import type { JsonObject } from '../../infrastructure/json.js';
import type { FrozenMethod } from '../../skills/builtin-methods.js';
import type { FrozenSkill } from '../../skills/first-party-registry.js';
import { RELAY_AGENT_CORE_PROMPT_VERSION } from '../agent-system-prompt.js';
import type { AssistIntent } from '../fake-model-port.js';

/**
 * 运行时提示词路由：**冻结的共享契约**（主 Agent 独占）。
 *
 * 分层与职责（apps/api/src/workflow/prompts/）：
 *   * `route-types.ts`（本文件，主 Agent）：合法路由输入、返回形状、路由登记表。
 *     不 import 任何模板模块，也不 import application 的运行实现。
 *   * `conversation-prompts.ts` / `run-prompts.ts` / `interpretation-prompts.ts`
 *     （按职责分组的模板模块，由对应工作包独占）：各自返回**最终 system 文本**，
 *     由模板模块自己调用 `withRelayAgentCore()` 组合公共核心。
 *   * `index.ts`（主 Agent）：唯一统一入口 `selectRuntimePrompt()`，只做确定性
 *     选模板、组合文本与返回可核对元数据。
 *
 * 硬约束：
 *   * 路由器不访问数据库、不创建任务、不发起模型调用、不决定工具准入；
 *   * 每个需要公共核心的模板只组合一次核心；
 *   * 路由输入穷尽合法类型；未知值必须显式拒绝，不能让某个默认分支吞掉；
 *   * system 模板与连接验证的 user 探针在返回类型上分开，不能互相冒充。
 */

/** 普通 Assist 的五个既有意图（与 `assist_messages.intent` 同一封闭集合）。 */
export type RuntimeAssistIntent = AssistIntent;

/** DRAFT 分支按本次**实际工具清单**得到的能力档位。 */
export type RuntimeDraftCapabilityInput = {
  /** 本次请求是否声明了工具（空清单 = 无工具 DRAFT）。 */
  readonly toolsEnabled: boolean;
  /** 工具清单是否含 `apply_changeset`（只读清单与写清单不能串用）。 */
  readonly canWrite: boolean;
};

/**
 * 统一路由输入。
 *
 * 每个成员对应一个已经由 Application 用例或模型端口确定的场景与必要数据；
 * 路由器只消费这些已确定事实，不重新查询、不推断、不升级。
 */
