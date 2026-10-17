import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import { assignInboxTaskToProject } from '../application/task-project-binding.js';
import { createCommandHandler, type RouteDependencies } from './envelope.js';
import { DecimalSchema, UuidSchema, WorkspaceTaskParamsSchema, commandEnvelopeSchema } from './domain-schemas.js';

const strict = { additionalProperties: false } as const;
const Body = Type.Object({ command_id: UuidSchema, expected_revision: DecimalSchema, project_id: UuidSchema }, strict);
const Result = Type.Object({ task_id: UuidSchema, project_id: UuidSchema, status: Type.String(),
  revision: DecimalSchema, acceptance_revision: DecimalSchema }, strict);

export function registerTaskProjectBindingRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/tasks/:task_id/project-binding', { schema: {
    params: WorkspaceTaskParamsSchema, body: Body, response: { 200: commandEnvelopeSchema(Result) },
  } }, createCommandHandler(dependencies, {
    commandType: 'AssignInboxTaskToProject', bodySchema: Body,
    execute: async ({ executor, body, params }) => {
      const outcome = await assignInboxTaskToProject(executor, { workspaceId: params.workspace_id ?? '',
        taskId: params.task_id ?? '', commandId: body.command_id, expectedRevision: body.expected_revision,
        projectId: body.project_id });
      return { outcome, result: outcome.result };
    },
  }));
}
