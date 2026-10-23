import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import {
  claimRunForGateway, dispatchGatewayAction, prepareGatewayAction,
  SimulatedGatewayCrash, type GatewayOrigin,
} from '../../src/application/gateway-actions.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource } from '../../src/application/gateway-configuration.js';
import { reconcileReadonlyGatewayOperationCommand } from '../../src/application/gateway-reconcile.js';
import { DomainError } from '../../src/application/domain-error.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * DEV-0054：未决只读动作的**手动核对**（真实 PG + 受控本机 HTTP）。
 *
 * 覆盖四条边界与两条落库事实：
 *   * PREPARED 是唯一证明「调用未开始」的状态 → NOT_EXECUTED，动作回 PREPARED 可再投递；
 *   * admit 后崩溃（UNKNOWN）→ 安全重读收敛为 SUCCEEDED，结论带 invocation_id 与重读证据；
 *   * RUN 有活跃 Worker / 写能力 / 跨 Workspace 三种越界一律拒绝，不放行手动结清；
 *   * 命令幂等：同 command_id 重放返回原结论，不二次落库。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-dev-0054-reconcile');
let dataRoot: string;
let storage: ManagedContentStore;
let server: Server;
let port = 0;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
  server = createServer((request, response) => {
    if ((request.url ?? '') === '/plain') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('手动核对正文');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  try { if (server !== undefined) await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); }); }
  finally {
    try { await app.close(); } finally { if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true }); }
  }
});

interface Fixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  connectionId: string; resourceId: string; resourceRoot: string;
}

async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `d54-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'DEV-0054 Reconcile', projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Reconcile',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '只读核对', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(),
    expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  for (const kind of ['BUILD_CONTEXT', 'DRAFT'] as const) {
    const result = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  const step = await withTransaction(app.db, (repositories) => repositories.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(step);
  const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: ['WEB_FETCH'], allowedHost: '127.0.0.1', allowPrivate: true });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'WEB_FETCH',
    actionType: 'WEB_FETCH', targetPrefix: '127.0.0.1', decision: 'AUTO', maxPayloadBytes: 1024 });
  const root = join(dataRoot, `reconcile-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  return { workspaceId, projectId, taskId, runId, stepId: step.id, connectionId: connection.result.connection_id!,
    resourceId: resource.resourceId, resourceRoot: resource.canonicalRoot };
}

// WEB_FETCH 指向 URL、不绑定受管资源（与 mock-gateway-action 的 RUN origin 同形）：
// origin 带上 resourceId 会让 dispatch 的 originMatches 拒掉 prepare 自己落库的行。
async function claimWorker(f: Fixture, options: { readonly bindResource?: boolean } = {}):
  Promise<Extract<GatewayOrigin, { kind: 'RUN' }>> {
  const workerId = `worker-${randomUUID()}`;
  const claim = await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId });
  return { kind: 'RUN', runId: f.runId, stepId: f.stepId, workerId,
    ...(options.bindResource ? { resourceId: f.resourceId } : {}),
    workerEpoch: BigInt(claim.worker_epoch) };
}

async function prepareWebFetch(f: Fixture, origin: GatewayOrigin): Promise<string> {
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH', target: `http://127.0.0.1:${port}/plain`, params: {} });
  return prepared.operation_id;
}

async function lastInvocationId(operationId: string): Promise<string> {
  const row = await sql<{ id: string }>`select id from invocation_attempts
    where operation_id = ${operationId} order by attempt_number desc limit 1`.execute(app.db);
  return row.rows[0]!.id;
}

function domainError(error: unknown): DomainError {
  assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
  return error;
}

test('PREPARED 的只读动作手动核对为 NOT_EXECUTED，动作回到 PREPARED 可再投递', async () => {
  const f = await fixture();
  const origin = await claimWorker(f);
  const operationId = await prepareWebFetch(f, origin);

  const outcome = await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: f.workspaceId, operationId, commandId: randomUUID() });
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.result.status, 'NOT_EXECUTED');
  assert.equal(outcome.result.reconciliation, 'PREPARED_NOT_EXECUTED');
  assert.equal(outcome.result.capability_key, 'WEB_FETCH');

  const operation = await sql<{ status: string }>`select status from logical_operations
    where id = ${operationId}`.execute(app.db);
  // NOT_EXECUTED 不终结动作：回到 PREPARED，保持可被后续投递的原状（与恢复路径同口径）。
  assert.equal(operation.rows[0]!.status, 'PREPARED');
  const invocation = await sql<{ status: string; result_ref: { manual?: boolean } | null }>`
    select status, result_ref from invocation_attempts where id = ${outcome.result.invocation_id}`
    .execute(app.db);
  assert.equal(invocation.rows[0]!.status, 'NOT_EXECUTED');
  assert.equal(invocation.rows[0]!.result_ref?.manual, true);

  // 核对作为关键审计落库，可追溯到命令与动作。
  const activity = await sql<{ count: bigint }>`select count(*)::bigint as count from activity_records
    where workspace_id = ${f.workspaceId} and event_type = 'GATEWAY_OPERATION_RECONCILED'
      and fact_refs->>'operation_id' = ${operationId}`.execute(app.db);
  assert.equal(Number(activity.rows[0]!.count), 1);
});

