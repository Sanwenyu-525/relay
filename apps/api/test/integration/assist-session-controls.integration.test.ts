import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import {
  archiveAssistSession,
  reopenAssistSession,
  renameAssistSession,
  setAssistSessionPin,
  setAssistSessionUnread,
} from '../../src/application/assist-session-controls.js';
import { createAssistSession } from '../../src/application/assist-commands.js';
import { DomainError } from '../../src/application/domain-error.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { AssistSessionRow } from '../../src/infrastructure/database-schema.js';
import {
  createDataRoot, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 会话行内控制（改名/置顶/未读/归档/重开）的真实 PostgreSQL 集成（迁移 0090/0104，工作台 §28.9）。
 *
 * 单测只能证明入口栅栏；**依赖真实事务、行锁与 CAS 的保证只能在这里取证**：
 *   * 五条命令各自落库、推进修订，回执资源指向这条会话；
 *   * 同一 `command_id` + 同载荷重放返回原结果、附 `command-replayed`、修订不推进、不新增回执；
 *   * 同一 `command_id` 换载荷被 `COMMAND_ID_REUSED` 挡住，不能靠改内容复用 ID；
 *   * 陈旧 `expected_revision` → 409 并带出服务端实际修订（界面据此重读，绝不自动重发）；
 *   * 跨 Workspace 的会话按不可见处理；归档态拒绝改名/置顶/标记未读；在途消息挡住归档；
 *   * 重复归档/重复重开是无操作，返回当前事实但不推进修订；
 *   * 列表默认只列 ACTIVE，`status=ARCHIVED|ALL` 各得其所，置顶项排在最前且取消置顶写回 NULL。
 * 归档在这里始终等于「隐藏 + 拒收新消息」：消息、提案与命令回执留在原地，重开后照旧读得到。
 * 真实模型、浏览器与 Windows 安装态不在本文件的取证范围内。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-session-controls-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); });

/** 每条用例独占一个 Workspace，名字落到库里，失败时能在库里认出是哪一条场景。 */
async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `session-controls-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

/** 用真实建会话命令播种：0015 的 revision 缺省为 0，第一次行内命令的 CAS 基线就是 0。 */
async function newSession(workspaceId: string, title = '待改名的讨论'): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

async function readRow(sessionId: string): Promise<AssistSessionRow> {
  const row = await createRepositories(app.db).assist.readSession(sessionId);
  assert.ok(row !== undefined, `会话 ${sessionId} 读不回来`);
  return row;
}

async function receiptsFor(commandId: string): Promise<number> {
  const row = (await sql<{ c: string }>`select count(*)::text as c from command_receipts
    where command_id = ${commandId}`.execute(app.db)).rows[0];
  return Number(row?.c ?? '0');
}

async function expectDomainCode(work: () => Promise<unknown>, code: string): Promise<void> {
  try { await work(); } catch (error) {
    if (error instanceof DomainError) { assert.equal(error.code, code); return; }
    throw new Error(`期望抛出的 DomainError ${code}，实际：${String(error)}`);
  }
  throw new Error(`期望抛出的 DomainError ${code} 没有出现`);
}

function post(workspaceId: string, sessionId: string, action: string, body: Record<string, unknown>) {
  return api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/${action}`), body);
}

test('改名落库：新标题成为唯一显示事实，修订推进，回执指向这条会话', async () => {
  const workspaceId = await newWorkspace('rename');
  const sessionId = await newSession(workspaceId, '旧的标题');
  const commandId = randomUUID();

  const response = await post(workspaceId, sessionId, 'title', {
    command_id: commandId, expected_revision: '0', title: '  改过的标题  ' });
  const result = expectCommandAccepted(response, 200, commandId) as
    { session_id: string; title: string; revision: string; updated_at: string };

  assert.equal(result.session_id, sessionId);
  assert.equal(result.title, '改过的标题', '入库标题必须是去空白后的规范化结果');
  assert.equal(result.revision, '1');
  assert.match(result.updated_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal((response.body as { links: { resource: string } }).links.resource,
    `/api/v1/workspaces/${workspaceId}/assist-sessions/${sessionId}`);
  // 改名只改标题：身份、归属、状态与置顶都不许被顺手带走。
  const row = await readRow(sessionId);
  assert.equal(row.title, '改过的标题');
  assert.equal(row.task_id, null);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.pinned_at, null);
});

