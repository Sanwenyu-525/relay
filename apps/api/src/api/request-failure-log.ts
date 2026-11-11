import type { FastifyRequest } from 'fastify';

import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import type { ProblemDetails } from './problem.js';

/**
 * 请求失败的单一落盘点（2026-11-10）。
 *
 * 桌面模式 Fastify 关闭了 pino（`logger: false`），`request.log.*` 是 no-op；只依赖它时，
 * 用户看到的 5xx 在日志里没有任何记录，而响应体又只给出 request_id。这里把状态码
 * >= 500 的失败统一写进 runtime log，字段口径对齐 docs/deployment/本机部署.md §5。
 *
 * 刻意不记录请求体、query 与 header：排障只需要身份与位置，敏感内容不落盘。
 */
export interface RequestFailureIds {
  readonly command_id?: string | undefined;
  readonly task_id?: string | undefined;
  readonly run_id?: string | undefined;
  readonly project_id?: string | undefined;
  readonly operation_id?: string | undefined;
  readonly invocation_id?: string | undefined;
}

function routeTemplateOf(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (typeof route === 'string' && route.length > 0) return route;
  // 没有路由模板时退回去掉 query 的 path：避免把查询参数带进日志。
  return request.url.split('?')[0] ?? request.url;
}

function presentIds(ids: RequestFailureIds): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(ids)) {
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  return result;
}

/** 5xx 内部失败。4xx 业务拒绝不是 bug，直接跳过，避免日志被正常冲突淹没。 */
export function logRequestFailure(request: FastifyRequest, error: unknown,
  problem: ProblemDetails, ids: RequestFailureIds = {}): void {
  if (problem.status < 500) return;
  getRuntimeLogger('api-request').error('request_failed', {
    request_id: request.id,
    method: request.method,
    route: routeTemplateOf(request),
    status_code: problem.status,
    code: problem.code,
    ...presentIds(ids),
    error,
  });
}

/** 领域错误本应在路由内映射；走到全局 handler 说明有路由漏接，记一条便于排查。 */
export function logDomainErrorReachedGlobalHandler(request: FastifyRequest, error: unknown): void {
  getRuntimeLogger('api-request').warn('domain_error_reached_global_handler', {
    request_id: request.id,
    method: request.method,
    route: routeTemplateOf(request),
    error,
  });
}
