import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { archiveAssistSession } from '../../src/application/assist-session-controls.js';
import { loadAssistSourceContent } from '../../src/application/assist-source-content.js';
import { selectSessionModel } from '../../src/application/select-session-model.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { captureMemoriesForTurn } from '../../src/application/memory-auto-capture.js';
import { readAutoCaptures, recordAutoCapture } from '../../src/application/memory-captures.js';
import { restoreInformation, retireInformation } from '../../src/application/information-commands.js';
import { listInformation } from '../../src/application/information-queries.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { FakeModelPort, type AssistRequest } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

/**
 * 自动捕获（ADR-030、DEV-0042、ADR-032）：真实 PostgreSQL + 真实聊天入口。
 *
 * 固定的是七件事：
 *  1. **真实入口**（P0-A）：从 `requestAssistMessage` 发消息、`runAssistGenerationTick` 生成并结算，
 *     自动记忆必须落库。此前只有直接调用 `captureMemoriesForTurn` 的测试，真实路径恒为 0；
 *  2. 来源类别按**模型声明**核验（P0-B）：声明 user 只能在用户原话里找到，声明 assistant
 *     只能在助手答复里找到；观察不得被升级成用户陈述；
 *  3. 证据身份分列（P0-B）：触发轮次是助手消息，证据消息随类别走，SHA256 可核对；
 *  4. 提取调用进统一账本（P0-C）：独立一行 model_calls，带真实用量；
 *  5. 关闭后不再写入（P0-D）：写事务里复核 `auto_capture` 与会话状态；
 *  6. 重试与并发不重复（P0-D）；
 *  7. 提取失败不改变已经结算的主回复。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-memory-auto-capture');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

const USER_TEXT = '我们决定用 PostgreSQL 做唯一业务数据库。';
const REPLY_TEXT = '网页正文说 pnpm 是这个仓库的包管理器。';
const EXTRACTION_MARKER = '长期记忆提取器';

async function fixture(): Promise<{ workspaceId: string; projectId: string; sessionId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'auto-capture' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'auto', projectType: 'GENERAL' });
  });
  const session = await createAssistSession(app.db, { workspaceId, projectId,
    title: 'auto capture', commandId: randomUUID() });
  return { workspaceId, projectId, sessionId: session.result.session_id };
}

function isExtraction(request: AssistRequest): boolean {
  return typeof request.system === 'string' && request.system.includes(EXTRACTION_MARKER);
}

/** 一轮真实聊天：主流程回 REPLY_TEXT，提取调用回给定 JSON。 */
async function runChatTurn(f: { workspaceId: string; sessionId: string },
  extraction: string | Error): Promise<{ assistantMessageId: string; userMessageId: string }> {
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content: USER_TEXT });
  const port = new FakeModelPort();
  port.assist = async (request) => {
    if (!isExtraction(request)) {
      return { kind: 'CONTENT', content: REPLY_TEXT, providerRequestId: randomUUID(),
        usage: { inputTokens: 11, outputTokens: 5 } };
    }
    if (extraction instanceof Error) throw extraction;
    return { kind: 'CONTENT', content: extraction, providerRequestId: randomUUID(),
      usage: { inputTokens: 7, outputTokens: 3 } };
  };
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));
  return { assistantMessageId: sent.result.assistant_message_id,
    userMessageId: sent.result.user_message_id };
}

/** 三条候选：一条引自用户原话、一条引自助手答复、一条两段都找不到。 */
const EXTRACTION = JSON.stringify({ memories: [
  { title: '数据库选型', text: '唯一业务数据库用 PostgreSQL。', source: 'user',
    quote: '我们决定用 PostgreSQL', reason: '用户第一句' },
  { title: '包管理器', text: '这个仓库用 pnpm。', source: 'assistant',
    quote: 'pnpm 是这个仓库的包管理器' },
  { title: '凭空来的', text: '用户同意改用 MySQL。', source: 'user',
    quote: '用户同意改用 MySQL' },
] });

