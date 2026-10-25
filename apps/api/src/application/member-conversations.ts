import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type {
  MemberConversationKind, MemberConversationRow, MemberMessageIntent, MemberMessageRow,
} from '../team/member-conversation-repository.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace, requireWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

/**
 * 成员私聊、群聊与消息的应用 Owner（ADR-034 包 B，迁移 0140）。
 *
 * 消息只是协作记录：投递不等于任务领取，成员回信与互相唤醒随包 C 接入；
 * 定向接收者在消息行上持久化——群聊未定向消息按规则由协调者接住，唤醒侧
 * （包 C）据此决定只唤醒谁，绝不默认广播全员。讨论终止用会话级状态表达，
 * 关闭保留记录、可重开；去重靠 command_id 回执，不依赖前端本地状态。
 */

export type { MemberConversationKind, MemberMessageIntent } from '../team/member-conversation-repository.js';

export const MEMBER_CONVERSATION_CLOSE_REASONS = [
  'RESOLVED', 'INSUFFICIENT_INFO', 'NO_NEW_EVIDENCE', 'NEEDS_USER_DECISION', 'TECHNICAL_BOUNDARY', 'NO_PROGRESS',
] as const;
export type MemberConversationCloseReason = (typeof MEMBER_CONVERSATION_CLOSE_REASONS)[number];

const MESSAGE_INTENTS = new Set<MemberMessageIntent>(['DISCUSS', 'QUESTION', 'SUGGESTION', 'STATUS_REPORT', 'CHECK_REQUEST', 'HANDOFF']);
const HANDOFF_PAYLOAD_KEYS = new Set(['baseline_note', 'open_questions', 'next_actions', 'artifact_version_id']);

type Scope = { readonly workspaceId: string; readonly commandId: string };

async function authority(r: Repositories, workspaceId: string): Promise<void> {
  if (await r.workspaces.lockAuthority(workspaceId, 'share') === undefined) throw resourceNotFound('Workspace');
}

function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw validationFailed([{ field, message: `需要 ${min}–${max} 字。` }]);
  }
  return value.trim();
}

/** 交接载荷只引用原事实：键词表封闭，不复制业务状态（Task/Run/产物归原 Owner）。 */
function requireHandoffPayload(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationFailed([{ field: 'handoff', message: '交接需要对象载荷。' }]);
  }
  const payload: Record<string, string | readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!HANDOFF_PAYLOAD_KEYS.has(key)) {
      throw validationFailed([{ field: 'handoff', message: `交接载荷不支持字段 ${key}。` }]);
    }
    if (key === 'baseline_note' || key === 'artifact_version_id') {
      payload[key] = requireText(item, `handoff.${key}`, 1, 2000);
    } else {
      if (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 2000)) {
        throw validationFailed([{ field: `handoff.${key}`, message: '需要非空字符串数组。' }]);
      }
      payload[key] = item;
    }
  }
  if (Object.keys(payload).length === 0) {
    throw validationFailed([{ field: 'handoff', message: '交接至少携带基线说明、未决问题或下一步之一。' }]);
  }
  return payload;
}

async function requireProjectMember(r: Repositories, workspaceId: string, projectId: string, memberId: string, options: { readonly requireActive: boolean }): Promise<void> {
  const member = await r.agentMembers.read(memberId, true);
  if (member?.workspace_id !== workspaceId || member.project_id !== projectId) throw resourceNotFound('AgentMember');
  if (options.requireActive && member.status !== 'ACTIVE') {
    throw invalidTransition('成员已停用或归档，不能接收新的消息或被指定为接收者。');
  }
}

const conversationView = (row: MemberConversationRow) => ({
  conversation_id: row.id, project_id: row.project_id, kind: row.kind, member_id: row.member_id,
  title: row.title, status: row.status, close_reason: row.close_reason,
  revision: row.revision.toString(), created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
});

const messageView = (row: MemberMessageRow) => ({
  message_id: row.id, conversation_id: row.conversation_id, seq: row.seq.toString(),
  sender_kind: row.sender_kind, sender_member_id: row.sender_member_id,
  recipient_member_ids: row.recipient_member_ids, intent: row.intent, content: row.content,
  handoff_payload: row.handoff_payload, linked_task_id: row.linked_task_id, linked_run_id: row.linked_run_id,
  processing_status: row.processing_status, created_at: row.created_at.toISOString(),
});

