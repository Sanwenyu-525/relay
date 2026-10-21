import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import type { AssistMessageRow, AssistSessionRow, GatewayCapability } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AssistModelPort, AssistResult, ModelToolCall, ModelToolSpec, ModelToolTurn,
  ModelToolTurnResult, ModelUsage, AssistRequest } from '../workflow/fake-model-port.js';
import { gatewayParamsFor, normalizeToolChanges, ToolRequestRejected } from './tool-loop.js';
import { declaredToolSpecs, readInternalTool, type InternalToolName } from
  '../workflow/tool-catalog.js';
import { capabilityFor, dispatchGatewayAction, prepareGatewayAction,
  targetMatches, type GatewayActionType, type GatewayOrigin, type GatewaySessionReadOrigin }
  from './gateway-actions.js';
import { settleDelegationToolCall, type DelegationChildRunner } from './subagent-delegation.js';
import { DELEGATE_SUBAGENT_SPEC, DELEGATE_SUBAGENT_TOOL_NAME } from '../workflow/tool-catalog.js';
import { COMPUTER_DESKTOP_TARGET } from '../computer/protocol.js';
import { BROWSER_UNKNOWN_TARGET, isBrowserAction } from '../browser/protocol.js';
import { browserTargetForTool } from '../browser/browser-adapter.js';
import { isGithubReadAction } from '../github/github-adapter.js';
import { createRepositories } from './unit-of-work.js';
import { selectRuntimeSystemPrompt } from '../workflow/prompts/index.js';
import { ASSIST_STEERING_RULES } from '../workflow/prompts/conversation-prompts.js';
import { ModelCallBudgetError, ModelOutputBudgetError, ModelTimeoutError,
  ModelToolOutputError } from '../workflow/openai-compatible-model-port.js';
import { classifyProviderError, type ModelErrorCategory } from
  '../workflow/model-error-classification.js';
import { ModelScopeBudgetError } from '../model/model-call-repository.js';

/**
 * 会话读取工具轮次（迁移 0060 起 B 档人设助手；0087 起普通 Agent 主流程，ADR-022）。
 *
 * 这一类轮次「可读不可写」：
 *   * 词表只有只读工具，且**每轮按当前连接与权限重新裁剪**——冻结快照是文本，不是能力。
 *     连接被删，下一轮就少一个工具，不靠旧快照续命。
 *   * 写工具、Skill、提案意图与委派都不在这条路径上。模型请求写工具时得到类型化拒绝
 *     并在 `session_tool_calls` 留痕，不静默丢弃、不照做。
 *   * 只读动作仍走 Gateway，因此读取也留账本与审计；但不建 Task/Run/StepAttempt，
 *     也不产生任何审批。
 *   * 停止复用 `assist_messages.cancel_requested`：不新增停止通道。
 *
 * 两种会话身份**共用这一条读路径**，但来源必须可分辨：人设助手是 `ASSISTANT_READ`，
 * 普通 Agent 主流程是 `AGENT_SESSION_READ`。共用的是读路径，不是身份——目录判定、
 * 词表来源与账本归属都由各自的解析器给出，运行架构 §2.6.3 要求它们互不冒充。
 */

/** 会话读取允许出现的工具，按词表顺序固定，保证同一轮可复现。 */
export const ASSISTANT_READ_TOOLS: readonly InternalToolName[] = [
  'list_directory', 'find_paths', 'search_text', 'read_file', 'git_status', 'git_diff', 'git_log',
  // 0092: Computer 只读（截图/窗口枚举）。输入类工具不在此列——会话轮次可读不可写，
  // 桌面输入只经 Run 工具循环，由单动作审批或本次任务范围授权放行。
  'computer_screenshot', 'computer_get_windows',
  // 0103: GitHub 只读。这些工具只有当项目里存在声明 GITHUB_READ 的 ACTIVE 连接时才会
  // 进入本轮词表（assistantToolNames 与实际连接求交集），没装 gh 或未授权时模型看不到它们。
  'github_repo_view', 'github_pr_list', 'github_pr_view', 'github_issue_list', 'github_issue_view',
  // 0105: 浏览器只读（页面列表/快照/截图/等待）。交互与提交类工具不在此列——
  // 会话轮次可读不可写，浏览器动作只经 Run 工具循环。
  'browser_list_pages', 'browser_read_page', 'browser_screenshot', 'browser_wait_for',
];

/**
 * 0126：会话写工具词表。
 *
 * 只有两个，且都在 `FILE_WRITE` 能力下：`apply_changeset` 带 SHA-256 基线，`read_change_set`
 * 只读自己刚写出的那份变更集证据。`WRITE_FILE` 全文覆盖、无基线，不在会话词表内——
 * 会话没有 Run 的 resource_claim，两个会话并发写同一文件时唯一可靠的闸门就是那条基线。
 *
 * 与 `ASSISTANT_READ_TOOLS` 分开维护而不是合成一张表：两者的准入来源不同
 * （`AGENT_SESSION_WRITE` vs `*_READ`），合成会让「这条动作是读还是写」在词表层面就分不清。
 */
export const ASSISTANT_WRITE_TOOLS: readonly InternalToolName[] =
  ['apply_changeset', 'read_change_set'];

/**
 * 本轮实际可用的只读工具 = 冻结只读词表 ∩ 当前连接可用的工具。
 *
 * `available` 必须由调用方按**当前**连接与权限算出；这里不做任何回落，
 * 交集为空就返回空词表——空词表意味着模型只能凭已读内容回答，而不是「全部放行」。
 */
export function assistantToolNames(available: readonly InternalToolName[],
  allowWrite = false): readonly InternalToolName[] {
  const usable = new Set(available);
  // 0126：写词表只在本轮允许写时并入。默认 false，因此所有人设助手、学习搭档与
  // 只读档位的行为一字不变——放行写必须是显式传入的决定，不能靠某个布尔默认值漂移进来。
  const vocabulary = allowWrite
    ? [...ASSISTANT_READ_TOOLS, ...ASSISTANT_WRITE_TOOLS]
    : ASSISTANT_READ_TOOLS;
  return vocabulary.filter((name) => usable.has(name));
}

/**
 * 人设提示词（单一来源的兼容再导出）。
 *
 * 正文已迁到 `workflow/prompts/conversation-prompts.ts` 的 `assistantReadonlySystemPrompt()`，
 * 由统一路由入口组合公共核心与本次只读边界；这里只保留一个名字给既有调用方与测试，
 * 不再维护第二份可分别修改的正文。
 *
 * 三条不可让步的边界由模板本身声明：人设文本是 UNTRUSTED_DATA（配置不是指令）、
 * 本轮只读、回复不是验收结论。
 */
export { assistantReadonlySystemPrompt as assistantSystemPrompt }
  from '../workflow/prompts/conversation-prompts.js';

