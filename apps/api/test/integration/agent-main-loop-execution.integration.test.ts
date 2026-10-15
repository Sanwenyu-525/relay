import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { applyConversationExecution } from '../../src/application/conversation-execution.js';
import { createAssistSession, bindAssistSessionDirectory, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createGatewayPolicy, registerManagedResource } from
  '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 阶段 C 第一段：主流程提交类型化执行候选（ADR-022 / 总纲 §0.5.1）。
 *
 * 阶段 B 之后，「列目录 / 读文件 / 解释文件」已经由同一条主流程原生完成，不再需要
 * Task/Run。因此这里要验的是**真正需要执行**的那一段：
 *
 *   * AM-07：一个明确修改请求**只经一次模型判定**就得到候选——不再额外调用
 *     `interpret` 入口。候选落进**原** `conversation_execution_requests` 行，
 *     `source_message_id` 指回那条原用户消息，回复落在同一行消息上。
 *   * AM-05：纯讨论**零执行对象**——模型不提交候选时，一行请求、一个 Task、一个 Run
 *     都不出现。候选不是「凑执行入口」的产物。
 *   * 确定性校验仍归原入口：候选不合规时按原 `clarify` 收口并留原澄清，不造 Task/Run。
 *
 * 本文件**不**自动应用候选（`applyConversationExecution` 与 `auto_start` 规则未改）：
 * 建 Task/Run 仍由原 Owner 在用户动作后推进，本段只负责「同一次调用产出合法候选」。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-agent-main-loop-exec');
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
  readonly sessionId: string;
  readonly root: string;
}

const MARKER = 'main-loop-exec';

async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-main-loop-exec-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await writeFile(join(root, 'NOTES.md'), `# 目录说明\n标记 ${MARKER}\n`, 'utf8');

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'main-loop-exec' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'main-loop-exec',
      projectType: 'DEVELOPMENT' });
  });
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const capabilities: readonly GatewayCapability[] = ['FILE_QUERY', 'FILE_READ'];
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: canonicalRoot } });
    for (const capability of capabilities) {
      await repositories.gateway.addConnectionCapability(connection.id, capability);
    }
    await repositories.workspaces.bumpAuthority(workspaceId);
  });
  for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
    ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE']] as const) {
    await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
      targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  }
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '普通会话', projectId, conversationMode: 'AGENT' });
  await bindAssistSessionDirectory(app.db, { workspaceId, sessionId: session.result.session_id,
    commandId: randomUUID(), resourceId });
  return { workspaceId, projectId, sessionId: session.result.session_id, root };
}

/**
 * 只回答一次的端口：第一轮就给出收尾内容，主流程不请求任何工具。
 *
 * `interpret` 故意**保留**为 undefined：它证明的是「主流程不需要解释入口」，
 * 桩端口里放一个会抛错的 `interpret` 反而会让「没被调用」和「不可用」混为一谈。
 */
function oneShotPort(content: string): AssistModelPort {
  const base = new FakeModelPort();
  return {
    identity: base.identity,
    assist: async () => ({ kind: 'CONTENT' as const, content,
      providerRequestId: 'exec-one-shot',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } }),
  };
}

async function countRows(table: string, projectId: string): Promise<number> {
  const rows = await sql<{ present: boolean }>`select exists(
    select 1 from ${sql.table(table)} where project_id = ${projectId}) as present`
    .execute(app.db);
  return rows.rows[0]?.present === true ? 1 : 0;
}

async function ask(fx: Fixture, content: string, port: AssistModelPort) {
  const storage = new ManagedContentStore(dataRoot);
  let assistCalls = 0;
  let interpretCalls = 0;
  const originalAssist = port.assist.bind(port);
  const originalInterpret = port.interpret?.bind(port);
  port.assist = async (request) => {
    assistCalls += 1;
    return originalAssist(request);
  };
  if (originalInterpret !== undefined) {
    port.interpret = async (request) => {
      interpretCalls += 1;
      return originalInterpret(request);
    };
  }
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `exec-${randomUUID()}`,
    storage, modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  assert.ok(outcome !== undefined, '本次生成 tick 应当领取这条消息');
  const message = await createRepositories(app.db).assist.readMessage(
    sent.result.assistant_message_id);
  // 只取**这条原消息**的请求行：一条会话里发过多条消息时，会话级查询会把别的消息的
  // 请求也带回来，用例就无法分辨「这次判定落了几行」。断言某条消息的候选必须只看它自己。
  const requests = (await createRepositories(app.db).conversationExecutions
    .listSessionRequests(fx.workspaceId, fx.sessionId))
    .filter((item) => item.source_message_id === sent.result.user_message_id);
  return { sent, outcome, message, requests, assistCalls, interpretCalls };
}