test('四条命令都服从 revision CAS：同一 command_id 重放不推进修订，陈旧基线 409 带出实际修订', async () => {
  const workspaceId = await newWorkspace('cas');
  const sessionId = await newSession(workspaceId);
  const commandId = randomUUID();

  const first = await post(workspaceId, sessionId, 'pin', {
    command_id: commandId, expected_revision: '0', pinned: true });
  const body = expectCommandAccepted(first, 200, commandId) as
    { session_id: string; pinned: boolean; pinned_at: string; revision: string };
  assert.equal(body.pinned, true);
  assert.equal(body.revision, '1');

  // 同 ID + 同载荷：重放原结果，不新增回执，修订仍停在 1。
  const replay = await post(workspaceId, sessionId, 'pin', {
    command_id: commandId, expected_revision: '0', pinned: true });
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual(replay.body, first.body);
  assert.equal(await receiptsFor(commandId), 1);
  assert.equal((await readRow(sessionId)).revision, 1n);

  // 同 ID 换载荷：不能靠改内容复用一枚命令 ID。
  const reused = await post(workspaceId, sessionId, 'pin', {
    command_id: commandId, expected_revision: '1', pinned: false });
  expectProblem(reused, 409, 'COMMAND_ID_REUSED');

  // 陈旧基线：服务端把实际修订带回来，界面据此重读，不自动重发。
  const stale = await post(workspaceId, sessionId, 'title', {
    command_id: randomUUID(), expected_revision: '0', title: '基于旧版本的改名' });
  const problem = expectProblem(stale, 409, 'REVISION_CONFLICT');
  assert.equal((problem.conflict as Record<string, unknown>).actual_revision, '1');
  assert.equal((await readRow(sessionId)).title, '待改名的讨论');
});

test('归档 → 重开：状态可逆，历史与命令回执留在原地', async () => {
  const workspaceId = await newWorkspace('archive');
  const sessionId = await newSession(workspaceId, '要被归档的讨论');
  await renameAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', title: '归档前改过一次名' });

  const archived = await archiveAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1' });
  assert.equal(archived.result.status, 'ARCHIVED');
  assert.equal(archived.result.revision, '2');

  const row = await readRow(sessionId);
  assert.equal(row.status, 'ARCHIVED');
  // 归档不删行、不抹历史：标题仍是那次改名的结果。
  assert.equal(row.title, '归档前改过一次名');

  const reopened = await reopenAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '2' });
  assert.equal(reopened.result.status, 'ACTIVE');
  assert.equal(reopened.result.revision, '3');
  assert.equal((await readRow(sessionId)).title, '归档前改过一次名');
});

test('重复归档与重复重开是无操作：如实返回当前事实，不推进修订', async () => {
  const workspaceId = await newWorkspace('idempotent-state');
  const sessionId = await newSession(workspaceId);
  await archiveAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0' });

  const again = await archiveAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1' });
  assert.equal(again.replayed, false, '这是新命令，不是重放');
  assert.equal(again.result.status, 'ARCHIVED');
  assert.equal(again.result.revision, '1', '已经是归档态，不该再多推进一次修订');

  const active = await reopenAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1' });
  const stillActive = await reopenAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '2' });
  assert.equal(stillActive.result.status, 'ACTIVE');
  assert.equal(stillActive.result.revision, '2');
  assert.equal(active.result.revision, '2');
});

test('归档态拒绝改名与置顶：INVALID_TRANSITION，且被拒的命令不留回执', async () => {
  const workspaceId = await newWorkspace('archived-gate');
  const sessionId = await newSession(workspaceId);
  await archiveAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0' });

  const renameCommand = randomUUID();
  await expectDomainCode(() => renameAssistSession(app.db, { workspaceId, sessionId,
    commandId: renameCommand, expectedRevision: '1', title: '归档后改名' }), 'INVALID_TRANSITION');
  assert.equal(await receiptsFor(renameCommand), 0, '被业务规则拒掉的改名不该留下回执');

  const pinCommand = randomUUID();
  await expectDomainCode(() => setAssistSessionPin(app.db, { workspaceId, sessionId,
    commandId: pinCommand, expectedRevision: '1', pinned: true }), 'INVALID_TRANSITION');
  assert.equal(await receiptsFor(pinCommand), 0, '被业务规则拒掉的置顶不该留下回执');

  assert.equal((await readRow(sessionId)).status, 'ARCHIVED');
  assert.equal((await readRow(sessionId)).pinned_at, null);
});

