import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import type { AssistMessageRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AssistModelPort, AssistResult, ModelToolTurn, ModelToolTurnResult,
  ModelUsage, AssistRequest } from '../workflow/fake-model-port.js';
import { gatewayParamsFor } from './tool-loop.js';
import { declaredToolSpecs, readInternalTool, type InternalToolName } from
  '../workflow/tool-catalog.js';
import { capabilityFor, dispatchGatewayAction, prepareGatewayAction,
  type GatewayActionType, type GatewayOrigin, type GatewaySessionReadOrigin }
  from './gateway-actions.js';
import { COMPUTER_DESKTOP_TARGET } from '../computer/protocol.js';
import { isGithubReadAction } from '../github/github-adapter.js';
import { createRepositories } from './unit-of-work.js';
import { selectRuntimeSystemPrompt } from '../workflow/prompts/index.js';

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
  // 0103: GitHub 只读。这四个工具只有当项目里存在声明 GITHUB_READ 的 ACTIVE 连接时才会
  // 进入本轮词表（assistantToolNames 与实际连接求交集），没装 gh 或未授权时模型看不到它们。
  'github_repo_view', 'github_pr_list', 'github_pr_view', 'github_issue_list',
];

/**
 * 本轮实际可用的只读工具 = 冻结只读词表 ∩ 当前连接可用的工具。
 *
 * `available` 必须由调用方按**当前**连接与权限算出；这里不做任何回落，
 * 交集为空就返回空词表——空词表意味着模型只能凭已读内容回答，而不是「全部放行」。
 */
export function assistantToolNames(available: readonly InternalToolName[]): readonly InternalToolName[] {
  const usable = new Set(available);
  return ASSISTANT_READ_TOOLS.filter((name) => usable.has(name));
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
  readonly resolveOrigin: () => Promise<SessionReadOriginResolution>;
  readonly maxRounds?: number | undefined;
  readonly maxToolCalls?: number | undefined;
}

