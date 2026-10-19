import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import {
  archiveAssistSession,
  forkAssistSession,
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
 * 会话行内控制（改名/置顶/未读/归档/重开/分叉）的真实 PostgreSQL 集成（迁移 0090/0104/0113，工作台 §28.9、§28.1）。
 *
 * 单测只能证明入口栅栏；**依赖真实事务、行锁与 CAS 的保证只能在这里取证**：
 *   * 五条命令各自落库、推进修订，回执资源指向这条会话；
 *   * 同一 `command_id` + 同载荷重放返回原结果、附 `command-replayed`、修订不推进、不新增回执；
 *   * 同一 `command_id` 换载荷被 `COMMAND_ID_REUSED` 挡住，不能靠改内容复用 ID；
 *   * 陈旧 `expected_revision` → 409 并带出服务端实际修订（界面据此重读，绝不自动重发）；
 *   * 跨 Workspace 的会话按不可见处理；归档态拒绝改名/置顶/标记未读；在途消息挡住归档；
 *   * 重复归档/重复重开是无操作，返回当前事实但不推进修订；
 *   * 列表默认只列 ACTIVE，`status=ARCHIVED|ALL` 各得其所，置顶项排在最前且取消置顶写回 NULL；
 *   * 0111 的活动排序键只由消息落库与生成结算推进，改名/置顶/未读都不推进，且不推进
 *     `revision` 与 `updated_at`；列表按「最后消息时间（还没说话时回落创建时间）」上浮。
 * 归档在这里始终等于「隐藏 + 拒收新消息」：消息、提案与命令回执留在原地，重开后照旧读得到。
 *
 * 分叉（0113）是这一组里唯一**新建行**的命令，取证口径与前五条不同：
 *   * 201 而非 200，回执与 `links.resource` 指向那条**新**会话，源会话一行都没改、修订不推进；
 *   * 搬过去的是输入快照（正文、来源、各类选择快照、历史时刻、图片字节）与按新序号重排的顺序；
 *   * 过程与结局一律不搬（服务商请求号、token 用量、领取 worker、错误码），失败的那一轮不进历史；
 *   * 提案不搬：同一条提案不能在两条会话里各接受一次，接受会写业务事实；
 *   * 重放同一 `command_id` 返回同一个子会话身份，不会再分出一条。
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

  // 未读不是排序键：列表顺序只由置顶与「最后消息时间（无消息时回落创建时间）」决定，
  // 标记前后顺序不变。
  const beforeOrder = (await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: { id: string }[] };
  await setAssistSessionUnread(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1', unread: false });
  const afterOrder = (await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: { id: string }[] };
  assert.deepEqual(afterOrder.items.map((item) => item.id),
    beforeOrder.items.map((item) => item.id));
});

/**
 * 用真实写入口播种一条消息（0111）：活动排序键只能由消息落库推进，测试不直接写那一列。
 * 返回消息 ID，供结算用例继续按领取身份收敛。
 */
async function seedMessage(sessionId: string, role: 'USER' | 'ASSISTANT'): Promise<string> {
  const messageId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    const seq = await repositories.assist.nextMessageSeq(sessionId);
    await repositories.assist.insertMessage({ id: messageId, sessionId, seq, role,
      status: role === 'USER' ? 'COMPLETED' : 'PENDING', intent: 'DISCUSS',
      content: role === 'USER' ? '说一句' : null, sources: [] });
  });
  return messageId;
}

