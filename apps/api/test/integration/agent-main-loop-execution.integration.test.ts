import assert from 'node:assert/strict';
import { startTestApi, workspacePath } from './api-harness.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { applyConversationExecution, isAutoStartConversationExecution } from
  '../../src/application/conversation-execution.js';
import { createAssistSession, bindAssistSessionDirectory, requestAssistMessage,
  steerAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { resolveSessionReadTools, sessionWriteAllowed } from '../../src/application/assist-read-tools.js';
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
 * 本文件不代替 Workbench 调用 applications；它核对原请求行的就绪候选会投影为 `auto_start`，
 * 由 Workbench 沿固定命令身份进入原 Task/Run Owner。
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
  // 词表记录只观察主轮次，不让独立的自动记忆提取覆盖最后一轮工具；生产默认值不变。
  await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(), expectedRevision: '0',
    recallEnabled: true, automaticCompaction: true, autoCapture: false });
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

async function addFileWriteConnection(fx: Fixture, rootPath: string,
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): Promise<string> {
  const connectionId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(fx.workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: connectionId,
      workspaceId: fx.workspaceId, projectId: fx.projectId, config: { root_path: rootPath } });
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_WRITE');
    if (status === 'DISABLED') await repositories.gateway.setConnection({ id: connection.id,
      status, config: connection.config });
    await repositories.workspaces.bumpAuthority(fx.workspaceId);
  });
  return connectionId;
}

async function prepareWriteCandidate(fx: Fixture) {
  const candidate: JsonObject = { title: '修改受管文件', objective: '把 src/index.ts 改为 false',
    criteria: [{ statement: 'src/index.ts 导出 false', required: true, method: 'HUMAN' }],
    expected_outputs: { kind: 'MARKDOWN_DOCUMENT' },
    file_changes: [{ path: 'src/index.ts', action: 'MODIFY' }], writes_files: true };
  const outcome = await ask(fx, '把 src/index.ts 改为 false', oneShotPort(JSON.stringify({
    reply: '我会按本目录的写入连接处理。', execution: candidate,
  })));
  assert.equal(outcome.requests.length, 1);
  assert.equal(outcome.requests[0]?.candidate_status, 'READY');
  return outcome.requests[0]!;
}

