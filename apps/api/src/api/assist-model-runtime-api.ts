import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { readAssistModelRuntime } from '../application/assist-model-runtime.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const nullableText = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Integer(), Type.Null()]);
const response = Type.Object({
  message_id: UuidSchema, session_id: UuidSchema, message_status: Type.String(),
  snapshot_available: Type.Boolean(), preferred_model: nullableText,
  candidate_models: Type.Array(Type.String()), current_candidate_model: nullableText,
  actual_model: nullableText, max_candidates: nullableNumber, routing_status: nullableText,
  revision: nullableText, failure_scope: nullableText, failure_reason: nullableText,
  retry_after_at: nullableText, free_daily_remaining: nullableNumber,
  switches: Type.Array(Type.Object({ from_model: nullableText, to_model: nullableText,
    reason: nullableText, scope: nullableText, retry_after_at: nullableText, switched_at: nullableText }, strict)),
  calls: Type.Array(Type.Object({ id: UuidSchema, provider: Type.String(), model: Type.String(),
    status: Type.String(), error_kind: nullableText, provider_request_id: nullableText,
    input_tokens: nullableNumber, output_tokens: nullableNumber,
    started_at: Type.String(), settled_at: nullableText }, strict)),
}, strict);

export function registerAssistModelRuntimeRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get('/assist-messages/:message_id/model-runtime', { schema: {
    params: Type.Object({ workspace_id: UuidSchema, message_id: UuidSchema }, strict),
    response: { 200: response },
  } }, async (request, reply) => {
    const params = request.params as { workspace_id: string; message_id: string };
    try {
      return await readAssistModelRuntime(dependencies.database.executor, {
        workspaceId: params.workspace_id, messageId: params.message_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
