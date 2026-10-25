// 禅道 #119 同类遗漏审计（0125 memory_auto_captures）：自动记忆捕获行以 NO ACTION 外键
// 同时引用会话（session_id）与消息（message_id），还指向 workspace 级 memory_items；
// listDeleteBlockers 未覆盖它（MEMORY_SOURCES 只查 0118 的 memory_message_sources），
// deleteSession 也不清理，且 relay_app 没有 memory_auto_captures 的 DELETE 授权。
// 本探针按真实约束播种一条 ACTIVE 捕获终态（memory_items + memory_versions + 捕获行），
// 再走真实 HTTP 删除入口：预期当前实现撞外键 500 INTERNAL_ERROR 且整条回滚。
// 「捕获行该阻断（对齐 MEMORY_SOURCES）还是随会话清理」是设计决策，另开单处理；
// 本探针红转绿时按当时选定的口径改写断言。
// 健康对照：同工作区普通空会话删除 200，证明 500 只来自捕获行外键。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import fs from 'node:fs';
import { sql } from 'kysely';
import { runMigrations } from '../../dist/src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from '../../dist/test/integration/integration-support.js';
import { createWorkspace, startTestApi, workspacePath } from '../../dist/test/integration/api-harness.js';
import { createAssistSession } from '../../dist/src/application/assist-commands.js';

const app = openDatabase(APP_DATABASE_URL, 'triage-auto-capture-session-delete');
let api, wid;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); wid = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
async function session(title) { return (await createAssistSession(app.db, {workspaceId: wid, commandId: randomUUID(), projectId: null, title})).result.session_id; }
async function revisionOf(sessionId) {
  return (await sql`select revision::text as revision from assist_sessions where id = ${sessionId}`.execute(app.db)).rows[0].revision;
}
test('deleting a session that produced an auto memory capture must not fall through to an unhandled FK error', async () => {
  const controlSessionId = await session('plain delete control');
  const control = await api.post(workspacePath(wid, `/assist-sessions/${controlSessionId}/delete`),
    {command_id: randomUUID(), expected_revision: await revisionOf(controlSessionId)});
  assert.equal(control.status, 200, control.text);

  const sid = await session('auto capture source session');
  const messageId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${messageId}, ${sid}, 1, 'USER', 'COMPLETED', 'DISCUSS', '自动提取这条记忆')`.execute(app.db);
  // memory_items.current_version 对 memory_versions 是 DEFERRABLE 延迟外键，而
  // memory_versions.memory_id 又立即引用 memory_items：两行必须同一事务落库。
  const memoryId = randomUUID();
  await app.db.transaction().execute(async (tx) => {
    await sql`insert into memory_items (id, workspace_id, title)
      values (${memoryId}, ${wid}, '自动捕获的记忆')`.execute(tx);
    await sql`insert into memory_versions (id, memory_id, version, title, body_text, confirmed_by,
        confirmed_at)
      values (${randomUUID()}, ${memoryId}, 1, '自动捕获的记忆', '自动捕获的正文', 'user:local', now())`
      .execute(tx);
  });
  await sql`insert into memory_auto_captures (id, workspace_id, session_id, message_id,
      source_sha256, normalized_sha256, memory_id)
    values (${randomUUID()}, ${wid}, ${sid}, ${messageId}, ${'ab'.repeat(32)}, ${'cd'.repeat(32)},
      ${memoryId})`.execute(app.db);

  const response = await api.post(workspacePath(wid, `/assist-sessions/${sid}/delete`),
    {command_id: randomUUID(), expected_revision: await revisionOf(sid)});
  const afterSession = (await sql`select 1 as present from assist_sessions where id = ${sid}`.execute(app.db)).rows[0];
  const afterMessages = (await sql`select count(*)::text as c from assist_messages where session_id = ${sid}`.execute(app.db)).rows[0].c;
  const afterCaptures = (await sql`select count(*)::text as c from memory_auto_captures where session_id = ${sid}`.execute(app.db)).rows[0].c;
  const evidence = {controlStatus: control.status, deleteStatus: response.status, deleteBody: response.body,
    deleteText: response.text, sessionPreserved: !!afterSession, messagesPreserved: afterMessages,
    capturesPreserved: afterCaptures};
  fs.writeFileSync('output/triage-defects-20261022/auto-capture-session-delete-evidence.json', JSON.stringify(evidence, null, 2));
  console.log('TRIAGE_AUTO_CAPTURE_SESSION_DELETE', JSON.stringify(evidence));
  assert.equal(response.status, 500,
    `0125 捕获行的删除外键缺口应如实暴露为 500（当前现状），实际 ${response.status}: ${response.text}`);
  assert.ok(afterSession, '删除事务应整条回滚：会话、消息与捕获行都保留');
  assert.equal(afterMessages, '1');
  assert.equal(afterCaptures, '1');
});
