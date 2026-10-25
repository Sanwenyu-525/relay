// 禅道 #119 同类遗漏审计（0132 撤回账本族）：assist_message_baselines / assist_message_recalls /
// assist_message_recall_files / assist_message_recall_undos 都以 NO ACTION 外键引用会话或消息，
// assist_messages.withdrawn_by_recall_id 还反向引用 recalls；listDeleteBlockers 与 deleteSession
// 均未处理，且 relay_app 对 recalls / recall_files / undos / baseline_files 没有 DELETE 授权。
// 本探针按迁移 0132 的真实约束播种一次已完成的撤回终态，再走真实 HTTP 删除入口：
// 预期当前实现撞外键 500 INTERNAL_ERROR 且整条回滚（修复需要补 DELETE 授权迁移 + 删除顺序，
// 属另开单范围，本探针红转绿时按正式回归口径改写断言）。
// 健康对照：同工作区普通空会话删除 200，证明 500 只来自撤回账本外键。
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

const app = openDatabase(APP_DATABASE_URL, 'triage-recall-session-delete');
let api, wid;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); wid = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
async function session(title) { return (await createAssistSession(app.db, {workspaceId: wid, commandId: randomUUID(), projectId: null, title})).result.session_id; }
async function revisionOf(sessionId) {
  return (await sql`select revision::text as revision from assist_sessions where id = ${sessionId}`.execute(app.db)).rows[0].revision;
}
test('deleting a session whose recall ledger exists must not fall through to an unhandled FK error', async () => {
  const controlSessionId = await session('plain delete control');
  const control = await api.post(workspacePath(wid, `/assist-sessions/${controlSessionId}/delete`),
    {command_id: randomUUID(), expected_revision: await revisionOf(controlSessionId)});
  assert.equal(control.status, 200, control.text);

  const sid = await session('recalled message session');
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${userMessageId}, ${sid}, 1, 'USER', 'COMPLETED', 'DISCUSS', '撤回这一条')`.execute(app.db);
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${assistantMessageId}, ${sid}, 2, 'ASSISTANT', 'COMPLETED', 'DISCUSS', '已回复')`.execute(app.db);
  const baselineId = randomUUID();
  await sql`insert into assist_message_baselines (id, workspace_id, session_id, message_id,
      resource_id, root_path, status)
    values (${baselineId}, ${wid}, ${sid}, ${userMessageId}, ${randomUUID()},
      '/tmp/recall-root', 'COMPLETE')`.execute(app.db);
  const recallId = randomUUID();
  await sql`insert into assist_message_recalls (id, workspace_id, session_id, message_id,
      assistant_message_id, command_id, status, root_path, completed_at)
    values (${recallId}, ${wid}, ${sid}, ${userMessageId}, ${assistantMessageId},
      ${randomUUID()}, 'COMPLETED', '/tmp/recall-root', now())`.execute(app.db);
  await sql`insert into assist_message_recall_files (recall_id, relative_path, baseline_existed,
      baseline_message_id, status)
    values (${recallId}, 'notes/a.md', true, ${userMessageId}, 'PLANNED')`.execute(app.db);
  await sql`insert into assist_message_recall_undos (id, workspace_id, session_id,
      source_recall_id, command_id, status, root_path, completed_at)
    values (${randomUUID()}, ${wid}, ${sid}, ${recallId}, ${randomUUID()}, 'COMPLETED',
      '/tmp/recall-root', now())`.execute(app.db);
  await sql`update assist_messages set withdrawn_at = now(), withdrawn_by_recall_id = ${recallId}
    where id in (${userMessageId}, ${assistantMessageId})`.execute(app.db);

  const response = await api.post(workspacePath(wid, `/assist-sessions/${sid}/delete`),
    {command_id: randomUUID(), expected_revision: await revisionOf(sid)});
  const afterSession = (await sql`select 1 as present from assist_sessions where id = ${sid}`.execute(app.db)).rows[0];
  const afterMessages = (await sql`select count(*)::text as c from assist_messages where session_id = ${sid}`.execute(app.db)).rows[0].c;
  const afterBaselines = (await sql`select count(*)::text as c from assist_message_baselines where session_id = ${sid}`.execute(app.db)).rows[0].c;
  const afterRecalls = (await sql`select count(*)::text as c from assist_message_recalls where session_id = ${sid}`.execute(app.db)).rows[0].c;
  const evidence = {controlStatus: control.status, deleteStatus: response.status, deleteBody: response.body,
    deleteText: response.text, sessionPreserved: !!afterSession, messagesPreserved: afterMessages,
    baselinesPreserved: afterBaselines, recallsPreserved: afterRecalls};
  fs.writeFileSync('output/triage-defects-20261022/recall-session-delete-evidence.json', JSON.stringify(evidence, null, 2));
  console.log('TRIAGE_RECALL_SESSION_DELETE', JSON.stringify(evidence));
  assert.equal(response.status, 500,
    `0132 撤回账本族的删除外键缺口应如实暴露为 500（当前现状），实际 ${response.status}: ${response.text}`);
  assert.ok(afterSession, '删除事务应整条回滚：会话、消息与撤回账本都保留');
  assert.equal(afterMessages, '2');
  assert.equal(afterBaselines, '1');
  assert.equal(afterRecalls, '1');
});
