/**
 * 浏览器后端状态 API（migration 0106，F26 M2）。
 *
 *   GET  /browser/status                       后端健康结论（版本、可操作建议、上次检查时间）
 *   GET  /browser/sessions                     当前浏览器任务（Worker 写入的状态投影）
 *   POST /browser/sessions/{owner}/{id}/stop    停止一个浏览器任务（仅 RUN 归属）
 *
 * 为什么不是「API 去问一下后端」：浏览器后端由 Worker 进程持有，API 进程再去启动
 * 一份就会变成两个 Chrome。这里读的是 Worker 写下的投影，与桌面壳看到的完全一致。
 *
 * 这是安装级的运行时诊断，不是工作区业务数据，因此不带 workspace 参数，也不做
 * 跨工作区可见性裁剪。
 */

import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { readBrowserBackendState } from '../browser/state.js';
import { dispatchBridgeCommand } from '../browser/bridge.js';
import { BROWSER_SESSION_IDLE_MS } from '../browser/sessions.js';
import { readBrowserSessions, requestBrowserSessionStop } from '../browser/sessions.js';
import type { RouteDependencies } from './envelope.js';
import { sendReadError } from './envelope.js';

const strict = { additionalProperties: false } as const;

const statusResponse = Type.Object({
  status: Type.Union([
    Type.Literal('NOT_STARTED'), Type.Literal('READY'), Type.Literal('CHROME_MISSING'),
    Type.Literal('BACKEND_MISSING'), Type.Literal('INCOMPATIBLE'),
    Type.Literal('DISCONNECTED'),
  ]),
  backend_version: Type.Union([Type.String(), Type.Null()]),
  chrome_version: Type.Union([Type.String(), Type.Null()]),
  detail: Type.String(),
  remediation: Type.Union([Type.String(), Type.Null()]),
  tool_count: Type.Integer(),
  updated_at: Type.Union([Type.String(), Type.Null()]),
}, strict);

