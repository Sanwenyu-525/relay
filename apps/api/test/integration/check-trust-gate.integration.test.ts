import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createTask } from '../../src/application/create-task.js';
import { applySafeControl, requestRunControl } from '../../src/application/control-requests.js';
import { DomainError } from '../../src/application/domain-error.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { RunScopeGrantRepository, type FrozenCheck } from
  '../../src/application/run-scope-grant.js';
import { withTransaction, type Repositories } from '../../src/application/unit-of-work.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from
  './integration-support.js';

/**
 * 检查入口信任摘要（Stage A）的真实 PG 出口。
 *
 * 锁的是业务事实而不是内部形状：
 *   - 授权冻结时把「这次检查实际跑的材料」一并落库；
 *   - 同一 check_id、同一路径、同一命令名，入口脚本正文被改后不再 AUTO，退回人工确认，
 *     并把类型化原因写进 Review；
 *   - 只改被检查的源文件不使原信任失效，检查仍按原授权自动执行；
 *   - 内联求值参数在冻结期就被拒绝，不落一份没有依据的授权；
 *   - 历史授权行（只有入口摘要、没有材料依据）同样不自动放行；
 *   - 选项结束标记 `--` 之后真正被执行、名称以横线开头的入口同样进冻结材料，
 *     冻结期读不到就在冻结期被拒，冻结之后被换掉则退回人工。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-check-trust-gate');
// 授权边界对应用角色不可改写（只有撤销列有 UPDATE），所以「模拟升级前的历史行」必须
// 用迁移角色；这不是绕过产品约束，而是造一条产品已经不可能再写出来的历史数据。
const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-check-trust-gate-migrator');
let dataRoot: string;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => {
  await app.close();
  await migrator.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly canonicalRoot: string;
  readonly scriptPath: string;
  /** 本次委托冻结的那份检查配置；原任务重新委托时用的是同一个对象。 */
  readonly check: FrozenCheck;
  /** 本次 CLI_RUN 策略身份：撤权反例必须精确作用在这一条上。 */
  readonly cliRunPolicyId: string;
}

const CHECK_SCRIPT_V1 = 'console.log("check-ok");\n';

/**
 * 已冻结的检查（不含 Run）：委托之前的准备结果。冻结期被拒的用例要断言「没有落授权行」，
 * 所以准备与委托必须能分开驱动，否则那条反例只能断言异常、无法核对数据库事实。
 */
interface PreparedFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly canonicalRoot: string;
  readonly scriptPath: string;
  /** 终止符形态下真正被执行、名称以横线开头的入口脚本；未预置时为 null。 */
  readonly terminatorEntryPath: string | null;
  readonly cliRunPolicyId: string;
  readonly check: FrozenCheck;
}

/**
 * 建一个带范围授权的最小工作区：受管根里有入口脚本、构建配置与被检查的源文件。
 * 检查入口是 node.exe，第一个路径参数是根内的脚本——这是最常见的检查形态。
 */
async function prepareFixture(scriptText = CHECK_SCRIPT_V1, options?: {
  readonly writeEnvFile?: boolean;
  readonly checkArgs?: (scriptPath: string) => readonly string[];
  /** 预置选项结束标记形态下真正被执行、名称以横线开头的入口脚本。 */
  readonly writeTerminatorEntry?: string;
  /**
   * 预置受管根里名为 `--` 的文件。固定 Node 24.21.0 实测：`--env-file=--` 会真实
   * 打开这个文件（把内容从 A 改成 B，脚本读到的环境变量随之变化，exit 0）。
   */
  readonly writeDashDashFile?: string;
}): Promise<PreparedFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-check-trust-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\n', 'utf8');
  await writeFile(join(root, 'src', 'value.txt'), 'incorrect\n', 'utf8');
  await writeFile(join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { check: 'node check.mjs' } }), 'utf8');
  const scriptPath = join(root, 'check.mjs');
  await writeFile(scriptPath, scriptText, 'utf8');
  if (options?.writeEnvFile) {
    await writeFile(join(root, '.env'), 'RELAY_TRUST_ENV=1\n', 'utf8');
  }
  if (options?.writeDashDashFile !== undefined) {
    await writeFile(join(root, '--'), options.writeDashDashFile, 'utf8');
  }
  let terminatorEntryPath: string | null = null;
  if (options?.writeTerminatorEntry !== undefined) {
    terminatorEntryPath = join(root, '--entry.mjs');
    await writeFile(terminatorEntryPath, options.writeTerminatorEntry, 'utf8');
  }

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'check-trust' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'check-trust',
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
  let cliRunPolicyId = '';
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE'],
    ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'READ_CHANGE_SET'],
    ['CLI_RUN', 'CLI_RUN']] as const) {
    const created = await createGatewayPolicy(app.db, { workspaceId, projectId, capability,
      actionType, targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
    if (capability === 'CLI_RUN' && actionType === 'CLI_RUN') cliRunPolicyId = created.policyId;
  }

  const check: FrozenCheck = { id: 'check-1', executable: process.execPath,
    args: options?.checkArgs !== undefined ? options.checkArgs(scriptPath) : [scriptPath],
    max_output_bytes: 4096,
    executable_sha256: sha256(await readFile(process.execPath)) };
  return { workspaceId, projectId, resourceId, connectionId, canonicalRoot, scriptPath,
    terminatorEntryPath, cliRunPolicyId, check };
}

/** 准备 + 委托：正常冻结路径（授权行与 Run 都已落下）。 */
async function fixture(scriptText = CHECK_SCRIPT_V1, options?: {
  readonly writeEnvFile?: boolean;
  readonly checkArgs?: (scriptPath: string) => readonly string[];
  readonly writeTerminatorEntry?: string;
  readonly writeDashDashFile?: string;
}): Promise<Fixture> {
  const prepared = await prepareFixture(scriptText, options);
  const task = await createTask(app.db, { workspaceId: prepared.workspaceId,
    commandId: randomUUID(), projectId: prepared.projectId,
    title: '跑一次已配置检查', objective: '按冻结检查执行一次真实命令',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId: prepared.workspaceId,
    taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  const delegated = await delegateTask(app.db, { workspaceId: prepared.workspaceId,
    taskId: task.result.task_id,
    commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: prepared.resourceId,
      connections: { FILE_QUERY: prepared.connectionId, FILE_READ: prepared.connectionId,
        FILE_WRITE: prepared.connectionId, CLI_RUN: prepared.connectionId },
      allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
    scopeGrant: { resource_id: prepared.resourceId, allowed_actions: ['CLI_RUN'],
      checks: [prepared.check] } });
  return { workspaceId: prepared.workspaceId, projectId: prepared.projectId,
    taskId: task.result.task_id, runId: delegated.result.run_id,
    resourceId: prepared.resourceId, connectionId: prepared.connectionId,
    canonicalRoot: prepared.canonicalRoot, scriptPath: prepared.scriptPath,
    check: prepared.check, cliRunPolicyId: prepared.cliRunPolicyId };
}

/**
 * 原 Task 上的合法接续：同一个 Task、同一个受管资源，按 retry_of_run_id 引用已终态的原 Run。
 *
 * 这条路径必须走既有领域入口（契约 02 第 4 节「AI 本轮不可恢复失败 → READY」后由用户重新
 * 委托），因此它同时断言前置条件：原 Run 已经是终态、Task 已经回到 READY。
 */
async function redelegateSameTask(fx: Fixture): Promise<string> {
  const task = await withTransaction(app.db, (repositories) =>
    repositories.tasks.readTask(fx.taskId));
  assert.ok(task !== undefined);
  assert.equal(task.status, 'READY',
    '原 Run 必须先安全收口并释放 AI 执行权，Task 才能被重新委托');
  assert.equal(task.executor_run_id, null, '重新委托前原执行权必须已释放');
  const delegated = await delegateTask(app.db, { workspaceId: fx.workspaceId,
    taskId: fx.taskId, commandId: randomUUID(),
    expectedTaskRevision: task.revision.toString(), retryOfRunId: fx.runId,
    toolLoopAction: { resource_id: fx.resourceId,
      connections: { FILE_QUERY: fx.connectionId, FILE_READ: fx.connectionId,
        FILE_WRITE: fx.connectionId, CLI_RUN: fx.connectionId },
      allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
    scopeGrant: { resource_id: fx.resourceId, allowed_actions: ['CLI_RUN'],
      checks: [fx.check] } });
  assert.notEqual(delegated.result.run_id, fx.runId,
    '接续必须产生新 Run 并引用旧 Run，不能复活原动作身份');
  return delegated.result.run_id;
}

/** 准备 + 建 Task 到 READY，不委托：用于「冻结期必须被拒」的用例。 */
async function readyTask(prepared: PreparedFixture): Promise<{ readonly taskId: string;
  readonly taskRevision: string }> {
  const task = await createTask(app.db, { workspaceId: prepared.workspaceId,
    commandId: randomUUID(), projectId: prepared.projectId,
    title: '跑一次已配置检查', objective: '按冻结检查执行一次真实命令',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId: prepared.workspaceId,
    taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  return { taskId: task.result.task_id, taskRevision: ready.result.revision };
}

const CHECK_ROUND: readonly JsonObject[][] =
  [[{ name: 'run_check', arguments: { check_id: 'check-1' } }]];

/** 有界驱动：推进步骤与派发工具交替，直到 Run 离开工具循环。 */
async function drive(fx: Fixture): Promise<{ readonly statuses: readonly string[];
  readonly toolCallId: string | null }> {
  const storage = new ManagedContentStore(dataRoot);
  const statuses: string[] = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
      workerId: `trust-${randomUUID()}`, storage, fakeToolScript: CHECK_ROUND as never });
    statuses.push(advanced.status);
    if (advanced.status === 'STEP_SUCCEEDED' || advanced.status === 'RETRYABLE' ||
        advanced.status === 'REPLAYED') continue;
    if (advanced.status !== 'TOOL_LOOP_ACTION_REQUIRED') return { statuses, toolCallId: null };
    const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
      runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
      workerId: `trust-${randomUUID()}`, epoch: 0n }, toolCallId: advanced.tool_call_id });
    statuses.push(`TOOL_${dispatched.status}`);
    return { statuses, toolCallId: dispatched.toolCallId };
  }
  throw new Error('推进超过步数上限');
}

