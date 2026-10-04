import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from
  './integration-support.js';

/**
 * 模型工具循环的真实 PG 出口（docs/architecture/runtime-context.md §2.3）。
 *
 * 覆盖 A 片验收：Fake 模型按脚本发出真实的「搜索 → 读取 → Git diff → 回复」序列，
 * 每次工具调用都落到自己的 Gateway 动作身份上；重复派发不产生第二次执行；未授权、
 * 未知工具与非法参数都不派发；断点恢复从已落库行重建而不是重跑模型。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-tool-loop');
let dataRoot: string;
const roots: string[] = [];
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
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
  readonly canonicalRoot: string;
  readonly connectionId: string;
  readonly policyId: string;
}

/** 一次性测试仓库：既有 HEAD 也有未暂存与未跟踪内容，覆盖 Git 只读的真实形态。 */
async function initGitRepository(root: string): Promise<void> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Relay Test',
    GIT_AUTHOR_EMAIL: 'relay@example.invalid', GIT_COMMITTER_NAME: 'Relay Test',
    GIT_COMMITTER_EMAIL: 'relay@example.invalid' };
  const run = async (...args: readonly string[]): Promise<void> => {
    await new Promise<void>((resolveResult, rejectResult) => {
      execFile('git', args, { cwd: root, env }, (error) => {
        if (error === null) resolveResult();
        else rejectResult(new Error(`git ${args.join(' ')}: ${error.message}`));
      });
    });
  };
  await run('init', '-q', '-b', 'main');
  await run('add', 'README.md');
  await run('commit', '-q', '-m', '初始提交');
  // 留下已暂存、未暂存与未跟踪三种真实状态，让 git_status/diff 都能看到差异。
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = false;\n', 'utf8');
  await run('add', 'src/index.ts');
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
}

async function fixture(name: string, options: {
  readonly auto?: boolean;
  readonly git?: boolean;
  readonly allowedTools?: readonly string[];
  readonly maxToolCalls?: number;
} = {}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-tool-loop-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\n内部工具循环\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await writeFile(join(root, 'src', '工具.ts'), 'export const 名称 = "中文";\n', 'utf8');
  if (options.git === true) await initGitRepository(root);

  // 工作区、项目、受管资源、连接与策略必须先于 Task 存在：Gateway 的每一步都核对
  // Workspace authority 与 Project 归属，顺序颠倒会得到与业务无关的 404。
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: name,
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of ['FILE_QUERY', 'FILE_READ', 'GIT_READ'] as GatewayCapability[]) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  const decision = options.auto === false ? 'ASK' : 'AUTO';
  // 记住 LIST_DIRECTORY 的策略身份：撤权反例要精确作用在这一条上。
  let listDirectoryPolicyId = '';
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'],
    ['FILE_READ', 'READ_FILE'], ['GIT_READ', 'GIT_STATUS'], ['GIT_READ', 'GIT_DIFF'],
    ['GIT_READ', 'GIT_LOG']] as const) {
    const created = await createGatewayPolicy(app.db, { workspaceId, projectId, capability,
      actionType, targetPrefix: canonicalRoot, decision, maxPayloadBytes: 262144 });
    if (actionType === 'LIST_DIRECTORY') listDirectoryPolicyId = created.policyId;
  }

  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '按工具结果继续', objective: '依据实际工具结果生成候选',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c1', statement: '存在候选交付', required: true, method: 'HUMAN' }],
    mode: 'ME' });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedRevision: task.result.revision });

  const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
    commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
    toolLoopAction: { resource_id: resourceId,
      connections: { FILE_QUERY: connectionId, FILE_READ: connectionId, GIT_READ: connectionId },
      allowed_tools: options.allowedTools ?? ['list_directory', 'search_text', 'read_file',
        'git_status', 'git_diff'],
      max_rounds: 6, max_tool_calls: options.maxToolCalls ?? 8 } });
  return { workspaceId, projectId, taskId: task.result.task_id, runId: delegated.result.run_id,
    resourceId, canonicalRoot, connectionId, policyId: listDirectoryPolicyId };
}

