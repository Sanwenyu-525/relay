import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sql } from 'kysely';
import { Client } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

import { httpCommandScopeKey } from '../../src/application/actor.js';
import { acceptAssistProposal, cancelAssistMessage, createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { applyBlueprintProposal } from '../../src/application/blueprint-apply.js';
import { createBlueprintProposal } from '../../src/application/blueprint-proposals.js';
import { CommandIdReusedError, runIdempotentCommand } from '../../src/application/command.js';
import { requestRunControl, applySafeControl } from '../../src/application/control-requests.js';
import { createProject } from '../../src/application/create-project.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { DomainError } from '../../src/application/domain-error.js';
import { readAdmission } from '../../src/application/maintenance-admission.js';
import { runModelPortVerification } from '../../src/application/model-port-verification.js';
import { claimRunForGateway, claimGatewayWorker, prepareGatewayAction, dispatchGatewayAction,
  SimulatedGatewayCrash, type GatewayOrigin } from '../../src/application/gateway-actions.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { closePartialFileWriteCommand, readFileWriteDispositionPreview }
  from '../../src/application/file-write-disposition.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { claimNextRunCommand, renewRunInvocation } from '../../src/application/run-dispatch.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { changeAdmission, readAdmissionStatus } from '../../src/application/runtime-maintenance.js';
import { cancelTask } from '../../src/application/task-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { createWebImportJob, WEB_IMPORT_CONFIG_VERSION } from '../../src/application/web-import-commands.js';
import { runWebImportTick } from '../../src/application/web-import-runner.js';
import { installGraphCheckpoints, GRAPH_CHECKPOINT_SCHEMA } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { SchemaReadinessChecker } from '../../src/infrastructure/schema-readiness.js';
import { RuntimeAdmissionRepository } from '../../src/runtime/runtime-admission-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import { createFakeVerifyCall } from '../../src/workflow/model-port-verify.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { recoverStoppedDesktopLaunch } from '../../src/worker/supervisor.js';
import { createDataRoot, createWorkspace, delay, expectProblem, startTestApi,
  workspacePath } from './api-harness.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase,
  expectSqlState, type TemporaryDatabase } from './integration-support.js';

let database: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let observer: ReturnType<typeof openDatabase>;
let dataRoot: string;
let storage: ManagedContentStore;
const fake = new FakeModelPort();
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/cli/maintenance.js');
const runFile = promisify(execFile);

beforeEach(async () => {
  database = await createTemporaryDatabase('m07_admission');
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(database.migrationUrl);
  app = openDatabase(database.appUrl, 'relay-m07-app');
  observer = openDatabase(database.adminUrl, 'relay-m07-observer');
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
afterEach(async () => {
  if (app !== undefined) await app.close();
  if (observer !== undefined) await observer.close();
  if (database !== undefined) await database.drop();
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

async function drain() {
  const status = await readAdmissionStatus(app.db);
  return changeAdmission(app.db, { commandId: randomUUID(), action: 'begin-drain',
    expectedRevision: status.revision });
}
async function rejected(code: string, work: () => Promise<unknown>) {
  await assert.rejects(work, (error: unknown) => error instanceof DomainError &&
    error.code === code && (code === 'REVISION_CONFLICT' || error.status === 503));
}
function pausePoint() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  return { reached, release, wait: async () => { entered(); await held; } };
}
async function waitForDatabaseLock(applicationName: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const waiting = await sql<{ waiting: boolean }>`select exists (
      select 1 from pg_stat_activity where datname = ${database.name}
      and application_name = ${applicationName} and wait_event_type = 'Lock') as waiting`
      .execute(observer.db);
    if (waiting.rows[0]?.waiting) return;
    await delay(20);
  }
  assert.fail(`no actual database lock wait for ${applicationName}`);
}
async function fixture(status: 'READY' | 'IN_PROGRESS' = 'READY') {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Admission', projectType: 'GENERAL' });
  const projectId = project.result.project_id;
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Drain task',
      status, mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Create one immutable result', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: 'Review result', required: true, method: 'HUMAN', targetSpec: {} });
  });
  return { workspaceId, projectId, taskId };
}
async function delegated() {
  const f = await fixture();
  const outcome = await delegateTask(app.db, { ...f, commandId: randomUUID(),
    expectedTaskRevision: '0' });
  return { ...f, runId: outcome.result.run_id };
}
async function assist(f: Awaited<ReturnType<typeof fixture>>, intent = 'DISCUSS') {
  const session = await createAssistSession(app.db, { ...f, commandId: randomUUID(), title: 'Drain Assist' });
  const turn = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: 'Fixed request', intent });
  return { sessionId: session.result.session_id, messageId: turn.result.assistant_message_id };
}

