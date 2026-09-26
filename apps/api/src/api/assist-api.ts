import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { acceptAssistProposal, cancelAssistMessage, createAssistSession,
  rejectAssistProposal, requestAssistMessage } from '../application/assist-commands.js';
import { listAssistMessages, listAssistProposals, listAssistSessions, readAssistProposal,
  readAssistSession, projectAssistSkillMessage, readAssistLivePreview }
  from '../application/assist-queries.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const text = Type.String({ minLength: 1, maxLength: 32_768 });
const base = Type.Object({ workspace_id: uuid }, strict);
const sessionItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const proposalItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const messageItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const livePreviewItem = Type.Object({ workspace_id: uuid, id: uuid,
  message_id: uuid }, strict);

const AssistSessionDto = Type.Object({
  id: uuid, workspace_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]),
  title: Type.String(), status: Type.String(), revision: rev,
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
/** 命令回执里的会话结果（resource 以 session_id 命名，与命令契约一致）。 */
const AssistSessionResult = Type.Object({
  session_id: uuid, workspace_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]),
  title: Type.String(), status: Type.String(), revision: rev,
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
const AssistMessageDto = Type.Object({
  id: uuid, session_id: uuid, seq: rev, role: Type.String(), status: Type.String(),
  intent: Type.String(), content: Type.Union([Type.String(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  sources: Type.Array(Type.Object({}, { additionalProperties: true })),
  skill: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  skill_input: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  skill_output: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  provider_request_id: Type.Union([Type.String(), Type.Null()]),
  usage: Type.Object({ input_tokens: Type.Union([Type.Integer(), Type.Null()]),
    output_tokens: Type.Union([Type.Integer(), Type.Null()]) }, strict),
  cancel_requested: Type.Boolean(),
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
const AssistLivePreviewDto = Type.Object({
  session_id: uuid, message_id: uuid,
  status: Type.Union([Type.Literal('PENDING'), Type.Literal('RUNNING'),
    Type.Literal('COMPLETED'), Type.Literal('FAILED'), Type.Literal('CANCELLED')]),
  preview_revision: rev, preview_text: Type.Union([Type.String(), Type.Null()]),
  preview_truncated: Type.Boolean(), preview_available: Type.Boolean(),
}, strict);
const AssistProposalDto = Type.Object({
  id: uuid, workspace_id: uuid, session_id: uuid, message_id: uuid,
  kind: Type.String(), project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]), target_type: Type.String(), target_id: uuid,
  base_revision: rev, payload: Type.Object({}, { additionalProperties: true }),
  base_acceptance_revision: Type.Union([rev, Type.Null()]),
  payload_hash: Type.String(), payload_available: Type.Boolean(),
  skill_sha256: Type.Union([Type.String(), Type.Null()]),
  skill_output_sha256: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  decision: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  created_at: Type.String(), decided_at: Type.Union([Type.String(), Type.Null()]),
  updated_at: Type.String(),
}, strict);

const createSessionBody = Type.Object({
  command_id: uuid,
  project_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  task_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  title: Type.String({ minLength: 1, maxLength: 200 }),
}, strict);
const sessionsQuery = Type.Object({
  project_id: Type.Optional(uuid), task_id: Type.Optional(uuid),
}, strict);
const messagesQuery = Type.Object({ limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]{1,2}|200)$' })) }, strict);
const sourceRef = Type.Object({
  kind: Type.Union([Type.Literal('KNOWLEDGE'), Type.Literal('MEMORY'), Type.Literal('DECISION')]),
  root_id: uuid, version: Type.String({ pattern: '^[1-9][0-9]*$' }),
}, strict);
const requestMessageBody = Type.Object({
  command_id: uuid, content: text,
  intent: Type.Optional(Type.Union([Type.Literal('DISCUSS'), Type.Literal('PROPOSE_CANDIDATE'),
    Type.Literal('PROPOSE_TASK')])),
  source_refs: Type.Optional(Type.Array(sourceRef, { maxItems: 10 })),
  skill_ref: Type.Optional(Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }),
    version: Type.String({ minLength: 1, maxLength: 32 }) }, strict)),
  skill_input: Type.Optional(Type.Object({}, { additionalProperties: true })),
}, strict);
const cancelBody = Type.Object({ command_id: uuid }, strict);
const proposalsQuery = Type.Object({
  session_id: Type.Optional(uuid), status: Type.Optional(Type.String()), kind: Type.Optional(Type.String()),
}, strict);
const proposalDecisionBody = Type.Object({ command_id: uuid }, strict);
const proposalAcceptBody = Type.Object({ command_id: uuid,
  expected_task_revision: Type.Optional(rev),
  expected_acceptance_revision: Type.Optional(rev),
  payload_hash: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
}, strict);

