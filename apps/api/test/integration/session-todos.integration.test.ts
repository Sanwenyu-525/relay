import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { SessionTodoRepository } from '../../src/assist/session-todo-repository.js';
import { TodoRequestRejected } from '../../src/assist/session-todos.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { settleTodoWriteCall, reconcileTodoWriteSettlements, TodoSettlementIncomplete } from
  '../../src/application/session-todo-tool.js';
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
  role: 'USER' | 'ASSISTANT', content?: string): Promise<string> {
  const id = randomUUID();
  await createRepositories(app.db).assist.insertMessage({ id, sessionId, seq, role,
    status: 'COMPLETED', intent: 'DISCUSS',
    content: content ?? (role === 'USER' ? '开始干活' : '收到'), sources: [] });
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
    // 正向对照：同一路由对本 Workspace 正常返回 200。这一条让后面的 404 不能被误读成「路由没注册」。
    const visible = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/todos`));
    assert.equal(visible.status, 200);
    assert.equal((visible.body as { snapshot?: { version?: number } }).snapshot?.version, 1);

    const denied = await api.get(workspacePath(randomUUID(),
      `/assist-sessions/${sessionId}/todos`));
    assert.equal(denied.status, 404);
    assert.equal((denied.body as { snapshot?: unknown }).snapshot, undefined);
    // 路由存在、是归属检查拒绝：Problem Details 必须带 RESOURCE_NOT_FOUND，而不是 Fastify 的裸 404。
    assert.match(String(denied.headers['content-type']), /application\/problem\+json/u);
    const problem = denied.body as { code?: string; status?: number; detail?: string; title?: string };
    assert.equal(problem.status, 404);
    assert.equal(problem.code, 'RESOURCE_NOT_FOUND');
    assert.match(problem.detail ?? '', /Assist session/u);

    const missing = await api.get(workspacePath(workspaceId,
      `/assist-sessions/${randomUUID()}/todos`));
    assert.equal(missing.status, 404);
    assert.equal((missing.body as { code?: string }).code, 'RESOURCE_NOT_FOUND');
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
  // 用户在同一会话里又提了另一件事：**明确声明**换任务才开新轮次（第六轮起延续是默认，
  // 未声明就延续当前工作），新轮次的清单从空开始。
  const secondUser = await insertMessage(sessionId, 3n, 'USER', '新任务：整理发布说明');
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
test('TL-21 A→B→A 迟到写入：旧轮次不得改写当前快照，旧调用重放仍返历史回执', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  const callA = randomUUID();
  await writeInTurn(sessionId, workspaceId, a1, callA,
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '新任务：另一件事');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 B 第一步', status: 'in_progress' }], 0);

  // A 轮的写入在 B 轮之后才到：必须被轮次顺序闸门拦下。
  await assert.rejects(
    () => writeInTurn(sessionId, workspaceId, a1, randomUUID(),
      [{ content: '任务 A 第二步', status: 'completed' }], 2),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_SCOPE_STALE');
  const current = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(current?.scopeKey, `turn:${u2}`);
  assert.deepEqual(current?.items.map((item) => item.content), ['任务 B 第一步']);

  // 旧调用原身份重放：返回它当初那一版，不改变当前投影。
  const replay = await writeInTurn(sessionId, workspaceId, a1, callA,
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  assert.equal(replay.outcome, 'IDEMPOTENT');
  assert.equal(replay.snapshot.version, 1);
  assert.equal(replay.snapshot.scopeKey, `turn:${u1}`);
  const stillB = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(stillB?.scopeKey, `turn:${u2}`);
  assert.equal(stillB?.version, 1);
});

test('TL-22 不同轮次相同版本：各自 v1 共存于事件表，快照只留顺序靠后的那一轮', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: 'A', status: 'completed' }], 0);
  // 第六轮起「延续」是默认，两轮各自 v1 的前提是用户明确声明换任务。
  const u2 = await insertMessage(sessionId, 3n, 'USER', '新任务：换一件');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const second = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: 'B', status: 'pending' }], 0);
  assert.equal(second.snapshot.version, 1);
  assert.equal(second.snapshot.scopeKey, `turn:${u2}`);
  assert.equal(await eventCount(sessionId), 2, '两轮各自一条 v1 事件，不撞唯一约束');
});

test('TL-23 并发切换：旧轮次与新轮次同时写，最终快照属于新轮次', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: 'A 进行中', status: 'in_progress' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '新任务：换一件');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const results = await Promise.allSettled([
    writeInTurn(sessionId, workspaceId, a1, randomUUID(),
      [{ content: 'A 收尾', status: 'completed' }], 1),
    writeInTurn(sessionId, workspaceId, a2, randomUUID(),
      [{ content: 'B 开始', status: 'in_progress' }], 0),
  ]);
  // 两种提交顺序都合法：要么旧轮次先落地再被新轮次覆盖，要么直接被轮次闸门拦下。
  // 但最终快照只能是新轮次。
  const stale = results[0];
  if (stale.status === 'rejected') {
    assert.ok(stale.reason instanceof TodoRequestRejected &&
      stale.reason.reason === 'TODO_SCOPE_STALE');
  }
  const current = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(current?.scopeKey, `turn:${u2}`);
});

test('TL-24 工作连续性：上一轮还有未完成项时，新一句话落在同一作用域', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }], 0);
  // 用户只说“继续”，不是新任务。
  await insertMessage(sessionId, 3n, 'USER');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const continued = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'completed' }], 1);
  assert.equal(continued.outcome, 'APPLIED');
  assert.equal(continued.snapshot.scopeKey, `turn:${u1}`);
  assert.equal(continued.snapshot.version, 2, '延续同一作用域，版本继续递增');
});

test('TL-25 明确新任务：带“新任务：”前缀才开新作用域，版本从 1 开始', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '旧任务第一步', status: 'in_progress' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '新任务：整理发布说明');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const fresh = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '写发布说明', status: 'in_progress' }], 0);
  assert.equal(fresh.snapshot.scopeKey, `turn:${u2}`);
  assert.equal(fresh.snapshot.version, 1);
});

test('TL-26 请求摘要：同一调用换基线版本或换条目身份都算异载荷', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const call = randomUUID();
  const items = [{ content: 'A', status: 'pending' as const }];
  await write(sessionId, workspaceId, call, items);
  // 换 expected_version（首次基线与省略等价，但 3 不是合法基线）：
  await assert.rejects(
    () => write(sessionId, workspaceId, call, items, 3),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_TOOL_CALL_CONFLICT');
  // 换条目身份（带 id 的条目）：
  await assert.rejects(
    () => write(sessionId, workspaceId, call,
      [{ id: 'forged-id', content: 'A', status: 'pending' }]),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_TOOL_CALL_CONFLICT');
  assert.equal(await eventCount(sessionId), 1);
});
test('TL-27 结算不被静默当成完成：已结算同摘要幂等成功，无法结算则显式报错', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await insertMessage(sessionId, 1n, 'USER');
  const assistantMessageId = await insertMessage(sessionId, 2n, 'ASSISTANT');
  const calls = new SessionToolCallRepository(app.db);
  const argumentsValue = { items: [{ content: 'A', status: 'in_progress' }], expected_version: 0 };
  const row = await calls.insert({ id: randomUUID(), sessionId, messageId: assistantMessageId,
    round: 1, ordinal: 1, toolName: 'todo_write', arguments: argumentsValue,
    argumentsSha256: 'b'.repeat(64), providerToolCallId: 'provider-settle-1' });
  const session = await createRepositories(app.db).assist.readSession(sessionId);
  const message = await createRepositories(app.db).assist.readMessage(assistantMessageId);
  assert.ok(session !== undefined && message !== undefined);
  const base = { session: session!, message: message!, repository: calls,
    call: { providerToolCallId: 'provider-settle-1', name: 'todo_write',
      arguments: argumentsValue } };

  const first = await settleTodoWriteCall(app.db, { ...base, row });
  assert.equal(first.isError, false);
  assert.equal((await calls.read(row.id))?.status, 'SETTLED');
  // 同一行再结算一次：已结算且摘要相同，应当幂等成功，而不是把 false 当成功。
  const again = await settleTodoWriteCall(app.db, { ...base, row });
  assert.equal(again.isError, false);
  assert.equal(again.content, first.content);

  // 账本行被放弃（无法结算）：必须显式报错，不能当作已结算。
  const second = await calls.insert({ id: randomUUID(), sessionId, messageId: assistantMessageId,
    round: 1, ordinal: 2, toolName: 'todo_write',
    arguments: { items: [{ content: 'B', status: 'pending' }], expected_version: 1 },
    argumentsSha256: 'c'.repeat(64), providerToolCallId: 'provider-settle-2' });
  // 让这行先被别人用另一份摘要结算掉：本次结算必然拿不到它。
  await calls.settleTodoWrite(second.id, 'd'.repeat(64));
  await assert.rejects(
    () => settleTodoWriteCall(app.db, { session: session!, message: message!, repository: calls,
      row: second,
      call: { providerToolCallId: 'provider-settle-2', name: 'todo_write',
        arguments: { items: [{ content: 'B', status: 'pending' }], expected_version: 1 } } }),
    (error: unknown) => error instanceof Error && error.name === 'TodoSettlementIncomplete');
  assert.equal((await calls.read(second.id))?.status, 'SETTLED');
});

test('TL-28 0150 之前的历史事件：请求没带 id、服务端补了 id 的原载荷重放仍幂等', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const call = randomUUID();
  // 直接落一条 0150 之前形状的历史事件：没有规范化摘要（request_digest IS NULL），
  // items 里是服务端规范化时补上的条目 id——原始请求并没有携带它。
  await sql`insert into assist_session_todo_events
    (id, session_id, workspace_id, scope_key, scope_seq, version, items, tool_call_id,
      message_id, origin_version, request_digest)
    values (${randomUUID()}, ${sessionId}, ${workspaceId}, 'session', 0, 1,
      ${JSON.stringify([{ id: 'server-generated-id', content: 'A', status: 'pending' }])}::jsonb,
      ${call}, ${randomUUID()}, 0, null)`.execute(app.db);
  // 同一份原始载荷（没有 id）重放：不得因服务端生成的 id 被误判成异载荷。
  const replay = await new SessionTodoRepository(app.db).write({ sessionId, workspaceId,
    toolCallId: call, messageId: randomUUID(), scopeKey: 'session',
    items: [{ content: 'A', status: 'pending' }] });
  assert.equal(replay.outcome, 'IDEMPOTENT');
  assert.equal(replay.snapshot.version, 1);
  assert.equal(await eventCount(sessionId), 1);
  // 异载荷仍然拒绝：内容或状态不同就是身份伪造，历史宽限不放宽这一条。
  await assert.rejects(
    () => new SessionTodoRepository(app.db).write({ sessionId, workspaceId,
      toolCallId: call, messageId: randomUUID(), scopeKey: 'session',
      items: [{ content: 'A', status: 'completed' }] }),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_TOOL_CALL_CONFLICT');
});

test('TL-29 账本恢复：快照已提交、账本 REQUESTED 的调用按原身份补结算，不重写不递增', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await insertMessage(sessionId, 1n, 'USER');
  const assistantMessageId = await insertMessage(sessionId, 2n, 'ASSISTANT');
  const calls = new SessionToolCallRepository(app.db);
  const argumentsValue = { items: [{ content: '恢复前的那一步', status: 'in_progress' }],
    expected_version: 0 };
  const row = await calls.insert({ id: randomUUID(), sessionId, messageId: assistantMessageId,
    round: 1, ordinal: 1, toolName: 'todo_write', arguments: argumentsValue,
    argumentsSha256: 'e'.repeat(64), providerToolCallId: 'provider-reconcile-1' });
  // 崩溃窗口：清单写入已提交，账本结算没有发生。
  const committed = await new SessionTodoRepository(app.db).write({ sessionId, workspaceId,
    messageId: assistantMessageId, toolCallId: row.id, items: argumentsValue.items,
    expectedVersion: 0 });
  assert.equal(committed.snapshot.version, 1);
  assert.equal((await calls.read(row.id))?.status, 'REQUESTED');

  // 共享验收库里可能有其他文件遗留的待结算行：恢复是全库扫描，这里只断言本会话的行。
  const first = await reconcileTodoWriteSettlements(app.db);
  assert.ok(first.settled.includes(row.id), '本次崩溃窗口的调用必须被补结算');
  assert.equal((await calls.read(row.id))?.status, 'SETTLED');
  assert.equal(await eventCount(sessionId), 1, '恢复不新增事件');
  assert.equal((await new SessionTodoRepository(app.db).read(sessionId))?.version, 1,
    '恢复不递增版本');

  // 再跑一遍：已结算的行不再出现在扫描里，也不产生任何新写入。
  const second = await reconcileTodoWriteSettlements(app.db);
  assert.equal(second.settled.includes(row.id), false);
  assert.equal(await eventCount(sessionId), 1);
});

test('TL-30 账本恢复的可诊断边界：事件不存在的调用不重跑，异载荷不吞掉', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await insertMessage(sessionId, 1n, 'USER');
  const assistantMessageId = await insertMessage(sessionId, 2n, 'ASSISTANT');
  const calls = new SessionToolCallRepository(app.db);
  // 写入事务从未提交过（事件表查无此调用）：恢复不得重新执行这次写入。
  const neverCommitted = await calls.insert({ id: randomUUID(), sessionId,
    messageId: assistantMessageId, round: 1, ordinal: 1, toolName: 'todo_write',
    arguments: { items: [{ content: '从未提交的写入', status: 'pending' }],
      expected_version: 0 },
    argumentsSha256: 'f'.repeat(64), providerToolCallId: 'provider-reconcile-2' });
  // 已提交事件但账本参数与之冲突（同身份异载荷）：保持 REQUESTED，等人工核对。
  const conflicted = await calls.insert({ id: randomUUID(), sessionId,
    messageId: assistantMessageId, round: 1, ordinal: 2, toolName: 'todo_write',
    arguments: { items: [{ content: '另一份载荷', status: 'pending' }], expected_version: 0 },
    argumentsSha256: '9'.repeat(64), providerToolCallId: 'provider-reconcile-3' });
  await new SessionTodoRepository(app.db).write({ sessionId, workspaceId,
    messageId: assistantMessageId, toolCallId: conflicted.id,
    items: [{ content: '真实写入', status: 'in_progress' }], expectedVersion: 0 });

  const result = await reconcileTodoWriteSettlements(app.db);
  assert.equal(result.settled.includes(neverCommitted.id), false,
    '从未提交的写入不得被恢复执行');
  assert.equal(result.settled.includes(conflicted.id), false, '异载荷调用不得被结算');
  // 第六轮：事件不存在且消息已终止 → 收口成「未执行」，不再永久停在 REQUESTED。
  assert.ok(result.abandoned.includes(neverCommitted.id), '无事件的悬挂行必须给出终态');
  const abandonedRow = await calls.read(neverCommitted.id);
  assert.equal(abandonedRow?.status, 'ABANDONED');
  assert.equal(abandonedRow?.rejection_reason, 'TODO_NOT_EXECUTED');
  assert.equal(abandonedRow?.result_digest, null, '未执行不得带结算结果');
  // 异载荷行仍是 REQUESTED：它确实提交过事件，需要人工核对，不能当没跑过。
  assert.equal((await calls.read(conflicted.id))?.status, 'REQUESTED');
  assert.equal(await eventCount(sessionId), 1, '恢复不替失败生成补写清单');
  assert.equal((await new SessionTodoRepository(app.db).read(sessionId))?.items[0]?.content,
    '真实写入');
});

async function turnBasis(sessionId: string, messageId: string): Promise<string | undefined> {
  const rows = (await sql<{ basis: string }>`select basis from assist_session_todo_turn_scopes
    where session_id = ${sessionId} and message_id = ${messageId}`.execute(app.db)).rows;
  return rows[0]?.basis;
}

test('TL-31 用户插话不切换工作身份：同一轮里插话后的写入仍落在延续的作用域', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  // 用户「继续」开启的轮次：第一次写入按连续性延续 turn:u1，归属就此冻结。
  const u2 = await insertMessage(sessionId, 3n, 'USER', '继续');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const second = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' },
      { content: '任务 A 第二步', status: 'in_progress' }], 1);
  assert.equal(second.snapshot.scopeKey, `turn:${u1}`);
  assert.equal(second.snapshot.version, 2);
  assert.equal(await turnBasis(sessionId, u2), 'CONTINUED_UNFINISHED');

  // 用户在生成进行中插话（seq 更大）：现算口径会把「最新一轮」换成插话消息，
  // 同一轮的第二次写入就被静默切进它自己的新作用域。冻结后必须仍落 turn:u1。
  await insertMessage(sessionId, 5n, 'USER', '这个背景是什么？');
  const third = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' },
      { content: '任务 A 第二步', status: 'in_progress' }], 2);
  assert.equal(third.snapshot.scopeKey, `turn:${u1}`,
    '插话不得改变本轮已冻结的工作身份');
  assert.equal(third.snapshot.version, 3);
  // 读口（界面轮询）此时首次观察插话轮次：清单仍未收尾，插话轮次延续同一作用域，
  // 视图不因为一句话被清空或换掉。
  const current = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(current?.scopeKey, `turn:${u1}`);
  assert.equal(current?.version, 3);
  assert.equal(await turnBasis(sessionId, u2), 'CONTINUED_UNFINISHED');
});

test('TL-32 全部完成后回来纠错：延续同一工作作用域，版本继续递增', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' }], 0);
  // 清单已全部收尾，但用户没有声明换任务：「这里不对」是对同一件工作的纠错，
  // 不是新工作。第六轮之前这里被判成开新作用域，上一份清单因此从注入和界面同时消失。
  const u2 = await insertMessage(sessionId, 3n, 'USER', '这里不对，第二步漏了');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const corrected = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' },
      { content: '任务 A 第二步（补）', status: 'in_progress' }], 1);
  assert.equal(corrected.snapshot.scopeKey, `turn:${u1}`, '纠错属于同一件工作');
  assert.equal(corrected.snapshot.version, 2, '同一作用域内版本继续递增');
  assert.equal(await turnBasis(sessionId, u2), 'CONTINUED_COMPLETED',
    '依据如实记录当时看到的清单状态：已收尾，但延续');
  assert.equal(await turnBasis(sessionId, u1), 'OPENED');
  // 注入给模型的仍是同一份清单：纠错的那一轮不会从「没有待办」开始。
  const injected = await new SessionTodoRepository(app.db).readContextBlock(sessionId, a2);
  assert.match(injected, /任务 A 第二步（补）/u);
  // 事件表保留两版，历史不合并、不覆盖。
  assert.equal(await eventCount(sessionId), 2);
});

test('TL-33 未完成时明确切换独立任务：前缀强制开新作用域并冻结依据', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '新任务：先去办另一件事');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const switched = await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 B 第一步', status: 'in_progress' }], 0);
  assert.equal(switched.snapshot.scopeKey, `turn:${u2}`,
    '上一轮未完成也不延续：用户写明了新任务');
  assert.equal(switched.snapshot.version, 1);
  assert.equal(await turnBasis(sessionId, u2), 'FORCED_NEW_PREFIX');
  assert.equal(await turnBasis(sessionId, u1), 'OPENED');
});

test('TL-34 重启后恢复工作身份：冻结的归属不随清单状态重算', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '继续');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' }], 1);
  // 清单在本轮内全部收尾：此时若按当前状态重算，「最新一轮」会被判成开新作用域。
  // 重启（新仓储实例）后归属必须仍读冻结值，注入与写入的作用域保持一致。
  const restarted = new SessionTodoRepository(app.db);
  assert.equal(await restarted.resolveScopeKey(sessionId, a2), `turn:${u1}`,
    '清单收尾后重算会得到另一个作用域；冻结值必须胜出');
  assert.equal(await restarted.resolveScopeKey(sessionId), `turn:${u1}`);
  assert.equal((await restarted.read(sessionId))?.scopeKey, `turn:${u1}`);
});

test('TL-35 延续语境下的旧轮次迟到写入：冻结归属落回原作用域，被顺序闸门拦下', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '继续');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  const continuationCall = randomUUID();
  await writeInTurn(sessionId, workspaceId, a2, continuationCall,
    [{ content: '任务 A 第一步', status: 'completed' }], 1);
  const u3 = await insertMessage(sessionId, 5n, 'USER', '新任务：换一件事');
  const a3 = await insertMessage(sessionId, 6n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a3, randomUUID(),
    [{ content: '任务 B 第一步', status: 'in_progress' }], 0);

  // 延续轮次（turn:u2 冻结在 turn:u1）的迟到写入：落回原作用域后由顺序闸门拒绝，
  // 不会因为归属被误判成它自己的 turn 键而绕过或错判。
  await assert.rejects(
    () => writeInTurn(sessionId, workspaceId, a2, randomUUID(),
      [{ content: '任务 A 第二步', status: 'pending' }], 2),
    (error: unknown) => error instanceof TodoRequestRejected &&
      error.reason === 'TODO_SCOPE_STALE');
  // 原调用按原身份重放：仍返回它当初那一版，当前投影不动。
  const replay = await writeInTurn(sessionId, workspaceId, a2, continuationCall,
    [{ content: '任务 A 第一步', status: 'completed' }], 1);
  assert.equal(replay.outcome, 'IDEMPOTENT');
  assert.equal(replay.snapshot.version, 2);
  assert.equal(replay.snapshot.scopeKey, `turn:${u1}`);
  const current = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(current?.scopeKey, `turn:${u3}`);
  assert.equal(current?.version, 1);
});
/** 归属表的行数：读取接口是否偷偷写了它，只看这一列就够。 */
async function turnScopeRows(sessionId: string): Promise<readonly { message_id: string;
  scope_key: string; basis: string }[]> {
  return (await sql<{ message_id: string; scope_key: string; basis: string }>`
    select message_id, scope_key, basis from assist_session_todo_turn_scopes
    where session_id = ${sessionId} order by message_id`.execute(app.db)).rows;
}

test('TL-36 GET 不写归属表：反复读取不新增归属行，写入准入才冻结一次', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  const api = await startTestApi();
  try {
    // 归属尚未判定时连读三次：读取接口只给答案，不落库。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api.get(workspacePath(workspaceId,
        `/assist-sessions/${sessionId}/todos`));
      assert.equal(response.status, 200);
      assert.equal((response.body as { snapshot: unknown }).snapshot, null);
    }
    assert.deepEqual(await turnScopeRows(sessionId), [], 'GET 不得写 assist_session_todo_turn_scopes');

    // 执行准入（这里用写入入口代表）才冻结：归属行出现，且只有一行。
    await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
      [{ content: '第一步', status: 'in_progress' }], 0);
    const frozen = await turnScopeRows(sessionId);
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0]?.message_id, u1);
    assert.equal(frozen[0]?.scope_key, `turn:${u1}`);

    // 再读若干次：归属行数量与内容都不再变化，投影照常可读。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api.get(workspacePath(workspaceId,
        `/assist-sessions/${sessionId}/todos`));
      assert.equal(response.status, 200);
      assert.equal((response.body as { snapshot: { version: number } | null })
        .snapshot?.version, 1);
    }
    assert.deepEqual(await turnScopeRows(sessionId), frozen, 'GET 不得改写已冻结的归属');
  } finally { await api.stop(); }
});

test('TL-37 插话后读取仍落在同一归属，且不替插话轮次造归属行', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  // 生成进行中插话：最新一轮变成插话消息，但它还没被任何准入判定过。
  const u2 = await insertMessage(sessionId, 3n, 'USER', '这个背景是什么？');
  const repo = new SessionTodoRepository(app.db);
  // 只读解析与已冻结归属一致（延续未完成清单），并且不落库。
  assert.equal(await repo.resolveScopeKey(sessionId), `turn:${u1}`);
  assert.equal((await repo.read(sessionId))?.version, 1);
  const rows = await turnScopeRows(sessionId);
  assert.deepEqual(rows.map((row) => row.message_id), [u1],
    '读取不得替插话轮次造归属行');
  // 执行准入显式冻结插话轮次：与只读解析得到同一个作用域，不改写已有归属。
  assert.equal(await repo.freezeTurnScope(sessionId, u2), `turn:${u1}`);
  const afterFreeze = await turnScopeRows(sessionId);
  assert.equal(afterFreeze.length, 2);
  assert.equal(afterFreeze.find((row) => row.message_id === u2)?.basis, 'CONTINUED_UNFINISHED');
  assert.equal(afterFreeze.find((row) => row.message_id === u1)?.basis, 'OPENED');
});

test('TL-38 未完成时切换独立任务：声明新任务才开新作用域，读口同步换到新轮次', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  // 未完成 + 明确声明换任务：开新作用域（TL-33 的只读侧对照）。
  const u2 = await insertMessage(sessionId, 3n, 'USER', '新任务：先去办另一件事');
  const repo = new SessionTodoRepository(app.db);
  assert.equal(await repo.resolveScopeKey(sessionId), `turn:${u2}`,
    '明确声明换任务后，读口立刻落在新轮次，旧清单不再对外可见');
  assert.equal(await repo.read(sessionId), undefined);
  assert.deepEqual((await turnScopeRows(sessionId)).map((row) => row.message_id), [u1],
    '只读解析不落库');
  assert.equal(await repo.freezeTurnScope(sessionId, u2), `turn:${u2}`);
  assert.equal((await turnScopeRows(sessionId)).find((row) => row.message_id === u2)?.basis,
    'FORCED_NEW_PREFIX');
});

test('TL-39 重启后读到冻结归属：新仓储实例不重算、不改写', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' }], 0);
  const u2 = await insertMessage(sessionId, 3n, 'USER', '继续');
  const a2 = await insertMessage(sessionId, 4n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a2, randomUUID(),
    [{ content: '任务 A 第一步', status: 'completed' },
      { content: '任务 A 第二步', status: 'completed' }], 1);
  const before = await turnScopeRows(sessionId);
  // 进程重启：新仓储实例 + 幂等冻结不得改写已定案的归属与依据。
  const restarted = new SessionTodoRepository(app.db);
  assert.equal(await restarted.freezeTurnScope(sessionId, u2), `turn:${u1}`);
  assert.equal(await restarted.resolveScopeKey(sessionId), `turn:${u1}`);
  assert.deepEqual(await turnScopeRows(sessionId), before);
});

test('TL-42 消息仍在跑时不做未执行收口：进行中的调用不得被提前判死', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  await insertMessage(sessionId, 1n, 'USER');
  const runningMessageId = randomUUID();
  await createRepositories(app.db).assist.insertMessage({ id: runningMessageId,
    sessionId, seq: 2n, role: 'ASSISTANT', status: 'RUNNING', intent: 'DISCUSS',
    content: null, sources: [] });
  const calls = new SessionToolCallRepository(app.db);
  const inFlight = await calls.insert({ id: randomUUID(), sessionId,
    messageId: runningMessageId, round: 1, ordinal: 1, toolName: 'todo_write',
    arguments: { items: [{ content: '还在途中', status: 'in_progress' }], expected_version: 0 },
    argumentsSha256: 'c'.repeat(64), providerToolCallId: 'provider-running' });

  const result = await reconcileTodoWriteSettlements(app.db);
  assert.equal(result.abandoned.includes(inFlight.id), false);
  assert.equal((await calls.read(inFlight.id))?.status, 'REQUESTED',
    '生成还在跑：可能确实在途中，不能替它下结论');

  // 生成结束（CANCELLED）之后同一行才允许收口。
  await sql`update assist_messages set status = 'CANCELLED' where id = ${runningMessageId}`
    .execute(app.db);
  const after = await reconcileTodoWriteSettlements(app.db);
  assert.ok(after.abandoned.includes(inFlight.id));
  assert.equal((await calls.read(inFlight.id))?.status, 'ABANDONED');
});

test('TL-43 /newtask 前缀：消息准入剥掉命令、强制开新作用域，读口同步换轮次', async () => {
  const workspaceId = randomUUID();
  const sessionId = await seedSession(app.db, workspaceId);
  const u1 = await insertMessage(sessionId, 1n, 'USER');
  const a1 = await insertMessage(sessionId, 2n, 'ASSISTANT');
  await writeInTurn(sessionId, workspaceId, a1, randomUUID(),
    [{ content: '任务 A 第一步', status: 'in_progress' }], 0);
  const api = await startTestApi();
  try {
    // 只有命令没有内容：明确拒绝，而不是把一条空消息发出去。
    const empty = await api.post(workspacePath(workspaceId,
      `/assist-sessions/${sessionId}/messages`), { command_id: randomUUID(), content: '/newtask' });
    assert.equal(empty.status, 422);
    assert.equal(await turnScopeRows(sessionId).then((rows) => rows.length), 1,
      '被拒绝的请求不得留下归属行');

    const posted = await api.post(workspacePath(workspaceId,
      `/assist-sessions/${sessionId}/messages`),
      { command_id: randomUUID(), content: '/newtask 整理发布说明' });
    // 修复前这里会 422（/newtask 不在系统命令表里）：注释写了前缀，但发不出去。
    assert.equal(posted.status, 202);
    const list = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`));
    const users = (list.body as { items: { id: string; role: string; content: string | null }[] })
      .items.filter((item) => item.role === 'USER');
    const last = users[users.length - 1]!;
    assert.equal(last.content, '整理发布说明', '命令不进正文，用户说的话保持原样');
    assert.notEqual(last.id, u1);

    const frozen = (await turnScopeRows(sessionId)).find((row) => row.message_id === last.id);
    assert.equal(frozen?.basis, 'FORCED_NEW_PREFIX', '上一轮未完成也开新作用域');
    assert.equal(frozen?.scope_key, `turn:${last.id}`);
    // 读口立刻不再展示上一轮的清单：新任务不继承旧清单。
    const todos = await api.get(workspacePath(workspaceId,
      `/assist-sessions/${sessionId}/todos`));
    assert.equal(todos.status, 200);
    assert.equal((todos.body as { snapshot: unknown }).snapshot, null);
  } finally { await api.stop(); }
});
