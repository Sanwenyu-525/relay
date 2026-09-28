import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import {
  createArtifactWithVersion,
  submitHumanArtifactVersion,
} from '../application/artifact-commands.js';
import { listTaskArtifacts, readArtifactById, readArtifactContent } from '../application/artifact-queries.js';
import { listArtifactTextLocks, lockArtifactText, unlockArtifactText } from '../application/artifact-text-locks.js';
import { applyArtifactImpactCandidate, readArtifactImpactCandidate,
  readArtifactImpactCheck, startArtifactImpactCandidate,
  startArtifactImpactCheck } from '../application/artifact-impact-checks.js';
import {
  ArtifactSchema,
  ArtifactVersionResultSchema,
  CreateArtifactBodySchema,
  SubmitArtifactVersionBodySchema,
  WorkspaceArtifactParamsSchema,
  WorkspaceArtifactVersionParamsSchema,
  WorkspaceTaskParamsSchema,
  UuidSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const TaskArtifactsSchema = Type.Object({
  items: Type.Array(ArtifactSchema),
  current_accepted_version_ids: Type.Array(UuidSchema),
}, { additionalProperties: false });

const TextLockSchema = Type.Object({ id: UuidSchema, artifact_id: UuidSchema,
  base_version_id: UuidSchema,
  block_kind: Type.Union([Type.Literal('PARAGRAPH'), Type.Literal('SECTION')]),
  block_index: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  text: Type.String(), status: Type.Union([Type.Literal('MAPPED'), Type.Literal('UNMAPPED')]),
}, { additionalProperties: false });
const TextLockBodySchema = Type.Object({ command_id: UuidSchema,
  expected_artifact_revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
  expected_version_id: UuidSchema,
  block_kind: Type.Union([Type.Literal('PARAGRAPH'), Type.Literal('SECTION')]),
  block_index: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const UnlockTextBodySchema = Type.Object({ command_id: UuidSchema,
  expected_artifact_revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
}, { additionalProperties: false });
const ImpactBodySchema = Type.Object({ command_id: UuidSchema,
  source_after_version_id: UuidSchema,
  expected_artifact_revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
  analysis_target_version_ids: Type.Array(UuidSchema, { maxItems: 10, uniqueItems: true }),
}, { additionalProperties: false });
const ImpactCheckSchema = Type.Object({ id: UuidSchema, artifact_id: UuidSchema,
  source_before_version_id: UuidSchema, source_after_version_id: UuidSchema,
  status: Type.String(), error_code: Type.Union([Type.String(), Type.Null()]),
  direct_targets: Type.Array(Type.Object({}, { additionalProperties: true })),
  possibly_related: Type.Array(Type.Object({}, { additionalProperties: true })),
  has_more: Type.Boolean(), input_truncated: Type.Boolean(),
  unanalysed_scope: Type.Array(Type.String()), stale: Type.Boolean(),
}, { additionalProperties: false });
const ImpactCandidateBodySchema = Type.Object({ command_id: UuidSchema,
  target_version_id: UuidSchema,
  expected_target_revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
  confirmed_possible: Type.Boolean(),
}, { additionalProperties: false });
const ApplyImpactBodySchema = Type.Object({ command_id: UuidSchema,
  expected_target_revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
}, { additionalProperties: false });
const ImpactCandidateSchema = Type.Object({ id: UuidSchema, impact_check_id: UuidSchema,
  target_artifact_id: UuidSchema, target_version_id: UuidSchema, status: Type.String(),
  error_code: Type.Union([Type.String(), Type.Null()]),
  markdown: Type.Union([Type.String(), Type.Null()]), stale: Type.Boolean(),
  applied_version_id: Type.Union([UuidSchema, Type.Null()]),
}, { additionalProperties: false });

/**
 * Artifact 端点（docs/api/http-command-contract.md 第 3 节）。
 *
 * 两个保存入口都只允许处于 IN_PROGRESS 的人工 Task；内容上限 256 KiB（413）且只接受
 * text/markdown（415）。内容按版本不可变：旧版本永不覆盖，新版本不继承任何验收凭据。
 * 读取端只返回受管逻辑信息；正文通过受授权下载接口获取，不暴露宿主绝对路径。
 */
export function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): void {
  app.post('/artifact-versions/:artifact_version_id/impact-checks', {
    schema: { params: WorkspaceArtifactVersionParamsSchema, body: ImpactBodySchema,
      response: { 202: commandEnvelopeSchema(Type.Object({ impact_check_id: UuidSchema,
        assistant_message_id: UuidSchema }, { additionalProperties: false })) } },
  }, createCommandHandler(dependencies, { commandType: 'StartArtifactImpactCheck',
    bodySchema: ImpactBodySchema, execute: async ({ executor, body, params }) => {
      const outcome = await startArtifactImpactCheck(executor, dependencies.storage, {
        workspaceId: params.workspace_id ?? '', beforeVersionId: params.artifact_version_id ?? '',
        afterVersionId: body.source_after_version_id, commandId: body.command_id,
        expectedArtifactRevision: body.expected_artifact_revision,
        analysisTargetVersionIds: body.analysis_target_version_ids });
      return { outcome, result: outcome.result };
    } }));
  app.get('/impact-checks/:impact_check_id', {
    schema: { params: Type.Object({ workspace_id: UuidSchema,
      impact_check_id: UuidSchema }, { additionalProperties: false }),
      response: { 200: ImpactCheckSchema } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; impact_check_id: string };
      return await readArtifactImpactCheck(dependencies.database.executor,
        p.workspace_id, p.impact_check_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/impact-checks/:impact_check_id/candidates', {
    schema: { params: Type.Object({ workspace_id: UuidSchema,
      impact_check_id: UuidSchema }, { additionalProperties: false }),
      body: ImpactCandidateBodySchema,
      response: { 202: commandEnvelopeSchema(Type.Object({ candidate_id: UuidSchema,
        assistant_message_id: UuidSchema }, { additionalProperties: false })) } },
  }, createCommandHandler(dependencies, { commandType: 'StartArtifactImpactCandidate',
    bodySchema: ImpactCandidateBodySchema, execute: async ({ executor, body, params }) => {
      const outcome = await startArtifactImpactCandidate(executor, dependencies.storage, {
        workspaceId: params.workspace_id ?? '', checkId: params.impact_check_id ?? '',
        targetVersionId: body.target_version_id, commandId: body.command_id,
        expectedTargetRevision: body.expected_target_revision,
        confirmedPossible: body.confirmed_possible });
      return { outcome, result: outcome.result };
    } }));
  app.get('/impact-candidates/:candidate_id', {
    schema: { params: Type.Object({ workspace_id: UuidSchema,
      candidate_id: UuidSchema }, { additionalProperties: false }),
      response: { 200: ImpactCandidateSchema } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; candidate_id: string };
      return await readArtifactImpactCandidate(dependencies.database.executor,
        p.workspace_id, p.candidate_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });
  app.post('/impact-candidates/:candidate_id/apply', {
    schema: { params: Type.Object({ workspace_id: UuidSchema,
      candidate_id: UuidSchema }, { additionalProperties: false }),
      body: ApplyImpactBodySchema,
      response: { 200: commandEnvelopeSchema(Type.Object({ artifact_id: UuidSchema,
        version_id: UuidSchema, artifact_revision: Type.String(),
        task_revision: Type.String() }, { additionalProperties: false })) } },
  }, createCommandHandler(dependencies, { commandType: 'ApplyArtifactImpactCandidate',
    bodySchema: ApplyImpactBodySchema, execute: async ({ executor, body, params }) => {
      const outcome = await applyArtifactImpactCandidate(executor, dependencies.storage, {
        workspaceId: params.workspace_id ?? '', candidateId: params.candidate_id ?? '',
        commandId: body.command_id, expectedTargetRevision: body.expected_target_revision });
      return { outcome, result: outcome.result };
    } }));
  app.get('/artifacts/:artifact_id/text-locks', {
    schema: { params: WorkspaceArtifactParamsSchema,
      response: { 200: Type.Object({ artifact_id: UuidSchema,
        locks: Type.Array(TextLockSchema) }, { additionalProperties: false }) } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; artifact_id: string };
      return await listArtifactTextLocks(dependencies.database.executor, p.workspace_id, p.artifact_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/artifacts/:artifact_id/text-locks', {
    schema: { params: WorkspaceArtifactParamsSchema, body: TextLockBodySchema,
      response: { 200: commandEnvelopeSchema(Type.Object({ artifact_id: UuidSchema,
        artifact_revision: Type.String(), lock: TextLockSchema }, { additionalProperties: false })) } },
  }, createCommandHandler(dependencies, { commandType: 'LockArtifactText',
    bodySchema: TextLockBodySchema, execute: async ({ executor, body, params }) => {
      const outcome = await lockArtifactText(executor, dependencies.storage, {
        workspaceId: params.workspace_id ?? '', artifactId: params.artifact_id ?? '',
        commandId: body.command_id, expectedArtifactRevision: body.expected_artifact_revision,
        expectedVersionId: body.expected_version_id, blockKind: body.block_kind,
        blockIndex: body.block_index });
      return { outcome, result: outcome.result };
    } }));

  app.post('/artifacts/:artifact_id/text-locks/:lock_id/unlock', {
    schema: { params: Type.Object({ workspace_id: UuidSchema, artifact_id: UuidSchema,
      lock_id: UuidSchema }, { additionalProperties: false }), body: UnlockTextBodySchema,
      response: { 200: commandEnvelopeSchema(Type.Object({ artifact_id: UuidSchema,
        artifact_revision: Type.String(), unlocked_lock_id: UuidSchema },
      { additionalProperties: false })) } },
  }, createCommandHandler(dependencies, { commandType: 'UnlockArtifactText',
    bodySchema: UnlockTextBodySchema, execute: async ({ executor, body, params }) => {
      const outcome = await unlockArtifactText(executor, { workspaceId: params.workspace_id ?? '',
        artifactId: params.artifact_id ?? '', lockId: params.lock_id ?? '',
        commandId: body.command_id, expectedArtifactRevision: body.expected_artifact_revision });
      return { outcome, result: outcome.result };
    } }));
  app.get(
    '/tasks/:task_id/artifacts',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        response: { 200: TaskArtifactsSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; task_id: string };

        return await listTaskArtifacts(dependencies.database.executor, params.workspace_id, params.task_id);
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.post(
    '/tasks/:task_id/artifacts',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: CreateArtifactBodySchema,
        response: { 201: commandEnvelopeSchema(ArtifactVersionResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'CreateArtifactWithVersion',
      bodySchema: CreateArtifactBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await createArtifactWithVersion(executor, dependencies.storage, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedTaskRevision: body.expected_task_revision,
          title: body.title,
          mediaType: body.media_type,
          content: body.content,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.post(
    '/artifacts/:artifact_id/versions',
    {
      schema: {
        params: WorkspaceArtifactParamsSchema,
        body: SubmitArtifactVersionBodySchema,
        response: { 201: commandEnvelopeSchema(ArtifactVersionResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'SubmitHumanArtifactVersion',
      bodySchema: SubmitArtifactVersionBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await submitHumanArtifactVersion(executor, dependencies.storage, {
          workspaceId: params.workspace_id ?? '',
          artifactId: params.artifact_id ?? '',
          commandId: body.command_id,
          expectedArtifactRevision: body.expected_artifact_revision,
          expectedTaskRevision: body.expected_task_revision,
          mediaType: body.media_type,
          content: body.content,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.get(
    '/artifacts/:artifact_id',
    {
      schema: {
        params: WorkspaceArtifactParamsSchema,
        response: { 200: ArtifactSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; artifact_id: string };

        return await readArtifactById(
          dependencies.database.executor,
          params.workspace_id,
          params.artifact_id,
        );
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  /**
   * 受授权下载确切版本内容。响应用 text/markdown 传输正文本身（不是 JSON 包装），
   * 因此这里不声明 response schema；内容与登记摘要不一致时返回 503 EVIDENCE_UNAVAILABLE，
   * 不回退到“返回现有内容”。
   */
  app.get(
    '/artifact-versions/:artifact_version_id/content',
    {
      schema: { params: WorkspaceArtifactVersionParamsSchema },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; artifact_version_id: string };
        const { version, content } = await readArtifactContent(
          dependencies.database.executor,
          dependencies.storage,
          params.workspace_id,
          params.artifact_version_id,
        );

        return reply
          .code(200)
          .type(`${version.media_type}; charset=utf-8`)
          .header('content-length', Buffer.byteLength(content).toString())
          .send(content);
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );
}