test('在途消息挡住归档：消息未结束就不宣称这段讨论已经收口', async () => {
  const workspaceId = await newWorkspace('inflight');
  const sessionId = await newSession(workspaceId);
  await createRepositories(app.db).assist.insertMessage({
    id: randomUUID(), sessionId, seq: 1n, role: 'ASSISTANT', status: 'PENDING',
    intent: 'DISCUSS', content: null, sources: [] });

  const commandId = randomUUID();
  await expectDomainCode(() => archiveAssistSession(app.db, { workspaceId, sessionId,
    commandId, expectedRevision: '0' }), 'INVALID_TRANSITION');
  const row = await readRow(sessionId);
  assert.equal(row.status, 'ACTIVE', '被挡住归档后仍须可读可续');
  assert.equal(row.revision, 0n);
  assert.equal(await receiptsFor(commandId), 0);

  // 在途结束（COMPLETED，且补上回答正文以满足「完成必须有正文」的 CHECK）后归档才成立：
  // 这条拒绝是「等它结束」，不是永久封死。
  await sql`update assist_messages set status = 'COMPLETED', content = '已结束的回答'
    where session_id = ${sessionId}`.execute(app.db);
  const settled = await archiveAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(settled.result.status, 'ARCHIVED');
});

test('跨 Workspace 的会话按不可见处理，且 CAS 落空时不返回“看起来对”的结果', async () => {
  const workspaceA = await newWorkspace('scope-a');
  const workspaceB = await newWorkspace('scope-b');
  const sessionId = await newSession(workspaceA, '只属于 A 的讨论');

  const commandId = randomUUID();
  await expectDomainCode(() => renameAssistSession(app.db, { workspaceId: workspaceB,
    sessionId, commandId, expectedRevision: '0', title: '越权改名' }), 'RESOURCE_NOT_FOUND');
  assert.equal(await receiptsFor(commandId), 0);
  assert.equal((await readRow(sessionId)).title, '只属于 A 的讨论');

  // 仓储层基线不符 → undefined：Owner 会把它转成 REVISION_CONFLICT，绝不返回旧行。
  const repo = createRepositories(app.db).assist;
  assert.equal(await repo.applySessionControl(sessionId, 999n, { title: '不该落库' }), undefined);
  assert.equal((await readRow(sessionId)).title, '只属于 A 的讨论');
  // 正确基线才落得下去，并且一次只推进一位。
  assert.equal((await repo.applySessionControl(sessionId, 0n, { title: '基线正确的改名' }))
    ?.revision, 1n);
});

test('置顶是导航排序键：取消写回 NULL，注入时钟让时刻确定', async () => {
  const workspaceId = await newWorkspace('pin');
  const first = await newSession(workspaceId, '先建的会话');
  const second = await newSession(workspaceId, '后建的会话');
  const at = new Date('2026-10-16T04:00:00.000Z');

  const pinned = await setAssistSessionPin(app.db, { workspaceId, sessionId: first,
    commandId: randomUUID(), expectedRevision: '0', pinned: true, now: at });
  assert.equal(pinned.result.pinned, true);
  assert.equal(pinned.result.pinned_at, at.toISOString());

  const unpinned = await setAssistSessionPin(app.db, { workspaceId, sessionId: first,
    commandId: randomUUID(), expectedRevision: '1', pinned: false });
  assert.equal(unpinned.result.pinned, false);
  assert.equal(unpinned.result.pinned_at, null, '取消置顶必须把排序键写回 NULL，不留“曾经置顶”');
  assert.equal((await readRow(first)).pinned_at, null);
  // 置顶不改标题，也不动另一条会话。
  assert.equal((await readRow(first)).title, '先建的会话');
  assert.equal((await readRow(second)).pinned_at, null);
});

