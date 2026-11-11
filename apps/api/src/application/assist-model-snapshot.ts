import type { JsonObject } from '../infrastructure/json.js';
import type { ModelCatalogEntryRow, SessionModelSelectionRow } from
  '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';
import { computeModelConfigFingerprint, protocolOf, readModelPortConfig,
  readOpenRouterModelPortConfig, type ModelPortConfig, type ModelProtocol } from
  '../workflow/model-port-config.js';
import { readCredentialFingerprint } from '../workflow/credential-identity.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';
import type { ModelCallBudget } from
  '../workflow/openai-compatible-model-port.js';
import type { AssistModelPort } from '../workflow/fake-model-port.js';

const MAX_FREE_MODEL_ATTEMPTS = 3;
const FREE_MODEL_POLICY_VERSION = 'openrouter-free-fallback-v1';

/**
 * 作用域预算要盖住几笔同时在途预留（2026-11-10）。
 *
 * 作用域闸门（model-call-repository.ts）对已结算调用按真实用量、对在途调用按整笔
 * `budget_reserved_tokens` 计费。实测最小重叠是「上一轮回复结束后仍在途的 TITLE／
 * MEMORY_CAPTURE 辅助调用」与「用户紧接着发的下一条消息」：两笔预留相加就等于旧公式的
 * 两倍下限，再叠上任何已结算用量就被判 MODEL_BUDGET_EXHAUSTED（2026-11-10 14:42:49
 * 会话 f7caca02：已结算 10397 + 在途 262144 + 新预留 262144 = 534685 > 524288）。
 *
 * 所以按「同时两笔在途 + 一笔已结算余量」给作用域下限，256K 档从 512K 提到 768K；
 * 上限仍是硬限制，仍随 max_scope_tokens 只有更高时取更高。
 */
const SCOPE_CONCURRENT_RESERVATIONS = 2;

/**
 * 单次调用预算的三个数（P1-A）。
 *
 * 0145：档位是**会话级**的（`assist_sessions.context_budget_tokens`），由调用方读出来
 * 传进来；Run / 委派这类没有对话会话的消费者仍传工作区默认（见 `readWorkspaceContextBudget`）。
 * 三个数讲的都是同一次外呼的预算，不管档位从哪来：
 *   · `callReservationTokens`：这一次调用申请多少预算（写进 model_calls 的预留列）；
 *   · Provider 实际窗口：候选模型自己声明的 `context_window`。档位高于它时**按窗口截断**，
 *     不能声称要用一个 Provider 根本装不下的预算；
 *   · 输出预留：`maxOutputTokens` 由模型端口配置决定，不随档位变化；
 *   · 作用域上限：`scopeTokenLimit` 至少要盖住单次预留，否则 1M 档会把自己卡死在第一次调用。
 *
 * `minimum_context_window`（候选资格门槛）**不**随档位走：它是「这个进程至少要什么样的
 * 模型」，让工作区档位去改它会把换档变成静默的模型淘汰。
 *
 * Run 准入也用同一函数重算「当前配置 + 冻结档位」下的预期三个数，
 * 而不是拿冻结预算直接和进程默认值比较（那样每次选了档位都会误判成配置变化）。
 */
export function planAssistModelBudget(config: { readonly maxCallTokens: number;
  readonly maxScopeCalls: number; readonly maxScopeTokens: number },
  contextTokens: number | null, providerWindow: number | null) {
  const requested = contextTokens ?? config.maxCallTokens;
  const reservation = providerWindow === null ? requested : Math.min(requested, providerWindow);
  // 选中档位时作用域要留出「两笔同时在途的预留 + 一笔已结算余量」：闸门对已结算调用按
  // 真实用量计费、对在途调用按整笔预留计费；旧公式只留两倍预留，任何已结算用量都会把余量吃干（见 SCOPE_CONCURRENT_RESERVATIONS）。
  const scopeFloor = contextTokens === null ? reservation
    : reservation * (1 + SCOPE_CONCURRENT_RESERVATIONS);
  return { callReservationTokens: reservation, scopeCallLimit: config.maxScopeCalls,
    scopeTokenLimit: Math.max(config.maxScopeTokens, scopeFloor),
    contextBudgetTokens: contextTokens };
}