/** 有界驱动：advance 与工具派发交替，直到 Run 离开这两个状态或达到步数上限。 */
async function drive(fx: Fixture, script: readonly { name: string;
  arguments: JsonObject }[][], maxIterations = 20): Promise<{
    readonly statuses: readonly string[];
    readonly pending: readonly string[];
}> {
  const storage = new ManagedContentStore(dataRoot);
  const statuses: string[] = [];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
      workerId: `loop-${randomUUID()}`, storage, fakeToolScript: script });
    statuses.push(advanced.status);
    // STEP_SUCCEEDED/REPLAYED 只是「本步完成」，图会继续推进；其余状态本驱动无法自行处理。
    if (advanced.status === 'STEP_SUCCEEDED' || advanced.status === 'RETRYABLE' ||
        advanced.status === 'REPLAYED') continue;
    if (advanced.status !== 'TOOL_LOOP_ACTION_REQUIRED') return { statuses, pending: [] };
    const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
      runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
      workerId: `loop-${randomUUID()}`, epoch: 0n },
      toolCallId: advanced.tool_call_id });
    statuses.push(`TOOL_${dispatched.status}`);
    if (dispatched.status === 'WAITING' || dispatched.status === 'UNKNOWN') {
      return { statuses, pending: [dispatched.toolCallId] };
    }
  }
  const pending = await new RunToolCallRepository(app.db).listPending(fx.runId);
  return { statuses, pending: pending.map((row) => row.id) };
}

function rowsOf(runId: string): ReturnType<RunToolCallRepository['listPending']> extends
  Promise<infer T> ? T : never {
  throw new Error('unused');
}

async function draftAttemptId(runId: string): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const run = await repositories.runs.readRun(runId);
    const steps = await repositories.runs.listSteps(runId);
    const draft = steps.find((step) => step.step_kind === 'DRAFT');
    assert.ok(draft !== undefined);
    const attempts = await repositories.runs.listAttempts(draft.id);
    assert.ok(attempts.length > 0, `no DRAFT attempt; run=${run?.status}`);
    return attempts.at(-1)!.id;
  });
}

async function toolRows(runId: string) {
  return new RunToolCallRepository(app.db).listByAttempt(await draftAttemptId(runId));
}

test('a scripted model walks search → read → git diff and then settles the draft', async () => {
  const fx = await fixture('tool-loop-read', { git: true });
  const driven = await drive(fx, [
    [{ name: 'search_text', arguments: { query: '中文' } }],
    [{ name: 'read_file', arguments: { relative_path: 'src/工具.ts' } }],
    [{ name: 'git_status', arguments: {} }],
  ]);
  assert.deepEqual(driven.pending, []);
  assert.ok(driven.statuses.includes('STEP_SUCCEEDED'));
  // 每一轮都是一次真实的模型调用，且不多不少。
  const modelCalls = await new ModelCallRepository(app.db)
    .listForStepAttempt(await draftAttemptId(fx.runId));
  assert.equal(modelCalls.length, 4);
  assert.ok(modelCalls.every((call: { status: string }) => call.status === 'COMPLETED'));

  const rows = await toolRows(fx.runId);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.tool_name), ['search_text', 'read_file', 'git_status']);
  assert.deepEqual(rows.map((row) => row.round), [0, 1, 2]);
  // 每个请求都有自己的动作身份；行 id 就是那个 Operation 的 id。
  for (const row of rows) {
    assert.equal(row.status, 'SETTLED');
    assert.equal(row.operation_id, row.id);
    const operation = await withTransaction(app.db, (repositories) =>
      repositories.gateway.readOperation(row.id));
    assert.equal(operation?.run_id, fx.runId);
    assert.equal(operation?.status, 'SUCCEEDED');
    assert.equal(operation?.step_id, rows[0]!.step_id);
  }
  // 真实读到了合成目录，而不是预制答案。
  const read = rows.find((row) => row.tool_name === 'read_file')!;
  assert.ok(String(read.result_ref?.content).includes('中文'));
  assert.ok(JSON.stringify(rows[0]!.result_ref?.matches).includes('工具.ts'));
  // Git 只读读到了真实仓库状态：未暂存与未跟踪都出现，不因 diff 无输出而消失。
  const gitStatus = rows.find((row) => row.tool_name === 'git_status')!.result_ref?.status as
    { staged: string[]; unstaged: string[]; untracked: string[] };
  assert.ok(Array.isArray(gitStatus.unstaged));
  assert.ok(gitStatus.unstaged.includes('src/index.ts'));
  assert.ok(gitStatus.untracked.includes('src/工具.ts'));
});