test('列表：默认只列 ACTIVE，status=ARCHIVED|ALL 各得其所，置顶项排在最前', async () => {
  const workspaceId = await newWorkspace('list');
  const older = await newSession(workspaceId, '较早的自由讨论');
  const newer = await newSession(workspaceId, '较晚的自由讨论');
  const archived = await newSession(workspaceId, '已被归档的讨论');
  await setAssistSessionPin(app.db, { workspaceId, sessionId: older,
    commandId: randomUUID(), expectedRevision: '0', pinned: true,
    now: new Date('2026-10-16T00:00:00.000Z') });
  await archiveAssistSession(app.db, { workspaceId, sessionId: archived,
    commandId: randomUUID(), expectedRevision: '0' });

  const ids = async (query: string): Promise<string[]> => {
    const response = await api.get(workspacePath(workspaceId, `/assist-sessions${query}`));
    assert.equal(response.status, 200, response.text);
    return ((response.body as { items: { id: string; status: string }[] }).items)
      .map((item) => item.id);
  };

  // 归档即隐藏发生在读侧：默认列表里没有它，所以左栏不点「已归档」也看不到。
  assert.deepEqual(await ids(''), [older, newer]);
  assert.deepEqual(await ids('?status=ARCHIVED'), [archived]);
  // 未置顶之间按 created_at 倒序：归档的会话建得最晚，因此排在 newer 之前。
  assert.deepEqual(await ids('?status=ALL'), [older, archived, newer]);
  // 状态值是封闭词表：小写这种「看起来一样」的写法必须在入口就被挡住，不能靠服务端猜。
  await expectProblem(await api.get(workspacePath(workspaceId,
    '/assist-sessions?status=archived')), 422, 'VALIDATION_FAILED');

  // 置顶行的 pinned_at 逐字返回，未置顶为 null；顺序由服务端决定，客户端不再猜。
  const active = (await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: { id: string; pinned_at: string | null }[] };
  assert.equal(active.items[0]?.id, older);
  assert.equal(active.items[0]?.pinned_at, '2026-10-16T00:00:00.000Z');
  assert.equal(active.items[1]?.pinned_at, null);

  // 第二条也置顶时，两枚置顶之间按置顶时刻倒序，未置顶的仍落在后面。
  await setAssistSessionPin(app.db, { workspaceId, sessionId: newer,
    commandId: randomUUID(), expectedRevision: '0', pinned: true,
    now: new Date('2026-10-16T08:00:00.000Z') });
  assert.deepEqual(await ids(''), [newer, older]);
});