export interface AssistantReadonlyRoundInput {
  readonly contextTurns?: AssistRequest['turns'];
  readonly session: AssistSessionRow;
  readonly message: AssistMessageRow;
  /** 当前连接可用的工具名；每轮重新计算，不从快照读。 */
  readonly availableTools: readonly InternalToolName[];
  readonly modelPort: AssistModelPort;
  /** 可选的消息级冻结模型调用入口；普通会话仍沿既有端口路径。 */
  readonly invokeAssist?: (request: AssistRequest) => Promise<AssistResult>;
  readonly signal: AbortSignal;
  readonly maxRounds?: number | undefined;
  readonly maxToolCalls?: number | undefined;
  /**
   * 0126：本轮是否允许写文件。缺省 false——人设助手、学习搭档与只读档位行为不变。
   * 由调用方按目录写档位决定；这里只影响词表，能不能真正落盘仍由 Gateway 准入判定。
   */
  readonly allowWrite?: boolean | undefined;
  /**
   * 0122：消费用户插话。每次模型请求前调用；返回的原文按顺序接进本轮上下文，
   * 对应的排队消息已由实现方收口（不再自己生成回复）。
   * 缺省表示这条会话身份不支持插话——人设档与学习档本来就不排队。
   */
  readonly drainSteers?: (() => Promise<readonly { messageId: string; content: string }[]>) | undefined;
  /**
   * 0128：读「本会话关联的正式执行是否仍在途」的事实说明；语义同
   * `SessionReadonlyRoundInput.readExecutionNotice`。
   */
  readonly readExecutionNotice?: (() => Promise<string | null>) | undefined;
  /**
   * 0128：子 Agent 只读轮次的执行注入点，语义同 `SessionReadonlyRoundInput.runDelegation`。
   *
   * 只有生成层（`runAgentMainLoopGeneration`）能给：它持有 Worker 身份、模型端口与心跳。
   * 缺省即「这条身份不支持委派」——词表里不会出现 `delegate_subagent`。
   */
  readonly runDelegation?: DelegationChildRunner | undefined;
  /**
   * 0128：执行本次生成的 Worker 身份，委派尝试行按它记录领取者。
   *
   * 与 `runDelegation` 成对出现：只有注入点没有 Worker 身份时，尝试行无法记录领取者，
   * 因此这一轮同样不声明委派工具（宁可让模型看不见，不给它一条注定被拒的词表项）。
   */
  readonly workerId?: string | undefined;
}

/**
 * 会话读取的 Gateway 来源：两种身份形状相同，但来源 key 必须可分辨。
 *
 * 抽出这个子集是为了让「本轮只能读」这件事在类型上成立：这里不可能构造出
 * `USER_IMPORT`/`USER_ACTION`/`RUN` 那三种会写入或占用资源的来源。
 */
export type SessionReadOrigin = GatewaySessionReadOrigin;

/**
 * 每次工具请求前重新解析本次读取身份。
 *
 * 解析失败**不是**整轮失败：它以类型化原因拒掉那一次请求并留在 `session_tool_calls` 上，
 * 模型因此能照实说明缺什么，而不是被整轮中止或被静默放行。调用方按自己的会话身份给规则：
 *   * 人设助手（0060 原行为）：项目下**唯一**的 ACTIVE 受管资源；多个则不猜。
 *   * 普通 Agent 主流程（0087）：会话行上持久绑定的那个受管资源；没绑就明确说没绑。
 *
 * 「每次调用前重查」是刻意的：换绑、停用、撤权必须在**下一次**工具请求就生效，
 * 而不是在建轮次时被快照住。
 */
