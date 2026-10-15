import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { attachTaskAcceptanceMaterial, listTaskAcceptanceMaterials, withdrawTaskAcceptanceMaterial }
  from '../application/task-acceptance-materials.js';
import { commandEnvelopeSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]+$' });
const params = Type.Object({ workspace_id: uuid, task_id: uuid }, strict);
const attachBody = Type.Object({ command_id: uuid, expected_acceptance_revision: revision,
  knowledge_id: uuid, knowledge_version: revision,
  criterion_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
  tested_artifact_version_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  source_label: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()])),
  note: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()])),
}, strict);
const resultSchema = Type.Object({ material_id: uuid, task_id: uuid, status: Type.String(), revision }, strict);

export function registerTaskAcceptanceMaterialRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/tasks/:task_id/acceptance-materials', { schema: { params, body: attachBody,
    response: { 200: commandEnvelopeSchema(resultSchema) } } }, createCommandHandler(dependencies, {
    commandType: 'AttachTaskAcceptanceMaterial', bodySchema: attachBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await attachTaskAcceptanceMaterial(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', commandId: body.command_id,
        expectedAcceptanceRevision: body.expected_acceptance_revision,
        knowledgeId: body.knowledge_id, knowledgeVersion: body.knowledge_version,
        criterionId: body.criterion_id ?? null, testedArtifactVersionId: body.tested_artifact_version_id ?? null,
        sourceLabel: body.source_label ?? null, note: body.note ?? null });
      return { outcome, result: outcome.result };
    } }));
  app.get('/tasks/:task_id/acceptance-materials', { schema: { params } }, async (request, reply) => {
    try {
      const ids = request.params as { workspace_id: string; task_id: string };
      return await listTaskAcceptanceMaterials(dependencies.database.executor, ids.workspace_id, ids.task_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  const withdrawBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
  app.post('/tasks/:task_id/acceptance-materials/:material_id/withdrawals', {
    schema: { params: Type.Object({ workspace_id: uuid, task_id: uuid, material_id: uuid }, strict),
      body: withdrawBody, response: { 200: commandEnvelopeSchema(resultSchema) } },
  }, createCommandHandler(dependencies, { commandType: 'WithdrawTaskAcceptanceMaterial',
    bodySchema: withdrawBody, execute: async ({ executor, params, body }) => {
      const outcome = await withdrawTaskAcceptanceMaterial(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', materialId: params.material_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));
}
