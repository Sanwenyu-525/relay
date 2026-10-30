import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { SessionTodoRepository } from '../../src/assist/session-todo-repository.js';
import { TodoRequestRejected } from '../../src/assist/session-todos.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { settleTodoWriteCall } from '../../src/application/session-todo-tool.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

/**
 * 会话级待办清单的真实 PostgreSQL 验收（ADR-038，2026-10-30）。
 *
 * 这里只验证持久化层能兑现的四件事：版本递增、调用幂等、并发不覆盖、会话隔离，
 * 以及只读投影不泄露别的会话。模型是否真会调用工具不在本文件范围。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-session-todos');

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

async function seedSession(db: typeof app.db, workspaceId: string): Promise<string> {
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const repo = (await import('../../src/application/unit-of-work.js')).createRepositories(db);
  // 同一测试里可能建两个会话：workspace 只能建一次。
  const existing = await sql`select 1 as ok from workspaces where id = ${workspaceId}`.execute(db);
  if (existing.rows.length === 0) {
    await repo.workspaces.insertWorkspace({ id: workspaceId, name: `todo-${workspaceId.slice(0, 6)}` });
    await repo.workspaces.insertAuthorityRow(workspaceId);
  }
  await repo.projects.insertProject({ id: projectId, workspaceId, title: 'todo', projectType: 'GENERAL' });
  await repo.projects.insertProjectState(projectId, 'PLANNING');
  await repo.assist.insertSession({ id: sessionId, workspaceId, projectId, taskId: null, title: '待办验收' });
  return sessionId;
}

function write(sessionId: string, workspaceId: string, toolCallId: string,
  items: unknown, expectedVersion?: number) {
  return new SessionTodoRepository(app.db).write({ sessionId, workspaceId, toolCallId,
    messageId: randomUUID(), items, expectedVersion });
}

async function eventCount(sessionId: string): Promise<number> {
  const rows = (await sql<{ count: string }>`select count(*)::text as count
    from assist_session_todo_events where session_id = ${sessionId}`.execute(app.db)).rows;
  return Number(rows[0]?.count ?? '0');
}

test('TL-01 首次写入：版本 1、稳定 id、快照可读', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const first = await write(sessionId, workspaceId, randomUUID(), [
    { content: '读取执行契约', status: 'completed' },
    { content: '实现 todo_write', status: 'in_progress' },
  ]);
  assert.equal(first.outcome, 'APPLIED');
  assert.equal(first.snapshot.version, 1);
  assert.equal(first.snapshot.items.length, 2);
  assert.ok(first.snapshot.items.every((item) => item.id.length > 0));
  const read = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(read?.version, 1);
  assert.deepEqual(read?.items.map((item) => item.status), ['completed', 'in_progress']);
});

test('TL-02 同一调用重放：幂等，不递增版本、不新写事件', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const toolCallId = randomUUID();
  const items = [{ content: 'A', status: 'pending' }];
  await write(sessionId, workspaceId, toolCallId, items);
  const replay = await write(sessionId, workspaceId, toolCallId, items);
  assert.equal(replay.outcome, 'IDEMPOTENT');
  assert.equal(replay.snapshot.version, 1);
  assert.equal(await eventCount(sessionId), 1);
});

test('TL-03 版本 CAS：基于旧版本提交被拒，不覆盖新快照', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await write(sessionId, workspaceId, randomUUID(), [{ content: 'A', status: 'pending' }]);
  await assert.rejects(
    () => write(sessionId, workspaceId, randomUUID(), [{ content: 'B', status: 'pending' }], 5),
    (error: unknown) => error instanceof TodoRequestRejected && error.reason === 'TODO_VERSION_CONFLICT');
  assert.equal((await new SessionTodoRepository(app.db).read(sessionId))?.version, 1);
});

test('TL-04 并发写入：版本锁住后只有一版落地', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await write(sessionId, workspaceId, randomUUID(), [{ content: 'A', status: 'pending' }]);
  const results = await Promise.allSettled([
    write(sessionId, workspaceId, randomUUID(), [{ content: 'B', status: 'pending' }], 1),
    write(sessionId, workspaceId, randomUUID(), [{ content: 'C', status: 'pending' }], 1),
  ]);
  const applied = results.filter((result) => result.status === 'fulfilled').length;
  const rejected = results.filter((result) => result.status === 'rejected'
    && (result.reason as TodoRequestRejected).reason === 'TODO_VERSION_CONFLICT').length;
  assert.equal(applied + rejected, 2);
  assert.ok(applied >= 1, '至少一版必须落地');
  const snapshot = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(snapshot?.version, 1 + applied);
  assert.equal(await eventCount(sessionId), 1 + applied);
});

test('TL-05 会话隔离：另一个会话从版本 1 开始', async () => {
  const workspaceId = randomUUID();
  const a = await seedSession(app.db, workspaceId);
  const b = await seedSession(app.db, workspaceId);
  await write(a, workspaceId, randomUUID(), [{ content: 'A', status: 'pending' }]);
  const second = await write(b, workspaceId, randomUUID(), [{ content: 'B', status: 'pending' }]);
  assert.equal(second.snapshot.version, 1);
  assert.notEqual(second.snapshot.items[0]?.content, 'A');
});

test('TL-06 并行上限：默认 1，调宽后允许 2 项进行中', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await assert.rejects(
    () => write(sessionId, workspaceId, randomUUID(), [
      { content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }]),
    (error: unknown) => error instanceof TodoRequestRejected && error.reason === 'TODO_IN_PROGRESS_LIMIT');
  await sql`update assist_sessions set todo_parallel_limit = 2 where id = ${sessionId}`.execute(app.db);
  const ok = await write(sessionId, workspaceId, randomUUID(), [
    { content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }]);
  assert.equal(ok.outcome, 'APPLIED');
  assert.equal(ok.snapshot.inProgressLimit, 2);
});

test('TL-07 HTTP 投影：有快照返回版本，无快照返回 null', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const api = await startTestApi();
  try {
    const empty = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/todos`));
    assert.equal(empty.status, 200);
    assert.equal((empty.body as { snapshot: unknown }).snapshot, null);
    await write(sessionId, workspaceId, randomUUID(), [{ content: 'A', status: 'in_progress' }]);
    const filled = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/todos`));
    assert.equal(filled.status, 200);
    const snapshot = (filled.body as { snapshot: { version: number; inProgressLimit: number;
      items: { content: string; status: string }[] } }).snapshot;
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.inProgressLimit, 1);
    assert.deepEqual(snapshot.items.map((item) => item.content), ['A']);
  } finally {
    await api.stop();
  }
});
async function insertMessage(sessionId: string, seq: bigint,
  role: 'USER' | 'ASSISTANT'): Promise<string> {
  const id = randomUUID();
  await createRepositories(app.db).assist.insertMessage({ id, sessionId, seq, role,
    status: 'COMPLETED', intent: 'DISCUSS',
    content: role === 'USER' ? '开始干活' : '收到', sources: [] });
  return id;
}

function writeInTurn(sessionId: string, workspaceId: string, messageId: string,
  toolCallId: string, items: unknown, expectedVersion?: number) {
  return new SessionTodoRepository(app.db).write({ sessionId, workspaceId, toolCallId,
    messageId, items, expectedVersion });
}

test('TL-08 跨 Workspace 读取：与 readAssistSession 同一口径，404 且不带清单', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await write(sessionId, workspaceId, randomUUID(), [{ content: 'A', status: 'pending' }]);
  const api = await startTestApi();
  try {
    const denied = await api.get(workspacePath(randomUUID(),
      `/assist-sessions/${sessionId}/todos`));
    assert.equal(denied.status, 404);
    assert.equal((denied.body as { snapshot?: unknown }).snapshot, undefined);
    const missing = await api.get(workspacePath(workspaceId,
      `/assist-sessions/${randomUUID()}/todos`));
    assert.equal(missing.status, 404);
  } finally { await api.stop(); }
});

test('TL-09 历史调用重放：返回它当初写下的那一版，不推进版本、不新写事件', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const firstCall = randomUUID();
  await write(sessionId, workspaceId, firstCall, [{ content: 'A', status: 'pending' }]);
  await write(sessionId, workspaceId, randomUUID(), [{ content: 'A', status: 'completed' }], 1);
  const replay = await write(sessionId, workspaceId, firstCall, [{ content: 'A', status: 'pending' }]);
  assert.equal(replay.outcome, 'IDEMPOTENT');
  assert.equal(replay.snapshot.version, 1);
  assert.deepEqual(replay.snapshot.items.map((item) => item.status), ['pending']);
  assert.equal(await eventCount(sessionId), 2);
  assert.equal((await new SessionTodoRepository(app.db).read(sessionId))?.version, 2);
});

test('TL-10 同身份异载荷：明确拒绝，不产生重复版本也不诱发唯一约束异常', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const call = randomUUID();
  await write(sessionId, workspaceId, call, [{ content: 'A', status: 'pending' }]);
  await assert.rejects(
    () => write(sessionId, workspaceId, call, [{ content: 'B', status: 'pending' }]),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_TOOL_CALL_CONFLICT');
  assert.equal(await eventCount(sessionId), 1);
  const snapshot = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(snapshot?.version, 1);
  assert.equal(snapshot?.items[0]?.content, 'A');
});

test('TL-11 expected_version 必填：首次基线 0，后续缺省或旧版本都拒绝', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const first = await write(sessionId, workspaceId, randomUUID(),
    [{ content: 'A', status: 'pending' }], 0);
  assert.equal(first.snapshot.version, 1);
  await assert.rejects(
    () => write(sessionId, workspaceId, randomUUID(), [{ content: 'B', status: 'pending' }]),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_VERSION_REQUIRED');
  await assert.rejects(
    () => write(sessionId, workspaceId, randomUUID(), [{ content: 'B', status: 'pending' }], 0),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_VERSION_CONFLICT');
  const second = await write(sessionId, workspaceId, randomUUID(),
    [{ content: 'B', status: 'completed' }], 1);
  assert.equal(second.snapshot.version, 2);
});

test('TL-12 故障窗口：快照已提交、工具未结算就退出，恢复结算不重写也不给错结论', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await insertMessage(sessionId, 1n, 'USER');
  const assistantMessageId = await insertMessage(sessionId, 2n, 'ASSISTANT');
  const calls = new SessionToolCallRepository(app.db);
  const argumentsValue = { items: [{ content: 'A', status: 'in_progress' }], expected_version: 0 };
  const row = await calls.insert({ id: randomUUID(), sessionId, messageId: assistantMessageId,
    round: 1, ordinal: 1, toolName: 'todo_write', arguments: argumentsValue,
    argumentsSha256: 'a'.repeat(64), providerToolCallId: 'provider-call-1' });
  // 进程在快照提交后、工具结算前退出：这里只做写入，不结算。
  const committed = await new SessionTodoRepository(app.db).write({ sessionId, workspaceId,
    messageId: assistantMessageId, toolCallId: row.id, items: argumentsValue.items,
    expectedVersion: 0 });
  assert.equal(committed.snapshot.version, 1);
  const pendingRow = await calls.read(row.id);
  assert.equal(pendingRow?.status, 'REQUESTED');

  const session = await createRepositories(app.db).assist.readSession(sessionId);
  const message = await createRepositories(app.db).assist.readMessage(assistantMessageId);
  assert.ok(session !== undefined && message !== undefined);
  const settled = await settleTodoWriteCall(app.db, { session: session!, message: message!,
    row: pendingRow!, repository: calls,
    call: { providerToolCallId: 'provider-call-1', name: 'todo_write', arguments: argumentsValue } });
  assert.equal(settled.isError, false);
  const payload = JSON.parse(settled.content) as { version: number };
  assert.equal(payload.version, 1, '恢复后返回的仍是当初那一版');
  assert.equal(await eventCount(sessionId), 1);
  assert.equal((await calls.read(row.id))?.status, 'SETTLED');
  assert.equal((await new SessionTodoRepository(app.db).read(sessionId))?.version, 1);
});

test('TL-13 工作轮次隔离：新任务不继承旧清单，版本从 1 重新开始', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const firstUser = await insertMessage(sessionId, 1n, 'USER');
  const firstAssistant = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, firstAssistant, randomUUID(),
    [{ content: '任务 A', status: 'completed' }], 0);
  // 用户在同一会话里又提了另一件事：新轮次的清单从空开始。
  const secondUser = await insertMessage(sessionId, 3n, 'USER');
  const repo = new SessionTodoRepository(app.db);
  assert.equal(await repo.read(sessionId), undefined);
  assert.equal(await repo.readContextBlock(sessionId), '');
  const secondAssistant = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const next = await writeInTurn(sessionId, workspaceId, secondAssistant, randomUUID(),
    [{ content: '任务 B', status: 'in_progress' }], 0);
  assert.equal(next.snapshot.version, 1);
  assert.equal(next.snapshot.scopeKey, `turn:${secondUser}`);
  assert.deepEqual(next.snapshot.items.map((item) => item.content), ['任务 B']);
  // 快照行只代表当前轮次：旧轮次的投影不再对外可见，它的历史在事件表里。
  assert.equal(await repo.read(sessionId, `turn:${firstUser}`), undefined);
  assert.equal(await repo.read(sessionId, `turn:${secondUser}`) !== undefined, true);
});