export type SessionReadOriginResolution =
  | { readonly ok: true; readonly origin: SessionReadOrigin;
      readonly canonicalRoot: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface SessionReadonlyRoundInput {
  readonly contextTurns?: AssistRequest['turns'];
  readonly session: AssistSessionRow;
  readonly message: AssistMessageRow;
  /** 当前连接可用的工具名；每轮重新计算，不从快照读。 */
  readonly availableTools: readonly InternalToolName[];
  readonly modelPort: AssistModelPort;
  /** 消息冻结模型调用入口；缺省时保留既有模型端口调用。 */
  readonly invokeAssist?: (request: AssistRequest) => Promise<AssistResult>;
  readonly signal: AbortSignal;
  /** 本次的 system 模板文本；由调用方按自己的会话身份经统一路由入口选出。 */
  readonly system: string;
  /**
   * 0126：本轮是否允许写文件。缺省 false——人设助手、学习搭档与只读档位的行为不变。
   * 只影响「词表里有没有写工具」；这一次请求能不能真正落盘仍由 Gateway 准入判定。
   */
  readonly allowWrite?: boolean | undefined;
  readonly resolveOrigin: () => Promise<SessionReadOriginResolution>;
  readonly maxRounds?: number | undefined;
  readonly maxToolCalls?: number | undefined;
  /** 0122：插话消费；见 `AssistantReadonlyRoundInput.drainSteers`。 */
  readonly drainSteers?: (() => Promise<readonly { messageId: string; content: string }[]>) | undefined;
  /**
   * 0128：读「本会话关联的正式执行是否仍在途」的事实说明。
   *
   * 只在**发生插话**后查询一次：插话是唯一会让模型产生「正式执行已经改向」误解的入口。
   * 返回 null 表示没有在途运行（或读不到），此时不注入任何说明。
   *
   * 这块说明只用于阻止错误的承诺，它不授予权限、也不让任何执行停下。
   */
  readonly readExecutionNotice?: (() => Promise<string | null>) | undefined;
  /**
   * 0128：本轮是否声明委派工具（有界多 Agent）。
   *
   * 只对**根会话**的普通 Agent 主流程为真：子会话仅一层，拿不到这个词表项。
   * 与 `allowWrite` 同一性质——影响词表，不改变任何准入；委派本身不授予权限。
   */
  readonly allowDelegate?: boolean | undefined;
  /**
   * 0128：执行一次子 Agent 只读轮次的注入点。
   *
   * 由生成层（`runAgentMainLoopGeneration`）提供：它持有 Worker 身份、模型端口与
   * 心跳，子轮次因此复用同一条领取/结算机制，不新建第二个执行框架。
   * 缺省表示这条会话身份不支持委派（人设档、学习档本来就没有这个词表项）。
   */
  readonly runDelegation?: DelegationChildRunner | undefined;
  /**
   * 0128：执行本次生成的 Worker 身份。委派尝试行按它记录领取者；
   * 不缺省成空串——没有 Worker 身份的轮次不应建立委派。
   */
  readonly workerId?: string | undefined;
}

/**
 * 本轮能否声明 `delegate_subagent`（0128 词表闸门）。
 *
 * 三个条件缺一不可，且都在**这一轮**成立：
 *   * 发起者是根会话——子会话仅一层（ADR-017、总纲 §0.9）；
 *   * 有子执行注入点——没有它，词表项只会让模型反复调用、反复被拒；
 *   * 有非空 Worker 身份——委派尝试行要记录领取者，否则恢复核对无从判断这条尝试属于谁。
 *
 * 只管「看得见」，不授予任何能力：真正建立委派时 `createDelegation` 还要按当前会话
 * 状态、项目与工作目录再判一次（委派不是授权）。
 */
export function delegateToolDeclared(input: {
  readonly parentSessionId: string | null;
  readonly runDelegation: DelegationChildRunner | undefined;
  readonly workerId: string | undefined;
}): boolean {
  return input.parentSessionId === null && input.runDelegation !== undefined &&
    input.workerId !== undefined && input.workerId !== '';
}

/**
 * 有副作用的能力：这些动作一旦执行就改变了外部状态。
 *
 * 只读能力不在此列：读同一个文件两次没有副作用，而**新方向下重读同一文件是正常动作**
 * （用户说「换个方向」之后重看同一个文件完全正常）。把只读动作也拦掉，会把新判断
 * 误判成机械重试。
 */
const EFFECTFUL_CAPABILITIES: readonly GatewayCapability[] = [
  'FAKE_WRITE', 'FILE_WRITE', 'GIT_WRITE', 'CLI_RUN', 'COMPUTER_INPUT',
  'BROWSER_ACTION', 'BROWSER_COMMIT',
];

/**
 * 动作签名：同一个「要做什么」的稳定标识。
 *
 * 写动作的 `baselineSha256` **不进**签名：它是「读到的当前内容」，模型重新读一次就会变，
 * 而要做的事（改哪个文件、改成什么）没有变。把它算进签名，真正的机械重试反而拦不住。
 */
export function actionSignature(call: ModelToolCall): string {
  return `${call.name}:${stableSignature(call.arguments)}`;
}

/** 稳定序列化：键按字典序排列，数组保序。 */
function stableSignature(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableSignature(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'baselineSha256')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${stableSignature(item)}`).join(',')}}`;
}

/**
 * 这个工具调用有没有副作用。
 *
 * 词表外的工具名返回 false：它们不会走到派发，签不签名都没有意义。
 */
export function isEffectfulToolCall(call: ModelToolCall): boolean {
  const definition = readInternalTool(call.name);
  if (definition === undefined) return false;
  return EFFECTFUL_CAPABILITIES.includes(capabilityFor(definition.actionType));
}

/**
 * 被新输入撤回的动作签名 → 撤回那一刻已消费的插话条数。
 *
 * 用途（0128 补齐）：插话打断后，模型可能**原样重发**刚被撤回的那批动作——那不是
 * 「按最新要求重新决定」，而是没听见用户新说的那句话。提示词已经要求它不要这么做，
 * 但提示词不是代码保证：写动作一旦执行就是真实副作用。
 *
 * 判据是「自那次撤回以来，用户有没有又说过话」：
 *   * 没有新插话 → 重复的就是刚被撤回的旧动作，属于机械重试，拦下；
 *   * 有新插话 → 同样的动作可能是用户的新指令（用户说「算了，还是绿色吧」），
 *     应当放行给正常准入与基线比对去判断。
 *
 * 登记时记的是**撤回那一刻已消费的插话条数**。注意撤回总是伴随一条新插话到达
 * （打断正因它而起），所以「撤回后的第一次重发」在两种场景下都要看**撤回之后**
 * 有没有新插话，不能只看撤回本身。
 *
 * 作用域是**本轮生成**：进程重启后本轮从头开始，模型也没有旧工具结果可依据。
 */
export type WithdrawnActionGuard = Map<string, number>;

/**
 * 这个动作是否应当被撤回守卫拦下。
 *
 * 抽成纯函数是为了让「机械重试被拦、用户新指令放行」这两条都能被单测直接锁住，
 * 而不是只能靠集成用例的时序去撞。
 */
export function isWithdrawnActionBlocked(guard: WithdrawnActionGuard, signature: string,
  currentSteerEpoch: number): boolean {
  const withdrawnAt = guard.get(signature);
  return withdrawnAt !== undefined && withdrawnAt === currentSteerEpoch;
}

export type AssistantReadonlyOutcome =
  | { readonly kind: 'CONTENT'; readonly content: string; readonly usage: ModelUsage;
      readonly providerRequestIds: readonly string[]; readonly rounds: number }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId: string | null;
      readonly usage: ModelUsage; readonly providerRequestIds: readonly string[] }
  | { readonly kind: 'FAILED'; readonly errorCode: string;
      /**
       * Provider 传输层类别（`MODEL_FAILED` 的可归因半边）。
       *
       * 会话轮次把模型异常折叠成类型化 `errorCode` 之后，排查只剩「失败」一个词：
       * 到底是 Provider 抖动（限流、断流、5xx）还是本模块的代码缺陷，库里分不出来，
       * 真实 Provider 的插话场景就卡在这里无法归因。类别沿用连接验证与运行账本同一套
       * 词表（`model-error-classification`），无法归因时保持 null——不套一个类别冒充结论。
       */
      readonly providerErrorKind?: ModelErrorCategory | null;
      readonly usage: ModelUsage;
      readonly providerRequestIds: readonly string[] };

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS = 8;
const RESULT_TEXT_LIMIT = 16_000;

/**
 * 预算用尽前的收尾指令。
 *
 * 只在两种情况下追加：轮次预算已到最后一次，或工具调用预算已经用完。此时本轮**不再
 * 声明任何工具**——不是靠一句「请收尾」劝，而是让模型真的没有工具可调。真实 Provider
 * 在只读轮次里会反复 find/list/read（同一文件连读两次），仅提示它收尾时仍会再请求一次
 * 工具，然后整个消息以 `SESSION_TOOL_ROUNDS_EXHAUSTED` 失败，用户看到的是一次报错而不是答复。
 */
const TOOL_BUDGET_WRAP_UP = '工具轮次或调用预算已用尽。请立即用已经拿到的结果给出最终答复，'
  + '不要再请求任何工具。';

/** 是否已到必须收尾的轮次：最后一次轮次，或工具调用预算已经用尽。 */
export function shouldWrapUpReadonlyRound(input: {
  readonly round: number; readonly maxRounds: number;
  readonly usedCalls: number; readonly maxToolCalls: number;
}): boolean {
  return input.round >= input.maxRounds || input.usedCalls >= input.maxToolCalls;
}

/** 模型异常的类型化归类：只回答「哪一类」，不复制 provider 正文或凭据。 */
function sessionModelErrorCode(error: unknown): string {
  if (error instanceof ModelTimeoutError) return 'MODEL_TIMEOUT';
  if (error instanceof ModelToolOutputError) return 'MODEL_TOOL_OUTPUT_INVALID';
  if (error instanceof ModelScopeBudgetError || error instanceof ModelCallBudgetError ||
      error instanceof ModelOutputBudgetError) return 'MODEL_BUDGET_EXHAUSTED';
  return 'MODEL_FAILED';
}

const EMPTY_USAGE: ModelUsage = { inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheCreationTokens: null };

function addUsage(a: ModelUsage, b: ModelUsage | undefined): ModelUsage {
  if (b === undefined) return a;
  const sum = (left: number | null | undefined, right: number | null | undefined): number | null => {
    const l = left ?? null;
    const r = right ?? null;
    return l === null && r === null ? null : (l ?? 0) + (r ?? 0);
  };
  return { inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: sum(a.cacheCreationTokens, b.cacheCreationTokens) };
}

/** 只读范围从冻结快照里读路径，能力从当前连接读——两者不混。 */
export function assistantReadScopeRoots(session: AssistSessionRow): readonly string[] {
  const scope = session.assistant_role_snapshot?.read_scope;
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return [];
  const roots = (scope as JsonObject).roots;
  if (!Array.isArray(roots)) return [];
  return roots.filter((root): root is string => typeof root === 'string' && root !== '');
}

/**
 * 跑完一次会话读取回答（两种会话身份共用的循环）。
 *
 * 循环形态：模型给工具请求 → 逐个校验并派发 → 结果回传 → 直到模型给出正文。
 * 三个终止条件都是显式的：轮次预算、工具调用预算、用户停止。
 * 任何一次工具失败都不吞掉：类型化原因回传模型，同时留在 session_tool_calls 上。
 *
 * 这里**不做身份判定**：system 模板与来源身份都由调用方给出，因此新增一种会话身份
 * 不需要改这条循环，人设档的判定也不会渗进普通会话。
 */