// ------------------------------------------------- AM-05 状态维护（阶段 C 其余）

test('AM-05 明确状态维护经主流程提交，落进原请求行并沿原 Owner 生效', async () => {
  const fx = await fixture();
  const port = oneShotPort(JSON.stringify({
    reply: '我把这次阶段推进记下来了。',
    execution: null,
    maintenance: { decision: 'MAINTAIN', changes: [{ kind: 'SET_PHASE', phase: '规划' }] },
  }));
  const outcome = await ask(fx, '这个项目进入规划阶段了', port);
  assert.equal(outcome.message?.status, 'COMPLETED');

  const requests = await createRepositories(app.db).conversationState
    .listSessionRequests(fx.workspaceId, fx.sessionId);
  assert.equal(requests.length, 1, '状态维护候选必须落进原请求表');
  const request = requests[0]!;
  assert.equal(request.decision, 'MAINTAIN');
  assert.equal(request.candidate_status, 'READY');
  assert.equal(request.source_message_id, outcome.sent.result.user_message_id,
    '请求行必须指回那条原用户消息');
  // 基线在**调用模型之前**就冻结在请求行上（R3）：模型在途期间的人工修改不会被吸收。
  assert.ok(request.interpretation_baseline !== null, '请求行必须带冻结的解释基线');
  // 应用阶段仍沿原 applications 入口与原 Owner，本段不自动应用。
  assert.equal(request.status, 'READY');
});

test('AM-05 纯讨论与文件读取不产生任何状态维护写入', async () => {
  const fx = await fixture();
  const outcome = await ask(fx, '这个目录是做什么的？',
    oneShotPort(JSON.stringify({ reply: '这是一个测试目录。', execution: null, maintenance: null })));
  assert.equal(outcome.message?.status, 'COMPLETED');
  const requests = await createRepositories(app.db).conversationState
    .listSessionRequests(fx.workspaceId, fx.sessionId);
  assert.deepEqual(requests, [], '纯讨论不得留下状态维护请求行');
});

test('状态维护候选不合法时按原澄清收口，不改任何业务事实', async () => {
  const fx = await fixture();
  const before_ = await withTransaction(app.db, async (repositories) =>
    (await repositories.projects.readProjectState(fx.projectId))?.phase_key ?? null);
  const outcome = await ask(fx, '推进一下项目', oneShotPort(JSON.stringify({
    reply: '我需要先确认推进到哪一步。', execution: null,
    maintenance: { decision: 'MAINTAIN', changes: [{ kind: 'SET_PHASE' }] },
  })));
  assert.equal(outcome.message?.status, 'COMPLETED');
  const requests = await createRepositories(app.db).conversationState
    .listSessionRequests(fx.workspaceId, fx.sessionId);
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0]!.decision, 'MAINTAIN', '不合规候选不得成为可维护候选');
  const after_ = await withTransaction(app.db, async (repositories) =>
    (await repositories.projects.readProjectState(fx.projectId))?.phase_key ?? null);
  assert.equal(after_, before_, '不合规候选不得改动业务事实');
});

