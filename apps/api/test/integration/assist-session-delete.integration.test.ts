import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession } from '../../src/application/assist-commands.js';
import { forkAssistSession } from '../../src/application/assist-session-controls.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import {
  createDataRoot, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 会话物理删除的真实 PostgreSQL 集成（ADR-027、迁移 0116）。
 *
 * 这里取证的是单测覆盖不到的三件事：
 *   * 删除顺序真的能穿过全部 NO ACTION 外键，并把**会话自有**的账本删干净；
 *   * 被别的对象引用时整条拒绝、零删除——保留边界不是文案，是一组真实的 exists 判定；
 *   * 行消失之后幂等仍然有效：同 command_id 重放读的是回执账本，不是那条已经不存在的会话。
 *
 * 不取证：真实模型产生的调用、Windows 窗口、界面观感。删除「不可撤销」是产品口径，
 * 不是可测行为——这里只测「没有恢复命令能把行带回来」这一事实（行与消息确实不存在）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-session-delete-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `session-delete-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title = '待删除的讨论'): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

function post(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
  return api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/delete`), body);
}

async function countOf(
  query: { execute(db: DbExecutor): Promise<{ rows: readonly unknown[] }> },
): Promise<number> {
  const row = (await query.execute(app.db)).rows[0] as { c?: string } | undefined;
  return Number(row?.c ?? '0');
}

/** 播种一条会话自有账本：消息、附件、生成预览、辅助模型调用、模型选择与 diff 基线。 */
async function seedLedger(workspaceId: string, sessionId: string): Promise<{
  readonly messageId: string; readonly attachmentId: string; readonly modelCallId: string }> {
  const messageId = randomUUID();
  const attachmentId = randomUUID();
  const modelCallId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${messageId}, ${sessionId}, 1, 'USER', 'COMPLETED', 'DISCUSS', '删除这一轮')`
    .execute(app.db);
  await sql`insert into assist_message_previews (message_id, preview_text)
    values (${messageId}, '正在生成')`.execute(app.db);
  await withTransaction(app.db, async (repositories) => {
    await repositories.assist.insertAttachment({ id: attachmentId, workspaceId, sessionId,
      name: 'image.png', mediaType: 'image/png', content: Buffer.from([1, 2, 3]),
      contentHash: Buffer.from('11'.repeat(32), 'hex') });
  });
  await sql`insert into model_calls (id, workspace_id, kind, assist_message_id, provider, model,
      config_fingerprint, status)
    values (${modelCallId}, ${workspaceId}, 'ASSIST', ${messageId}, 'test-provider',
      'test-model', ${'0'.repeat(64)}, 'STARTED')`.execute(app.db);
  await sql`insert into session_model_selection (session_id, connection, model, config_fingerprint,
      selected_by_command_id)
    values (${sessionId}, 'default', 'test-model', ${'0'.repeat(64)}, ${randomUUID()})`.execute(app.db);
  await sql`insert into conversation_diff_baselines (workspace_id, session_id, resource_id,
      root_path, files)
    values (${workspaceId}, ${sessionId}, ${randomUUID()}, '/tmp/delete-root', '[]'::jsonb)`
    .execute(app.db);
  return { messageId, attachmentId, modelCallId };
}

test('删除清空会话自有账本：消息、附件、预览、模型计量、选择与 diff 基线全删，会话行消失', async () => {
  const workspaceId = await newWorkspace('ledger');
  const sessionId = await newSession(workspaceId);
  const seeded = await seedLedger(workspaceId, sessionId);
  const commandId = randomUUID();

  const response = await post(workspaceId, sessionId, {
    command_id: commandId, expected_revision: '0' });
  const result = expectCommandAccepted(response, 200, commandId) as
    { session_id: string; revision: string; deleted_messages: number;
      deleted_attachments: number; deleted_at: string };

  assert.equal(result.session_id, sessionId);
  assert.equal(result.revision, '0', '回执里的修订就是删除前核对过的那一版');
  assert.equal(result.deleted_messages, 1);
  assert.equal(result.deleted_attachments, 1);
  assert.match(result.deleted_at, /^\d{4}-\d{2}-\d{2}T/u);

  // 会话行与消息真的不在了，不是软删除标记。
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_previews
    where message_id = ${seeded.messageId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_attachments
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from model_calls
    where id = ${seeded.modelCallId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from session_model_selection
    where session_id = ${sessionId}`), 0);
  // 0097 的 session_id 是普通列，没有外键兜底：必须显式删掉，不能留悬空账本。
  assert.equal(await countOf(sql`select count(*)::text as c from conversation_diff_baselines
    where session_id = ${sessionId}`), 0);

  // 读入口按不可见处理。
  const readBack = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  expectProblem(readBack, 404, 'RESOURCE_NOT_FOUND');

  // activity_records 只增不减：删除命令自身留下唯一痕迹，且不复制正文。
  const audit = (await sql<{ event_type: string; fact_refs: Record<string, unknown> }>`
    select event_type, fact_refs from activity_records
    where command_id = ${commandId}`.execute(app.db)).rows[0];
  assert.equal(audit?.event_type, 'ASSIST_SESSION_DELETED');
  assert.equal(audit?.fact_refs.session_id, sessionId);
  assert.equal(audit?.fact_refs.deleted_messages, 1);
  assert.equal(JSON.stringify(audit?.fact_refs).includes('删除这一轮'), false,
    '审计只记身份与行数，不复制标题或正文');
});