export type RuntimePromptRoute =
  /* ---------------------------- 会话档 ---------------------------- */
  | { readonly kind: 'ASSIST_DISCUSS' }
  | { readonly kind: 'ASSIST_MEMORY_COMPACT' }
  | { readonly kind: 'ASSIST_IMPACT_CHECK' }
  | { readonly kind: 'ASSIST_IMPACT_CANDIDATE' }
  | { readonly kind: 'ASSIST_PROPOSE_CANDIDATE' }
  | { readonly kind: 'ASSIST_PROPOSE_TASK' }
  | { readonly kind: 'ASSISTANT_READONLY'; readonly snapshot: JsonObject;
      readonly readScopeRoots: readonly string[] }
  /**
   * 0087 / ADR-022：普通 Agent 连续主流程的读取轮次。
   *
   * 单独一条路由而不是复用 `ASSIST_DISCUSS`：声明了只读工具的轮次与不声明工具的轮次
   * **不能**共用同一段边界——旧 DISCUSS 模板写着「本轮你只生成对话回复，不自己调用工具」
   * 并要求「如实说明这次请求会由会话内的执行入口处理」，那正是把「没有文件读取能力」
   * 写进模型输入的那句话。工具可见性变了，模板就必须跟着变，否则模板变成一句谎话。
   * 0126：写工具可见性同样是模板必须跟随的事实。`writeEnabled` 为真时模板要声明
   * 「你可以直接改文件」并给出基线纪律；为假时保持只读表述与执行候选协议。
   */
  | { readonly kind: 'AGENT_MAIN_LOOP'; readonly writeEnabled?: boolean;
      /** 本轮词表里是否有只读工具；未归属会话借机器插件走主流程时为 false。 */
      readonly readTools?: boolean }
  /**
   * 0127：`/plan` 规划模式。只读模板——写工具根本不在词表里，因此这段文本不需要
   * 「用户要求修改时声明执行候选」那套协议；它要求的是形成结构化计划。
   */
  | { readonly kind: 'AGENT_PLAN_MODE' }
  /**
   * 0127：`/goal` 的一次推进轮。`state` 是服务端保存的目标状态（成功条件、步骤、进展），
   * 由调用方读出后原样交给模板；模板不查数据库，也不判断条件是否达成。
   */
  | { readonly kind: 'AGENT_GOAL_ROUND'; readonly state: JsonObject;
      readonly writeEnabled?: boolean }
  /**
   * 0128：有界子 Agent 的一次只读执行。`state` 是服务端冻结的委派事实
   * （角色、任务说明、范围、基线、输出要求），由调用方读出后原样交给模板。
   */
  | { readonly kind: 'AGENT_SUBAGENT'; readonly state: JsonObject }
  | { readonly kind: 'LEARNING_PARTNER'; readonly state: JsonObject;
      readonly material: readonly JsonObject[] }
  | { readonly kind: 'SKILL'; readonly skill: FrozenSkill }
  | { readonly kind: 'METHOD'; readonly method: FrozenMethod;
      readonly action: 'INSPECT' | 'MODIFY' | null;
      /**
       * 本轮是否声明了真实只读工具。
       *
       * 有工具时 MODIFY 可以按主流程信封声明执行候选；无工具轮只能给修改方案。
       * INSPECT / null 不受此位影响，始终只读。
       */
      readonly readTools: boolean; readonly writeEnabled?: boolean }
  /* -------------------------- 解释（模型端口） -------------------------- */
  | { readonly kind: 'INTERPRETATION_EXECUTION' }
  | { readonly kind: 'INTERPRETATION_STATE_MAINTENANCE' }
  /* ---------------------------- Run 档 ---------------------------- */
  | { readonly kind: 'DRAFT'; readonly capability: RuntimeDraftCapabilityInput }
  | { readonly kind: 'SEMANTIC_VERDICT' }
  /* ------------------------ 草稿辅助（§30） ------------------------ */
  /**
   * 发送前的草稿辅助：分点（只给原文边界）与润色（改写表达）。
   *
   * 与 Run 档分开：草稿辅助不产生 Task/Run，也不写任何业务事实；两条路由各自
   * 一句协议，不能与语义验收或 DRAFT 共用模板。
   */
  | { readonly kind: 'COMPOSER_OUTLINE' }
  | { readonly kind: 'COMPOSER_POLISH' }
  /* ------------------------ 连接验证（探针） ------------------------ */
  | { readonly kind: 'CONNECTION_VERIFY' };

/**
 * 只返回 system 提示词的路由输入（除连接验证那条固定 user 探针外的全部）。
 *
 * 只需要最终 system 文本的调用方用它：连接验证在类型上不可达，因此不可能把
 * 探针当 system 消息发出去。
 */
export type RuntimeSystemRoute = Exclude<RuntimePromptRoute,
  { readonly kind: 'CONNECTION_VERIFY' }>;

/** 路由标识：每个标识对应一句可核对的「本次用了哪条路由」。 */
export type RuntimeRouteId =
  | 'ASSIST_DISCUSS'
  | 'ASSIST_MEMORY_COMPACT'
  | 'ASSIST_IMPACT_CHECK'
  | 'ASSIST_IMPACT_CANDIDATE'
  | 'ASSIST_PROPOSE_CANDIDATE'
  | 'ASSIST_PROPOSE_TASK'
  | 'ASSISTANT_READONLY'
  | 'AGENT_MAIN_LOOP'
  | 'AGENT_PLAN_MODE'
  | 'AGENT_GOAL_ROUND'
  | 'AGENT_SUBAGENT'
  | 'LEARNING_PARTNER'
  | 'SKILL'
  | 'METHOD'
  | 'INTERPRETATION_EXECUTION'
  | 'INTERPRETATION_STATE_MAINTENANCE'
  | 'DRAFT_NO_TOOLS'
  | 'DRAFT_READ_ONLY_TOOLS'
  | 'DRAFT_WRITE_TOOLS'
  | 'SEMANTIC_VERDICT'
  | 'COMPOSER_OUTLINE'
  | 'COMPOSER_POLISH'
  | 'CONNECTION_VERIFY';

export type RuntimeRouteGroup = 'CONVERSATION' | 'INTERPRETATION' | 'RUN' | 'VERIFICATION' | 'COMPOSER';

