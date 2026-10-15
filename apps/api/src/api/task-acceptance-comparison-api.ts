import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { freezeAcceptanceComparison, listAcceptanceComparisons } from '../application/task-acceptance-comparisons.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const params = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const bodySchema = Type.Object({ command_id: uuid, baseline_trial_id: uuid,
  expected_baseline_revision: Type.String({ pattern: '^[0-9]+$' }),
  target_reduction_percent: Type.Integer({ minimum: 1, maximum: 100 }),
  sample_scope: Type.String({ minLength: 1, maxLength: 4000 }),
}, strict);
export function registerTaskAcceptanceComparisonRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const root = '/projects/:project_id/acceptance-comparisons';
  app.post(root, { schema: { params, body: bodySchema, response: {
    200: commandEnvelopeSchema(Type.Object({ comparison_id: uuid, project_id: uuid }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'FreezeAcceptanceComparison', bodySchema,
    execute: async ({ executor, params, body }) => {
      const outcome = await freezeAcceptanceComparison(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', commandId: body.command_id, baselineTrialId: body.baseline_trial_id,
        expectedBaselineRevision: body.expected_baseline_revision,
        targetReductionPercent: body.target_reduction_percent, sampleScope: body.sample_scope });
      return { outcome, result: outcome.result };
    } }));
  app.get(root, { schema: { params } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; project_id: string };
      return await listAcceptanceComparisons(dependencies.database.executor, ids.workspace_id, ids.project_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