async function fileWriteConnectionFromRun(runId: string): Promise<string | undefined> {
  const result = await sql<{ frozen_snapshot: JsonObject }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}
  `.execute(app.db);
  const loop = result.rows[0]?.frozen_snapshot.tool_loop_action as JsonObject | undefined;
  const connections = loop?.connections as JsonObject | undefined;
  return typeof connections?.FILE_WRITE === 'string' ? connections.FILE_WRITE : undefined;
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

test('主流程候选的 HTTP 只读投影保留资源、标题和目标，不产生第二次解释或执行', async () => {
  const fx = await fixture();
  const result = await ask(fx, '整理交付说明', oneShotPort(JSON.stringify({
    reply: '目标已整理。', maintenance: null,
    execution: { title: '整理交付说明', objective: '整理 NOTES.md 的交付说明',
      criteria: [{ statement: '记录当前目录事实', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false, file_changes: [], check: null }
  })));
  const saved = result.requests[0]!;
  const api = await startTestApi();
  try {
    const response = await api.get(`${workspacePath(fx.workspaceId)}/conversation-execution-requests?session_id=${fx.sessionId}`);
    assert.equal(response.status, 200, response.text);
    const row = (response.body as { items: { request_id: string; resource_id: string; candidate: JsonObject; task_id: string | null; run_id: string | null }[] }).items[0]!;
    assert.equal(row.request_id, saved.id);
    assert.equal(row.resource_id, saved.resource_id);
    assert.deepEqual(row.candidate, saved.candidate);
    assert.equal(row.candidate.title, '整理交付说明');
    assert.equal(row.task_id, null);
    assert.equal(row.run_id, null);
    assert.equal(result.interpretCalls, 0);
  } finally { await api.stop(); }
});

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
  // 候选经**原**确定性校验；写意图进入 Run 后仍受 Gateway / Review 控制。
  assert.equal((request.candidate as unknown as { writes_files?: boolean }).writes_files, true);
  assert.equal(isAutoStartConversationExecution(request), true,
    '明确写请求沿原 applications 入口自动准备 Task/Run');
  // 本集成仅确认候选与 auto_start 投影，没有模拟 Workbench 的 HTTP 应用调用。
  assert.equal(request.task_id, null);
  assert.equal(request.run_id, null);
  assert.equal(await countRows('tasks', fx.projectId), 0);
  // 磁盘未被候选改动——候选只是声明范围，不是执行。
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'),
    'export const relay = true;\n');
  // 回复落在原消息上，不是第二套状态。
  assert.match(outcome.message?.content ?? '', /整理成一条可执行的任务/u);
});

test('文件写执行选择匹配的根连接，即使它不是首个 ACTIVE 连接', async () => {
  const fx = await fixture();
  const wrongRoot = await mkdtemp(join(tmpdir(), 'relay-main-loop-wrong-root-'));
  roots.push(wrongRoot);
  const wrongConnectionId = await addFileWriteConnection(fx, wrongRoot);
  const matchingConnectionId = await addFileWriteConnection(fx, fx.root);
  const request = await prepareWriteCandidate(fx);

  await applyConversationExecution(app.db, { workspaceId: fx.workspaceId, requestId: request.id });
  const applied = await createRepositories(app.db).conversationExecutions.readRequest(request.id);
  assert.ok(applied?.run_id);
  assert.notEqual(wrongConnectionId, matchingConnectionId);
  assert.equal(await fileWriteConnectionFromRun(applied.run_id), matchingConnectionId,
    '执行契约必须冻结覆盖当前受管根的连接');
});

test('文件写执行拒绝只有不匹配根的 ACTIVE 连接', async () => {
  const fx = await fixture();
  const wrongRoot = await mkdtemp(join(tmpdir(), 'relay-main-loop-wrong-root-'));
  roots.push(wrongRoot);
  await addFileWriteConnection(fx, wrongRoot);
  const request = await prepareWriteCandidate(fx);

  await assert.rejects(() => applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: request.id }), /本项目还没有绑定该目录的 FILE_WRITE 连接/u);
  const saved = await createRepositories(app.db).conversationExecutions.readRequest(request.id);
  assert.equal(saved?.run_id, null, '没有匹配根连接时不得创建 Run');
});

test('文件写执行不把已停用的同根连接当作匹配连接', async () => {
  const fx = await fixture();
  const wrongRoot = await mkdtemp(join(tmpdir(), 'relay-main-loop-wrong-root-'));
  roots.push(wrongRoot);
  await addFileWriteConnection(fx, wrongRoot);
  await addFileWriteConnection(fx, fx.root, 'DISABLED');
  const request = await prepareWriteCandidate(fx);

  await assert.rejects(() => applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: request.id }), /本项目还没有绑定该目录的 FILE_WRITE 连接/u);
  const saved = await createRepositories(app.db).conversationExecutions.readRequest(request.id);
  assert.equal(saved?.run_id, null);
});

test('文件写执行没有 FILE_WRITE 连接时仍拒绝创建 Run', async () => {
  const fx = await fixture();
  const request = await prepareWriteCandidate(fx);

  await assert.rejects(() => applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: request.id }), /本项目还没有绑定该目录的 FILE_WRITE 连接/u);
  const saved = await createRepositories(app.db).conversationExecutions.readRequest(request.id);
  assert.equal(saved?.run_id, null);
});

test('文件写执行沿用同根 FILE_WRITE 连接', async () => {
  const fx = await fixture();
  const matchingConnectionId = await addFileWriteConnection(fx, fx.root);
  const request = await prepareWriteCandidate(fx);

  await applyConversationExecution(app.db, { workspaceId: fx.workspaceId, requestId: request.id });
  const applied = await createRepositories(app.db).conversationExecutions.readRequest(request.id);
  assert.ok(applied?.run_id);
  assert.equal(await fileWriteConnectionFromRun(applied.run_id), matchingConnectionId);
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

// ------------------------------- 0126 会话内直接写文件（ADR-031）

/**
 * 把目录放到「完全访问」并补一条 APPLY_CHANGESET 的 AUTO 策略。
 *
 * FULL 与 AUTO 在策略行上不可区分，档位差别只记在 `local_directory_access.write_tier`：
 * 会话侧按这一列决定「模型能不能看到写工具」，Gateway 侧按它决定要不要 ASK。
 */
async function enableSessionWrite(fx: Fixture):
Promise<{ resourceId: string; canonicalRoot: string }> {
  const resource = (await withTransaction(app.db, (repositories) =>
    repositories.gateway.listResources())).find((item) => item.project_id === fx.projectId);
  assert.ok(resource !== undefined, '夹具必须已有受管资源');
  // 写连接的 root_path 必须用**服务端读回的规范根**：Windows 临时目录带 8.3/大小写别名，
  // 拿原始 mkdtemp 路径建连接会让 `targetMatches` 判不出同一根，写能力静默不进入词表。
  const writeConnectionId = await addFileWriteConnection(fx, resource.canonical_root);
  const readConnection = await sql<{ id: string }>`select id from gateway_connections
    where project_id = ${fx.projectId} and status = 'ACTIVE' and id <> ${writeConnectionId}
    order by created_at limit 1`.execute(app.db);
  const readConnectionId = readConnection.rows[0]?.id;
  assert.ok(readConnectionId !== undefined, '夹具必须已有读连接');
  await sql`insert into local_directory_access
    (resource_id, write_tier, read_connection_id, write_connection_id)
    values (${resource.id}, 'FULL', ${readConnectionId}, ${writeConnectionId})
    on conflict (resource_id) do update set write_tier = 'FULL',
      write_connection_id = ${writeConnectionId}`.execute(app.db);
  await createGatewayPolicy(app.db, { workspaceId: fx.workspaceId, projectId: fx.projectId,
    capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET',
    targetPrefix: resource.canonical_root, decision: 'AUTO', maxPayloadBytes: 262144 });
  // 前置校验：档位行必须与**会话实际绑定的**受管资源是同一行。写完就跑的用例最怕
  // 「档位落在另一个资源上，于是词表看起来毫无变化」——那种失败会被误读成实现没生效。
  const sessionRow = await sql<{ working_resource_id: string | null }>`
    select working_resource_id from assist_sessions where id = ${fx.sessionId}`.execute(app.db);
  assert.equal(sessionRow.rows[0]?.working_resource_id, resource.id,
    '会话绑定的受管资源必须与档位行一致');
  const tier = await sql<{ write_tier: string }>`select write_tier from local_directory_access
    where resource_id = ${resource.id}`.execute(app.db);
  assert.equal(tier.rows[0]?.write_tier, 'FULL');
  return { resourceId: resource.id, canonicalRoot: resource.canonical_root };
}

/** 记录本轮模型实际拿到的工具词表的端口。 */
function recordingPort(): { port: AssistModelPort; declared: () => readonly string[] } {
  const base = new FakeModelPort();
  let declared: readonly string[] = [];
  return {
    declared: () => declared,
    port: {
      identity: base.identity,
      assist: async (request) => {
        declared = (request.tools ?? []).map((spec) => spec.name);
        return { kind: 'CONTENT' as const,
          content: JSON.stringify({ reply: '记下了。', execution: null, maintenance: null }),
          providerRequestId: 'declared-tools',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
            cacheCreationTokens: null } };
      },
    },
  };
}

test('0126 只读档位下词表里没有写工具：模型看不到也就不会一直调用被拒', async () => {
  const fx = await fixture();
  const { port, declared } = recordingPort();
  const outcome = await ask(fx, '看看这个目录', port);
  assert.equal(outcome.message?.status, 'COMPLETED');
  assert.ok(declared().includes('read_file'), `读工具应在词表内：${declared().join(',')}`);
  assert.equal(declared().includes('apply_changeset'), false,
    '没有目录写档位时写工具不得进入词表');
  assert.equal(declared().includes('read_change_set'), false);
});

test('0126 完全访问档把写工具放进词表', async () => {
  const fx = await fixture();
  const { resourceId } = await enableSessionWrite(fx);
  // 先单独验证工具解析这一层：若这里就没有 apply_changeset，问题在连接/根匹配，
  // 而不是 runner 没把 allowWrite 传下去。
  const sessionRow = (await sql<Record<string, unknown>>`
    select * from assist_sessions where id = ${fx.sessionId}`.execute(app.db)).rows[0];
  assert.ok(sessionRow !== undefined);
  const direct = await resolveSessionReadTools(createRepositories(app.db),
    sessionRow as never, true);
  const caps = await sql<{ capability_key: string }>`
    select capability_key from gateway_connection_capabilities
    where connection_id = (select write_connection_id from local_directory_access
      where resource_id = ${resourceId})`.execute(app.db);
  assert.deepEqual([...direct].filter((name) => name === 'apply_changeset'),
    ['apply_changeset'],
    `工具解析层应含写工具；写连接能力=${caps.rows.map((row) => row.capability_key).join(',')}；` +
    `解析结果=${direct.join(',')}`);
  // 档位判定层：同一行 session 必须被判为可写。若这里为 false，问题在档位读取，
  // 而不是 runner 的分支或传参。
  const tierRow = await sql<{ write_tier: string }>`
    select write_tier from local_directory_access where resource_id = ${resourceId}`.execute(app.db);
  assert.equal(await sessionWriteAllowed(app.db, sessionRow as never), true,
    `档位判定应为可写；tier=${tierRow.rows[0]?.write_tier ?? 'MISSING'}`);
  const { port, declared } = recordingPort();
  await ask(fx, '看看这个目录', port);
  assert.ok(declared().includes('apply_changeset'), `写工具应在词表内：${declared().join(',')}`);
  assert.ok(declared().includes('read_file'), '写启用不应挤掉读工具');
});

test('0126 会话轮次直接写：apply_changeset 真实落盘，写动作属 AGENT_SESSION_WRITE', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const target = join(fx.root, 'src', 'index.ts');
  const before = await readFile(target, 'utf8');
  const baselineSha256 = createHash('sha256').update(before, 'utf8').digest('hex');
  const script = [[{ name: 'apply_changeset', arguments: { changes: [{ path: 'src/index.ts',
    action: 'MODIFY', content: 'export const relay = false;\n', baselineSha256 }] } }]];
  const outcome = await ask(fx, `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, new FakeModelPort());
  // 断言消息不能 JSON.stringify：消息行里有 bigint 修订号，序列化会抛 TypeError。
  assert.equal(outcome.message?.status, 'COMPLETED',
    `${outcome.message?.status}/${outcome.message?.error_code ?? 'no-error'}`);

  // 磁盘真的变了——这一片唯一不能靠推断的事实。失败时把工具账本一起带出来：
  // 「词表里有写工具但没落盘」最常见的三种原因是脚本没触发、准入拒绝、基线过期。
  const diagRows = await sql<{ tool_name: string; status: string; rejection_reason: string | null;
    rejection_detail: string | null }>`select tool_name, status, rejection_reason, rejection_detail
    from session_tool_calls where session_id = ${fx.sessionId}`.execute(app.db);
  const diag = diagRows.rows.map((row) => `${row.tool_name}:${row.status}:` +
    `${row.rejection_reason ?? '-'}:${row.rejection_detail ?? '-'}`).join(' | ');
  assert.equal(await readFile(target, 'utf8'), 'export const relay = false;\n', `账本=${diag}`);

  // 写动作的来源必须是会话写身份，能力是 FILE_WRITE。
  const ops = await sql<{ origin: string; capability_key: string; status: string }>`
    select origin, capability_key, status from logical_operations
    where project_id = ${fx.projectId} and capability_key = 'FILE_WRITE'`.execute(app.db);
  assert.equal(ops.rows.length, 1);
  assert.equal(ops.rows[0]?.origin, 'AGENT_SESSION_WRITE');
  assert.equal(ops.rows[0]?.status, 'SUCCEEDED');

  // 账本以 SETTLED 收口并保留 Operation 身份。
  const calls = await sql<{ status: string; operation_id: string | null; tool_name: string }>`
    select status, operation_id, tool_name from session_tool_calls
    where session_id = ${fx.sessionId}`.execute(app.db);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0]?.tool_name, 'apply_changeset');
  assert.equal(calls.rows[0]?.status, 'SETTLED');
  assert.ok(calls.rows[0]?.operation_id !== null, 'SETTLED 必须指向原 Operation');

  // 会话写不建 Task/Run：它没有验收条件，也不该污染执行面板。
  // runs 没有 project_id（经 task 关联），按 workspace 数。
  assert.equal(await countRows('tasks', fx.projectId), 0);
  const runRows = await sql<{ count: string }>`select count(*)::text as count from runs
    where workspace_id = ${fx.workspaceId}`.execute(app.db);
  assert.equal(runRows.rows[0]?.count, '0');
});

