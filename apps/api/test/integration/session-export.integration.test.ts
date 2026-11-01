import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { archiveAssistSession } from '../../src/application/assist-session-controls.js';
import { createGatewayConnectionCommand, createGatewayPolicyCommand }
  from '../../src/application/gateway-commands.js';
import { registerManagedResource } from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, expectProblem, startTestApi, workspacePath, type TestApi }
  from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 会话导出（`GET /assist-sessions/:id/export`）的真实 PostgreSQL 集成。
 *
 * 判的是这份诊断文件**能不能被当作事实**，取证口径跟着导出的四条承诺走：
 *   * 证据齐全：消息、工具轮次、清单、模型用量、执行请求与动作身份各有其位；
 *   * 不静默残缺：长会话一条不少，真被上限切掉时 `completeness` 必须自己说清楚；
 *   * 不冒充：读不到的写 null 并说明原因，界面百分比不反推成 token，缺的证据点名缺；
 *   * 不改事实：一次导出不推进修订、不写回执、不结算任何一行。
 *
 * 不取证：真实 Provider、Windows 下载行为与界面观感（分别在桌面轮与浏览器轮）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-session-export-test');
let api: TestApi;
let storage: ManagedContentStore;
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
  storage = new ManagedContentStore(api.dataRoot);
});
after(async () => {
  await api?.stop();
  await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `export-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newProject(workspaceId: string, title: string): Promise<string> {
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title,
      projectType: 'DEVELOPMENT' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  return projectId;
}

async function newSession(workspaceId: string, title = '导出用的讨论'): Promise<string> {
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title });
  return created.result.session_id;
}

/** 走真实受理与受控生成得到一落定轮：USER + ASSISTANT COMPLETED，并留下真实 model_calls 行。 */
async function settledRound(workspaceId: string, sessionId: string, content: string,
  reply: string): Promise<{ userId: string; assistantId: string }> {
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content, intent: 'DISCUSS' });
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async () => ({ kind: 'CONTENT', content: reply,
      providerRequestId: `export-${randomUUID().slice(0, 8)}`,
      usage: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: null,
        cacheCreationTokens: null } }),
  };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runAssistGenerationTick(app.db, { workerId: `export-${randomUUID()}`,
      storage, modelPort: port, leaseMs: 60_000, maxMessages: 1 });
    if (outcome?.messageId === sent.result.assistant_message_id && outcome.status !== 'DISCARDED') break;
  }
  const message = await createRepositories(app.db).assist.readMessage(sent.result.assistant_message_id);
  assert.equal(message?.status, 'COMPLETED', '受控生成必须把这一轮结算完，否则判的就不是落定态');
  return { userId: sent.result.user_message_id, assistantId: sent.result.assistant_message_id };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

async function recordCall(sessionId: string, messageId: string, round: number, ordinal: number,
  toolName: string, args: JsonObject): Promise<string> {
  const repository = new SessionToolCallRepository(app.db);
  const row = await repository.insert({ id: randomUUID(), sessionId, messageId, round, ordinal,
    toolName, arguments: args, argumentsSha256: digest(args),
    providerToolCallId: `call_${round}_${ordinal}` });
  return row.id;
}

function exportUrl(workspaceId: string, sessionId: string): string {
  return workspacePath(workspaceId, `/assist-sessions/${sessionId}/export`);
}

async function exportSession(workspaceId: string, sessionId: string): Promise<Record<string, any>> {
  const response = await api.get(exportUrl(workspaceId, sessionId));
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers['cache-control'], 'no-store');
  return JSON.parse(response.text) as Record<string, any>;
}

async function countOf(query: { execute(db: DbExecutor): Promise<{ rows: readonly unknown[] }> }):
Promise<number> {
  const row = (await query.execute(app.db)).rows[0] as { c?: string } | undefined;
  return Number(row?.c ?? '0');
}

/** 会话相关账本的整体指纹：导出前后同一份，就证明读路径没有落任何一笔。 */
async function ledgerSnapshot(sessionId: string): Promise<string> {
  const facts = await sql<{ table_name: string; c: string; marker: string | null }>`
    select 'messages' as table_name, count(*)::text as c, max(updated_at)::text as marker
      from assist_messages where session_id = ${sessionId}
    union all select 'tool_calls', count(*)::text,
      string_agg(status || coalesce(rejection_reason, ''), ',' order by ordinal)
      from session_tool_calls where session_id = ${sessionId}
    union all select 'todo_snapshots', count(*)::text, max(version)::text
      from assist_session_todo_snapshots where session_id = ${sessionId}
    union all select 'todo_events', count(*)::text, null
      from assist_session_todo_events where session_id = ${sessionId}
    union all select 'model_calls', count(*)::text, max(status)
      from model_calls where assist_message_id in
      (select id from assist_messages where session_id = ${sessionId})
    union all select 'previews', count(*)::text, max(revision)::text
      from assist_message_previews where message_id in
      (select id from assist_messages where session_id = ${sessionId})
  `.execute(app.db);
  const session = await sql<{ revision: string; updated_at: string; status: string }>`
    select revision::text as revision, updated_at::text as updated_at, status
    from assist_sessions where id = ${sessionId}`.execute(app.db);
  return JSON.stringify({ facts: facts.rows, session: session.rows,
    receipts: await countOf(sql`select count(*)::text as c from command_receipts`),
    activities: await countOf(sql`select count(*)::text as c from activity_records`) });
}

async function seedTodo(workspaceId: string, sessionId: string, messageId: string,
  messageSeq: number): Promise<void> {
  const items = JSON.stringify([
    { id: 't1', content: '读现状', status: 'completed' },
    { id: 't2', content: '改投影', status: 'in_progress' },
  ]);
  // 轮次归属行由真实消息路径已经开好（`turn:<用户消息 id>`），这里只补快照：
  // 导出的 `readCurrent` 读的就是快照那一行连同它自带的 scope_key。
  await sql`insert into assist_session_todo_snapshots (session_id, workspace_id, scope_key,
      version, items, in_progress_limit, last_tool_call_id, last_message_id, scope_seq)
    values (${sessionId}, ${workspaceId}, ${`turn:${messageId}`}, 3, ${items}::jsonb, 1,
      ${randomUUID()}, ${messageId}, ${messageSeq})`.execute(app.db);
}

test('EX-01 正常会话：一次落定轮导出后消息原文、模型用量与工具轮次各归其位', async () => {
  const workspaceId = await newWorkspace('normal');
  const sessionId = await newSession(workspaceId, '导出基线会话');
  const round = await settledRound(workspaceId, sessionId, '请按目录现状给个方案', '先读清单再定顺序。');
  await recordCall(sessionId, round.assistantId, 0, 0, 'list_directory', { path: '.', limit: 50 });
  await recordCall(sessionId, round.assistantId, 0, 1, 'read_file', { path: 'README.md' });

  const doc = await exportSession(workspaceId, sessionId);

  assert.equal(doc.format, 'relay-session-export');
  assert.equal(doc.schema_version, '1.0');
  assert.match(doc.exported_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(doc.session.id, sessionId);
  assert.equal(doc.session.title, '导出基线会话');
  assert.equal(doc.session.status, 'ACTIVE');
  assert.equal(doc.workspace.id, workspaceId);
  assert.equal(doc.snapshot.is_generating, false, '落定轮不该被标成在途');

  assert.equal(doc.messages.length, 2);
  const [user, assistant] = doc.messages;
  assert.equal(user.role, 'USER');
  assert.equal(user.content, '请按目录现状给个方案', '正文逐字保留，这是导出文件的价值');
  assert.equal(assistant.role, 'ASSISTANT');
  assert.equal(assistant.status, 'COMPLETED');
  assert.equal(assistant.content, '先读清单再定顺序。');
  assert.equal(assistant.usage.input_tokens, 1234);
  assert.equal(assistant.usage.output_tokens, 567);
  assert.equal(assistant.error_code, null, '成功的一轮不该带错误码');

  const dbCalls = await sql<{ c: string }>`select count(*)::text as c from model_calls
    where assist_message_id = ${round.assistantId}`.execute(app.db);
  assert.equal(doc.model_calls.length, Number(dbCalls.rows[0]!.c),
    '这一轮真实发生过几次调用就写几条，不多一条也不少一条');
  assert.ok(doc.model_calls.every((call: any) => call.assist_message_id === round.assistantId),
    '模型调用只挂在本会话被导出的消息上');
  assert.ok(doc.model_calls.some((call: any) => call.usage.input_tokens === 1234
    && call.usage.output_tokens === 567), '计量列取 model_calls 原列，不从界面反推');

  assert.equal(doc.tool_calls.length, 1);
  const group = doc.tool_calls[0];
  assert.equal(group.message_id, round.assistantId);
  assert.equal(group.message_status, 'COMPLETED');
  assert.equal(group.rounds[0].round, 0);
  assert.deepEqual(group.rounds[0].calls.map((call: any) => call.tool_name),
    ['list_directory', 'read_file']);
  assert.deepEqual(group.rounds[0].calls[0].arguments, { path: '.', limit: 50 });

  assert.equal(doc.completeness.messages.total, 2);
  assert.equal(doc.completeness.messages.exported, 2);
  assert.equal(doc.completeness.messages.truncated, false);
  assert.equal(doc.privacy.redacted_key_fields, 0, '干净参数不该有脱敏命中');
});

test('EX-02 归档会话同样可导出：状态如实写 ARCHIVED，不因归档失去诊断价值', async () => {
  const workspaceId = await newWorkspace('archived');
  const sessionId = await newSession(workspaceId, '归档后要复盘的讨论');
  await settledRound(workspaceId, sessionId, '归档前最后一问', '已记录。');
  const revision = (await sql<{ r: string }>`select revision::text as r from assist_sessions
    where id = ${sessionId}`.execute(app.db)).rows[0]!.r;
  await archiveAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: revision });

  const doc = await exportSession(workspaceId, sessionId);

  assert.equal(doc.session.status, 'ARCHIVED');
  assert.equal(doc.messages.length, 2);
  assert.equal(doc.completeness.messages.truncated, false);
});

test('EX-03 空会话：消息为空是事实，不报错也不造占位内容', async () => {
  const workspaceId = await newWorkspace('empty');
  const sessionId = await newSession(workspaceId, '一句没说的会话');

  const doc = await exportSession(workspaceId, sessionId);

  assert.deepEqual(doc.messages, []);
  assert.deepEqual(doc.tool_calls, []);
  assert.deepEqual(doc.model_calls, []);
  assert.deepEqual(doc.executions, []);
  assert.deepEqual(doc.operations, []);
  assert.equal(doc.todos.snapshot, null);
  assert.equal(doc.todos.change_history_exported, false);
  assert.equal(doc.completeness.messages.total, 0);
  assert.equal(doc.completeness.messages.truncated, false);
  assert.equal(doc.session.has_messages, false);
});

test('EX-04 被拒、已结算、已放弃与仍在请求中四态分明，拒绝原文可追', async () => {
  const workspaceId = await newWorkspace('tool-states');
  const sessionId = await newSession(workspaceId, '工具账本多态');
  const round = await settledRound(workspaceId, sessionId, '跑几个工具', '都试过了。');
  const repository = new SessionToolCallRepository(app.db);
  const rejected = await recordCall(sessionId, round.assistantId, 0, 0, 'find_paths', { pattern: '' });
  await repository.reject(rejected, 'INVALID_ARGUMENTS', '缺少必填参数 pattern。');
  const settled = await recordCall(sessionId, round.assistantId, 0, 1, 'todo_write',
    { items: [{ content: '读现状', status: 'pending' }] });
  const settledOk = await repository.settleTodoWrite(settled, 'ok:true');
  assert.ok(settledOk, '应用内工具的结算走真实入口，不在测试里伪造状态');
  const unknown = await recordCall(sessionId, round.assistantId, 0, 2, 'read_file', { path: 'a.md' });
  await repository.abandon(unknown, 'CANCELLED_BY_USER');
  await recordCall(sessionId, round.assistantId, 1, 0, 'list_directory', { path: 'docs' });

  const doc = await exportSession(workspaceId, sessionId);
  const calls = doc.tool_calls[0].rounds.flatMap((entry: any) => entry.calls);

  assert.equal(calls.length, 4);
  const byName = new Map<string, any>(calls.map((call: any) => [call.tool_name, call]));
  assert.equal(byName.get('find_paths').status, 'REJECTED');
  assert.equal(byName.get('find_paths').rejection_reason, 'INVALID_ARGUMENTS');
  assert.equal(byName.get('find_paths').rejection_detail, '缺少必填参数 pattern。');
  assert.equal(byName.get('todo_write').status, 'SETTLED');
  assert.equal(byName.get('todo_write').result_digest, 'ok:true');
  assert.equal(byName.get('todo_write').operation_id, null, '应用内工具没有 Gateway 动作');
  assert.equal(byName.get('read_file').status, 'ABANDONED');
  assert.equal(byName.get('read_file').rejection_reason, 'CANCELLED_BY_USER');
  assert.equal(byName.get('list_directory').status, 'REQUESTED');
  assert.equal(byName.get('list_directory').settled_at, null);
  assert.deepEqual(doc.operations, [], '没有动作身份的会话不该凭空长出操作账本');
  assert.ok(doc.completeness.missing_evidence.some((note: string) => note.includes('result_digest')),
    '账本只存摘要不存正文，必须当面写缺');
});

test('EX-05 长会话（>200 条）不丢历史：界面分页上限不影响导出', async () => {
  const workspaceId = await newWorkspace('long');
  const sessionId = await newSession(workspaceId, '长会话');
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    select gen_random_uuid(), ${sessionId}, s, 'USER', 'COMPLETED', 'DISCUSS',
      '第 ' || s || ' 条历史'
    from generate_series(1, 260) as s`.execute(app.db);

  const doc = await exportSession(workspaceId, sessionId);

  assert.equal(doc.messages.length, 260, '读消息的 200 条上限是界面分页口径，导出不能沿用');
  assert.equal(doc.completeness.messages.total, 260);
  assert.equal(doc.completeness.messages.exported, 260);
  assert.equal(doc.completeness.messages.truncated, false);
  assert.equal(doc.messages[259].seq, '260');
  assert.equal(doc.messages[259].content, '第 260 条历史');
});

