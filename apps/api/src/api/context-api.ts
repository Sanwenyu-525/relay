import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { listRunContextManifests, readRunContextManifest }
  from '../application/context-queries.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const uuid = Type.String({ format: 'uuid' });
const runParams = Type.Object({ workspace_id: uuid, run_id: uuid }, { additionalProperties: false });
const manifestParams = Type.Object({ workspace_id: uuid, run_id: uuid, manifest_id: uuid },
  { additionalProperties: false });

export function registerContextRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/runs/:run_id/context-manifests', { schema: { params: runParams } }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; run_id: string };
      return await listRunContextManifests(dependencies.database.executor,
        params.workspace_id, params.run_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/runs/:run_id/context-manifests/:manifest_id',
    { schema: { params: manifestParams } }, async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; run_id: string; manifest_id: string };
        return await readRunContextManifest(dependencies.database.executor, dependencies.storage,
          params.workspace_id, params.run_id, params.manifest_id);
      } catch (error) { return sendReadError(reply, error, request.id); }
    });
}