test('真实聊天入口：结算后自动提取落库，来源与证据身份可核对', async () => {
  const f = await fixture();
  const turn = await runChatTurn(f, EXTRACTION);

  const items = await listInformation(app.db, 'memory', f.workspaceId, f.projectId);
  const byTitle = new Map(items.map((item) => [String(item.title), item]));
  assert.equal(byTitle.get('数据库选型')?.origin, 'AUTO_CAPTURE');
  assert.equal(byTitle.get('数据库选型')?.source_kind, 'USER_STATEMENT');
  assert.equal(byTitle.get('包管理器')?.source_kind, 'MODEL_OBSERVATION');
  assert.equal(byTitle.has('凭空来的'), false, '来源核验不通过的候选不落库');

  // 捕获账本：轮次身份是**助手消息**，SHA256 是**证据消息**正文的哈希。
  const captures = await sql<{ title: string; message_id: string; source_sha256: string;
    source_quote: string }>`select m.title, c.message_id, c.source_sha256, c.source_quote
      from memory_auto_captures c join memory_items m on m.id = c.memory_id
      where c.workspace_id = ${f.workspaceId} and c.status = 'ACTIVE'`.execute(app.db);
  const captureByTitle = new Map(captures.rows.map((row) => [row.title, row]));
  assert.equal(captureByTitle.get('数据库选型')?.message_id, turn.assistantMessageId);
  assert.equal(captureByTitle.get('包管理器')?.message_id, turn.assistantMessageId);
  assert.equal(captureByTitle.get('数据库选型')?.source_sha256,
    createHash('sha256').update(USER_TEXT, 'utf8').digest('hex'));
  assert.equal(captureByTitle.get('包管理器')?.source_sha256,
    createHash('sha256').update(REPLY_TEXT, 'utf8').digest('hex'));
  assert.equal(captureByTitle.get('数据库选型')?.source_quote, '我们决定用 PostgreSQL');

  // 来源绑定（memory_message_sources）：用户陈述绑用户消息，模型观察绑助手回复。
  const sources = await sql<{ title: string; message_id: string; content_sha256: string }>`
    select m.title, s.message_id, s.content_sha256
    from memory_message_sources s
    join memory_versions v on v.memory_id = s.memory_id and v.version = s.memory_version
    join memory_items m on m.id = s.memory_id
    where s.session_id = ${f.sessionId}`.execute(app.db);
  const sourceByTitle = new Map(sources.rows.map((row) => [row.title, row]));
  assert.equal(sourceByTitle.get('数据库选型')?.message_id, turn.userMessageId);
  assert.equal(sourceByTitle.get('数据库选型')?.content_sha256,
    createHash('sha256').update(USER_TEXT, 'utf8').digest('hex'));
  assert.equal(sourceByTitle.get('包管理器')?.message_id, turn.assistantMessageId);
  assert.equal(sourceByTitle.get('包管理器')?.content_sha256,
    createHash('sha256').update(REPLY_TEXT, 'utf8').digest('hex'));

  // 提取调用进统一账本（P0-C）：同一助手消息下有两条真实调用，其中一条是 7/3 用量的提取。
  const calls = await sql<{ usage_input_tokens: number | null; usage_output_tokens: number | null;
    status: string }>`select usage_input_tokens, usage_output_tokens, status from model_calls
      where assist_message_id = ${turn.assistantMessageId} order by started_at, id`.execute(app.db);
  assert.equal(calls.rows.length, 2, `主流程 + 提取各一行：${JSON.stringify(calls.rows)}`);
  assert.ok(calls.rows.some((row) => row.status === 'COMPLETED' &&
    row.usage_input_tokens === 7 && row.usage_output_tokens === 3), JSON.stringify(calls.rows));
  assert.ok(calls.rows.every((row) => row.status === 'COMPLETED'));

  // 召回排序与来源类别投影：同为自动捕获时用户原话先于模型观察。
  const repositories = createRepositories(app.db);
  const recalled = await repositories.information.recallMemories(f.workspaceId, f.projectId, [], 10);
  const kinds = recalled.map((row) => row.source_kind);
  assert.equal(kinds[0], 'USER_STATEMENT', `召回顺序应先用户原话：${kinds.join(',')}`);
  assert.ok(kinds.indexOf('MODEL_OBSERVATION') > kinds.indexOf('USER_STATEMENT'));

  // 模型侧看到的来源段带类别标注：观察不能被当成用户陈述。
  const session = await repositories.assist.readSession(f.sessionId);
  assert.ok(session);
  const storage = new ManagedContentStore(dataRoot);
  const userMemory = recalled.find((row) => row.source_kind === 'USER_STATEMENT');
  const observed = recalled.find((row) => row.source_kind === 'MODEL_OBSERVATION');
  assert.ok(userMemory && observed);
  const userSection = await loadAssistSourceContent(repositories, storage, session,
    { kind: 'MEMORY', root_id: userMemory.id, version: userMemory.current_version.toString() });
  const observedSection = await loadAssistSourceContent(repositories, storage, session,
    { kind: 'MEMORY', root_id: observed.id, version: observed.current_version.toString() });
  assert.match(userSection.section, /用户原话/u);
  assert.match(observedSection.section, /模型观察/u);
  assert.ok(userSection.section.includes('UNTRUSTED_DATA'));
});

