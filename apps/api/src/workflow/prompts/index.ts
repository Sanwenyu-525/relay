import * as conversationPrompts from './conversation-prompts.js';
import * as interpretationPrompts from './interpretation-prompts.js';
import * as runPrompts from './run-prompts.js';
import { draftRouteIdFor, RUNTIME_ROUTES, UnknownRuntimePromptRouteError,
  type RuntimePromptRoute, type RuntimePromptSelection, type RuntimeRouteId,
  type RuntimeSystemRoute } from './route-types.js';

/**
 * 运行时提示词路由：**唯一统一入口**（主 Agent 独占）。
 *
 * 它只做三件事：按调用方已经确定的场景选模板、把模板文本组合成最终 system、
 * 返回可核对的本次元数据（路由标识 + 专用模板版本 + 公共核心版本）。
 *
 * 它**不**做这些事：访问数据库、查当前业务事实、校验或冻结 Skill/方法、选择来源、
 * 判定权限、开事务、定调用预算、发起模型调用、给工具准入。这些仍归原应用用例与
 * 模型端口，路由器集中提示词不改变任何 Owner。
 *
 * `assist()` / `interpret()` 仍由 Application 准备好 `system` 后交给真实端口直接发送；
 * `generate()` / `evaluate()` / 连接验证在端口或用例内经本入口取各自固定模板。
 */

function systemSelection(routeId: RuntimeRouteId, system: string): RuntimePromptSelection {
  const route = RUNTIME_ROUTES[routeId];
  return { kind: 'SYSTEM', route, coreIncluded: route.coreVersion !== null, system };
}

export type RuntimeSystemSelection = Extract<RuntimePromptSelection, { readonly kind: 'SYSTEM' }>;

/**
 * 只需要最终 system 文本的调用方用它。
 *
 * 输入类型已排除 `CONNECTION_VERIFY`，因此这里的分支是类型完备性守卫而非真实分支；
 * 它存在的意义是让 5 个调用点不必各写一遍不可达的 `kind !== 'SYSTEM'` 判断。
 */
export function selectRuntimeSystemPrompt(route: RuntimeSystemRoute): RuntimeSystemSelection {
  const selection = selectRuntimePrompt(route);
  if (selection.kind !== 'SYSTEM') {
    throw new UnknownRuntimePromptRouteError(selection.route.routeId);
  }
  return selection;
}

export function selectRuntimePrompt(route: RuntimePromptRoute): RuntimePromptSelection {
  switch (route.kind) {
    /* ------------------------------ 会话档 ------------------------------ */
    case 'ASSIST_DISCUSS':
      return systemSelection('ASSIST_DISCUSS',
        conversationPrompts.assistIntentSystemPrompt('DISCUSS'));
    case 'ASSIST_IMPACT_CHECK':
      return systemSelection('ASSIST_IMPACT_CHECK',
        conversationPrompts.assistIntentSystemPrompt('IMPACT_CHECK'));
    case 'ASSIST_IMPACT_CANDIDATE':
      return systemSelection('ASSIST_IMPACT_CANDIDATE',
        conversationPrompts.assistIntentSystemPrompt('IMPACT_CANDIDATE'));
    case 'ASSIST_PROPOSE_CANDIDATE':
      return systemSelection('ASSIST_PROPOSE_CANDIDATE',
        conversationPrompts.assistIntentSystemPrompt('PROPOSE_CANDIDATE'));
    case 'ASSIST_PROPOSE_TASK':
      return systemSelection('ASSIST_PROPOSE_TASK',
        conversationPrompts.assistIntentSystemPrompt('PROPOSE_TASK'));
    case 'ASSISTANT_READONLY':
      return systemSelection('ASSISTANT_READONLY',
        conversationPrompts.assistantReadonlySystemPrompt(route.snapshot,
          route.readScopeRoots));
    case 'AGENT_MAIN_LOOP':
      return systemSelection('AGENT_MAIN_LOOP',
        conversationPrompts.agentMainLoopSystemPrompt());
    case 'LEARNING_PARTNER':
      return systemSelection('LEARNING_PARTNER',
        conversationPrompts.learningPartnerSystemPrompt(route.state, route.material));
    case 'SKILL':
      return systemSelection('SKILL', conversationPrompts.skillSystemPrompt(route.skill));
    case 'METHOD':
      return systemSelection('METHOD',
        conversationPrompts.methodSystemPrompt(route.method, route.action));
    /* ---------------------------- 解释（端口） ---------------------------- */
    case 'INTERPRETATION_EXECUTION':
      return systemSelection('INTERPRETATION_EXECUTION',
        interpretationPrompts.interpretationExecutionSystemPrompt());
    case 'INTERPRETATION_STATE_MAINTENANCE':
      return systemSelection('INTERPRETATION_STATE_MAINTENANCE',
        interpretationPrompts.interpretationStateMaintenanceSystemPrompt());
    /* ------------------------------ Run 档 ------------------------------ */
    case 'DRAFT':
      return systemSelection(draftRouteIdFor(route.capability),
        route.capability.toolsEnabled
          ? runPrompts.draftToolSystemPrompt(route.capability.canWrite)
          : runPrompts.draftNoToolSystemPrompt());
    case 'SEMANTIC_VERDICT':
      return systemSelection('SEMANTIC_VERDICT', runPrompts.semanticVerdictSystemPrompt());
    /* --------------------------- 连接验证探针 --------------------------- */
    case 'CONNECTION_VERIFY':
      return { kind: 'USER_PROBE', route: RUNTIME_ROUTES.CONNECTION_VERIFY,
        probe: runPrompts.connectionVerifyUserProbe() };
    default: {
      // 穷尽性守卫：新增路由必须在这里显式接线，不能落进某个默认分支。
      const exhaustive: never = route;
      throw new UnknownRuntimePromptRouteError(
        (exhaustive as { readonly kind: string }).kind);
    }
  }
}

export { RUNTIME_ROUTES, RUNTIME_ROUTE_IDS, UnknownRuntimePromptRouteError,
  draftRouteIdFor } from './route-types.js';
export type { RuntimeDraftCapabilityInput, RuntimePromptRoute,
  RuntimePromptSelection, RuntimeRouteDescriptor, RuntimeRouteGroup, RuntimeRouteId,
  RuntimeSystemRoute } from './route-types.js';
