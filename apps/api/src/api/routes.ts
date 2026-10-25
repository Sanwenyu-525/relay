import type { FastifyInstance } from 'fastify';

import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { registerArtifactRoutes } from './artifact-api.js';
import { registerAttentionRoutes } from './attention-api.js';
import { registerAssistRoutes } from './assist-api.js';
import { registerAssistMemoryRoutes } from './assist-memory-api.js';
import { registerMemoryCaptureRoutes } from './memory-capture-api.js';
import { registerAssistModelRuntimeRoutes } from './assist-model-runtime-api.js';
import { registerChatCommandRoutes } from './chat-command-api.js';
import { createBearerGuard, type BoundaryConfig } from './boundary.js';
import { registerCommandRoutes } from './command-api.js';
import { registerContextRoutes } from './context-api.js';
import { registerCompletionRoutes } from './completion-api.js';
import type { RouteDependencies } from './envelope.js';
import { databaseUnavailable, problemBody, schemaUnavailable } from './problem.js';
import { registerProjectRoutes } from './project-api.js';
import { registerProjectContinuationRoutes } from './project-continuation-api.js';
import { registerProjectKnowledgeGuideRoutes } from './project-knowledge-guide-api.js';
import { registerRunRoutes } from './run-api.js';
import { registerGatewayRoutes } from './gateway-api.js';
import { registerGitUserActionRoutes } from './git-user-action-api.js';
import { registerFileUserActionRoutes } from './file-user-action-api.js';
import { registerAssistantProfileRoutes } from './assistant-profile-api.js';
import { registerInformationRoutes } from './information-api.js';
import { registerReviewRoutes } from './review-api.js';
import { LivenessSchema, ReadinessNotReadySchema, ReadinessReadySchema } from './schemas.js';
import { registerStateRoutes } from './state-api.js';
import { registerTaskRoutes } from './task-api.js';
import { registerTodayRoutes } from './today-api.js';
import { registerActivityRoutes } from './activity-api.js';
import { registerTraceRoutes } from './trace-api.js';
import { registerLineageRoutes } from './lineage-api.js';
import { registerFirstPartySkillRoutes } from './first-party-skills-api.js';
import { registerViewConfigurationRoutes } from './view-configuration-api.js';
import { registerWorkingDirectoryRoutes } from './working-directory-api.js';
import { registerConversationExecutionRoutes } from './conversation-execution-api.js';
import { registerPlanGoalRoutes } from './plan-goal-api.js';
import { registerStateMaintenanceRoutes } from './state-maintenance-api.js';
import { registerProjectDailyContinuationRoutes } from './project-daily-continuation-api.js';
import { registerLearningRoutes } from './learning-api.js';
import { registerTaskAcceptanceMaterialRoutes } from './task-acceptance-material-api.js';
import { registerTaskAcceptanceTrialRoutes } from './task-acceptance-trial-api.js';
import { registerTaskAcceptanceComparisonRoutes } from './task-acceptance-comparison-api.js';
import { registerHypothesisRoutes } from './hypothesis-api.js';
import { registerDecisionReviewRoutes } from './decision-review-api.js';
import { registerWorkSegmentRoutes } from './work-segment-api.js';
import { registerPersonalPlanningRoutes } from './personal-planning-api.js';
import { registerScopeSimulationRoutes } from './plan-scope-simulation-api.js';
import { registerProjectReminderRoutes } from './project-reminder-api.js';
import { registerProjectReminderScheduler } from '../runtime/project-reminder-scheduler.js';
import { registerTaskChainScheduler } from '../runtime/task-chain-scheduler.js';
import { registerTaskChainRoutes } from './task-chain-api.js';
import { registerScheduledTaskRoutes } from './scheduled-task-api.js';
import { registerAgentMemberRoutes } from './agent-member-api.js';
import { registerMemberConversationRoutes } from './member-conversation-api.js';
import { registerScheduledTaskScheduler } from '../runtime/scheduled-task-scheduler.js';
import { registerBlueprintRoutes } from './blueprint-api.js';
import { registerModelRoutes } from './model-api.js';
import { registerComposerRoutes } from './composer-api.js';
import { registerComputerRoutes } from './computer-api.js';
import { registerBrowserBridgeCommandRoutes, registerBrowserRoutes } from './browser-api.js';
import { registerPluginRoutes } from './plugins-api.js';
import { ensureBridgeRegistration } from '../browser/bridge.js';

export type { RouteDependencies };

/**
 * 浏览器桥接路由：独立 scope，鉴权用桥接令牌而不是 bearer（Worker 是唯一调用方，
 * 把 bearer 交给扩展/Worker 会扩大泄露面）。前缀 `/api/v1`，不带 workspace 段——
 * 桥接是安装级通道，不是工作区业务。
 */
