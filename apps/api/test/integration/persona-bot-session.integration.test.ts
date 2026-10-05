import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { createBotProfile, reviseBotProfile, archiveBotProfile } from
  '../../src/application/bot-profile-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { toDecimalString } from '../../src/shared/decimal.js';
import { createDataRoot, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 会话模式与人设 bot 配置的真实 PG 出口（迁移 0059）。
 *
 * 覆盖三类事实：
 *   * bot_profiles 的作用域唯一性、revision CAS 与归档；
 *   * assist_sessions 建立时冻结模式与人设快照，之后不可改写；
 *   * 既有会话按 AGENT 读出，不虚构 bot 关系；同 command_id 异载荷被拒。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-persona-bot-session');
let dataRoot: string;
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  api = await startTestApi();
});
after(async () => {
  if (api !== undefined) await api.stop();
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function workspace(title: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `${title}-${workspaceId.slice(0, 8)}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function countSessions(workspaceId: string): Promise<number> {
  return (await sql<{ present: boolean }>`select exists(
    select 1 from assist_sessions where workspace_id = ${workspaceId}) as present`
    .execute(app.db)).rows[0]?.present === true ? 1 : 0;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : undefined;
}

/** 契约第 1 节：revision 在 JSON 与回执里都是十进制字符串。 */
function revisionOf(result: JsonObject): bigint {
  return BigInt(String(result.revision));
}

/** validationFailed 把逐项问题放在 fieldErrors 里，detail 只是总述。 */
function problemText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const problems = (error as { fieldErrors?: unknown }).fieldErrors;
  if (!Array.isArray(problems)) return '';
  return problems.map((problem) => typeof problem === 'object' && problem !== null
    ? Object.values(problem as Record<string, unknown>).join(' ') : String(problem)).join(' ');
}

test('0059：assist_sessions 增五列且 CHECK 绑定模式与 bot', async () => {
  const columns = (await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_name = 'assist_sessions'
      and column_name in ('conversation_mode','bot_profile_id','bot_profile_revision',
        'bot_role_snapshot','remember')
    order by column_name`.execute(app.db)).rows.map((row) => row.column_name);
  assert.deepEqual(columns,
    ['bot_profile_id', 'bot_profile_revision', 'bot_role_snapshot', 'conversation_mode', 'remember']);

  const workspaceId = await workspace('mode-check');
  // BOT 必须带 bot_profile_id，缺 bot 的会话插不进去。
  await assert.rejects(() => sql`
    insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, bot_profile_id)
    values (${randomUUID()}, ${workspaceId}, null, null, '缺 bot 的 BOT 会话', 'BOT', null)`
    .execute(app.db));
  // AGENT 不得携带 bot 字段，避免「普通会话其实挂着人设」的形态。
  const created = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核' });
  const botId = created.result.bot_profile_id as string;
  await assert.rejects(() => sql`
    insert into assist_sessions (id, workspace_id, project_id, task_id, title,
      conversation_mode, bot_profile_id, bot_profile_revision, bot_role_snapshot)
    values (${randomUUID()}, ${workspaceId}, null, null, '挂着 bot 的 AGENT 会话', 'AGENT',
      ${botId}, 1, ${JSON.stringify({ name: '审读' })}::jsonb)`.execute(app.db));
});

test('既有会话按 AGENT 读出，且不虚构 bot 关系', async () => {
  const workspaceId = await workspace('legacy-agent');
  await sql`insert into assist_sessions (id, workspace_id, project_id, task_id, title)
    values (${randomUUID()}, ${workspaceId}, null, null, '迁移前的旧会话')`.execute(app.db);
  const row = (await sql<{ conversation_mode: string; bot_profile_id: string | null;
    bot_profile_revision: string | null; bot_role_snapshot: unknown; remember: boolean }>`
    select conversation_mode, bot_profile_id, bot_profile_revision, bot_role_snapshot, remember
    from assist_sessions where workspace_id = ${workspaceId}`.execute(app.db)).rows[0];
  assert.equal(row?.conversation_mode, 'AGENT');
  assert.equal(row?.bot_profile_id, null);
  assert.equal(row?.bot_profile_revision, null);
  assert.equal(row?.bot_role_snapshot, null);
  assert.equal(row?.remember, true);
});

test('bot_profiles 同 workspace 活跃名唯一，归档后可重用', async () => {
  const workspaceId = await workspace('bot-names');
  const first = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核', tone: '简短' });
  const botId = first.result.bot_profile_id as string;

  await assert.rejects(() => createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '另一个同名 bot' }),
  (error: unknown) => {
    assert.equal(codeOf(error), 'VALIDATION_FAILED');
    assert.match(problemText(error), /同名/);
    return true;
  });

  const archived = await archiveBotProfile(app.db, { workspaceId, botProfileId: botId,
    commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(first.result)) });
  assert.equal(archived.result.status, 'ARCHIVED');
  // 归档后同名可再建，且旧行不被改动。
  const reused = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '新的同名 bot' });
  assert.notEqual(reused.result.bot_profile_id, botId);
  const row = (await sql<{ status: string; role_description: string }>`
    select status, role_description from bot_profiles where id = ${botId}`.execute(app.db)).rows[0];
  assert.deepEqual(row, { status: 'ARCHIVED', role_description: '只读复核' });
});