export async function runSessionReadonlyRounds(db: DbExecutor,
  input: SessionReadonlyRoundInput): Promise<AssistantReadonlyOutcome> {
  const { session, message } = input;
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const repository = new SessionToolCallRepository(db);
  // 0126：声明规格这一处同样按 allowWrite 取词表。这里漏传会让调用方算出的写工具
  // 在声明时被二次滤掉——现象是「工具解析层有、模型收到的清单里没有」，
  // 从模型侧看起来像「系统没有写能力」，最难定位的一类静默失败。
  //
  // 0128：委派工具是应用内动作（没有 Gateway 动作），不在 `INTERNAL_TOOL_DEFINITIONS`
  // 里，因此按 allowDelegate 显式追加——根会话才拿得到，子会话仅一层。
  const declared: ModelToolSpec[] = [
    ...declaredToolSpecs(assistantToolNames(input.availableTools, input.allowWrite ?? false)),
    ...(input.allowDelegate === true ? [DELEGATE_SUBAGENT_SPEC] : []),
  ];
  const toolTurns: ModelToolTurn[] = [];
  const providerRequestIds: string[] = [];
  let usage: ModelUsage = EMPTY_USAGE;
  let usedCalls = 0;
  const turns = input.contextTurns ?? await historyTurns(db, message);
  /**
   * 0122：本轮生成期间用户插话的原文。
   *
   * 上游对照（`core/agent-loop/src/agent.ts:359-364`）：一步结束时若 `next-step`
   * inbox 非空，**这一轮不结束**，再跑一步。这里照同一语义实现，但只在还有轮次预算
   * 时消费——预算已用完还去消费，等于把那条排队消息取消掉却永远不回答它。
   */
  const steers: string[] = [];
  let hasSteers = false;
  /**
   * 0128：在途正式执行的事实说明；undefined = 还没查过，null = 查过但没有在途运行。
   */
  let executionNotice: string | null | undefined = undefined;
  /**
   * 已消费的插话条数（只增不减）。
   *
   * 它是撤回守卫的「纪元」：某个动作被撤回时记下当时的纪元，之后只有纪元变化
   * （说明用户又说了新的话）才认为那可能是新指令而不是机械重试。
   */
  let steerEpoch = 0;
  const withdrawnActions: WithdrawnActionGuard = new Map();
  const drainSteers = async (): Promise<boolean> => {
    if (input.drainSteers === undefined) return false;
    const drained = await input.drainSteers();
    let appended = false;
    for (const item of drained) {
      if (item.content.trim() === '') continue;
      steers.push(item.content);
      hasSteers = true;
      steerEpoch += 1;
      appended = true;
    }
    return appended;
  };

  for (let round = 0; round <= maxRounds; round += 1) {
    if (input.signal.aborted || await isCancelRequested(db, message.id)) {
      return { kind: 'CANCELLED', providerRequestId: providerRequestIds.at(-1) ?? null,
        usage, providerRequestIds };
    }
    let response: AssistResult;
    try {
      // 最后一轮或工具调用预算用完时强制收尾：本轮不声明工具，模型只能输出正文。
      const wrapUp = shouldWrapUpReadonlyRound({ round, maxRounds, usedCalls, maxToolCalls });
      // 收尾轮不再消费插话：这一轮之后没有下一次模型请求，接了也答不上。
      if (!wrapUp) await drainSteers();
      // 0128：插话是唯一会让模型误解「正式执行已经改向」的入口，因此只在发生插话后
      // 查一次在途事实。读不到就当没有，不让这块说明成为一次回答失败的原因。
      if (hasSteers && executionNotice === undefined && input.readExecutionNotice !== undefined) {
        executionNotice = await input.readExecutionNotice();
      }
      const request: AssistRequest = { intent: 'DISCUSS',
        system: executionNotice === undefined || executionNotice === null
          ? (hasSteers ? `${input.system}\n\n${ASSIST_STEERING_RULES}` : input.system)
          : `${hasSteers ? `${input.system}\n\n${ASSIST_STEERING_RULES}` : input.system}\n\n${executionNotice}`,
        turns: wrapUp ? [...turns, { role: 'user', content: TOOL_BUDGET_WRAP_UP }] : turns,
        ...(wrapUp ? { tools: [] } : { tools: declared }),
        toolTurns, ...(steers.length === 0 ? {} : { steers: [...steers] }), signal: input.signal };
      response = input.invokeAssist === undefined
        ? await input.modelPort.assist(request) : await input.invokeAssist(request);
    } catch (error) {
      // 只读轮次过去把所有模型异常折叠成 MODEL_FAILED：用户只看到「失败」，排查时分不清
      // 是超时、输出不合法还是预算用尽——真实 Provider 的第一次端到端跑通正是卡在这里
      // 无法定位。类型化原因仍不携带正文或凭据，只保留可判定的类别。
      // 归不进上面任何一类的失败再补一条传输层类别：Provider 抖动（限流、断流、5xx）与
      // 本模块的代码缺陷必须在库里可分辨，否则「MODEL_FAILED」这个词承担两种完全不同的结论。
      return { kind: 'FAILED', errorCode: sessionModelErrorCode(error),
        providerErrorKind: classifyProviderError(error) ?? null,
        usage, providerRequestIds };
    }
    if (response.kind === 'CANCELLED') {
      return { kind: 'CANCELLED', providerRequestId: response.providerRequestId ?? null,
        usage, providerRequestIds };
    }
    providerRequestIds.push(response.providerRequestId);
    usage = addUsage(usage, response.usage);

    if (response.kind === 'CONTENT') {
      // 0122：模型已经给出正文，但这一步之后还有插话到达 → 这一轮不结束，再跑一步。
      // 只在还能再跑一轮时消费（wrapUp 轮之后没有下一次请求）。
      const wrapUp = shouldWrapUpReadonlyRound({ round, maxRounds, usedCalls, maxToolCalls });
      if (!wrapUp && await drainSteers()) continue;
      return { kind: 'CONTENT', content: response.content, usage, providerRequestIds,
        rounds: round };
    }

    const results: ModelToolTurnResult[] = [];
    const steersBefore = steers.splice(0);
    let interrupted = false;
    for (const [ordinal, call] of response.calls.entries()) {
      if (input.signal.aborted || await isCancelRequested(db, message.id)) {
        return { kind: 'CANCELLED', providerRequestId: response.providerRequestId,
          usage, providerRequestIds };
      }
      // 新输入可能撤回整批动作；先回模型重新判断，不按关键词猜哪些工具还能继续。
      // round < maxRounds 保证消费后至少还会有一次请求（可以是无工具的收尾请求）。
      if (!interrupted && round < maxRounds) interrupted = await drainSteers();
      // 撤回守卫：模型原样重发刚被撤回的**有副作用**动作时，在派发前拦下。
      // 只在「自撤回以来没有新插话」时拦——有新的用户输入时，同样的动作可能是新指令。
      const effectful = isEffectfulToolCall(call);
      const signature = effectful ? actionSignature(call) : null;
      if (signature !== null &&
          isWithdrawnActionBlocked(withdrawnActions, signature, steerEpoch)) {
        results.push({ providerToolCallId: call.providerToolCallId, name: call.name,
          isError: true, content: JSON.stringify({ status: 'NOT_EXECUTED',
            reason: 'ACTION_WITHDRAWN',
            detail: '该动作已被用户的新输入撤回，且此后没有新的用户输入；不要机械重试，'
              + '请依据最新要求重新决定。' }) });
        continue;
      }
      if (interrupted) {
        if (effectful && signature !== null) withdrawnActions.set(signature, steerEpoch);
        results.push({ providerToolCallId: call.providerToolCallId, name: call.name,
          isError: true, content: JSON.stringify({ status: 'NOT_EXECUTED',
            reason: 'NEW_USER_INPUT', detail: '用户有新输入；此工具未执行，请依据最新要求重新决定。' }) });
        continue;
      }
      const settled = await settleSessionReadonlyToolCall(db, { session, message,
        availableTools: input.availableTools, repository, round, ordinal, call,
        usedCalls, maxToolCalls, maxRounds, resolveOrigin: input.resolveOrigin,
        allowWrite: input.allowWrite ?? false,
        allowDelegate: input.allowDelegate === true,
        runDelegation: input.runDelegation,
        workerId: input.workerId,
        // 0128：委派子轮次沿用本次生成的取消信号；不传下去的话父轮停止后子执行会继续跑。
        signal: input.signal });
      usedCalls += 1;
      results.push(settled);
      if (input.signal.aborted || await isCancelRequested(db, message.id)) {
        return { kind: 'CANCELLED', providerRequestId: response.providerRequestId,
          usage, providerRequestIds };
      }
    }
    toolTurns.push({ calls: response.calls, results, steersBefore, preamble: response.preamble,
      reasoningContent: response.reasoningContent });
  }
  return { kind: 'FAILED', errorCode: 'SESSION_TOOL_ROUNDS_EXHAUSTED', usage, providerRequestIds };
}