test('0126 基线过期时拒绝并保留原文件，不覆盖别人刚写的正文', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const target = join(fx.root, 'src', 'index.ts');
  // 模型读到的是旧内容，但磁盘在这之后被别人改了。
  const stale = createHash('sha256').update('export const relay = true;\n', 'utf8').digest('hex');
  await writeFile(target, 'export const relay = true; // 别人刚改成这样\n', 'utf8');
  const script = [[{ name: 'apply_changeset', arguments: { changes: [{ path: 'src/index.ts',
    action: 'MODIFY', content: 'export const relay = false;\n', baselineSha256: stale }] } }]];
  await ask(fx, `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, new FakeModelPort());
  // 文件保持他人的改动，没有被这次写入覆盖。
  assert.equal(await readFile(target, 'utf8'), 'export const relay = true; // 别人刚改成这样\n');
  const ops = await sql<{ status: string }>`select status from logical_operations
    where project_id = ${fx.projectId} and capability_key = 'FILE_WRITE'`.execute(app.db);
  assert.ok(ops.rows.every((row) => row.status !== 'SUCCEEDED'), '过期基线不得以成功收口');
  assert.equal(await countRows('tasks', fx.projectId), 0);
});

test('审批档不暴露无法接续审批的会话写工具，保留执行候选入口', async () => {
  const fx = await fixture();
  const { resourceId } = await enableSessionWrite(fx);
  await sql`update local_directory_access set write_tier = 'ASK'
    where resource_id = ${resourceId}`.execute(app.db);
  const { port, declared } = recordingPort();
  await ask(fx, '把 src/index.ts 改为 false', port);
  assert.equal(declared().includes('apply_changeset'), false);
  assert.equal(declared().includes('read_file'), true);
  const request = await prepareWriteCandidate(fx);
  assert.equal(request.candidate_status, 'READY');
  assert.equal(isAutoStartConversationExecution(request), true);
});

test('写连接停用后不再向模型宣称可以直接写文件', async () => {
  const fx = await fixture();
  const { resourceId } = await enableSessionWrite(fx);
  await sql`update gateway_connections set status = 'DISABLED'
    where id = (select write_connection_id from local_directory_access
      where resource_id = ${resourceId})`.execute(app.db);
  const port = oneShotPort(JSON.stringify({ reply: '读取当前文件。', execution: null }));
  const original = port.assist.bind(port);
  port.assist = async (request) => {
    assert.equal(request.tools?.some((tool) => tool.name === 'apply_changeset'), false);
    assert.doesNotMatch(request.system, /本轮你可以直接修改文件/);
    return original(request);
  };
  const outcome = await ask(fx, '看看 src/index.ts', port);
  assert.equal(outcome.message?.status, 'COMPLETED');
});

test('明确修改的方法轮复用会话写工具，不强制创建 Task 和 Run', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const before = await readFile(join(fx.root, 'NOTES.md'), 'utf8');
  const baselineSha256 = createHash('sha256').update(before, 'utf8').digest('hex');
  const script = [[{ name: 'apply_changeset', arguments: { changes: [{ path: 'NOTES.md',
    action: 'MODIFY', content: '# 已更新\n', baselineSha256 }] } }]];
  const port = new FakeModelPort();
  const original = port.assist.bind(port);
  port.assist = async (request) => {
    assert.ok(request.tools?.some((tool) => tool.name === 'apply_changeset'));
    assert.doesNotMatch(request.system, /你\*\*不直接写文件\*\*/);
    return original(request);
  };
  const outcome = await ask(fx, `更新文档 FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, port);
  assert.equal(outcome.message?.status, 'COMPLETED');
  assert.equal(await readFile(join(fx.root, 'NOTES.md'), 'utf8'), '# 已更新\n');
  assert.equal(outcome.requests.length, 0);
  assert.equal(await countRows('tasks', fx.projectId), 0);
});