test('EX-06 真被上限切掉时明说部分导出，不把残缺当完整', async () => {
  const workspaceId = await newWorkspace('truncated');
  const sessionId = await newSession(workspaceId, '超限会话');
  const round = await settledRound(workspaceId, sessionId, '大量工具', '收尾。');
  await sql`insert into session_tool_calls (id, session_id, message_id, round, ordinal,
      tool_name, arguments, arguments_sha256, status)
    select gen_random_uuid(), ${sessionId}, ${round.assistantId}, 0, s, 'read_file',
      '{}'::jsonb, ${'0'.repeat(64)}, 'REQUESTED'
    from generate_series(1, 520) as s`.execute(app.db);

  const doc = await exportSession(workspaceId, sessionId);

  assert.equal(doc.completeness.tool_calls.total, 520);
  assert.equal(doc.completeness.tool_calls.exported, 500);
  assert.equal(doc.completeness.tool_calls.limit, 500);
  assert.equal(doc.completeness.tool_calls.truncated, true);
  assert.match(doc.completeness.tool_calls.reason, /部分导出/u);
  assert.equal(doc.messages.length, 2, '消息侧没超限，不该被连坐标记');
  assert.equal(doc.completeness.messages.truncated, false);
});

test('EX-07 生成中导出：标注为截至导出时刻的快照，在途正文只给已落盘的即时草稿', async () => {
  const workspaceId = await newWorkspace('generating');
  const sessionId = await newSession(workspaceId, '正在生成的会话');
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '慢慢说', intent: 'DISCUSS' });
  const assistantId = sent.result.assistant_message_id;
  await sql`update assist_messages set status = 'RUNNING', worker_id = 'export-holder'
    where id = ${assistantId}`.execute(app.db);
  await createRepositories(app.db).assist.writeLivePreview(assistantId, 'export-holder',
    '已经写出来的前半段🙂', false);

  const doc = await exportSession(workspaceId, sessionId);

  assert.equal(doc.snapshot.is_generating, true);
  assert.equal(doc.snapshot.run_state, 'RUNNING');
  assert.match(doc.snapshot.note, /截至导出时刻/u);
  const inFlight = doc.messages.find((message: any) => message.id === assistantId);
  assert.equal(inFlight.status, 'RUNNING');
  assert.equal(inFlight.content, null, '未结算的回复还没有正文，不能拿草稿冒充正文');
  assert.equal(inFlight.live_preview.text, '已经写出来的前半段🙂');
  assert.equal(inFlight.live_preview.revision, '1');
});