test('default NORMAL, role limits, CLI status/CAS/replay and resume preserve identity', async () => {
  assert.deepEqual(await readAdmissionStatus(app.db), { target: 'DATABASE', mode: 'NORMAL', revision: '0' });
  await expectSqlState('42501', 'app cannot insert gate', () =>
    sql`insert into runtime_admission_gate (singleton) values (true)`.execute(app.db));
  await expectSqlState('42501', 'app cannot delete gate', () =>
    sql`delete from runtime_admission_gate`.execute(app.db));
  await expectSqlState('42501', 'app cannot update singleton identity', () =>
    sql`update runtime_admission_gate set singleton = true`.execute(app.db));
  const env = { ...process.env, RELAY_DB_URL: database.appUrl };
  const status = await runFile(process.execPath, [cli, 'status'], { env });
  assert.equal(JSON.parse(status.stdout).mode, 'NORMAL');
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from command_receipts`
    .execute(app.db)).rows[0]?.count, '0');
  const commandId = randomUUID();
  const args = [cli, 'begin-drain', '--command-id', commandId, '--expected-revision', '0'];
  const first = JSON.parse((await runFile(process.execPath, args, { env })).stdout);
  assert.deepEqual(first.result, { target: 'DATABASE', mode: 'DRAINING', revision: '1' });
  assert.equal(first.replayed, false);
  const replay = JSON.parse((await runFile(process.execPath, args, { env })).stdout);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.committedAt, first.committedAt);
  await assert.rejects(() => changeAdmission(app.db, { commandId, action: 'resume-admission',
    expectedRevision: '1' }), CommandIdReusedError);
  await rejected('REVISION_CONFLICT', () => changeAdmission(app.db,
    { commandId: randomUUID(), action: 'resume-admission', expectedRevision: '0' }));
  const resumed = await changeAdmission(app.db, { commandId: randomUUID(),
    action: 'resume-admission', expectedRevision: '1' });
  assert.equal(resumed.result.mode, 'NORMAL');
  assert.equal(resumed.result.revision, '2');
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from run_commands`
    .execute(app.db)).rows[0]?.count, '0');
  const replayAfterResume = await changeAdmission(app.db, { commandId,
    action: 'begin-drain', expectedRevision: '0' });
  assert.deepEqual(replayAfterResume.result, first.result);
  assert.equal((await readAdmissionStatus(app.db)).mode, 'NORMAL');
  await assert.rejects(() => runFile(process.execPath, [cli, 'status'],
    { env: { ...env, RELAY_DB_URL: 'postgres://hidden:secret@127.0.0.1:1/db' } }),
  (error: unknown) => {
    const output = (error as { stderr: string }).stderr;
    assert.match(output, /MAINTENANCE_UNAVAILABLE/u);
    assert.doesNotMatch(output, /hidden|secret|postgres:/u);
    return true;
  });
});

test('DRAINING refuses new HTTP commands across Workspaces, preserves old receipts and read readiness', async () => {
  const firstWorkspace = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const api = await startTestApi({ databaseUrl: database.appUrl });
  try {
    const commandId = randomUUID();
    const body = { command_id: commandId, title: 'Original', project_type: 'GENERAL' };
    const path = workspacePath(firstWorkspace, '/projects');
    const created = await api.post(path, body);
    assert.equal(created.status, 201);
    await drain();
    const replay = await api.post(path, body);
    assert.deepEqual(replay.body, created.body);
    assert.equal(replay.headers['command-replayed'], 'true');
    expectProblem(await api.post(path, { ...body, title: 'Different' }), 409, 'COMMAND_ID_REUSED');
    for (const workspaceId of [firstWorkspace, otherWorkspace]) {
      const newId = randomUUID();
      expectProblem(await api.post(workspacePath(workspaceId, '/projects'),
        { ...body, command_id: newId }), 503, 'MAINTENANCE_DRAINING');
      assert.equal(await createRepositories(app.db).receipts.findReceipt({
        scopeKey: httpCommandScopeKey(workspaceId), commandId: newId }), undefined);
      assert.equal((await api.get(workspacePath(workspaceId, '/projects'))).status, 200);
    }
    assert.equal((await new SchemaReadinessChecker(MIGRATIONS_DIRECTORY).check(app.db)).compatible, true);
    assert.equal((await sql<{ count: string }>`select count(*)::text as count from projects`
      .execute(app.db)).rows[0]?.count, '1');
  } finally { await api.stop(); }
});