export interface OpenMemberConversationInput {
  readonly projectId: string;
  readonly kind: MemberConversationKind;
  readonly memberId: string | undefined;
}

export async function openProjectMemberConversation(db: DbExecutor, input: Scope & OpenMemberConversationInput) {
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'OpenProjectMemberConversation',
    target: { project_id: input.projectId, kind: input.kind },
    body: { kind: input.kind, member_id: input.memberId ?? null },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      await lockWritableProjectInWorkspace(r, input.workspaceId, input.projectId);
      if (input.kind === 'DIRECT') {
        if (input.memberId === undefined) throw validationFailed([{ field: 'member_id', message: '私聊需要指定成员。' }]);
        await requireProjectMember(r, input.workspaceId, input.projectId, input.memberId, { requireActive: true });
      } else if (input.memberId !== undefined) {
        throw validationFailed([{ field: 'member_id', message: '群聊不绑定单个成员。' }]);
      }
      const conversation = await r.memberConversations.insertOrExisting({
        id: randomUUID(), workspace_id: input.workspaceId, project_id: input.projectId,
        kind: input.kind, member_id: input.kind === 'DIRECT' ? input.memberId! : null,
        title: input.kind === 'GROUP' ? '项目群聊' : null,
      });
      return conversationView(conversation);
    },
  });
}

export interface SendMemberMessageInput {
  readonly conversationId: string;
  readonly content: string;
  readonly intent: MemberMessageIntent;
  readonly recipientMemberIds: readonly string[] | undefined;
  readonly handoffPayload: unknown;
  readonly linkedTaskId: string | undefined;
  readonly linkedRunId: string | undefined;
}

export async function sendProjectMemberMessage(db: DbExecutor, input: Scope & SendMemberMessageInput) {
  const content = requireText(input.content, 'content', 1, 20000);
  if (!MESSAGE_INTENTS.has(input.intent)) {
    throw validationFailed([{ field: 'intent', message: '意图需要是 DISCUSS/QUESTION/SUGGESTION/STATUS_REPORT/CHECK_REQUEST/HANDOFF 之一。' }]);
  }
  const handoff = input.intent === 'HANDOFF' ? requireHandoffPayload(input.handoffPayload) : null;
  if (input.intent !== 'HANDOFF' && input.handoffPayload !== undefined && input.handoffPayload !== null) {
    throw validationFailed([{ field: 'handoff', message: '只有交接意图可以携带交接载荷。' }]);
  }
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'SendProjectMemberMessage',
    target: { conversation_id: input.conversationId },
    body: {
      content, intent: input.intent,
      ...(input.recipientMemberIds === undefined ? {} : { recipient_member_ids: input.recipientMemberIds }),
      ...(handoff === null ? {} : { handoff: handoff }),
      ...(input.linkedTaskId === undefined ? {} : { linked_task_id: input.linkedTaskId }),
      ...(input.linkedRunId === undefined ? {} : { linked_run_id: input.linkedRunId }),
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const conversation = await r.memberConversations.read(input.conversationId, true);
      if (conversation?.workspace_id !== input.workspaceId) throw resourceNotFound('MemberConversation');
      await lockWritableProjectInWorkspace(r, input.workspaceId, conversation.project_id);
      if (conversation.status !== 'OPEN') {
        throw invalidTransition('这场讨论已结束；需要继续时先重新开启。');
      }

      // 定向接收者：私聊恒为对方成员；群聊定向子集必须都是本项目的启用成员，
      // 空集＝未定向，由协调者接住（唤醒侧按此裁决，见包 C）。
      let recipients: readonly string[];
      if (conversation.kind === 'DIRECT') {
        await requireProjectMember(r, input.workspaceId, conversation.project_id, conversation.member_id!, { requireActive: true });
        recipients = [conversation.member_id!];
      } else {
        recipients = input.recipientMemberIds ?? [];
        for (const memberId of recipients) {
          await requireProjectMember(r, input.workspaceId, conversation.project_id, memberId, { requireActive: true });
        }
      }

      const seq = await r.memberConversations.nextSeq(conversation.id);
      const message = await r.memberConversations.insertMessage({
        id: randomUUID(), conversation_id: conversation.id, workspace_id: input.workspaceId,
        project_id: conversation.project_id, seq, sender_kind: 'HUMAN', sender_member_id: null,
        recipient_member_ids: recipients, intent: input.intent, content, handoff_payload: handoff,
        linked_task_id: input.linkedTaskId ?? null, linked_run_id: input.linkedRunId ?? null,
      });
      await r.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: input.workspaceId, projectId: conversation.project_id, taskId: null,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, eventType: 'MEMBER_MESSAGE_SENT',
        factRefs: { conversation_id: conversation.id, message_id: message.id, intent: input.intent, seq: seq.toString() },
      });
      return messageView(message);
    },
  });
}