/**
 * 0145：模型调用使用的档位。
 *
 * 有会话就是会话自己的档位（这就是「每个会话独立保存」在运行时的那一端）；
 * 没有会话的消费者（Run 执行、委派、连接验证）读工作区默认——那是它们的合法默认，
 * 不因为聊天改成会话级就被抹掉。
 */
async function readContextBudget(repositories: Repositories,
  scope: AssistBudgetScope | undefined): Promise<number | null> {
  if (scope === undefined) return null;
  if (scope.sessionId !== undefined && scope.sessionId !== null) {
    const session = await repositories.assist.readSession(scope.sessionId);
    if (session?.workspace_id === scope.workspaceId) return session.context_budget_tokens;
  }
  const configured = await repositories.workspaces.readDefaultDirectory(scope.workspaceId);
  return configured?.context_budget_tokens ?? null;
}

/**
 * 同一档位读法的公开入口：按连接冻结聊天计划时（`model-connection-runtime`）必须用
 * 完全相同的口径，否则连接路径与进程默认路径会算出不同的预算，冻结即失真。
 */
export const readAssistContextBudget = readContextBudget;

/** 预算来源的作用域：有会话按会话，没有会话按工作区。 */
export interface AssistBudgetScope {
  readonly workspaceId: string;
  /** 会话档位的来源；Run / 委派不传。 */
  readonly sessionId?: string | null;
}

/** Immutable non-secret model identity frozen in the RequestAssistMessage transaction. */
export async function freezeAssistModelSnapshot(repositories: Repositories,
  selection: SessionModelSelectionRow | undefined, env: NodeJS.ProcessEnv,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean },
  scope?: AssistBudgetScope):
  Promise<FrozenAssistModelPlan | undefined> {
  const contextBudget = await readContextBudget(repositories, scope);
  if (selection === undefined) {
    const config = readModelPortConfig(env);
    if (config === undefined) return undefined;
    return withCredential(frozen([candidateSnapshot({ provider: 'openai-compatible',
      model: config.model, configFingerprint: computeModelConfigFingerprint(config) },
    false, null)], config, 1, requirements,
    planAssistModelBudget(config, contextBudget, null)), config);
  }
  if (selection.connection === 'default') {
    const config = readModelPortConfig(env);
    if (config === undefined || config.model !== selection.model ||
        computeModelConfigFingerprint(config) !== selection.config_fingerprint) {
      throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
    }
    const candidate = candidateSnapshot({ provider: 'openai-compatible', model: config.model,
      configFingerprint: selection.config_fingerprint }, false, null);
    return withCredential(frozen([candidate], config, 1, requirements,
      planAssistModelBudget(config, contextBudget, null)), config);
  }

  const sync = await repositories.modelCatalog.readSyncState();
  const catalogConfig = readModelCatalogConfig(env);
  if (catalogConfig === undefined || sync.last_success_at === null ||
      Date.now() - sync.last_success_at.getTime() > catalogConfig.cacheTtlMs) {
    throw new Error('ASSIST_MODEL_CATALOG_STALE');
  }
  const rows = await repositories.modelCatalog.readEntries(true);
  const selected = rows.find((row) => row.source_model_id === selection.model);
  if (selection.free_only !== true || selected === undefined ||
      selected.source_model_id.toLowerCase() === 'openrouter/free') {
    throw new Error('ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE');
  }
  const selectedConfig = readOpenRouterModelPortConfig(env, selection.model);
  if (!isTextCandidate(selected, requirements, selectedConfig.maxCallTokens)) {
    throw new Error('ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE');
  }
  if (computeModelConfigFingerprint(selectedConfig) !== selection.config_fingerprint) {
    throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
  }
  const entries = [selected, ...rows.filter((row) => row.source_model_id !== selection.model)
    .filter((entry) => isTextCandidate(entry, requirements, selectedConfig.maxCallTokens))
    .sort(byModelId)].slice(0, MAX_FREE_MODEL_ATTEMPTS);
  const candidates = entries.map((entry, index) => {
    const config = readOpenRouterModelPortConfig(env, entry.source_model_id);
    return candidateSnapshot({ provider: 'openrouter', model: entry.source_model_id,
      configFingerprint: index === 0 ? selection.config_fingerprint
        : computeModelConfigFingerprint(config) }, true, {
      source: 'openrouter', snapshotSeq: sync.snapshot_seq.toString(),
      sourceModelId: entry.source_model_id });
  });
  // 免费模型路由额外多一个上限：Provider 目录里声明的 `context_window`。档位高于它时按
  // 窗口截断——不是把模型淘汰掉（资格门槛仍是进程默认），而是不申请它装不下的预算。
  return withCredential(frozen(candidates, selectedConfig,
    Math.min(MAX_FREE_MODEL_ATTEMPTS, candidates.length), requirements,
    planAssistModelBudget(selectedConfig, contextBudget, selected.context_window)), selectedConfig);
}