test('来源类别按声明核验：声明与段落不符就丢弃，观察不得升级为用户陈述', async () => {
  const f = await fixture();
  // 回复刻意包含「唯一业务数据库」（用户原话里也有），但**不含**「我们决定用 PostgreSQL」。
  const both = '助手复述了「唯一业务数据库」这个说法，并转述网页正文：pnpm 是这个仓库的包管理器。';
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content: USER_TEXT });
  const port = new FakeModelPort();
  port.assist = async (request) => isExtraction(request)
    ? { kind: 'CONTENT', content: JSON.stringify({ memories: [
      // 引文只在用户原话里，却声明来自助手 → 必须拒绝。
      { title: '声明错位', text: '错位的事实。', source: 'assistant', quote: '我们决定用 PostgreSQL' },
      // 引文只在助手答复里，却声明来自用户 → 必须拒绝。
      { title: '冒充用户', text: '冒充的用户陈述。', source: 'user', quote: 'pnpm 是这个仓库的包管理器' },
      // 两段都有，声明 assistant → 记模型观察，不升级。
      { title: '两段都有', text: '同一句话在两段里都出现过。', source: 'assistant',
        quote: '唯一业务数据库' },
    ] }), providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } }
    : { kind: 'CONTENT', content: both, providerRequestId: randomUUID(),
      usage: { inputTokens: 1, outputTokens: 1 } };
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));
  assert.ok(sent.result.user_message_id);

  const items = await listInformation(app.db, 'memory', f.workspaceId, f.projectId);
  const byTitle = new Map(items.map((item) => [String(item.title), item]));
  assert.equal(byTitle.has('声明错位'), false, '声明 assistant 却只能在该段之外找到，必须丢弃');
  assert.equal(byTitle.has('冒充用户'), false, '声明 user 却只能在该段之外找到，必须丢弃');
  assert.equal(byTitle.get('两段都有')?.source_kind, 'MODEL_OBSERVATION',
    '同一句话出现在两段时按声明记观察，不得升级为用户陈述');
});

test('关闭自动捕获后不再写入：预检与写入事务两道闸门都生效', async () => {
  const f = await fixture();
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const turn = await runChatTurn(f, EXTRACTION);
  assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 0,
    '关闭后提取链不得写入任何记忆');

  // 写入事务内的复核（P0-D）：即使调用方绕过预检直接写，也必须按当前开关拒绝。
  const repositories = createRepositories(app.db);
  const session = await repositories.assist.readSession(f.sessionId);
  assert.ok(session);
  const direct = await withTransaction(app.db, (r) => recordAutoCapture(r, {
    workspaceId: f.workspaceId, projectId: f.projectId, sessionId: f.sessionId,
    triggerMessageId: turn.assistantMessageId, evidenceMessageId: turn.userMessageId,
    evidenceText: USER_TEXT, title: '直写尝试', text: '不该落库的一条。', reason: null,
    sourceKind: 'USER_STATEMENT', sourceQuote: '我们决定用 PostgreSQL' }));
  assert.equal(direct, null, '开关已关闭时写事务必须整条拒绝');
  assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 0);
});

