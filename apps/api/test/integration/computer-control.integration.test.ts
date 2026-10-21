import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { applySafeControl, requestComputerControlStop } from '../../src/application/control-requests.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { claimRunForGateway, dispatchGatewayAction, prepareGatewayAction, releaseGatewayWorker }
  from '../../src/application/gateway-actions.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { RunScopeGrantRepository } from '../../src/application/run-scope-grant.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { ComputerControlStateRepository, readComputerControlSession }
  from '../../src/computer/control-state.js';
import { ComputerDesktopLeaseRepository } from '../../src/computer/desktop-lease-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { getComputerRuntimeClient, shutdownComputerRuntimeClient } from '../../src/computer/client-holder.js';
import { replaceComputerRuntimeClientForTest } from '../../src/computer/client-holder.js';
import { COMPUTER_PROTOCOL_VERSION } from '../../src/computer/protocol.js';
import { ComputerRuntimeClient, type ComputerRuntimeProcessLike, type SpawnProcess }
  from '../../src/computer/runtime-client.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, startTestApi } from './api-harness.js';
import { APP_DATABASE_URL, createTemporaryDatabase, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-test-computer-control');
const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-test-computer-control-setup');
let dataRoot: string;

class SuccessfulComputerProcess implements ComputerRuntimeProcessLike {
  private readonly dataListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();

  constructor(private readonly hangType = false) {}

  readonly stdin = { write: (line: string) => {
    const request = JSON.parse(line) as { request_id: string; method: string };
    if (this.hangType && request.method === 'computer.type') return true;
    const result = request.method === 'computer.describe_environment' ? {
      platform: 'windows', dpi_awareness: 'per-monitor-v2', virtual_screen: null, monitors: [],
      child_session: { enabled: false, enabled_query_ok: true, available: false, session_id: null },
      ui_automation: { client_library_loadable: false, provider_implemented: false, already_loaded: false },
      mode_availability: { background: { status: 'unavailable', browser_cdp: 'unavailable', ui_automation: 'unavailable' },
        isolated: { status: 'unavailable' }, foreground: { status: 'available' } }, mock: true,
    } : request.method === 'computer.get_windows' ? { windows: [] } : {};
    const reply = Buffer.from(`${JSON.stringify({ version: COMPUTER_PROTOCOL_VERSION,
      request_id: request.request_id, success: true, result })}\n`);
    queueMicrotask(() => { for (const listener of this.dataListeners) listener(reply); });
    return true;
  }, end: () => {} };
  readonly stdout = { on: (_event: 'data', listener: (chunk: Buffer) => void) => {
    this.dataListeners.add(listener); return this.stdout;
  } };
  readonly stderr = { on: () => this.stderr };

  on(event: 'spawn', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): this;
  on(event: 'spawn' | 'error' | 'exit' | 'close',
    listener: (() => void) | ((error: Error) => void) | ((code: number | null) => void)): this {
    if (event === 'spawn') {
      // 真实 Node 在进程确实起来后才发 'spawn'；假进程在登记监听后的微任务里发一次。
      queueMicrotask(() => { (listener as () => void)(); });
      return this;
    }
    if (event !== 'error') this.exitListeners.add(listener as (code: number | null) => void);
    return this;
  }

  kill(): boolean {
    for (const listener of this.exitListeners) listener(null);
    return true;
  }
}

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  shutdownComputerRuntimeClient();
  await app.close();
  await migrator.close();
  if (typeof dataRoot === 'string') await rm(dataRoot, { recursive: true, force: true });
});

async function fixture(db: DbExecutor = app.db) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(db, async repositories => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'Computer control' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'Computer control',
      projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId,
      title: 'Computer control', status: 'READY', mode: 'ME', acceptanceRevision: 1n,
      executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Stop computer control', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: 'Human check', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(db, { workspaceId, taskId,
    commandId: randomUUID(), expectedTaskRevision: '0' });
  return { workspaceId, projectId, taskId, runId: delegated.result.run_id };
}

