import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { listScopeSimulations, proposeScopeSimulation, readScopeSimulation, selectScopeSimulation } from '../application/plan-scope-simulations.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const taskIds = Type.Array(uuid, { maxItems: 64, uniqueItems: true });
const option = Type.Union([Type.Literal('ALL'), Type.Literal('SHRINK'), Type.Literal('DEFER')]);
const createBody = Type.Object({ command_id: uuid, expected_revision: revision, keep_task_ids: Type.Array(uuid, { minItems: 1, maxItems: 64, uniqueItems: true }),
  defer_task_ids: Type.Array(uuid, { minItems: 1, maxItems: 64, uniqueItems: true }), unreliable_task_ids: taskIds }, strict);
const selectionBody = Type.Object({ command_id: uuid, expected_revision: revision, option, confirmed: Type.Literal(true), reason: Type.String({ minLength: 1, maxLength: 4000 }) }, strict);
const result = Type.Object({ simulation_id: uuid, source_plan_id: uuid, project_id: uuid, revision, status: Type.Union([Type.Literal('PROPOSED'), Type.Literal('SELECTED')]),
  selected_option: Type.Union([option, Type.Null()]), selected_plan_id: Type.Union([uuid, Type.Null()]) }, strict);
const response = { 200: commandEnvelopeSchema(result) };
export function registerScopeSimulationRoutes(app: FastifyInstance, d: RouteDependencies): void {
  app.post('/period-plans/:id/scope-simulations', { schema: { params, body: createBody, response } }, createCommandHandler(d, {
    commandType: 'ProposeScopeSimulation', bodySchema: createBody, execute: async ({ executor, params, body }) => {
      const outcome = await proposeScopeSimulation(executor, { workspaceId: params.workspace_id ?? '', planId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, keepTaskIds: body.keep_task_ids, deferTaskIds: body.defer_task_ids, unreliableTaskIds: body.unreliable_task_ids });
      return { outcome, result: outcome.result };
    } }));
  app.post('/scope-simulations/:id/selections', { schema: { params, body: selectionBody, response } }, createCommandHandler(d, {
    commandType: 'SelectScopeSimulation', bodySchema: selectionBody, execute: async ({ executor, params, body }) => {
      const outcome = await selectScopeSimulation(executor, { workspaceId: params.workspace_id ?? '', simulationId: params.id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, option: body.option, confirmed: body.confirmed, reason: body.reason });
      return { outcome, result: outcome.result };
    } }));
  app.get('/scope-simulations/:id', { schema: { params } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; id: string }; return await readScopeSimulation(d.database.executor, p.workspace_id, p.id); }
    catch (e) { return sendReadError(reply, e, request.id); }
  });
  app.get('/period-plans/:id/scope-simulations', { schema: { params } }, async (request, reply) => {
    try { const p = request.params as { workspace_id: string; id: string }; return await listScopeSimulations(d.database.executor, p.workspace_id, p.id); }
    catch (e) { return sendReadError(reply, e, request.id); }
  });
}
