import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { runMemberWakeupTick } from '../../src/application/member-wakeup.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';

/**
 * P1-C 第一片：成员消息唤醒与消费结算（ADR-034 包 C，迁移 0141）。
 *
 * 六条不变量：
 *  * 唤醒裁决只依据消息行上的定向事实：私聊→对方、群聊定向→指定成员、
 *    未定向→协调者；一次只唤醒一个成员，绝不广播全员；
 *  * 成员回信是 sender_kind=MEMBER 的未定向协作记录——结构性不触发下一轮唤醒；
 *  * RECORDED→CLAIMED 条件更新是唯一领取点：重复扫描与第二个 Worker 不重复回信；
 *  * 崩溃由租约清扫收敛：上限内重试一次，超上限按 WAKEUP_ATTEMPTS_EXHAUSTED 收口；
 *    模型失败本身不自动重试；
 *  * 停用/外部成员、关闭会话、归档项目不唤醒：消息保留 RECORDED 等待，不记失败；
 *  * 成员模型按 PT-08 如实解析：INHERIT 用默认端口，EXPLICIT 不匹配/未接路由类型化失败；
 *    每次真实调用进 model_calls 账本（kind='MEMBER'，指回触发消息）。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-member-wakeup-test');
let api: TestApi;
const fakePort = new FakeModelPort();

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

type Conversation = {
  conversation_id: string; project_id: string; kind: string; member_id: string | null;
  status: string; close_reason: string | null; revision: string;
};
type Message = {
  message_id: string; conversation_id: string; seq: string; sender_kind: string;
  sender_member_id: string | null; recipient_member_ids: string[]; intent: string;
  content: string; processing_status: string;
};

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const path = (segment: string) => workspacePath(workspaceId, segment);
  const command = async (segment: string, body: Record<string, unknown>, status: 200 | 201 = 200) => {
    const id = typeof body.command_id === 'string' ? body.command_id : randomUUID();
    return expectCommandAccepted(await api.post(path(segment), { command_id: id, ...body }), status, id);
  };
  const projectId = (await command('/projects', { title: '唤醒项目', project_type: 'GENERAL' }, 201)).project_id as string;
  const createMember = (name: string, roleKey = 'DEVELOPMENT', runMode = 'BUILTIN') =>
    command('/projects/' + projectId + '/agent-members', {
      name, role_key: roleKey, run_mode: runMode,
    }, 201) as Promise<unknown> as Promise<{ agent_member_id: string; revision: string }>;
  const openConversation = (kind: 'DIRECT' | 'GROUP', memberId?: string) =>
    command(`/projects/${projectId}/member-conversations`, {
      kind, ...(memberId === undefined ? {} : { member_id: memberId }),
    }, 200) as Promise<unknown> as Promise<Conversation>;
  const send = (conversationId: string, content: string, extra: Record<string, unknown> = {}) =>
    command(`/member-conversations/${conversationId}/messages`, {
      content, intent: 'DISCUSS', ...extra,
    }, 200) as Promise<unknown> as Promise<Message>;
  const tick = (workerId: string, options: Record<string, unknown> = {}) =>
    runMemberWakeupTick(app.db, { workerId, modelPort: fakePort, leaseMs: 60_000, ...options });
  return { workspaceId, projectId, path, command, createMember, openConversation, send, tick };
}

async function messageRow(id: string): Promise<{
  processing_status: string; attempts: number; claimed_by: string | null;
  failure_reason: string | null;
}> {
  return (await sql<{ processing_status: string; attempts: number; claimed_by: string | null;
    failure_reason: string | null }>`select processing_status, attempts, claimed_by, failure_reason
    from project_member_messages where id = ${id}`.execute(app.db)).rows[0]!;
}

async function conversationMessages(conversationId: string): Promise<Message[]> {
  return (await sql<Message>`select id as message_id, conversation_id, seq::text as seq,
    sender_kind, sender_member_id, recipient_member_ids, intent, content, processing_status
    from project_member_messages where conversation_id = ${conversationId} order by seq`
    .execute(app.db)).rows;
}

async function memberCallCount(messageId: string): Promise<{ total: string; completed: string }> {
  return (await sql<{ total: string; completed: string }>`select count(*)::text as total,
    count(*) filter (where status = 'COMPLETED')::text as completed
    from model_calls where kind = 'MEMBER' and member_message_id = ${messageId}`
    .execute(app.db)).rows[0]!;
}

test('唤醒裁决：私聊唤醒对方、群聊定向唤醒指定成员、未定向由协调者接住，一次只唤醒一个', async () => {
  const f = await fixture();
  const coordinator = await f.createMember('协调成员', 'COORDINATION');
  const developer = await f.createMember('开发成员');
  const reviewer = await f.createMember('测试成员', 'TEST_REVIEW');
  await f.command(`/projects/${f.projectId}/coordinator-assignments`, {
    member_id: coordinator.agent_member_id, reason: '指派协调者',
  }, 200);

  const group = await f.openConversation('GROUP');
  const undirected = await f.send(group.conversation_id, '这个需求怎么拆？');
  const outcome = await f.tick('worker-a');
  assert.equal(outcome.processed.length, 1, '一条消息一次唤醒');
  assert.equal(outcome.processed[0]!.memberId, coordinator.agent_member_id, '未定向群聊由协调者接住');

  const directed = await f.send(group.conversation_id, '请独立检查这版方案。', {
    intent: 'CHECK_REQUEST', recipient_member_ids: [reviewer.agent_member_id],
  });
  const second = await f.tick('worker-a');
  assert.equal(second.processed[0]!.memberId, reviewer.agent_member_id, '定向消息只唤醒指定成员');

  const dm = await f.openConversation('DIRECT', developer.agent_member_id);
  const dmMessage = await f.send(dm.conversation_id, '请核对存储层迁移。');
  const third = await f.tick('worker-a');
  assert.equal(third.processed[0]!.memberId, developer.agent_member_id, '私聊唤醒对方成员');

  const messages = await conversationMessages(group.conversation_id);
  assert.equal(messages.length, 4, '两条人类消息＋两条成员回信，没有广播多余的回信');
  const reply = messages.find((row) => row.sender_kind === 'MEMBER');
  assert.ok(reply !== undefined, '存在成员回信');
  assert.equal(reply!.sender_member_id, coordinator.agent_member_id);
  assert.equal(reply!.intent, 'DISCUSS');
  assert.deepEqual(reply!.recipient_member_ids, [], '成员回信未定向——结构性不触发下一轮唤醒');
  assert.ok(reply!.content.trim().length > 0);

  // 成员回信（MEMBER、未定向）不会成为下一轮唤醒的触发：再跑一个 tick 没有新工作。
  const idle = await f.tick('worker-a');
  assert.equal(idle.processed.length, 0);
  assert.equal(idle.waiting.length, 0, '没有候选被反复报告为不可唤醒');

  for (const message of [undirected, directed, dmMessage]) {
    const row = await messageRow(message.message_id);
    assert.equal(row.processing_status, 'PROCESSED');
    assert.equal(row.attempts, 1);
  }
  for (const message of [undirected.message_id, directed.message_id, dmMessage.message_id]) {
    const calls = await memberCallCount(message);
    assert.equal(calls.total, '1', `每次唤醒恰好一次模型调用（${message}）`);
    assert.equal(calls.completed, '1');
  }
});

test('消费幂等与并发领取：第二个 Worker 不重复领取，CAS 是唯一领取点', async () => {
  const f = await fixture();
  const coordinator = await f.createMember('协调成员', 'COORDINATION');
  await f.command(`/projects/${f.projectId}/coordinator-assignments`, {
    member_id: coordinator.agent_member_id, reason: '指派',
  }, 200);
  const group = await f.openConversation('GROUP');
  const message = await f.send(group.conversation_id, '这个需求怎么拆？');

  const first = await f.tick('worker-a');
  assert.equal(first.processed.length, 1);
  const replay = await f.tick('worker-b');
  assert.equal(replay.processed.length, 0, '已处理消息不再被第二个 Worker 领取');

  const calls = await memberCallCount(message.message_id);
  assert.equal(calls.total, '1', '不重复调用模型');
  const messages = await conversationMessages(group.conversation_id);
  assert.equal(messages.filter((row) => row.sender_kind === 'MEMBER').length, 1, '只有一条成员回信');

  // 在途领取（CLAIMED、租约未过期）对其他 Worker 不可见：不抢领也不误判。
  const secondMessage = await f.send(group.conversation_id, '补充一个问题。');
  await withTransaction(app.db, (tx) => tx.memberConversations
    .claimWakeupMessage(secondMessage.message_id, 'worker-holder', new Date(), 60_000));
  const busy = await f.tick('worker-b');
  assert.equal(busy.processed.length, 0, '在途领取不被其他 Worker 抢走');
  const held = await messageRow(secondMessage.message_id);
  assert.equal(held.processing_status, 'CLAIMED');
  assert.equal(held.claimed_by, 'worker-holder');
});

test('崩溃恢复：租约过期在上限内重试一次，超上限按 WAKEUP_ATTEMPTS_EXHAUSTED 收口', async () => {
  const f = await fixture();
  const developer = await f.createMember('开发成员');
  const dm = await f.openConversation('DIRECT', developer.agent_member_id);
  const message = await f.send(dm.conversation_id, '第一次唤醒。');

  // 模拟崩溃：领取后租约过期（attempts=1 < 2）→ 清扫退回 RECORDED，本 tick 内重新领取并完成。
  await withTransaction(app.db, (tx) => tx.memberConversations
    .claimWakeupMessage(message.message_id, 'crashed-worker', new Date(), 60_000));
  await sql`update project_member_messages set lease_expires_at = now() - interval '1 second'
    where id = ${message.message_id}`.execute(app.db);
  const recovered = await f.tick('worker-b');
  assert.equal(recovered.requeued, 1, '过期租约被清扫退回');
  assert.equal(recovered.processed.length, 1, '退回后由本 tick 重新领取完成');
  const row = await messageRow(message.message_id);
  assert.equal(row.processing_status, 'PROCESSED');
  assert.equal(row.attempts, 2, '崩溃的一次＋重试的一次');
  assert.equal((await conversationMessages(dm.conversation_id))
    .filter((entry) => entry.sender_kind === 'MEMBER').length, 1, '仍然只有一条回信');

  // 超上限：不再重试，按失败收口，不产生模型调用。
  const exhausted = await f.send(dm.conversation_id, '第二次唤醒。');
  await withTransaction(app.db, (tx) => tx.memberConversations
    .claimWakeupMessage(exhausted.message_id, 'crashed-worker', new Date(), 60_000));
  await sql`update project_member_messages set attempts = 2,
    lease_expires_at = now() - interval '1 second' where id = ${exhausted.message_id}`
    .execute(app.db);
  const swept = await f.tick('worker-b');
  assert.equal(swept.expiredFailed, 1);
  assert.equal(swept.processed.length, 0, '超上限不再重试');
  const failedRow = await messageRow(exhausted.message_id);
  assert.equal(failedRow.processing_status, 'FAILED');
  assert.equal(failedRow.failure_reason, 'WAKEUP_ATTEMPTS_EXHAUSTED');
  assert.equal((await memberCallCount(exhausted.message_id)).total, '0', '收口不产生模型调用');
});

test('准入：停用/外部成员、关闭会话、归档项目不唤醒，消息保留等待不记失败', async () => {
  const f = await fixture();
  const inactive = await f.createMember('将停用成员');
  const external = await f.createMember('外部成员', 'DEVELOPMENT', 'EXTERNAL');
  await f.command(`/projects/${f.projectId}/coordinator-assignments`, {
    member_id: inactive.agent_member_id, reason: '先指派',
  }, 200);
  const group = await f.openConversation('GROUP');

  const undirectedNoCoordinatorYet = await f.send(group.conversation_id, '谁在？');
  const externalDm = await f.openConversation('DIRECT', external.agent_member_id);
  const externalMessage = await f.send(externalDm.conversation_id, '外部成员请领取。');

  // 停用协调者：未定向消息没有可唤醒对象。
  await f.command(`/agent-members/${inactive.agent_member_id}/status-changes`, {
    expected_revision: inactive.revision, status: 'INACTIVE', reason: '停用',
  }, 200);
  const skipped = await f.tick('worker-a');
  assert.equal(skipped.processed.length, 0);
  assert.ok(skipped.waiting.some((entry) => entry.messageId === undirectedNoCoordinatorYet.message_id),
    '无可唤醒成员的消息进入等待清单');
  const waitingRow = await messageRow(undirectedNoCoordinatorYet.message_id);
  assert.equal(waitingRow.processing_status, 'RECORDED', '等待不改变状态、不记失败');
  assert.equal(waitingRow.failure_reason, null);
  assert.equal((await memberCallCount(undirectedNoCoordinatorYet.message_id)).total, '0');

  // 外部成员：不由内置循环唤醒（主动领取归外部协议）。
  assert.ok(skipped.waiting.some((entry) => entry.messageId === externalMessage.message_id));
  assert.equal((await messageRow(externalMessage.message_id)).processing_status, 'RECORDED');

  // 关闭会话：讨论已终止，不再唤醒。
  const dm = await f.openConversation('DIRECT', (await f.createMember('开发成员')).agent_member_id);
  const closedMessage = await f.send(dm.conversation_id, '即将关闭的讨论。');
  await f.command(`/member-conversations/${dm.conversation_id}/status-changes`, {
    expected_revision: dm.revision, status: 'CLOSED', close_reason: 'RESOLVED', note: '已解决',
  }, 200);
  const afterClose = await f.tick('worker-a');
  assert.equal(afterClose.processed.length, 0);
  assert.ok(!afterClose.waiting.some((entry) => entry.messageId === closedMessage.message_id),
    '关闭会话的消息不进候选，也不进等待清单');
  assert.equal((await messageRow(closedMessage.message_id)).processing_status, 'RECORDED');

  // 归档项目：不领取。
  const archivedProject = await fixture();
  const member = await archivedProject.createMember('开发成员');
  const archivedDm = await archivedProject.openConversation('DIRECT', member.agent_member_id);
  const archivedMessage = await archivedProject.send(archivedDm.conversation_id, '归档前的问题。');
  await sql`update projects set archived_at = now() where id = ${archivedProject.projectId}`
    .execute(app.db);
  const afterArchive = await archivedProject.tick('worker-a');
  assert.equal(afterArchive.processed.length, 0);
  assert.equal((await messageRow(archivedMessage.message_id)).processing_status, 'RECORDED');
});

test('成员模型（PT-08）：EXPLICIT 不匹配或未接路由类型化失败，模型失败不自动重试', async () => {
  const f = await fixture();
  const openrouterMemberId = randomUUID();
  const staleMemberId = randomUUID();
  await withTransaction(app.db, async (tx) => {
    await tx.agentMembers.insert({ id: openrouterMemberId, workspace_id: f.workspaceId,
      project_id: f.projectId, name: '免费路由成员', role_key: 'DEVELOPMENT',
      duties: '开发', run_mode: 'BUILTIN',
      model_selection: { mode: 'EXPLICIT', model: 'x', connection: 'openrouter',
        free_only: true, config_fingerprint: 'f' },
      external_binding: {} });
    await tx.agentMembers.insert({ id: staleMemberId, workspace_id: f.workspaceId,
      project_id: f.projectId, name: '配置漂移成员', role_key: 'DEVELOPMENT',
      duties: '开发', run_mode: 'BUILTIN',
      model_selection: { mode: 'EXPLICIT', model: 'other-model', connection: 'openai-compatible',
        free_only: false, config_fingerprint: 'stale' },
      external_binding: {} });
  });

  const openrouterDm = await f.openConversation('DIRECT', openrouterMemberId);
  const openrouterMessage = await f.send(openrouterDm.conversation_id, '请回应。');
  const routeTick = await f.tick('worker-a');
  assert.equal(routeTick.processed[0]!.status, 'FAILED');
  assert.equal(routeTick.processed[0]!.reason, 'MEMBER_MODEL_ROUTE_UNAVAILABLE');
  assert.equal((await memberCallCount(openrouterMessage.message_id)).total, '0',
    '路由不可用不产生模型调用');

  const staleDm = await f.openConversation('DIRECT', staleMemberId);
  const staleMessage = await f.send(staleDm.conversation_id, '请回应。');
  const staleTick = await f.tick('worker-a');
  assert.equal(staleTick.processed[0]!.reason, 'MEMBER_MODEL_CONFIG_CHANGED');
  assert.equal((await memberCallCount(staleMessage.message_id)).total, '0');

  // 模型异常：按类型化失败收口；第二个 tick 不再重试（FAILED 不回候选）。
  const developer = await f.createMember('开发成员');
  const dm = await f.openConversation('DIRECT', developer.agent_member_id);
  const thrown = await f.send(dm.conversation_id, '这次会失败 FAKE_ASSIST_THROW');
  const failedTick = await f.tick('worker-a');
  assert.equal(failedTick.processed[0]!.status, 'FAILED');
  assert.equal(failedTick.processed[0]!.reason, 'MODEL_FAILED');
  const retryTick = await f.tick('worker-a');
  assert.equal(retryTick.processed.length, 0, '模型失败不自动重试');
  const thrownCalls = await memberCallCount(thrown.message_id);
  assert.equal(thrownCalls.total, '1');
  const ledger = (await sql<{ status: string }>`select status from model_calls
    where kind = 'MEMBER' and member_message_id = ${thrown.message_id}`.execute(app.db)).rows[0]!;
  assert.equal(ledger.status, 'FAILED', '失败调用在账本里如实记为 FAILED');
});