async function inputFixture(rootPath: string, db: DbExecutor = app.db) {
  const f = await fixture(db);
  const storage = new ManagedContentStore(dataRoot);
  for (let step = 0; step < 2; step += 1) {
    assert.equal((await advanceRunStep(db, { runId: f.runId,
      workerId: `setup-${randomUUID()}`, storage })).status, 'STEP_SUCCEEDED');
  }
  const draft = await withTransaction(db, repositories => repositories.runs.readStepByKind(f.runId, 'DRAFT'));
  assert.ok(draft);
  await mkdir(rootPath, { recursive: true });
  const resource = await registerManagedResource(db, { workspaceId: f.workspaceId,
    projectId: f.projectId, rootPath });
  const connection = await createFakeConnection(db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capabilities: ['COMPUTER_INPUT'] });
  await createGatewayPolicy(db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'COMPUTER_INPUT', actionType: 'COMPUTER_TYPE', targetPrefix: 'computer://desktop',
    decision: 'AUTO', maxPayloadBytes: 8192 });
  await new RunScopeGrantRepository(db).insert({ workspaceId: f.workspaceId,
    projectId: f.projectId, runId: f.runId, taskId: f.taskId, resourceId: resource.resourceId,
    canonicalRoot: resource.canonicalRoot, allowedActions: ['COMPUTER_INPUT'], checks: [] });
  const workerId = `computer-${randomUUID()}`;
  const claimed = await claimRunForGateway(db, { workspaceId: f.workspaceId,
    runId: f.runId, workerId });
  return { ...f, draftId: draft.id, resourceId: resource.resourceId, connectionId: connection.connectionId,
    workerId, workerEpoch: BigInt(claimed.worker_epoch), rootPath };
}

function installSuccessfulComputerRuntime(hangType = false): void {
  replaceComputerRuntimeClientForTest(new ComputerRuntimeClient({ executable: 'test-runtime.exe',
    mode: 'mock', ...(hangType ? { requestTimeoutMs: 300 } : {}),
    spawnProcess: (() => new SuccessfulComputerProcess(hangType)) as SpawnProcess }));
}

async function prepareAndDispatchType(f: Awaited<ReturnType<typeof inputFixture>>, text: string,
  db: DbExecutor = app.db) {
  const operationId = randomUUID();
  const origin = { kind: 'RUN' as const, runId: f.runId, stepId: f.draftId,
    resourceId: f.resourceId, workerId: f.workerId, workerEpoch: f.workerEpoch };
  const prepared = await prepareGatewayAction(db, { workspaceId: f.workspaceId,
    operationId, intentKey: randomUUID(), connectionId: f.connectionId, origin,
    actionType: 'COMPUTER_TYPE', target: 'computer://desktop', params: { text } });
  assert.equal(prepared.status, 'PREPARED');
  return { operationId, origin, result: await dispatchGatewayAction(db,
    { workspaceId: f.workspaceId, operationId, origin }) };
}

async function safelyCancelDesktopRun(f: Awaited<ReturnType<typeof inputFixture>>,
  db: DbExecutor = app.db): Promise<void> {
  await requestComputerControlStop(db, { workspaceId: f.workspaceId, runId: f.runId });
  let applied = await applySafeControl(db, f.runId);
  if (applied?.status !== 'APPLIED') {
    const run = await withTransaction(db, repositories => repositories.runs.readRun(f.runId));
    assert.ok(run?.worker_id, 'a pending stop must retain the worker until its safe release');
    await releaseGatewayWorker(db, { workspaceId: f.workspaceId, runId: f.runId,
      workerId: run.worker_id, workerEpoch: run.worker_epoch });
    applied = await applySafeControl(db, f.runId);
  }
  assert.equal(applied?.status, 'APPLIED');
  assert.equal((await withTransaction(db, repositories => repositories.computerDesktopLease.read())).state, 'FREE');
}