test('重试与重复触发不产生第二条记忆', async () => {
  const f = await fixture();
  const turn = await runChatTurn(f, EXTRACTION);
  const before = await sql<{ count: string }>`select count(*)::text as count
    from memory_items where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(before.rows[0]?.count, '2');

  const port = new FakeModelPort();
  port.assist = async () => ({ kind: 'CONTENT', content: EXTRACTION,
    providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } });
  // 同一轮再提取一次（模拟 Worker 重放）：去重指纹命中，写入 0 条。
  const again = await captureMemoriesForTurn(app.db, { sessionId: f.sessionId,
    assistantMessageId: turn.assistantMessageId, modelPort: port });
  assert.equal(again, 0);
  const after = await sql<{ count: string }>`select count(*)::text as count
    from memory_items where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(after.rows[0]?.count, '2', '重放不得写入第二条');
});

test('提取失败不改变已经结算的主回复', async () => {
  const f = await fixture();
  const turn = await runChatTurn(f, new Error('provider down'));
  const row = await sql<{ status: string; content: string | null }>`select status, content
    from assist_messages where id = ${turn.assistantMessageId}`.execute(app.db);
  assert.equal(row.rows[0]?.status, 'COMPLETED');
  assert.equal(row.rows[0]?.content, REPLY_TEXT);
  assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 0);
  // 失败也留痕：提取调用那一行是 FAILED，不是没有调用过。
  const calls = await sql<{ status: string; error_kind: string | null }>`
    select status, error_kind from model_calls
    where assist_message_id = ${turn.assistantMessageId} order by started_at, id`.execute(app.db);
  assert.equal(calls.rows.length, 2, JSON.stringify(calls.rows));
  assert.equal(calls.rows.filter((entry) => entry.status === 'FAILED').length, 1);
});

test('来源撤回后该记忆不再进入召回', async () => {
  const f = await fixture();
  const turn = await runChatTurn(f, EXTRACTION);
  const repositories = createRepositories(app.db);
  const before = await repositories.information.recallMemories(f.workspaceId, f.projectId, [], 10);
  assert.equal(before.length, 2);

  // 0132：撤回证据消息（用户原话）。只影响绑定它的那条记忆，模型观察那条仍在。
  await sql`update assist_messages set withdrawn_at = now()
    where id = ${turn.userMessageId}`.execute(app.db);
  const after = await repositories.information.recallMemories(f.workspaceId, f.projectId, [], 10);
  assert.deepEqual(after.map((row) => row.source_kind), ['MODEL_OBSERVATION'],
    `撤回来源后只剩观察那条：${JSON.stringify(after.map((row) => row.source_kind))}`);
});

/**
 * P1-B：停用/恢复是**一个业务动作**，正文与捕获账本必须一起走。
 *
 * 只有正文改了而账本停在 ACTIVE 时，同一条记忆会在两个入口里状态互相矛盾：
 * 「最近自动记住」仍把它当有效条目展示，而按自动记忆撤销又因「对应记忆已非有效状态」被拒。
 * 恢复是停用的正向补偿；「撤销过的内容不再被提取」由账本行的存在性保证，与状态无关。
 */