test('a Git repository with staged, unstaged and untracked content reports each one', async () => {
  const fx = await fixture('tool-loop-git', { git: true, allowedTools: ['git_status', 'git_diff'] });
  const driven = await drive(fx, [[{ name: 'git_status', arguments: {} }],
    [{ name: 'git_diff', arguments: {} }]]);
  assert.deepEqual(driven.pending, []);
  const rows = await toolRows(fx.runId);
  assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'SETTLED']);
  const status = rows[0]!.result_ref!.status as
    { staged: string[]; unstaged: string[]; untracked: string[]; headCommit: string | null };
  assert.ok(status.staged.includes('src/index.ts'));
  assert.ok(status.unstaged.includes('src/index.ts'));
  assert.ok(status.untracked.includes('src/工具.ts'));
  assert.equal(typeof status.headCommit, 'string');
  // 未暂存差异里能看到真实内容改动。
  assert.ok(String(rows[1]!.result_ref?.diff).includes('relay = true'));
});

test('a non-Git directory returns a typed git failure instead of looking clean', async () => {
  const fx = await fixture('tool-loop-nongit', { allowedTools: ['git_status', 'git_diff'] });
  const driven = await drive(fx, [[{ name: 'git_status', arguments: {} }]]);
  assert.deepEqual(driven.pending, []);
  const rows = await toolRows(fx.runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'SETTLED');
  // 动作本身 FAILED，模型在下一轮看到类型化原因并收尾。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(rows[0]!.id));
  assert.equal(operation?.status, 'FAILED');
  assert.ok(typeof operation?.result_ref?.reason === 'string');
});

test('an unknown tool name and illegal arguments are rejected without any Operation', async () => {
  const fx = await fixture('tool-loop-reject', { allowedTools: ['search_text'] });
  const driven = await drive(fx, [[
    { name: 'apply_changeset', arguments: { path: '../escape' } },
    { name: 'search_text', arguments: { query: 7 } },
    { name: 'search_text', arguments: { query: 'ok' } },
  ]]);
  assert.deepEqual(driven.pending, []);
  const rows = await toolRows(fx.runId);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), ['REJECTED', 'REJECTED', 'SETTLED']);
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.operation_id, null);
    assert.ok(typeof row.result_ref?.reason === 'string');
    // 未派发就不该留下任何动作或调用记录。
    const operation = await withTransaction(app.db, (repositories) =>
      repositories.gateway.readOperation(row.id));
    assert.equal(operation, undefined);
  }
});

test('the loop budget stops dispatch and returns a typed reason to the model', async () => {
  const fx = await fixture('tool-loop-budget', { allowedTools: ['list_directory'],
    maxToolCalls: 1 });
  const driven = await drive(fx, [
    [{ name: 'list_directory', arguments: {} }],
    [{ name: 'list_directory', arguments: {} }],
    [{ name: 'list_directory', arguments: {} }],
  ]);
  assert.deepEqual(driven.pending, []);
  const rows = await toolRows(fx.runId);
  assert.equal(rows.filter((row) => row.status === 'SETTLED').length, 1);
  assert.ok(rows.some((row) => row.result_ref?.reason === 'TOOL_LOOP_BUDGET_EXHAUSTED'));
});