/** 只推进到「模型已发出工具请求、尚未派发」这一刻，供重新确认场景复用同一动作入口。 */
async function advanceToPendingToolAction(fx: Fixture,
  script: readonly JsonObject[][], maxIterations = 10): Promise<string> {
  const storage = new ManagedContentStore(dataRoot);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
      workerId: `trust-${randomUUID()}`, storage, fakeToolScript: script as never });
    if (advanced.status === 'TOOL_LOOP_ACTION_REQUIRED') {
      assert.ok(advanced.tool_call_id !== null);
      return advanced.tool_call_id;
    }
    assert.ok(['STEP_SUCCEEDED', 'RETRYABLE', 'REPLAYED'].includes(advanced.status),
      `推进停在 ${advanced.status}，没有落到待派发的工具请求`);
  }
  throw new Error('推进超过步数上限，仍未出现待派发的工具请求');
}

async function frozenChecks(runId: string): Promise<readonly FrozenCheck[]> {
  const grant = await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(runId));
  assert.ok(grant !== undefined, '授权行必须存在');
  return grant.checks as unknown as readonly FrozenCheck[];
}

test('冻结期把入口脚本与根内构建配置算成信任依据并随授权落库', async () => {
  const fx = await fixture();
  const checks = await frozenChecks(fx.runId);
  assert.equal(checks.length, 1);
  const basis = checks[0]!.trust_basis;
  assert.ok(basis !== undefined, '冻结检查必须带信任依据');
  assert.equal(basis.version, 'check-trust-v1');
  const roles = new Map(basis.materials.map((material) => [material.role, material.path]));
  assert.ok(roles.has('EXECUTABLE'), '入口程序必须计入材料');
  assert.equal(roles.get('REFERENCED_SCRIPT'), fx.scriptPath.toLowerCase(),
    '第一个位置脚本参数是真正被执行的检查程序，必须计入材料');
  assert.ok([...roles.keys()].includes('BUILD_CONFIG'), '根内构建/测试配置必须计入材料');
  // 被检查的源文件不是材料。
  assert.ok(!basis.materials.some((material) => material.path.includes('value.txt')),
    '被检查的源文件不得计入执行材料');
});

test('同一 check_id 在入口脚本正文被改后不再自动放行，退回人工并带类型化原因', async () => {
  const fx = await fixture();
  // 同路径、同命令名，只把正文改成固定成功。
  await writeFile(fx.scriptPath, 'console.log("always ok");\nprocess.exit(0);\n', 'utf8');
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `入口脚本被改后不得自动执行：${JSON.stringify(driven.statuses)}`);
  assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得沿用旧信任直接放行');

  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  const row = rows[0];
  assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row!.operation_id!));
  assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
  assert.equal((review!.evidence as JsonObject).scope_decision_reason, 'SCOPE_GRANT_CHECK_CHANGED',
    '前端必须能区分「检查材料变了」和「策略本来就要人工」');
});

test('只改被检查的源文件不使原信任失效，检查仍按原授权自动执行', async () => {
  const fx = await fixture();
  // src/value.txt 是这次检查要看的输入，不是检查程序；改它不能把原授权判失效。
  await writeFile(join(fx.canonicalRoot, 'src', 'value.txt'), 'still incorrect\n', 'utf8');
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_SUCCEEDED'),
    `只改被检查输入不得阻断检查：${JSON.stringify(driven.statuses)}`);
  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  assert.equal(rows[0]?.status, 'SETTLED');
});

