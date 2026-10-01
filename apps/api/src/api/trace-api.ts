import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { readRunTrace } from '../application/trace-queries.js';
import { MODEL_ERROR_CATEGORIES } from '../workflow/model-error-classification.js';
import { UuidSchema } from './domain-schemas.js';
import { sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const nullableId = Type.Union([UuidSchema, Type.Null()]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Integer(), Type.Null()]);
const timestamp = nullableString;
const source = Type.Object({ kind: Type.String(), source_ref: nullableString,
  version: nullableString, sha256: nullableString, source_sha256: nullableString,
  role: Type.String(), trust: Type.String(),
  availability: Type.Union([Type.Literal('AVAILABLE'), Type.Literal('UNAVAILABLE')]) }, strict);
const trace = Type.Object({
  run_id: UuidSchema, task_id: UuidSchema, project_id: nullableId, status: Type.String(),
  steps: Type.Array(Type.Object({ id: UuidSchema, step_index: Type.Integer(),
    kind: Type.String(), status: Type.String(), revision: Type.String(),
    result_available: Type.Boolean(), started_at: timestamp, finished_at: timestamp }, strict)),
  attempts: Type.Array(Type.Object({ id: UuidSchema, step_id: UuidSchema,
    attempt_number: Type.String(), status: Type.String(), claim_epoch: Type.String(),
    result_available: Type.Boolean(), started_at: timestamp, finished_at: timestamp }, strict)),
  model_calls: Type.Array(Type.Object({ id: UuidSchema, step_attempt_id: nullableId,
    kind: Type.String(), criterion_id: nullableString, check_attempt: nullableNumber,
    provider_error_kind: Type.Union([
      ...MODEL_ERROR_CATEGORIES.map((category) => Type.Literal(category)), Type.Null()]),
    provider_request_id: nullableString,
    manifest_id: nullableId, status: Type.String(), provider: Type.String(),
    model: Type.String(), input_sha256: nullableString, read_operation_id: nullableId,
    read_invocation_id: nullableId, usage_input_tokens: nullableNumber,
    usage_output_tokens: nullableNumber, usage_cache_read_tokens: nullableNumber,
    usage_cache_creation_tokens: nullableNumber, started_at: Type.String(),
    first_text_delta_at: timestamp, first_preview_persisted_at: timestamp,
    settled_at: timestamp }, strict)),
  manifests: Type.Array(Type.Object({ id: UuidSchema, step_id: nullableId,
    builder_version: Type.String(), sha256: Type.String(), sources: Type.Array(source),
    created_at: Type.String() }, strict)),
  verifications: Type.Array(Type.Object({ id: UuidSchema, status: Type.String(),
    verdict: nullableString, acceptance_revision: Type.String(), check_plan_hash: Type.String(),
    parent_session_id: nullableId, targets: Type.Array(Type.Object({
      artifact_version_id: UuidSchema, content_sha256: Type.String() }, strict)),
    checks: Type.Array(Type.Object({ id: UuidSchema, criterion_id: Type.String(),
      result: Type.String(), severity: Type.String(), required: Type.Boolean(),
      created_at: Type.String() }, strict)), created_at: Type.String(),
    finalized_at: timestamp }, strict)),
  reviews: Type.Array(Type.Object({ id: UuidSchema, kind: Type.String(), status: Type.String(),
    operation_id: nullableId, verification_session_id: nullableId,
    target_hash: Type.String(), decision: Type.Union([Type.Null(),
      Type.Object({ id: UuidSchema, value: Type.String(), decided_at: Type.String() }, strict)]),
    created_at: Type.String(), decided_at: timestamp }, strict)),
  operations: Type.Array(Type.Object({ id: UuidSchema, step_id: nullableId,
    capability: Type.String(), action_type: Type.String(), status: Type.String(),
    params_sha256: Type.String(), result_available: Type.Boolean(),
    invocations: Type.Array(Type.Object({ id: UuidSchema, attempt_number: Type.String(),
      status: Type.String(), result_available: Type.Boolean(), created_at: Type.String(),
      resolved_at: timestamp }, strict)), created_at: Type.String(),
    updated_at: Type.String() }, strict)),
  effects: Type.Array(Type.Object({ id: UuidSchema, step_id: UuidSchema,
    status: Type.String(), params_sha256: Type.String(), result_available: Type.Boolean(),
    created_at: Type.String(), resolved_at: timestamp }, strict)),
}, strict);

export function registerTraceRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/runs/:run_id/trace', { schema: { params: Type.Object({
    workspace_id: UuidSchema, run_id: UuidSchema }, strict),
    response: { 200: trace } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; run_id: string };
      return await readRunTrace(dependencies.database.executor, dependencies.storage,
        p.workspace_id, p.run_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
}
