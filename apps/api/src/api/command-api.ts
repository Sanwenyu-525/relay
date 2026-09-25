import type { FastifyInstance } from 'fastify';

import { commandNotFound } from '../application/domain-error.js';
import { requireWorkspaceVisible } from '../application/guards.js';
import {
  httpCommandScopeKey,
} from '../application/actor.js';
import { createRepositories } from '../application/unit-of-work.js';
import { CommandReceiptSchema, WorkspaceCommandParamsSchema } from './domain-schemas.js';
import { buildCommandEnvelope, sendReadError, type RouteDependencies } from './envelope.js';

/**
 * 命令回执读取：GET W/commands/{command_id}（docs/api/http-command-contract.md 第 2 节）。
 *
 * 返回与首次成功响应同一形状的回执（成功码由 command_type 还原）；回执不存在返回 404
 * COMMAND_NOT_FOUND，但这不能证明一个仍在事务中的请求永远未提交——原样重试仍是安全路径。
 */
export function registerCommandRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void {
  app.get(
    '/commands/:command_id',
    {
      schema: {
        params: WorkspaceCommandParamsSchema,
        response: { 200: CommandReceiptSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; command_id: string };

        await requireWorkspaceVisible(dependencies.database.executor, params.workspace_id);

        const receipt = await createRepositories(dependencies.database.executor).receipts.findReceipt(
          {
            scopeKey: httpCommandScopeKey(params.workspace_id),
            commandId: params.command_id,
          },
        );

        if (receipt === undefined) {
          throw commandNotFound();
        }

        const envelope = buildCommandEnvelope({
          workspaceId: params.workspace_id,
          commandId: receipt.command_id,
          commandType: receipt.command_type,
          committedAt: receipt.created_at,
          result: receipt.result_ref,
        });

        return reply.code(200).send({
          command_id: envelope.command_id,
          command_type: receipt.command_type,
          committed_at: envelope.committed_at,
          result: envelope.result,
          links: envelope.links,
        });
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );
}