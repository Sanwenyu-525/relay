import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { listPeriodPlans, proposePeriodPlan, readPeriodPlan, readTaskTimeEstimates, recordTaskTimeEstimate, resolvePeriodPlanItem } from '../application/personal-planning.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const ms = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableMs = Type.Union([ms, Type.Null()]);
const ids = Type.Array(uuid, { maxItems: 64, uniqueItems: true });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const estimateBody = Type.Object({ command_id: uuid, confirmed: Type.Literal(true), expected_task_revision: revision, expected_estimate_revision: revision,
  elapsed_ms: nullableMs, execution_ms: nullableMs, waiting_ms: nullableMs, review_ms: nullableMs, human_ms: nullableMs,
  source_note: Type.String({ minLength: 1, maxLength: 4000 }) }, strict);
const planBody = Type.Object({ command_id: uuid, title: Type.String({ minLength: 1, maxLength: 200 }),
  available_ms: Type.Integer({ minimum: 1, maximum: 604800000 }), diagnostic_ms: Type.Integer({ minimum: 1, maximum: 604800000 }),
  task_ids: Type.Array(uuid, { minItems: 1, maxItems: 64, uniqueItems: true }), mainline_task_ids: ids, goal_ids: ids }, strict);
const resolutionBody = Type.Object({ command_id: uuid, expected_revision: revision, action: Type.Union([Type.Literal('ACCEPT'), Type.Literal('REJECT')]),
  reason: Type.String({ minLength: 1, maxLength: 4000 }) }, strict);
const planResult = Type.Object({ plan_id: uuid, project_id: uuid, revision, item_id: Type.Optional(uuid), item_status: Type.Optional(Type.String()),
  created_task_id: Type.Optional(Type.Union([uuid, Type.Null()])) }, strict);
export function registerPersonalPlanningRoutes(app: FastifyInstance, d: RouteDependencies): void {
  app.post('/tasks/:id/time-estimates', { schema: { params, body: estimateBody, response: { 200: commandEnvelopeSchema(Type.Object({ task_id: uuid, estimate_id: uuid, revision }, strict)) } } },
    createCommandHandler(d, { commandType: 'RecordTaskTimeEstimate', bodySchema: estimateBody, execute: async ({ executor, params, body }) => {
      const outcome = await recordTaskTimeEstimate(executor, { workspaceId: params.workspace_id ?? '', taskId: params.id ?? '', commandId: body.command_id,
        confirmed: body.confirmed, expectedTaskRevision: body.expected_task_revision, expectedEstimateRevision: body.expected_estimate_revision, sourceNote: body.source_note,
        elapsedMs: body.elapsed_ms, executionMs: body.execution_ms, waitingMs: body.waiting_ms, reviewMs: body.review_ms, humanMs: body.human_ms });
      return { outcome, result: outcome.result };
    } }));
  app.get('/tasks/:id/time-estimates', { schema: { params } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; id: string }; return await readTaskTimeEstimates(d.database.executor, p.workspace_id, p.id); }
    catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/projects/:project_id/period-plans', { schema: { params: projectParams, body: planBody, response: { 200: commandEnvelopeSchema(planResult) } } },
    createCommandHandler(d, { commandType: 'ProposePeriodPlan', bodySchema: planBody, execute: async ({ executor, params, body }) => {
      const outcome = await proposePeriodPlan(executor, { workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '', commandId: body.command_id,
        title: body.title, availableMs: body.available_ms, diagnosticMs: body.diagnostic_ms, taskIds: body.task_ids, mainlineTaskIds: body.mainline_task_ids, goalIds: body.goal_ids });
      return { outcome, result: outcome.result };
    } }));
  app.get('/projects/:project_id/period-plans', { schema: { params: projectParams } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; project_id: string }; return await listPeriodPlans(d.database.executor, p.workspace_id, p.project_id); }
    catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/period-plans/:id', { schema: { params } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; id: string }; return await readPeriodPlan(d.database.executor, p.workspace_id, p.id); }
    catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/period-plans/:id/items/:item_id/resolutions', { schema: { params: Type.Object({ workspace_id: uuid, id: uuid, item_id: uuid }, strict), body: resolutionBody,
    response: { 200: commandEnvelopeSchema(planResult) } } }, createCommandHandler(d, { commandType: 'ResolvePeriodPlanItem', bodySchema: resolutionBody, execute: async ({ executor, params, body }) => {
      const outcome = await resolvePeriodPlanItem(executor, { workspaceId: params.workspace_id ?? '', planId: params.id ?? '', itemId: params.item_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision, action: body.action, reason: body.reason });
      return { outcome, result: outcome.result };
    } }));
}