export interface SetMemberConversationStatusInput {
  readonly conversationId: string;
  readonly expectedRevision: string;
  readonly status: 'OPEN' | 'CLOSED';
  readonly closeReason: MemberConversationCloseReason | undefined;
  readonly note: string;
}

export async function setProjectMemberConversationStatus(db: DbExecutor, input: Scope & SetMemberConversationStatusInput) {
  const note = requireText(input.note, 'note', 1, 4000);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'SetProjectMemberConversationStatus',
    target: { conversation_id: input.conversationId },
    body: {
      expected_revision: input.expectedRevision, status: input.status,
      ...(input.closeReason === undefined ? {} : { close_reason: input.closeReason }), note,
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const conversation = await r.memberConversations.read(input.conversationId, true);
      if (conversation?.workspace_id !== input.workspaceId) throw resourceNotFound('MemberConversation');
      await lockWritableProjectInWorkspace(r, input.workspaceId, conversation.project_id);
      if (conversation.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'MEMBER_CONVERSATION', expectedRevision: input.expectedRevision, actualRevision: conversation.revision.toString() });
      }
      if (conversation.status === input.status) throw invalidTransition('状态没有变化，请读回当前结果。');
      if (input.status === 'CLOSED' && input.closeReason === undefined) {
        throw validationFailed([{ field: 'close_reason', message: '结束讨论需要给出原因码。' }]);
      }
      if (input.status === 'OPEN' && input.closeReason !== undefined) {
        throw validationFailed([{ field: 'close_reason', message: '重新开启不携带结束原因。' }]);
      }
      const updated = input.status === 'CLOSED'
        ? await r.memberConversations.close(conversation.id, input.closeReason!)
        : await r.memberConversations.reopen(conversation.id);
      await r.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: input.workspaceId, projectId: conversation.project_id, taskId: null,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, eventType: 'MEMBER_CONVERSATION_STATUS_CHANGED',
        factRefs: { conversation_id: updated.id, status: updated.status, close_reason: updated.close_reason, note },
      });
      return conversationView(updated);
    },
  });
}

export async function listProjectMemberConversations(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await requireWorkspace(r, workspaceId);
    await readProjectInWorkspace(r, workspaceId, projectId);
    const conversations = await r.memberConversations.list(workspaceId, projectId);
    const members = new Map((await r.agentMembers.list(workspaceId, projectId)).map((member) => [member.id, member]));
    const items = [];
    for (const conversation of conversations) {
      const member = conversation.member_id === null ? undefined : members.get(conversation.member_id);
      items.push({
        ...conversationView(conversation),
        member: member === undefined ? null
          : { agent_member_id: member.id, name: member.name, role_key: member.role_key, status: member.status },
      });
    }
    return { project_id: projectId, items };
  });
}

export async function readProjectMemberConversation(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const conversation = await r.memberConversations.read(id);
    if (conversation?.workspace_id !== workspaceId) throw resourceNotFound('MemberConversation');
    const project = await readProjectInWorkspace(r, workspaceId, conversation.project_id);
    const member = conversation.member_id === null ? undefined : await r.agentMembers.read(conversation.member_id);
    return {
      ...conversationView(conversation),
      project: { title: project.title, revision: project.revision.toString(), archived: project.archived_at !== null },
      member: member === undefined || member === null
        ? null
        : { agent_member_id: member.id, name: member.name, role_key: member.role_key, status: member.status },
    };
  });
}

export async function listProjectMemberMessages(
  db: DbExecutor, workspaceId: string, conversationId: string, afterSeq: bigint | null, limit: number,
) {
  return withTransaction(db, async (r) => {
    const conversation = await r.memberConversations.read(conversationId);
    if (conversation?.workspace_id !== workspaceId) throw resourceNotFound('MemberConversation');
    await readProjectInWorkspace(r, workspaceId, conversation.project_id);
    const rows = await r.memberConversations.messages(conversationId, afterSeq, limit);
    return {
      conversation_id: conversationId,
      items: rows.map(messageView),
      next_after_seq: rows.length === limit ? rows[rows.length - 1]!.seq.toString() : null,
    };
  });
}