export function registerBrowserBridgeRoutes(app: FastifyInstance, dependencies: {
  readonly bridgeToken: string;
  readonly dataRoot: string;
  readonly database: Parameters<typeof registerBrowserBridgeCommandRoutes>[1]['database'];
}): void {
  app.register(async (scope) => {
    registerBrowserBridgeCommandRoutes(scope, dependencies);
  }, { prefix: '/api/v1' });
}

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
  registerProjectReminderScheduler(app, dependencies);
  const taskChainRuntimeId=registerTaskChainScheduler(app,dependencies);
  registerScheduledTaskScheduler(app, dependencies);
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
      registerProjectContinuationRoutes(scope, apiDependencies);
registerProjectKnowledgeGuideRoutes(scope, apiDependencies);
      registerTaskRoutes(scope, apiDependencies);
      registerTaskAcceptanceMaterialRoutes(scope, apiDependencies);
    registerTaskAcceptanceTrialRoutes(scope, apiDependencies);
    registerTaskAcceptanceComparisonRoutes(scope, apiDependencies);
    registerHypothesisRoutes(scope, apiDependencies);
    registerDecisionReviewRoutes(scope, apiDependencies);
    registerWorkSegmentRoutes(scope, apiDependencies);
    registerPersonalPlanningRoutes(scope, apiDependencies);
    registerScopeSimulationRoutes(scope, apiDependencies);
    registerProjectReminderRoutes(scope, apiDependencies);
    registerTaskChainRoutes(scope,apiDependencies,taskChainRuntimeId);
    registerScheduledTaskRoutes(scope, apiDependencies);
    registerAgentMemberRoutes(scope, apiDependencies);
    registerMemberConversationRoutes(scope, apiDependencies);
      registerTodayRoutes(scope, apiDependencies);
      registerActivityRoutes(scope, apiDependencies);
      registerTraceRoutes(scope, apiDependencies);
      registerLineageRoutes(scope, apiDependencies);
      registerFirstPartySkillRoutes(scope, apiDependencies);
      registerViewConfigurationRoutes(scope, apiDependencies);
      registerBlueprintRoutes(scope, apiDependencies);
      registerArtifactRoutes(scope, apiDependencies);
      registerAttentionRoutes(scope, apiDependencies);
      registerModelRoutes(scope, apiDependencies);
      // 工作台 §30：发送前草稿辅助（分点边界 / 润色）。不写业务事实，只记模型调用证据。
      registerComposerRoutes(scope, apiDependencies);
      registerCompletionRoutes(scope, apiDependencies);
      registerStateRoutes(scope, apiDependencies);
      registerRunRoutes(scope, apiDependencies);
      registerContextRoutes(scope, apiDependencies);
      registerGatewayRoutes(scope, apiDependencies);
      registerGitUserActionRoutes(scope, apiDependencies);
      // 0134：人工受管目录浏览与文件读取（工具面板「文件」页签后端，只读）。
      registerFileUserActionRoutes(scope, apiDependencies);
      registerInformationRoutes(scope, apiDependencies);
      registerReviewRoutes(scope, apiDependencies);
      registerAssistRoutes(scope, apiDependencies);
      registerAssistMemoryRoutes(scope, apiDependencies);
      registerMemoryCaptureRoutes(scope, apiDependencies);
      registerAssistModelRuntimeRoutes(scope, apiDependencies);
      registerChatCommandRoutes(scope, apiDependencies);
      registerAssistantProfileRoutes(scope, apiDependencies);
      registerWorkingDirectoryRoutes(scope, apiDependencies);
      registerConversationExecutionRoutes(scope, apiDependencies);
      // 0127：聊天 /plan 与 /goal 的计划版本、活动目标与控制（HTTP §10.108）。
      registerPlanGoalRoutes(scope, apiDependencies);
      registerStateMaintenanceRoutes(scope, apiDependencies);
      registerProjectDailyContinuationRoutes(scope, apiDependencies);
      // 0072：学习记录（ADR-020）。读路径只读应用保存的同一记录，不调模型总结。
      registerLearningRoutes(scope, apiDependencies);
      registerCommandRoutes(scope, apiDependencies);
      // 电脑操控状态（migration 0096）：桌面壳轮询的展示状态与 Esc 取消入口。
      registerComputerRoutes(scope, apiDependencies);
      // 浏览器后端状态（migration 0106）：Worker 写入的健康投影，只读。
      registerBrowserRoutes(scope, apiDependencies);
      registerPluginRoutes(scope, apiDependencies);
    },
    { prefix: API_PREFIX },
  );
}