/**
 * P2（ADR-036 阶段三）：按**已解析的**配置冻结单候选计划。
 *
 * 与 `freezeAssistModelSnapshot` 的唯一区别是「配置从哪来」：那里读进程环境，这里由调用方
 * 给出（工作区默认连接解析出的配置）。快照形状、预算口径与凭据身份必须完全一致——否则
 * 执行端会按同一套校验把一次合法冻结误判成「配置已变」。
 *
 * 只冻结**一个**候选：连接是确切型号，不存在候选接续。Run 内不换模型。
 */
export function freezeSingleCandidatePlan(config: ModelPortConfig,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean },
  workspaceTokens: number | null): FrozenAssistModelPlan {
  // 协议随配置一起冻结：执行端据此选择同一种协议的端口，且配置指纹已经把协议算进去，
  // 因此改协议后旧快照必然失配（不会被重新解释成另一种协议）。
  const candidate = candidateSnapshot({ provider: config.provider, model: config.model,
    protocol: protocolOf(config),
    configFingerprint: computeModelConfigFingerprint(config) }, false, null);
  return withCredential(frozen([candidate], config, 1, requirements,
    planAssistModelBudget(config, workspaceTokens, null)), config);
}

/**
 * 0142：冻结计划里同时带出**服务端**凭据身份。
 *
 * 它不写进 `snapshot`：快照会随执行契约进入上下文清单、也可能出现在界面，凭据摘要不能
 * 出现在这些位置。调用方把它写进 execution_contracts / assist_messages 的独立列。
 */
export interface FrozenAssistModelPlan {
  readonly snapshot: JsonObject;
  readonly attemptState: JsonObject;
  readonly credentialFingerprint: string;
  /**
   * 0158：这次冻结绑定的是哪条已登记连接（没有则为 null）。
   *
   * 快照本身不写连接 ID——它回答「模型计划」，连接身份是解析依据。调用方把它写进
   * `assist_messages.model_connection_id`，执行端据此解析，与 Run 的
   * `execution_contracts.connection_id` 同形。非空必然同时有快照（表 CHECK 兜住）。
   */
  readonly connectionId: string | null;
}

function withCredential(plan: { readonly snapshot: JsonObject;
  readonly attemptState: JsonObject }, config: { readonly provider: string;
  readonly apiKey: string }, connectionId: string | null = null): FrozenAssistModelPlan {
  return { ...plan, credentialFingerprint: readCredentialFingerprint(config), connectionId };
}

export interface AssistModelCandidateSnapshot {
  readonly connection: { readonly provider: string; readonly model: string;
    /**
     * 协议（MODEL-SETTINGS-03）。`openai-compatible` 快照可以省略它（0143–0159 的既有
     * 快照没有这个键）；`anthropic-messages` 必须显式出现，读不到就当快照无效。
     */
    readonly protocol?: ModelProtocol | undefined;
    readonly configFingerprint: string };
  readonly freeOnly: boolean;
  readonly catalogBasis: { readonly source: 'openrouter'; readonly snapshotSeq: string;
    readonly sourceModelId: string } | null;
}

export interface ParsedAssistModelSnapshot {
  readonly version: 1;
  readonly policyVersion: string;
  readonly requirements: { readonly requiresTools: boolean;
    readonly requiresJsonOutput: boolean; readonly minimumContextWindow: number };
  readonly candidates: readonly AssistModelCandidateSnapshot[];
  readonly budget: { readonly callReservationTokens: number;
    readonly scopeCallLimit: number; readonly scopeTokenLimit: number;
    /**
     * 0145：冻结时用的是哪个档位（会话档位；没有会话的消费者是工作区默认）。
     * null = 冻结时读不到档位，按进程默认。
     */
    readonly contextBudgetTokens: number | null };
  readonly maxAttempts: number;
}