test('迁移 0090 只是可空列：既有行取 NULL，无 CHECK 把状态钉成两值', async () => {
  const workspaceId = await newWorkspace('column');
  const sessionId = await newSession(workspaceId);
  const column = (await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
    select is_nullable, data_type, column_default from information_schema.columns
    where table_name = 'assist_sessions' and column_name = 'pinned_at'`.execute(app.db)).rows[0];
  assert.equal(column?.is_nullable, 'YES');
  assert.equal(column?.data_type, 'timestamp with time zone');
  assert.equal(column?.column_default, null, '缺省必须是 NULL：未置顶不是第三种状态');
  // 0090 之前的行不需要回填即可读：新列对旧代码不可见。
  assert.equal((await readRow(sessionId)).pinned_at, null);
  await sql`update assist_sessions set pinned_at = now() where id = ${sessionId}`.execute(app.db);
  assert.ok((await readRow(sessionId)).pinned_at instanceof Date);
  // 归档状态仍由 0015 的 status 表达，这一列不参与业务判定。
  const constraints = (await sql<{ c: string }>`select count(*)::text as c from pg_constraint
    where conname like 'assist_sessions%pinned%'`.execute(app.db)).rows[0];
  assert.equal(constraints?.c, '0');
});

test('未读标记：标记写入时刻、取消写回 NULL，修订推进且不动其它事实', async () => {
  const workspaceId = await newWorkspace('unread');
  const sessionId = await newSession(workspaceId, '有一条未读的讨论');
  const at = new Date('2026-10-17T02:30:00.000Z');

  const marked = await setAssistSessionUnread(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0', unread: true, now: at });
  assert.equal(marked.result.session_id, sessionId);
  assert.equal(marked.result.unread, true);
  assert.equal(marked.result.unread_at, at.toISOString(), '注入时钟让标记时刻确定');
  assert.equal(marked.result.revision, '1');
  assert.equal((await readRow(sessionId)).unread_at?.toISOString(), at.toISOString());
  // 未读只是导航标记：标题、状态、置顶都不许被顺手带走。
  const row = await readRow(sessionId);
  assert.equal(row.title, '有一条未读的讨论');
  assert.equal(row.status, 'ACTIVE');
  assert.equal(row.pinned_at, null);

  const cleared = await setAssistSessionUnread(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1', unread: false });
  assert.equal(cleared.result.unread, false);
  assert.equal(cleared.result.unread_at, null);
  assert.equal(cleared.result.revision, '2');
  assert.equal((await readRow(sessionId)).unread_at, null,
    '取消未读把标记写回 NULL，不保留「曾经未读」');
});

test('未读命令服从 revision CAS 与命令幂等：重放不推进，换载荷被拒，陈旧基线 409', async () => {
  const workspaceId = await newWorkspace('unread-cas');
  const sessionId = await newSession(workspaceId);
  const commandId = randomUUID();

  const first = await post(workspaceId, sessionId, 'unread', {
    command_id: commandId, expected_revision: '0', unread: true });
  const body = expectCommandAccepted(first, 200, commandId) as
    { session_id: string; unread: boolean; unread_at: string | null; revision: string };
  assert.equal(body.session_id, sessionId);
  assert.equal(body.unread, true);
  assert.match(body.unread_at ?? '', /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(body.revision, '1');
  assert.equal((first.body as { links: { resource: string } }).links.resource,
    `/api/v1/workspaces/${workspaceId}/assist-sessions/${sessionId}`);

  const replay = await post(workspaceId, sessionId, 'unread', {
    command_id: commandId, expected_revision: '0', unread: true });
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual(replay.body, first.body);
  assert.equal(await receiptsFor(commandId), 1);
  assert.equal((await readRow(sessionId)).revision, 1n);

  // 同 ID 换载荷：不能靠改内容复用一枚命令 ID。
  const reused = await post(workspaceId, sessionId, 'unread', {
    command_id: commandId, expected_revision: '1', unread: false });
  expectProblem(reused, 409, 'COMMAND_ID_REUSED');

  // 陈旧基线：服务端带出实际修订，界面据此重读；标记仍保持首次结果。
  const stale = await post(workspaceId, sessionId, 'unread', {
    command_id: randomUUID(), expected_revision: '0', unread: false });
  const problem = expectProblem(stale, 409, 'REVISION_CONFLICT');
  assert.equal((problem.conflict as Record<string, unknown>).actual_revision, '1');
  assert.ok((await readRow(sessionId)).unread_at !== null, '被拒的取消未读不得落库');
});

test('归档态拒绝标记未读，跨 Workspace 的会话不可见，被拒命令不留回执', async () => {
  const workspaceId = await newWorkspace('unread-gate');
  const sessionId = await newSession(workspaceId);
  await archiveAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0' });

  const commandId = randomUUID();
  await expectDomainCode(() => setAssistSessionUnread(app.db, { workspaceId, sessionId,
    commandId, expectedRevision: '1', unread: true }), 'INVALID_TRANSITION');
  assert.equal(await receiptsFor(commandId), 0, '被拒的未读标记不该留下回执');
  assert.equal((await readRow(sessionId)).unread_at, null);

  const otherWorkspace = await newWorkspace('unread-scope-b');
  const crossCommand = randomUUID();
  await expectDomainCode(() => setAssistSessionUnread(app.db, { workspaceId: otherWorkspace,
    sessionId, commandId: crossCommand, expectedRevision: '1', unread: true }), 'RESOURCE_NOT_FOUND');
  assert.equal(await receiptsFor(crossCommand), 0);
});

test('迁移 0104 只是可空列，列表把 unread_at 逐字返回', async () => {
  const workspaceId = await newWorkspace('unread-column');
  const sessionId = await newSession(workspaceId);
  const column = (await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
    select is_nullable, data_type, column_default from information_schema.columns
    where table_name = 'assist_sessions' and column_name = 'unread_at'`.execute(app.db)).rows[0];
  assert.equal(column?.is_nullable, 'YES');
  assert.equal(column?.data_type, 'timestamp with time zone');
  assert.equal(column?.column_default, null, '缺省必须是 NULL：已读不是第三种状态');
  // 0104 之前的行不回填即可读：新列对旧代码不可见。
  assert.equal((await readRow(sessionId)).unread_at, null);

  const at = new Date('2026-10-17T03:00:00.000Z');
  await setAssistSessionUnread(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0', unread: true, now: at });
  const listed = (await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: { id: string; unread_at: string | null }[] };
  assert.equal(listed.items[0]?.id, sessionId);
  assert.equal(listed.items[0]?.unread_at, at.toISOString(),
    '列表必须带上未读时刻，客户端不再自己猜');

  // 未读不是排序键：置顶排序只由 pinned_at 与 created_at 决定，标记前后顺序不变。
  const beforeOrder = (await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: { id: string }[] };
  await setAssistSessionUnread(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1', unread: false });
  const afterOrder = (await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: { id: string }[] };
  assert.deepEqual(afterOrder.items.map((item) => item.id),
    beforeOrder.items.map((item) => item.id));
});