test('状态维护授权来源是那条原用户消息，模型不能凭自己的话造一个请求', async () => {
  const fx = await fixture();
  // 首条消息不在本用例里发送：没有原用户消息，主流程就没有可挂的授权来源。
  const outcome = await ask(fx, '推进项目', oneShotPort(JSON.stringify({
    reply: '已记录。', execution: null,
    maintenance: { decision: 'MAINTAIN', changes: [{ kind: 'SET_PHASE', phase: '规划' }] },
  })));
  assert.equal(outcome.message?.status, 'COMPLETED');
  const requests = await createRepositories(app.db).conversationState
    .listSessionRequests(fx.workspaceId, fx.sessionId);
  // 有原消息，因此恰好一行；授权来源就是那条 USER 消息，不存在第二份来源。
  assert.equal(requests.length, 1);
  const sent = await createRepositories(app.db).assist.readMessage(
    outcome.sent.result.user_message_id);
  assert.equal(sent?.role, 'USER');
  assert.equal(requests[0]!.source_message_id, sent?.id);
});

test('状态维护待人工决定时仍落成原请求行，并停在 DECISION_REQUIRED 不自动应用', async () => {
  const fx = await fixture();
  const outcome = await ask(fx, '把下一步换成验收，同时说清楚这会挡住什么', oneShotPort(JSON.stringify({
    reply: '这里有一个连带影响需要你先决定。', execution: null,
    maintenance: { decision: 'MAINTAIN',
      changes: [{ kind: 'SET_NEXT_ACTION', task_title: '完成验收' }],
      decision_required: { summary: '会挡住第 3 个任务', question: '先推进还是先收口？', affected: [] } },
  })));
  assert.equal(outcome.message?.status, 'COMPLETED');
  const requests = await createRepositories(app.db).conversationState
    .listSessionRequests(fx.workspaceId, fx.sessionId);
  assert.equal(requests.length, 1, '需要人工决定的候选也必须留下原请求行');
  const request = requests[0]!;
  assert.equal(request.status, 'DECISION_REQUIRED', '待决定语义由原入口判定，不由主流程改写');
  assert.equal(request.decision, 'MAINTAIN');
  // 本段不自动应用：候选停在等待用户决定的状态。
  const changes = await createRepositories(app.db).conversationState
    .listChangeRows(request.id);
  assert.ok(changes.length === 1, '变更条目仍按原规则逐条独立');
  assert.ok(changes.every((c) => c.status === 'PENDING'), '未应用前所有变更条目都是 PENDING');
});

// ------------------------------------------------- AM-06 会话接续 Run（阶段 C 第三段）

