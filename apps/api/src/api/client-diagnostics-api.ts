import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { getRuntimeLogger } from '../infrastructure/runtime-log.js';

/**
 * 前端异常诊断的受控落盘入口（工作台 P0-3）。
 *
 * 只接受固定字段、固定枚举与有界长度；没有任意附加字段，也没有自由正文。它挂在
 * API 的 Bearer 作用域下，沿用同一套来源/主机边界，不开放匿名写入。这里刻意不访问
 * 数据库——前端初始化失败往往伴随数据库不可用，诊断入口本身不能因此失效。
 *
 * 客户端已做一次限频；服务端仍保留第二道窗口，避免被改坏的前端或脚本刷爆磁盘。
 */
const strict = { additionalProperties: false } as const;

const diagnosticBody = Type.Object({
  kind: Type.Union([
    Type.Literal('render'),
    Type.Literal('uncaught'),
    Type.Literal('unhandled_rejection'),
    Type.Literal('init'),
    Type.Literal('api_5xx'),
  ]),
  message: Type.String({ minLength: 1, maxLength: 1000 }),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  stack: Type.Optional(Type.String({ maxLength: 4000 })),
  component_stack: Type.Optional(Type.String({ maxLength: 4000 })),
  route: Type.Optional(Type.String({ maxLength: 500 })),
  request_id: Type.Optional(Type.String({ maxLength: 128 })),
  error_code: Type.Optional(Type.String({ maxLength: 128 })),
  status: Type.Optional(Type.Integer({ minimum: 400, maximum: 599 })),
  client_ts: Type.Optional(Type.String({ maxLength: 40 })),
}, strict);

interface DiagnosticBody {
  readonly kind: 'render' | 'uncaught' | 'unhandled_rejection' | 'init' | 'api_5xx';
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly component_stack?: string;
  readonly route?: string;
  readonly request_id?: string;
  readonly error_code?: string;
  readonly status?: number;
  readonly client_ts?: string;
}

const WINDOW_MS = 10_000;
const MAX_PER_KEY = 10;
const MAX_PER_WINDOW = 100;
const MAP_LIMIT = 256;

let windowStart = Date.now();
let windowCount = 0;
const recent = new Map<string, { windowStart: number; count: number }>();

function shouldRecord(body: DiagnosticBody, now: number): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_WINDOW) return false;
  const key = [body.kind, body.name ?? '', body.message.slice(0, 200),
    body.status === undefined ? '' : String(body.status)].join('|');
  const entry = recent.get(key);
  if (entry === undefined || now - entry.windowStart >= WINDOW_MS) {
    if (recent.size >= MAP_LIMIT) {
      const oldest = recent.keys().next().value;
      if (typeof oldest === 'string') recent.delete(oldest);
    }
    recent.set(key, { windowStart: now, count: 1 });
  } else {
    if (entry.count >= MAX_PER_KEY) return false;
    entry.count += 1;
  }
  windowCount += 1;
  return true;
}

export function registerClientDiagnosticsRoutes(app: FastifyInstance): void {
  app.post(
    '/client-diagnostics',
    { schema: { body: diagnosticBody } },
    async (request, reply) => {
      const body = request.body as DiagnosticBody;
      // 超限时同样返回 204：前端不应据此重试，服务端已经知道“有人在刷”。
      if (shouldRecord(body, Date.now())) {
        getRuntimeLogger('frontend').error('frontend_error', {
          surface: 'workbench',
          kind: body.kind,
          route: body.route ?? null,
          component_stack: body.component_stack ?? null,
          client_ts: body.client_ts ?? null,
          status_code: body.status ?? null,
          error_code: body.error_code ?? null,
          request_id: body.request_id ?? null,
          error: {
            name: body.name ?? 'FrontendError',
            message: body.message,
            ...(body.stack === undefined ? {} : { stack: body.stack }),
          },
        });
      }
      return reply.code(204).send();
    },
  );
}

/** 测试专用：清空限频窗口与键计数。 */
export function resetClientDiagnosticsRateLimitForTest(): void {
  windowStart = Date.now();
  windowCount = 0;
  recent.clear();
}
