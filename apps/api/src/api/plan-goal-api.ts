import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { ChatMode } from '../infrastructure/database-schema.js';
import { cancelGoal, confirmGoalCompletion, pauseGoal, readSessionGoal,
  resumeGoalCommand, startGoalFromPlan } from '../application/assist-goals.js';
import { readPlanVersion, readSessionPlan } from '../application/assist-plans.js';
import { setChatMode } from '../application/chat-mode.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { commandEnvelopeSchema } from './domain-schemas.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const chatModeSchema = Type.Union([Type.Literal('CHAT'), Type.Literal('PLAN'),
  Type.Literal('GOAL')]);

const sessionParams = Type.Object({ workspace_id: uuid, session_id: uuid }, strict);
const planParams = Type.Object({ workspace_id: uuid, session_id: uuid, plan_id: uuid }, strict);
const goalParams = Type.Object({ workspace_id: uuid, goal_id: uuid }, strict);

const chatModeBody = Type.Object({
  command_id: uuid,
  mode: chatModeSchema,
  /** 客户端读到的会话修订号：不一致就拒绝，不让过期选择覆盖别人的决定。 */
  expected_revision: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
}, strict);

const startGoalBody = Type.Object({
  command_id: uuid,
  plan_id: uuid,
  /** 选定版本不是最新版时必须显式确认，服务端从不静默改用另一版。 */
  allow_superseded: Type.Optional(Type.Boolean()),
}, strict);

const controlBody = Type.Object({ command_id: uuid }, strict);

const planProjection = Type.Object({
  plan_id: uuid, session_id: uuid, version: Type.Integer(),
  status: Type.Union([Type.Literal('CURRENT'), Type.Literal('SUPERSEDED')]),
  goal: Type.String(),
  scope: Type.Array(Type.String()),
  steps: Type.Array(Type.Object({ title: Type.String(),
    detail: Type.Union([Type.String(), Type.Null()]) }, strict)),
  verification: Type.Array(Type.Object({ statement: Type.String(), method: Type.String() },
    strict)),
  open_questions: Type.Array(Type.String()),
  source_message_id: uuid,
  created_at: Type.String(),
}, strict);

const goalProjectionSchema = Type.Object({
  goal_id: uuid, session_id: uuid, objective: Type.String(), status: Type.String(),
  current_step: Type.Union([Type.String(), Type.Null()]),
  progress: Type.Union([Type.String(), Type.Null()]),
  stop_reason: Type.Union([Type.Object({
    code: Type.String(), detail: Type.String(), questions: Type.Array(Type.String()),
    resumable: Type.Boolean(),
  }, strict), Type.Null()]),
  criteria: Type.Array(Type.Object({
    key: Type.String(), statement: Type.String(), status: Type.String(),
    evidence: Type.Union([Type.String(), Type.Null()]), required: Type.Boolean(),
  }, strict)),
  steps: Type.Array(Type.Object({ title: Type.String(), status: Type.String() }, strict)),
  round_count: Type.Integer(), no_progress_rounds: Type.Integer(),
  plan_version_id: Type.Union([uuid, Type.Null()]),
  plan_version: Type.Union([Type.Integer(), Type.Null()]),
  last_round_at: Type.Union([Type.String(), Type.Null()]),
  actions: Type.Object({ pause: Type.Boolean(), cancel: Type.Boolean(),
    resume: Type.Boolean(), confirm_completion: Type.Boolean() }, strict),
  revision: Type.String(), created_at: Type.String(), updated_at: Type.String(),
}, strict);

const goalView = Type.Object({
  goal: Type.Union([goalProjectionSchema, Type.Null()]),
  rounds: Type.Array(Type.Object({ round_index: Type.Integer(), outcome: Type.String(),
    note: Type.Union([Type.String(), Type.Null()]), created_at: Type.String() }, strict)),
}, strict);

const chatModeTransition = Type.Object({
  session_id: uuid, chat_mode: chatModeSchema, revision: Type.String(),
  goal_stopping: Type.Boolean(),
  goal: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
}, strict);

const goalCommandResult = Type.Object({
  goal: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
}, strict);