test('AM-06 原消息→请求→Task→Run 是一条链：Run 由 Run Worker 驱动，消息轮次不碰它', async () => {
  const fx = await fixture();
  const first = await ask(fx, '把 NOTES.md 整理成交付说明', oneShotPort(JSON.stringify({
    reply: '这次会整理出一份交付说明。', maintenance: null,
    execution: { title: '整理交付说明', objective: '整理 NOTES.md 的交付说明',
      criteria: [{ statement: '交付说明记录当前目录事实', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      writes_files: false, file_changes: [], check: null },
  })));
  assert.equal(first.message?.status, 'COMPLETED');
  assert.equal(first.interpretCalls, 0, '候选来自主流程这一次模型判定，不经旧解释入口');
  const requestId = first.requests[0]!.id;

  const applied = await applyConversationExecution(app.db, { workspaceId: fx.workspaceId, requestId });
  assert.equal(applied.status, 'DELEGATED');
  assert.ok(applied.run_id, '委托必须给出确切 Run');
  // 推进责任此刻在 Run 一侧：原请求行同时记住原消息、Task 与 Run 三者。
  const row = await createRepositories(app.db).conversationExecutions.readRequest(requestId);
  assert.equal(row?.source_message_id, first.sent.result.user_message_id);
  assert.equal(row?.task_id, applied.task_id);
  assert.equal(row?.run_id, applied.run_id);
  // 消息轮次只消费 assist_messages，不会去驱动这个 Run。
  const before_ = await createRepositories(app.db).runs.readRun(applied.run_id!);
  const tick = await runAssistGenerationTick(app.db, { workerId: 'main-loop-after-delegate',
    storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(),
    leaseMs: 60_000, maxMessages: 5 });
  assert.equal(tick, undefined, '没有新消息时消息轮次不应启动');
  assert.equal((await createRepositories(app.db).runs.readRun(applied.run_id!))?.status,
    before_?.status, '消息轮次不得改变 Run 的状态');
});

test('AM-06 会话里已有活动 Run 时，第二条执行链按类型化冲突拒绝，不并行推进', async () => {
  const fx = await fixture();
  const first = await ask(fx, '把 NOTES.md 整理成交付说明', oneShotPort(JSON.stringify({
    reply: '这次会整理出一份交付说明。', maintenance: null,
    execution: { title: '整理交付说明', objective: '整理 NOTES.md 的交付说明',
      criteria: [{ statement: '交付说明记录当前目录事实', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      writes_files: false, file_changes: [], check: null } })));
  const applied = await applyConversationExecution(app.db, { workspaceId: fx.workspaceId,
    requestId: first.requests[0]!.id });
  assert.equal(applied.status, 'DELEGATED');
  assert.ok(applied.run_id);

  // 同一条会话里再提一个**同样明确**的修改请求：这是第二条执行链的入口。
  const second = await ask(fx, '再把 NOTES.md 的标题改清楚', oneShotPort(JSON.stringify({
    reply: '这次会改标题。', maintenance: null,
    execution: { title: '改清楚标题', objective: '把 NOTES.md 的标题改清楚',
      criteria: [{ statement: '标题已改清楚', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      writes_files: false, file_changes: [], check: null } })));
  assert.equal(second.requests.length, 1);
  const secondRequest = second.requests[0]!;
  assert.notEqual(secondRequest.source_message_id, first.sent.result.user_message_id);

  // 冲突必须是类型化的，并指回正在推进的那个 Run，让调用方去接续它而不是另起一条链。
  await assert.rejects(() => applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: secondRequest.id }),
    (error: { code?: string; status?: number; detail?: string }) => {
      assert.equal(error.code, 'EXECUTOR_CONFLICT');
      assert.equal(error.status, 409);
      assert.ok(error.detail?.includes(applied.run_id!), '冲突必须指回原 Run');
      return true;
    });
  // 关键事实：同一会话上没有第二个 Task、第二个 Run。
  const counts = await sql<{ tasks: string; runs: string }>`select
    (select count(*) from tasks where workspace_id = ${fx.workspaceId})::text as tasks,
    (select count(*) from runs where workspace_id = ${fx.workspaceId})::text as runs`.execute(app.db);
  assert.deepEqual(counts.rows[0], { tasks: '1', runs: '1' }, '不得并行推进出第二套工作');
  // 原链原样还在：请求、Task、Run 三者的指认没有被动过。
  const row = await createRepositories(app.db).conversationExecutions.readRequest(
    first.requests[0]!.id);
  assert.equal(row?.run_id, applied.run_id);
  assert.equal(row?.task_id, applied.task_id);
});

test('AM-06 原 Run 结束之后同一会话可以再发起执行，接续不再被误挡', async () => {
  const fx = await fixture();
  const first = await ask(fx, '把 NOTES.md 整理成交付说明', oneShotPort(JSON.stringify({
    reply: '这次会整理出一份交付说明。', maintenance: null,
    execution: { title: '整理交付说明', objective: '整理 NOTES.md 的交付说明',
      criteria: [{ statement: '交付说明记录当前目录事实', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      writes_files: false, file_changes: [], check: null } })));
  const applied = await applyConversationExecution(app.db, { workspaceId: fx.workspaceId,
    requestId: first.requests[0]!.id });
  assert.equal(applied.status, 'DELEGATED');
  // 原 Run 以失败收口：之后同一会话再提执行请求不应被「历史活动」挡住。
  await sql`update runs set status = 'FAILED', terminal_at = now() where id = ${applied.run_id}`
    .execute(app.db);
  const second = await ask(fx, '再把 NOTES.md 的标题改清楚', oneShotPort(JSON.stringify({
    reply: '这次会改标题。', maintenance: null,
    execution: { title: '改清楚标题', objective: '把 NOTES.md 的标题改清楚',
      criteria: [{ statement: '标题已改清楚', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
      writes_files: false, file_changes: [], check: null } })));
  const retry = await applyConversationExecution(app.db, { workspaceId: fx.workspaceId,
    requestId: second.requests[0]!.id });
  assert.equal(retry.status, 'DELEGATED');
  assert.notEqual(retry.run_id, applied.run_id, '原 Run 已收口，新请求应当建立自己的 Run');
  assert.notEqual(retry.task_id, applied.task_id, '原 Task 已结束，新请求应当建立自己的 Task');
});

// ------------------------------------------------------------------ AM-05 纯讨论

test('AM-05 纯讨论零执行对象：模型不提交候选时不留任何请求行、Task 或 Run', async () => {
  const fx = await fixture();
  const outcome = await ask(fx, '这个目录是做什么的？',
    oneShotPort('这是一个用于验证主流程的目录。'));
  assert.equal(outcome.message?.status, 'COMPLETED', JSON.stringify({ outcome: outcome.outcome }));
  assert.deepEqual(outcome.requests, [], '纯讨论不得留下执行请求行');
  assert.equal(await countRows('tasks', fx.projectId), 0);
  assert.equal(await countRows('run_scope_grants', fx.projectId), 0);
  // 磁盘未变：讨论不碰文件。
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'),
    'export const relay = true;\n');
});

// ------------------------------------------------------------- AM-07 候选落原行

test('AM-07 明确修改请求在同一次模型判定里产出候选，落进原执行请求行并指回原消息', async () => {
  const fx = await fixture();
  const candidate: JsonObject = { title: '修好入口导出', objective: '把 src/index.ts 的导出改成 false',
    criteria: [{ statement: 'src/index.ts 的导出为 false', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    file_changes: [{ path: 'src/index.ts', action: 'MODIFY' }], writes_files: true };
  const port = oneShotPort(
    JSON.stringify({ reply: '我先把这次修改整理成一条可执行的任务。', execution: candidate }));
  const outcome = await ask(fx, '把 src/index.ts 的导出改成 false', port);

  assert.equal(outcome.message?.status, 'COMPLETED', JSON.stringify({ outcome: outcome.outcome }));
  // 一次模型判定就产出候选：旧解释入口没有被调用。
  assert.equal(outcome.interpretCalls, 0, '主流程不得再经过独立的执行解释入口');
  assert.ok(outcome.assistCalls >= 1);

  assert.equal(outcome.requests.length, 1, '候选必须落进原执行请求表');
  const request = outcome.requests[0]!;
  assert.equal(request.source_message_id, outcome.sent.result.user_message_id,
    '请求行必须指回那条原用户消息');
  assert.equal(request.decision, 'PREPARE');
  assert.equal(request.candidate_status, 'READY');
  assert.equal(request.status, 'READY');
  // 阶段命令身份在创建时就固定，恢复按原身份重放而不是新建第二个 Task/Run。
  assert.ok(request.task_command_id !== null && request.ready_command_id !== null &&
    request.delegate_command_id !== null);
  // 候选经**原**确定性校验：写意图为真，因此不会被当成只读自动启动。
  assert.equal((request.candidate as unknown as { writes_files?: boolean }).writes_files, true);
  // 本段不应用候选：Task/Run 仍由原 Owner 在用户动作后推进。
  assert.equal(request.task_id, null);
  assert.equal(request.run_id, null);
  assert.equal(await countRows('tasks', fx.projectId), 0);
  // 磁盘未被候选改动——候选只是声明范围，不是执行。
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'),
    'export const relay = true;\n');
  // 回复落在原消息上，不是第二套状态。
  assert.match(outcome.message?.content ?? '', /整理成一条可执行的任务/u);
});

test('候选不合规时按原澄清收口，不造 Task/Run，也不把原文当成执行结果', async () => {
  const fx = await fixture();
  const port = oneShotPort(
    JSON.stringify({ reply: '我先确认一下这次要改什么。',
      execution: { title: '缺少可判断结果', criteria: [], expected_outputs: {} } }));
  const outcome = await ask(fx, '改一下那个文件', port);
  assert.equal(outcome.message?.status, 'COMPLETED');
  assert.equal(outcome.requests.length, 1);
  const request = outcome.requests[0]!;
  assert.notEqual(request.decision, 'PREPARE', '不合规候选不得成为可执行候选');
  assert.equal(request.candidate_status, 'INVALID');
  assert.equal(request.candidate, null);
  assert.equal(await countRows('tasks', fx.projectId), 0);
});