test('停用与恢复记忆时捕获账本同步，且停用后重放不会写回第二条', async () => {
  const f = await fixture();
  const turn = await runChatTurn(f, EXTRACTION);

  const items = await listInformation(app.db, 'memory', f.workspaceId, f.projectId);
  const statement = items.find((item) => String(item.title) === '数据库选型');
  assert.ok(statement, `自动捕获应写入「数据库选型」：${JSON.stringify(items.map((row) => row.title))}`);
  const statementId = String(statement.id);
  const titles = async () => (await readAutoCaptures(app.db, f.workspaceId))
    .map((row) => String(row.title)).sort();
  assert.deepEqual(await titles(), ['包管理器', '数据库选型']);
  const baseRevision = (await sql<{ revision: bigint }>`select revision from memory_auto_captures
    where memory_id = ${statementId}`.execute(app.db)).rows[0]?.revision;
  assert.ok(baseRevision !== undefined);

  // 普通 RetireMemory（不是「撤销自动记忆」那条路）：账本必须同步停用。
  const retired = await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory',
    id: statementId, expectedRevision: '0', commandId: randomUUID() });
  assert.equal(retired.result.auto_capture_retired, '1',
    `停用回执应带上账本条数：${JSON.stringify(retired.result)}`);
  assert.deepEqual(await titles(), ['包管理器'], '停用后「最近自动记住」不得再显示这一条');

  // 账本行仍在，只是 RETIRED —— 这是「撤销过的内容不再被提取」的依据。
  const ledger = await sql<{ status: string }>`select status from memory_auto_captures
    where memory_id = ${statementId}`.execute(app.db);
  assert.deepEqual(ledger.rows.map((row) => row.status), ['RETIRED']);

  // 重放同一轮提取：已捕获（含已停用）的内容不产生第二条。
  const port = new FakeModelPort();
  port.assist = async () => ({ kind: 'CONTENT', content: EXTRACTION,
    providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal(await captureMemoriesForTurn(app.db, { sessionId: f.sessionId,
    assistantMessageId: turn.assistantMessageId, modelPort: port }), 0);
  const total = await sql<{ count: string }>`select count(*)::text as count from memory_items
    where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(total.rows[0]?.count, '2', '停用后重放不得写回第二条');

  // 恢复：账本回到 ACTIVE，列表重新显示，且不留撤销决定人。
  const restored = await restoreInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory',
    id: statementId, expectedRevision: '1', commandId: randomUUID() });
  assert.equal(restored.result.auto_capture_restored, '1',
    `恢复回执应带上账本条数：${JSON.stringify(restored.result)}`);
  assert.deepEqual(await titles(), ['包管理器', '数据库选型'], '恢复后账本与正文一起回到 ACTIVE');
  const decision = await sql<{ decided_by: string | null; decided_at: Date | null; revision: bigint }>`
    select decided_by, decided_at, revision from memory_auto_captures
    where memory_id = ${statementId}`.execute(app.db);
  assert.equal(decision.rows[0]?.decided_by, null, '恢复后不得留下撤销决定人');
  assert.equal(decision.rows[0]?.decided_at, null);
  // 停用与恢复各推进一格：回执核对靠这个修订号，不能被两次动作合并成一次。
  assert.equal(decision.rows[0]?.revision, baseRevision + 2n, '停用与恢复各推进一格 revision');
});

const EMPTY_EXTRACTION = JSON.stringify({ memories: [] });

/** 绕过提取预检，直接走写入事务：验证「当前事实」闸门本身。 */
async function directWrite(f: { workspaceId: string; projectId: string; sessionId: string },
  turn: { assistantMessageId: string; userMessageId: string }) {
  return withTransaction(app.db, (r) => recordAutoCapture(r, {
    workspaceId: f.workspaceId, projectId: f.projectId, sessionId: f.sessionId,
    triggerMessageId: turn.assistantMessageId, evidenceMessageId: turn.userMessageId,
    evidenceText: USER_TEXT, title: '迟到的一条', text: '不该落库的一条。', reason: null,
    sourceKind: 'USER_STATEMENT', sourceQuote: '我们决定用 PostgreSQL' }));
}

test('提取返回非正文结果时，失败账本仍保留这次外呼的真实用量', async () => {
  const f = await fixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, commandId: randomUUID(), content: USER_TEXT });
  const port = new FakeModelPort();
  port.assist = async (request) => isExtraction(request)
    ? { kind: 'TOOL_CALLS', calls: [], preamble: '', providerRequestId: 'extraction-tool-call',
      usage: { inputTokens: 9, outputTokens: 4 } }
    : { kind: 'CONTENT', content: REPLY_TEXT, providerRequestId: randomUUID(),
      usage: { inputTokens: 11, outputTokens: 5 } };
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));

  const calls = await sql<{ status: string; error_kind: string | null;
    provider_request_id: string | null; usage_input_tokens: number | null;
    usage_output_tokens: number | null }>`select status, error_kind, provider_request_id,
      usage_input_tokens, usage_output_tokens from model_calls
      where assist_message_id = ${sent.result.assistant_message_id}
      order by started_at, id`.execute(app.db);
  assert.equal(calls.rows.length, 2, JSON.stringify(calls.rows));
  const failed = calls.rows.find((row) => row.status === 'FAILED');
  assert.ok(failed, `提取结果不是正文也必须留 FAILED 行：${JSON.stringify(calls.rows)}`);
  assert.equal(failed.error_kind, 'EXTRACTION_TOOL_CALLS');
  assert.equal(failed.provider_request_id, 'extraction-tool-call');
  assert.equal(failed.usage_input_tokens, 9, 'Provider 已计费的用量不能丢');
  assert.equal(failed.usage_output_tokens, 4);
  assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 0);
});

test('会话记忆关闭或会话归档后，迟到提取不写记忆也不再外呼', async () => {
  for (const mode of ['REMEMBER_OFF', 'ARCHIVED'] as const) {
    const f = await fixture();
    const turn = await runChatTurn(f, EMPTY_EXTRACTION);
    if (mode === 'REMEMBER_OFF') {
      await sql`update assist_sessions set remember = false where id = ${f.sessionId}`.execute(app.db);
    } else {
      await archiveAssistSession(app.db, { workspaceId: f.workspaceId, sessionId: f.sessionId,
        commandId: randomUUID(), expectedRevision: '0' });
    }

    let extractionCalls = 0;
    const port = new FakeModelPort();
    port.assist = async () => { extractionCalls += 1;
      return { kind: 'CONTENT', content: EXTRACTION, providerRequestId: randomUUID(),
        usage: { inputTokens: 1, outputTokens: 1 } }; };
    // 预检按当前会话事实收口：状态 / remember 已不成立时不发起模型调用。
    assert.equal(await captureMemoriesForTurn(app.db, { sessionId: f.sessionId,
      assistantMessageId: turn.assistantMessageId, modelPort: port }), 0, mode);
    assert.equal(extractionCalls, 0, `${mode}：关闭后不得再外呼`);
    // 绕过预检直接写：写入事务必须按当前事实整条拒绝。
    assert.equal(await directWrite(f, turn), null, `${mode}：写事务必须拒绝`);
    assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 0, mode);
  }
});

test('提取期间关闭自动记忆或切换会话作用域：迟到的结果不得写入', async () => {
  for (const change of ['AUTO_CAPTURE_OFF', 'PROJECT_CHANGED'] as const) {
    const f = await fixture();
    const sent = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
      sessionId: f.sessionId, commandId: randomUUID(), content: USER_TEXT });
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const port = new FakeModelPort();
    port.assist = async (request) => {
      if (!isExtraction(request)) return { kind: 'CONTENT', content: REPLY_TEXT,
        providerRequestId: randomUUID(), usage: { inputTokens: 11, outputTokens: 5 } };
      extractionStarted();
      await gate;
      return { kind: 'CONTENT', content: EXTRACTION, providerRequestId: randomUUID(),
        usage: { inputTokens: 7, outputTokens: 3 } };
    };
    const pending = runAssistGenerationTick(app.db, { workerId: randomUUID(),
      storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000 });
    await started;

    let otherProjectId: string | null = null;
    if (change === 'AUTO_CAPTURE_OFF') {
      await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
        expectedRevision: '0', recallEnabled: true, automaticCompaction: true, autoCapture: false });
    } else {
      // 提取已开始后会话被挪到别的项目：等价于用户在别处切换了作用域。
      otherProjectId = randomUUID();
      await withTransaction(app.db, (r) => r.projects.insertProject({ id: otherProjectId!,
        workspaceId: f.workspaceId, title: 'other-scope', projectType: 'GENERAL' }));
      await sql`update assist_sessions set project_id = ${otherProjectId}
        where id = ${f.sessionId}`.execute(app.db);
    }

    release();
    const ticked = await pending;
    assert.equal(ticked?.status, 'COMPLETED', change);
    assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 0, change);
    if (otherProjectId !== null) {
      assert.equal((await listInformation(app.db, 'memory', f.workspaceId, otherProjectId)).length, 0,
        '迟到的提取结果不得写进新作用域');
    }
    // 提取调用确实发生过并已记账：不是靠「没调用」通过。
    const calls = await sql<{ status: string }>`select status from model_calls
      where assist_message_id = ${sent.result.assistant_message_id}`.execute(app.db);
    assert.equal(calls.rows.length, 2, `${change}：${JSON.stringify(calls.rows)}`);
  }
});

test('并发提取同一轮：advisory 锁与去重指纹只留一份', async () => {
  const f = await fixture();
  const turn = await runChatTurn(f, EMPTY_EXTRACTION);
  const extractionPort = () => {
    const port = new FakeModelPort();
    port.assist = async () => ({ kind: 'CONTENT', content: EXTRACTION,
      providerRequestId: randomUUID(), usage: { inputTokens: 1, outputTokens: 1 } });
    return port;
  };
  const [left, right] = await Promise.all([
    captureMemoriesForTurn(app.db, { sessionId: f.sessionId,
      assistantMessageId: turn.assistantMessageId, modelPort: extractionPort() }),
    captureMemoriesForTurn(app.db, { sessionId: f.sessionId,
      assistantMessageId: turn.assistantMessageId, modelPort: extractionPort() }),
  ]);
  assert.equal(left + right, 2, `两条候选各写一次：${left} + ${right}`);
  assert.equal((await listInformation(app.db, 'memory', f.workspaceId, f.projectId)).length, 2);
  const captures = await sql<{ count: string }>`select count(*)::text as count
    from memory_auto_captures where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(captures.rows[0]?.count, '2');
});

