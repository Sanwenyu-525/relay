import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { archiveGoal, editGoal } from '../application/goal-commands.js';
import { editProjectPresentation } from '../application/project-presentation-commands.js';
import { createCommandHandler, type RouteDependencies } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^[0-9]{1,19}$' });
const goalParams = Type.Object({ workspace_id: uuid, goal_id: uuid }, strict);
const projectParams = Type.Object({ workspace_id: uuid, project_id: uuid }, strict);
const editGoalBody = Type.Object({ command_id: uuid, expected_revision: revision,
  title: Type.String(), description: Type.String() }, strict);
const archiveGoalBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
const editProjectBody = Type.Object({ command_id: uuid, expected_revision: revision,
  title: Type.String() }, strict);
const editGoalResult = Type.Object({ goal_id: uuid, title: Type.String(), description: Type.String(),
  status: Type.Literal('ACTIVE'), revision }, strict);
const archiveGoalResult = Type.Object({ goal_id: uuid, status: Type.Literal('ARCHIVED'), revision }, strict);
const editProjectResult = Type.Object({ project_id: uuid, title: Type.String(), revision }, strict);

export function registerProjectMaintenanceRoutes(
  app: FastifyInstance, dependencies: RouteDependencies,
): void {
  app.post('/goals/:goal_id/revisions', {
    schema: { params: goalParams, body: editGoalBody, response: { 200: commandEnvelopeSchema(editGoalResult) } },
  }, createCommandHandler(dependencies, {
    commandType: 'EditGoal', bodySchema: editGoalBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await editGoal(executor, { workspaceId: params.workspace_id ?? '',
        goalId: params.goal_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, title: body.title, description: body.description });
      return { outcome, result: outcome.result };
    },
  }));

  app.post('/goals/:goal_id/archive', {
    schema: { params: goalParams, body: archiveGoalBody, response: { 200: commandEnvelopeSchema(archiveGoalResult) } },
  }, createCommandHandler(dependencies, {
    commandType: 'ArchiveGoal', bodySchema: archiveGoalBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await archiveGoal(executor, { workspaceId: params.workspace_id ?? '',
        goalId: params.goal_id ?? '', commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    },
  }));

  app.patch('/projects/:project_id', {
    schema: { params: projectParams, body: editProjectBody,
      response: { 200: commandEnvelopeSchema(editProjectResult) } },
  }, createCommandHandler(dependencies, {
    commandType: 'EditProjectPresentation', bodySchema: editProjectBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await editProjectPresentation(executor, { workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision, title: body.title });
      return { outcome, result: outcome.result };
    },
  }));
}
