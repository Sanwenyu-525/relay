import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { listTaskAcceptanceTrials, recordTaskAcceptanceObservation, startTaskAcceptanceTrial,
  transitionTaskAcceptanceTrial } from '../application/task-acceptance-trials.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const taskParams = Type.Object({ workspace_id: uuid, task_id: uuid }, strict);
const trialParams = Type.Object({ workspace_id: uuid, task_id: uuid, trial_id: uuid }, strict);
const resultSchema = Type.Object({ trial_id: uuid, task_id: uuid, status: Type.String(), revision }, strict);
const startBody = Type.Object({ command_id: uuid, expected_acceptance_revision: revision,
  mode: Type.Union([Type.Literal('ORIGINAL'), Type.Literal('EVIDENCE_VIEW')]),
  sample_label: Type.String({ minLength: 1, maxLength: 1024 }),
  material_ids: Type.Optional(Type.Array(uuid, { maxItems: 64, uniqueItems: true })),
  comparison_id: Type.Optional(uuid),
}, strict);
const transitionBody = Type.Object({ command_id: uuid, expected_revision: revision,
  action: Type.Union([Type.Literal('PAUSE'), Type.Literal('RESUME'), Type.Literal('FINISH')]),
}, strict);
const ms = Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]);
const observationBody = Type.Object({ command_id: uuid, expected_revision: revision,
  preparation_ms: ms, total_acceptance_ms: ms, source_note: Type.String({ minLength: 1, maxLength: 4000 }),
  correctness_outcome: Type.Optional(Type.Union([Type.Literal('UNKNOWN'), Type.Literal('NO_ISSUE_REPORTED'), Type.Literal('ISSUE_REPORTED')])),
}, strict);

export function registerTaskAcceptanceTrialRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const root = '/tasks/:task_id/acceptance-trials';
  app.post(root, { schema: { params: taskParams, body: startBody,
    response: { 200: commandEnvelopeSchema(resultSchema) } } }, createCommandHandler(dependencies, {
    commandType: 'StartTaskAcceptanceTrial', bodySchema: startBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await startTaskAcceptanceTrial(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', commandId: body.command_id,
        expectedAcceptanceRevision: body.expected_acceptance_revision,
        mode: body.mode, sampleLabel: body.sample_label, materialIds: body.material_ids ?? [],
        ...(body.comparison_id === undefined ? {} : { comparisonId: body.comparison_id }) });
      return { outcome, result: outcome.result };
    } }));
  app.get(root, { schema: { params: taskParams } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; task_id: string };
      return await listTaskAcceptanceTrials(dependencies.database.executor, ids.workspace_id, ids.task_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post(`${root}/:trial_id/transitions`, { schema: { params: trialParams, body: transitionBody,
    response: { 200: commandEnvelopeSchema(resultSchema) } } }, createCommandHandler(dependencies, {
    commandType: 'TransitionTaskAcceptanceTrial', bodySchema: transitionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await transitionTaskAcceptanceTrial(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', trialId: params.trial_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, action: body.action });
      return { outcome, result: outcome.result };
    } }));
  app.post(`${root}/:trial_id/observations`, { schema: { params: trialParams, body: observationBody,
    response: { 200: commandEnvelopeSchema(resultSchema) } } }, createCommandHandler(dependencies, {
    commandType: 'RecordTaskAcceptanceObservation', bodySchema: observationBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await recordTaskAcceptanceObservation(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', trialId: params.trial_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, preparationMs: body.preparation_ms,
        totalAcceptanceMs: body.total_acceptance_ms, sourceNote: body.source_note,
        ...(body.correctness_outcome === undefined ? {} : { correctnessOutcome: body.correctness_outcome }) });
      return { outcome, result: outcome.result };
    } }));
}