/**
 * 跑完一次 B 档人设助手回答（迁移 0060、ADR-018 的既有入口）。
 *
 * 身份门槛仍在：**必须有**冻结的人设快照，否则这轮根本不成立——一个人设会话缺了快照
 * 就不是人设会话，不能退化成一个普通只读会话。
 */
export async function runAssistantReadonlyRounds(db: DbExecutor,
  input: AssistantReadonlyRoundInput): Promise<AssistantReadonlyOutcome> {
  const { session, message } = input;
  if (session.conversation_mode !== 'ASSISTANT' || session.assistant_role_snapshot === null) {
    return { kind: 'FAILED', errorCode: 'ASSISTANT_SESSION_IDENTITY_MISSING',
      usage: EMPTY_USAGE, providerRequestIds: [] };
  }
  const { system } = selectRuntimeSystemPrompt({ kind: 'ASSISTANT_READONLY',
    snapshot: session.assistant_role_snapshot,
    readScopeRoots: assistantReadScopeRoots(session) });
  return runSessionReadonlyRounds(db, { session, message, availableTools: input.availableTools,
    modelPort: input.modelPort, signal: input.signal, system,
    ...(input.contextTurns === undefined ? {} : { contextTurns: input.contextTurns }),
    ...(input.invokeAssist === undefined ? {} : { invokeAssist: input.invokeAssist }),
    resolveOrigin: () => assistantReadOrigin(db, session, message.id),
    ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
    ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }) });
}

/**
 * 跑完一次**普通 Agent 主流程**的读取轮次（0087、ADR-022）。
 *
 * 与人设档的差别只有两处，且都不是「能力」差别：
 *   * system 模板：默认走 `AGENT_MAIN_LOOP`（声明本轮有真实读取工具、要求用真实回执
 *     回答，而不是像旧 DISCUSS 模板那样否认系统的读取能力）；**已冻结工作方法的轮次
 *     保留方法自己的模板**——方法模板本来就要求「只依据实际读取到的内容下结论」，缺的
 *     恰恰是工具，而不是边界说明；
 *   * 来源是 `AGENT_SESSION_READ`，目录取自会话行上**持久绑定**的受管资源。
 */
export async function runAgentSessionReadonlyRounds(db: DbExecutor,
  input: AssistantReadonlyRoundInput & { readonly system?: string | undefined }):
  Promise<AssistantReadonlyOutcome> {
  const { session, message } = input;
  if (session.conversation_mode !== 'AGENT') {
    return { kind: 'FAILED', errorCode: 'AGENT_SESSION_IDENTITY_MISSING',
      usage: EMPTY_USAGE, providerRequestIds: [] };
  }
  const system = input.system ??
    selectRuntimeSystemPrompt({ kind: 'AGENT_MAIN_LOOP' }).system;
  return runSessionReadonlyRounds(db, { session, message, availableTools: input.availableTools,
    modelPort: input.modelPort, signal: input.signal, system,
    ...(input.invokeAssist === undefined ? {} : { invokeAssist: input.invokeAssist }),
    ...(input.contextTurns === undefined ? {} : { contextTurns: input.contextTurns }),
    resolveOrigin: () => agentSessionReadOrigin(db, session, message.id),
    ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
    ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
    // 0126：写只在这一条身份（普通 Agent 主流程）上开放，且由调用方按档位决定。
    ...(input.allowWrite === undefined ? {} : { allowWrite: input.allowWrite }),
    ...(input.drainSteers === undefined ? {} : { drainSteers: input.drainSteers }),
    ...(input.readExecutionNotice === undefined ? {}
      : { readExecutionNotice: input.readExecutionNotice }),
    // 0128：委派只对根会话开放（仅一层），且必须有执行注入点与非空 Worker 身份。
    // 判定抽到 delegateToolDeclared，与结算侧的同一套条件对齐——词表里出现了工具却
    // 每次都被拒，是最难从现象定位的一类接线缺口。
    allowDelegate: delegateToolDeclared({ parentSessionId: session.parent_session_id,
      runDelegation: input.runDelegation, workerId: input.workerId }),
    ...(input.runDelegation === undefined ? {} : { runDelegation: input.runDelegation }),
    ...(input.workerId === undefined ? {} : { workerId: input.workerId }) });
}

interface AssistantToolCallSettlement {
  readonly providerToolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
}

/**
 * 一次只读工具请求的上下文。
 *
 * 只依赖「会话 + 消息 + 当前可用词表 + 本次来源解析」，因此人设档、学习档与普通 Agent
 * 主流程共用同一条只读执行路径（同一张 `session_tool_calls` 账本、同一套准入与派发）；
 * 差别只在来源身份与目录判定，两件事都由 `resolveOrigin` 给出。
 */