export type AssistantReadonlyOutcome =
  | { readonly kind: 'CONTENT'; readonly content: string; readonly usage: ModelUsage;
      readonly providerRequestIds: readonly string[]; readonly rounds: number }
  | { readonly kind: 'CANCELLED'; readonly providerRequestId: string | null;
      readonly usage: ModelUsage; readonly providerRequestIds: readonly string[] }
  | { readonly kind: 'FAILED'; readonly errorCode: string; readonly usage: ModelUsage;
      readonly providerRequestIds: readonly string[] };

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS = 8;
const RESULT_TEXT_LIMIT = 16_000;

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
  const declared = declaredToolSpecs(assistantToolNames(input.availableTools));
  const toolTurns: ModelToolTurn[] = [];
  const providerRequestIds: string[] = [];
  let usage: ModelUsage = EMPTY_USAGE;
  let usedCalls = 0;
  const turns = await historyTurns(db, message);

  for (let round = 0; round <= maxRounds; round += 1) {
    if (input.signal.aborted || await isCancelRequested(db, message.id)) {
      return { kind: 'CANCELLED', providerRequestId: providerRequestIds.at(-1) ?? null,
        usage, providerRequestIds };
    }
    let response: AssistResult;
    try {
      const request: AssistRequest = { intent: 'DISCUSS', system: input.system,
        turns, tools: declared, toolTurns, signal: input.signal };
      response = input.invokeAssist === undefined
        ? await input.modelPort.assist(request) : await input.invokeAssist(request);
    } catch {
      return { kind: 'FAILED', errorCode: 'MODEL_FAILED', usage, providerRequestIds };
    }
    if (response.kind === 'CANCELLED') {
      return { kind: 'CANCELLED', providerRequestId: response.providerRequestId ?? null,
        usage, providerRequestIds };
    }
    providerRequestIds.push(response.providerRequestId);
    usage = addUsage(usage, response.usage);

    if (response.kind === 'CONTENT') {
      return { kind: 'CONTENT', content: response.content, usage, providerRequestIds,
        rounds: round };
    }

    const results: ModelToolTurnResult[] = [];
    for (const [ordinal, call] of response.calls.entries()) {
      const settled = await settleSessionReadonlyToolCall(db, { session, message,
        availableTools: input.availableTools, repository, round, ordinal, call,
        usedCalls, maxToolCalls, maxRounds, resolveOrigin: input.resolveOrigin });
      usedCalls += 1;
      results.push(settled);
      if (input.signal.aborted || await isCancelRequested(db, message.id)) {
        return { kind: 'CANCELLED', providerRequestId: response.providerRequestId,
          usage, providerRequestIds };
      }
    }
    toolTurns.push({ calls: response.calls, results, preamble: response.preamble,
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
    resolveOrigin: () => agentSessionReadOrigin(db, session, message.id),
    ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
    ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }) });
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
  const definition = readInternalTool(call.name);
  if (definition === undefined || !assistantToolNames(context.availableTools).includes(definition.name)) {
    // 写工具在这一步被拒：它不进入词表，模型收到的是类型化原因而不是静默。
    return refuse('TOOL_NOT_READ_ONLY', `工具 ${call.name} 不在本次只读词表内；会话读取不提供写工具。`);
  }

  const repositories = createRepositories(db);
  // 目录与来源身份在**这次请求**上解析：换绑、停用与撤权必须在下一次工具请求就生效。
  const resolved = await context.resolveOrigin();
  if (!resolved.ok) return refuse(resolved.reason, resolved.detail);
  const { origin, canonicalRoot } = resolved;
  const capability = capabilityOf(definition.actionType);
  // 连接按**当前**配置选，不从冻结快照读：连接被删或停用后下一轮就少一个能力。
  const connectionId = await findActiveConnection(repositories, session.workspace_id,
    origin.projectId, capability);
  if (connectionId === undefined) {
    return refuse('SESSION_CAPABILITY_NOT_CONFIGURED',
      `当前项目没有可用的 ${capability} 连接，本次不提供该读取能力。`);
  }

  const intentKey = `session-read:${row.id}`;
  let prepared;
  try {
    prepared = await prepareGatewayAction(db, { workspaceId: session.workspace_id,
      operationId: row.id, intentKey, connectionId, origin,
      actionType: definition.actionType,
      target: toolTarget(canonicalRoot, definition.actionType, call.arguments),
      // 参数按工具词表裁剪（复用 Run 侧同一份映射）：模型多带的字段不会变成动作参数，
      // 而 read_file 这类「路径在 target 里」的动作不会带着 relative_path 去 prepare。
      params: gatewayParamsFor(definition, call.arguments) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '本次读取被准入拒绝。';
    return refuse('GATEWAY_ACTION_DENIED', detail);
  }
  if (prepared.status !== 'PREPARED' && prepared.status !== 'SUCCEEDED') {
    const reason = prepared.status === 'DENIED' ? 'GATEWAY_ACTION_DENIED'
      : prepared.status === 'WAITING_APPROVAL' ? 'SESSION_READ_NEEDS_NO_APPROVAL'
        : 'GATEWAY_NOT_DISPATCHABLE';
    return refuse(reason, prepared.status === 'WAITING_APPROVAL'
      ? '只读读取不需要也不产生动作审批；请检查连接与权限配置。'
      : `本次读取没有进入可派发状态（${prepared.status}）。`);
  }
  if (!await repository.attachOperation(row.id, prepared.operation_id, origin.kind)) {
    return refuse('SESSION_OPERATION_ATTACH_FAILED', '本次读取的动作身份无法绑定到这条请求。');
  }

  let dispatched;
  try {
    dispatched = await dispatchGatewayAction(db, { workspaceId: session.workspace_id,
      operationId: prepared.operation_id, origin });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '只读派发失败。';
    await repository.markUnknown(row.id);
    return { providerToolCallId: call.providerToolCallId, name: call.name,
      content: `【GATEWAY_RESULT_UNRESOLVED】${detail}（需人工核对，未重试）`, isError: true };
  }
  if (dispatched.status === 'UNKNOWN') {
    // UNKNOWN 以 UNKNOWN 结束：不因「再读一次大概相同」写成成功。
    await repository.markUnknown(row.id);
    return { providerToolCallId: call.providerToolCallId, name: call.name,
      content: '【GATEWAY_RESULT_UNRESOLVED】这次读取的结果未知，需要人工核对后再继续。',
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
  args: JsonObject): string {
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
  const relative = typeof args.relative_path === 'string' && args.relative_path !== ''
    ? args.relative_path : undefined;
  return join(canonicalRoot, relative ?? '');
}

function capabilityOf(actionType: GatewayActionType):
  'FILE_QUERY' | 'FILE_READ' | 'GIT_READ' | 'COMPUTER_READ' | 'GITHUB_READ' {
  const capability = capabilityFor(actionType);
  // 会话读取只有只读能力；词表之外的动作在这一层之前已被拒，这里只做类型收窄。
  if (capability !== 'FILE_QUERY' && capability !== 'FILE_READ' && capability !== 'GIT_READ' &&
      capability !== 'COMPUTER_READ' && capability !== 'GITHUB_READ') {
    throw new Error(`session read round reached a non-read capability: ${capability}`);
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
  capability: 'FILE_QUERY' | 'FILE_READ' | 'GIT_READ' | 'COMPUTER_READ' | 'GITHUB_READ'): Promise<string | undefined> {
  for (const connection of await repositories.gateway.listConnections(workspaceId, projectId)) {
    if (connection.status !== 'ACTIVE') continue;
    const capabilities = await repositories.gateway.listConnectionCapabilities(connection.id);
    if (capabilities.includes(capability)) return connection.id;
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