test('内联求值参数在冻结期被拒，不落一份没有依据的授权', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-check-dynamic-'));
  roots.push(root);
  await writeFile(join(root, 'check.mjs'), 'console.log("x");\n', 'utf8');
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'dynamic' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'dynamic',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of ['FILE_WRITE', 'CLI_RUN'] as GatewayCapability[]) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '动态检查', objective: '不应被接受',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  const check: FrozenCheck = { id: 'check-1', executable: process.execPath,
    args: ['-e', 'process.exit(0)'], executable_sha256: sha256(await readFile(process.execPath)) };
  await assert.rejects(
    delegateTask(app.db, { workspaceId, taskId: task.result.task_id, commandId: randomUUID(),
      expectedTaskRevision: ready.result.revision,
      toolLoopAction: { resource_id: resourceId,
        connections: { FILE_WRITE: connectionId, CLI_RUN: connectionId },
        allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
      scopeGrant: { resource_id: resourceId, allowed_actions: ['CLI_RUN'], checks: [check] } }),
    (error: unknown) => String((error as Error).message)
      .includes('CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED'),
    '内联求值无法证明执行范围，必须在冻结期明确拒绝');
  const remaining = await sql<{ count: string }>`select count(*)::text as count from run_scope_grants
    where project_id = ${projectId}`.execute(migrator.db);
  assert.equal(remaining.rows[0]?.count, '0',
    '冻结期被拒的检查不得留下任何授权行');
});

test('历史授权行只有入口摘要、没有材料依据时不自动放行', async () => {
  const fx = await fixture();
  // 模拟升级前的历史行：把信任依据从已落库的授权里去掉，入口摘要保持不变。
  const checks = await frozenChecks(fx.runId);
  const historical = checks.map((check) => {
    const { trust_basis: _dropped, ...rest } = check;
    return rest;
  });
  await sql`update run_scope_grants set checks = ${JSON.stringify(historical)}::jsonb
    where run_id = ${fx.runId}`.execute(migrator.db);

  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `缺材料依据的历史行必须退回人工确认：${JSON.stringify(driven.statuses)}`);
  assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得把「没有依据」当成「摘要相同」');
});

test('同一组冻结材料重复核对得到同一摘要（重放不产生新的批准要求）', async () => {
  const fx = await fixture();
  const before = await frozenChecks(fx.runId);
  const repository = new RunScopeGrantRepository(app.db);
  const grant = await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(fx.runId));
  assert.ok(grant !== undefined);
  const again = await repository.readByRun(fx.runId);
  assert.deepEqual(again?.checks, grant.checks);
  assert.equal((again?.checks as unknown as readonly FrozenCheck[])[0]!.trust_basis?.digest,
    before[0]!.trust_basis?.digest, '未改动时同一份授权必须读出同一摘要');
});

// BE-01：多显式测试入口的冻结与失效（集成出口）。
async function fixtureWithTwoTests(): Promise<Fixture & { readonly secondScriptPath: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-check-trust-tests-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'value.txt'), 'incorrect\n', 'utf8');
  await writeFile(join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { check: 'node --test' } }), 'utf8');
  const firstPath = join(root, 'a.test.mjs');
  const secondPath = join(root, 'b.test.mjs');
  await writeFile(firstPath, 'console.log("a-ok");\n', 'utf8');
  await writeFile(secondPath, 'console.log("b-ok");\n', 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'check-trust-tests' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'check-trust-tests',
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
  let cliRunPolicyId = '';
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE'],
    ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'READ_CHANGE_SET'],
    ['CLI_RUN', 'CLI_RUN']] as const) {
    const created = await createGatewayPolicy(app.db, { workspaceId, projectId, capability,
      actionType, targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
    if (capability === 'CLI_RUN' && actionType === 'CLI_RUN') cliRunPolicyId = created.policyId;
  }

  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '跑一次多入口测试', objective: '按冻结检查执行一次真实命令',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });
  const check: FrozenCheck = { id: 'check-1', executable: process.execPath,
    args: ['--test', firstPath, secondPath], max_output_bytes: 4096,
    executable_sha256: sha256(await readFile(process.execPath)) };
  const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: resourceId,
      connections: { FILE_QUERY: connectionId, FILE_READ: connectionId,
        FILE_WRITE: connectionId, CLI_RUN: connectionId },
      allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
    scopeGrant: { resource_id: resourceId, allowed_actions: ['CLI_RUN'], checks: [check] } });
  return { workspaceId, projectId, taskId: task.result.task_id, runId: delegated.result.run_id,
    resourceId, connectionId, canonicalRoot, scriptPath: firstPath, secondScriptPath: secondPath,
    check, cliRunPolicyId };
}

test('冻结期把多显式测试入口全部算成信任依据并随授权落库', async () => {
  const fx = await fixtureWithTwoTests();
  const checks = await frozenChecks(fx.runId);
  assert.equal(checks.length, 1);
  const basis = checks[0]!.trust_basis;
  assert.ok(basis !== undefined, '冻结检查必须带信任依据');
  const byPath = new Map(basis.materials.map((material) => [material.path, material.role]));
  assert.equal(byPath.get(fx.scriptPath.toLowerCase()), 'REFERENCED_SCRIPT',
    '第一个测试入口必须计入材料');
  assert.equal(byPath.get(fx.secondScriptPath.toLowerCase()), 'REFERENCED_SCRIPT',
    '第二个测试入口必须计入材料（BE-01）');
  assert.ok(byPath.size >= 4, '入口程序、双测试入口与构建配置必须全部落库');
  assert.ok(!basis.materials.some((material) => material.path.includes('value.txt')),
    '被检查的源文件不得计入执行材料');
});

test('第二个测试入口正文被改后不再自动放行，退回人工并带类型化原因', async () => {
  const fx = await fixtureWithTwoTests();
  await writeFile(fx.secondScriptPath, 'console.log("b-changed");\nprocess.exit(0);\n', 'utf8');
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `第二个入口被改后不得自动执行：${JSON.stringify(driven.statuses)}`);
  assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得沿用旧信任直接放行');

  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  const row = rows[0];
  assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row!.operation_id!));
  assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
  assert.equal((review!.evidence as JsonObject).scope_decision_reason, 'SCOPE_GRANT_CHECK_CHANGED',
    '前端必须能区分「检查材料变了」和「策略本来就要人工」');
});

