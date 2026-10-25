import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import {
  listProjectMemberConversations, listProjectMemberMessages, openProjectMemberConversation,
  readProjectMemberConversation, sendProjectMemberMessage, setProjectMemberConversationStatus,
  MEMBER_CONVERSATION_CLOSE_REASONS,
} from '../application/member-conversations.js';
import type { MemberConversationCloseReason, MemberConversationKind, MemberMessageIntent } from '../application/member-conversations.js';
import { commandEnvelopeSchema, OpenObjectSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

/**
 * 成员私聊/群聊与消息的 HTTP 面（ADR-034 包 B，迁移 0140）。
 * 成员回信与互相唤醒随包 C 接入；本面只提供持久记录与人工入口。
 */
const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const workspaceParams = Type.Object({ workspace_id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const conversationParams = Type.Object({ workspace_id: uuid, id: uuid }, strict);

const openBody = Type.Object({
  command_id: uuid,
  kind: Type.Union([Type.Literal('DIRECT'), Type.Literal('GROUP')]),
  member_id: Type.Optional(uuid),
}, strict);

const intent = Type.Union(['DISCUSS', 'QUESTION', 'SUGGESTION', 'STATUS_REPORT', 'CHECK_REQUEST', 'HANDOFF']
  .map((value) => Type.Literal(value)));

const sendBody = Type.Object({
  command_id: uuid,
  content: Type.String({ minLength: 1, maxLength: 20000 }),
  intent,
  recipient_member_ids: Type.Optional(Type.Array(uuid, { maxItems: 20 })),
  handoff: Type.Optional(Type.Object({
    baseline_note: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    open_questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 })),
    next_actions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 20 })),
    artifact_version_id: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  }, strict)),
  linked_task_id: Type.Optional(uuid),
  linked_run_id: Type.Optional(uuid),
}, strict);

const statusBody = Type.Object({
  command_id: uuid, expected_revision: revision,
  status: Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED')]),
  close_reason: Type.Optional(Type.Union(MEMBER_CONVERSATION_CLOSE_REASONS.map((value) => Type.Literal(value)))),
  note: Type.String({ minLength: 1, maxLength: 4000 }),
}, strict);

const conversationResult = Type.Object({
  conversation_id: uuid, project_id: uuid,
  kind: Type.Union([Type.Literal('DIRECT'), Type.Literal('GROUP')]),
  member_id: Type.Union([uuid, Type.Null()]), title: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(), close_reason: Type.Union([Type.String(), Type.Null()]), revision,
}, strict);

const messageResult = Type.Object({
  message_id: uuid, conversation_id: uuid, seq: revision,
  sender_kind: Type.String(), sender_member_id: Type.Union([uuid, Type.Null()]),
  recipient_member_ids: Type.Array(uuid), intent: Type.String(), content: Type.String(),
  handoff_payload: Type.Union([OpenObjectSchema, Type.Null()]),
  linked_task_id: Type.Union([uuid, Type.Null()]), linked_run_id: Type.Union([uuid, Type.Null()]),
  processing_status: Type.String(),
}, strict);

export function registerMemberConversationRoutes(app: FastifyInstance, d: RouteDependencies): void {
  app.post('/projects/:project_id/member-conversations', {
    schema: { params: projectParams, body: openBody, response: { 200: commandEnvelopeSchema(conversationResult) } },
  }, createCommandHandler(d, {
    commandType: 'OpenProjectMemberConversation', bodySchema: openBody, execute: async ({ executor, params, body }) => {
      const outcome = await openProjectMemberConversation(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '', commandId: body.command_id,
        kind: body.kind as MemberConversationKind, memberId: body.member_id,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/member-conversations/:id/messages', {
    schema: { params: conversationParams, body: sendBody, response: { 200: commandEnvelopeSchema(messageResult) } },
  }, createCommandHandler(d, {
    commandType: 'SendProjectMemberMessage', bodySchema: sendBody, execute: async ({ executor, params, body }) => {
      const outcome = await sendProjectMemberMessage(executor, {
        workspaceId: params.workspace_id ?? '', conversationId: params.id ?? '', commandId: body.command_id,
        content: body.content, intent: body.intent as MemberMessageIntent,
        recipientMemberIds: body.recipient_member_ids, handoffPayload: body.handoff,
        linkedTaskId: body.linked_task_id, linkedRunId: body.linked_run_id,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/member-conversations/:id/status-changes', {
    schema: { params: conversationParams, body: statusBody, response: { 200: commandEnvelopeSchema(conversationResult) } },
  }, createCommandHandler(d, {
    commandType: 'SetProjectMemberConversationStatus', bodySchema: statusBody, execute: async ({ executor, params, body }) => {
      const outcome = await setProjectMemberConversationStatus(executor, {
        workspaceId: params.workspace_id ?? '', conversationId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, status: body.status,
        closeReason: body.close_reason as MemberConversationCloseReason | undefined, note: body.note,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.get('/projects/:project_id/member-conversations', { schema: { params: projectParams } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; project_id: string };
      return await listProjectMemberConversations(d.database.executor, p.workspace_id, p.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/member-conversations/:id', { schema: { params: conversationParams } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      return await readProjectMemberConversation(d.database.executor, p.workspace_id, p.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/member-conversations/:id/messages', {
    schema: { params: conversationParams, querystring: Type.Object({
      after_seq: Type.Optional(Type.String({ pattern: '^[0-9]+$' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, strict) },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const q = request.query as { after_seq?: string; limit?: number };
      return await listProjectMemberMessages(d.database.executor, p.workspace_id, p.id,
        q.after_seq === undefined ? null : BigInt(q.after_seq), q.limit ?? 50);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
