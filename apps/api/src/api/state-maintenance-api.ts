import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  applyStateMaintenance, interpretStateMaintenance, listStateMaintenanceRequests,
  readStateMaintenanceRequest, readUndoPlan, replyStateDecision, withdrawStateMaintenance,
  type ReadStateMaintenanceResult, type StateChangeProjection,
} from '../application/conversation-state.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { commandEnvelopeSchema, OpenObjectSchema } from './domain-schemas.js';
import { createCommandHandler, problemFromError, sendProblem, sendReadError,
  type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });

const interpretParams = Type.Object({ workspace_id: uuid, session_id: uuid }, strict);
const requestParams = Type.Object({ workspace_id: uuid, request_id: uuid }, strict);

const interpretBody = Type.Object({
  command_id: uuid,
  source_message_id: uuid,
  // 客户端本机时区：只用于把「下周」落成确切 due_local_date，不参与任何授权判断。
  timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, strict);

const decisionReplyBody = Type.Object({
  command_id: uuid,
  resolution: Type.Union([Type.Literal('ACCEPT'), Type.Literal('DECLINE')]),
  answer: Type.String({ minLength: 1, maxLength: 2000 }),
  expected_revision: Type.String(),
}, strict);

const withdrawBody = Type.Object({
  command_id: uuid,
  // 只有「原范围里有不可撤回项」时才必须先读方案再确认范围；整组可撤回时可省略。
  plan_digest: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  confirmed_change_ids: Type.Optional(Type.Array(uuid, { minItems: 1, maxItems: 12 })),
}, strict);

const changeProjectionSchema = Type.Object({
  ordinal: Type.Integer(),
  change_kind: Type.String(),
  command_id: uuid,
  status: Type.String(),
  before_ref: Type.Union([OpenObjectSchema, Type.Null()]),
  after_ref: Type.Union([OpenObjectSchema, Type.Null()]),
  error: Type.Union([OpenObjectSchema, Type.Null()]),
}, strict);

const decisionRequiredSchema = Type.Object({
  summary: Type.String(),
  question: Type.String(),
  affected: Type.Array(Type.String()),
  // null = 整组都等这个决定；数组 = 只有这些序号在等（独立修改照常生效）。
  blocked_changes: Type.Union([Type.Array(Type.Integer()), Type.Null()]),
}, strict);

/** 前端按此解析：changes 为 null 表示候选尚未产生或 DISCUSS/CLARIFY。 */
const stateMaintenanceProjection = Type.Object({
  request_id: uuid,
  session_id: uuid,
  source_message_id: uuid,
  project_id: uuid,
  decision: Type.Union([Type.Literal('DISCUSS'), Type.Literal('CLARIFY'),
    Type.Literal('MAINTAIN')]),
  status: Type.String(),
  candidate_status: Type.String(),
  questions: Type.Array(Type.String()),
  changes: Type.Union([Type.Array(changeProjectionSchema), Type.Null()]),
  decision_required: Type.Union([decisionRequiredSchema, Type.Null()]),
  // 撤回只接受请求行固化的身份；读投影必须携带它，否则会话重载后客户端无法撤回。
  undo_command_id: uuid,
  revision: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
}, strict);

const applicationResult = Type.Object({
  request_id: uuid,
  status: Type.String(),
  revision: Type.String(),
  changes: Type.Array(changeProjectionSchema),
  undo_command_id: uuid,
}, strict);

const undoPlanItemSchema = Type.Object({
  change_id: uuid,
  ordinal: Type.Integer(),
  change_kind: Type.String(),
  command_id: uuid,
  action: OpenObjectSchema,
  withdrawable: Type.Boolean(),
  reason_code: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  impact: Type.Union([Type.String(), Type.Null()]),
  facts: OpenObjectSchema,
}, strict);

/** 撤回事前预检方案（只读）：不可撤回项与影响必须在执行前可见。 */
const undoPlanSchema = Type.Object({
  request_id: uuid,
  undo_command_id: uuid,
  plan_digest: Type.String(),
  fully_withdrawable: Type.Boolean(),
  blocked_count: Type.Integer(),
  state_revision: Type.String(),
  items: Type.Array(undoPlanItemSchema),
}, strict);

function questionsOf(row: ReadStateMaintenanceResult['request']): readonly string[] {
  const raw = row.clarification === null ? undefined : row.clarification.questions;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function decisionRequiredOf(raw: JsonObject | null):
  { summary: string; question: string; affected: readonly string[];
    blocked_changes: readonly number[] | null } | null {
  if (raw === null) return null;
  const summary = raw.summary;
  const question = raw.question;
  const affected = raw.affected;
  if (typeof summary !== 'string' || typeof question !== 'string' || !Array.isArray(affected)) {
    return null;
  }
  const blocked = raw.blocked_changes;
  return { summary, question,
    affected: affected.filter((item): item is string => typeof item === 'string'),
    blocked_changes: Array.isArray(blocked)
      ? blocked.filter((item): item is number => typeof item === 'number') : null };
}

function changeProject(row: StateChangeProjection): StateChangeProjection {
  return { ordinal: row.ordinal, change_kind: row.change_kind, command_id: row.command_id,
    status: row.status, before_ref: row.before_ref, after_ref: row.after_ref, error: row.error };
}

function project(result: ReadStateMaintenanceResult) {
  const row = result.request;
  return { request_id: row.id, session_id: row.session_id,
    source_message_id: row.source_message_id, project_id: row.project_id,
    decision: row.decision, status: row.status, candidate_status: row.candidate_status,
    questions: questionsOf(row),
    changes: row.decision === 'MAINTAIN' ? result.changes.map(changeProject) : null,
    decision_required: decisionRequiredOf(row.decision_required),
    undo_command_id: row.undo_command_id,
    revision: toDecimalString(row.revision),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

/**
 * 自然语言状态维护的 HTTP 入口（总纲 §0.8.1）。
 *
 * 解释（原消息 → 候选）、应用（候选 → 逐条领域命令）与整组撤回是三个阶段；
 * 模型调用在事务外，候选先落库；应用按请求行上固定的命令身份重放，
 * 不会产生第二组对象或版本；撤回只接受请求行固化的 undo_command_id。
 */
export function registerStateMaintenanceRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.post('/assist-sessions/:session_id/state-maintenance-requests', {
    schema: { params: interpretParams, body: interpretBody,
      response: { 202: commandEnvelopeSchema(stateMaintenanceProjection) } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const body = request.body as { command_id: string; source_message_id: string;
        timezone?: string | undefined };
      const outcome = await interpretStateMaintenance(dependencies.database.executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '',
        sourceMessageId: body.source_message_id, commandId: body.command_id,
        timezone: body.timezone });
      if (outcome.replayed) reply.header('command-replayed', 'true');
      return reply.code(202).send({
        command_id: body.command_id,
        committed_at: outcome.committedAt.toISOString(),
        result: project(outcome.result),
        links: { resource: `/api/v1/workspaces/${params.workspace_id ?? ''}` +
          `/conversation-state-requests/${outcome.result.request.id}` } });
    } catch (error) {
      const commandId = (request.body as { command_id?: string } | undefined)?.command_id;
      return sendProblem(reply, problemFromError(error, commandId), request.id);
    }
  });

  app.post('/conversation-state-requests/:request_id/applications', {
    schema: { params: requestParams, body: Type.Object({}, strict),
      response: { 200: commandEnvelopeSchema(applicationResult) } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const result = await applyStateMaintenance(dependencies.database.executor, {
        workspaceId: params.workspace_id ?? '', requestId: params.request_id ?? '',
        // Slice B：完成指令沿原完成 Owner 提交时需要受管内容存储。
        storage: dependencies.storage });
      return reply.code(200).send({
        command_id: result.apply_command_id,
        committed_at: new Date().toISOString(),
        result: { request_id: result.request_id, status: result.status,
          revision: result.revision, changes: result.changes.map(changeProject),
          undo_command_id: result.undo_command_id },
        links: { resource: `/api/v1/workspaces/${params.workspace_id ?? ''}` +
          `/conversation-state-requests/${result.request_id}` } });
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.post('/conversation-state-requests/:request_id/decision-replies', {
    schema: { params: requestParams, body: decisionReplyBody,
      response: { 200: commandEnvelopeSchema(applicationResult) } },
  }, createCommandHandler(dependencies, {
    commandType: 'AnswerStateDecision',
    bodySchema: decisionReplyBody,
    execute: async ({ executor, body, params }) => {
      const result = await replyStateDecision(executor, {
        workspaceId: params.workspace_id ?? '', requestId: params.request_id ?? '',
        commandId: body.command_id, resolution: body.resolution, answer: body.answer,
        expectedRevision: body.expected_revision });
      return { outcome: { result: { request_id: result.request_id }, replayed: false,
          committedAt: new Date() },
        result: { request_id: result.request_id, status: result.status,
          revision: result.revision, changes: result.changes.map(changeProject),
          undo_command_id: result.undo_command_id } };
    },
  }));

  app.get('/conversation-state-requests/:request_id/undo-plan', {
    schema: { params: requestParams, response: { 200: undoPlanSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const plan = await readUndoPlan(dependencies.database.executor,
        params.workspace_id ?? '', params.request_id ?? '');
      return reply.code(200).send(plan);
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.post('/conversation-state-requests/:request_id/withdrawals', {
    schema: { params: requestParams, body: withdrawBody,
      response: { 200: commandEnvelopeSchema(applicationResult) } },
    }, createCommandHandler(dependencies, {
    commandType: 'WithdrawStateMaintenance',
    bodySchema: withdrawBody,
    execute: async ({ executor, body, params }) => {
      const result = await withdrawStateMaintenance(executor, {
        workspaceId: params.workspace_id ?? '', requestId: params.request_id ?? '',
        commandId: body.command_id, planDigest: body.plan_digest,
        confirmedChangeIds: body.confirmed_change_ids });
      return { outcome: { result: { request_id: result.request_id }, replayed: false,
          committedAt: new Date() },
        result: { request_id: result.request_id, status: result.status,
          revision: result.revision, changes: result.changes.map(changeProject),
          undo_command_id: result.undo_command_id } };
    },
  }));

  app.get('/conversation-state-requests', {
    schema: { querystring: Type.Object({ session_id: uuid }, strict),
      response: { 200: Type.Object({ items: Type.Array(stateMaintenanceProjection) }, strict) } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const query = request.query as { session_id?: string };
      const rows = await listStateMaintenanceRequests(dependencies.database.executor,
        params.workspace_id ?? '', query.session_id ?? '');
      return reply.code(200).send({ items: rows.map(project) });
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.get('/conversation-state-requests/:request_id', {
    schema: { params: requestParams, response: { 200: stateMaintenanceProjection } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const result = await readStateMaintenanceRequest(dependencies.database.executor,
        params.workspace_id ?? '', params.request_id ?? '');
      return reply.code(200).send(project(result));
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });
}