// BE-02（一般形态）：等号开关值不得挤掉主脚本。冻结摘要必须包含主脚本；
// 主脚本正文被改后，Gateway 重算摘要必须不一致，退回人工而不是继续 AUTO。
test('等号开关值不挤掉主脚本：主脚本被改后不再自动放行，退回人工并带类型化原因', async () => {
  const fx = await fixture(CHECK_SCRIPT_V1, { writeEnvFile: true,
    checkArgs: (scriptPath) => ['--env-file=.env', scriptPath] });
  const checks = await frozenChecks(fx.runId);
  const basis = checks[0]!.trust_basis;
  assert.ok(basis !== undefined, '冻结检查必须带信任依据');
  assert.ok(basis.materials.some((material) =>
    material.role === 'REFERENCED_SCRIPT' && material.path === fx.scriptPath.toLowerCase()),
    '等号开关值不得挤掉主脚本：主脚本必须随授权落库（BE-02 一般形态）');
  assert.ok(basis.materials.some((material) => material.path.endsWith('.env')),
    '等号开关引用的 env 文件也是执行材料');

  // 同路径、同命令名，只把主脚本正文改成固定成功。
  await writeFile(fx.scriptPath, 'console.log("always ok");\nprocess.exit(0);\n', 'utf8');
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `主脚本被改后不得自动执行：${JSON.stringify(driven.statuses)}`);
  assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得沿用旧信任直接放行');

  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  const row = rows[0];
  assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row!.operation_id!));
  assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
  assert.equal((review!.evidence as JsonObject).scope_decision_reason, 'SCOPE_GRANT_CHECK_CHANGED',
    '前端必须能区分「检查材料变了」和「策略本来就要人工」');
});

test('动态预加载形态在冻结期被拒，不落一份没有依据的授权', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-check-preload-'));
  roots.push(root);
  await writeFile(join(root, 'preload.mjs'), 'console.log("preload");\n', 'utf8');
  await writeFile(join(root, 'check.mjs'), 'console.log("check");\n', 'utf8');
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'preload' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'preload',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of ['FILE_WRITE', 'CLI_RUN'] as GatewayCapability[]) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  const dynamicArgs: readonly string[][] = [
    ['--import=./preload.mjs', 'check.mjs'],
    ['--import', './preload.mjs', 'check.mjs'],
    ['--require=./preload.mjs', 'check.mjs'],
    ['-r./preload.mjs', 'check.mjs'],
  ];
  for (const args of dynamicArgs) {
    const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
      title: '动态预加载', objective: '不应被接受',
      expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
      criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
      mode: 'ME' });
    const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
      commandId: randomUUID(), expectedRevision: task.result.revision });
    const check: FrozenCheck = { id: 'check-1', executable: process.execPath,
      args, executable_sha256: sha256(await readFile(process.execPath)) };
    await assert.rejects(
      delegateTask(app.db, { workspaceId, taskId: task.result.task_id, commandId: randomUUID(),
        expectedTaskRevision: ready.result.revision,
        toolLoopAction: { resource_id: resourceId,
          connections: { FILE_WRITE: connectionId, CLI_RUN: connectionId },
          allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
        scopeGrant: { resource_id: resourceId, allowed_actions: ['CLI_RUN'], checks: [check] } }),
      (error: unknown) => String((error as Error).message)
        .includes('CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED'),
      `动态预加载 ${JSON.stringify(args)} 必须在冻结期明确拒绝`);
  }
  const remaining = await sql<{ count: string }>`select count(*)::text as count from run_scope_grants
    where project_id = ${projectId}`.execute(migrator.db);
  assert.equal(remaining.rows[0]?.count, '0',
    '冻结期被拒的检查不得留下任何授权行');
});

// P1 反例 A：选项结束标记形态下真正被执行的入口在冻结期还不存在。
// 修复前这条命令照样冻结成功，材料里只有 package.json、src/value.txt 与 node.exe，
// 真正执行的 --entry.mjs 完全漏算；冻结之后再创建它，检查链仍会自动跑成功。
test('选项结束标记形态的入口在冻结期缺失：冻结被拒，不落漏算入口的授权', async () => {
  const prepared = await prepareFixture(CHECK_SCRIPT_V1,
    { checkArgs: () => ['--', '--entry.mjs', 'src/value.txt'] });
  assert.equal(prepared.terminatorEntryPath, null,
    '这条反例要求冻结期那一刻真正被执行的入口尚不存在');
  const task = await readyTask(prepared);
  await assert.rejects(
    delegateTask(app.db, { workspaceId: prepared.workspaceId, taskId: task.taskId,
      commandId: randomUUID(), expectedTaskRevision: task.taskRevision,
      toolLoopAction: { resource_id: prepared.resourceId,
        connections: { FILE_WRITE: prepared.connectionId, CLI_RUN: prepared.connectionId },
        allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
      scopeGrant: { resource_id: prepared.resourceId, allowed_actions: ['CLI_RUN'],
        checks: [prepared.check] } }),
    (error: unknown) => String((error as Error).message)
      .includes('CHECK_TRUST_MATERIAL_UNREADABLE'),
  '终止符之后真正被执行的入口读不到时必须在冻结期被拒，不得等到执行期才发现');
  const remaining = await sql<{ count: string }>`select count(*)::text as count from run_scope_grants
    where project_id = ${prepared.projectId}`.execute(migrator.db);
  assert.equal(remaining.rows[0]?.count, '0',
    '冻结期被拒的检查不得留下任何授权行，更不得留下漏算入口的授权');
});

// P1 反例 B：入口在冻结期已存在时必须计入冻结材料；之后改它正文必须退回人工。
test('终止符之后真正被执行的入口进冻结材料，正文被改后退回人工并带类型化原因', async () => {
  const fx = await fixture(CHECK_SCRIPT_V1, {
    writeTerminatorEntry: 'console.log("entry v1");\n',
    checkArgs: () => ['--', '--entry.mjs', 'src/value.txt'] });
  const checks = await frozenChecks(fx.runId);
  const basis = checks[0]!.trust_basis;
  assert.ok(basis !== undefined, '冻结检查必须带信任依据');
  assert.ok(basis.materials.some((material) => material.role === 'REFERENCED_SCRIPT' &&
    material.path.endsWith('--entry.mjs')),
  '终止符之后真正被执行、名称以横线开头的入口必须计入冻结材料');
  assert.ok(!basis.materials.some((material) => material.path.endsWith('value.txt')),
    '终止符之后的受验输入不得计入执行材料');

  // 冻结之后才把入口换成固定成功：受检输入 src/value.txt 一个字没动，命令名也没换。
  await writeFile(join(fx.canonicalRoot, '--entry.mjs'),
    'console.log("always ok");\nprocess.exit(0);\n', 'utf8');
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `入口被换后不得自动执行：${JSON.stringify(driven.statuses)}`);
  assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得沿用旧信任直接放行');

  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  const row = rows[0];
  assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row!.operation_id!));
  assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
  assert.equal((review!.evidence as JsonObject).scope_decision_reason, 'SCOPE_GRANT_CHECK_CHANGED',
    '前端必须能区分「检查材料变了」和「策略本来就要人工」');
});