test('admit 后崩溃的 UNKNOWN 手动核对安全重读，收敛为 SUCCEEDED', async () => {
  const f = await fixture();
  const origin = await claimWorker(f);
  const operationId = await prepareWebFetch(f, origin);
  await assert.rejects(
    dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId, origin,
      hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('after admit'); } } }),
    SimulatedGatewayCrash);
  const before = await sql<{ status: string }>`select status from invocation_attempts
    where operation_id = ${operationId}`.execute(app.db);
  // admit 后崩溃：调用停在 DISPATCHING（未结算）或 UNKNOWN，二者都属未决，手动核对都受理。
  assert.ok(['DISPATCHING', 'UNKNOWN'].includes(before.rows[0]!.status),
    `unexpected settled status: ${before.rows[0]!.status}`);

  const outcome = await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: f.workspaceId, operationId, commandId: randomUUID() });
  assert.equal(outcome.result.status, 'SUCCEEDED');
  assert.equal(outcome.result.reconciliation, 'SAFE_REREAD');
  const after = await sql<{ status: string; result_ref: { reconciliation?: string } | null }>`
    select status, result_ref from invocation_attempts where id = ${outcome.result.invocation_id}`
    .execute(app.db);
  assert.equal(after.rows[0]!.status, 'SUCCEEDED');
  assert.equal(after.rows[0]!.result_ref?.reconciliation, 'SAFE_REREAD');
  const operation = await sql<{ status: string }>`select status from logical_operations
    where id = ${operationId}`.execute(app.db);
  assert.equal(operation.rows[0]!.status, 'SUCCEEDED');
});

test('同一 command_id 重放返回原结论，不重复落库', async () => {
  const f = await fixture();
  const origin = await claimWorker(f);
  const operationId = await prepareWebFetch(f, origin);
  const commandId = randomUUID();
  const first = await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: f.workspaceId, operationId, commandId });
  assert.equal(first.replayed, false);
  const second = await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: f.workspaceId, operationId, commandId });
  assert.equal(second.replayed, true);
  assert.equal(second.result.status, first.result.status);
  assert.equal(second.result.invocation_id, first.result.invocation_id);
  const activity = await sql<{ count: bigint }>`select count(*)::bigint as count from activity_records
    where workspace_id = ${f.workspaceId} and event_type = 'GATEWAY_OPERATION_RECONCILED'
      and fact_refs->>'operation_id' = ${operationId}`.execute(app.db);
  assert.equal(Number(activity.rows[0]!.count), 1, '重放不得再写一条审计');
});

test('被新 Worker 接管的 Run 拒绝手动核对（跨执行进程不混淆）', async () => {
  const f = await fixture();
  const origin = await claimWorker(f);
  const operationId = await prepareWebFetch(f, origin);
  // 新 epoch 接管同一 Run：旧调用不再接受手动核对。同身份 Worker 未释放时可核对由测试 1 覆盖。
  // 接管走恢复路径的停机证明：fence 清空占有者后 claimWorker 才接受（它只认领空闲 Run）。
  await withTransaction(app.db, async (r) => {
    assert.ok(await r.runs.fenceWorker(f.runId));
    assert.ok(await r.runs.claimWorker(f.runId, `worker-${randomUUID()}`,
      new Date(Date.now() + 30_000)));
  });
  const error = domainError(await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: f.workspaceId, operationId, commandId: randomUUID() }).catch((caught) => caught));
  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.match(error.detail, /新的执行进程接管/u);
});

test('写能力一律拒绝手动核对，指向停机恢复路径', async () => {
  const f = await fixture();
  const origin = await claimWorker(f, { bindResource: true });
  const fake = await createFakeConnection(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capabilities: ['FAKE_WRITE'] });
  await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'FAKE_WRITE', actionType: 'WRITE_MARKER', targetPrefix: f.resourceRoot,
    decision: 'AUTO', maxPayloadBytes: 1024 });
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`,
    connectionId: fake.connectionId, origin, actionType: 'WRITE_MARKER',
    target: join(f.resourceRoot, `${randomUUID()}.json`), params: { content: 'x' } });
  const error = domainError(await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: f.workspaceId, operationId: prepared.operation_id, commandId: randomUUID() })
    .catch((caught) => caught));
  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.match(error.detail, /停机恢复路径|人工处置/u);
});

test('跨 Workspace 的 operation 一律 404，不做能力判定', async () => {
  const f = await fixture();
  const origin = await claimWorker(f);
  const operationId = await prepareWebFetch(f, origin);
  const error = domainError(await reconcileReadonlyGatewayOperationCommand(app.db, {
    workspaceId: randomUUID(), operationId, commandId: randomUUID() }).catch((caught) => caught));
  assert.equal(error.code, 'RESOURCE_NOT_FOUND');
});
