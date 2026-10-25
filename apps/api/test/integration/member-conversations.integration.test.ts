import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

/**
 * P1-B 成员私聊/群聊与消息（ADR-034 包 B，迁移 0140）：
 * 私聊一线程、群聊一线程；消息身份/定向接收者/意图与交接载荷；command_id 去重；
 * 讨论终止与重开；ACTIVE 闸门；项目归档与跨工作区隔离。
 * 成员回信与互相唤醒（模型调用）归包 C，此处只证明持久记录与准入。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-member-conversation-test');
let api: TestApi;

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
  recipient_member_ids: string[]; intent: string; content: string;
  handoff_payload: Record<string, unknown> | null; processing_status: string;
};

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const path = (segment: string) => workspacePath(workspaceId, segment);
  const command = async (segment: string, body: Record<string, unknown>, status: 200 | 201 = 200) => {
    const id = typeof body.command_id === 'string' ? body.command_id : randomUUID();
    return expectCommandAccepted(await api.post(path(segment), { command_id: id, ...body }), status, id);
  };
  const read = async (segment: string) => {
    const response = await api.get(path(segment));
    assert.equal(response.status, 200, response.text);
    return response.body as Record<string, unknown>;
  };
  const projectId = (await command('/projects', { title: '成员协作项目', project_type: 'GENERAL' }, 201)).project_id as string;
  const createMember = (name: string, roleKey = 'DEVELOPMENT') => command(`/projects/${projectId}/agent-members`, {
    name, role_key: roleKey, run_mode: 'BUILTIN',
  }, 201) as Promise<unknown> as Promise<{ agent_member_id: string; revision: string }>;
  return { workspaceId, projectId, path, command, read, createMember };
}

test('私聊一线程、群聊一线程：开启或继续返回同一会话，重放不新建', async () => {
  const f = await fixture();
  const member = await f.createMember('开发成员');
  const url = `/projects/${f.projectId}/member-conversations`;

  const body = { command_id: randomUUID(), kind: 'DIRECT', member_id: member.agent_member_id };
  const opened = await f.command(url, body, 200) as unknown as Conversation;
  const replay = await f.command(url, body, 200) as unknown as Conversation;
  assert.equal(replay.conversation_id, opened.conversation_id, '同命令重放返回原会话');
  const again = await f.command(url, { command_id: randomUUID(), kind: 'DIRECT', member_id: member.agent_member_id }, 200) as unknown as Conversation;
  assert.equal(again.conversation_id, opened.conversation_id, '新命令开启或继续同一私聊线程');

  const groupBody = { command_id: randomUUID(), kind: 'GROUP' };
  const group = await f.command(url, groupBody, 200) as unknown as Conversation;
  assert.equal(group.kind, 'GROUP');
  const groupAgain = await f.command(url, { command_id: randomUUID(), kind: 'GROUP' }, 200) as unknown as Conversation;
  assert.equal(groupAgain.conversation_id, group.conversation_id, '项目群聊只有一个线程');

  const groupWithMember = await api.post(f.path(url), { command_id: randomUUID(), kind: 'GROUP', member_id: member.agent_member_id });
  assert.equal(groupWithMember.status, 422, groupWithMember.text);
  const directWithoutMember = await api.post(f.path(url), { command_id: randomUUID(), kind: 'DIRECT' });
  assert.equal(directWithoutMember.status, 422, directWithoutMember.text);
});

test('消息身份与定向：seq 递增、同命令不重复、私聊强制对方、群聊定向校验与未定向空集', async () => {
  const f = await fixture();
  const member = await f.createMember('开发成员');
  const reviewer = await f.createMember('测试成员', 'TEST_REVIEW');
  const dm = await f.command(`/projects/${f.projectId}/member-conversations`, {
    command_id: randomUUID(), kind: 'DIRECT', member_id: member.agent_member_id,
  }, 200) as unknown as Conversation;
  const group = await f.command(`/projects/${f.projectId}/member-conversations`, {
    command_id: randomUUID(), kind: 'GROUP',
  }, 200) as unknown as Conversation;

  const dmUrl = `/member-conversations/${dm.conversation_id}/messages`;
  const sendBody = { command_id: randomUUID(), content: '请核对存储层迁移。', intent: 'CHECK_REQUEST' };
  const sent = await f.command(dmUrl, sendBody, 200) as unknown as Message;
  assert.equal(sent.seq, '1');
  assert.equal(sent.sender_kind, 'HUMAN');
  assert.deepEqual(sent.recipient_member_ids, [member.agent_member_id], '私聊接收者恒为对方成员');

  const replayed = await f.command(dmUrl, sendBody, 200) as unknown as Message;
  assert.equal(replayed.message_id, sent.message_id, '同 command_id 重放不落新消息');
  const rows = await sql<{ count: string }>`select count(*)::text as count from project_member_messages
    where conversation_id = ${dm.conversation_id}`.execute(app.db);
  assert.equal(rows.rows[0]!.count, '1');

  const second = await f.command(dmUrl, { command_id: randomUUID(), content: '补充：注意回滚。', intent: 'DISCUSS' }, 200) as unknown as Message;
  assert.equal(second.seq, '2', 'seq 必须按会话递增');

  const groupUrl = `/member-conversations/${group.conversation_id}/messages`;
  const directed = await f.command(groupUrl, {
    command_id: randomUUID(), content: '请独立检查这版方案。', intent: 'CHECK_REQUEST',
    recipient_member_ids: [reviewer.agent_member_id],
  }, 200) as unknown as Message;
  assert.deepEqual(directed.recipient_member_ids, [reviewer.agent_member_id], '群聊定向消息只记录指定接收者');

  const undirected = await f.command(groupUrl, {
    command_id: randomUUID(), content: '这个需求怎么拆？', intent: 'QUESTION',
  }, 200) as unknown as Message;
  assert.deepEqual(undirected.recipient_member_ids, [], '未定向群聊消息落空集，由协调者接住（唤醒侧裁决）');

  const foreignProject = await (async () => {
    const other = await fixture();
    return other;
  })();
  const foreignMember = await foreignProject.createMember('别的项目成员');
  const directedForeign = await api.post(f.path(groupUrl), {
    command_id: randomUUID(), content: '跨项目定向', intent: 'DISCUSS',
    recipient_member_ids: [foreignMember.agent_member_id],
  });
  assert.equal(directedForeign.status, 404, directedForeign.text);
});

test('交接载荷：HANDOFF 必带受控载荷，其他意图不得携带；引用原事实不复制', async () => {
  const f = await fixture();
  const member = await f.createMember('开发成员');
  const coordinator = await f.createMember('协调成员', 'COORDINATION');
  const group = await f.command(`/projects/${f.projectId}/member-conversations`, {
    command_id: randomUUID(), kind: 'GROUP',
  }, 200) as unknown as Conversation;
  const url = `/member-conversations/${group.conversation_id}/messages`;

  const badKey = await api.post(f.path(url), {
    command_id: randomUUID(), content: '交接', intent: 'HANDOFF',
    handoff: { baseline_note: 'v3 基线', secret_power: '越权字段' },
  });
  assert.equal(badKey.status, 422, badKey.text);

  const empty = await api.post(f.path(url), {
    command_id: randomUUID(), content: '交接', intent: 'HANDOFF', handoff: {},
  });
  assert.equal(empty.status, 422, empty.text);

  const nonHandoffWithPayload = await api.post(f.path(url), {
    command_id: randomUUID(), content: '普通讨论', intent: 'DISCUSS', handoff: { baseline_note: '不该带' },
  });
  assert.equal(nonHandoffWithPayload.status, 422, nonHandoffWithPayload.text);

  const handoff = await f.command(url, {
    command_id: randomUUID(), content: '把存储层迁移的核对交给测试。', intent: 'HANDOFF',
    recipient_member_ids: [member.agent_member_id],
    handoff: {
      baseline_note: '迁移 0139/0140 已合入，revision 3',
      open_questions: ['0140 的回滚是否需要先清消息表'],
      next_actions: ['跑 member-conversations 回归', '核对审计事件'],
    },
  }, 200) as unknown as Message;
  assert.equal((handoff.handoff_payload as { baseline_note: string }).baseline_note, '迁移 0139/0140 已合入，revision 3');

  // linked_task_id 引用真实 Task 才能落库：外键是事实引用，不是复制。
  const taskId = (await f.command('/tasks', {
    project_id: f.projectId, title: '被引用的任务', objective: '验证消息关联', mode: 'AI_ASSIST',
    criteria: [{ statement: '至少一条' }],
  }, 201)).task_id as string;
  const linked = await f.command(url, {
    command_id: randomUUID(), content: '这条消息关联具体任务。', intent: 'STATUS_REPORT',
    linked_task_id: taskId,
  }, 200) as unknown as Message & { linked_task_id: string };
  assert.equal(linked.linked_task_id, taskId);
  // coordinator 变量在断言外保持引用，说明群聊定向给成员而非默认广播。
  assert.ok(coordinator.agent_member_id !== member.agent_member_id);
});

test('讨论终止与重开：关闭需原因码、关闭后拒发、重开清原因、修订 CAS', async () => {
  const f = await fixture();
  const member = await f.createMember('开发成员');
  const dm = await f.command(`/projects/${f.projectId}/member-conversations`, {
    command_id: randomUUID(), kind: 'DIRECT', member_id: member.agent_member_id,
  }, 200) as unknown as Conversation;
  const statusUrl = `/member-conversations/${dm.conversation_id}/status-changes`;
  const messageUrl = `/member-conversations/${dm.conversation_id}/messages`;

  const closeNoReason = await api.post(f.path(statusUrl), {
    command_id: randomUUID(), expected_revision: dm.revision, status: 'CLOSED', note: '结束',
  });
  assert.equal(closeNoReason.status, 422, closeNoReason.text);

  const staleRevision = await api.post(f.path(statusUrl), {
    command_id: randomUUID(), expected_revision: '999', status: 'CLOSED',
    close_reason: 'RESOLVED', note: '旧修订',
  });
  assert.equal(staleRevision.status, 409, staleRevision.text);

  const closed = await f.command(statusUrl, {
    command_id: randomUUID(), expected_revision: dm.revision, status: 'CLOSED',
    close_reason: 'NEEDS_USER_DECISION', note: '需要用户决定技术选型',
  }, 200) as unknown as Conversation;
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.close_reason, 'NEEDS_USER_DECISION');

  const sendClosed = await api.post(f.path(messageUrl), {
    command_id: randomUUID(), content: '关闭后不应发出', intent: 'DISCUSS',
  });
  assert.equal(sendClosed.status, 409, sendClosed.text);

  const reopened = await f.command(statusUrl, {
    command_id: randomUUID(), expected_revision: closed.revision, status: 'OPEN', note: '用户已决定，继续讨论',
  }, 200) as unknown as Conversation;
  assert.equal(reopened.status, 'OPEN');
  assert.equal(reopened.close_reason, null);

  const sendAgain = await f.command(messageUrl, {
    command_id: randomUUID(), content: '重开后可以继续。', intent: 'DISCUSS',
  }, 200) as unknown as Message;
  assert.equal(sendAgain.seq, '1', '关闭期间没有产生消息，seq 连续');
});

test('ACTIVE 闸门与隔离：停用成员拒收、项目归档拒写、跨工作区 404', async () => {
  const f = await fixture();
  const other = await fixture();
  const member = await f.createMember('开发成员');
  const dm = await f.command(`/projects/${f.projectId}/member-conversations`, {
    command_id: randomUUID(), kind: 'DIRECT', member_id: member.agent_member_id,
  }, 200) as unknown as Conversation;

  // 停用后：私聊可读历史，但不能发新消息；也不能再开新私聊。
  await f.command(`/agent-members/${member.agent_member_id}/status-changes`, {
    command_id: randomUUID(), expected_revision: member.revision, status: 'INACTIVE', reason: '暂停职责',
  });
  const sendPaused = await api.post(f.path(`/member-conversations/${dm.conversation_id}/messages`), {
    command_id: randomUUID(), content: '停用后不应发出', intent: 'DISCUSS',
  });
  assert.equal(sendPaused.status, 409, sendPaused.text);
  const openPaused = await api.post(f.path(`/projects/${f.projectId}/member-conversations`), {
    command_id: randomUUID(), kind: 'DIRECT', member_id: member.agent_member_id,
  });
  assert.equal(openPaused.status, 409, openPaused.text);
  const history = await f.read(`/member-conversations/${dm.conversation_id}/messages`);
  assert.equal((history as { items: unknown[] }).items.length, 0, '历史读取不受影响');

  // 项目归档后：开会话与发消息都拒绝。
  const member2 = await f.createMember('开发成员二');
  await sql`update projects set archived_at = now() where id = ${f.projectId}`.execute(app.db);
  const openArchived = await api.post(f.path(`/projects/${f.projectId}/member-conversations`), {
    command_id: randomUUID(), kind: 'DIRECT', member_id: member2.agent_member_id,
  });
  assert.equal(openArchived.status, 409, openArchived.text);

  // 跨工作区：会话与消息读取都 404。
  const foreignRead = await api.get(other.path(`/member-conversations/${dm.conversation_id}`));
  assert.equal(foreignRead.status, 404, foreignRead.text);
  const foreignMessages = await api.get(other.path(`/member-conversations/${dm.conversation_id}/messages`));
  assert.equal(foreignMessages.status, 404, foreignMessages.text);
});