test('EX-08 归属收口：跨 Workspace、不存在的会话与无凭据分别按既有口径拒绝', async () => {
  const owner = await newWorkspace('owner');
  const other = await newWorkspace('other');
  const sessionId = await newSession(owner, '只属于这个作用域');
  await settledRound(owner, sessionId, '私有内容', '私有回复。');

  expectProblem(await api.get(exportUrl(other, sessionId)), 404, 'RESOURCE_NOT_FOUND');
  expectProblem(await api.get(exportUrl(owner, randomUUID())), 404, 'RESOURCE_NOT_FOUND');
  const unauthorised = await api.get(exportUrl(owner, sessionId),
    { headers: { authorization: 'Bearer wrong' } });
  assert.equal(unauthorised.status, 401, unauthorised.text);

  const own = await exportSession(owner, sessionId);
  assert.equal(own.messages.length, 2, '拒绝跨作用域不等于拒绝本作用域');
});

test('EX-09 凭据脱敏：结构化字段命中即替换，正文与非凭据列不受影响', async () => {
  const workspaceId = await newWorkspace('redaction');
  const sessionId = await newSession(workspaceId, '带凭据形状的会话');
  const round = await settledRound(workspaceId, sessionId,
    '我的密钥是 sk-abcdefgh12345678，别读错目录', '按你说的路径读过了。');
  const repository = new SessionToolCallRepository(app.db);
  const leakedArgs = await recordCall(sessionId, round.assistantId, 0, 0, 'web_fetch', {
    url: 'https://example.com/cb?access_token=supersecretvalue123',
    api_key: 'sk-liveABCDEFGHIJKLMNOP',
    headers: { Authorization: 'Bearer abcdefghijklmnop1234' },
    timeout_ms: 5000,
  });
  await repository.reject(leakedArgs, 'POLICY_DENIED', '接入配置里 password=hunter2neverreveal 不能带进导出');
  const usage = await recordCall(sessionId, round.assistantId, 0, 1, 'read_file',
    { path: 'README.md', max_tokens: 4000 });
  await repository.settleTodoWrite(usage, 'n/a');

  const doc = await exportSession(workspaceId, sessionId);
  const text = JSON.stringify(doc);

  assert.doesNotMatch(text, /sk-liveABCDEFGHIJKLMNOP/u, '参数里的密钥必须消失');
  assert.doesNotMatch(text, /supersecretvalue123/u, 'URL 查询参数里的令牌必须消失');
  assert.doesNotMatch(text, /hunter2neverreveal/u, '拒绝说明里的赋值凭据必须消失');
  assert.doesNotMatch(text, /Bearer abcdefghijklmnop1234/u, '头部 Bearer 令牌必须消失');
  assert.ok(doc.privacy.redacted_key_fields >= 2, 'api_key 与 Authorization 都是键名命中');
  assert.ok(doc.privacy.redacted_value_fields >= 2, 'URL 参数与赋值凭据都是值形态命中');

  const calls = doc.tool_calls[0].rounds.flatMap((call: any) => call.calls ?? [call]);
  const fetch = calls.find((call: any) => call.tool_name === 'web_fetch');
  assert.equal(fetch.arguments.url, 'https://example.com/cb?access_token=[REDACTED:credential]',
    '替换值不毁掉结构：参数键与 URL 主干仍在，读的人知道哪里被动过');
  assert.equal(fetch.arguments.timeout_ms, 5000, '非凭据字段原样保留');
  assert.equal(fetch.rejection_detail, '接入配置里 password=[REDACTED:credential] 不能带进导出');
  const read = calls.find((call: any) => call.tool_name === 'read_file');
  assert.equal(read.arguments.max_tokens, 4000, '计量列不是凭据，不能被「含 token 就删」误伤');
  assert.equal(doc.messages[0].content, '我的密钥是 sk-abcdefgh12345678，别读错目录',
    '正文按承诺逐字保留，风险由 privacy.message_content 当面声明');
  assert.match(doc.privacy.message_content, /逐字保留/u);
});

