import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { JsonObject } from '../infrastructure/json.js';
import { applyConversationExecution, interpretConversationMessage, isReadOnlyConversationExecution }
  from '../application/conversation-execution.js';
import { resourceNotFound } from '../application/domain-error.js';
import { createRepositories } from '../application/unit-of-work.js';
import { toDecimalString } from '../shared/decimal.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });

const interpretParams = Type.Object({ workspace_id: uuid, session_id: uuid }, strict);
const requestParams = Type.Object({ workspace_id: uuid, request_id: uuid }, strict);

const interpretBody = Type.Object({
  command_id: uuid,
  source_message_id: uuid,
  resource_id: uuid,
}, strict);

const interpretationResult = Type.Object({
  request_id: uuid,
  session_id: uuid,
  source_message_id: uuid,
  resource_id: uuid,
  root_path: Type.String(),
  decision: Type.Union([Type.Literal('DISCUSS'), Type.Literal('CLARIFY'), Type.Literal('PREPARE')]),
  status: Type.String(),
  candidate_status: Type.String(),
  questions: Type.Array(Type.String()),
  candidate: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]),
  run_id: Type.Union([uuid, Type.Null()]),
  revision: Type.String(),
  auto_start: Type.Boolean(),
}, strict);

const applyResult = Type.Object({
  request_id: uuid,
  status: Type.String(),
  task_id: Type.Union([uuid, Type.Null()]),
  run_id: Type.Union([uuid, Type.Null()]),
  revision: Type.String(),
}, strict);

const requestProjection = Type.Object({
  request_id: uuid,
  session_id: uuid,
  source_message_id: uuid,
  decision: Type.String(),
  status: Type.String(),
  candidate_status: Type.String(),
  root_path: Type.String(),
  questions: Type.Array(Type.String()),
  task_id: Type.Union([uuid, Type.Null()]),
  run_id: Type.Union([uuid, Type.Null()]),
  revision: Type.String(),
  /** 与解释回执同源：恢复/刷新后也据此判断这次只读请求是否已可直接启动。 */
  auto_start: Type.Boolean(),
  created_at: Type.String(),
  updated_at: Type.String(),
}, strict);

function project(row: {
  readonly id: string; readonly session_id: string; readonly source_message_id: string;
  readonly decision: string; readonly status: string; readonly candidate_status: string;
  readonly root_path: string; readonly clarification: { readonly questions?: unknown } | null;
  readonly candidate: JsonObject | null;
  readonly task_id: string | null; readonly run_id: string | null; readonly revision: bigint;
  readonly created_at: Date; readonly updated_at: Date;
}) {
  const raw = row.clarification?.questions;
  return { request_id: row.id, session_id: row.session_id,
    source_message_id: row.source_message_id, decision: row.decision, status: row.status,
    candidate_status: row.candidate_status, root_path: row.root_path,
    questions: Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [],
    task_id: row.task_id, run_id: row.run_id, revision: toDecimalString(row.revision),
    auto_start: isReadOnlyConversationExecution(row),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

/**
 * 工作台 §18.2 的执行请求接口。
 *
 * 解释（原消息 → 候选）与执行（候选 → Task/READY/Delegate）是两个命令：
 * 模型调用在事务外，候选先落库；Apply 按请求行上固定的命令身份重放，
 * 不会产生第二个 Task/Run，也不重新支付已保存的模型整理成本。
 */
export function registerConversationExecutionRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.post('/assist-sessions/:session_id/execution-requests', {
    schema: { params: interpretParams, body: interpretBody,
      response: { 202: commandEnvelopeSchema(interpretationResult) } },
  }, createCommandHandler(dependencies, { commandType: 'InterpretConversationMessage',
    bodySchema: interpretBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await interpretConversationMessage(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '',
        sourceMessageId: body.source_message_id, resourceId: body.resource_id,
        commandId: body.command_id,
      });
      return { outcome: { result: { request_id: outcome.result.request_id },
        replayed: outcome.replayed, committedAt: outcome.committedAt },
      result: outcome.result };
    } }));

  app.post('/conversation-execution-requests/:request_id/applications', {
    schema: { params: requestParams, body: Type.Object({}, strict),
      response: { 200: commandEnvelopeSchema(applyResult) } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const result = await applyConversationExecution(dependencies.database.executor, {
        workspaceId: params.workspace_id ?? '', requestId: params.request_id ?? '' });
      return reply.code(200).send({ command_id: params.request_id ?? '',
        committed_at: new Date().toISOString(), result,
        links: { resource: `/api/v1/workspaces/${params.workspace_id ?? ''}/conversation-execution-requests/${result.request_id}` } });
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.get('/conversation-execution-requests', {
    schema: { querystring: Type.Object({ session_id: uuid }, strict),
      response: { 200: Type.Object({ items: Type.Array(requestProjection) }, strict) } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const query = request.query as { session_id?: string };
      const rows = await createRepositories(dependencies.database.executor)
        .conversationExecutions.listSessionRequests(params.workspace_id ?? '', query.session_id ?? '');
      return reply.code(200).send({ items: rows.map(project) });
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.get('/conversation-execution-requests/:request_id', {
    schema: { params: requestParams, response: { 200: requestProjection } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      const row = await createRepositories(dependencies.database.executor)
        .conversationExecutions.readRequest(params.request_id ?? '');
      if (row === undefined || row.workspace_id !== (params.workspace_id ?? '')) {
        throw resourceNotFound('Execution request');
      }
      return reply.code(200).send(project(row));
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });
}
