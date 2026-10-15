import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import type { FrozenCheck } from '../../src/application/run-scope-grant.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { graphCheckpointsReady, installGraphCheckpoints } from
  '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * CT-12：完整生产图链里「派发前确定拒绝」的状态收口与原任务接续。
 *
 * 为什么单独一个套件文件：`claimNextRunCommand` 按整库选取待投递命令，这是生产语义本身，
 * 不带 workspace 过滤。因此任何用 `runOneCommand` 驱动真实图的用例都必须独占一个数据库，
 * 否则一次投递可能领取到**别的**用例留下的命令，测到的不是本 Run 的收口。运行器为每个测试
 * 文件克隆独占库（见 verification-plan §20.10「集成套件的数据隔离」），本文件因此自带最小
 * fixture，不与 `check-trust-gate` 共用。
 *
 * 锁的是业务事实而不是内部形状：真实 START 投递 → 图内等待 ACTION_APPROVAL → 真实批准排出的
 * RESUME → 材料漂移 → 确定性拒绝。必须核对零 Invocation、原 Operation/工具行/Run/Task/命令
 * 的一致结算，以及「确定未执行不投影成 ACTION_UNKNOWN」。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-check-trust-refusal');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  // 官方 Saver 表缺失时 runOneCommand 会在领取处失败，那样测到的是环境而不是状态收口。
  await installGraphCheckpoints(MIGRATION_DATABASE_URL);
  assert.ok(await graphCheckpointsReady(app.db, APP_DATABASE_URL),
    '完整图反例要求官方 Saver 表已就绪并对应用角色可用');
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly scriptPath: string;
  readonly check: FrozenCheck;
}

/** 一次真实委派：受管根里有入口脚本，构建配置在根顶层，CLI_RUN 走 AUTO + 范围授权。 */
async function fixture(scriptText: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-refusal-graph-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'value.txt'), 'incorrect\n', 'utf8');
  await writeFile(join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { check: 'node check.mjs' } }), 'utf8');
  const scriptPath = join(root, 'check.mjs');
  await writeFile(scriptPath, scriptText, 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'refusal-graph' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'refusal-graph',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of ['FILE_QUERY', 'FILE_READ', 'FILE_WRITE',
      'CLI_RUN'] as GatewayCapability[]) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE'],
    ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'READ_CHANGE_SET'],
    ['CLI_RUN', 'CLI_RUN']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }

  const check: FrozenCheck = { id: 'check-1', executable: process.execPath, args: [scriptPath],
    max_output_bytes: 4096,
    executable_sha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex') };
  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '完整图拒绝收口', objective: '按冻结检查执行一次真实命令',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: resourceId,
      connections: { FILE_QUERY: connectionId, FILE_READ: connectionId,
        FILE_WRITE: connectionId, CLI_RUN: connectionId },
      allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
    scopeGrant: { resource_id: resourceId, allowed_actions: ['CLI_RUN'], checks: [check] } });
  return { workspaceId, projectId, taskId: task.result.task_id, runId: delegated.result.run_id,
    resourceId, connectionId, scriptPath, check };
}

const CHECK_ROUND: readonly JsonObject[][] =
  [[{ name: 'run_check', arguments: { check_id: 'check-1' } }]];

/** 一次真实投递。它按整库领取，所以必须断言领取到的就是本 Run。 */
async function deliver(runId: string) {
  const delivered = await runOneCommand(app.db, { workerId: `graph-${randomUUID()}`, dataRoot,
    checkpointUrl: APP_DATABASE_URL, fakeToolScript: CHECK_ROUND as never, leaseMs: 30_000 });
  assert.equal(delivered?.runId, runId,
    `本独占库内只应存在本用例的命令：${JSON.stringify(delivered)}`);
  return delivered;
}

async function approve(workspaceId: string, reviewId: string) {
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(reviewId));
  assert.ok(review !== undefined);
  return resolveReview(app.db, { workspaceId, reviewId, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
    decision: 'APPROVE' });
}

/** 批准后排出的那一条 RESUME 命令 id：真实恢复必须用它。 */
async function resumeCommandId(decisionId: string): Promise<string> {
  const commands = await sql<{ id: string }>`select id from run_commands
    where review_decision_id = ${decisionId}`.execute(app.db);
  assert.equal(commands.rows.length, 1, '批准必须恰好排出一条恢复命令');
  return commands.rows[0]!.id;
}