test('只审查的方法轮即使目录完全访问也不暴露写工具', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const { port, declared } = recordingPort();
  const outcome = await ask(fx, '代码审查，只报告问题', port);
  assert.equal(outcome.message?.status, 'COMPLETED');
  assert.equal(declared().includes('apply_changeset'), false);
  assert.equal(outcome.requests.length, 0);
});

test('会话直写后可以提交仅运行检查的候选，原修改不重复入队', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const before = await readFile(join(fx.root, 'src', 'index.ts'), 'utf8');
  const baselineSha256 = createHash('sha256').update(before, 'utf8').digest('hex');
  const port = oneShotPort('');
  port.assist = async (request) => {
    assert.doesNotMatch(request.system, /execution 一律填 null/);
    assert.match(request.system, /只运行检查时 writes_files=false/);
    const common = { providerRequestId: 'write-then-check', usage: {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null } };
    if ((request.toolTurns?.length ?? 0) === 0) return { ...common, kind: 'TOOL_CALLS', preamble: '',
      calls: [{ providerToolCallId: 'write-once', name: 'apply_changeset', arguments: {
        changes: [{ path: 'src/index.ts', action: 'MODIFY', baselineSha256,
          content: 'export const relay = false;\n' }] } }] };
    assert.equal(request.toolTurns?.[0]?.results[0]?.isError, false);
    return { ...common, kind: 'CONTENT', content: JSON.stringify({ reply: '文件已修改，继续检查。',
      execution: { title: '核对修改', objective: '检查修改后的文件',
        criteria: [{ statement: '检查命令成功', required: true, method: 'HUMAN' }],
        expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false, file_changes: [],
        check: { executable: 'node', args: ['--check', 'src/index.ts'] } }, maintenance: null }) };
  };
  const outcome = await ask(fx, '修改 src/index.ts 并运行检查', port);
  assert.equal(outcome.message?.status, 'COMPLETED');
  assert.equal(await readFile(join(fx.root, 'src', 'index.ts'), 'utf8'), 'export const relay = false;\n');
  assert.equal(outcome.requests.length, 1);
  assert.equal(outcome.requests[0]?.candidate_status, 'READY');
  assert.equal(outcome.requests[0]?.candidate?.writes_files, false);
  assert.deepEqual(outcome.requests[0]?.candidate?.file_changes, []);
  assert.deepEqual(outcome.requests[0]?.candidate?.check,
    { executable: 'node', args: ['--check', 'src/index.ts'] });
  const writes = await sql<{ count: string }>`select count(*)::text as count from logical_operations
    where project_id = ${fx.projectId} and capability_key = 'FILE_WRITE'`.execute(app.db);
  assert.equal(writes.rows[0]?.count, '1');
});