export interface SessionReadonlyToolCallContext {
  readonly session: AssistSessionRow;
  readonly message: AssistMessageRow;
  /** 当前连接可用的工具名；每轮重新计算，不从快照读。 */
  readonly availableTools: readonly InternalToolName[];
  readonly repository: SessionToolCallRepository;
  readonly round: number;
  readonly ordinal: number;
  readonly call: { readonly providerToolCallId: string; readonly name: string;
    readonly arguments: JsonObject };
  readonly usedCalls: number;
  readonly maxToolCalls: number;
  readonly maxRounds: number;
  /** 按调用方的会话身份解析本次读取来源；解析失败即类型化拒掉这一次请求。 */
  readonly resolveOrigin: () => Promise<SessionReadOriginResolution>;
  /**
   * 0126：本轮是否允许写文件。
   *
   * 由调用方按目录写档位决定（READ_ONLY 为 false），并在执行时**再判一次**——词表里有没有
   * 写工具与这一次请求能不能写是两个问题，前者来自档位、后者来自 Gateway 准入。
   */
  readonly allowWrite: boolean;
  /**
   * 0128：本轮是否声明委派工具。仅根会话为真；子会话的上下文里它恒为 false，
   * 因此「子会话请求委派」在这条共享执行路径上不可能被放行。
   */
  readonly allowDelegate: boolean;
  /** 0128：子轮次执行注入点；缺省表示本会话身份不支持委派。 */
  readonly runDelegation?: DelegationChildRunner | undefined;
  /** 0128：本次生成的 Worker 身份（委派尝试行的领取者）。 */
  readonly workerId?: string | undefined;
  /** 本次生成的取消信号：委派子轮次与取消传播都沿它。 */
  readonly signal: AbortSignal;
}

/**
 * 一次工具请求的完整落定：登记 → 校验 → 准入 → 派发 → 结算。
 *
 * 被拒的请求不连 Operation，但仍占一次调用额度——否则同一轮里的多个请求会一起越过上限，
 * 这与 Run 侧工具循环的口径一致。
 *
 * 三种会话身份共用：差别只在系统提示词、来源身份与目录判定，读路径本身必须完全一致。
 */
export async function settleSessionReadonlyToolCall(db: DbExecutor,
  context: SessionReadonlyToolCallContext): Promise<AssistantToolCallSettlement> {
  const { repository, round, ordinal, call } = context;
  const session = context.session;
  const argumentsSha = createHash('sha256')
    .update(canonicalizeJson(call.arguments), 'utf8').digest('hex');
  const row = await repository.insert({ id: randomUUID(), sessionId: session.id,
    messageId: context.message.id, round, ordinal, toolName: call.name,
    arguments: call.arguments, argumentsSha256: argumentsSha,
    providerToolCallId: call.providerToolCallId });

  const refuse = async (reason: string, detail: string): Promise<AssistantToolCallSettlement> => {
    await repository.reject(row.id, reason, detail);
    return { providerToolCallId: call.providerToolCallId, name: call.name,
      content: `【${reason}】${detail}`, isError: true };
  };

  if (context.usedCalls >= context.maxToolCalls) {
    return refuse('SESSION_TOOL_BUDGET_EXHAUSTED', '本次只读工具调用预算已用尽；请用已有结果回答。');
  }
  if (round >= context.maxRounds) {
    return refuse('SESSION_TOOL_ROUNDS_EXHAUSTED', '本次只读轮次预算已用尽；请用已有结果回答，不要继续请求工具。');
  }
  // 0128：委派是应用内动作，没有 Gateway 动作与连接能力，因此在词表校验之前特判。
  // 两道独立闸门：词表里有没有它（allowDelegate，仅根会话）与这次声明合不合法
  // （角色/范围/基线，由服务端校验后冻结进委派行）。
  if (call.name === DELEGATE_SUBAGENT_TOOL_NAME) {
    if (!context.allowDelegate || context.runDelegation === undefined ||
        context.workerId === undefined || context.workerId === '') {
      return refuse('SUBAGENT_DELEGATE_UNAVAILABLE',
        '这条会话当前不能委派子 Agent：只有普通 Agent 的根会话可以，且本轮必须由服务端执行。');
    }
    return settleDelegationToolCall(db, {
      parentSession: session, parentMessage: context.message, row,
      call: { providerToolCallId: call.providerToolCallId, name: call.name,
        arguments: call.arguments },
      workerId: context.workerId, signal: context.signal,
      runChild: context.runDelegation });
  }
  const definition = readInternalTool(call.name);
  if (definition === undefined ||
      !assistantToolNames(context.availableTools, context.allowWrite).includes(definition.name)) {
    // 写工具在这一步被拒：它不进入词表，模型收到的是类型化原因而不是静默。
    // 0126：档位为 READ_ONLY 时写工具仍不进来，但原因必须指回档位——否则模型会
    // 把它读成「系统没有写能力」，而不是「这个目录现在不允许写」。
    const wantsWrite = ASSISTANT_WRITE_TOOLS.some((name) => name === call.name);
    return refuse('TOOL_NOT_READ_ONLY', wantsWrite && !context.allowWrite
      ? `工具 ${call.name} 需要目录写权限；当前目录档位是只读，请先在目录设置里放宽档位。`
      : `工具 ${call.name} 不在本次词表内；这一轮不提供该工具。`);
  }

  const repositories = createRepositories(db);
  // 目录与来源身份在**这次请求**上解析：换绑、停用与撤权必须在下一次工具请求就生效。
  const resolved = await context.resolveOrigin();
  if (!resolved.ok) return refuse(resolved.reason, resolved.detail);
  const { canonicalRoot } = resolved;
  const capability = capabilityOf(definition.actionType);
  // 0126：写工具换用写来源。不换就等于把写动作记在读身份名下——库层 CHECK 会拒，
  // 更严重的是账本从此分不清谁读了、谁写了。
  const origin: GatewayOrigin = capability === 'FILE_WRITE'
    ? { kind: 'AGENT_SESSION_WRITE', projectId: resolved.origin.projectId,
        resourceId: resolved.origin.resourceId, sessionId: resolved.origin.sessionId,
        messageId: resolved.origin.messageId }
    : resolved.origin;
  // 连接按**当前**配置选，不从冻结快照读：连接被删或停用后下一轮就少一个能力。
  const connectionId = await findActiveConnection(repositories, session.workspace_id,
    origin.projectId, capability, canonicalRoot);
  if (connectionId === undefined) {
    return refuse('SESSION_CAPABILITY_NOT_CONFIGURED',
      `当前项目没有可用的 ${capability} 连接，本次不提供该${capability === 'FILE_WRITE' ? '写入' : '读取'}能力。`);
  }

  const intentKey = capability === 'FILE_WRITE' ? `session-write:${row.id}` : `session-read:${row.id}`;
  // 0126：变更集在进 Gateway 之前先过与 Run 侧**同一份**校验（1–8 项、baseline 必须是
  // 真正的 64 位摘要、单文件不超过 64 KiB）。Gateway prepare 自己还会再校验一次；
  // 这里做是为了让模型在派发前就拿到类型化原因，而不是留下一条注定被拒的动作。
  // 复用 Run 的函数而不是另写一份：两份规则一旦漂移，两条入口就会对同一个声明给出不同结论。
  let params: JsonObject;
  if (definition.actionType === 'APPLY_CHANGESET') {
    try {
      params = normalizeToolChanges(call.arguments.changes);
    } catch (error) {
      return refuse(error instanceof ToolRequestRejected ? error.reason : 'TOOL_CHANGESET_INVALID',
        error instanceof Error ? error.message : '变更声明不合法。');
    }
  } else {
    params = gatewayParamsFor(definition, call.arguments);
  }
  if (definition.actionType === 'APPLY_CHANGESET' && Array.isArray(params.changes) &&
      params.changes.some((change) => typeof change === 'object' && change !== null &&
        !Array.isArray(change) && change.action === 'DELETE')) {
    const access = await repositories.gateway.readLocalDirectoryAccess(origin.resourceId);
    if (access?.write_tier !== 'FULL') {
      return refuse('SESSION_WRITE_REQUIRES_RUN',
        '这次删除需要可恢复的审批执行：请把尚未执行的变更作为 execution 候选交给原 Run 入口；未创建写动作。');
    }
  }
  let prepared;
  try {
    prepared = await prepareGatewayAction(db, { workspaceId: session.workspace_id,
      operationId: row.id, intentKey, connectionId, origin,
      actionType: definition.actionType,
      target: toolTarget(canonicalRoot, definition.actionType, call.arguments, origin),
      // 参数按工具词表裁剪（复用 Run 侧同一份映射）：模型多带的字段不会变成动作参数，
      // 而 read_file 这类「路径在 target 里」的动作不会带着 relative_path 去 prepare。
      params });
  } catch (error) {
    const detail = error instanceof Error ? error.message
      : `本次${capability === 'FILE_WRITE' ? '写入' : '读取'}被准入拒绝。`;
    return refuse('GATEWAY_ACTION_DENIED', detail);
  }
  if (prepared.status !== 'PREPARED' && prepared.status !== 'SUCCEEDED') {
    if (prepared.status === 'WAITING_APPROVAL') {
      // 0126：写动作在 ASK 档会等人工批准。会话里没有异步推进审批的通道，因此如实拒绝
      // 并指向审批入口——假装「已排队」会让模型下一轮误以为文件已经改过。
      return refuse(capability === 'FILE_WRITE' ? 'SESSION_WRITE_NEEDS_APPROVAL'
        : 'SESSION_READ_NEEDS_NO_APPROVAL',
      capability === 'FILE_WRITE'
        ? `这次写入等待人工批准，原 operation_id=${prepared.operation_id}；会话暂无自动接续通道，` +
          '请核对原动作，不要重试或创建新的执行候选替代它。'
        : '只读读取不需要也不产生动作审批；请检查连接与权限配置。');
    }
    return refuse(prepared.status === 'DENIED' ? 'GATEWAY_ACTION_DENIED' : 'GATEWAY_NOT_DISPATCHABLE',
      `本次${capability === 'FILE_WRITE' ? '写入' : '读取'}没有进入可派发状态（${prepared.status}）。`);
  }
  if (!await repository.attachOperation(row.id, prepared.operation_id, origin.kind)) {
    return refuse('SESSION_OPERATION_ATTACH_FAILED', '本次读取的动作身份无法绑定到这条请求。');
  }

  let dispatched;
  try {
    dispatched = await dispatchGatewayAction(db, { workspaceId: session.workspace_id,
      operationId: prepared.operation_id, origin });
  } catch (error) {
    const detail = error instanceof Error ? error.message
      : `只读${capability === 'FILE_WRITE' ? '写' : '读'}取派发失败。`;
    await repository.markUnknown(row.id);
    return { providerToolCallId: call.providerToolCallId, name: call.name,
      content: `【GATEWAY_RESULT_UNRESOLVED】${detail}（需人工核对，未重试）`, isError: true };
  }
  if (dispatched.status === 'UNKNOWN') {
    // UNKNOWN 以 UNKNOWN 结束：不因「再读一次大概相同」写成成功。
    // 0126：写动作的 UNKNOWN 更要紧——文件可能已经改了一半，模型不能据此继续下一个写入。
    await repository.markUnknown(row.id);
    return { providerToolCallId: call.providerToolCallId, name: call.name,
      content: capability === 'FILE_WRITE'
        ? '【GATEWAY_RESULT_UNRESOLVED】这次写入的结果未知（文件可能已改、也可能没改），' +
          '需要人工核对后再继续；不要重试同一动作，也不要声称已经改好。'
        : '【GATEWAY_RESULT_UNRESOLVED】这次读取的结果未知，需要人工核对后再继续。',
      isError: true };
  }
  const content = projectToolResult(definition.actionType, dispatched.result_ref);
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  if (dispatched.status === 'SUCCEEDED') {
    await repository.settle(row.id, digest);
  } else {
    await repository.markUnknown(row.id);
  }
  return { providerToolCallId: call.providerToolCallId, name: call.name, content,
    isError: dispatched.status !== 'SUCCEEDED' };
}