export function registerBrowserRoutes(app: FastifyInstance,
  dependencies: RouteDependencies): void {
  app.get('/browser/status', { schema: { response: { 200: statusResponse } } },
    async (request, reply) => {
      // 与其它只读投影一致：健康结论随 Worker 实测变化，绝不缓存。
      reply.header('Cache-Control', 'no-store');
      try {
        return await readBrowserBackendState(dependencies.database.executor);
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    });

  // workspace_id 来自全站路由前缀，必须一起声明：strict 对象下它是"多出来的属性"，
  // 漏声明会被 Fastify 判成 422（实测踩过）。
  const sessionItemParams = Type.Object({
    workspace_id: Type.String({ format: 'uuid' }),
    owner_kind: Type.Union([Type.Literal('RUN'), Type.Literal('SESSION')]),
    owner_id: Type.String({ format: 'uuid' }),
  }, strict);

  const sessionDto = Type.Object({
    owner_kind: Type.Union([Type.Literal('RUN'), Type.Literal('SESSION')]),
    owner_id: Type.String(),
    page_id: Type.Integer(),
    url: Type.String(),
    title: Type.String(),
    action_type: Type.Union([Type.String(), Type.Null()]),
    action_label: Type.Union([Type.String(), Type.Null()]),
    state: Type.String(),
    started_at: Type.Union([Type.String(), Type.Null()]),
    updated_at: Type.Union([Type.String(), Type.Null()]),
  }, strict);

  const sessionsResponse = Type.Object({
    sessions: Type.Array(sessionDto),
    idle_ms: Type.Integer(),
  }, strict);

  const stopResponse = Type.Object({
    state: Type.Union([Type.Literal('STOP_REQUESTED'), Type.Literal('STOPPED')]),
    control_request_id: Type.Union([Type.String(), Type.Null()]),
  }, strict);

  app.get('/browser/sessions', { schema: { response: { 200: sessionsResponse } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const params = request.params as { workspace_id: string };
      try {
        return { sessions: await readBrowserSessions(dependencies.database.executor,
          params.workspace_id), idle_ms: BROWSER_SESSION_IDLE_MS };
      } catch (error) {
        return sendReadError(reply, error, request.id);
      }
    });

  app.post('/browser/sessions/:owner_kind/:owner_id/stop', {
    schema: { params: sessionItemParams, response: { 200: stopResponse } },
  }, async (request, reply) => {
    const params = request.params as { workspace_id: string;
      owner_kind: 'RUN' | 'SESSION'; owner_id: string };
    try {
      return await requestBrowserSessionStop(dependencies.database.executor, {
        workspaceId: params.workspace_id,
        ownerKind: params.owner_kind, ownerId: params.owner_id,
      });
    } catch (error) {
      return sendReadError(reply, error, request.id);
    }
  });
}

/**
 * 浏览器桥接的命令入口（Worker → API → 扩展）。
 *
 * 鉴权用桥接令牌而不是 bearer：这是 Worker 进程访问的唯一通道，且独立令牌的可撤销
 * 影响面只有浏览器操作。路由注册在独立的 bridge scope 里（见 routes.ts）。
 */
export function registerBrowserBridgeCommandRoutes(app: FastifyInstance, dependencies: {
  readonly database: RouteDependencies['database'];
  readonly bridgeToken: string;
}): void {
  app.addHook('onRequest', async (request, reply) => {
    const provided = request.headers['x-bridge-token'];
    if (typeof provided !== 'string' || provided.length < 32 ||
        provided !== dependencies.bridgeToken) {
      await reply.code(401).type('application/problem+json').send({
        type: '/problems/auth-required', title: '浏览器桥接未授权', status: 401,
        detail: '缺少或错误的桥接令牌。', code: 'BROWSER_BRIDGE_UNAUTHORIZED',
        request_id: request.id, retryable: false, retry_action: 'NONE',
        instance: request.url, field_errors: [], conflict: undefined,
      });
    }
  });

  app.post('/browser-bridge/commands', {
    // 不走 schema 严格校验：命令形状由桥接层与扩展各自校验，这里只做通道。
    // 响应不声明 schema：成功 200、扩展缺失 503、上游失败 502，各带不同形状。
    schema: {},
  }, async (request, reply) => {
    const body = request.body as { op?: unknown; params?: unknown; timeout_ms?: unknown };
    if (typeof body.op !== 'string' || body.op === '' ||
        typeof body.params !== 'object' || body.params === null) {
      await reply.code(422).type('application/problem+json').send({
        type: '/problems/validation-failed', title: '请求未通过校验', status: 422,
        detail: '桥接命令需要 op 与 params。', code: 'VALIDATION_FAILED',
        request_id: request.id, retryable: false, retry_action: 'NONE',
        instance: request.url, field_errors: [], conflict: undefined,
      });
      return reply;
    }
    const timeoutMs = typeof body.timeout_ms === 'number' &&
      body.timeout_ms > 0 && body.timeout_ms <= 120_000 ? body.timeout_ms : 60_000;
    try {
      const result = await dispatchBridgeCommand(body.op,
        body.params as Record<string, unknown>, timeoutMs);
      return { ok: result.ok, result: result.result ?? null,
        error: result.error ?? null, extension_version: result.extensionVersion };
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? String((error as { code: unknown }).code) : 'BROWSER_ACTION_FAILED';
      const status = code === 'BROWSER_EXTENSION_MISSING' ? 503 : 502;
      await reply.code(status).type('application/problem+json').send({
        type: `/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: '浏览器桥接命令失败', status,
        detail: error instanceof Error ? error.message : String(error),
        code, request_id: request.id, retryable: status === 503,
        retry_action: 'NONE', instance: request.url, field_errors: [], conflict: undefined,
      });
      return reply;
    }
  });
}