test('EX-10 文档结构可被外部工具校验：顶层键固定，大整数走十进制字符串', async () => {
  const workspaceId = await newWorkspace('schema');
  const sessionId = await newSession(workspaceId, '结构校验会话');
  const round = await settledRound(workspaceId, sessionId, '一问', '一答。');
  const seq = (await sql<{ s: string }>`select seq::text as s from assist_messages
    where id = ${round.userId}`.execute(app.db)).rows[0]!.s;
  await seedTodo(workspaceId, sessionId, round.userId, Number(seq));

  const doc = await exportSession(workspaceId, sessionId);

  assert.deepEqual(Object.keys(doc).sort(), [
    'completeness', 'context_usage', 'executions', 'exported_at', 'file_changes', 'format',
    'messages', 'model', 'model_calls', 'operations', 'privacy', 'relay', 'schema_version',
    'scope', 'session', 'snapshot', 'todos', 'tool_calls', 'workspace',
  ]);
  assert.deepEqual(Object.keys(doc.relay).sort(), ['version', 'version_source']);
  assert.equal(doc.relay.version, null, '读不到的版本写 null，不从别处猜一个数冒充');
  assert.equal(doc.relay.version_source, 'NOT_EXPOSED_BY_API');
  assert.equal(doc.todos.snapshot.version, 3);
  assert.equal(doc.todos.snapshot.scope_key, `turn:${round.userId}`);
  assert.deepEqual(doc.todos.snapshot.items.map((item: any) => item.content), ['读现状', '改投影']);
  assert.equal(doc.todos.change_history_exported, false);
  assert.match(doc.todos.note, /没有面向界面的合法读口/u);

  // bigint 必须是十进制字符串：JSON 里出现 number 就意味着精度可能已经丢在传输路上。
  assert.equal(typeof doc.session.revision, 'string');
  assert.match(doc.session.revision, /^\d+$/u);
  assert.equal(typeof doc.messages[0].seq, 'string');
  assert.deepEqual(JSON.parse(JSON.stringify(doc)).format, 'relay-session-export');
});