// ── 环境文件值形状（Node 24.21.0 实测）──────────────────────────────────────
// 固定 Node 24.21.0 实测：`node --env-file=-- check.mjs` 会真实打开受管根里名为 `--`
// 的文件（把内容从 A 改成 B，脚本读到的环境变量随之变化，exit 0）；而分离形态
// `node --env-file -- check.mjs` 报 `--env-file requires an argument`（exit 9），
// 一个脚本都不执行。因此前者必须进冻结材料并在冻结后失效时退回人工，后者在冻结期拒绝。

// A1 冻结期：以 `--env-file=--` 委托时，根内名为 `--` 的文件必须计入冻结材料。
test('值为 -- 的等号开关读到的文件进冻结材料', async () => {
  const fx = await fixture(CHECK_SCRIPT_V1, {
    writeDashDashFile: 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=first\n',
    checkArgs: (scriptPath) => ['--env-file=--', scriptPath] });
  const checks = await frozenChecks(fx.runId);
  assert.equal(checks.length, 1);
  const basis = checks[0]!.trust_basis;
  assert.ok(basis !== undefined, '冻结检查必须带信任依据');
  const dashFile = join(fx.canonicalRoot, '--');
  const material = basis.materials.find((item) => item.path === dashFile.toLowerCase());
  assert.ok(material !== undefined,
    `名为 -- 的环境文件必须计入冻结材料：${JSON.stringify(basis.materials.map((item) => item.path))}`);
  assert.equal(material!.role, 'REFERENCED_SCRIPT', '它是这次检查真实读取的开关引用文件');
  assert.equal(material!.rootRelativePath, '--', '根内相对路径必须是 -- 而不是被当成参数丢弃');
  assert.ok(basis.materials.some((item) => item.path === fx.scriptPath.toLowerCase()),
    '开关引用文件不占主脚本位置：主脚本同样必须落库');
});

// A2 冻结之后才把该环境文件换成新内容：入口路径、命令名、参数一字未动，仍必须退回人工。
test('冻结后环境文件被替换：不再自动放行，退回人工并带类型化原因', async () => {
  const fx = await fixture(CHECK_SCRIPT_V1, {
    writeDashDashFile: 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=first\n',
    checkArgs: (scriptPath) => ['--env-file=--', scriptPath] });

  // 只改名为 `--` 的环境文件，主脚本与受验输入 src/value.txt 一个字没动。
  await writeFile(join(fx.canonicalRoot, '--'),
    'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=second\n', 'utf8');
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `环境文件被替换后不得自动执行：${JSON.stringify(driven.statuses)}`);
  assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得沿用旧信任直接放行');

  const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
  const row = rows[0];
  assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row!.operation_id!));
  assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
  assert.equal((review!.evidence as JsonObject).scope_decision_reason, 'SCOPE_GRANT_CHECK_CHANGED',
    '前端必须能区分「检查材料变了」和「策略本来就要人工」');
});

// A3 根内没有名为 `--` 的文件时（Node 实测 exit 9 `--: not found`，根本不执行），
//    冻结期必须拒绝，不落一份漏算环境材料的授权。
test('值为 -- 的等号开关在环境文件缺失时冻结被拒，不落漏算材料的授权', async () => {
  const prepared = await prepareFixture(CHECK_SCRIPT_V1,
    { checkArgs: (scriptPath) => ['--env-file=--', scriptPath] });
  const task = await readyTask(prepared);
  await assert.rejects(
    delegateTask(app.db, { workspaceId: prepared.workspaceId, taskId: task.taskId,
      commandId: randomUUID(), expectedTaskRevision: task.taskRevision,
      toolLoopAction: { resource_id: prepared.resourceId,
        connections: { FILE_WRITE: prepared.connectionId, CLI_RUN: prepared.connectionId },
        allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
      scopeGrant: { resource_id: prepared.resourceId, allowed_actions: ['CLI_RUN'],
        checks: [prepared.check] } }),
    (error: unknown) => String((error as Error).message)
      .includes('CHECK_TRUST_MATERIAL_UNREADABLE'),
  '环境文件读不到时必须在冻结期被拒，不得等到执行期才发现');
  const remaining = await sql<{ count: string }>`select count(*)::text as count from run_scope_grants
    where project_id = ${prepared.projectId}`.execute(migrator.db);
  assert.equal(remaining.rows[0]?.count, '0',
    '冻结期被拒的检查不得留下任何授权行，更不得留下漏算环境文件的授权');
});

// A4 分离形态 `--env-file --`：Node 实测它根本不执行（exit 9 requires an argument），
//    执行范围无法证明，必须在冻结期明确拒绝。
test('分离形态 --env-file -- 在冻结期被拒，不落一份没有依据的授权', async () => {
  const prepared = await prepareFixture(CHECK_SCRIPT_V1, {
    writeDashDashFile: 'RELAY_ACCEPTANCE_SENTINEL_ENVFILE=first\n',
    checkArgs: (scriptPath) => ['--env-file', '--', scriptPath] });
  const task = await readyTask(prepared);
  await assert.rejects(
    delegateTask(app.db, { workspaceId: prepared.workspaceId, taskId: task.taskId,
      commandId: randomUUID(), expectedTaskRevision: task.taskRevision,
      toolLoopAction: { resource_id: prepared.resourceId,
        connections: { FILE_WRITE: prepared.connectionId, CLI_RUN: prepared.connectionId },
        allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
      scopeGrant: { resource_id: prepared.resourceId, allowed_actions: ['CLI_RUN'],
        checks: [prepared.check] } }),
    (error: unknown) => String((error as Error).message)
      .includes('CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED'),
  '分离形态下 -- 不是该选项的值（Node 实测 requires an argument），必须明确拒绝');
  const remaining = await sql<{ count: string }>`select count(*)::text as count from run_scope_grants
    where project_id = ${prepared.projectId}`.execute(migrator.db);
  assert.equal(remaining.rows[0]?.count, '0',
    '冻结期被拒的检查不得留下任何授权行');
});

// ── CT-11：人工批准必须绑定创建 Review 时观察到的检查材料（2026-10-09 实施）────────
//
// 2026-10-08 后端独立验收的已确认根因：材料漂移让范围授权退回 ASK，但 ACTION_APPROVAL 的
// target 只绑定动作、路径、参数与连接/策略版本，没有绑定创建那一刻观察到的材料摘要。
// 因此「Review 创建后改脚本」与「批准后改脚本」两条反例都能凭旧批准真实执行新脚本。
//
// 这一组锁的是业务事实而不是内部形状：脚本正文、真实子进程、真实 stdout、真实账本。
// 只断言某个抛错文本不算通过——必须核对「调用是否真的发生」与「跑的是哪一份材料」。

/** 派发到等待批准后返回那条 Review 与它的确切 Operation/工具请求身份。 */
async function waitingApproval(fx: Fixture): Promise<{ readonly toolCallId: string;
  readonly operationId: string; readonly reviewId: string; readonly review: NonNullable<
    Awaited<ReturnType<Repositories['reviews']['readByOperationId']>>> }> {
  const driven = await drive(fx);
  assert.ok(driven.statuses.includes('TOOL_WAITING'),
    `材料漂移后必须退回人工确认：${JSON.stringify(driven.statuses)}`);
  assert.ok(driven.toolCallId !== null);
  const row = await new RunToolCallRepository(app.db).read(driven.toolCallId);
  assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readByOperationId(row!.operation_id!));
  assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
  return { toolCallId: driven.toolCallId, operationId: row!.operation_id!, reviewId: review.id,
    review };
}

async function approveReview(workspaceId: string, reviewId: string) {
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(reviewId));
  assert.ok(review !== undefined);
  return resolveReview(app.db, { workspaceId, reviewId, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
    decision: 'APPROVE' });
}