test('an ASK policy parks the tool call at an ACTION_APPROVAL bound to its exact action', async () => {
  const fx = await fixture('tool-loop-ask', { auto: false, allowedTools: ['list_directory'] });
  const storage = new ManagedContentStore(dataRoot);
  // 先让 BUILD_CONTEXT 走完：工具调用只发生在 DRAFT Attempt 内。
  const built = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
    storage, fakeToolScript: [[{ name: 'list_directory', arguments: {} }]] });
  assert.equal(built.status, 'STEP_SUCCEEDED', JSON.stringify(built));
  const advanced = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
    storage, fakeToolScript: [[{ name: 'list_directory', arguments: {} }]] });
  assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
  const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
    runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
    workerId: `loop-${randomUUID()}`, epoch: 0n }, toolCallId: advanced.tool_call_id });
  assert.equal(dispatched.status, 'WAITING');
  assert.ok(dispatched.reviewId !== undefined);

  const rows = await toolRows(fx.runId);
  assert.equal(rows[0]!.status, 'WAITING_APPROVAL');
  // 未批准前没有调用发生，也没有资源被占用。
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(rows[0]!.id));
  assert.equal(operation?.status, 'WAITING_APPROVAL');
  const invocations = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listInvocations(rows[0]!.id));
  assert.equal(invocations.length, 0);
  const run = await withTransaction(app.db, (repositories) =>
    repositories.runs.readRun(fx.runId));
  assert.equal(run?.status, 'WAITING_APPROVAL');
  assert.equal(run?.worker_id, null);
});

test('a repeated delivery of the same request reuses the original Operation', async () => {
  const fx = await fixture('tool-loop-replay', { allowedTools: ['list_directory'] });
  const storage = new ManagedContentStore(dataRoot);
  const script = [[{ name: 'list_directory', arguments: {} }]];
  await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`, storage,
    fakeToolScript: script });
  const advanced = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
    storage, fakeToolScript: script });
  assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
  const claim = { commandId: randomUUID(), runId: fx.runId, workspaceId: fx.workspaceId,
    kind: 'START' as const, reviewDecisionId: null, workerId: `loop-${randomUUID()}`, epoch: 0n };
  const first = await executeToolLoopStep(app.db, { claim, toolCallId: advanced.tool_call_id });
  assert.equal(first.status, 'SUCCEEDED');
  const operationsAfterFirst = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listRunOperations(fx.runId));
  const second = await executeToolLoopStep(app.db, { claim, toolCallId: advanced.tool_call_id });
  assert.equal(second.status, 'SUCCEEDED');
  const operationsAfterSecond = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listRunOperations(fx.runId));
  // 同一请求重复投递不产生第二个动作，也不重跑模型生成同一个写动作。
  assert.equal(operationsAfterSecond.length, operationsAfterFirst.length);
  assert.equal(operationsAfterFirst.length, 1);
});

test('a revoked permission blocks the tool call and keeps the reason traceable', async () => {
  const fx = await fixture('tool-loop-revoke', { allowedTools: ['list_directory'] });
  await withTransaction(app.db, async (repositories) => {
    const versions = await repositories.gateway.listPolicyVersions(fx.policyId);
    assert.ok(versions.length > 0);
    await repositories.gateway.revokePolicy(fx.policyId);
  });
  const driven = await drive(fx, [[{ name: 'list_directory', arguments: {} }]]);
  assert.deepEqual(driven.pending, []);
  const rows = await toolRows(fx.runId);
  assert.equal(rows.length, 1);
  // 撤权后请求根本没有派发：不产生 Operation，只留下类型化原因。
  assert.equal(rows[0]!.status, 'REJECTED');
  assert.equal(rows[0]!.operation_id, null);
  assert.equal(rows[0]!.result_ref?.reason, 'GATEWAY_PERMISSION_DENIED');
  const operation = await withTransaction(app.db, (repositories) =>
    repositories.gateway.readOperation(rows[0]!.id));
  assert.equal(operation, undefined);
});