/** 结果投影成给模型看的正文：有界截断 + 摘要，不把整棵目录树塞进上下文。 */
function projectToolResult(actionType: GatewayActionType, resultRef: JsonObject | null): string {
  const failure = typeof resultRef?.reason === 'string' && resultRef.reason !== ''
    ? resultRef.reason
    : typeof resultRef?.failure_kind === 'string' && resultRef.failure_kind !== ''
      ? resultRef.failure_kind : undefined;
  if (failure !== undefined) {
    return `【${failure}】${typeof resultRef?.error === 'string' ? resultRef.error : '本次读取没有结果。'}`;
  }
  const text = JSON.stringify(resultRef ?? {});
  return text.length <= RESULT_TEXT_LIMIT ? text
    : `${text.slice(0, RESULT_TEXT_LIMIT)}\n【截断：完整结果 ${text.length} 字符】`;
}

/**
 * 执行时使用的绝对目标。
 *
 * 与 Run 侧 `toolTargetFor` 同一形状（按工具声明的 capability 决定）：GIT_READ 的目标是
 * 受管根本身，FILE_READ 的目标是根内文件路径，目录浏览与搜索冻结根或根内相对子目录。
 * Gateway prepare 仍会按规范路径重新归一并做根内与保护路径判定，因此这里只是候选值，
 * 不是最终裁决。
 */
export function toolTarget(canonicalRoot: string, actionType: GatewayActionType,
  args: JsonObject, origin?: GatewayOrigin): string {
  if (actionType === 'COMPUTER_SCREENSHOT' || actionType === 'COMPUTER_GET_WINDOWS') {
    // Computer 只读动作没有受管根：目标是合成值，资源仍绑定（来源身份与账本）。
    return COMPUTER_DESKTOP_TARGET;
  }
  if (actionType === 'GIT_STATUS' || actionType === 'GIT_DIFF' || actionType === 'GIT_LOG' ||
      isGithubReadAction(actionType)) {
    // 0103: GitHub 查询的目标就是这个目录本身——仓库身份由适配器在此本地解析 remote，
    // 走的是与 GIT_READ 同一个绑定，因此不存在「读到别的仓库」。
    return canonicalRoot;
  }
  if (isBrowserAction(actionType)) {
    // 0105: 浏览器只读没有受管根；目标是按站点收窄的合成值，与工具循环同一算法。
    return origin === undefined
      ? BROWSER_UNKNOWN_TARGET : browserTargetForTool(origin, args);
  }
  if (actionType === 'APPLY_CHANGESET' || actionType === 'READ_CHANGE_SET') {
    // 0126: 变更集的目标是受管根本身——单个文件的路径写在 `changes` 里，不在 target 上。
    // 与 Run 侧 `toolTargetFor` 的 FILE_WRITE 分支同一形状（那里按 capability 判，
    // 这里按 actionType 判；两条入口必须给出同一个目标）。
    return canonicalRoot;
  }
  const relative = typeof args.relative_path === 'string' && args.relative_path !== ''
    ? args.relative_path : undefined;
  return join(canonicalRoot, relative ?? '');
}