test('both custom proposal acceptance transactions reject before any proposal or business effect', async () => {
  const f = await fixture();
  const turn = await assist(f, 'PROPOSE_TASK');
  const generated = await runAssistGenerationTick(app.db, { workerId: 'proposal-worker',
    modelPort: fake, storage, leaseMs: 30_000 });
  assert.equal(generated?.status, 'COMPLETED');
  assert.equal(generated?.messageId, turn.messageId);
  const proposalId = generated!.proposalIds[0]!;
  const blueprint = await createBlueprintProposal(app.db, { ...f,
    commandId: randomUUID(), expectedProjectRevision: '0', expectedStateRevision: '0',
    expectedViewRevision: '0', draft: { intent: 'One new task', goal_id: null,
      phase_key: null, tasks: [{ local_key: 'new', title: 'New', objective: 'New objective' }],
      next_action: null, view_kind: 'general', pack_ref: null } });
  const bp = blueprint.result as { id: string; candidate_sha256: string };
  const acceptId = randomUUID();
  const applyId = randomUUID();
  const originalReceipts = (await sql<{ count: string }>`select count(*)::text as count
    from command_receipts`.execute(app.db)).rows[0]?.count;
  await drain();
  await rejected('MAINTENANCE_DRAINING', () => acceptAssistProposal(app.db,
    { workspaceId: f.workspaceId, proposalId, commandId: acceptId, storage }));
  await rejected('MAINTENANCE_DRAINING', () => applyBlueprintProposal(app.db, { ...f,
    proposalId: bp.id, commandId: applyId, candidateSha256: bp.candidate_sha256,
    expectedProjectRevision: '0', expectedStateRevision: '0', expectedViewRevision: '0' }));
  assert.equal((await createRepositories(app.db).assist.readProposal(proposalId))?.status, 'PENDING');
  assert.equal((await createRepositories(app.db).blueprints.read(bp.id))?.status, 'PENDING');
  assert.equal((await createRepositories(app.db).projects.readProject(f.projectId))?.revision, 0n);
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from tasks`
    .execute(app.db)).rows[0]?.count, '1');
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from command_receipts`
    .execute(app.db)).rows[0]?.count, String(Number(originalReceipts) + 1));
});