/** 批准后排出的那一条 RESUME 命令：真实恢复必须用它，不能凭空造 command_id。 */
async function resumeCommandId(decisionId: string): Promise<string> {
  const commands = await sql<{ id: string }>`select id from run_commands
    where review_decision_id = ${decisionId}`.execute(app.db);
  assert.equal(commands.rows.length, 1, '批准必须恰好排出一条恢复命令');
  return commands.rows[0]!.id;
}

const UNAPPROVED_STDOUT = 'UNAPPROVED_SCRIPT';
/** 原任务安全收口后重新委托时冻结的当前材料；它从未出现在任何一次人工审阅里。 */
const RECONFIRMED_STDOUT = 'RECONFIRMED_SCRIPT';

test('CT-11 未漂移的材料：Review 绑定其确切材料，批准后真实执行该材料', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  // 冻结之后脚本被改一次：这正是退回人工的原因。此后材料保持不变。
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);

  // Review 的 target 必须真的绑定创建时观察到的材料，否则后两条反例无从谈起。
  const bound = waiting.review.target.check_trust_basis as JsonObject | undefined;
  assert.ok(bound !== undefined && typeof bound.digest === 'string',
    `批准目标必须绑定创建 Review 时观察到的材料依据：${JSON.stringify(waiting.review.target)}`);
  const frozen = (await frozenChecks(fx.runId))[0]!.trust_basis;
  assert.notEqual(bound.digest, frozen?.digest,
    'Review 绑定的是创建时的实测材料，不能照抄最初授权冻结的摘要');

  const resolved = await approveReview(fx.workspaceId, waiting.reviewId);
  // 恢复必须用批准真实排出的那一条 RESUME 命令：凭空造 command_id 会被
  // `approvedToolResume` 判成「仍在等待」，测的就不是批准后的真实执行了。
  const dispatched = await executeToolLoopStep(app.db, { claim: { commandId:
    await resumeCommandId(resolved.result.decision_id),
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'RESUME',
    reviewDecisionId: resolved.result.decision_id, workerId: `ct11-${randomUUID()}`, epoch: 0n },
    toolCallId: waiting.toolCallId });
  assert.equal(dispatched.status, 'SUCCEEDED', JSON.stringify(dispatched));

  // 真实执行的是被审阅的那份材料，stdout 与账本都要能核对。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId));
  assert.equal(operation?.status, 'SUCCEEDED');
  assert.equal(operation?.result_ref?.stdout, 'REVIEWED_SCRIPT\n');
  assert.equal(operation?.result_ref?.outcome, 'SUCCEEDED');
  const invocations = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId));
  assert.equal(invocations.length, 1, '一个批准只驱动一次真实调用');
  assert.equal(invocations[0]?.status, 'SUCCEEDED');
});

test('CT-11 Review 创建后、批准前改脚本：旧 target 不得批准并执行新脚本', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);

  // 批准之前把材料换成第三份：这份正文从未出现在任何一次人工审阅里。
  await writeFile(fx.scriptPath, `console.log("${UNAPPROVED_STDOUT}");\n`, 'utf8');
  await assert.rejects(approveReview(fx.workspaceId, waiting.reviewId),
    'Review 创建后材料已变，旧 target 必须按失效处理而不是照样批准');

  // 未出现未批准副作用：没有 Invocation，更没有真实执行。
  const invocations = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId));
  assert.equal(invocations.length, 0, '未批准的材料不得产生任何真实调用');
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId));
  assert.notEqual(operation?.status, 'SUCCEEDED');
  assert.ok(!JSON.stringify(operation?.result_ref ?? {}).includes(UNAPPROVED_STDOUT),
    '未批准材料不得留下任何执行痕迹');
});