function sessionDto(row: { id: string; workspace_id: string; project_id: string | null;
  task_id: string | null; title: string; status: string; revision: bigint;
  created_at: Date; updated_at: Date }) {
  return {
    id: row.id, workspace_id: row.workspace_id, project_id: row.project_id,
    task_id: row.task_id, title: row.title, status: row.status,
    revision: toDecimalString(row.revision),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function messageDto(row: { id: string; session_id: string; seq: bigint; role: string;
  status: string; intent: string; content: string | null; error_code: string | null;
  sources: unknown; provider_request_id: string | null; usage_input_tokens: number | null;
  usage_output_tokens: number | null; cancel_requested: boolean; created_at: Date; updated_at: Date },
  projection: { skill: JsonObject | null; skill_input: JsonObject | null;
    skill_output: JsonObject | null; content: string | null; sources: unknown }) {
  return {
    id: row.id, session_id: row.session_id, seq: toDecimalString(row.seq), role: row.role,
    status: row.status, intent: row.intent, content: projection.content,
    error_code: row.error_code, sources: projection.sources,
    skill: projection.skill, skill_input: projection.skill_input,
    skill_output: projection.skill_output, provider_request_id: row.provider_request_id,
    usage: { input_tokens: row.usage_input_tokens, output_tokens: row.usage_output_tokens },
    cancel_requested: row.cancel_requested,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function proposalDto(row: { id: string; workspace_id: string; session_id: string;
  message_id: string; kind: string; project_id: string | null; task_id: string | null;
  target_type: string; target_id: string; base_revision: bigint; payload: unknown;
  base_acceptance_revision: bigint | null; payload_hash: string;
  payload_available: boolean; skill_sha256: string | null;
  skill_output_sha256: string | null;
  status: string; decision: unknown; created_at: Date;
  decided_at: Date | null; updated_at: Date }) {
  return {
    id: row.id, workspace_id: row.workspace_id, session_id: row.session_id,
    message_id: row.message_id, kind: row.kind, project_id: row.project_id,
    task_id: row.task_id, target_type: row.target_type, target_id: row.target_id,
    base_revision: toDecimalString(row.base_revision), payload: row.payload,
    base_acceptance_revision: row.base_acceptance_revision === null ? null :
      toDecimalString(row.base_acceptance_revision),
    payload_hash: row.payload_hash, payload_available: row.payload_available,
    skill_sha256: row.skill_sha256,
    skill_output_sha256: row.skill_output_sha256,
    status: row.status, decision: row.decision,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at === null ? null : row.decided_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function registerAssistRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/assist-sessions', { schema: { params: base, body: createSessionBody,
    response: { 201: commandEnvelopeSchema(AssistSessionResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateAssistSession',
    bodySchema: createSessionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createAssistSession(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        ...(body.project_id === undefined ? {} : { projectId: body.project_id }),
        ...(body.task_id === undefined ? {} : { taskId: body.task_id }),
        title: body.title,
      });
      return { outcome, result: outcome.result };
    } }));

  app.get('/assist-sessions', { schema: { params: base, querystring: sessionsQuery } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string; task_id?: string };
      const rows = await listAssistSessions(dependencies.database.executor, {
        workspaceId: p.workspace_id,
        ...(q.project_id === undefined ? {} : { projectId: q.project_id }),
        ...(q.task_id === undefined ? {} : { taskId: q.task_id }),
      });
      return { items: rows.map(sessionDto) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-sessions/:id', { schema: { params: sessionItem,
    response: { 200: AssistSessionDto } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const session = await readAssistSession(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '' });
      return sessionDto(session);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  // 异步生成：202 只代表消息已排队；回复以 GET messages 的 ASSISTANT 行状态为准。
  app.post('/assist-sessions/:id/messages', { schema: { params: sessionItem,
    body: requestMessageBody,
    response: { 202: commandEnvelopeSchema(Type.Object({
      session_id: uuid, user_message_id: uuid, assistant_message_id: uuid,
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'RequestAssistMessage',
    bodySchema: requestMessageBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await requestAssistMessage(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, content: body.content,
        ...(body.intent === undefined ? {} : { intent: body.intent }),
        ...(body.source_refs === undefined ? {} : { sourceRefs: body.source_refs }),
        ...(body.skill_ref === undefined ? {} : { skillRef: body.skill_ref }),
        ...(body.skill_input === undefined ? {} : { skillInput: body.skill_input }),
      });
      return { outcome, result: outcome.result };
    } }));

  app.get('/assist-sessions/:id/messages', { schema: { params: sessionItem,
    querystring: messagesQuery } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const q = request.query as { limit?: string };
      const rows = await listAssistMessages(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '',
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
      });
      const session = await readAssistSession(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '' });
      return { items: await Promise.all(rows.map(async (row) => messageDto(row,
        await projectAssistSkillMessage(dependencies.database.executor,
          dependencies.storage, session, row)))) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-sessions/:id/messages/:message_id/live-preview', {
    schema: { params: livePreviewItem, response: { 200: AssistLivePreviewDto } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string;
        message_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readAssistLivePreview(dependencies.database.executor,
        dependencies.storage, { workspaceId: p.workspace_id, sessionId: p.id,
          messageId: p.message_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/assist-messages/:id/cancel', { schema: { params: messageItem, body: cancelBody,
    response: { 200: commandEnvelopeSchema(Type.Object({
      message_id: uuid, status: Type.String(),
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'CancelAssistMessage',
    bodySchema: cancelBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await cancelAssistMessage(executor, {
        workspaceId: params.workspace_id ?? '', messageId: params.id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  app.get('/assist-proposals', { schema: { params: base, querystring: proposalsQuery } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { session_id?: string; status?: string; kind?: string };
      const rows = await listAssistProposals(dependencies.database.executor,
        dependencies.storage, {
        workspaceId: p.workspace_id,
        ...(q.session_id === undefined ? {} : { sessionId: q.session_id }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.kind === undefined ? {} : { kind: q.kind }),
      });
      return { items: rows.map(proposalDto) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-proposals/:id', { schema: { params: proposalItem,
    response: { 200: AssistProposalDto } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const row = await readAssistProposal(dependencies.database.executor,
        dependencies.storage, {
        workspaceId: p.workspace_id, proposalId: p.id ?? '' });
      return proposalDto(row);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/assist-proposals/:id/accept', { schema: { params: proposalItem,
    body: proposalAcceptBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'AcceptAssistProposal',
    bodySchema: proposalAcceptBody,
    execute: async ({ dependencies: routeDependencies, executor, params, body }) => {
      const outcome = await acceptAssistProposal(executor, {
        workspaceId: params.workspace_id ?? '', proposalId: params.id ?? '',
        commandId: body.command_id, storage: routeDependencies.storage,
        ...(body.expected_task_revision === undefined ? {} :
          { expectedTaskRevision: body.expected_task_revision }),
        ...(body.expected_acceptance_revision === undefined ? {} :
          { expectedAcceptanceRevision: body.expected_acceptance_revision }),
        ...(body.payload_hash === undefined ? {} : { payloadHash: body.payload_hash }) });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-proposals/:id/reject', { schema: { params: proposalItem,
    body: proposalDecisionBody,
    response: { 200: commandEnvelopeSchema(Type.Object({
      proposal_id: uuid, status: Type.String(),
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'RejectAssistProposal',
    bodySchema: proposalDecisionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await rejectAssistProposal(executor, {
        workspaceId: params.workspace_id ?? '', proposalId: params.id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));
}