test('行消失之后幂等仍读回执账本：同 command_id 同载荷重放原结果，换载荷 COMMAND_ID_REUSED', async () => {
  const workspaceId = await newWorkspace('replay');
  const sessionId = await newSession(workspaceId);
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_revision: '0' };

  expectCommandAccepted(await post(workspaceId, sessionId, body), 200, commandId);

  const replay = await post(workspaceId, sessionId, body);
  const replayed = expectCommandAccepted(replay, 200, commandId) as { session_id: string };
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.equal(replayed.session_id, sessionId);
  // 回执只有一条，重放没有新增第二发。
  assert.equal(await countOf(sql`select count(*)::text as c from command_receipts
    where command_id = ${commandId}`), 1);

  const reused = await post(workspaceId, sessionId, { command_id: commandId, expected_revision: '1' });
  expectProblem(reused, 409, 'COMMAND_ID_REUSED');
});

test('陈旧基线不删除任何行：409 REVISION_CONFLICT 带出服务端实际修订', async () => {
  const workspaceId = await newWorkspace('stale');
  const sessionId = await newSession(workspaceId);
  await seedLedger(workspaceId, sessionId);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '7' });
  const problem = expectProblem(response, 409, 'REVISION_CONFLICT');
  assert.equal(problem.conflict?.expected_revision, '7');
  assert.equal(problem.conflict?.actual_revision, '0');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages where session_id = ${sessionId}`), 1);
});

test('在途消息挡住删除：整条拒绝、零删除，与归档共用同一道栅栏', async () => {
  const workspaceId = await newWorkspace('inflight');
  const sessionId = await newSession(workspaceId);
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent)
    values (${randomUUID()}, ${sessionId}, 1, 'ASSISTANT', 'RUNNING', 'DISCUSS')`.execute(app.db);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  expectProblem(response, 409, 'INVALID_TRANSITION');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages where session_id = ${sessionId}`), 1);
});

test('被分叉引用时拒绝删除：blocking_reasons 带 FORK_CHILDREN，父子两行都还在', async () => {
  const workspaceId = await newWorkspace('fork');
  const sessionId = await newSession(workspaceId);
  const fork = await forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  const problem = expectProblem(response, 409, 'SESSION_DELETE_BLOCKED');
  assert.deepEqual((problem.conflict as { blocking_reasons: string[] }).blocking_reasons,
    ['FORK_CHILDREN']);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${fork.result.session_id}`), 1);
});

test('有学习记录时拒绝删除：学习记录有自己的删除入口，不能借删会话绕过', async () => {
  const workspaceId = await newWorkspace('learning');
  const sessionId = await newSession(workspaceId);
  await sql`insert into learning_session_controls (session_id, workspace_id)
    values (${sessionId}, ${workspaceId})`.execute(app.db);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  const problem = expectProblem(response, 409, 'SESSION_DELETE_BLOCKED');
  assert.deepEqual((problem.conflict as { blocking_reasons: string[] }).blocking_reasons,
    ['LEARNING_RECORDS']);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
});

test('跨 Workspace 的会话按不可见处理：404 且一行不动', async () => {
  const ownerWorkspace = await newWorkspace('owner');
  const otherWorkspace = await newWorkspace('other');
  const sessionId = await newSession(ownerWorkspace);

  const response = await post(otherWorkspace, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  expectProblem(response, 404, 'RESOURCE_NOT_FOUND');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
});

test('0116 只补会话删除需要的 DELETE 授权：会话表可删，任务表仍不可删', async () => {
  // 迁移账本归 migrator 所有，应用角色不读；迁移是否应用由 migration.integration.test.ts 的
  // 全量清单守（0116 已加入其中）。这里只看权限本身的边界。
  const privileges = (await sql<{ sessions: boolean; tasks: boolean }>`
    select has_table_privilege('relay_app', 'assist_sessions', 'DELETE') as sessions,
      has_table_privilege('relay_app', 'tasks', 'DELETE') as tasks`
    .execute(app.db)).rows[0];
  assert.equal(privileges?.sessions, true);
  assert.equal(privileges?.tasks, false, '授权只覆盖会话自有账本，不外溢到任务');
});

test('删除后无法恢复：不存在能读回消息或会话的只读入口', async () => {
  const workspaceId = await newWorkspace('no-restore');
  const sessionId = await newSession(workspaceId);
  await seedLedger(workspaceId, sessionId);
  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, {
    command_id: commandId, expected_revision: '0' }), 200, commandId);

  for (const path of [`/assist-sessions/${sessionId}`, `/assist-sessions/${sessionId}/messages`]) {
    expectProblem(await api.get(workspacePath(workspaceId, path)), 404, 'RESOURCE_NOT_FOUND');
  }
  const list = await api.get(workspacePath(workspaceId, '/assist-sessions?status=ALL'));
  assert.equal((list.body as { items: readonly unknown[] }).items.length, 0);
});
