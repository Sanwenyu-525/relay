import type { FastifyInstance } from 'fastify';

import { createGoal } from '../application/create-goal.js';
import { createProject } from '../application/create-project.js';
import { requireWorkspaceVisible } from '../application/guards.js';
import {
  linkProjectGoal,
  unlinkProjectGoal,
} from '../application/project-goal-links.js';
import {
  listProjectGoals,
  readGoalById,
  readProjectById,
} from '../application/project-queries.js';
import {
  CreateGoalBodySchema,
  CreateGoalResultSchema,
  CreateProjectBodySchema,
  CreateProjectResultSchema,
  GoalSchema,
  LinkProjectGoalBodySchema,
  ProjectGoalLinkResultSchema,
  ProjectGoalListSchema,
  ProjectGoalUnlinkResultSchema,
  ProjectSchema,
  UnlinkProjectGoalBodySchema,
  WorkspaceGoalParamsSchema,
  WorkspaceParamsSchema,
  WorkspaceProjectParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

/**
 * Project 与 Goal 端点（docs/api/http-command-contract.md 第 3 节、
 * docs/api/module-api.md 第 1 节的 Goal / Project Goal 行）。
 *
 * Project 与 Goal 是两类事实：CreateProject 不隐式创建 Goal，CreateGoal 不隐式关联 Project；
 * 关联与解除关联是显式命令，解除时在同一个操作内清理受影响的显式对齐。
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void {
  app.post(
    '/projects',
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateProjectBodySchema,
        response: { 201: commandEnvelopeSchema(CreateProjectResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'CreateProject',
      bodySchema: CreateProjectBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await createProject(executor, {
          workspaceId: params.workspace_id ?? '',
          commandId: body.command_id,
          title: body.title,
          projectType: body.project_type,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.get(
    '/projects/:project_id',
    {
      schema: {
        params: WorkspaceProjectParamsSchema,
        response: { 200: ProjectSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; project_id: string };

        await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

        return await readProjectById(
          dependencies.database.executor,
          params.workspace_id,
          params.project_id,
        );
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.get(
    '/projects/:project_id/goals',
    {
      schema: {
        params: WorkspaceProjectParamsSchema,
        response: { 200: ProjectGoalListSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; project_id: string };

        await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

        return {
          items: await listProjectGoals(
            dependencies.database.executor,
            params.workspace_id,
            params.project_id,
          ),
        };
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.post(
    '/projects/:project_id/goal-links',
    {
      schema: {
        params: WorkspaceProjectParamsSchema,
        body: LinkProjectGoalBodySchema,
        response: { 200: commandEnvelopeSchema(ProjectGoalLinkResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'LinkProjectGoal',
      bodySchema: LinkProjectGoalBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await linkProjectGoal(executor, {
          workspaceId: params.workspace_id ?? '',
          projectId: params.project_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          goalId: body.goal_id,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/projects/:project_id/goal-unlinks',
    {
      schema: {
        params: WorkspaceProjectParamsSchema,
        body: UnlinkProjectGoalBodySchema,
        response: { 200: commandEnvelopeSchema(ProjectGoalUnlinkResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'UnlinkProjectGoal',
      bodySchema: UnlinkProjectGoalBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await unlinkProjectGoal(executor, {
          workspaceId: params.workspace_id ?? '',
          projectId: params.project_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          goalId: body.goal_id,
          expectedImpactedTaskIds: body.expected_impacted_task_ids,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/goals',
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateGoalBodySchema,
        response: { 201: commandEnvelopeSchema(CreateGoalResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'CreateGoal',
      bodySchema: CreateGoalBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await createGoal(executor, {
          workspaceId: params.workspace_id ?? '',
          commandId: body.command_id,
          title: body.title,
          description: body.description ?? '',
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.get(
    '/goals/:goal_id',
    {
      schema: {
        params: WorkspaceGoalParamsSchema,
        response: { 200: GoalSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; goal_id: string };

        await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

        return await readGoalById(
          dependencies.database.executor,
          params.workspace_id,
          params.goal_id,
        );
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );
}