test('CT-11 批准后、派发前改脚本：旧批准不能进入真实执行，且原动作按领域入口收口', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);
  const resolved = await approveReview(fx.workspaceId, waiting.reviewId);
  const commandId = await resumeCommandId(resolved.result.decision_id);

  // 批准本身合法（此刻材料未变）；漂移发生在批准之后、真实派发之前。
  await writeFile(fx.scriptPath, `console.log("${UNAPPROVED_STDOUT}");\n`, 'utf8');
  const dispatched = await executeToolLoopStep(app.db, { claim: { commandId,
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'RESUME',
    reviewDecisionId: resolved.result.decision_id, workerId: `ct11-${randomUUID()}`, epoch: 0n },
    toolCallId: waiting.toolCallId });
  assert.equal(dispatched.status, 'FAILED', JSON.stringify(dispatched));

  // 确定未执行：零 Invocation，且不得派生第二个动作身份。
  const invocations = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId));
  assert.equal(invocations.length, 0, '确定未执行的拒绝不得产生任何真实调用');
  assert.equal(dispatched.operationId, waiting.operationId, '不得派生第二个动作身份绕过核对');

  // 原动作与原任务必须形成一致、可恢复的结果，而不是留下一条已结算工具＋等待批准的动作。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId));
  assert.equal(operation?.id, waiting.operationId, '原动作身份必须保留');
  assert.equal(operation?.status, 'DENIED',
    `派发前确定拒绝必须让原 Operation 收口，实际 ${String(operation?.status)}`);
  assert.equal(operation?.result_ref?.reason, 'GATEWAY_APPROVAL_STALE');
  assert.ok(!JSON.stringify(operation?.result_ref ?? {}).includes(UNAPPROVED_STDOUT),
    '漂移材料不得留下任何执行痕迹');
  const settled = await new RunToolCallRepository(app.db).read(waiting.toolCallId);
  assert.equal(settled?.status, 'SETTLED');
  assert.equal(settled?.result_ref?.reason, 'GATEWAY_APPROVAL_STALE',
    `拒绝必须留下可核对的原因：${JSON.stringify(settled?.result_ref)}`);
  assert.ok(String(settled?.result_ref?.detail ?? '').length > 0, '拒绝原因要能被人读懂');

  // 收口后没有未决动作：继续推进不得被投影成「结果未知」。
  const unresolved = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listUnresolvedRunOperations(fx.runId));
  assert.deepEqual(unresolved, [], '收口后本 Run 不得残留未决 Gateway 动作');
  const run = await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId));
  const task = await withTransaction(app.db, (repositories) => repositories.tasks.readTask(fx.taskId));
  assert.equal(run?.status, 'FAILED', `原 Run 必须收口，实际 ${String(run?.status)}`);
  assert.equal(run?.wait_reason, 'GATEWAY_APPROVAL_STALE');
  assert.equal(task?.status, 'READY', 'AI 执行权必须已释放回用户');
  assert.equal(task?.executor_run_id, null);
  const advanced = await advanceRunStep(app.db, { runId: fx.runId,
    workerId: `ct11-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) });
  assert.equal(advanced.status, 'RUN_TERMINAL',
    `确定未执行不得被投影成 ACTION_UNKNOWN：${JSON.stringify(advanced)}`);
});

test('CT-12 批准后、派发前改脚本：原 Task 与原受管资源上的合法接续，旧依据保持可追溯', async () => {
  // 原 Task 的一次真实失败：材料漂移 → 批准 → 再漂移 → 真实 RESUME 被确定性拒绝。
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const stale = await waitingApproval(fx);
  const staleBound = String((stale.review.target.check_trust_basis as JsonObject).digest);
  const resolved = await approveReview(fx.workspaceId, stale.reviewId);
  await writeFile(fx.scriptPath, `console.log("${RECONFIRMED_STDOUT}");\n`, 'utf8');
  const refused = await executeToolLoopStep(app.db, { claim: {
    commandId: await resumeCommandId(resolved.result.decision_id),
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'RESUME',
    reviewDecisionId: resolved.result.decision_id, workerId: `ct12-${randomUUID()}`, epoch: 0n },
    toolCallId: stale.toolCallId });
  assert.equal(refused.status, 'FAILED', JSON.stringify(refused));
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(stale.operationId))).length, 0,
  '被拒的旧批准不得驱动任何真实调用');

  // 接续必须发生在**原 Task 与原受管资源**上：走既有 Delegate 入口并引用已终态的原 Run。
  // 复制一个新工作区/目录/Task 只能证明「新任务能跑」，证明不了原任务的恢复路径。
  const nextRunId = await redelegateSameTask(fx);
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(nextRunId)))?.task_id, fx.taskId,
  '接续后的 Run 必须仍属于原 Task');
  const grants = await withTransaction(app.db, (repositories) =>
    repositories.scopeGrants.readByRun(nextRunId));
  assert.equal(grants?.resource_id, fx.resourceId,
    '接续必须仍在原受管资源上，不能换一个目录冒充恢复');

  // 新 Run 冻结的是当前材料：不再漂移时按原授权正常执行，且只执行一次。
  const driven = await advanceToPendingToolAction({ ...fx, runId: nextRunId }, CHECK_ROUND);
  const executed = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
    runId: nextRunId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
    workerId: `ct12-${randomUUID()}`, epoch: 0n }, toolCallId: driven });
  assert.equal(executed.status, 'SUCCEEDED', JSON.stringify(executed));
  const nextOperation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(driven));
  assert.equal(nextOperation?.result_ref?.stdout, `${RECONFIRMED_STDOUT}\n`);
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(driven))).length, 1,
  '同一请求不得重复执行');

  // 旧依据保持可追溯：旧 Review、决定与原 Run 都没有被接续改写。
  const oldReview = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(stale.reviewId));
  assert.ok(oldReview !== undefined, '旧 Review 不能因接续而被抹去');
  assert.equal(oldReview!.status, 'DECIDED');
  assert.equal(String((oldReview!.target.check_trust_basis as JsonObject).digest), staleBound,
    '旧 Review 仍记录它当时绑定的材料，不能被新授权改写');
  const oldOperation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(stale.operationId));
  assert.equal(oldOperation?.status, 'DENIED', '原动作终态保持为拒绝');
  assert.notEqual(oldOperation?.id, nextOperation?.id, '接续不得复用原动作身份');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId)))?.status, 'FAILED', '历史 Run 不得复活');
});

test('CT-12 范围授权撤销不追溯撤销确切单动作批准：真实 RESUME 仍执行该批准绑定的材料', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);
  const resolved = await approveReview(fx.workspaceId, waiting.reviewId);

  // 范围授权一直是覆盖 CLI_RUN 的那一份；撤销它不改变这条确切单动作批准（SC-13）。
  assert.equal(await new RunScopeGrantRepository(app.db).revoke(fx.runId, 'CT-12 范围授权撤销对照'), true);
  const dispatched = await executeToolLoopStep(app.db, { claim: { commandId:
    await resumeCommandId(resolved.result.decision_id),
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'RESUME',
    reviewDecisionId: resolved.result.decision_id, workerId: `ct12-${randomUUID()}`, epoch: 0n },
    toolCallId: waiting.toolCallId });
  // 这里必须是一个确定结果，不接受「成功或失败都行」。
  assert.equal(dispatched.status, 'SUCCEEDED', JSON.stringify(dispatched));
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId));
  assert.equal(operation?.result_ref?.stdout, 'REVIEWED_SCRIPT\n',
    '放行也只能执行 Review 当时绑定的材料');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId))).length, 1);
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(waiting.reviewId));
  assert.equal(String((review!.target.check_trust_basis as JsonObject).digest).length, 64,
    '撤销不得改写或伪造 Review 当时绑定的材料依据');
});

test('CT-12 Permission 撤销必须拒绝未执行动作：真实 RESUME 零 Invocation 并完整收口', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);
  const resolved = await approveReview(fx.workspaceId, waiting.reviewId);
  const commandId = await resumeCommandId(resolved.result.decision_id);

  // 撤销的是 Permission 本体：旧批准不能覆盖撤销，也不得靠它进入真实执行。
  await withTransaction(app.db, async (repositories) => {
    assert.ok((await repositories.gateway.listPolicyVersions(fx.cliRunPolicyId)).length > 0,
      '撤权反例必须作用在本次真实创建的策略上');
    await repositories.gateway.revokePolicy(fx.cliRunPolicyId);
  });

  const dispatched = await executeToolLoopStep(app.db, { claim: { commandId,
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'RESUME',
    reviewDecisionId: resolved.result.decision_id, workerId: `ct12-${randomUUID()}`, epoch: 0n },
    toolCallId: waiting.toolCallId });
  assert.equal(dispatched.status, 'FAILED', `撤权后不得执行：${JSON.stringify(dispatched)}`);
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId))).length, 0,
  'Permission 撤销后必须零 Invocation');
  assert.ok(!JSON.stringify(dispatched).includes('REVIEWED_SCRIPT'),
    '撤权后不得留下已执行痕迹');

  // 拒绝后必须完整收口，不能悬空：Operation、工具行、Run、Task 与推进结果一致。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(waiting.operationId));
  assert.equal(operation?.status, 'DENIED');
  assert.equal(operation?.result_ref?.reason, 'GATEWAY_PERMISSION_DENIED');
  const settled = await new RunToolCallRepository(app.db).read(waiting.toolCallId);
  assert.equal(settled?.result_ref?.reason, 'GATEWAY_PERMISSION_DENIED');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId)))?.status, 'FAILED');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.tasks.readTask(fx.taskId)))?.status, 'READY');
  const advanced = await advanceRunStep(app.db, { runId: fx.runId,
    workerId: `ct12-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) });
  assert.equal(advanced.status, 'RUN_TERMINAL', JSON.stringify(advanced));
});

