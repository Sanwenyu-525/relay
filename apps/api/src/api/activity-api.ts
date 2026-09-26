import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { listActivities } from '../application/activity-queries.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const workspace = Type.Object({ workspace_id: UuidSchema }, strict);
const query = Type.Object({
  project_id: Type.Optional(UuidSchema), task_id: Type.Optional(UuidSchema),
  run_id: Type.Optional(UuidSchema), from: Type.Optional(Type.String({ maxLength: 40 })),
  to: Type.Optional(Type.String({ maxLength: 40 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
}, strict);
const ref = Type.Object({ kind: Type.String(), id: UuidSchema }, strict);
const item = Type.Object({
  id: UuidSchema, created_at: Type.String(), actor_kind: Type.String(),
  actor_ref: Type.String(), command_id: Type.Union([UuidSchema, Type.Null()]),
  event_type: Type.String(), summary: Type.String(),
  project_id: Type.Union([UuidSchema, Type.Null()]),
  task_id: Type.Union([UuidSchema, Type.Null()]),
  run_id: Type.Union([UuidSchema, Type.Null()]),
  entity_refs: Type.Array(ref),
}, strict);
const page = Type.Object({ items: Type.Array(item),
  next_cursor: Type.Union([Type.String(), Type.Null()]) }, strict);

export function registerActivityRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/activities', { schema: { params: workspace, querystring: query,
    response: { 200: page } } }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string; task_id?: string; run_id?: string;
        from?: string; to?: string; cursor?: string; limit?: string };
      return await listActivities(dependencies.database.executor, {
        workspaceId: params.workspace_id, projectId: q.project_id,
        taskId: q.task_id, runId: q.run_id, from: q.from,
        to: q.to, cursor: q.cursor,
        limit: q.limit === undefined ? undefined : Number(q.limit) });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