test('EX-11 导出只读：会话修订、消息、工具账本、清单与回执账本前后完全一致', async () => {
  const workspaceId = await newWorkspace('readonly');
  const sessionId = await newSession(workspaceId, '导出前后不能变');
  const round = await settledRound(workspaceId, sessionId, '读一遍', '读完了。');
  const callId = await recordCall(sessionId, round.assistantId, 0, 0, 'list_directory', { path: '.' });
  const seq = (await sql<{ s: string }>`select seq::text as s from assist_messages
    where id = ${round.userId}`.execute(app.db)).rows[0]!.s;
  await seedTodo(workspaceId, sessionId, round.userId, Number(seq));
  const before = await ledgerSnapshot(sessionId);

  const doc = await exportSession(workspaceId, sessionId);
  const again = await exportSession(workspaceId, sessionId);

  assert.equal(await ledgerSnapshot(sessionId), before,
    '两次导出后，会话与全部相关账本必须逐字段回到原样');
  assert.equal(doc.messages.length, again.messages.length);
  assert.equal(doc.todos.snapshot.version, again.todos.snapshot.version);
  const after = await sql<{ revision: string }>`select revision::text as revision
    from assist_sessions where id = ${sessionId}`.execute(app.db);
  assert.equal(after.rows[0]!.revision, '0', '导出不得推进会话修订');
  const call = await sql<{ status: string }>`select status from session_tool_calls where id = ${callId}`
    .execute(app.db);
  assert.equal(call.rows[0]!.status, 'REQUESTED', '未结算的行不能因为被读过就结算');
});

