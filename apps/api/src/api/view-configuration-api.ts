import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { readViewConfiguration, setViewConfiguration }
  from '../application/view-configuration-commands.js';
import { WorkspaceProjectParamsSchema, commandEnvelopeSchema }
  from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies }
  from './envelope.js';

const strict = { additionalProperties: false } as const;
const kind = Type.Union([Type.Literal('general'), Type.Literal('thesis'),
  Type.Literal('development')]);
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const viewDto = Type.Object({
  project_id: Type.String({ format: 'uuid' }), revision,
  kind, template_version: Type.String(), template_sha256: Type.String(),
  pages: Type.Array(Type.Object({ page_id: Type.String(),
    visible: Type.Boolean(), position: Type.Integer() }, strict)),
  updated_at: Type.String(),
}, strict);
const setBody = Type.Object({ command_id: Type.String({ format: 'uuid' }),
  expected_revision: revision, kind }, strict);

export function registerViewConfigurationRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/projects/:project_id/view-configuration', {
    schema: { params: WorkspaceProjectParamsSchema, response: { 200: viewDto } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; project_id: string };
      return await readViewConfiguration(dependencies.database.executor, {
        workspaceId: params.workspace_id, projectId: params.project_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/projects/:project_id/view-configuration', {
    schema: { params: WorkspaceProjectParamsSchema, body: setBody,
      response: { 200: commandEnvelopeSchema(viewDto) } },
  }, createCommandHandler(dependencies, { commandType: 'SetViewConfiguration',
    bodySchema: setBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setViewConfiguration(executor, {
        workspaceId: params.workspace_id ?? '', projectId: params.project_id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        kind: body.kind });
      return { outcome, result: outcome.result };
    } }));
}
