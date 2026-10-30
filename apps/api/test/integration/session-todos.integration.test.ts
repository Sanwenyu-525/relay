import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { SessionTodoRepository } from '../../src/assist/session-todo-repository.js';
import { TodoRequestRejected } from '../../src/assist/session-todos.js';
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