test('CT-12 拒绝收口不占住受管资源，且随后的用户控制仍能安全收尾', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);
  const resolved = await approveReview(fx.workspaceId, waiting.reviewId);
  await writeFile(fx.scriptPath, `console.log("${UNAPPROVED_STDOUT}");\n`, 'utf8');
  const refused = await executeToolLoopStep(app.db, { claim: { commandId:
    await resumeCommandId(resolved.result.decision_id),
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'RESUME',
    reviewDecisionId: resolved.result.decision_id, workerId: `ct12-${randomUUID()}`, epoch: 0n },
    toolCallId: waiting.toolCallId });
  assert.equal(refused.status, 'FAILED', JSON.stringify(refused));

  // 资源排他跨 Task 生效：收口后不得留下任何仍被占用的受管根 claim。
  assert.equal(await withTransaction(app.db, (repositories) =>
    repositories.gateway.activeClaim(fx.resourceId)), undefined,
  '确定未执行的收口必须释放资源 claim，否则同目录的其它 Task 会被挡住');

  // 收口后到达的用户控制按既有终态语义收尾：终态 Run 在请求入口就被类型化拒绝
  // （409 RUN_TERMINAL），控制意图不入队，因此既不会二次释放执行权，也不会误报接手完成。
  // 安全收口扫描没有可收尾的队列，不得为不存在的控制意图伪造 REJECTED 回执。
  const before = await withTransaction(app.db, async (repositories) => ({
    task: await repositories.tasks.readTask(fx.taskId),
    run: await repositories.runs.readRun(fx.runId) }));
  await assert.rejects(requestRunControl(app.db, { workspaceId: fx.workspaceId, runId: fx.runId,
    commandId: randomUUID(), expectedTaskRevision: before.task!.revision.toString(),
    expectedRunRevision: before.run!.revision.toString(), type: 'CANCEL' }),
    (error: unknown) => error instanceof DomainError && error.code === 'RUN_TERMINAL');
  assert.equal(await applySafeControl(app.db, fx.runId), null,
    '没有入队的控制意图，安全收口不得伪造 REJECTED 回执');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId)))?.status, 'FAILED');
  const task = await withTransaction(app.db, (repositories) => repositories.tasks.readTask(fx.taskId));
  assert.equal(task?.status, 'READY');
  assert.equal(task?.executor_run_id, null, '终态后不得重复释放或复活执行权');
});

test('CT-12 真实 DISPATCHING/UNKNOWN 对照：不走「确定未执行」捷径，保留核对与隔离', async () => {
  // 慢脚本 + 极短 Worker 租约：派发期间租约过期，结算必须落 UNKNOWN 而不是被当成未执行。
  // 这条用例锁的是「不能因为没有成功回执就判未执行」——收口捷径只对确定未执行的动作开放。
  const slowRoot = await mkdtemp(join(tmpdir(), 'relay-check-unknown-'));
  roots.push(slowRoot);
  const slowScript = join(slowRoot, 'slow.mjs');
  await writeFile(slowScript,
    'await new Promise((resolve) => setTimeout(resolve, 1500));\nconsole.log("late");\n', 'utf8');
  const fx = await fixture('console.log("check-ok");\n', { checkArgs: () => [slowScript] });
  const toolCallId = await advanceToPendingToolAction(fx, CHECK_ROUND);
  const outcome = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
    workerId: `ct12-${randomUUID()}`, epoch: 0n }, toolCallId, leaseMs: 1_000 });
  assert.equal(outcome.status, 'UNKNOWN', `在途调用必须保持未知：${JSON.stringify(outcome)}`);

  // 真实 UNKNOWN 绝不能被收口成 DENIED/FAILED：它仍需按原身份核对。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(toolCallId));
  assert.equal(operation?.status, 'UNKNOWN');
  assert.equal((await new RunToolCallRepository(app.db).read(toolCallId))?.status, 'PREPARED',
    '在途调用的工具行保持未结算，不能被提前收口');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId)))?.status, 'RUNNING');

  // 在途 UNKNOWN 阻止控制应用：仍走既有核对流程，不谎称安全结束。
  const before = await withTransaction(app.db, async (repositories) => ({
    task: await repositories.tasks.readTask(fx.taskId),
    run: await repositories.runs.readRun(fx.runId) }));
  await requestRunControl(app.db, { workspaceId: fx.workspaceId, runId: fx.runId,
    commandId: randomUUID(), expectedTaskRevision: before.task!.revision.toString(),
    expectedRunRevision: before.run!.revision.toString(), type: 'CANCEL' });
  assert.equal((await applySafeControl(app.db, fx.runId))?.status, 'PENDING');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId)))?.status, 'RUNNING');
  assert.equal((await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(toolCallId)))?.status, 'UNKNOWN');
});

test('CT-11 审批记录缺少材料依据时保守拒绝，不猜测补摘要', async () => {
  const fx = await fixture('console.log("FROZEN_SCRIPT");\n');
  await writeFile(fx.scriptPath, 'console.log("REVIEWED_SCRIPT");\n', 'utf8');
  const waiting = await waitingApproval(fx);

  // 造一条「升级前形状」的审批记录：target 里没有任何材料依据。
  const legacy = Object.fromEntries(Object.entries(waiting.review.target)
    .filter(([key]) => key !== 'check_trust_basis')) as JsonObject;
  const legacyHash = createHash('sha256').update(canonicalizeJson(legacy), 'utf8').digest();
  await sql`update review_requests set target = ${JSON.stringify(legacy)}::jsonb,
    target_hash = ${legacyHash} where id = ${waiting.reviewId}`.execute(migrator.db);

  await assert.rejects(approveReview(fx.workspaceId, waiting.reviewId),
    '缺少材料依据的历史审批不得被当成有效批准');
  const invocations = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(waiting.operationId));
  assert.equal(invocations.length, 0, '缺依据的审批不得驱动任何真实调用');
});