/**
 * 一条路由的登记元数据。
 *
 * `templateVersion` 是本轮（2026-10-11）为专用模板登记的版本，适用起点即本次
 * 运行时提示词路由提取；**公共核心版本与 Skill/方法定义版本仍然是它们自己的值**，
 * 不顶替整个组合版本。历史调用没有记录组合版本的地方保持未知——不倒填、不声称
 * 完整提示词审计已经实现。
 */
export interface RuntimeRouteDescriptor {
  readonly routeId: RuntimeRouteId;
  readonly group: RuntimeRouteGroup;
  /** 专用模板版本；集中提取时为 1.0.0，正文行为修改后按路由更新。 */
  readonly templateVersion: string;
  /** 组合进最终文本的公共核心版本；不加载核心的路由为 null。 */
  readonly coreVersion: string | null;
  /** 模板正文的唯一维护位置（供导航，运行时不读取）。 */
  readonly templateSource: string;
  /** 一句中文说明，供日志与文档核对。 */
  readonly summary: string;
}

const CORE = RELAY_AGENT_CORE_PROMPT_VERSION;

/** 路由登记表：与 `RuntimePromptRoute` 一一对应，改路由先改这里。 */
export const RUNTIME_ROUTES: Readonly<Record<RuntimeRouteId, RuntimeRouteDescriptor>> = {
  ASSIST_MEMORY_COMPACT: { routeId: 'ASSIST_MEMORY_COMPACT', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '短期记忆：已结算轮次的接续摘要，不执行工具或改变业务事实' },
  ASSIST_DISCUSS: { routeId: 'ASSIST_DISCUSS', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '普通 Assist 讨论：Markdown 回答，不声明工具' },
  ASSIST_IMPACT_CHECK: { routeId: 'ASSIST_IMPACT_CHECK', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '影响检查：JSON possibly_related，只引用输入直接目标版本' },
  ASSIST_IMPACT_CANDIDATE: { routeId: 'ASSIST_IMPACT_CANDIDATE', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '影响候选：JSON markdown，不自动应用' },
  ASSIST_PROPOSE_CANDIDATE: { routeId: 'ASSIST_PROPOSE_CANDIDATE', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '交付候选提案：JSON summary/proposal，会话须绑定 Task' },
  ASSIST_PROPOSE_TASK: { routeId: 'ASSIST_PROPOSE_TASK', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '任务定义提案：JSON summary/proposal，会话须绑定 Project' },
  ASSISTANT_READONLY: { routeId: 'ASSISTANT_READONLY', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: 'B 档人设助手：冻结人设 + 只读范围与边界' },
  AGENT_MAIN_LOOP: { routeId: 'AGENT_MAIN_LOOP', group: 'CONVERSATION',
    templateVersion: '1.0.5', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '普通 Agent 连续主流程：已声明只读工具，写档位允许时另声明写工具；收尾输出 {reply, execution} 信封' },
  AGENT_PLAN_MODE: { routeId: 'AGENT_PLAN_MODE', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '聊天 /plan 规划模式：只读工具，收尾输出 {reply, plan} 计划信封' },
  AGENT_GOAL_ROUND: { routeId: 'AGENT_GOAL_ROUND', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '聊天 /goal 单轮推进：目标状态 + 工具纪律，收尾输出 {reply, goal} 进展信封' },
  AGENT_SUBAGENT: { routeId: 'AGENT_SUBAGENT', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '有界子 Agent 一次只读执行：冻结委派事实 + 只读边界，收尾输出 {reply, findings, conclusion}' },
  LEARNING_PARTNER: { routeId: 'LEARNING_PARTNER', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '学习搭档：教学规则 + 本轮学习状态与获准来源，{answer, increments} 信封' },
  SKILL: { routeId: 'SKILL', group: 'CONVERSATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '第一方 Skill：Skill 边界 + 该版本 definition.instructions + 输出协议' },
  METHOD: { routeId: 'METHOD', group: 'CONVERSATION',
    templateVersion: '1.0.2', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/conversation-prompts.ts',
    summary: '内置工作方法：INSPECT 只读；明确 MODIFY 按本轮实际工具直写或提交剩余执行候选' },
  INTERPRETATION_EXECUTION: { routeId: 'INTERPRETATION_EXECUTION', group: 'INTERPRETATION',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/interpretation-prompts.ts',
    summary: '原用户执行请求解释：DISCUSS/CLARIFY/PREPARE' },
  INTERPRETATION_STATE_MAINTENANCE: { routeId: 'INTERPRETATION_STATE_MAINTENANCE',
    group: 'INTERPRETATION', templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/interpretation-prompts.ts',
    summary: '项目状态维护解释：DISCUSS/CLARIFY/MAINTAIN 与有限 changes' },
  DRAFT_NO_TOOLS: { routeId: 'DRAFT_NO_TOOLS', group: 'RUN',
    templateVersion: '1.0.0', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/run-prompts.ts',
    summary: 'DRAFT 无工具：候选生成规则 + 输出规格' },
  DRAFT_READ_ONLY_TOOLS: { routeId: 'DRAFT_READ_ONLY_TOOLS', group: 'RUN',
    templateVersion: '1.0.1', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/run-prompts.ts',
    summary: 'DRAFT 只读工具集：声明工具只读，不修改任何文件' },
  DRAFT_WRITE_TOOLS: { routeId: 'DRAFT_WRITE_TOOLS', group: 'RUN',
    templateVersion: '1.0.2', coreVersion: CORE,
    templateSource: 'src/workflow/prompts/run-prompts.ts',
    summary: 'DRAFT 含 apply_changeset：先读后改，支持 CREATE/MODIFY/DELETE；删除仍需任务明确与逐次准入' },
  SEMANTIC_VERDICT: { routeId: 'SEMANTIC_VERDICT', group: 'VERIFICATION',
    templateVersion: '1.0.0', coreVersion: null,
    templateSource: 'src/workflow/prompts/run-prompts.ts',
    summary: '独立语义验收：窄提示词，不加载执行者公共核心' },
  COMPOSER_OUTLINE: { routeId: 'COMPOSER_OUTLINE', group: 'COMPOSER',
    templateVersion: '1.0.0', coreVersion: null,
    templateSource: 'src/workflow/prompts/composer-prompts.ts',
    summary: '输入框草稿分点：只输出原文边界序号 {breaks}，切片由程序完成' },
  COMPOSER_POLISH: { routeId: 'COMPOSER_POLISH', group: 'COMPOSER',
    templateVersion: '1.0.0', coreVersion: null,
    templateSource: 'src/workflow/prompts/composer-prompts.ts',
    summary: '输入框草稿润色：只输出 {text}，保留否定/数字/条件/范围与已有分点' },
  CONNECTION_VERIFY: { routeId: 'CONNECTION_VERIFY', group: 'VERIFICATION',
    templateVersion: '1.0.0', coreVersion: null,
    templateSource: 'src/workflow/prompts/run-prompts.ts',
    summary: '连接验证的固定 user 探针；不是 system 模板，也不是 Agent 工作模式' },
};

export const RUNTIME_ROUTE_IDS = Object.keys(RUNTIME_ROUTES) as readonly RuntimeRouteId[];

/**
 * 统一入口的返回。
 *
 * `SYSTEM` 与 `USER_PROBE` 是两种不同的东西：前者是可发给 Provider 的 system 消息，
 * 后者是连接验证那一条固定 user 探针。类型上分开，调用方不可能把探针当 system 发。
 */
export type RuntimePromptSelection =
  | { readonly kind: 'SYSTEM'; readonly route: RuntimeRouteDescriptor;
      readonly coreIncluded: boolean;
      readonly system: string }
  | { readonly kind: 'USER_PROBE'; readonly route: RuntimeRouteDescriptor;
      readonly probe: string };

/** 路由输入不在封闭集合内：显式失败，不允许回落到任何默认模板。 */
export class UnknownRuntimePromptRouteError extends Error {
  override readonly name = 'UnknownRuntimePromptRouteError';
  constructor(readonly received: string) {
    super(`unknown runtime prompt route: ${received}`);
  }
}

/** DRAFT 能力档位 → 路由标识；穷尽三个合法值，未知值拒绝。 */
export function draftRouteIdFor(capability: RuntimeDraftCapabilityInput): RuntimeRouteId {
  if (!capability.toolsEnabled) return 'DRAFT_NO_TOOLS';
  if (capability.canWrite) return 'DRAFT_WRITE_TOOLS';
  return 'DRAFT_READ_ONLY_TOOLS';
}