test('two different managed-directory Runs cannot both admit desktop input', async () => {
  installSuccessfulComputerRuntime();
  const first = await inputFixture(join(dataRoot, `desktop-first-${randomUUID()}`));
  const second = await inputFixture(join(dataRoot, `desktop-second-${randomUUID()}`));
  try {
    const firstAction = await prepareAndDispatchType(first, 'first input');
    assert.equal(firstAction.result.status, 'SUCCEEDED');
    assert.equal((await prepareAndDispatchType(first, 'same Run continues')).result.status, 'SUCCEEDED');
    await releaseGatewayWorker(app.db, { workspaceId: first.workspaceId, runId: first.runId,
      workerId: first.workerId, workerEpoch: first.workerEpoch });
    const nextWorkerId = `computer-${randomUUID()}`;
    const nextEpoch = BigInt((await claimRunForGateway(app.db, { workspaceId: first.workspaceId,
      runId: first.runId, workerId: nextWorkerId })).worker_epoch);
    assert.equal(await withTransaction(app.db, r => r.computerDesktopLease.unbindWorker({
      runId: first.runId, workerId: first.workerId, workerEpoch: first.workerEpoch })), false,
    'an old Worker epoch cannot unbind the current lease owner');
    const currentLease = await withTransaction(app.db, r => r.computerDesktopLease.read());
    assert.equal(currentLease.worker_id, nextWorkerId);
    assert.equal(currentLease.worker_epoch, nextEpoch);
    await releaseGatewayWorker(app.db, { workspaceId: first.workspaceId, runId: first.runId,
      workerId: nextWorkerId, workerEpoch: nextEpoch });
    await sql`update computer_desktop_lease set updated_at = now() - interval '1 hour' where id = 1`
      .execute(app.db);
    assert.equal((await readComputerControlSession(app.db, first.workspaceId)).state, 'RUNNING',
      'the 15 second projection fallback must not hide an active desktop lease');

    const operationId = randomUUID();
    const origin = { kind: 'RUN' as const, runId: second.runId, stepId: second.draftId,
      resourceId: second.resourceId, workerId: second.workerId, workerEpoch: second.workerEpoch };
    const prepared = await prepareGatewayAction(app.db, { workspaceId: second.workspaceId,
      operationId, intentKey: randomUUID(), connectionId: second.connectionId, origin,
      actionType: 'COMPUTER_TYPE', target: 'computer://desktop', params: { text: 'second input' } });
    assert.equal(prepared.status, 'PREPARED');
    await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: second.workspaceId,
      operationId, origin }), { code: 'COMPUTER_DESKTOP_OCCUPIED' });
    await safelyCancelDesktopRun(first);
    assert.equal((await dispatchGatewayAction(app.db, { workspaceId: second.workspaceId,
      operationId, origin })).status, 'SUCCEEDED', 'the same side-effect-free PREPARED operation can retry after release');
    await safelyCancelDesktopRun(second);
  } finally { shutdownComputerRuntimeClient(); }
});

test('a confirmed safe stop releases the session lease for another Run', async () => {
  installSuccessfulComputerRuntime();
  const first = await inputFixture(join(dataRoot, `desktop-stop-first-${randomUUID()}`));
  const second = await inputFixture(join(dataRoot, `desktop-stop-second-${randomUUID()}`));
  try {
    assert.equal((await prepareAndDispatchType(first, 'first input')).result.status, 'SUCCEEDED');
    await releaseGatewayWorker(app.db, { workspaceId: first.workspaceId, runId: first.runId,
      workerId: first.workerId, workerEpoch: first.workerEpoch });
    const operationId = randomUUID();
    const origin = { kind: 'RUN' as const, runId: second.runId, stepId: second.draftId,
      resourceId: second.resourceId, workerId: second.workerId, workerEpoch: second.workerEpoch };
    const prepared = await prepareGatewayAction(app.db, { workspaceId: second.workspaceId,
      operationId, intentKey: randomUUID(), connectionId: second.connectionId, origin,
      actionType: 'COMPUTER_TYPE', target: 'computer://desktop', params: { text: 'second after stop' } });
    assert.equal(prepared.status, 'PREPARED');
    await safelyCancelDesktopRun(first);
    assert.equal((await withTransaction(app.db, r => r.computerDesktopLease.read())).state, 'FREE');
    const dispatched = await dispatchGatewayAction(app.db, { workspaceId: second.workspaceId, operationId, origin });
    assert.equal(dispatched.status, 'SUCCEEDED', 'second Run can enter after safe stop');
    const lease = await withTransaction(app.db, r => r.computerDesktopLease.read());
    assert.equal(lease.run_id, second.runId);
    await safelyCancelDesktopRun(second);
  } finally { shutdownComputerRuntimeClient(); }
});