test('DRAINING allows only fixed stopping/cancellation commands and trusted safe control', async () => {
  const f = await delegated();
  const human = await fixture();
  const turn = await assist(human);
  await drain();
  const cancelled = await cancelTask(app.db, { ...human, commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(cancelled.result.status, 'CANCELLED');
  const cancelledMessage = await cancelAssistMessage(app.db, { workspaceId: human.workspaceId,
    messageId: turn.messageId, commandId: randomUUID() });
  assert.equal(cancelledMessage.result.status, 'CANCELLED');
  const task = await createRepositories(app.db).tasks.readTask(f.taskId);
  const run = await createRepositories(app.db).runs.readRun(f.runId);
  const stop = await requestRunControl(app.db, { ...f, commandId: randomUUID(), type: 'CANCEL',
    expectedTaskRevision: task!.revision.toString(), expectedRunRevision: run!.revision.toString() });
  assert.equal(stop.result.status, 'PENDING');
  await applySafeControl(app.db, f.runId);
  assert.equal((await createRepositories(app.db).runs.readRun(f.runId))?.status, 'CANCELLED');
  for (const commandType of ['ResumeRun', 'ResolveReview', 'DelegateTask', 'AcceptAssistProposal']) {
    await rejected('MAINTENANCE_DRAINING', () => runIdempotentCommand(app.db, {
      scopeKey: 'maintenance-test', commandId: randomUUID(), commandType,
      target: f.runId, body: {}, execute: async () => { assert.fail('new work was admitted'); } }));
  }
});

test('new Run, Assist, Web preparation and no-delivery Gateway claims stay unclaimed in DRAINING', async () => {
  const f = await delegated();
  const turn = await assist(f);
  const connection = await createGatewayConnectionCommand(app.db, { ...f,
    commandId: randomUUID(), capabilities: ['WEB_FETCH'], allowedHost: '127.0.0.1', allowPrivate: true });
  const web = await createWebImportJob(app.db, { ...f, commandId: randomUUID(),
    connectionId: connection.result.connection_id!, url: 'http://127.0.0.1:1/drain' });
  await drain();
  assert.equal(await claimNextRunCommand(app.db, 'refused-run-worker'), undefined);
  assert.equal(await runAssistGenerationTick(app.db,
    { workerId: 'refused-assist-worker', storage, modelPort: fake, leaseMs: 30_000 }), undefined);
  assert.deepEqual(await runWebImportTick(app.db), { prepared: 0, dispatched: 0, succeeded: 0, failed: 0 });
  assert.equal((await createRepositories(app.db).assist.readMessage(turn.messageId))?.status, 'PENDING');
  assert.equal((await createRepositories(app.db).gateway.readImportJob(web.result.import_job_id))?.status, 'QUEUED');
  const claimRows = await sql<{ status: string; worker_id: string | null }>`select status, worker_id
    from run_command_outbox`.execute(app.db);
  assert.deepEqual(claimRows.rows, [{ status: 'PENDING', worker_id: null }]);
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from logical_operations`
    .execute(app.db)).rows[0]?.count, '0');
  await rejected('MAINTENANCE_DRAINING', () => claimRunForGateway(app.db,
    { workspaceId: f.workspaceId, runId: f.runId, workerId: 'legacy-worker' }));
});

test('already claimed Run publishes its immutable artifact, saves checkpoints and settles original delivery', async () => {
  const f = await delegated();
  const outcome = await runOneCommand(app.db, { workerId: 'claimed-before-drain', dataRoot,
    checkpointUrl: database.appUrl, leaseMs: 30_000,
    onClaim: async (claim) => {
      await drain();
      assert.equal(await renewRunInvocation(app.db, claim), true);
    } });
  assert.equal(outcome?.runId, f.runId);
  assert.equal(outcome?.outcome, 'DONE');
  const artifacts = await sql<{ storage_ref: string; content_hash: Buffer; size: bigint }>`
    select v.storage_ref, v.content_hash, v.size from artifact_versions v
    join artifacts a on a.id = v.artifact_id where a.task_id = ${f.taskId}`.execute(app.db);
  assert.equal(artifacts.rows.length, 1);
  const artifact = artifacts.rows[0]!;
  assert.equal((await storage.readWithHashCheck(artifact.storage_ref,
    { contentHash: artifact.content_hash, size: artifact.size })).status, 'OK');
  const saver = PostgresSaver.fromConnString(database.appUrl, { schema: GRAPH_CHECKPOINT_SCHEMA });
  try {
    assert.ok(await saver.getTuple({ configurable: { thread_id: f.runId, checkpoint_ns: '' } }));
  } finally { await saver.end(); }
  const delivery = await createRepositories(app.db).dispatch.readOutbox(outcome!.commandId);
  assert.equal(delivery?.status, 'DONE');
  assert.equal((await readAdmissionStatus(app.db)).mode, 'DRAINING');
});

test('already claimed Assist settles after DRAINING and expired lease cleanup still runs', async () => {
  const f = await fixture();
  const turn = await assist(f);
  const modelPort: AssistModelPort = { identity: fake.identity,
    assist: async (request) => { await drain(); return fake.assist(request); } };
  const result = await runAssistGenerationTick(app.db, { workerId: 'original-assist',
    modelPort, storage, leaseMs: 30_000 });
  assert.equal(result?.messageId, turn.messageId);
  assert.equal(result?.status, 'COMPLETED');
  assert.equal((await createRepositories(app.db).assist.readMessage(turn.messageId))?.status, 'COMPLETED');
  await changeAdmission(app.db, { commandId: randomUUID(), action: 'resume-admission', expectedRevision: '1' });
  const expired = await assist(f);
  await withTransaction(app.db, (r) => r.assist.claimNextPendingMessage('expired-owner'));
  await sql`update assist_messages set updated_at = now() - interval '1 minute'
    where id = ${expired.messageId}`.execute(observer.db);
  await drain();
  assert.equal(await runAssistGenerationTick(app.db, { workerId: 'cleanup-worker',
    modelPort: fake, storage, leaseMs: 500 }), undefined);
  assert.equal((await createRepositories(app.db).assist.readMessage(expired.messageId))?.status, 'FAILED');
});

test('RUNNING Web original operation dispatches and settles Knowledge in DRAINING', async () => {
  const f = await fixture();
  let fetches = 0;
  const server = createServer((_request, response) => {
    fetches += 1; response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Drain original content');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as AddressInfo).port;
    const connection = await createGatewayConnectionCommand(app.db, { ...f,
      commandId: randomUUID(), capabilities: ['WEB_FETCH'], allowedHost: '127.0.0.1', allowPrivate: true });
    await createGatewayPolicy(app.db, { ...f, capability: 'WEB_FETCH', actionType: 'WEB_FETCH',
      targetPrefix: '127.0.0.1', decision: 'AUTO', maxPayloadBytes: 1024 });
    const created = await createWebImportJob(app.db, { ...f, commandId: randomUUID(),
      connectionId: connection.result.connection_id!, url: `http://127.0.0.1:${port}/original` });
    const jobId = created.result.import_job_id;
    const job = await withTransaction(app.db, (r) => r.gateway.setImportJobStatus(jobId, 'RUNNING', null));
    const operationId = randomUUID();
    const origin: GatewayOrigin = { kind: 'USER_IMPORT', importJobId: jobId,
      actorRef: job.actor_ref, configVersion: WEB_IMPORT_CONFIG_VERSION };
    await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId,
      intentKey: `web-import-${jobId}`, connectionId: connection.result.connection_id!, origin,
      actionType: 'WEB_FETCH', target: job.source_uri, params: {} });
    await drain();
    const result = await runWebImportTick(app.db);
    assert.equal(result.prepared, 0);
    assert.equal(result.succeeded, 1);
    assert.equal(fetches, 1);
    const settled = await createRepositories(app.db).gateway.readImportJob(jobId);
    assert.equal(settled?.status, 'SUCCEEDED');
    assert.ok(settled?.knowledge_version_id);
    assert.equal((await createRepositories(app.db).gateway.readOperation(operationId))?.status, 'SUCCEEDED');
    await runWebImportTick(app.db);
    assert.equal(fetches, 1);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

test('real SHARE/UPDATE lock ordering admits the earlier transaction and rereads its receipt after drain waits', async () => {
  const workspaceId = await createWorkspace(app.db);
  const maintenance = openDatabase(database.appUrl, 'relay-m07-maintenance-wait');
  const duplicate = openDatabase(database.appUrl, 'relay-m07-duplicate-wait');
  const hold = pausePoint();
  const beforeDuplicateGate = pausePoint();
  const maintenanceOwnsGate = pausePoint();
  const originalRead = RuntimeAdmissionRepository.prototype.read;
  let executions = 0;
  const commandId = randomUUID();
  const request = { scopeKey: 'real-lock-race', commandId, commandType: 'CreateProject',
    target: workspaceId, body: { title: 'Race' }, execute: async (r: ReturnType<typeof createRepositories>) => {
      executions += 1;
      const project = await r.projects.insertProject({ id: randomUUID(), workspaceId, title: 'Race', projectType: 'GENERAL' });
      await hold.wait();
      return { project_id: project.id };
    } };
  try {
    const original = runIdempotentCommand(app.db, request);
    await hold.reached;
    // Transparent scheduling seams: execute the same repository SQL and retain
    // actual PG locks. PostgreSQL does not promise FIFO for queued row lockers.
    // Delay only duplicate's gate query (its first receipt read already finished)
    // and maintenance's return from its acquired UPDATE lock.
    RuntimeAdmissionRepository.prototype.read = async function (lock) {
      if (lock === 'share') await beforeDuplicateGate.wait();
      const gate = await originalRead.call(this, lock);
      if (lock === 'update') await maintenanceOwnsGate.wait();
      return gate;
    };
    const draining = changeAdmission(maintenance.db, { commandId: randomUUID(),
      action: 'begin-drain', expectedRevision: '0' });
    await waitForDatabaseLock('relay-m07-maintenance-wait');
    const replaying = runIdempotentCommand(duplicate.db, request);
    await beforeDuplicateGate.reached;
    hold.release();
    const first = await original;
    await maintenanceOwnsGate.reached;
    beforeDuplicateGate.release();
    await waitForDatabaseLock('relay-m07-duplicate-wait');
    maintenanceOwnsGate.release();
    const [drainResult, replay] = await Promise.all([draining, replaying]);
    assert.equal(drainResult.result.mode, 'DRAINING');
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    assert.equal(executions, 1);
    assert.equal((await sql<{ count: string }>`select count(*)::text as count from projects`
      .execute(app.db)).rows[0]?.count, '1');
    await rejected('MAINTENANCE_DRAINING', () => runIdempotentCommand(duplicate.db,
      { ...request, commandId: randomUUID() }));
  } finally {
    RuntimeAdmissionRepository.prototype.read = originalRead;
    hold.release(); beforeDuplicateGate.release(); maintenanceOwnsGate.release();
    await maintenance.close(); await duplicate.close();
  }
});

test('maintenance lock timeout rolls back gate/revision/receipt and SHARE timeout admits no half effect', async () => {
  const workspaceId = await createWorkspace(app.db);
  const client = new Client({ connectionString: database.appUrl, application_name: 'relay-m07-lock-holder' });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('select singleton from runtime_admission_gate for share');
    const commandId = randomUUID();
    await rejected('MAINTENANCE_UNAVAILABLE', () => changeAdmission(app.db,
      { commandId, action: 'begin-drain', expectedRevision: '0' }));
    await client.query('rollback');
    assert.deepEqual(await readAdmissionStatus(app.db), { target: 'DATABASE', mode: 'NORMAL', revision: '0' });
    assert.equal(await createRepositories(app.db).receipts.findReceipt({
      scopeKey: 'runtime:database-admission', commandId }), undefined);
    await client.query('begin');
    await client.query('select singleton from runtime_admission_gate for update');
    const ordinaryId = randomUUID();
    await rejected('MAINTENANCE_UNAVAILABLE', () => createProject(app.db,
      { workspaceId, commandId: ordinaryId, title: 'Never created', projectType: 'GENERAL' }));
    await client.query('rollback');
    assert.equal((await sql<{ count: string }>`select count(*)::text as count from projects`
      .execute(app.db)).rows[0]?.count, '0');
    assert.equal(await createRepositories(app.db).receipts.findReceipt({
      scopeKey: httpCommandScopeKey(workspaceId), commandId: ordinaryId }), undefined);
  } finally { await client.query('rollback'); await client.end(); }
});

test('missing or inaccessible gate fails closed without blocking an existing receipt', async () => {
  const workspaceId = await createWorkspace(app.db);
  const input = { workspaceId, commandId: randomUUID(), title: 'Existing', projectType: 'GENERAL' as const };
  const original = await createProject(app.db, input);
  await sql`delete from runtime_admission_gate`.execute(observer.db);
  await rejected('MAINTENANCE_UNAVAILABLE', () => createProject(app.db, { ...input, commandId: randomUUID() }));
  assert.deepEqual((await createProject(app.db, input)).result, original.result);
  await sql`insert into runtime_admission_gate (singleton) values (true)`.execute(observer.db);
  await sql`revoke select on runtime_admission_gate from relay_app`.execute(observer.db);
  await rejected('MAINTENANCE_UNAVAILABLE', () => readAdmissionStatus(app.db));
  await rejected('MAINTENANCE_UNAVAILABLE', () => createProject(app.db, { ...input, commandId: randomUUID() }));
  assert.equal((await createProject(app.db, input)).replayed, true);
});

test('gate restores original business lock timeout and never lengthens a shorter caller timeout', async () => {
  for (const timeout of ['0', '10s', '50ms']) {
    await app.db.transaction().execute(async (trx) => {
      await sql`select set_config('lock_timeout', ${timeout}, true)`.execute(trx);
      const before = (await sql<{ value: string }>`select current_setting('lock_timeout') as value`
        .execute(trx)).rows[0]!.value;
      await readAdmission(createRepositories(trx), 'share');
      const after = (await sql<{ value: string }>`select current_setting('lock_timeout') as value`
        .execute(trx)).rows[0]!.value;
      assert.equal(after, before);
    });
  }
  const client = new Client({ connectionString: database.appUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query('select singleton from runtime_admission_gate for update');
    const began = Date.now();
    await rejected('MAINTENANCE_UNAVAILABLE', () => app.db.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '50ms'`.execute(trx);
      await readAdmission(createRepositories(trx), 'share');
      assert.fail('shorter timeout did not reject admission');
    }));
    assert.ok(Date.now() - began < 1000, '50ms gate wait must not be stretched to 5 seconds');
  } finally { await client.query('rollback'); await client.end(); }
});

test('UPDATE-first committed DRAINING rejects a later SHARE request before its business callback', async () => {
  const workspaceId = await createWorkspace(app.db);
  const maintenance = openDatabase(database.appUrl, 'relay-m07-update-first');
  const arriving = openDatabase(database.appUrl, 'relay-m07-arriving-share');
  const hold = pausePoint();
  try {
    const transition = withTransaction(maintenance.db, async (r) => {
      await readAdmission(r, 'update');
      await r.admission.compareAndSet(0n, 'DRAINING');
      await hold.wait();
    });
    await hold.reached;
    const request = createProject(arriving.db, { workspaceId, commandId: randomUUID(),
      title: 'Late arrival', projectType: 'GENERAL' });
    // Attach rejection assertion before unblocking the actual database wait.
    const checked = rejected('MAINTENANCE_DRAINING', () => request);
    await waitForDatabaseLock('relay-m07-arriving-share');
    hold.release();
    await Promise.all([transition, checked]);
    assert.equal((await readAdmissionStatus(app.db)).mode, 'DRAINING');
    assert.equal((await sql<{ count: string }>`select count(*)::text as count from projects`
      .execute(app.db)).rows[0]?.count, '0');
  } finally { hold.release(); await maintenance.close(); await arriving.close(); }
});

test('DRAINING retains original Gateway delivery and UNKNOWN/PARTIAL stop-proof disposition without claiming cancellation complete', async () => {
  for (const variant of ['NO_RECEIPT', 'PARTIAL'] as const) {
    const f = await fixture();
    const root = join(dataRoot, variant);
    await mkdir(root);
    if (variant === 'PARTIAL') await writeFile(join(root, 'existing.txt'), 'keep original\n');
    const resource = await registerManagedResource(app.db, { ...f, rootPath: root });
    const connection = await createFakeConnection(app.db, { ...f, capabilities: ['FILE_WRITE'] });
    await createGatewayPolicy(app.db, { ...f, capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET',
      targetPrefix: resource.canonicalRoot, decision: 'ASK', maxPayloadBytes: 8192 });
    const delegatedRun = await delegateTask(app.db, { ...f, commandId: randomUUID(), expectedTaskRevision: '0' });
    const runId = delegatedRun.result.run_id;
    const launchId = randomUUID();
    const workerId = `worker:desktop:${launchId}:${randomUUID()}`;
    const claim = await claimNextRunCommand(app.db, workerId, 60_000);
    assert.equal(claim?.runId, runId);
    const delivery = { commandId: claim!.commandId, invocationEpoch: claim!.epoch };
    for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
      assert.equal((await advanceRunStep(app.db, { runId, workerId,
        invocationEpoch: claim!.epoch, leaseMs: 60_000, storage })).status, 'STEP_SUCCEEDED', kind);
    }
    const draft = await createRepositories(app.db).runs.readStepByKind(runId, 'DRAFT');
    const firstEpoch = BigInt((await claimRunForGateway(app.db,
      { workspaceId: f.workspaceId, runId, workerId, delivery })).worker_epoch);
    const origin: GatewayOrigin = { kind: 'RUN', runId, stepId: draft!.id,
      resourceId: resource.resourceId, workerId, workerEpoch: firstEpoch, delivery };
    const operationId = randomUUID();
    const changes = [{ path: 'created.txt', action: 'CREATE', content: 'partial created\n' },
      ...(variant === 'NO_RECEIPT' ? [] : [{ path: 'existing.txt', action: 'MODIFY',
        baselineSha256: '0'.repeat(64), content: 'must not replace\n' }])];
    const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId, intentKey: `maintenance-${variant}`, connectionId: connection.connectionId,
      origin, actionType: 'APPLY_CHANGESET', target: resource.canonicalRoot, params: { changes } });
    const review = await createRepositories(app.db).reviews.readRequest(prepared.review_id!);
    await resolveReview(app.db, { workspaceId: f.workspaceId, reviewId: review!.id,
      commandId: randomUUID(), expectedRevision: review!.revision.toString(),
      targetHash: review!.target_hash.toString('hex'), decision: 'APPROVE' });
    await drain();
    await rejected('MAINTENANCE_DRAINING', () => claimRunForGateway(app.db,
      { workspaceId: f.workspaceId, runId, workerId: 'unowned-legacy-worker' }));
    await rejected('MAINTENANCE_DRAINING', () => claimGatewayWorker(app.db,
      { workspaceId: f.workspaceId, operationId, workerId: 'unowned-legacy-worker' }));
    const workerEpoch = BigInt((await claimGatewayWorker(app.db,
      { workspaceId: f.workspaceId, operationId, workerId, delivery })).worker_epoch);
    await assert.rejects(() => dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId, origin: { ...origin, workerEpoch }, hooks: variant === 'NO_RECEIPT'
        ? { afterAdmit: async () => { throw new SimulatedGatewayCrash('before adapter receipt'); } }
        : { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after partial adapter receipt'); } } }),
    SimulatedGatewayCrash);
    const invocation = await createRepositories(app.db).gateway.lastInvocation(operationId);
    await recoverStoppedDesktopLaunch({ db: app.db, dataRoot, launchId,
      stopEvidence: 'armed_job_terminated_and_active_count_zero' });
    const stopped = await readFileWriteDispositionPreview(app.db, f.workspaceId, operationId);
    assert.equal(stopped.stop_proof_recorded, true);
    assert.equal(stopped.operation_status, 'UNKNOWN');
    assert.equal(stopped.observation_mode, variant === 'PARTIAL' ? 'PARTIAL_LEDGER' : 'NO_RECEIPT');
    assert.equal(stopped.can_dispose, true, JSON.stringify(stopped.blocking_reasons));
    await cancelTask(app.db, { ...f, commandId: randomUUID(),
      expectedRevision: stopped.task_revision, expectedRunRevision: stopped.run_revision });
    await applySafeControl(app.db, runId);
    assert.equal((await createRepositories(app.db).runs.readRun(runId))?.status, 'RUNNING',
      'UNKNOWN/PARTIAL must not become cancelled before explicit safe disposition');
    const current = await readFileWriteDispositionPreview(app.db, f.workspaceId, operationId);
    const commandId = randomUUID();
    const input = { workspaceId: f.workspaceId, operationId, invocationId: invocation!.id,
      commandId, decision: 'KEEP_CURRENT_AND_FAIL_RUN' as const,
      expectedRunRevision: current.run_revision, expectedTaskRevision: current.task_revision,
      expectedObservationSha256: current.observation_sha256! };
    const settled = await closePartialFileWriteCommand(app.db, input);
    assert.equal(settled.result.run_status, 'FAILED');
    assert.equal(settled.result.task_status, 'READY');
    assert.equal((await closePartialFileWriteCommand(app.db, input)).replayed, true);
    if (variant === 'PARTIAL') {
      assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'partial created\n');
      assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'keep original\n');
    }
    assert.equal((await readAdmissionStatus(app.db)).mode, 'DRAINING');
    await changeAdmission(app.db, { commandId: randomUUID(), action: 'resume-admission',
      expectedRevision: (await readAdmissionStatus(app.db)).revision });
  }
});

test('new VERIFY refuses with zero calls while a previously reserved VERIFY settles in DRAINING', async () => {
  const workspaceId = await createWorkspace(app.db);
  const env = { RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_NAME: 'controlled-verify', RELAY_MODEL_API_KEY: 'test-only-placeholder' };
  let externalCalls = 0;
  const fakeVerify = createFakeVerifyCall('SUCCESS');
  const input = { db: app.db, workspaceId, env, call: {
    call: async (request: Parameters<typeof fakeVerify.call>[0]) => {
      externalCalls += 1;
      const started = await sql<{ status: string }>`select status from model_calls
        where kind = 'VERIFY'`.execute(app.db);
      assert.deepEqual(started.rows, [{ status: 'STARTED' }]);
      await drain();
      return fakeVerify.call(request);
    },
  } };
  await drain();
  await rejected('MAINTENANCE_DRAINING', () => runModelPortVerification(input));
  assert.equal(externalCalls, 0);
  assert.equal((await sql<{ count: string }>`select count(*)::text as count from model_calls
    where kind = 'VERIFY'`.execute(app.db)).rows[0]?.count, '0');
  await changeAdmission(app.db, { commandId: randomUUID(), action: 'resume-admission', expectedRevision: '1' });
  assert.equal((await runModelPortVerification(input)).ok, true);
  assert.equal(externalCalls, 1);
  assert.deepEqual((await sql<{ status: string }>`select status from model_calls
    where kind = 'VERIFY'`.execute(app.db)).rows, [{ status: 'COMPLETED' }]);
  await rejected('MAINTENANCE_DRAINING', () => runModelPortVerification(input));
  assert.equal(externalCalls, 1);
});