test('revise 用 revision CAS，落后的期望被拒且不改行', async () => {
  const workspaceId = await workspace('bot-cas');
  const created = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '第一版' });
  const botId = created.result.bot_profile_id as string;
  const revised = await reviseBotProfile(app.db, { workspaceId, botProfileId: botId,
    commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(created.result)),
    name: '审读', roleDescription: '第二版' });
  assert.equal(revisionOf(revised.result), revisionOf(created.result) + 1n);

  await assert.rejects(() => reviseBotProfile(app.db, { workspaceId, botProfileId: botId,
    commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(created.result)),
    name: '审读', roleDescription: '第三版' }),
  (error: unknown) => { assert.equal(codeOf(error), 'REVISION_CONFLICT'); return true; });

  const row = (await sql<{ role_description: string }>`select role_description
    from bot_profiles where id = ${botId}`.execute(app.db)).rows[0];
  assert.equal(row?.role_description, '第二版');
});

test('BOT 会话建立时冻结人设快照，之后不可改写', async () => {
  const workspaceId = await workspace('frozen-snapshot');
  const bot = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核' });
  const botId = bot.result.bot_profile_id as string;
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '人设会话', conversationMode: 'BOT', botProfileId: botId });

  const frozen = (await sql<{ bot_profile_id: string; bot_profile_revision: bigint;
    bot_role_snapshot: { name?: string; role_description?: string; capabilities?: unknown } }>`
    select bot_profile_id, bot_profile_revision, bot_role_snapshot
    from assist_sessions where id = ${created.result.session_id}`.execute(app.db)).rows[0];
  assert.equal(frozen?.bot_profile_id, botId);
  assert.equal(frozen?.bot_profile_revision, revisionOf(bot.result));
  assert.equal(frozen?.bot_role_snapshot.name, '审读');
  // 快照是文本，不是授权：不得含能力或连接信息。
  assert.equal(frozen?.bot_role_snapshot.capabilities, undefined);

  // 改 bot 不影响既有会话的冻结快照。
  await reviseBotProfile(app.db, { workspaceId, botProfileId: botId, commandId: randomUUID(),
    expectedRevision: toDecimalString(revisionOf(bot.result)),
    name: '审读', roleDescription: '改过的人设' });
  const after_ = (await sql<{ bot_role_snapshot: { role_description?: string } }>`
    select bot_role_snapshot from assist_sessions where id = ${created.result.session_id}`
    .execute(app.db)).rows[0];
  assert.equal(after_?.bot_role_snapshot.role_description, '只读复核');

  // 直接改写被 CHECK 与只读语义共同挡住：会话身份没有公开的改写命令。
  await assert.rejects(() => sql`update assist_sessions set bot_profile_id = null
    where id = ${created.result.session_id}`.execute(app.db));
});

test('BOT 会话缺 bot 建不出来，归档 bot 建不出新会话', async () => {
  const workspaceId = await workspace('bot-required');
  await assert.rejects(() => createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '缺 bot', conversationMode: 'BOT' }),
  (error: unknown) => { assert.equal(codeOf(error), 'VALIDATION_FAILED'); return true; });

  const bot = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核' });
  await archiveBotProfile(app.db, { workspaceId, botProfileId: bot.result.bot_profile_id as string,
    commandId: randomUUID(), expectedRevision: toDecimalString(revisionOf(bot.result)) });
  await assert.rejects(() => createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '归档 bot', conversationMode: 'BOT', botProfileId: bot.result.bot_profile_id as string }),
  (error: unknown) => { assert.equal(codeOf(error), 'INVALID_TRANSITION'); return true; });
});