test('COMPUTER_READ remains available while another Run holds the desktop input lease', async () => {
  installSuccessfulComputerRuntime();
  const first = await inputFixture(join(dataRoot, `desktop-read-owner-${randomUUID()}`));
  const second = await inputFixture(join(dataRoot, `desktop-read-reader-${randomUUID()}`));
  try {
    assert.equal((await prepareAndDispatchType(first, 'hold input session')).result.status, 'SUCCEEDED');
    const connection = await createFakeConnection(app.db, { workspaceId: second.workspaceId,
      projectId: second.projectId, capabilities: ['COMPUTER_READ'] });
    await createGatewayPolicy(app.db, { workspaceId: second.workspaceId, projectId: second.projectId,
      capability: 'COMPUTER_READ', actionType: 'COMPUTER_GET_WINDOWS',
      targetPrefix: 'computer://desktop', decision: 'AUTO', maxPayloadBytes: 8192 });
    const operationId = randomUUID();
    const origin = { kind: 'RUN' as const, runId: second.runId, stepId: second.draftId,
      resourceId: second.resourceId, workerId: second.workerId, workerEpoch: second.workerEpoch };
    const prepared = await prepareGatewayAction(app.db, { workspaceId: second.workspaceId,
      operationId, intentKey: randomUUID(), connectionId: connection.connectionId, origin,
      actionType: 'COMPUTER_GET_WINDOWS', target: 'computer://desktop', params: {} });
    assert.equal(prepared.status, 'PREPARED');
    assert.equal((await dispatchGatewayAction(app.db, { workspaceId: second.workspaceId,
      operationId, origin })).status, 'SUCCEEDED');
    const lease = await withTransaction(app.db, r => r.computerDesktopLease.read());
    assert.equal(lease.state, 'HELD');
    assert.equal(lease.run_id, first.runId, 'a read does not acquire or replace the input session lease');
    await releaseGatewayWorker(app.db, { workspaceId: second.workspaceId, runId: second.runId,
      workerId: second.workerId, workerEpoch: second.workerEpoch });
    await safelyCancelDesktopRun(first);
  } finally { shutdownComputerRuntimeClient(); }
});

