import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import {
  confirmProjectDailyView, readProjectDailyContinuation,
} from '../application/project-daily-continuation.js';
import { reviewProjectReturn } from '../application/project-return-review.js';
import {
  DecimalSchema, OpenObjectSchema, UuidSchema, WorkspaceProjectParamsSchema,
  commandEnvelopeSchema,
} from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;

const dailyViewCurrentSchema = Type.Object({
  state_revision: DecimalSchema,
  phase_key: Type.Union([Type.String(), Type.Null()]),
  next_action_task_id: Type.Union([UuidSchema, Type.Null()]),
  open_task_ids: Type.Array(UuidSchema),
  open_task_count: Type.Integer(),
  open_task_ids_truncated: Type.Boolean(),
  waiting_task_count: Type.Integer(),
  blocked_task_count: Type.Integer(),
  unresolved_blocker_count: Type.Integer(),
}, strict);

const dailyViewBaselineSchema = Type.Object({
  presentation_id: UuidSchema,
  viewed_state_revision: DecimalSchema,
  viewed_fact_refs: OpenObjectSchema,
  viewed_presentation_seq: DecimalSchema,
  confirmed_at: Type.String({ minLength: 20 }),
}, strict);

const dailyViewDeltaSchema = Type.Object({
  phase_changed: Type.Boolean(),
  phase_before: Type.Union([Type.String(), Type.Null()]),
  phase_after: Type.Union([Type.String(), Type.Null()]),
  next_action_changed: Type.Boolean(),
  next_action_before: Type.Union([UuidSchema, Type.Null()]),
  next_action_after: Type.Union([UuidSchema, Type.Null()]),
  new_open_task_ids: Type.Array(UuidSchema),
  closed_task_ids: Type.Array(UuidSchema),
  unresolved_blocker_count_changed: Type.Boolean(),
  open_tasks_unknown: Type.Boolean(),
}, strict);

const presentationSchema = Type.Object({
  presentation_id: UuidSchema,
  presentation_seq: DecimalSchema,
}, strict);

/** 顶部接续卡投影：无基线时 baseline 与 delta 均为 null，只展示当前事实。 */
export const DailyContinuationProjectionSchema = Type.Object({
  project_id: UuidSchema,
  current: dailyViewCurrentSchema,
  baseline: Type.Union([dailyViewBaselineSchema, Type.Null()]),
  delta: Type.Union([dailyViewDeltaSchema, Type.Null()]),
  presentation: presentationSchema,
  revision: DecimalSchema,
}, strict);

const confirmBody = Type.Object({
  command_id: UuidSchema,
  presentation_id: UuidSchema,
  presentation_seq: DecimalSchema,
  viewed_state_revision: DecimalSchema,
  viewed_fact_refs: OpenObjectSchema,
}, strict);

const returnReviewEvidenceSchema = Type.Object({
  task_id: UuidSchema,
  completion_id: Type.String(),
  basis_kind: Type.String(),
  acceptance_revision: Type.String(),
  applicable: Type.Boolean(),
}, strict);

const returnReviewDeltaSchema = Type.Object({
  phase_changed: Type.Boolean(),
  next_action_changed: Type.Boolean(),
  new_open_task_count: Type.Integer(),
  closed_open_task_count: Type.Integer(),
  unresolved_blocker_count_changed: Type.Boolean(),
  open_tasks_unknown: Type.Boolean(),
}, strict);

/** 返回轻量核对投影（Slice C / NLS-05）：有持久身份的只读核对记录。 */
export const ReturnReviewProjectionSchema = Type.Object({
  review_id: UuidSchema,
  project_id: UuidSchema,
  status: Type.Union([Type.Literal('APPLICABLE'), Type.Literal('CHANGED')]),
  fingerprint: Type.String(),
  reused: Type.Boolean(),
  changed_dimensions: Type.Array(Type.String()),
  delta: Type.Union([returnReviewDeltaSchema, Type.Null()]),
  evidence: Type.Array(returnReviewEvidenceSchema),
  created_at: Type.String(),
}, strict);

const returnReviewBody = Type.Object({ command_id: UuidSchema }, strict);

/**
 * 日常查看基线与顶部接续卡端点（工作台 §18.9）。
 *
 * 确认 = 「实际查看确认」：保存查看时点的版本引用，不复制业务正文；
 * 基线单调推进，迟到确认不覆盖；「已查看」不是接受或接手。
 */
export function registerProjectDailyContinuationRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.post('/projects/:project_id/daily-view-confirmations', {
    schema: {
      params: WorkspaceProjectParamsSchema,
      body: confirmBody,
      response: { 200: commandEnvelopeSchema(DailyContinuationProjectionSchema) },
    },
  }, createCommandHandler(dependencies, {
    commandType: 'ConfirmProjectDailyView',
    bodySchema: confirmBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await confirmProjectDailyView(executor, {
        workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '',
        commandId: body.command_id,
        presentationId: body.presentation_id,
        presentationSeq: body.presentation_seq,
        viewedStateRevision: body.viewed_state_revision,
        viewedFactRefs: body.viewed_fact_refs,
      });
      return { outcome, result: outcome.result };
    },
  }));

  app.get('/projects/:project_id/daily-continuation', {
    schema: {
      params: WorkspaceProjectParamsSchema,
      response: { 200: DailyContinuationProjectionSchema },
    },
  }, async (request, reply) => {
    try {
      const params = request.params as { workspace_id?: string; project_id?: string };
      const projection = await readProjectDailyContinuation(dependencies.database.executor,
        params.workspace_id ?? '', params.project_id ?? '');
      return reply.code(200).send(projection);
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  // Slice C：返回轻量核对。同一份事实与证据复用同一核对记录（持久身份），
  // 不伪造 Run、不启动进程、不自动修复；失权在可见性核对处拒绝，零写入。
  app.post('/projects/:project_id/return-reviews', {
    schema: {
      params: WorkspaceProjectParamsSchema,
      body: returnReviewBody,
      response: { 200: commandEnvelopeSchema(ReturnReviewProjectionSchema) },
    },
  }, createCommandHandler(dependencies, {
    commandType: 'ReviewProjectReturn',
    bodySchema: returnReviewBody,
    execute: async ({ executor, body, params }) => {
      const outcome = await reviewProjectReturn(executor, {
        workspaceId: params.workspace_id ?? '',
        projectId: params.project_id ?? '',
        commandId: body.command_id });
      return { outcome: { result: { review_id: outcome.projection.review_id },
          replayed: outcome.replayed, committedAt: new Date() },
        result: outcome.projection };
    },
  }));
}