function capabilityOf(actionType: GatewayActionType):
  'FILE_QUERY' | 'FILE_READ' | 'GIT_READ' | 'COMPUTER_READ' | 'GITHUB_READ' | 'BROWSER_READ'
  | 'FILE_WRITE' {
  const capability = capabilityFor(actionType);
  // 会话词表之外的动作在这一层之前已被拒，这里只做类型收窄。
  // 0126：FILE_WRITE 一并收窄放行——它只在 allowWrite 的那一轮才可能出现在 call 上。
  if (capability !== 'FILE_QUERY' && capability !== 'FILE_READ' && capability !== 'GIT_READ' &&
      capability !== 'COMPUTER_READ' && capability !== 'GITHUB_READ' &&
      capability !== 'BROWSER_READ' && capability !== 'FILE_WRITE') {
    throw new Error(`session round reached an unsupported capability: ${capability}`);
  }
  return capability;
}

/**
 * 人设助手的读取来源解析（0060 既有规则）。
 *
 * 人设会话没有目录绑定这一列（它的可读范围来自冻结快照），因此这里按项目解析：只有
 * **唯一一个** ACTIVE 受管资源时才算有确定目标。
 *
 * 规则收紧自原实现：原来这里取 `rows[0]`，即同项目登记了多个受管根时任取第一个。
 * 那会让模型读到一个用户没指认的目录，而且模型无从知道还有别的根可选。多根时现在
 * 明确拒掉并让用户先选定目录，而不是猜一个——「读不到」比「读到别人的目录」诚实。
 */
export async function assistantReadOrigin(db: DbExecutor, session: AssistSessionRow,
  messageId: string): Promise<SessionReadOriginResolution> {
  if (session.project_id === null) {
    return { ok: false, reason: 'ASSISTANT_SESSION_HAS_NO_PROJECT',
      detail: '这条会话没有绑定项目，无法读取受管目录。' };
  }
  const rows = (await createRepositories(db).gateway.listResources())
    .filter((resource) => resource.workspace_id === session.workspace_id &&
      resource.project_id === session.project_id && resource.status === 'ACTIVE');
  if (rows.length === 0) {
    return { ok: false, reason: 'ASSISTANT_NO_MANAGED_RESOURCE',
      detail: '这个项目还没有登记受管目录，无法读取文件。' };
  }
  if (rows.length > 1) {
    return { ok: false, reason: 'ASSISTANT_DIRECTORY_AMBIGUOUS',
      detail: `这个项目登记了 ${rows.length} 个受管目录，无法判断该读哪一个；` +
        '请先为这条会话选定目录。' };
  }
  const only = rows[0]!;
  return { ok: true, canonicalRoot: only.canonical_root,
    origin: { kind: 'ASSISTANT_READ', projectId: session.project_id, resourceId: only.id,
      sessionId: session.id, messageId } };
}

/**
 * 普通 Agent 主流程的读取来源解析（0087）。
 *
 * 目录只来自会话行上**持久绑定**的那一个受管资源，不按项目猜、不取第一个：本次重构前
 * 目录绑定只存在于浏览器组件状态，服务端因此没有任何可信来源可读（AM-03）。
 *
 * 四种无法解析的情况各给一条类型化原因，而不是回落成「读某个看起来像的目录」：
 * 没项目、没绑定目录、绑定的资源已不可用、绑定与项目不一致。
 */
async function agentSessionReadOrigin(db: DbExecutor, session: AssistSessionRow,
  messageId: string): Promise<SessionReadOriginResolution> {
  if (session.project_id === null) {
    return { ok: false, reason: 'AGENT_SESSION_HAS_NO_PROJECT',
      detail: '这条会话还没有归入项目，无法确定受管目录。' };
  }
  if (session.working_resource_id === null) {
    return { ok: false, reason: 'AGENT_SESSION_HAS_NO_WORKING_DIRECTORY',
      detail: '这段会话还没有选定工作目录，因此本次无法读取文件；请先选择目录。' };
  }
  const repositories = createRepositories(db);
  const resource = await repositories.gateway.readResource(session.working_resource_id);
  if (resource === undefined || resource.workspace_id !== session.workspace_id) {
    return { ok: false, reason: 'AGENT_SESSION_WORKING_DIRECTORY_UNAVAILABLE',
      detail: '这段会话绑定的工作目录已不存在，请重新选择目录。' };
  }
  if (resource.project_id !== session.project_id) {
    return { ok: false, reason: 'AGENT_SESSION_WORKING_DIRECTORY_MISMATCH',
      detail: '这段会话绑定的工作目录不属于它的项目；请重新选择目录。' };
  }
  if (resource.status !== 'ACTIVE') {
    return { ok: false, reason: 'AGENT_SESSION_WORKING_DIRECTORY_DISABLED',
      detail: '这段会话绑定的工作目录已停用，恢复后才能读取。' };
  }
  return { ok: true, canonicalRoot: resource.canonical_root,
    origin: { kind: 'AGENT_SESSION_READ', projectId: session.project_id, resourceId: resource.id,
      sessionId: session.id, messageId } };
}

/**
 * 按当前配置找一个具备该能力的 ACTIVE 连接。
 *
 * 与解释入口同一口径：只复用现有绑定，不创建连接、不放宽权限。找不到就返回 undefined，
 * 让调用方以类型化原因拒掉这次请求——不伪造连接，也不假装这项能力可用。
 */
async function findActiveConnection(repositories: ReturnType<typeof createRepositories>,
  workspaceId: string, projectId: string,
  capability: 'FILE_QUERY' | 'FILE_READ' | 'GIT_READ' | 'COMPUTER_READ' | 'GITHUB_READ'
    | 'BROWSER_READ' | 'FILE_WRITE', canonicalRoot: string): Promise<string | undefined> {
  for (const connection of await repositories.gateway.listConnections(workspaceId, projectId)) {
    if (connection.status !== 'ACTIVE') continue;
    const capabilities = await repositories.gateway.listConnectionCapabilities(connection.id);
    if (!capabilities.includes(capability)) continue;
    // 0126: FILE_WRITE 与只读文件能力走同一条根匹配——写连接如果不校验根路径，
    // 就可能是「在 A 目录授权、往 B 目录写」。
    if ((capability === 'FILE_QUERY' || capability === 'FILE_READ' || capability === 'GIT_READ' ||
         capability === 'FILE_WRITE') &&
        (typeof connection.config.root_path !== 'string' ||
          !targetMatches(connection.config.root_path, canonicalRoot, capability))) continue;
    return connection.id;
  }
  return undefined;
}

async function isCancelRequested(db: DbExecutor, messageId: string): Promise<boolean> {
  return createRepositories(db).assist.isCancelRequested(messageId);
}

/**
 * 已完成的会话历史照常作为上下文（与 A 档同一读取口径：会话内已完成轮次）。
 * 工具结果不在这里重复注入——它们已经按顺序在 toolTurns 里回传。
 */
async function historyTurns(db: DbExecutor, message: AssistMessageRow):
Promise<readonly { role: 'user' | 'assistant'; content: string }[]> {
  const history = await createRepositories(db).assist
    .listCompletedHistory(message.session_id, message.seq - 1n, 20);
  return history.filter((entry) => entry.content !== null).map((entry) => ({
    role: entry.role === 'USER' ? 'user' as const : 'assistant' as const,
    content: entry.content ?? '',
  }));
}