/**
 * P0-C：提取必须用**消息冻结的模型路由**。
 *
 * 主回复结算后消息已 COMPLETED，OpenRouter 路由包装器会以 `ASSIST_MODEL_SNAPSHOT_MISSING`
 * 拒绝调用；若退回默认端口，又会让提取走与主回复不同的 Provider。这里用真实 HTTP
 * （仅把 openrouter.ai 重定向到本机）验证：主回复与提取各一次外呼，提取用的是冻结型号、
 * 冻结预算，免费硬限制同样到达外呼体。
 */
test('OpenRouter 会话的自动提取使用消息冻结的模型路由并独立记账', async () => {
  const model = `free-capture-${randomUUID()}`;
  await sql`insert into model_catalog_entries
    (source_model_id, display_name, context_window, pricing, capabilities, is_free,
     not_free_reason, fetched_at)
    values (${model}, ${model}, 131072, '{"prompt":"0","completion":"0"}'::jsonb,
      '{"tools":true,"response_format":true,"text_input":true,"text_output":true}'::jsonb,
      true, null, now())`.execute(app.db);
  await sql`update model_catalog_sync_state set snapshot_seq = snapshot_seq + 1,
    last_success_at = now(), consecutive_failures = 0, last_failure_at = null,
    last_failure_reason = null where singleton = true`.execute(app.db);

  const workspaceId = await createWorkspace(app.db);
  const projectId = randomUUID();
  await withTransaction(app.db, (r) => r.projects.insertProject({ id: projectId, workspaceId,
    title: 'frozen-route-capture', projectType: 'GENERAL' }));
  const sessionId = randomUUID();
  await createRepositories(app.db).assist.insertSession({ id: sessionId, workspaceId,
    projectId, taskId: null, title: '冻结路由自动记忆' });
  const env = { RELAY_OPENROUTER_API_KEY: 'controlled-capture-key' } as NodeJS.ProcessEnv;
  const selection = await selectSessionModel(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: model, env });
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: USER_TEXT,
    expectedModelSelectionRevision: selection.result.revision }, env);

  const seen: { readonly extraction: boolean; readonly provider: unknown }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.once('end', () => {
      if ((request.url ?? '') !== '/api/v1/chat/completions') {
        response.writeHead(404).end(); return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string; provider?: unknown; messages?: { content?: unknown }[] };
      const system = typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : '';
      const extraction = system.includes(EXTRACTION_MARKER);
      seen.push({ extraction, provider: body.provider });
      const content = extraction ? EXTRACTION : REPLY_TEXT;
      const usage = extraction ? { prompt_tokens: 7, completion_tokens: 3 }
        : { prompt_tokens: 11, completion_tokens: 5 };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        `data: ${JSON.stringify({ id: 'chatcmpl-capture', object: 'chat.completion.chunk',
          created: 1, model, choices: [{ index: 0, delta: { role: 'assistant' },
            finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'chatcmpl-capture', object: 'chat.completion.chunk',
          created: 1, model, choices: [{ index: 0, delta: { content },
            finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'chatcmpl-capture', object: 'chat.completion.chunk',
          created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const localOrigin = `http://127.0.0.1:${address.port}`;
    const dependencies: ModelFetchDependencies = {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(target.origin, 'https://openrouter.ai');
        const local = await fetch(`${localOrigin}${target.pathname}`, init);
        return new Response(local.body, { status: local.status, statusText: local.statusText,
          headers: local.headers });
      },
    };
    const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
      storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(), leaseMs: 60_000,
      modelEnv: env, modelFetchDependencies: dependencies });
    assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(
      (error) => error ? reject(error) : resolve()));
  }

  assert.deepEqual(seen.map((entry) => entry.extraction).sort(), [false, true],
    '主回复与提取各一次真实外呼');
  for (const entry of seen) {
    assert.deepEqual(entry.provider, { max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      allow_fallbacks: false, require_parameters: true },
    '冻结的仅免费约束必须同样作用到提取外呼');
  }
  assert.deepEqual((await listInformation(app.db, 'memory', workspaceId, projectId))
    .map((item) => String(item.title)).sort(), ['包管理器', '数据库选型']);

  const snapshot = (await sql<{ snapshot: { budget: { call_reservation_tokens: number } } }>`
    select model_selection_snapshot as snapshot from assist_messages
    where id = ${sent.result.assistant_message_id}`.execute(app.db)).rows[0]?.snapshot;
  assert.ok(snapshot);
  const calls = await sql<{ model: string; provider: string; status: string;
    usage_input_tokens: number | null; usage_output_tokens: number | null;
    budget_reserved_tokens: number | null }>`select model, provider, status,
      usage_input_tokens, usage_output_tokens, budget_reserved_tokens from model_calls
      where assist_message_id = ${sent.result.assistant_message_id}
      order by started_at, id`.execute(app.db);
  assert.equal(calls.rows.length, 2, JSON.stringify(calls.rows));
  const extractionCall = calls.rows.find((row) => row.usage_input_tokens === 7);
  assert.ok(extractionCall, `提取调用必须来自冻结路由：${JSON.stringify(calls.rows)}`);
  assert.equal(extractionCall.provider, 'openrouter');
  assert.equal(extractionCall.model, model);
  assert.equal(extractionCall.status, 'COMPLETED');
  assert.equal(extractionCall.usage_output_tokens, 3);
  assert.equal(extractionCall.budget_reserved_tokens, snapshot.budget.call_reservation_tokens,
    '记账预算取消息冻结快照，不是进程默认值');
});