test('跨 workspace 的 bot 不能建会话', async () => {
  const ownerWorkspace = await workspace('bot-owner');
  const otherWorkspace = await workspace('bot-other');
  const bot = await createBotProfile(app.db, { workspaceId: ownerWorkspace, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核' });
  await assert.rejects(() => createAssistSession(app.db, { workspaceId: otherWorkspace,
    commandId: randomUUID(), title: '越权', conversationMode: 'BOT',
    botProfileId: bot.result.bot_profile_id as string }),
  (error: unknown) => { assert.equal(codeOf(error), 'RESOURCE_NOT_FOUND'); return true; });
});

test('同 command_id 换模式重放被拒', async () => {
  const workspaceId = await workspace('replay-mode');
  const commandId = randomUUID();
  await createAssistSession(app.db, { workspaceId, commandId, title: '先按普通会话建' });
  // 摘要不同即异载荷：不能因为 command_id 相同就拿到那条普通会话。
  await assert.rejects(() => createAssistSession(app.db, { workspaceId, commandId,
    title: '先按普通会话建', conversationMode: 'BOT', botProfileId: randomUUID() }),
  (error: unknown) => {
    assert.equal((error as { name?: unknown }).name, 'CommandIdReusedError');
    return true;
  });
});

test('同 command_id 同载荷重放返回原会话', async () => {
  const workspaceId = await workspace('replay-same');
  const bot = await createBotProfile(app.db, { workspaceId, commandId: randomUUID(),
    name: '审读', roleDescription: '只读复核' });
  const commandId = randomUUID();
  const first = await createAssistSession(app.db, { workspaceId, commandId, title: '人设会话',
    conversationMode: 'BOT', botProfileId: bot.result.bot_profile_id as string });
  const second = await createAssistSession(app.db, { workspaceId, commandId, title: '人设会话',
    conversationMode: 'BOT', botProfileId: bot.result.bot_profile_id as string });
  assert.equal(second.result.session_id, first.result.session_id);
  assert.equal(second.replayed, true);
});

test('AGENT 会话不传模式时行为不变', async () => {
  const workspaceId = await workspace('agent-unchanged');
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '普通会话' });
  const row = (await sql<{ conversation_mode: string; remember: boolean }>`
    select conversation_mode, remember from assist_sessions where id = ${created.result.session_id}`
    .execute(app.db)).rows[0];
  assert.equal(row?.conversation_mode, 'AGENT');
  assert.equal(row?.remember, true);

  // 既有发送入口照常工作：mode 不参与消息准入（Task 3 才加 B 档规则）。
  const sent = await requestAssistMessage(app.db, { workspaceId,
    sessionId: created.result.session_id, commandId: randomUUID(), content: '普通讨论一句' });
  assert.equal(sent.result.session_id, created.result.session_id);
});

test('HTTP：建 bot、列 bot、按人设模式建会话，读回冻结快照', async () => {
  const workspaceId = await workspace('http-bot');
  const scope = workspacePath(workspaceId, '');

  const created = await api.post(`${scope}/bot-profiles`, { command_id: randomUUID(),
    name: '审读', role_description: '只读复核这份改动', tone: '简短',
    read_scope: { roots: ['src'] } });
  assert.equal(created.status, 201, created.text);
  const botId = (created.body as { result: { bot_profile_id: string } }).result.bot_profile_id;

  const listed = await api.get(`${scope}/bot-profiles`);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual((listed.body as { items: { name: string }[] }).items.map((item) => item.name),
    ['审读']);

  const session = await api.post(`${scope}/assist-sessions`, { command_id: randomUUID(),
    title: '人设会话', conversation_mode: 'BOT', bot_profile_id: botId });
  assert.equal(session.status, 201, session.text);
  const sessionId = (session.body as { result: { session_id: string;
    conversation_mode: string } }).result;
  assert.equal(sessionId.conversation_mode, 'BOT');

  const read = await api.get(`${scope}/assist-sessions/${sessionId.session_id}`);
  assert.equal(read.status, 200, read.text);
  const dto = read.body as { conversation_mode: string; bot_profile_id: string;
    bot_role: { name?: string; read_scope?: unknown } | null; remember: boolean };
  assert.equal(dto.conversation_mode, 'BOT');
  assert.equal(dto.bot_profile_id, botId);
  assert.equal(dto.bot_role?.name, '审读');
  assert.deepEqual(dto.bot_role?.read_scope, { roots: ['src'] });
  assert.equal(dto.remember, true);

  // 不传模式的既有客户端仍按 AGENT 建会话，响应里多出来的字段不改变既有语义。
  const plain = await api.post(`${scope}/assist-sessions`, { command_id: randomUUID(),
    title: '普通会话' });
  assert.equal(plain.status, 201, plain.text);
  assert.equal((plain.body as { result: { conversation_mode: string } }).result.conversation_mode,
    'AGENT');
});

test('HTTP：BOT 缺 bot_profile_id 被拒，且不建出会话', async () => {
  const workspaceId = await workspace('http-missing-bot');
  const before_ = await countSessions(workspaceId);
  const response = await api.post(workspacePath(workspaceId, '/assist-sessions'),
    { command_id: randomUUID(), title: '缺 bot', conversation_mode: 'BOT' });
  assert.equal(response.status, 422, response.text);
  assert.equal((response.body as { code?: string }).code, 'VALIDATION_FAILED');
  assert.equal(await countSessions(workspaceId), before_);
});

test('HTTP：只读范围想扩大时被拒', async () => {
  const workspaceId = await workspace('http-scope');
  const response = await api.post(workspacePath(workspaceId, '/bot-profiles'),
    { command_id: randomUUID(), name: '越界', role_description: '想读到根外',
      read_scope: { roots: ['../outside'] } });
  assert.equal(response.status, 422, response.text);
  const rows = (await sql<{ present: boolean }>`select exists(
    select 1 from bot_profiles where workspace_id = ${workspaceId}) as present`
    .execute(app.db)).rows[0];
  assert.equal(rows?.present, false);
});