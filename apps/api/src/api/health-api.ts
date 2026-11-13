import type { FastifyInstance } from 'fastify';

import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import { createBearerGuard } from './boundary.js';
import { databaseUnavailable, problemBody, schemaUnavailable } from './problem.js';
import { LivenessSchema, ReadinessNotReadySchema, ReadinessReadySchema } from './schemas.js';

/**
 * 就绪探针的 5xx 落盘点（2026-11-12）。
 *
 * `/health/ready` 是唯一不经全局错误处理器直接回 503 的端点。客户端按秒轮询，
 * 所以这里只记录状态变化与低频心跳：每次失败都写会把日志刷爆，而完全不写时
 * 「服务为什么一直 503」在日志里查不到任何证据。
 *
 * 降级归属：status 由数据库/schema 探测结果决定，record 带上当次 request_id，
 * 用户报告的 503 仍能用响应体里的 request_id 与这条记录对应。
 */
type ReadinessStatus = 'ready' | 'schema_unavailable' | 'database_unavailable';

const UNAVAILABLE_HEARTBEAT_MS = 5 * 60_000;

export interface HealthRouteDependencies {
  readonly bearerToken: string;
  readonly database: RelayDatabase;
  readonly schemaReadiness: SchemaReadinessChecker;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthRouteDependencies,
): void {
  app.get(
    '/health/live',
    { schema: { response: { 200: LivenessSchema } } },
    async () => ({ status: 'alive' as const }),
  );

  app.register(async (scope) => {
    scope.addHook('onRequest', createBearerGuard(dependencies.bearerToken));

    let lastStatus: ReadinessStatus | 'unknown' = 'unknown';
    let lastChangeAt = 0;
    let lastHeartbeatAt = 0;
    let failedProbes = 0;

    scope.get(
      '/health/ready',
      {
        schema: {
          response: {
            200: ReadinessReadySchema,
            503: ReadinessNotReadySchema,
          },
        },
      },
      async (request, reply) => {
        const probe = await dependencies.database.checkReadiness(dependencies.schemaReadiness);
        const status: ReadinessStatus = probe.database === 'up' && probe.schema === 'up'
          ? 'ready'
          : probe.database === 'up' ? 'schema_unavailable' : 'database_unavailable';
        const now = Date.now();
        const logger = getRuntimeLogger('api-health');

        if (status === 'ready') {
          if (lastStatus !== 'ready' && lastStatus !== 'unknown') {
            logger.info('readiness_recovered', {
              previous_status: lastStatus,
              status,
              request_id: request.id,
              duration_ms: lastChangeAt === 0 ? 0 : now - lastChangeAt,
              failed_probes: failedProbes,
            });
          }
          lastStatus = 'ready';
          lastChangeAt = now;
          failedProbes = 0;
          return {
            status: 'ready' as const,
            components: {
              database: { status: 'up' as const },
              schema: { status: 'up' as const },
            },
          };
        }

        failedProbes += 1;
        if (status !== lastStatus) {
          logger.warn('readiness_degraded', {
            previous_status: lastStatus,
            status,
            request_id: request.id,
            database: probe.database,
            schema: probe.schema,
            failed_probes: failedProbes,
          });
          lastStatus = status;
          lastChangeAt = now;
          lastHeartbeatAt = now;
        } else if (now - lastHeartbeatAt >= UNAVAILABLE_HEARTBEAT_MS) {
          logger.warn('readiness_still_unavailable', {
            status,
            request_id: request.id,
            database: probe.database,
            schema: probe.schema,
            failed_probes: failedProbes,
            unavailable_ms: now - lastChangeAt,
          });
          lastHeartbeatAt = now;
        }

        if (probe.database === 'up') {
          return reply.code(503).type('application/problem+json').send({
            ...problemBody(schemaUnavailable(), request.id),
            components: {
              database: { status: 'up' },
              schema: { status: 'down' },
            },
          });
        }

        return reply.code(503).type('application/problem+json').send({
          ...problemBody(databaseUnavailable(), request.id),
          components: {
            database: { status: 'down' },
            schema: { status: 'unknown' },
          },
        });
      },
    );
  });
}