test('a held desktop lease does not block same-Run FILE_WRITE preparation', async () => {
  installSuccessfulComputerRuntime();
  const first = await inputFixture(join(dataRoot, `desktop-file-write-${randomUUID()}`));
  try {
    assert.equal((await prepareAndDispatchType(first, 'input first')).result.status, 'SUCCEEDED');
    await releaseGatewayWorker(app.db, { workspaceId: first.workspaceId, runId: first.runId,
      workerId: first.workerId, workerEpoch: first.workerEpoch });
    const workerId = `computer-${randomUUID()}`;
    const workerEpoch = BigInt((await claimRunForGateway(app.db, { workspaceId: first.workspaceId,
      runId: first.runId, workerId })).worker_epoch);
    const connection = await createGatewayConnectionCommand(app.db, { workspaceId: first.workspaceId,
      projectId: first.projectId, commandId: randomUUID(), capabilities: ['FILE_WRITE'],
      rootPath: first.rootPath });
    await createGatewayPolicy(app.db, { workspaceId: first.workspaceId, projectId: first.projectId,
      capability: 'FILE_WRITE', actionType: 'WRITE_FILE', targetPrefix: first.rootPath,
      decision: 'AUTO', maxPayloadBytes: 8192 });
    const writeOperationId = randomUUID();
    const write = await prepareGatewayAction(app.db, { workspaceId: first.workspaceId,
      operationId: writeOperationId, intentKey: randomUUID(), connectionId: connection.result.connection_id!,
      origin: { kind: 'RUN', runId: first.runId, stepId: first.draftId,
        resourceId: first.resourceId, workerId, workerEpoch },
      actionType: 'WRITE_FILE', target: join(first.rootPath, 'ordinary.txt'), params: { content: 'ordinary' } });
    assert.equal(write.status, 'WAITING_APPROVAL');
    assert.ok(write.review_id, 'FILE_WRITE prepared while this Run held the desktop lease');
    const review = await withTransaction(app.db, r => r.reviews.readRequest(write.review_id!));
    assert.ok(review);
    await resolveReview(app.db, { workspaceId: first.workspaceId, reviewId: review.id,
      commandId: randomUUID(), expectedRevision: review.revision.toString(),
      targetHash: review.target_hash.toString('hex'), decision: 'DENY' });
    const run = await withTransaction(app.db, r => r.runs.readRun(first.runId));
    assert.ok(run);
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) await safelyCancelDesktopRun(first);
    assert.equal((await withTransaction(app.db, r => r.computerDesktopLease.read())).state, 'FREE',
      'the session lease releases only after the denied operation reaches a safe boundary');
  } finally { shutdownComputerRuntimeClient(); }
});

test('real relay_app can maintain and read the computer control projection', async () => {
  const f = await fixture();
  await new ComputerControlStateRepository(app.db).markRunning({ ...f,
    actionType: 'COMPUTER_TYPE', actionLabel: 'Test input' });
  assert.equal((await readComputerControlSession(app.db, f.workspaceId)).state, 'RUNNING');
  assert.equal((await readComputerControlSession(app.db, randomUUID())).state, 'STOPPED');
});

test('idle projection expiry serializes against first desktop lease admission', async () => {
  const f = await inputFixture(join(dataRoot, `desktop-expire-race-${randomUUID()}`));
  let releaseWriter!: () => void;
  let notifyReady!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWriter = resolve; });
  const rowReady = new Promise<void>(resolve => { notifyReady = resolve; });
  const writer = app.db.transaction().execute(async trx => {
    assert.equal(await new ComputerDesktopLeaseRepository(trx).acquireForInput({
      workspaceId: f.workspaceId, runId: f.runId, workerId: f.workerId, workerEpoch: f.workerEpoch,
    }), true);
    await new ComputerControlStateRepository(trx).markRunning({ runId: f.runId,
      workspaceId: f.workspaceId, actionType: 'COMPUTER_TYPE', actionLabel: 'Expiration race' });
    await sql`update computer_control_state set updated_at = now() - interval '1 hour' where id = 1`
      .execute(trx);
    notifyReady();
    await writeGate;
  });
  await rowReady;
  const expiring = new ComputerControlStateRepository(app.db).expireIfIdle();
  await new Promise(resolve => setTimeout(resolve, 100));
  releaseWriter();
  await Promise.all([writer, expiring]);
  assert.equal((await readComputerControlSession(app.db, f.workspaceId)).state, 'RUNNING');
  await safelyCancelDesktopRun(f);
});

test('repeated stop remains STOP_REQUESTED until the safe control point confirms cancellation', async () => {
  const f = await fixture();
  await new ComputerControlStateRepository(migrator.db).markRunning({ ...f,
    actionType: 'COMPUTER_TYPE', actionLabel: 'Test input' });
  const api = await startTestApi();
  try {
    const url = `/api/v1/workspaces/${f.workspaceId}/computer/control-session`;
    const first = await api.post(`${url}/cancel`, {});
    assert.equal(first.status, 200, first.text);
    assert.equal((first.body as { state: string }).state, 'STOP_REQUESTED');
    const repeated = await api.post(`${url}/cancel`, {});
    assert.equal(repeated.status, 200, repeated.text);
    assert.equal((repeated.body as { state: string }).state, 'STOP_REQUESTED');
    const control = await applySafeControl(app.db, f.runId);
    assert.equal(control?.status, 'APPLIED');
    const stopped = await api.get(url);
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal(stopped.headers['cache-control'], 'no-store');
    assert.equal((stopped.body as { state: string }).state, 'STOPPED');
  } finally { await api.stop(); }
});

