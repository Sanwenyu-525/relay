import type { FastifyInstance } from 'fastify';

import { requireWorkspaceVisible } from '../application/guards.js';
import { runStateCommand } from '../application/state-commands.js';
import { readProjectState } from '../application/state-queries.js';
import {
  ProjectStateSchema,
  StateCommandBodySchema,
  StateCommandResultSchema,
  WorkspaceProjectParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

/**
 * Project State 端点（docs/api/http-command-contract.md 第 5 节）。
 *
 * GET 返回 State 自身 revision 与 dependency_versions；
 * POST 只接受类型化 action，客户端不能任意替换 ProjectState JSON 或做整对象覆盖。
 */
export function registerStateRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get(
    '/projects/:project_id/state',
    {
      schema: {
        params: WorkspaceProjectParamsSchema,
        response: { 200: ProjectStateSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; project_id: string };

        await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

        return await readProjectState(
          dependencies.database.executor,
          params.workspace_id,
          params.project_id,
        );
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.post(
    '/projects/:project_id/state-commands',
    {
      schema: {
        params: WorkspaceProjectParamsSchema,
        body: StateCommandBodySchema,
        response: { 200: commandEnvelopeSchema(StateCommandResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'SetProjectState',
      bodySchema: StateCommandBodySchema,
      execute: async ({ executor, body, params }) => {
        const { action, command_id: commandId, expected_revision: expectedRevision, ...rest } = body;

        const outcome = await runStateCommand(executor, {
          workspaceId: params.workspace_id ?? '',
          projectId: params.project_id ?? '',
          commandId,
          expectedRevision,
          action,
          params: rest as Readonly<Record<string, unknown>>,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );
}