export function parseAssistModelSnapshot(value: JsonObject): ParsedAssistModelSnapshot {
  const version = value.version;
  const policyVersion = value.policy_version;
  const candidates = value.candidates;
  const budget = value.budget;
  const requirements = value.requirements;
  const maxAttempts = value.max_attempts;
  if (version !== 1 || typeof policyVersion !== 'string' || !Array.isArray(candidates) ||
      candidates.length < 1 || candidates.length > MAX_FREE_MODEL_ATTEMPTS ||
      typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 || maxAttempts > candidates.length ||
      typeof budget !== 'object' || budget === null || Array.isArray(budget) ||
      typeof requirements !== 'object' || requirements === null || Array.isArray(requirements)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  const normalized = candidates.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    const object = entry as Record<string, unknown>;
    const connection = object.connection;
    const basis = object.catalog_basis;
    if (typeof connection !== 'object' || connection === null || Array.isArray(connection)) {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    const candidateConnection = connection as Record<string, unknown>;
    if (candidateConnection.provider === 'openrouter' &&
        typeof candidateConnection.model === 'string' &&
        candidateConnection.model.toLowerCase() === 'openrouter/free') {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    // MODEL-SETTINGS-03：协议是快照的一部分。provider 只决定解析路径与账本分组，
    // 协议决定端口；两者不一致的快照直接判无效，不做「按 provider 猜协议」的兼容。
    const declaredProtocol = candidateConnection.protocol;
    const protocol = declaredProtocol === undefined
      ? (candidateConnection.provider === 'anthropic-messages' ? 'anthropic-messages'
        : 'openai-compatible')
      : declaredProtocol;
    if ((protocol !== 'openai-compatible' && protocol !== 'anthropic-messages') ||
        (protocol === 'anthropic-messages') !==
          (candidateConnection.provider === 'anthropic-messages') ||
        (candidateConnection.provider !== 'openrouter' &&
         candidateConnection.provider !== 'openai-compatible' &&
         candidateConnection.provider !== 'anthropic-messages') ||
        typeof candidateConnection.model !== 'string' ||
        candidateConnection.model.trim() === '' || candidateConnection.model.length > 200 ||
        typeof candidateConnection.config_fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(candidateConnection.config_fingerprint) ||
        typeof object.free_only !== 'boolean' ||
        (basis !== null && (typeof basis !== 'object' || Array.isArray(basis))) ||
        object.free_only !== (candidateConnection.provider === 'openrouter')) {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    let catalogBasis: AssistModelCandidateSnapshot['catalogBasis'];
    if (basis === null && candidateConnection.provider === 'openrouter' ||
        basis !== null && candidateConnection.provider !== 'openrouter') {
      throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
    }
    if (basis === null) catalogBasis = null;
    else {
      const basisObject = basis as Record<string, unknown>;
      if (basisObject.source !== 'openrouter' ||
          typeof basisObject.snapshot_seq !== 'string' ||
          !/^[1-9][0-9]*$/u.test(basisObject.snapshot_seq) ||
          basisObject.source_model_id !== candidateConnection.model) {
        throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
      }
      catalogBasis = { source: 'openrouter', snapshotSeq: basisObject.snapshot_seq,
        sourceModelId: basisObject.source_model_id as string };
    }
    return {
      connection: { provider: candidateConnection.provider, model: candidateConnection.model,
        protocol, configFingerprint: candidateConnection.config_fingerprint },
      freeOnly: object.free_only,
      catalogBasis,
    };
  });
  const budgetObject = budget as Record<string, unknown>;
  const requirementObject = requirements as Record<string, unknown>;
  if (!positiveSafeInteger(budgetObject.call_reservation_tokens) ||
      !positiveSafeInteger(budgetObject.scope_call_limit) ||
      !positiveSafeInteger(budgetObject.scope_token_limit) ||
      typeof requirementObject.tools !== 'boolean' ||
      typeof requirementObject.response_format !== 'boolean' ||
      !positiveSafeInteger(requirementObject.minimum_context_window) ||
      normalized.some((candidate) => candidate.connection.provider !==
        normalized[0]!.connection.provider) ||
      new Set(normalized.map((candidate) => candidate.connection.model)).size !== normalized.length ||
      (normalized[0]!.connection.provider === 'openai-compatible' ||
        normalized[0]!.connection.provider === 'anthropic-messages') &&
        (normalized.length !== 1 || maxAttempts !== 1) ||
      normalized[0]!.connection.provider === 'openrouter' &&
        normalized.some((candidate) => candidate.catalogBasis?.snapshotSeq !==
          normalized[0]!.catalogBasis?.snapshotSeq)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  // 0145：档位是可选字段——0145 之前冻结的快照只有旧键 `workspace_context_budget_tokens`，
  // 读成同一个数（它当时就是生效的那一档），不因为改过键名就让在途消息无法继续。
  const frozenBudget = budgetObject.context_budget_tokens ??
    budgetObject.workspace_context_budget_tokens;
  if (frozenBudget !== undefined && frozenBudget !== null && !positiveSafeInteger(frozenBudget)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  return { version: 1, policyVersion,
    requirements: { requiresTools: requirementObject.tools as boolean,
      requiresJsonOutput: requirementObject.response_format as boolean,
      minimumContextWindow: requirementObject.minimum_context_window as number },
    candidates: normalized as readonly AssistModelCandidateSnapshot[],
    budget: { callReservationTokens: budgetObject.call_reservation_tokens as number,
      scopeCallLimit: budgetObject.scope_call_limit as number,
      scopeTokenLimit: budgetObject.scope_token_limit as number,
      contextBudgetTokens: typeof frozenBudget === 'number' ? frozenBudget : null },
    maxAttempts };
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

/** 冻结快照里的预算换成端口/记账用的三个数。 */
export function snapshotIdentityBudget(budget: ParsedAssistModelSnapshot['budget']): ModelCallBudget {
  return { callReservationTokens: budget.callReservationTokens,
    scopeCallLimit: budget.scopeCallLimit, scopeTokenLimit: budget.scopeTokenLimit };
}

/**
 * 路由解析在**进入模型调用之前**失败时的精确停因码（AGENT-CORE-RELIABILITY，2026-11-01）。
 *
 * 这三种失败都发生在 `resolveAssistModelRoute` / 快照解析阶段：快照不合法、模型配置
 * 已变更、凭据已换。它们与 Provider 无关，也不是调用账本意义上的传输失败——折叠成
 * 裸 `MODEL_FAILED` 后，消息行分不清「模型坏了」和「这条消息不能按当前模型身份继续」，
 * 而后者用户重发一次就会得到按新配置的正常回复。只认精确码，不做模糊匹配；
 * 已进入调用的路由停因（免费额度、限流、候选耗尽）保持既有口径（MODEL_FAILED +
 * `provider_error_kind` + Provider 状态账本），不在消息行上改词表。
 */
const ASSIST_MODEL_ROUTE_STOP_CODES: readonly string[] = [
  'ASSIST_MODEL_SNAPSHOT_INVALID', 'ASSIST_MODEL_CONFIG_CHANGED',
  'ASSIST_MODEL_CREDENTIAL_CHANGED',
  // 0158：消息冻结在已登记连接上，解析端口时的五道闸门各自给精确停因。
  'ASSIST_MODEL_CONNECTION_UNAVAILABLE', 'ASSIST_MODEL_CONNECTION_DISABLED',
  'ASSIST_MODEL_CONNECTION_CREDENTIAL_MISSING', 'ASSIST_MODEL_CREDENTIAL_STORE_UNAVAILABLE',
];

export function readAssistModelRouteStopCode(error: unknown): string | undefined {
  return error instanceof Error &&
    ASSIST_MODEL_ROUTE_STOP_CODES.includes(error.message)
    ? error.message : undefined;
}

/**
 * 0135：把冻结快照的预算套到真实端口上。
 *
 * 只对 `OpenAiCompatibleModelPort` 生效：它既改记账身份，也改端口内部的实际调用闸门。
 * 测试替身原样返回——它们不发起真实外呼，身份里的预算不影响任何真实准入；
 * 生产路径的三个入口（Assist 默认/免费路由、自动提取、压缩、Run）拿到的都是真实端口。
 */
export function applySnapshotBudget(port: AssistModelPort,
  budget: ParsedAssistModelSnapshot['budget']): AssistModelPort {
  // 两种协议端口都实现 withBudget；按能力判断，Anthropic 连接也要按冻结档位外呼。
  const budgeted = port as AssistModelPort & { withBudget?: (input:
    ReturnType<typeof snapshotIdentityBudget>) => AssistModelPort };
  return typeof budgeted.withBudget === 'function'
    ? budgeted.withBudget(snapshotIdentityBudget(budget)) : port;
}

function frozen(candidates: readonly AssistModelCandidateSnapshot[],
  config: { readonly maxCallTokens: number; readonly maxScopeCalls: number;
    readonly maxScopeTokens: number }, maxAttempts: number,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean },
  plan: { readonly callReservationTokens: number; readonly scopeCallLimit: number;
    readonly scopeTokenLimit: number; readonly contextBudgetTokens: number | null }) {
  const snapshot: JsonObject = {
    version: 1, policy_version: FREE_MODEL_POLICY_VERSION,
    requirements: { tools: requirements.requiresTools,
      response_format: requirements.requiresJsonOutput,
      minimum_context_window: config.maxCallTokens },
    candidates: candidates.map((candidate) => ({
      connection: { provider: candidate.connection.provider, model: candidate.connection.model,
        // 只在非默认协议时写入：既有 openai 快照的键集保持不变，旧冻结不被改写。
        ...(protocolOf(candidate.connection) === 'openai-compatible'
          ? {} : { protocol: protocolOf(candidate.connection) }),
        config_fingerprint: candidate.connection.configFingerprint },
      free_only: candidate.freeOnly,
      catalog_basis: candidate.catalogBasis === null ? null : {
        source: candidate.catalogBasis.source, snapshot_seq: candidate.catalogBasis.snapshotSeq,
        source_model_id: candidate.catalogBasis.sourceModelId },
    })),
    budget: { call_reservation_tokens: plan.callReservationTokens,
      scope_call_limit: plan.scopeCallLimit, scope_token_limit: plan.scopeTokenLimit,
      // 0145：这次调用用的是哪个档位（会话档位；没有会话的消费者是工作区默认）。
      // 它只解释「这个预留数从哪来」，不是新的闸门，也不改任何权限。
      context_budget_tokens: plan.contextBudgetTokens },
    max_attempts: maxAttempts,
  };
  return { snapshot, attemptState: { revision: '1', current_candidate_index: 0,
    switch_count: 0, switches: [], active_call_id: null, active_candidate_index: null,
    active_turn_id: null, completed_turn_id: null, completed_call_id: null,
    last_failure: null, status: 'READY' } };
}

/**
 * 0128：一份「还没开始」的模型尝试状态。
 *
 * 子会话消息沿用主会话冻结的模型选择快照（同一个模型、同一份预算事实），但尝试状态
 * 必须从头开始——把主消息在途的 `active_call_id` 带过去，会让子执行的第一轮就撞上
 * 「这一轮已有调用在进行中」而永远无法开始。
 */
export function freshAssistModelAttemptState(): JsonObject {
  return { revision: '1', current_candidate_index: 0,
    switch_count: 0, switches: [], active_call_id: null, active_candidate_index: null,
    active_turn_id: null, completed_turn_id: null, completed_call_id: null,
    last_failure: null, status: 'READY' };
}

function candidateSnapshot(connection: AssistModelCandidateSnapshot['connection'], freeOnly: boolean,
  catalogBasis: AssistModelCandidateSnapshot['catalogBasis']): AssistModelCandidateSnapshot {
  return { connection, freeOnly, catalogBasis };
}

function isTextCandidate(entry: ModelCatalogEntryRow,
  requirements: { readonly requiresTools: boolean; readonly requiresJsonOutput: boolean },
  minimumContextWindow: number): boolean {
  return entry.is_free && entry.source_model_id.toLowerCase() !== 'openrouter/free' &&
    entry.capabilities.text_input === true && entry.capabilities.text_output === true &&
    entry.context_window !== null && entry.context_window >= minimumContextWindow &&
    (!requirements.requiresTools || entry.capabilities.tools === true) &&
    (!requirements.requiresJsonOutput || entry.capabilities.response_format === true);
}

function byModelId(a: ModelCatalogEntryRow, b: ModelCatalogEntryRow): number {
  return a.source_model_id < b.source_model_id ? -1 : a.source_model_id > b.source_model_id ? 1 : 0;
}
