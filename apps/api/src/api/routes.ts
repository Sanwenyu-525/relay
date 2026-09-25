import type { FastifyInstance } from 'fastify';

import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { registerArtifactRoutes } from './artifact-api.js';
import { createBearerGuard, type BoundaryConfig } from './boundary.js';
import { registerCommandRoutes } from './command-api.js';
import { registerContextRoutes } from './context-api.js';
import { registerCompletionRoutes } from './completion-api.js';
import type { RouteDependencies } from './envelope.js';
import { databaseUnavailable, problemBody, schemaUnavailable } from './problem.js';
import { registerProjectRoutes } from './project-api.js';
import { registerRunRoutes } from './run-api.js';
import { registerGatewayRoutes } from './gateway-api.js';
import { registerInformationRoutes } from './information-api.js';
import { registerReviewRoutes } from './review-api.js';
import { LivenessSchema, ReadinessNotReadySchema, ReadinessReadySchema } from './schemas.js';
import { registerStateRoutes } from './state-api.js';
import { registerTaskRoutes } from './task-api.js';

export type { RouteDependencies };

/**
 * 业务 API 的统一前缀（docs/api/http-command-contract.md 第 1 节）。
 * Workspace 是路径上的作用域参数，所有业务路由都在它之下，跨作用域 ID 按不可见处理。
 */
export const API_PREFIX = '/api/v1/workspaces/:workspace_id';

export interface RouteDependenciesInput {
  readonly config: BoundaryConfig;
  /** 受管内容根目录：Artifact 内容只写在它下面，路径由服务端按内部 ID 生成。 */
  readonly dataRoot: string;
  readonly database: RelayDatabase;
  readonly schemaReadiness: SchemaReadinessChecker;
}

export function registerRoutes(
  app: FastifyInstance,
  // config 供 loopback 边界使用；领域路由只需要 database.executor，不额外持有连接池语义。
  dependencies: RouteDependenciesInput,
): void {
  const apiDependencies: RouteDependencies = {
    database: dependencies.database,
    storage: new ManagedContentStore(dependencies.dataRoot),
  };

  app.get(
    '/health/live',
    { schema: { response: { 200: LivenessSchema } } },
    async () => ({ status: 'alive' as const }),
  );

  app.register(async (scope) => {
    scope.addHook('onRequest', createBearerGuard(dependencies.config.bearerToken));

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

        if (probe.database === 'up' && probe.schema === 'up') {
          return {
            status: 'ready' as const,
            components: {
              database: { status: 'up' as const },
              schema: { status: 'up' as const },
            },
          };
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

  app.register(
    async (scope) => {
      scope.addHook('onRequest', createBearerGuard(dependencies.config.bearerToken));

      registerProjectRoutes(scope, apiDependencies);
      registerTaskRoutes(scope, apiDependencies);
      registerArtifactRoutes(scope, apiDependencies);
      registerCompletionRoutes(scope, apiDependencies);
      registerStateRoutes(scope, apiDependencies);
      registerRunRoutes(scope, apiDependencies);
      registerContextRoutes(scope, apiDependencies);
      registerGatewayRoutes(scope, apiDependencies);
      registerInformationRoutes(scope, apiDependencies);
      registerReviewRoutes(scope, apiDependencies);
      registerCommandRoutes(scope, apiDependencies);
    },
    { prefix: API_PREFIX },
  );
}
