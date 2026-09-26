import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { readArtifactLineage } from '../application/lineage-queries.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const availability = Type.Union([Type.Literal('AVAILABLE'), Type.Literal('UNAVAILABLE')]);
const edge = Type.Object({ id: UuidSchema, relation: Type.String(), parent_kind: Type.String(),
  parent_id: Type.Union([UuidSchema, Type.Null()]), availability,
  created_at: Type.String() }, strict);
const lineage = Type.Object({ artifact_version_id: UuidSchema, artifact_id: UuidSchema,
  version_number: Type.String(), sha256: Type.String(), source_kind: Type.String(),
  content_availability: availability, direct_parents: Type.Array(edge) }, strict);

export function registerLineageRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/artifact-versions/:artifact_version_id/lineage', {
    schema: { params: Type.Object({ workspace_id: UuidSchema,
      artifact_version_id: UuidSchema }, strict), response: { 200: lineage } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; artifact_version_id: string };
      return await readArtifactLineage(dependencies.database.executor, dependencies.storage,
        p.workspace_id, p.artifact_version_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