for (const interaction of ['BROWSER', 'COMPUTER'] as const) {
  test(`${interaction} 操作候选进入原 Run 工具循环，不因连接无文件根而丢失工具`, async () => {
    const fx = await fixture();
    const capabilities: readonly GatewayCapability[] = interaction === 'BROWSER'
      ? ['BROWSER_READ', 'BROWSER_ACTION', 'BROWSER_COMMIT'] : ['COMPUTER_READ', 'COMPUTER_INPUT'];
    await withTransaction(app.db, async (repositories) => {
      const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
        workspaceId: fx.workspaceId, projectId: fx.projectId, config: {} });
      for (const capability of capabilities) {
        await repositories.gateway.addConnectionCapability(connection.id, capability);
      }
    });
    const outcome = await ask(fx, '在已连接的工具中完成指定操作', oneShotPort(JSON.stringify({
      reply: '按原请求执行。', execution: { title: '完成操作', objective: '打开目标并核对结果',
        criteria: [{ statement: '有操作后的观察证据', required: true, method: 'HUMAN' }],
        expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false,
        file_changes: [], check: null, interaction }, maintenance: null })));
    assert.equal(outcome.requests[0]?.candidate?.interaction, interaction);
    const applied = await applyConversationExecution(app.db,
      { workspaceId: fx.workspaceId, requestId: outcome.requests[0]!.id });
    assert.equal(applied.status, 'DELEGATED');
    const contract = await sql<{ frozen_snapshot: JsonObject }>`select frozen_snapshot
      from execution_contracts where run_id = ${applied.run_id!}`.execute(app.db);
    const loop = contract.rows[0]?.frozen_snapshot.tool_loop_action as JsonObject;
    assert.ok(loop);
    const tools = loop.allowed_tools as string[];
    for (const tool of interaction === 'BROWSER'
      ? ['browser_new_page', 'browser_read_page', 'browser_click', 'browser_submit_form']
      : ['computer_screenshot', 'computer_get_windows', 'computer_click', 'computer_type']) {
      assert.ok(tools.includes(tool), `Run 应拿到 ${tool}`);
    }
    assert.equal(tools.includes('apply_changeset'), false);
    assert.equal(tools.includes('run_check'), false);
    const grants = await sql<{ count: string }>`select count(*)::text as count from run_scope_grants
      where run_id = ${applied.run_id!}`.execute(app.db);
    assert.equal(grants.rows[0]?.count, '0', '工具需求不得隐式变成操作授权或免批');
  });
}

