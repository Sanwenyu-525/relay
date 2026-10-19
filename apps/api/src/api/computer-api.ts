/**
 * Computer Control 会话状态 API（migration 0096）。
 *
 * 读取方是桌面壳（Tauri 宿主）：它轮询本端点决定屏幕边缘光效与顶部状态条，
 * 并把「按 Esc」翻译成这里的取消入口。状态的事实来源是 Worker 派发路径的
 * 上报（gateway-actions → computer/control-state.ts），本文件不制造状态。
 *
 *   GET  /computer/control-session          当前操控状态（跨工作空间按不可见处理）
 *   POST /computer/control-session/cancel   Esc 退出：RUNNING → STOP_REQUESTED，
 *                                           并向 Run 入队 CANCEL（既有控制通道）
 */

import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { DomainError } from '../application/domain-error.js';
import { requestComputerControlStop } from '../application/control-requests.js';
import { ComputerControlStateRepository, readComputerControlSession } from '../computer/control-state.js';
import type { RouteDependencies } from './envelope.js';
import { sendReadError } from './envelope.js';

const strict = { additionalProperties: false } as const;
const workspaceParams = Type.Object({ workspace_id: Type.String({ format: 'uuid' }) }, strict);

const controlSessionResponse = Type.Object({
  state: Type.Union([
    Type.Literal('RUNNING'), Type.Literal('STOP_REQUESTED'), Type.Literal('STOPPED'),
  ]),
  action_type: Type.Union([Type.String(), Type.Null()]),
  action_label: Type.Union([Type.String(), Type.Null()]),
  run_id: Type.Union([Type.String(), Type.Null()]),
  started_at: Type.Union([Type.String(), Type.Null()]),
  updated_at: Type.Union([Type.String(), Type.Null()]),
}, strict);

const cancelResponse = Type.Object({
  state: Type.Union([
    Type.Literal('RUNNING'), Type.Literal('STOP_REQUESTED'), Type.Literal('STOPPED'),
  ]),
  control_request_id: Type.Union([Type.String(), Type.Null()]),
}, strict);

export function registerComputerRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  const executor = dependencies.database.executor;

  app.get('/computer/control-session', {
    schema: { params: workspaceParams, response: { 200: controlSessionResponse } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const params = request.params as { workspace_id: string };
      return await readComputerControlSession(executor, params.workspace_id);
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });

  app.post('/computer/control-session/cancel', {
    schema: { params: workspaceParams, response: { 200: cancelResponse } },
  }, async (request, reply) => {
    const params = request.params as { workspace_id: string };
    const row = await new ComputerControlStateRepository(executor).readLatest();
    // 没有活跃操控、状态已是终态、或状态属于别的空间：按已停止幂等返回。
    if (row === undefined || row.state === 'STOPPED' || row.workspace_id !== params.workspace_id) {
      return { state: 'STOPPED' as const, control_request_id: null };
    }
    if (row.state === 'STOP_REQUESTED') {
      return { state: 'STOP_REQUESTED' as const, control_request_id: null };
    }
    try {
      const control = await requestComputerControlStop(executor, {
        workspaceId: params.workspace_id, runId: row.run_id,
      });
      return { state: 'STOP_REQUESTED' as const, control_request_id: control.id };
    } catch (error) {
      if (error instanceof DomainError) return sendReadError(reply, error, request.id);
      throw error;
    }
  });
}
