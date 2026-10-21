import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { readAutoCaptures, retireAutoCapture } from '../application/memory-captures.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const base = Type.Object({ workspace_id: uuid }, strict);

/**
 * 自动记忆的读取与撤销（ADR-030 / HTTP §10.105）。
 *
 * 没有「接受」端点：自动记忆写入即生效。这里只有「看最近写了什么」和「撤掉它」，
 * 撤销走既有命令回执协议，不另造一套幂等。
 */
export function registerMemoryCaptureRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/memory-auto-captures', { schema: { params: base,
    querystring: Type.Object({ limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-4][0-9]|50)$' })) }, strict) } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { limit?: string };
      reply.header('Cache-Control', 'no-store');
      const items = await readAutoCaptures(dependencies.database.executor, p.workspace_id,
        q.limit === undefined ? 20 : Number(q.limit));
      return { items };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  const retireBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
  app.post('/memory-auto-captures/:capture_id/retire', { schema: {
    params: Type.Object({ workspace_id: uuid, capture_id: uuid }, strict), body: retireBody } },
  createCommandHandler(dependencies, { commandType: 'RetireAutoMemoryCapture', bodySchema: retireBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await retireAutoCapture(executor, { workspaceId: params.workspace_id ?? '',
        captureId: params.capture_id ?? '', commandId: body.command_id,
        expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));
}