test('EX-12 代表性会话：动作身份、清单快照与被拒原文各归其位，接入配置、参数与基线正文都不进文件', async () => {
  const workspaceId = await newWorkspace('gateway');
  const projectId = await newProject(workspaceId, '导出的受管目录项目');
  const sessionId = await newSession(workspaceId, '带动作身份的会话');
  const root = await mkdtemp(join(tmpdir(), 'relay-export-it-'));
  roots.push(root);
  await writeFile(join(root, 'README.md'), '# 基线正文不该出现在导出里\n', 'utf8');
  const { resourceId, canonicalRoot } = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: ['FILE_READ'], rootPath: canonicalRoot });
  const connectionId = connection.result.connection_id!;
  const policy = await createGatewayPolicyCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capability: 'FILE_READ', actionType: 'READ_FILE', resourceId,
    decision: 'AUTO', maxPayloadBytes: 262_144 });
  const policyId = policy.result.policy_id!;
  const versions = await sql<{ cv: string; pv: string }>`
    select (select version::text from gateway_connections where id = ${connectionId}) as cv,
      (select active_version::text from gateway_permission_policies where id = ${policyId}) as pv`
    .execute(app.db);
  const connectionVersion = BigInt(versions.rows[0]!.cv);
  const policyVersion = BigInt(versions.rows[0]!.pv);

  const round = await settledRound(workspaceId, sessionId, '读 README', '读完了。');
  const operationId = randomUUID();
  const gateway = createRepositories(app.db).gateway;
  await gateway.insertOperation({
    id: operationId, workspace_id: workspaceId, project_id: projectId, origin: 'ASSISTANT_READ',
    task_id: null, run_id: null, step_id: null, import_job_id: null,
    intent_key: `intent-${operationId}`, connection_id: connectionId,
    connection_version: connectionVersion,
    // 这一列的形状被 0014 的 CHECK 钉死成 `{}` 或 `{root_path}`，塞不进假密钥，
    // 所以「接入配置整列不进导出」只能靠导出的动作对象里没有这个键来判。
    connection_config: { root_path: canonicalRoot },
    policy_id: policyId, policy_version: policyVersion, capability_key: 'FILE_READ',
    action_type: 'READ_FILE', normalized_target: canonicalRoot,
    params_hash: Buffer.alloc(32, 7),
    params: { path: 'README.md', api_key: 'sk-in-operation-params-never-exported' },
    resource_id: resourceId, status: 'SUCCEEDED' });
  const repository = new SessionToolCallRepository(app.db);
  const callId = await recordCall(sessionId, round.assistantId, 0, 0, 'read_file',
    { path: 'README.md' });
  const attached = await repository.attachOperation(callId, operationId, 'ASSISTANT_READ');
  assert.ok(attached, '动作身份走真实绑定入口');
  await repository.settle(callId, JSON.stringify({ ok: true, bytes: 30 }));

  /**
   * UNKNOWN 的一行必须有动作身份（0060 的 `ck_session_tool_calls_operation`），因此这一态
   * 只能长在有真实 Operation 的本用例里：派发后结果不明，身份不能清空，导出要照实写清状态。
   */
  const unknownOperationId = randomUUID();
  await gateway.insertOperation({
    id: unknownOperationId, workspace_id: workspaceId, project_id: projectId,
    origin: 'ASSISTANT_READ', task_id: null, run_id: null, step_id: null, import_job_id: null,
    intent_key: `intent-${unknownOperationId}`, connection_id: connectionId,
    connection_version: connectionVersion, connection_config: { root_path: canonicalRoot },
    policy_id: policyId, policy_version: policyVersion, capability_key: 'FILE_READ',
    action_type: 'READ_FILE', normalized_target: canonicalRoot,
    params_hash: Buffer.alloc(32, 9), params: { path: 'docs' },
    resource_id: resourceId, status: 'UNKNOWN' });
  const unknownCallId = await recordCall(sessionId, round.assistantId, 0, 1, 'list_directory',
    { path: 'docs' });
  assert.ok(await repository.attachOperation(unknownCallId, unknownOperationId, 'ASSISTANT_READ'));
  assert.ok(await repository.markUnknown(unknownCallId), 'UNKNOWN 走真实的状态推进入口');

  /**
   * 被拒的一行带凭据形状的参数：这一态在样例文件里必须同时演示两件事——拒绝原因原文可追，
   * 参数里的凭据形态被替换而不是整条消失（替换值仍读得出被动过哪里）。
   */
  const rejectedCallId = await recordCall(sessionId, round.assistantId, 0, 2, 'web_fetch', {
    url: 'https://example.com/pull?access_token=sampletokenvalue123',
    api_key: 'sk-sampleKeyNeverExported', timeout_ms: 5000 });
  await repository.reject(rejectedCallId, 'POLICY_DENIED',
    '接入配置里 password=samplepassword123 不允许进入导出');

  // 清单快照也挂上：验收样例要是一份五段证据同时齐全的会话，而不是每条各证一段。
  const userSeq = (await sql<{ s: string }>`select seq::text as s from assist_messages
    where id = ${round.userId}`.execute(app.db)).rows[0]!.s;
  await seedTodo(workspaceId, sessionId, round.userId, Number(userSeq));

  await sql`update assist_sessions set working_resource_id = ${resourceId},
    working_directory_source = 'USER_PICKED' where id = ${sessionId}`.execute(app.db);
  await sql`insert into conversation_diff_baselines (workspace_id, session_id, resource_id,
      root_path, files, incomplete, capture_reason)
    values (${workspaceId}, ${sessionId}, ${resourceId}, ${canonicalRoot},
      ${JSON.stringify([{ path: 'README.md', sha256: 'a'.repeat(64), size_bytes: 30,
        text: '基线正文：这一段的每一个字都不该出现在导出文件里', line_count: 1,
        unavailable_reason: null }])}::jsonb, false, '完整快照')`.execute(app.db);

  const doc = await exportSession(workspaceId, sessionId);
  const text = JSON.stringify(doc);

  assert.equal(doc.operations.length, 2);
  const operation = doc.operations.find((item: any) => item.id === operationId);
  assert.equal(operation.origin, 'ASSISTANT_READ');
  assert.equal(operation.status, 'SUCCEEDED');
  assert.equal(operation.resource_id, resourceId);
  assert.deepEqual(Object.keys(operation).sort(), ['action_type', 'capability_key', 'created_at',
    'id', 'normalized_target', 'origin', 'params_sha256', 'resource_id', 'result_ref', 'run_id',
    'status', 'task_id', 'updated_at']);
  assert.match(operation.params_sha256, /^[0-9a-f]{64}$/u);
  const group = doc.tool_calls[0].rounds.flatMap((entry: any) => entry.calls);
  assert.equal(group.length, 3);
  assert.equal(group[0].status, 'SETTLED');
  assert.equal(group[0].operation_id, operationId);
  // 账本把结算摘要存成 text，导出就照原样交出去：替它解析成对象等于替读者猜结构。
  assert.equal(group[0].result_digest, '{"ok":true,"bytes":30}');
  assert.equal(group[1].status, 'UNKNOWN', '派发后结果不明不能写成已结算，也不能写成被拒');
  assert.equal(group[1].operation_id, unknownOperationId, 'UNKNOWN 必须留着动作身份供事后核对');
  assert.equal(group[1].settled_at, null, '没有结算时刻就是没有，不能拿核对时刻冒充');
  const rejected = group[2];
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.rejection_reason, 'POLICY_DENIED');
  assert.equal(rejected.operation_id, null, '被拒的请求没有派出去，也就没有动作身份');
  assert.match(rejected.rejection_detail, /password=\[REDACTED:credential\]/u,
    '拒绝原因原样可追，只在凭据形态上打替换标记');
  // 替换是就地打的：参数键、URL 主干与非凭据字段都还在，读的人知道哪里被动过。
  assert.equal(rejected.arguments.api_key, '[REDACTED:credential]', '键名命中的凭据换成标记');
  assert.equal(rejected.arguments.url, 'https://example.com/pull?access_token=[REDACTED:credential]',
    'URL 只摘掉查询参数里的令牌值');
  assert.equal(rejected.arguments.timeout_ms, 5000, '计量字段不是凭据，原样保留');

  assert.equal(doc.todos.snapshot.version, 3);
  assert.deepEqual(doc.todos.snapshot.items.map((item: any) => item.status),
    ['completed', 'in_progress']);
  assert.equal(doc.todos.change_history_exported, false,
    '没有合法读口就只交当前快照，不假装导出了清单的变更历史');

  assert.ok(doc.privacy.redacted_key_fields >= 1, 'api_key 这一处键名命中要计入脱敏统计');
  assert.ok(doc.privacy.redacted_value_fields >= 2, 'URL 令牌与赋值凭据都是值形态命中');
  assert.doesNotMatch(text, /sk-sampleKeyNeverExported/u, '参数里的密钥必须消失');
  assert.doesNotMatch(text, /sampletokenvalue123/u, 'URL 查询参数里的令牌必须消失');
  assert.doesNotMatch(text, /samplepassword123/u, '拒绝说明里的赋值凭据必须消失');

  assert.equal(doc.file_changes.available, true);
  assert.equal(doc.file_changes.resource_id, resourceId);
  assert.equal(doc.file_changes.baseline.file_count, 1);
  assert.equal(doc.file_changes.baseline.capture_reason, '完整快照');
  assert.equal(doc.file_changes.written_paths.length, 0, '没有落盘变更集就不该编出路径');

  assert.doesNotMatch(text, /sk-in-operation-params-never-exported/u,
    '动作参数整列不进导出：即使里面直接写着密钥也不该出现');
  assert.doesNotMatch(text, /"connection_config"/u, '接入配置不进导出，端点与接入参数都不属于诊断文件');
  assert.doesNotMatch(text, /基线正文/u, '基线只交计数与身份，前像正文不搬');
  assert.doesNotMatch(text, /"params":/u, '动作参数不进导出，身份由 params_sha256 核对');

  /**
   * 验收样例（任务书 §八）：只有跑集成时显式给了落盘路径才写文件，平时跑回归不在工作树里留残件。
   * 落的就是这一发从真实 PostgreSQL 读回来的同一份 HTTP 正文——不二次加工、不补内容；
   * 里面的密钥、令牌与赋值凭据已经被产品自己的脱敏换成 `[REDACTED:credential]`。
   */
  const samplePath = process.env['RELAY_EXPORT_SAMPLE'];
  if (samplePath !== undefined) {
    await writeFile(samplePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }
});