test('AUTO 档删除在创建动作前转交 Run，不遗留无法接续的会话审批', async () => {
  const fx = await fixture();
  const { resourceId } = await enableSessionWrite(fx);
  await sql`update local_directory_access set write_tier = 'AUTO'
    where resource_id = ${resourceId}`.execute(app.db);
  const before = await readFile(join(fx.root, 'NOTES.md'), 'utf8');
  const baselineSha256 = createHash('sha256').update(before, 'utf8').digest('hex');
  const script = [[{ name: 'apply_changeset', arguments: { changes: [
    { path: 'NOTES.md', action: 'DELETE', baselineSha256 }] } }]];
  const port = new FakeModelPort();
  const original = port.assist.bind(port);
  let refusal = '';
  port.assist = async (request) => {
    if (request.toolTurns?.[0] !== undefined) refusal = request.toolTurns[0].results[0]?.content ?? '';
    return original(request);
  };
  await ask(fx, `FAKE_ASSIST_TOOLS ${JSON.stringify(script)}`, port);
  assert.match(refusal, /SESSION_WRITE_REQUIRES_RUN/);
  assert.equal(await readFile(join(fx.root, 'NOTES.md'), 'utf8'), before);
  const operations = await sql<{ count: string }>`select count(*)::text as count from logical_operations
    where project_id = ${fx.projectId} and capability_key = 'FILE_WRITE'`.execute(app.db);
  assert.equal(operations.rows[0]?.count, '0');
});