test('failed stop admission does not persist a false STOP_REQUESTED projection', async () => {
  const workspaceId = randomUUID();
  await new ComputerControlStateRepository(migrator.db).markRunning({ workspaceId,
    runId: randomUUID(), actionType: 'COMPUTER_TYPE', actionLabel: 'Test input' });
  const api = await startTestApi();
  try {
    const response = await api.post(`/api/v1/workspaces/${workspaceId}/computer/control-session/cancel`, {});
    assert.equal(response.status, 404, response.text);
    assert.equal((await new ComputerControlStateRepository(migrator.db).readLatest())?.state, 'RUNNING');
  } finally { await api.stop(); }
});

test('a stale control snapshot cannot enqueue CANCEL after another Run becomes visible', async () => {
  const previous = await fixture();
  const current = await fixture();
  const repository = new ComputerControlStateRepository(app.db);
  await repository.markRunning({ ...previous, actionType: 'COMPUTER_TYPE', actionLabel: 'Previous' });
  const snapshot = await repository.readLatest();
  assert.ok(snapshot);
  // 控制路由读取之后、取消事务准入之前，另一 Run 更新了展示事实。
  await repository.markRunning({ ...current, actionType: 'COMPUTER_TYPE', actionLabel: 'Current' });
  await assert.rejects(requestComputerControlStop(app.db, {
    workspaceId: snapshot.workspace_id, runId: snapshot.run_id,
  }), { code: 'INVALID_TRANSITION' });
  const pending = await withTransaction(app.db, r => r.recovery.findPendingControl(previous.runId));
  assert.equal(pending, undefined, 'the stale cancellation must roll back');
  const visible = await repository.readLatest();
  assert.equal(visible?.run_id, current.runId);
  assert.equal(visible?.state, 'RUNNING');
});

