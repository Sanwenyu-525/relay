import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { cancelMemoryCompaction, readMessageMemoryUse, readSessionMemory, requestMemoryCompaction,
  resetSessionMemory } from '../application/assist-memory.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const revision = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const params = Type.Object({ workspace_id: uuid, id: uuid }, strict);

export function registerAssistMemoryRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/assist-sessions/:id/messages/:message_id/memory', { schema: {
    params: Type.Object({ workspace_id: uuid, id: uuid, message_id: uuid }, strict) } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string; message_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readMessageMemoryUse(dependencies.database.executor, dependencies.storage,
        p.workspace_id, p.id, p.message_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.get('/assist-sessions/:id/memory', { schema: { params } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      reply.header('Cache-Control', 'no-store');
      return await readSessionMemory(dependencies.database.executor, dependencies.storage, p.workspace_id, p.id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  const compactBody = Type.Object({ command_id: uuid, expected_revision: revision }, strict);
  app.post('/assist-sessions/:id/memory/compact', { schema: { params, body: compactBody } },
    createCommandHandler(dependencies, { commandType: 'RequestMemoryCompaction', bodySchema: compactBody,
      execute: async ({ executor, params: p, body }) => {
        const outcome = await requestMemoryCompaction(executor, { workspaceId: p.workspace_id ?? '',
          sessionId: p.id ?? '', commandId: body.command_id, expectedRevision: body.expected_revision }, dependencies.storage);
        return { outcome, result: outcome.result };
      } }));
  const cancelBody = Type.Object({ command_id: uuid }, strict);
  app.post('/assist-sessions/:id/memory/requests/:request_id/cancel', { schema: {
    params: Type.Object({ workspace_id: uuid, id: uuid, request_id: uuid }, strict), body: cancelBody } },
    createCommandHandler(dependencies, { commandType: 'CancelMemoryCompaction', bodySchema: cancelBody,
      execute: async ({ executor, params: p, body }) => {
        const outcome = await cancelMemoryCompaction(executor, { workspaceId: p.workspace_id ?? '',
          sessionId: p.id ?? '', requestId: p.request_id ?? '', commandId: body.command_id });
        return { outcome, result: outcome.result };
      } }));
  const clearBody = Type.Object({ command_id: uuid, expected_revision: revision, expected_session_revision: revision }, strict);
  app.post('/assist-sessions/:id/memory/clear', { schema: { params, body: clearBody } },
    createCommandHandler(dependencies, { commandType: 'ClearSessionMemory', bodySchema: clearBody,
      execute: async ({ executor, params: p, body }) => {
        const outcome = await resetSessionMemory(executor, { workspaceId: p.workspace_id ?? '', sessionId: p.id ?? '',
          commandId: body.command_id, expectedRevision: body.expected_revision, expectedSessionRevision: body.expected_session_revision });
        return { outcome, result: outcome.result };
      } }));
  const rememberBody = Type.Object({ ...clearBody.properties, remember: Type.Boolean() }, strict);
  app.post('/assist-sessions/:id/memory/remember', { schema: { params, body: rememberBody } },
    createCommandHandler(dependencies, { commandType: 'SetSessionMemory', bodySchema: rememberBody,
      execute: async ({ executor, params: p, body }) => {
        const outcome = await resetSessionMemory(executor, { workspaceId: p.workspace_id ?? '', sessionId: p.id ?? '',
          commandId: body.command_id, expectedRevision: body.expected_revision,
          expectedSessionRevision: body.expected_session_revision, remember: body.remember });
        return { outcome, result: outcome.result };
      } }));
}