test('缺少浏览器操作连接时先报能力缺口，不生成半成品 Task', async () => {
  const fx = await fixture();
  const outcome = await ask(fx, '打开目标页面', oneShotPort(JSON.stringify({ reply: '打开目标页面。',
    execution: { title: '查看目标页面', objective: '打开页面并核对标题',
      criteria: [{ statement: '取得页面标题', required: true, method: 'HUMAN' }],
      expected_outputs: { kind: 'MARKDOWN_DOCUMENT' }, writes_files: false, file_changes: [],
      interaction: 'BROWSER' } })));
  await assert.rejects(() => applyConversationExecution(app.db,
    { workspaceId: fx.workspaceId, requestId: outcome.requests[0]!.id }), /BROWSER_READ/);
  assert.equal(await countRows('tasks', fx.projectId), 0);
});

// ---------------------------------------------------- 0128 插话撤回后的机械重试守卫

/**
 * 插话打断后模型原样重发刚被撤回的写动作。
 *
 * 这是「实际工具仍执行旧计划」的最小可复现场景：提示词已经要求模型按最新要求重新决定，
 * 但提示词不是代码保证——写动作一旦执行就是真实副作用。守卫的判据是「自撤回以来有没有
 * 新插话」：没有新信息时重复同一动作 = 机械重试；有新插话时同样的动作可能是用户的新指令。
 */
