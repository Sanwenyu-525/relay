import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import {
  createArtifactWithVersion,
  submitHumanArtifactVersion,
} from '../application/artifact-commands.js';
import { listTaskArtifacts, readArtifactById, readArtifactContent } from '../application/artifact-queries.js';
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