/** 把 Run 驱动到图内 ACTION_APPROVAL 等待点，返回那条 Review 与工具行身份。 */
async function waitForApproval(fx: Fixture): Promise<{ readonly toolCallId: string;
  readonly operationId: string; readonly reviewId: string;
  readonly boundDigest: string }> {
  const started = await deliver(fx.runId);
  assert.equal(started?.outcome, 'DONE', JSON.stringify(started));
  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.status, 'WAITING_APPROVAL', '真实图必须在 ACTION_APPROVAL 上停住');
  assert.ok(row.operation_id !== null);
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row.operation_id!));
  assert.ok(review !== undefined, '真实图必须产生一条待批准 Review');
  const bound = review.target.check_trust_basis as JsonObject | undefined;
  assert.ok(bound !== undefined && typeof bound.digest === 'string',
    '批准对象必须绑定创建 Review 时观察到的材料');
  return { toolCallId: row.id, operationId: row.operation_id!, reviewId: review.id,
    boundDigest: bound.digest };
}

const FROZEN = 'console.log("FROZEN_SCRIPT");\n';
const REVIEWED = 'console.log("REVIEWED_SCRIPT");\n';
const DRIFTED = 'console.log("DRIFTED_SCRIPT");\n';

test('CT-12 完整图：批准后材料漂移的确定拒绝必须闭合原动作/任务/命令且不返回 ACTION_UNKNOWN', async () => {
  const fx = await fixture(FROZEN);
  // 冻结之后换一次脚本：这正是退回人工的原因，Review 绑定 REVIEWED。
  await writeFile(fx.scriptPath, REVIEWED, 'utf8');
  const waiting = await waitForApproval(fx);
  const resolved = await approve(fx.workspaceId, waiting.reviewId);

  // 批准合法；漂移发生在批准之后、真实派发之前。
  await writeFile(fx.scriptPath, DRIFTED, 'utf8');
  const resumed = await deliver(fx.runId);
  assert.equal(resumed?.commandId, await resumeCommandId(resolved.result.decision_id));
  assert.equal(resumed?.outcome, 'DONE', '确定性拒绝不应把命令挂成需要恢复');

  // 未批准材料零执行，且不派生第二个动作身份。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId));
  assert.equal(operation?.id, waiting.operationId);
  assert.equal(operation?.status, 'DENIED',
    `派发前确定拒绝必须让原 Operation 收口，实际 ${String(operation?.status)}`);
  assert.equal(operation?.result_ref?.reason, 'GATEWAY_APPROVAL_STALE');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId))).length, 0,
  '未批准材料不得产生任何真实调用');
  assert.ok(!JSON.stringify(operation?.result_ref ?? {}).includes('DRIFTED_SCRIPT'),
    '漂移材料不得留下任何执行痕迹');

  // 工具行、Run、Task 三者一致：不再有「已结算工具 + 等待批准的动作」这种悬空组合。
  const settled = await new RunToolCallRepository(app.db).read(waiting.toolCallId);
  assert.equal(settled?.status, 'SETTLED');
  assert.equal(settled?.result_ref?.reason, 'GATEWAY_APPROVAL_STALE');
  const run = await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId));
  assert.equal(run?.status, 'FAILED', `原 Run 必须收口，实际 ${String(run?.status)}`);
  assert.equal(run?.wait_reason, 'GATEWAY_APPROVAL_STALE');
  const task = await withTransaction(app.db, (repositories) => repositories.tasks.readTask(fx.taskId));
  assert.equal(task?.status, 'READY', 'AI 执行权必须释放回用户');
  assert.equal(task?.executor_run_id, null);
  assert.deepEqual(await withTransaction(app.db, (repositories) =>
    repositories.gateway.listUnresolvedRunOperations(fx.runId)), [],
  '收口后本 Run 不得残留未决 Gateway 动作');

  // 命令一致结算：没有待投递命令，也没有需要停机证据的 BLOCKED。
  assert.deepEqual((await withTransaction(app.db, (repositories) =>
    repositories.dispatch.listPending(16)))
    .filter((command) => command.run_id === fx.runId), []);
  const outboxes = await sql<{ kind: string; status: string }>`
    select c.kind, o.status from run_command_outbox o join run_commands c on c.id = o.command_id
    where c.run_id = ${fx.runId} order by c.ordinal`.execute(app.db);
  assert.deepEqual(outboxes.rows.map((row) => `${row.kind}:${row.status}`),
    ['START:DONE', 'RESUME:DONE']);

  // 确定未执行不投影成 ACTION_UNKNOWN：继续推进只报告终态。
  const advanced = await advanceRunStep(app.db, { runId: fx.runId,
    workerId: `graph-advance-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
    fakeToolScript: CHECK_ROUND as never });
  assert.equal(advanced.status, 'RUN_TERMINAL',
    `零 Invocation 的确定未执行不得返回 ACTION_UNKNOWN：${JSON.stringify(advanced)}`);

  // 再次投递没有可领取命令，也不会重新产生任何副作用。
  const again = await runOneCommand(app.db, { workerId: `graph-${randomUUID()}`, dataRoot,
    checkpointUrl: APP_DATABASE_URL, fakeToolScript: CHECK_ROUND as never, leaseMs: 30_000 });
  assert.equal(again, undefined, '收口后不得再有可领取命令');
  assert.equal((await new RunToolCallRepository(app.db).read(waiting.toolCallId))?.status, 'SETTLED');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId))).length, 0);
});

test('CT-12 完整图：原 Task 与原受管资源上的合法接续，旧依据保持可追溯', async () => {
  const fx = await fixture(FROZEN);
  await writeFile(fx.scriptPath, REVIEWED, 'utf8');
  const waiting = await waitForApproval(fx);
  const resolved = await approve(fx.workspaceId, waiting.reviewId);
  await writeFile(fx.scriptPath, DRIFTED, 'utf8');
  const refused = await deliver(fx.runId);
  assert.equal(refused?.outcome, 'DONE');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId)))?.status, 'DENIED');

  // 接续必须发生在**原 Task 与原受管资源**上：既有 Delegate 入口 + retry_of_run_id 引用已终态
  // 的原 Run。复制一个新工作区/目录/Task 只能证明「新任务能跑」，证明不了原任务的恢复。
  const task = await withTransaction(app.db, (repositories) =>
    repositories.tasks.readTask(fx.taskId));
  assert.equal(task?.status, 'READY', '原 Run 收口后 Task 才能重新委托');
  const next = await delegateTask(app.db, { workspaceId: fx.workspaceId, taskId: fx.taskId,
    commandId: randomUUID(), expectedTaskRevision: task!.revision.toString(),
    retryOfRunId: fx.runId,
    toolLoopAction: { resource_id: fx.resourceId,
      connections: { FILE_QUERY: fx.connectionId, FILE_READ: fx.connectionId,
        FILE_WRITE: fx.connectionId, CLI_RUN: fx.connectionId },
      allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
    scopeGrant: { resource_id: fx.resourceId, allowed_actions: ['CLI_RUN'],
      checks: [fx.check] } });
  const nextRunId = next.result.run_id;
  assert.notEqual(nextRunId, fx.runId, '接续必须产生新 Run，不能复活原动作身份');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(nextRunId)))?.task_id, fx.taskId);
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(nextRunId)))?.resource_id, fx.resourceId,
  '接续必须仍在原受管资源上，不能换一个目录冒充恢复');

  // 重新委托那一刻，磁盘上就是 DRIFTED；新授权按当前材料冻结。此后不再改动，
  // 检查按原授权自动执行——旧 Run 那份已失效的批准从头到尾没有参与。
  const executed = await deliver(nextRunId);
  assert.equal(executed?.outcome, 'DONE', JSON.stringify(executed));
  const nextRows = await new RunToolCallRepository(app.db).listByRun(nextRunId);
  assert.equal(nextRows.length, 1);
  assert.equal(nextRows[0]!.status, 'SETTLED');
  const nextOperation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(nextRows[0]!.operation_id!));
  assert.equal(nextOperation?.result_ref?.stdout, 'DRIFTED_SCRIPT\n',
    '接续后的 Run 执行的是它自己那份授权所绑定的材料');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(nextRows[0]!.operation_id!))).length, 1,
  '同一请求不得重复执行');

  // 旧依据保持可追溯：旧 Review、决定与原 Run 都没有被接续改写。
  const oldReview = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(waiting.reviewId));
  assert.ok(oldReview !== undefined, '旧 Review 不能因接续而被抹去');
  assert.equal(oldReview!.status, 'DECIDED');
  assert.equal(String((oldReview!.target.check_trust_basis as JsonObject).digest),
    waiting.boundDigest, '旧 Review 仍记录它当时绑定的材料');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId)))?.status, 'FAILED', '历史 Run 不得复活');
  assert.notEqual(nextOperation?.id, waiting.operationId, '接续不得复用原动作身份');
});