test('0128 插话撤回后原样重发旧写动作：动作被拦下，磁盘与账本都没有副作用', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const target = join(fx.root, 'src', 'index.ts');
  const before = await readFile(target, 'utf8');
  const baselineSha256 = createHash('sha256').update(before, 'utf8').digest('hex');
  const change = { changes: [{ path: 'src/index.ts', action: 'MODIFY',
    content: 'export const relay = "green";\n', baselineSha256 }] };
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
    cacheCreationTokens: null };
  let round = 0;
  const seenResults: string[] = [];
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async (request) => {
      round += 1;
      if (round === 1) {
        // 在途期间用户插话：改成蓝色。这批写动作必须先停下。
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: '改成蓝色' });
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queued.result.assistant_message_id, commandId: randomUUID() });
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: 'retry-1',
          name: 'apply_changeset', arguments: change }], preamble: '', providerRequestId: 'r1', usage };
      }
      if (round === 2) {
        // 模型没听见新要求，原样重发刚被撤回的动作。
        seenResults.push(request.toolTurns?.[0]?.results[0]?.content ?? '');
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: 'retry-2',
          name: 'apply_changeset', arguments: change }], preamble: '', providerRequestId: 'r2', usage };
      }
      seenResults.push(request.toolTurns?.[1]?.results[0]?.content ?? '');
      return { kind: 'CONTENT', content: '已按最新要求处理。', providerRequestId: 'r3', usage };
    } };
  const outcome = await ask(fx, '把按钮改成绿色', port);
  assert.equal(outcome.message?.status, 'COMPLETED',
    `${outcome.message?.status}/${outcome.message?.error_code ?? 'no-error'}`);
  // 关键证据：磁盘没被这次旧动作改过。
  assert.equal(await readFile(target, 'utf8'), before, '被撤回的动作不得产生落盘副作用');
  // 第二次请求里，那个动作被类型化拦下（而不是执行成功）。
  const blocked = seenResults.find((content) => content.includes('ACTION_WITHDRAWN'));
  assert.ok(blocked !== undefined, `重发动作必须被撤回守卫拦下；实际回执=${seenResults.join(' | ')}`);
  assert.match(blocked, /NOT_EXECUTED/u);
  // 零写副作用：没有 FILE_WRITE Operation，也没有已结算的写工具账本。
  const operations = await sql<{ count: string }>`select count(*)::text as count from logical_operations
    where project_id = ${fx.projectId} and capability_key = 'FILE_WRITE'`.execute(app.db);
  assert.equal(operations.rows[0]?.count, '0');
  const calls = await sql<{ count: string }>`select count(*)::text as count from session_tool_calls
    where session_id = ${fx.sessionId} and tool_name = 'apply_changeset'`.execute(app.db);
  assert.equal(calls.rows[0]?.count, '0', '被撤回与被拦下的动作都不入工具账本');
});

test('0128 新方向的动作不被撤回守卫误伤：改蓝色照常落盘', async () => {
  const fx = await fixture();
  await enableSessionWrite(fx);
  const target = join(fx.root, 'src', 'index.ts');
  const before = await readFile(target, 'utf8');
  const baselineSha256 = createHash('sha256').update(before, 'utf8').digest('hex');
  const green = { changes: [{ path: 'src/index.ts', action: 'MODIFY',
    content: 'export const relay = "green";\n', baselineSha256 }] };
  const blue = { changes: [{ path: 'src/index.ts', action: 'MODIFY',
    content: 'export const relay = "blue";\n', baselineSha256 }] };
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
    cacheCreationTokens: null };
  let round = 0;
  const port: AssistModelPort = { identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      if (round === 1) {
        const queued = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
          sessionId: fx.sessionId, commandId: randomUUID(), content: '改成蓝色' });
        await steerAssistMessage(app.db, { workspaceId: fx.workspaceId,
          messageId: queued.result.assistant_message_id, commandId: randomUUID() });
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: 'turn-1',
          name: 'apply_changeset', arguments: green }], preamble: '', providerRequestId: 'b1', usage };
      }
      if (round === 2) {
        // 模型按新要求改了动作：这是新签名，不该被守卫当成机械重试。
        return { kind: 'TOOL_CALLS', calls: [{ providerToolCallId: 'turn-2',
          name: 'apply_changeset', arguments: blue }], preamble: '', providerRequestId: 'b2', usage };
      }
      return { kind: 'CONTENT', content: '已按蓝色写好。', providerRequestId: 'b3', usage };
    } };
  const outcome = await ask(fx, '把按钮改成绿色', port);
  assert.equal(outcome.message?.status, 'COMPLETED',
    `${outcome.message?.status}/${outcome.message?.error_code ?? 'no-error'}`);
  assert.equal(await readFile(target, 'utf8'), 'export const relay = "blue";\n',
    '新方向的动作必须照常落盘');
  const operations = await sql<{ status: string }>`select status from logical_operations
    where project_id = ${fx.projectId} and capability_key = 'FILE_WRITE'`.execute(app.db);
  assert.equal(operations.rows.length, 1);
  assert.equal(operations.rows[0]?.status, 'SUCCEEDED');
});
