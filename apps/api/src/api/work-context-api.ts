import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { readDirectoryWorkContext, readGoalWorkContext } from '../application/work-context-queries.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const uuid = Type.String({ format: 'uuid' });
const strict = { additionalProperties: false } as const;
const goalParams = Type.Object({ workspace_id: uuid, goal_id: uuid }, strict);
const directoryParams = Type.Object({ workspace_id: uuid, resource_id: uuid }, strict);
const query = Type.Object({ status: Type.Optional(Type.String()) }, strict);
const revision = Type.String({ pattern: '^[0-9]{1,19}$' });
const session = Type.Object({
  id: uuid, project_id: uuid, title: Type.String(), status: Type.String(),
  revision, working_resource_id: Type.Union([uuid, Type.Null()]),
}, strict);
const directory = Type.Object({
  id: uuid, canonical_root: Type.String(), status: Type.String(), revision,
}, strict);
const project = Type.Object({
  id: uuid, title: Type.String(), project_type: Type.String(),
  archive_status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
  archived_at: Type.Union([Type.String(), Type.Null()]), revision,
}, strict);
const goalLink = Type.Object({ id: uuid, title: Type.String(), status: Type.String(), revision }, strict);

const goalContext = Type.Object({
  kind: Type.Literal('GOAL'),
  goal: Type.Object({ id: uuid, title: Type.String(), description: Type.String(), status: Type.String(), revision }, strict),
  projects: Type.Array(Type.Object({ ...project.properties, directories: Type.Array(directory) }, strict)),
  sessions: Type.Array(session),
}, strict);
const directoryContext = Type.Object({
  kind: Type.Literal('DIRECTORY'),
  directory: Type.Object({ ...directory.properties, project }, strict),
  linked_goals: Type.Array(goalLink), sessions: Type.Array(session),
}, strict);

/** Read-only Goal and managed-directory work-context projections. */
export function registerWorkContextRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/goals/:goal_id/work-context', {
    schema: { params: goalParams, querystring: query, response: { 200: goalContext } },
  }, async (request, reply) => {
    try {
      const params = request.params as Static<typeof goalParams>;
      const search = request.query as Static<typeof query>;
      return await readGoalWorkContext(dependencies.database.executor,
        params.workspace_id, params.goal_id, search.status);
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.get('/working-directories/:resource_id/work-context', {
    schema: { params: directoryParams, querystring: query, response: { 200: directoryContext } },
  }, async (request, reply) => {
    try {
      const params = request.params as Static<typeof directoryParams>;
      const search = request.query as Static<typeof query>;
      return await readDirectoryWorkContext(dependencies.database.executor,
        params.workspace_id, params.resource_id, search.status);
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });
}