// Opt-in only: the coordinator must first observe a self-owned, blank Notepad window.
test('real Windows input uses the Gateway scope grant and projects its receipt', {
  skip: process.env.RELAY_TEST_COMPUTER_WINDOW_ID === undefined,
}, async () => {
  const windowId = process.env.RELAY_TEST_COMPUTER_WINDOW_ID!;
  const client = getComputerRuntimeClient();
  const windows = await client.request('computer.get_windows', {}) as {
    windows: Array<{ id: string; process_name: string | null; focused: boolean }>;
  };
  assert.ok(windows.windows.some(window => window.id === windowId &&
    /notepad/i.test(window.process_name ?? '')), 'must target the observed test Notepad');
  const f = await fixture();
  const storage = new ManagedContentStore(dataRoot);
  for (let step = 0; step < 2; step += 1) {
    assert.equal((await advanceRunStep(app.db, { runId: f.runId,
      workerId: `setup-${randomUUID()}`, storage })).status, 'STEP_SUCCEEDED');
  }
  const draft = await withTransaction(app.db, repositories => repositories.runs.readStepByKind(f.runId, 'DRAFT'));
  assert.ok(draft);
  const resource = await registerManagedResource(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, rootPath: dataRoot });
  const connectionId = await withTransaction(app.db, async repositories => {
    await repositories.workspaces.lockAuthority(f.workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId: f.workspaceId, projectId: f.projectId, config: {} });
    await repositories.gateway.addConnectionCapability(connection.id, 'COMPUTER_INPUT');
    await repositories.workspaces.bumpAuthority(f.workspaceId);
    return connection.id;
  });
  for (const actionType of ['COMPUTER_ACTIVATE_WINDOW', 'COMPUTER_TYPE']) {
    await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      capability: 'COMPUTER_INPUT', actionType, targetPrefix: 'computer://desktop',
      decision: 'AUTO', maxPayloadBytes: 8192 });
  }
  await new RunScopeGrantRepository(app.db).insert({ workspaceId: f.workspaceId,
    projectId: f.projectId, runId: f.runId, taskId: f.taskId, resourceId: resource.resourceId,
    canonicalRoot: resource.canonicalRoot, allowedActions: ['COMPUTER_INPUT'], checks: [] });
  const workerId = `computer-${randomUUID()}`;
  const held = await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId });
  const origin = { kind: 'RUN' as const, runId: f.runId, stepId: draft.id,
    resourceId: resource.resourceId, workerId, workerEpoch: BigInt(held.worker_epoch) };
  for (const [actionType, params] of [
    ['COMPUTER_ACTIVATE_WINDOW', { window_id: windowId }],
    ['COMPUTER_TYPE', { text: 'Relay computer acceptance 2026-10-18' }],
  ] as const) {
    if (actionType === 'COMPUTER_TYPE') {
      const observed = await client.request('computer.get_windows', {}) as typeof windows;
      assert.ok(observed.windows.some(window => window.id === windowId && window.focused),
        'stop before input if the test Notepad lost focus');
    }
    const operationId = randomUUID();
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId,
      intentKey: randomUUID(), connectionId, origin, actionType, target: 'computer://desktop', params });
    assert.equal(prepared.status, 'PREPARED');
    const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId, origin });
    assert.equal(dispatched.status, 'SUCCEEDED', JSON.stringify(dispatched));
  }
  assert.equal((await readComputerControlSession(app.db, f.workspaceId)).state, 'RUNNING');
  await requestComputerControlStop(app.db, { workspaceId: f.workspaceId, runId: f.runId });
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'PENDING');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId, workerEpoch: BigInt(held.worker_epoch) });
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'APPLIED');
});

test('an UNKNOWN desktop input quarantines the lease and blocks every other Run', async () => {
  const database = await createTemporaryDatabase('computer_unknown_lease');
  let isolatedApp: ReturnType<typeof openDatabase> | undefined;
  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
    isolatedApp = openDatabase(database.appUrl, 'relay-test-computer-unknown-lease');
    installSuccessfulComputerRuntime(true);
    const db = isolatedApp.db;
    const first = await inputFixture(join(dataRoot, `desktop-unknown-first-${randomUUID()}`), db);
    const second = await inputFixture(join(dataRoot, `desktop-unknown-second-${randomUUID()}`), db);
    const action = await prepareAndDispatchType(first, 'unknown input', db);
    assert.equal(action.result.status, 'UNKNOWN');
    await sql`update computer_desktop_lease set updated_at = now() - interval '1 hour' where id = 1`
      .execute(db);
    const lease = await withTransaction(db, r => r.computerDesktopLease.read());
    assert.equal(lease.state, 'QUARANTINED');
    const operationId = randomUUID();
    const origin = { kind: 'RUN' as const, runId: second.runId, stepId: second.draftId,
      resourceId: second.resourceId, workerId: second.workerId, workerEpoch: second.workerEpoch };
    const prepared = await prepareGatewayAction(db, { workspaceId: second.workspaceId,
      operationId, intentKey: randomUUID(), connectionId: second.connectionId, origin,
      actionType: 'COMPUTER_TYPE', target: 'computer://desktop', params: { text: 'must be blocked' } });
    assert.equal(prepared.status, 'PREPARED');
    await assert.rejects(dispatchGatewayAction(db, { workspaceId: second.workspaceId,
      operationId, origin }), { code: 'COMPUTER_DESKTOP_OCCUPIED' });
  } finally {
    shutdownComputerRuntimeClient();
    if (isolatedApp !== undefined) await isolatedApp.close();
    await database.drop();
  }
});
