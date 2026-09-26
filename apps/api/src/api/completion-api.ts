import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import {
  completeHumanTask,
  reopenTask,
} from '../application/completion-commands.js';
import { readCompletionEvidence } from '../application/completion-evidence-queries.js';
import {
  CompleteHumanTaskBodySchema,
  CompleteHumanTaskResultSchema,
  ReopenTaskBodySchema,
  ReopenTaskResultSchema,
  OpenObjectSchema,
  TimestampSchema,
  UuidSchema,
  WorkspaceTaskParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const availability = Type.Union([Type.Literal('AVAILABLE'), Type.Literal('UNAVAILABLE')]);
const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableUuid = Type.Union([UuidSchema, Type.Null()]);
const criterion = Type.Object({ criterion_id: Type.String(), statement: Type.String(),
  required: Type.Boolean(), method: Type.String(), target_spec: OpenObjectSchema }, strict);
const completionEvidence = Type.Object({
  completion_id: UuidSchema, task_id: UuidSchema,
  basis_kind: Type.Union([Type.Literal('HUMAN'), Type.Literal('AUTO')]),
  acceptance_revision: Type.String(), is_current: Type.Boolean(),
  committed_at: TimestampSchema,
  acceptance: Type.Object({ availability, objective: nullableString,
    expected_outputs: Type.Union([OpenObjectSchema, Type.Null()]),
    source: nullableString, created_at: nullableString,
    criteria: Type.Array(criterion) }, strict),
  human_acceptance: Type.Union([Type.Null(), Type.Object({ availability,
    id: nullableUuid, actor_kind: nullableString, statement: nullableString,
    accepted_criterion_ids: Type.Array(Type.String()), reason: nullableString,
    created_at: nullableString }, strict)]),
  verification_session: Type.Union([Type.Null(), Type.Object({ availability,
    id: nullableUuid, run_id: nullableUuid, status: nullableString,
    verdict: nullableString, check_plan_hash: nullableString,
    applicable: Type.Union([Type.Boolean(), Type.Null()]) }, strict)]),
  artifact_versions: Type.Array(Type.Object({ availability,
    artifact_version_id: nullableUuid, artifact_id: nullableUuid,
    version_number: nullableString, sha256: nullableString }, strict)),
}, strict);

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
  app.get('/completion-records/:completion_id', {
    schema: { params: Type.Object({ workspace_id: UuidSchema,
      completion_id: UuidSchema }, strict), response: { 200: completionEvidence } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; completion_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readCompletionEvidence(dependencies.database.executor,
        dependencies.storage, params.workspace_id, params.completion_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

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
