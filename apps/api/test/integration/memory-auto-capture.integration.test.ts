import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { loadAssistSourceContent } from '../../src/application/assist-source-content.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { captureMemoriesForTurn } from '../../src/application/memory-auto-capture.js';
import { recordAutoCapture } from '../../src/application/memory-captures.js';
import { listInformation } from '../../src/application/information-queries.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistRequest } from '../../src/workflow/fake-model-port.js';
import { createDataRoot } from './api-harness.js';
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
