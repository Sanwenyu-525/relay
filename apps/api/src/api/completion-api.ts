import type { FastifyInstance } from 'fastify';

import {
  completeHumanTask,
  reopenTask,
} from '../application/completion-commands.js';
import {
  CompleteHumanTaskBodySchema,
  CompleteHumanTaskResultSchema,
  ReopenTaskBodySchema,
  ReopenTaskResultSchema,
  WorkspaceTaskParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, type RouteDependencies } from './envelope.js';

/**
 * 人工完成与重开端点（docs/api/http-command-contract.md 第 3 节）。
 *
 * 完成只接受与当前 acceptance_revision 匹配、全部 required 人工项已确认、且被接受版本证据
 * 完整可用的提交；它不伪造 Run 或 Verification PASS。重开新建验收版本并保留历史凭据。
 */
export function registerCompletionRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void {
  app.post(
    '/tasks/:task_id/complete',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: CompleteHumanTaskBodySchema,
        response: { 200: commandEnvelopeSchema(CompleteHumanTaskResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'CompleteHumanTask',
      bodySchema: CompleteHumanTaskBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await completeHumanTask(executor, dependencies.storage, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          acceptanceRevision: body.acceptance_revision,
          artifactVersionIds: body.artifact_version_ids,
          acceptance: {
            statement: body.acceptance.statement,
            acceptedCriterionIds: body.acceptance.accepted_criterion_ids,
            reason: body.acceptance.reason,
          },
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/tasks/:task_id/reopen',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: ReopenTaskBodySchema,
        response: { 200: commandEnvelopeSchema(ReopenTaskResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'ReopenTask',
      bodySchema: ReopenTaskBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await reopenTask(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedRevision: body.expected_revision,
          reason: body.reason,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );
}