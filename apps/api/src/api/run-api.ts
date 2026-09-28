import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { delegateTask } from '../application/delegate-task.js';
import { readRunById } from '../application/run-queries.js';
import { readRunDraftPreview } from '../application/run-draft-preview.js';
import { applySafeControl, readControlRequest, requestRunControl, resumeRun } from '../application/control-requests.js';
import {
  DelegateTaskBodySchema,
  DelegateTaskResultSchema,
  RunSchema,
  RunControlRequestBodySchema,
  RunControlRequestResultSchema,
  RunControlRequestSchema,
  RunResumeBodySchema,
  RunResumeResultSchema,
  WorkspaceRunControlParamsSchema,
  WorkspaceRunParamsSchema,
  WorkspaceTaskParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { sendRunEventStream } from './run-events-api.js';

const draftPreviewDto = Type.Object({
  run_id: Type.String({ format: 'uuid' }), run_status: Type.String(),
  step_attempt_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  attempt_claim_epoch: Type.Union([Type.String({ pattern: '^(0|[1-9][0-9]*)$' }), Type.Null()]),
  model_call_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  preview_revision: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
  preview_text: Type.Union([Type.String(), Type.Null()]),
  preview_truncated: Type.Boolean(), preview_available: Type.Boolean(),
}, { additionalProperties: false });

/**
 * Run 与 Delegate 端点（docs/api/http-command-contract.md 第 4、6 节）。
 *
 * 用户入口不能提交 worker claim 或手动设置 Run 状态：Delegate 只创建 Run 并原子授予执行权，
 * 成功返回 202（已接受，工作尚未完成）。Run 查询是只读投影，不含宿主路径、密钥或可写实体。
 */
export function registerRunRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post(
    '/tasks/:task_id/delegations',
    {
      schema: {
        params: WorkspaceTaskParamsSchema,
        body: DelegateTaskBodySchema,
        response: { 202: commandEnvelopeSchema(DelegateTaskResultSchema) },
      },
    },
    createCommandHandler(dependencies, {
      commandType: 'DelegateTask',
      bodySchema: DelegateTaskBodySchema,
      execute: async ({ executor, body, params }) => {
        const outcome = await delegateTask(executor, {
          workspaceId: params.workspace_id ?? '',
          taskId: params.task_id ?? '',
          commandId: body.command_id,
          expectedTaskRevision: body.expected_task_revision,
          retryOfRunId: body.retry_of_run_id ?? null,
          workflowVersionId: body.workflow_version_id ?? null,
          executionConfigVersionId: body.execution_config_version_id ?? null,
          mockGatewayAction: body.mock_gateway_action,
          fileReadAction: body.file_read_action,
          webFetchAction: body.web_fetch_action,
          fileWriteAction: body.file_write_action,
          contextSources: body.context_sources,
        });

        return { outcome, result: outcome.result };
      },
    }),
  );

  app.get(
    '/runs/:run_id',
    {
      schema: {
        params: WorkspaceRunParamsSchema,
        response: { 200: RunSchema },
      },
    },
    async (request, reply) => {
      try {
        const params = request.params as { workspace_id: string; run_id: string };

        return await readRunById(dependencies.database.executor, params.workspace_id, params.run_id);
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    },
  );

  app.get('/runs/:run_id/draft-preview', {
    schema: { params: WorkspaceRunParamsSchema, response: { 200: draftPreviewDto } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const params = request.params as { workspace_id: string; run_id: string };
      return await readRunDraftPreview(dependencies.database.executor,
        dependencies.storage, params.workspace_id, params.run_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/runs/:run_id/events', {
    schema: { params: WorkspaceRunParamsSchema },
  }, async (request, reply) => {
    const params = request.params as { workspace_id: string; run_id: string };
    return sendRunEventStream(request, reply, dependencies.database.executor,
      params.workspace_id, params.run_id);
  });

  app.post('/runs/:run_id/control-requests', {
    schema: { params: WorkspaceRunParamsSchema, body: RunControlRequestBodySchema,
      response: { 202: commandEnvelopeSchema(RunControlRequestResultSchema) } },
  }, createCommandHandler(dependencies, {
    commandType: 'RequestRunControl', bodySchema: RunControlRequestBodySchema,
    execute: async ({ executor, body, params, request }) => {
      const outcome = await requestRunControl(executor, {
        workspaceId: params.workspace_id ?? '', runId: params.run_id ?? '', commandId: body.command_id,
        expectedTaskRevision: body.expected_task_revision, expectedRunRevision: body.expected_run_revision,
        type: body.type, supersedesRequestId: body.supersedes_request_id ?? null,
      });
      // 回执始终描述已提交的 PENDING 意图；安全点在另一个短事务推进。
      try { await applySafeControl(executor, params.run_id ?? ''); }
      catch (error) { request.log.error({ err: error }, 'run_control_safe_point_failed'); }
      return { outcome, result: outcome.result };
    },
  }));

  app.get('/runs/:run_id/control-requests/:request_id', {
    schema: { params: WorkspaceRunControlParamsSchema, response: { 200: RunControlRequestSchema } },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id: string; run_id: string; request_id: string };
      return await readControlRequest(dependencies.database.executor, params.workspace_id, params.run_id, params.request_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/runs/:run_id/resume', {
    schema: { params: WorkspaceRunParamsSchema, body: RunResumeBodySchema,
      response: { 202: commandEnvelopeSchema(RunResumeResultSchema) } },
  }, createCommandHandler(dependencies, {
    commandType: 'ResumeRun', bodySchema: RunResumeBodySchema,
    execute: async ({ executor, body, params }) => {
      const outcome = await resumeRun(executor, { workspaceId: params.workspace_id ?? '',
        runId: params.run_id ?? '', commandId: body.command_id,
        expectedTaskRevision: body.expected_task_revision, expectedRunRevision: body.expected_run_revision });
      return { outcome, result: outcome.result };
    },
  }));
}
