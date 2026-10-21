import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { readSessionToolCalls, type SessionToolCallProjection }
  from '../../src/application/session-tool-call-projection.js';
import { createWorkspace, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * 会话工具轮次的只读投影与 HTTP 口子（工作台 §18.10「原消息下展示实际阶段」）。
 *
 * `session_tool_calls` 自 0060 起只有写入口：Agent 主流程每轮调了什么工具、是否被拒、
 * 何时结算都只落在库里，界面上因此只剩一个「正在生成」。这里锁四件事——
 * 轮次分组与顺序、参数逐字节透传、跨作用域按不可见处理、读取本身不推进任何一行状态。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-session-tool-calls');
let api: TestApi;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function workspaceFixture(): Promise<{ workspaceId: string; projectId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `rounds-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: '轮次投影项目',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
  });
  return { workspaceId, projectId };
}

/** 建会话并发一条讨论消息，返回那条 ASSISTANT 的身份——工具轮次挂在它下面。 */
async function newAssistantMessage(workspaceId: string, projectId: string, content: string):
Promise<{ sessionId: string; messageId: string }> {
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, taskId: null, title: '轮次投影会话' });
  const sessionId = created.result.session_id;
  const requested = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content, intent: 'DISCUSS' });
  return { sessionId, messageId: requested.result.assistant_message_id };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

async function recordCall(messageId: string, sessionId: string, round: number, ordinal: number,
  toolName: string, args: JsonObject): Promise<string> {
  const row = await new SessionToolCallRepository(app.db).insert({ id: randomUUID(), sessionId,
    messageId, round, ordinal, toolName, arguments: args, argumentsSha256: sha256(args),
    providerToolCallId: `call_${round}_${ordinal}` });
  return row.id;
}

test('按轮次分组、按 ordinal 升序，参数逐字节透传，且不带任何推理字段', async () => {
  const f = await workspaceFixture();
  const m = await newAssistantMessage(f.workspaceId, f.projectId, '看一下这个目录');
  const repository = new SessionToolCallRepository(app.db);
  await recordCall(m.messageId, m.sessionId, 0, 0, 'list_directory', { path: '.', limit: 50 });
  await recordCall(m.messageId, m.sessionId, 0, 1, 'read_file', { path: 'README.md' });
  const rejected = await recordCall(m.messageId, m.sessionId, 1, 0, 'find_paths',
    { pattern: '*.md' });
  // 第二轮里的一次请求在派发前被参数校验拒绝：拒绝原因是界面要显示的事实。
  await repository.reject(rejected, 'INVALID_ARGUMENTS', '缺少必填参数 pattern。');

  const response = await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${m.sessionId}/messages/${m.messageId}/tool-calls`));
  assert.equal(response.status, 200, response.text);
  const body = response.body as SessionToolCallProjection;
  // HTTP 面必须与用例层同形：曾经出现过应用层给 camelCase、schema 只认 snake_case，
  // 于是响应被序列化悄悄丢掉字段——这类缺陷在纯用例层测不出来。
  assert.deepEqual(body, await readSessionToolCalls(app.db, { workspaceId: f.workspaceId,
    sessionId: m.sessionId, messageId: m.messageId }));
  assert.equal(body.session_id, m.sessionId);
  assert.equal(body.message_id, m.messageId);
  assert.equal(body.message_status, 'PENDING');
  assert.deepEqual(body.rounds.map((round) => round.round), [0, 1]);
  assert.deepEqual(body.rounds[0]!.calls.map((call) => [call.ordinal, call.tool_name, call.status]),
    [[0, 'list_directory', 'REQUESTED'], [1, 'read_file', 'REQUESTED']]);
  // 参数不重新序列化、不加摘要字段：界面看到的就是模型当时发出去的那一份。
  assert.deepEqual(body.rounds[0]!.calls[0]!.arguments, { path: '.', limit: 50 });
  assert.equal(body.rounds[1]!.calls[0]!.status, 'REJECTED');
  assert.equal(body.rounds[1]!.calls[0]!.rejection_reason, 'INVALID_ARGUMENTS');
  assert.equal(body.rounds[1]!.calls[0]!.rejection_detail, '缺少必填参数 pattern。');
  assert.match(body.rounds[0]!.calls[0]!.arguments_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(typeof body.rounds[0]!.calls[0]!.requested_at, 'string');
  assert.equal(body.rounds[0]!.calls[0]!.settled_at, null);
  // 字段集合就是契约，不多不少：折叠行的一行摘要在前端现算，投影不新增解释字段，
  // 也不带模型私有推理（现行禁令：推理文本不经工具轨迹口子暴露）。
  assert.deepEqual(Object.keys(body.rounds[0]!.calls[0]!).sort(), [
    'arguments', 'arguments_sha256', 'id', 'operation_id', 'ordinal',
    'provider_tool_call_id', 'rejection_detail', 'rejection_reason', 'requested_at',
    'result_digest', 'round', 'settled_at', 'status', 'tool_name',
  ].sort());
});

test('跨作用域与不属于本会话的消息一律 404；没有工具轮次的消息是空事实不是失败', async () => {
  const f = await workspaceFixture();
  const other = await workspaceFixture();
  const withCalls = await newAssistantMessage(f.workspaceId, f.projectId, '列一下文件');
  await recordCall(withCalls.messageId, withCalls.sessionId, 0, 0, 'list_directory', { path: '.' });
  const quiet = await newAssistantMessage(f.workspaceId, f.projectId, '你好');

  const path = (workspaceId: string, target: { sessionId: string; messageId: string }) =>
    workspacePath(workspaceId,
      `/assist-sessions/${target.sessionId}/messages/${target.messageId}/tool-calls`);

  // 换作用域：会话在那边不存在，按不可见处理，不透露它是否存在于别处。
  const crossWorkspace = await api.get(path(other.workspaceId, withCalls));
  assert.equal(crossWorkspace.status, 404);
  // 换会话：消息身份是真的，但不挂在这条会话下。
  const otherSession = await newAssistantMessage(f.workspaceId, f.projectId, '第三条');
  const crossSession = await api.get(path(f.workspaceId,
    { sessionId: otherSession.sessionId, messageId: withCalls.messageId }));
  assert.equal(crossSession.status, 404);

  const empty = await api.get(path(f.workspaceId, quiet));
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual((empty.body as { rounds: unknown[] }).rounds, []);
});

test('读取不推进账本：REQUESTED 行读过之后仍是 REQUESTED，也不新增行', async () => {
  const f = await workspaceFixture();
  const m = await newAssistantMessage(f.workspaceId, f.projectId, '读 README');
  await recordCall(m.messageId, m.sessionId, 0, 0, 'read_file', { path: 'README.md' });
  const before = (await sql<{ count: string }>`select count(*)::text as count,
    count(*) filter (where status = 'REQUESTED')::text as requested from session_tool_calls
    where message_id = ${m.messageId}`.execute(app.db)).rows[0]!;

  await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${m.sessionId}/messages/${m.messageId}/tool-calls`));

  const after = (await sql<{ count: string }>`select count(*)::text as count,
    count(*) filter (where status = 'REQUESTED')::text as requested from session_tool_calls
    where message_id = ${m.messageId}`.execute(app.db)).rows[0]!;
  assert.deepEqual(after, before);
});