test('迁移 0111：只有消息落库推进活动键，改名与置顶不推进、也不碰修订', async () => {
  const workspaceId = await newWorkspace('last-message-column');
  const sessionId = await newSession(workspaceId);
  const column = (await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
    select is_nullable, data_type, column_default from information_schema.columns
    where table_name = 'assist_sessions' and column_name = 'last_message_at'`.execute(app.db)).rows[0];
  assert.equal(column?.is_nullable, 'YES');
  assert.equal(column?.data_type, 'timestamp with time zone');
  assert.equal(column?.column_default, null, '缺省必须是 NULL：还没有消息不是第三种状态');
  assert.equal((await readRow(sessionId)).last_message_at, null);

  // 改名与置顶是元数据写入：推进 updated_at 与修订，但不得伪装成「这段讨论说过话」。
  await renameAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0', title: '改过的标题' });
  await setAssistSessionPin(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '1', pinned: true });
  assert.equal((await readRow(sessionId)).last_message_at, null,
    '改名与置顶都不推进活动排序键');

  const afterControls = await readRow(sessionId);
  assert.equal(afterControls.revision, 2n);
  await seedMessage(sessionId, 'USER');
  const afterMessage = await readRow(sessionId);
  assert.ok(afterMessage.last_message_at instanceof Date, '消息落库必须推进活动排序键');
  assert.equal(afterMessage.revision, afterControls.revision,
    '消息写入不得推进人工控制命令的 CAS 基线，否则在途生成会把置顶打成 409');
  assert.equal(afterMessage.updated_at.getTime(), afterControls.updated_at.getTime(),
    '消息写入也不得改写会话行的更新时间');
});

test('活动键单调：已经晚于本次写入的时刻不被旧事件拉回', async () => {
  const workspaceId = await newWorkspace('last-message-monotonic');
  const sessionId = await newSession(workspaceId);
  const future = new Date('2099-01-01T00:00:00.000Z');
  await sql`update assist_sessions set last_message_at = ${future} where id = ${sessionId}`
    .execute(app.db);

  await seedMessage(sessionId, 'USER');
  assert.equal((await readRow(sessionId)).last_message_at?.toISOString(), future.toISOString(),
    '排序键只前进不回退');
});

test('列表按最后消息时间上浮，还没说话的会话按创建时间留在原位', async () => {
  const workspaceId = await newWorkspace('last-message-order');
  const oldest = await newSession(workspaceId, '最早建的');
  const newest = await newSession(workspaceId, '后建的');
  type ListedSession = { id: string; last_message_at: string | null };
  const listed = async (): Promise<readonly ListedSession[]> =>
    ((await api.get(workspacePath(workspaceId, '/assist-sessions')))
      .body as { items: ListedSession[] }).items;

  // 都没说过话：按创建时间倒序，新会话在前。
  assert.deepEqual((await listed()).map((item) => item.id), [newest, oldest]);

  await seedMessage(oldest, 'USER');
  const floated = await listed();
  assert.deepEqual(floated.map((item) => item.id), [oldest, newest],
    '刚说过话的会话上浮，没说过话的那条不因本列为空而沉底');
  const [floatedFirst, floatedSecond] = floated as [ListedSession, ListedSession];
  assert.ok(floatedFirst.last_message_at !== null,
    '列表要逐字回显活动时刻，客户端不再自己猜');
  assert.equal(floatedSecond.last_message_at, null);

  // 置顶仍是第一排序键：活动序只在未置顶的组内生效。
  await setAssistSessionPin(app.db, { workspaceId, sessionId: newest,
    commandId: randomUUID(), expectedRevision: '0', pinned: true });
  assert.deepEqual((await listed()).map((item) => item.id), [newest, oldest]);
});

test('生成结算推进活动键，迟到的旧 Worker 结算不推进', async () => {
  const workspaceId = await newWorkspace('last-message-settle');
  const sessionId = await newSession(workspaceId);
  const messageId = await seedMessage(sessionId, 'ASSISTANT');
  const past = new Date('2020-01-01T00:00:00.000Z');
  await sql`update assist_sessions set last_message_at = ${past} where id = ${sessionId}`
    .execute(app.db);
  await sql`update assist_messages set status = 'RUNNING', worker_id = 'worker-1'
    where id = ${messageId}`.execute(app.db);

  const repositories = createRepositories(app.db);
  const stale = await repositories.assist.settleGeneration({ messageId, workerId: 'worker-2',
    status: 'COMPLETED', content: '迟到的答案', errorCode: null, providerRequestId: null,
    usageInputTokens: 1, usageOutputTokens: 1 });
  assert.equal(stale, false);
  assert.equal((await readRow(sessionId)).last_message_at?.toISOString(), past.toISOString(),
    '结算被 CAS 挡住时不得推进排序键');

  const settled = await repositories.assist.settleGeneration({ messageId, workerId: 'worker-1',
    status: 'FAILED', content: null, errorCode: 'MODEL_FAILED', providerRequestId: null,
    usageInputTokens: 1, usageOutputTokens: null });
  assert.equal(settled, true);
  const after = (await readRow(sessionId)).last_message_at;
  assert.ok(after instanceof Date && after.getTime() > past.getTime(),
    '失败的一轮同样是活动：回复说完就让会话上浮');
});

/** 分叉取证要逐列核对的消息快照（只声明用例断言到的列）。 */
type ForkedMessageRow = { id: string; seq: bigint; role: string; status: string;
  content: string | null; provider_request_id: string | null; worker_id: string | null;
  error_code: string | null; usage_input_tokens: number | null; usage_output_tokens: number | null;
  model_selection_snapshot: unknown; model_attempt_state: unknown;
  sources: unknown; created_at: Date };

type ForkedAttachmentRow = { id: string; session_id: string; message_id: string | null;
  name: string; media_type: string; byte_length: number; content_hash: Buffer;
  content: Buffer; created_at: Date };

async function listMessageRows(sessionId: string): Promise<readonly ForkedMessageRow[]> {
  return (await sql<ForkedMessageRow>`select id, seq, role, status, content,
    provider_request_id, worker_id, error_code, usage_input_tokens, usage_output_tokens,
    model_selection_snapshot, model_attempt_state, sources, created_at from assist_messages
    where session_id = ${sessionId} order by seq`.execute(app.db)).rows;
}

async function listAttachmentRows(sessionId: string): Promise<readonly ForkedAttachmentRow[]> {
  return (await sql<ForkedAttachmentRow>`select id, session_id, message_id, name, media_type,
    byte_length, content_hash, content, created_at from assist_message_attachments
    where session_id = ${sessionId} order by created_at, id`.execute(app.db)).rows;
}

/** 这条会话分出去了几条：被拒的分叉必须一直返回 0。 */
async function forkCount(sessionId: string): Promise<number> {
  const row = (await sql<{ c: string }>`select count(*)::text as c from assist_sessions
    where forked_from_session_id = ${sessionId}`.execute(app.db)).rows[0];
  return Number(row?.c ?? '0');
}

/** 播种一条已完成、带用量与服务商请求号的回复：走真实结算入口，测试不冒充 Worker。 */
async function seedCompletedAnswer(sessionId: string, content: string,
  workerId: string): Promise<string> {
  const messageId = await seedMessage(sessionId, 'ASSISTANT');
  await sql`update assist_messages set status = 'RUNNING', worker_id = ${workerId}
    where id = ${messageId}`.execute(app.db);
  const settled = await createRepositories(app.db).assist.settleGeneration({ messageId, workerId,
    status: 'COMPLETED', content, errorCode: null, providerRequestId: 'provider-req-1',
    usageInputTokens: 11, usageOutputTokens: 7 });
  assert.equal(settled, true, `播种的回复没能结算：${messageId}`);
  return messageId;
}

test('分叉：201 建一条子会话，历史与图片按新序号搬过去，源会话一行都没改', async () => {
  const workspaceId = await newWorkspace('fork-copy');
  // 会话绑一个真实项目：分叉之后归属必须照搬，不能变成「没主」的新会话。
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: '分叉用项目', projectType: 'GENERAL' });
  });
  const sessionId = (await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: '要分叉的讨论' })).result.session_id;

  const questionId = await seedMessage(sessionId, 'USER');
  await withTransaction(app.db, async (repositories) => {
    const attachmentId = randomUUID();
    await repositories.assist.insertAttachment({ id: attachmentId, workspaceId, sessionId,
      name: '截图.png', mediaType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentHash: Buffer.from([0x01, 0x02, 0x03, 0x04]) });
    await repositories.assist.bindAttachments(sessionId, questionId, [attachmentId]);
  });
  const answerId = await seedCompletedAnswer(sessionId, '分叉前说过的答案', 'worker-1');
  // 给那一轮挂上 0098 的模型身份对（快照 + 尝试状态）：两列在库里成对非空，
  // 正好用来钉住「分叉既不搬模型选择，也不搬尝试进度」这一条。
  await sql`update assist_messages set model_selection_snapshot = '{"candidate":"候选一"}'::jsonb,
    model_attempt_state = '{"status":"READY","currentCandidateIndex":0}'::jsonb
    where id = ${answerId}`.execute(app.db);
  // 失败的那一轮：那一轮自己的结局，不随文本进历史。
  const failedId = await seedMessage(sessionId, 'ASSISTANT');
  await sql`update assist_messages set status = 'RUNNING', worker_id = 'worker-2'
    where id = ${failedId}`.execute(app.db);
  await createRepositories(app.db).assist.settleGeneration({ messageId: failedId,
    workerId: 'worker-2', status: 'FAILED', content: null, errorCode: 'MODEL_FAILED',
    providerRequestId: 'provider-req-2', usageInputTokens: 5, usageOutputTokens: null });
  // 挂在已完成回复上的提案：接受一次会写业务事实，同一条不能在两条会话里各接受一次。
  await sql`insert into assist_proposals (id, workspace_id, session_id, message_id, kind,
    project_id, task_id, target_type, target_id, base_revision, payload, payload_hash)
    values (${randomUUID()}, ${workspaceId}, ${sessionId}, ${answerId}, 'TASK_DEFINITION',
      ${projectId}, null, 'PROJECT', ${projectId}, 0,
      '{"title":"分叉前的提案"}'::jsonb, 'sha256:proposal')`.execute(app.db);

  const before = await readRow(sessionId);
  const commandId = randomUUID();
  const response = await post(workspaceId, sessionId, 'fork', {
    command_id: commandId, expected_revision: '0' });
  const result = expectCommandAccepted(response, 201, commandId) as
    { session_id: string; title: string; revision: string; updated_at: string; copied_messages: number };
  const childId = result.session_id;

  assert.notEqual(childId, sessionId, '分叉给的是另一条会话的身份');
  assert.equal(result.title, '要分叉的讨论（1）', '编号由服务端决定，界面不自己拼');
  assert.equal(result.revision, '0', '新资源从 0 起，界面对它做第一次行内命令时基线就是 0');
  assert.equal(result.copied_messages, 2, '已完成且有正文的两轮进历史，失败那一轮不算');
  // 201 的回执指向新建的子会话，不是被分叉的那一条。
  assert.equal((response.body as { links: { resource: string } }).links.resource,
    `/api/v1/workspaces/${workspaceId}/assist-sessions/${childId}`);

  const child = await readRow(childId);
  assert.equal(child.forked_from_session_id, sessionId);
  assert.equal(child.workspace_id, workspaceId);
  assert.equal(child.project_id, projectId, '归属照搬：分叉不改变这段讨论属于哪个项目');
  assert.equal(child.task_id, null);
  assert.equal(child.status, 'ACTIVE');
  assert.equal(child.pinned_at, null, '置顶与未读是那一行自己的导航偏好，不继承');
  assert.equal(child.unread_at, null);
  assert.ok(child.last_message_at instanceof Date,
    '子会话刚写完历史：按消息落库那一口径推进活动键，新讨论要落在活动序顶部');

  // 源会话一行都没改——分叉不是对父会话的一次改写。
  const sourceAfter = await readRow(sessionId);
  assert.equal(sourceAfter.revision, before.revision, '分叉不推进父会话的 CAS 基线');
  assert.equal(sourceAfter.title, before.title);
  assert.equal(sourceAfter.updated_at.getTime(), before.updated_at.getTime());
  assert.equal(sourceAfter.forked_from_session_id, null);
  assert.equal(sourceAfter.last_message_at?.getTime(), before.last_message_at?.getTime(),
    '父会话的最近活动不因「被分叉了一次」而刷新');

  const parentRows = await listMessageRows(sessionId);
  const childRows = await listMessageRows(childId);
  const copied = parentRows.filter((row) => row.status === 'COMPLETED' && row.content !== null);
  assert.equal(childRows.length, copied.length, '失败与在途的轮次都不进历史');
  assert.ok(copied.some((row) => row.model_selection_snapshot !== null),
    '父会话那一轮确实带着 0098 的模型身份，「不搬」才不是空断言');
  // 顺序按子会话从 1 重排：0015 的 UNIQUE (session_id, seq) 只允许这一种编号方式。
  assert.deepEqual(childRows.map((row) => Number(row.seq)), [1, 2]);
  assert.deepEqual(childRows.map((row) => [row.role, row.status, row.content]),
    copied.map((row) => [row.role, row.status, row.content]));
  for (const [index, row] of childRows.entries()) {
    const source = copied[index]!;
    assert.notEqual(row.id, source.id, '每一轮都是新行，不与父会话共享消息身份');
    assert.equal(row.created_at.getTime(), source.created_at.getTime(),
      '历史时刻原样保留：这段讨论是什么时候说的，子会话里还是什么时候');
    assert.deepEqual(row.sources, source.sources);
    // 0098 把模型选择与尝试状态约束成成对非空，且二者只服务排队与重试；复制过去的历史
    // 一律 COMPLETED、不会再进生成路径，因此两列一起归零，而不是只搬其中一半。
    assert.equal(row.model_selection_snapshot, null, '排队期的模型选择不搬');
    assert.equal(row.model_attempt_state, null, '尝试进度是过程，不搬');
    assert.equal(row.provider_request_id, null, '子会话没有发生过那次外呼，请求号留着就是伪造');
    assert.equal(row.usage_input_tokens, null, '用量是那次外呼的结局，不搬；未知不是 0（0018）');
    assert.equal(row.usage_output_tokens, null);
    assert.equal(row.worker_id, null, '领取过程是父会话那一轮的事实，不继承');
    assert.equal(row.error_code, null);
  }

  const parentAttachment = (await listAttachmentRows(sessionId))[0]!;
  const childAttachments = await listAttachmentRows(childId);
  assert.equal(childAttachments.length, 1, '图片随那一轮一起搬过来');
  const childAttachment = childAttachments[0]!;
  assert.notEqual(childAttachment.id, parentAttachment.id, '附件也是新行，不共享身份');
  assert.equal(childAttachment.session_id, childId);
  assert.equal(childAttachment.message_id, childRows[0]!.id, '绑到子会话里的那一轮，不是父消息');
  assert.equal(childAttachment.name, parentAttachment.name);
  assert.equal(childAttachment.media_type, parentAttachment.media_type);
  assert.deepEqual(childAttachment.content, parentAttachment.content, '0093 的字节不可变，只搬运');
  assert.deepEqual(childAttachment.content_hash, parentAttachment.content_hash);

  // 提案留在父会话：子会话一条都没有，父会话仍恰好一条。
  const proposalCounts = (await sql<{ parent: string; child: string }>`
    select count(*) filter (where session_id = ${sessionId})::text as parent,
      count(*) filter (where session_id = ${childId})::text as child
    from assist_proposals`.execute(app.db)).rows[0]!;
  assert.equal(proposalCounts.parent, '1');
  assert.equal(proposalCounts.child, '0', '同一条提案不能在两条会话里各接受一次');

  // 重放：同一个 command_id 拿回同一份子会话结果，不会再分出一条。
  const replay = await post(workspaceId, sessionId, 'fork', {
    command_id: commandId, expected_revision: '0' });
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual(replay.body, response.body);
  assert.equal(await receiptsFor(commandId), 1);
  assert.equal(await forkCount(sessionId), 1, '重放不得再分出一条子会话');
  // 换载荷复用同一个 ID 仍然被挡住：分叉的载荷里只有基线修订。
  const reused = await post(workspaceId, sessionId, 'fork', {
    command_id: commandId, expected_revision: '1' });
  expectProblem(reused, 409, 'COMMAND_ID_REUSED');
});

test('分叉的栅栏：在途消息与归档态都拒绝，陈旧基线 409 带出实际修订，跨 Workspace 不可见', async () => {
  const workspaceId = await newWorkspace('fork-gates');
  const sessionId = await newSession(workspaceId, '不能分叉的讨论');

  // 还在生成的那一轮：既不该进历史，也不该让子会话从半截开始。
  await seedMessage(sessionId, 'ASSISTANT');
  const inflight = randomUUID();
  await expectDomainCode(() => forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: inflight, expectedRevision: '0' }), 'INVALID_TRANSITION');
  assert.equal(await receiptsFor(inflight), 0, '被拒的分叉不该留下回执');
  assert.equal(await forkCount(sessionId), 0, '被拒的分叉不该留下子会话');

  // 收敛那一轮之后才能归档：在途消息同样挡住归档（控制意图必须持久化）。
  await sql`update assist_messages set status = 'COMPLETED', content = '说完了'
    where session_id = ${sessionId} and status = 'PENDING'`.execute(app.db);
  const archived = randomUUID();
  await archiveAssistSession(app.db, { workspaceId, sessionId, commandId: archived,
    expectedRevision: '0' });
  assert.equal(await forkCount(sessionId), 0, '归档本身不分叉');

  const rejected = randomUUID();
  await expectDomainCode(() => forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: rejected, expectedRevision: '1' }), 'INVALID_TRANSITION');
  assert.equal(await receiptsFor(rejected), 0);
  assert.equal(await forkCount(sessionId), 0);

  await reopenAssistSession(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '1' });
  const stale = await post(workspaceId, sessionId, 'fork', {
    command_id: randomUUID(), expected_revision: '1' });
  const problem = expectProblem(stale, 409, 'REVISION_CONFLICT');
  assert.equal((problem.conflict as Record<string, unknown>).actual_revision, '2',
    '归档与重开各推进了一次修订：界面据此重读，绝不自动重发');
  assert.equal(await forkCount(sessionId), 0, '被拒的分叉同样不能留下子会话');

  const otherWorkspace = await newWorkspace('fork-scope-b');
  const cross = randomUUID();
  await expectDomainCode(() => forkAssistSession(app.db, { workspaceId: otherWorkspace,
    sessionId, commandId: cross, expectedRevision: '2' }), 'RESOURCE_NOT_FOUND');
  assert.equal(await receiptsFor(cross), 0);
  assert.equal((await sql<{ c: string }>`select count(*)::text as c from assist_sessions
    where forked_from_session_id = ${sessionId}`.execute(app.db)).rows[0]!.c, '0',
    '跨 Workspace 的分叉连一行都不该留下');
});

test('分叉标题由服务端排号：编号跟着被分叉那一条的标题走，上限守住编号', async () => {
  const workspaceId = await newWorkspace('fork-title');
  const sessionId = await newSession(workspaceId, '同一段讨论');

  const first = await forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(first.result.title, '同一段讨论（1）');
  // 同一源会话再分一次：编号跟着源标题（没有编号）走，仍是（1）。
  // 标题本来就不是唯一键；要按兄弟数量排号得在无索引的来源列上反查，只为一个显示编号不值得。
  const second = await forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(second.replayed, false, '这是第二次分叉，不是重放');
  assert.notEqual(second.result.session_id, first.result.session_id);
  assert.equal(second.result.title, '同一段讨论（1）');
  // 分叉一条（1）得到的才是（2）：编号随这一支的标题继续往下走。
  const grandChild = await forkAssistSession(app.db, { workspaceId,
    sessionId: first.result.session_id, commandId: randomUUID(), expectedRevision: '0' });
  assert.equal(grandChild.result.title, '同一段讨论（2）');
  assert.equal((await readRow(grandChild.result.session_id)).forked_from_session_id,
    first.result.session_id, '来源指向被分叉的那一条，不是它的祖辈');

  // 半角括号同样认：别的工具生成的标题不该被当成「没编过号」。
  const halfWidth = await newSession(workspaceId, '来自别处的讨论(3)');
  assert.equal((await forkAssistSession(app.db, { workspaceId, sessionId: halfWidth,
    commandId: randomUUID(), expectedRevision: '0' })).result.title, '来自别处的讨论（4）');

  // 200 上限守的是整串：超长时截正文前缀，编号永远完整留在末尾。
  const longId = await newSession(workspaceId, '标'.repeat(200));
  const longTitle = (await forkAssistSession(app.db, { workspaceId, sessionId: longId,
    commandId: randomUUID(), expectedRevision: '0' })).result.title;
  assert.equal(longTitle.length, 200);
  assert.ok(longTitle.endsWith('（1）'), '截的是正文，不是编号');
  assert.equal(longTitle, `${'标'.repeat(197)}（1）`);
  // 按完整码点退让：代理对不被切成半个（这里是 99 枚 emoji，每枚占两个 UTF-16 单位）。
  const emojiId = await newSession(workspaceId, '🐧'.repeat(99));
  const emojiTitle = (await forkAssistSession(app.db, { workspaceId, sessionId: emojiId,
    commandId: randomUUID(), expectedRevision: '0' })).result.title;
  assert.equal(emojiTitle, `${'🐧'.repeat(98)}（1）`, '退让只能整枚退，否则标题里会留下孤立代理项');
  assert.equal((await readRow(emojiId)).title, '🐧'.repeat(99), '源会话的标题一个字都不该动');
});

test('迁移 0113 只是一枚可空自引用列，会话读取与列表都逐字返回来源', async () => {
  const workspaceId = await newWorkspace('fork-column');
  const column = (await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
    select is_nullable, data_type, column_default from information_schema.columns
    where table_name = 'assist_sessions' and column_name = 'forked_from_session_id'`
    .execute(app.db)).rows[0];
  assert.equal(column?.is_nullable, 'YES');
  assert.equal(column?.data_type, 'uuid');
  assert.equal(column?.column_default, null, '缺省必须是 NULL：不是分叉来的不是第三种状态');
  const foreignKey = (await sql<{ referenced: string }>`
    select confrelid::regclass::text as referenced from pg_constraint
    where conrelid = 'assist_sessions'::regclass and contype = 'f'
      and conname = 'assist_sessions_forked_from_session_id_fkey'`.execute(app.db)).rows[0];
  assert.equal(foreignKey?.referenced, 'assist_sessions', '来源只指向另一条会话');

  const sessionId = await newSession(workspaceId, '带来源的讨论');
  // 0113 之前的行不回填即可读：新列对旧代码不可见。
  assert.equal((await readRow(sessionId)).forked_from_session_id, null);

  const forked = await forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });
  const childId = forked.result.session_id;
  assert.equal(forked.result.copied_messages, 0, '还没说过话的讨论照样能分叉');
  assert.equal((await readRow(childId)).last_message_at, null,
    '空讨论分叉不得捏造「说过话」：活动键只在真有消息搬过去时推进');

  type Listed = { id: string; title: string; forked_from_session_id: string | null };
  const listed = ((await api.get(workspacePath(workspaceId, '/assist-sessions')))
    .body as { items: Listed[] }).items;
  assert.deepEqual(new Set(listed.map((item) => item.id)), new Set([sessionId, childId]));
  // 新建的子会话按活动序浮在最前，父会话仍是 null。
  assert.deepEqual(listed.map((item) => [item.id, item.forked_from_session_id]),
    [[childId, sessionId], [sessionId, null]], '列表要逐字回显来源，客户端不自己猜标题里的编号');

  const single = (await api.get(workspacePath(workspaceId, `/assist-sessions/${childId}`)))
    .body as Listed;
  assert.equal(single.forked_from_session_id, sessionId);
});