/**
 * 聊天 `/plan` 与 `/goal` 的接口（HTTP 契约 §10.108）。
 *
 * 两条读、五条命令：
 *   * 读计划 / 读目标 —— 无副作用，刷新、重开会话、另一台设备都从这里恢复；
 *   * 切换模式 —— 只改行为模式，**不启动执行**；
 *   * 按计划执行 —— 绑定确切的一版计划启动目标（过期版要求显式确认）；
 *   * 暂停 / 取消 / 继续 / 确认完成 —— 都只写控制意图，由服务端推进器落定。
 *
 * 所有命令都按 `command_id` 幂等：重复提交读回原回执，异载荷按契约拒绝。
 * 没有任何端点让客户端直接改目标进度或宣布完成。
 */
export function registerPlanGoalRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/assist-sessions/:session_id/plans', {
    schema: { params: sessionParams, response: { 200: Type.Object({
      latest: Type.Union([planProjection, Type.Null()]),
      versions: Type.Array(planProjection),
    }, strict) } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      return await readSessionPlan(dependencies.database.executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '' });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-sessions/:session_id/plans/:plan_id', {
    schema: { params: planParams, response: { 200: planProjection } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      return await readPlanVersion(dependencies.database.executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '',
        planId: params.plan_id ?? '' });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-sessions/:session_id/goal', {
    schema: { params: sessionParams, response: { 200: goalView } },
  }, async (request, reply) => {
    try {
      const params = request.params as Record<string, string>;
      return await readSessionGoal(dependencies.database.executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '' });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/assist-sessions/:session_id/chat-mode', {
    schema: { params: sessionParams, body: chatModeBody,
      response: { 200: commandEnvelopeSchema(chatModeTransition) } },
  }, createCommandHandler(dependencies, { commandType: 'SetChatMode', bodySchema: chatModeBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setChatMode(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '',
        commandId: body.command_id, mode: body.mode as ChatMode,
        ...(body.expected_revision === undefined ? {} : {
          expectedRevision: body.expected_revision }),
      });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-sessions/:session_id/goals', {
    schema: { params: sessionParams, body: startGoalBody,
      response: { 200: commandEnvelopeSchema(goalCommandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'StartAssistGoal', bodySchema: startGoalBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await startGoalFromPlan(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.session_id ?? '',
        commandId: body.command_id, planId: body.plan_id,
        ...(body.allow_superseded === undefined ? {} : {
          allowSuperseded: body.allow_superseded }),
      });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-goals/:goal_id/pause', {
    schema: { params: goalParams, body: controlBody,
      response: { 200: commandEnvelopeSchema(goalCommandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'PauseAssistGoal',
    bodySchema: controlBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await pauseGoal(executor, { workspaceId: params.workspace_id ?? '',
        goalId: params.goal_id ?? '', commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-goals/:goal_id/cancel', {
    schema: { params: goalParams, body: controlBody,
      response: { 200: commandEnvelopeSchema(goalCommandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'CancelAssistGoal',
    bodySchema: controlBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await cancelGoal(executor, { workspaceId: params.workspace_id ?? '',
        goalId: params.goal_id ?? '', commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  // 「继续」在额度耗尽时按可核对事实授予一个窗口；其余状态只是恢复推进。
  app.post('/assist-goals/:goal_id/resume', {
    schema: { params: goalParams, body: controlBody,
      response: { 200: commandEnvelopeSchema(goalCommandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'ResumeAssistGoal',
    bodySchema: controlBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await resumeGoalCommand(executor, {
        workspaceId: params.workspace_id ?? '', goalId: params.goal_id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  // 人工确认完成：只有这条命令能把目标写成 COMPLETED。
  app.post('/assist-goals/:goal_id/complete', {
    schema: { params: goalParams, body: controlBody,
      response: { 200: commandEnvelopeSchema(goalCommandResult) } },
  }, createCommandHandler(dependencies, { commandType: 'ConfirmAssistGoal',
    bodySchema: controlBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await confirmGoalCompletion(executor, {
        workspaceId: params.workspace_id ?? '', goalId: params.goal_id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));
}
