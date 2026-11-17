import type { JsonObject } from '../infrastructure/json.js';
import type { ModelCatalogEntryRow, SessionModelSelectionRow } from
  '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';
import { computeModelConfigFingerprint, protocolOf, readModelPortConfig,
  readOpenRouterModelPortConfig, type ModelPortConfig, type ModelProtocol } from
  '../workflow/model-port-config.js';
import { readCredentialFingerprint } from '../workflow/credential-identity.js';
import { readModelCatalogConfig } from '../workflow/model-catalog-config.js';
import { readSessionModelCapacity, resolveEffectiveModelWindow,
  type ModelContextWindowSource } from './model-context-window.js';
import type { ModelCallBudget } from
  '../workflow/openai-compatible-model-port.js';
import type { AssistModelPort } from '../workflow/fake-model-port.js';

const MAX_FREE_MODEL_ATTEMPTS = 3;
const FREE_MODEL_POLICY_VERSION = 'openrouter-free-fallback-v1';
/**
 * 候选模型的进程资格门槛，与“单次调用预算”独立。
 *
 * 2026-11-15：`RELAY_MODEL_MAX_CALL_TOKENS` 的默认值提升到 1M 后，若继续直接拿它当
 * 资格门槛，所有 128K 上下文模型都会被误判为不合格（memory-auto-capture 的 OpenRouter
 * 用例正是因此由绿转红）。预算可以按模型窗口收敛，资格门槛不能随预算目标漂移；
 * 这里保持升级前的 64K 下限，低于它的模型仍然拒绝。
 */
const MINIMUM_CONTEXT_WINDOW_TOKENS = 65_536;

/**
 * 作用域上限至少盖住一笔单次预留（2026-11-10，0165 修订）。
 *
 * 闸门对已结算调用按真实用量、对在途调用按整笔 `budget_reserved_tokens` 计费。
 * 旧实现把下限抬到 `reservation * 3`，在 1M 目标下会得到 3M，反而突破连接/部署
 * 配置的 `max_scope_tokens`（DB 上限 2M）。0165 起默认 `max_scope_tokens` 已是 1M，
 * 足够覆盖旧的「两笔 256K 在途」实测形态；超过配置上限的并发由队列/预算耗尽处理，
 * 不靠篡改配置值放行。
 */

/**
 * 单次调用预算的三个数（P1-A / 0165）。
 *
 * 0165 起预算不再读会话档位：模型窗口是能力参数，由 `model-context-window.ts` 解析，
 * 这里只把它收敛成**一次外呼的预算**：
 *   · `callReservationTokens`：这一次调用申请多少预算（写进 model_calls 的预留列）；
 *   · 模型真实窗口：已知窗口 / 安全回退（256K）；产品目标 1M 是上限，不是模型能力；
 *   · 服务商硬上限：连接/进程配置的 `maxCallTokens`，例如只接受 64K 请求的端点；
 *   · 输出预留：`maxOutputTokens` 由模型端口配置决定，不随窗口变化；
 *   · 作用域上限：`scopeTokenLimit` 至少要盖住单次预留，否则大窗口会把自己卡死在第一次调用。
 *
 * `minimum_context_window`（候选资格门槛）**不**随窗口走：它是「这个进程至少要什么样的
 * 模型」，让用户压缩阈值去改它会把换阈值变成静默的模型淘汰。
 */
export function planAssistModelBudget(config: { readonly maxCallTokens: number;
  readonly maxScopeCalls: number; readonly maxScopeTokens: number },
  capacity: { readonly modelWindowTokens: number | null;
    readonly providerCallCapTokens?: number | null;
    readonly windowSource?: ModelContextWindowSource }) {
  return planResolvedAssistModelBudget(config, {
    modelWindowTokens: capacity.modelWindowTokens,
    ...(capacity.providerCallCapTokens === null || capacity.providerCallCapTokens === undefined ? {}
      : { providerCallCapTokens: capacity.providerCallCapTokens }),
    ...(capacity.windowSource === undefined ? {} : { windowSource: capacity.windowSource }),
  });
}

/**
 * 新口径的预算：`reservation = min(1M 目标, 模型窗口/安全回退, 服务商硬上限)`。
 *
 * `contextBudgetTokens` 保留在返回值里，只是为了让旧执行端/快照读取器能拿到一个
 * 数字；它的语义已经从「用户档位」变成「这次外呼实际申请的容量」。
 */
function planResolvedAssistModelBudget(config: { readonly maxCallTokens: number;
  readonly maxScopeCalls: number; readonly maxScopeTokens: number },
  capacity: { readonly modelWindowTokens: number | null;
    readonly providerCallCapTokens?: number | null;
    readonly windowSource?: ModelContextWindowSource }) {
  const resolved = resolveEffectiveModelWindow({
    modelWindowTokens: capacity.modelWindowTokens,
    ...(capacity.providerCallCapTokens === undefined ? {}
      : { providerCallCapTokens: capacity.providerCallCapTokens }),
  });
  const reservation = resolved.windowTokens;
  // 配置上限就是上限：只保证一笔单次预留能进入闸门，不再用 3 倍预留抬高它。
  const scopeTokenLimit = Math.max(reservation, config.maxScopeTokens);
  return { callReservationTokens: reservation, scopeCallLimit: config.maxScopeCalls,
    scopeTokenLimit,
    contextBudgetTokens: reservation,
    modelContextWindowTokens: capacity.modelWindowTokens,
    providerCallCapTokens: capacity.providerCallCapTokens ?? null,
    contextWindowSource: capacity.modelWindowTokens === null ? 'UNKNOWN_FALLBACK' as const
      : capacity.windowSource ?? 'MODEL_CATALOG' as const,
    budgetBasis: 'MODEL_CONTEXT_WINDOW' as const,
    fallbackApplied: resolved.fallbackApplied };
}

/**
 * 旧快照的预算复核口径（0145–0164）：冻结时按会话档位，仍按当时真实窗口截断。
 *
 * 只给**升级前已冻结**的在途消息/Run 用。新请求一律走 `planAssistModelBudget`；
 * 这里保留旧公式，是为了不让一次安全的预算收紧把在途任务误判成「配置已变」。
 */
export function planLegacyAssistModelBudget(config: { readonly maxCallTokens: number;
  readonly maxScopeCalls: number; readonly maxScopeTokens: number },
  contextTokens: number | null, providerWindow: number | null) {
  const requested = contextTokens ?? config.maxCallTokens;
  const reservation = providerWindow === null ? requested : Math.min(requested, providerWindow);
  const scopeTokenLimit = Math.max(reservation, config.maxScopeTokens);
  return { callReservationTokens: reservation, scopeCallLimit: config.maxScopeCalls,
    scopeTokenLimit,
    contextBudgetTokens: contextTokens,
    modelContextWindowTokens: providerWindow,
    providerCallCapTokens: null,
    contextWindowSource: providerWindow === null ? 'UNKNOWN_FALLBACK' as const
      : 'MODEL_CATALOG' as const,
    budgetBasis: 'LEGACY_SESSION_TIER' as const,
    fallbackApplied: providerWindow === null };
}

/**
 * 冻结前的容量读数：真实模型优先，读不到时安全回退，绝不把「用户选过 1M」当成
 * 「模型支持 1M」。兼容旧调用点（第三个参数传数字时按旧档位处理）。
 */
async function resolveBudgetCapacity(repositories: Repositories,
  scope: AssistBudgetScope | undefined, env: NodeJS.ProcessEnv):
Promise<{ readonly modelWindowTokens: number | null;
  readonly providerCallCapTokens: number | null;
  readonly windowSource: ModelContextWindowSource }> {
  const selection = scope?.sessionId === undefined || scope.sessionId === null
    ? undefined : await repositories.modelSelection.readForSession(scope.sessionId);
  const capacity = await readSessionModelCapacity(repositories, scope?.workspaceId ?? '',
    selection, env);
  return { modelWindowTokens: capacity.modelWindowTokens,
    providerCallCapTokens: capacity.providerCallCapTokens,
    windowSource: capacity.windowSource };
}

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
  if (selection === undefined) {
    const config = readModelPortConfig(env);
    if (config === undefined) return undefined;
    const capacity = await resolveBudgetCapacity(repositories, scope, env);
    return withCredential(frozen([candidateSnapshot({ provider: 'openai-compatible',
      model: config.model, configFingerprint: computeModelConfigFingerprint(config) },
    false, null)], config, 1, requirements,
    planAssistModelBudget(config, capacity)), config);
  }
  if (selection.connection === 'default') {
    const config = readModelPortConfig(env);
    if (config === undefined || config.model !== selection.model ||
        computeModelConfigFingerprint(config) !== selection.config_fingerprint) {
      throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
    }
    const capacity = await resolveBudgetCapacity(repositories, scope, env);
    const candidate = candidateSnapshot({ provider: 'openai-compatible', model: config.model,
      configFingerprint: selection.config_fingerprint }, false, null);
    return withCredential(frozen([candidate], config, 1, requirements,
      planAssistModelBudget(config, capacity)), config);
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
  if (!isTextCandidate(selected, requirements, MINIMUM_CONTEXT_WINDOW_TOKENS)) {
    throw new Error('ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE');
  }
  if (computeModelConfigFingerprint(selectedConfig) !== selection.config_fingerprint) {
    throw new Error('ASSIST_MODEL_CONFIG_CHANGED');
  }
  const entries = [selected, ...rows.filter((row) => row.source_model_id !== selection.model)
    .filter((entry) => isTextCandidate(entry, requirements, MINIMUM_CONTEXT_WINDOW_TOKENS))
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
  // 窗口截断——不是把模型淘汰掉（资格门槛是独立的 64K 下限），而是不申请它装不下的预算。
  return withCredential(frozen(candidates, selectedConfig,
    Math.min(MAX_FREE_MODEL_ATTEMPTS, candidates.length), requirements,
    planAssistModelBudget(selectedConfig, { modelWindowTokens: selected.context_window,
      providerCallCapTokens: selectedConfig.maxCallTokens, windowSource: 'MODEL_CATALOG' })),
  selectedConfig);
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
  capacity: { readonly modelWindowTokens: number | null;
    readonly providerCallCapTokens?: number | null;
    readonly windowSource?: ModelContextWindowSource }): FrozenAssistModelPlan {
  // 协议随配置一起冻结：执行端据此选择同一种协议的端口，且配置指纹已经把协议算进去，
  // 因此改协议后旧快照必然失配（不会被重新解释成另一种协议）。
  const candidate = candidateSnapshot({ provider: config.provider, model: config.model,
    protocol: protocolOf(config),
    configFingerprint: computeModelConfigFingerprint(config) }, false, null);
  return withCredential(frozen([candidate], config, 1, requirements,
    planAssistModelBudget(config, capacity)), config);
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
     * 0165：这次外呼实际申请的容量。新快照 = 按模型窗口收敛后的可用窗口；
     * 0145–0164 的旧快照 = 当时的会话档位（保留旧语义给在途消息）。
     */
    readonly contextBudgetTokens: number | null;
    /** 模型真实窗口的已知值；旧快照没有这个键，读作 null（未知）。 */
    readonly modelContextWindowTokens: number | null;
    /** 服务商/连接的单次硬上限；旧快照没有这个键。 */
    readonly providerCallCapTokens: number | null;
    /** 窗口读数来源；旧快照没有这个键，读作 null（不冒充已识别）。 */
    readonly contextWindowSource: ModelContextWindowSource | null;
    /** 预算口径。缺键的旧快照一律 LEGACY_SESSION_TIER。 */
    readonly budgetBasis: 'MODEL_CONTEXT_WINDOW' | 'LEGACY_SESSION_TIER';
    readonly fallbackApplied: boolean };
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
  // 0165：预算口径。缺键 = 0145–0164 的旧快照，按当时的「会话档位」语义继续复核；
  // 新快照必须显式写 `MODEL_CONTEXT_WINDOW`，不能让升级中的在途消息被两套公式互相误判。
  const budgetBasis = budgetObject.budget_basis === undefined
    ? 'LEGACY_SESSION_TIER' as const
    : budgetObject.budget_basis === 'MODEL_CONTEXT_WINDOW' ? 'MODEL_CONTEXT_WINDOW' as const
      : budgetObject.budget_basis === 'LEGACY_SESSION_TIER' ? 'LEGACY_SESSION_TIER' as const
        : null;
  if (budgetBasis === null) throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  const modelWindow = budgetObject.model_context_window_tokens;
  if (modelWindow !== undefined && modelWindow !== null && !positiveSafeInteger(modelWindow)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  const providerCap = budgetObject.provider_call_cap_tokens;
  if (providerCap !== undefined && providerCap !== null && !positiveSafeInteger(providerCap)) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  const windowSource = budgetObject.context_window_source;
  if (windowSource !== undefined && (typeof windowSource !== 'string' ||
      !CONTEXT_WINDOW_SOURCES.includes(windowSource))) {
    throw new Error('ASSIST_MODEL_SNAPSHOT_INVALID');
  }
  const fallbackApplied = budgetObject.fallback_applied;
  if (fallbackApplied !== undefined && typeof fallbackApplied !== 'boolean') {
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
      contextBudgetTokens: typeof frozenBudget === 'number' ? frozenBudget : null,
      modelContextWindowTokens: typeof modelWindow === 'number' ? modelWindow : null,
      providerCallCapTokens: typeof providerCap === 'number' ? providerCap : null,
      contextWindowSource: typeof windowSource === 'string'
        ? windowSource as ModelContextWindowSource : null,
      budgetBasis,
      fallbackApplied: typeof fallbackApplied === 'boolean' ? fallbackApplied : false },
    maxAttempts };
}

const CONTEXT_WINDOW_SOURCES: readonly string[] = ['MODEL_CATALOG',
  'CAPABILITY_DECLARATION', 'MODEL_CONFIG', 'UNKNOWN_FALLBACK'];

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
    readonly scopeTokenLimit: number; readonly contextBudgetTokens: number | null;
    readonly modelContextWindowTokens: number | null;
    readonly providerCallCapTokens: number | null;
    readonly contextWindowSource: ModelContextWindowSource;
    readonly budgetBasis: 'MODEL_CONTEXT_WINDOW' | 'LEGACY_SESSION_TIER';
    readonly fallbackApplied: boolean }) {
  const snapshot: JsonObject = {
    version: 1, policy_version: FREE_MODEL_POLICY_VERSION,
    requirements: { tools: requirements.requiresTools,
      response_format: requirements.requiresJsonOutput,
      minimum_context_window: MINIMUM_CONTEXT_WINDOW_TOKENS },
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
      // 0165：这次外呼实际申请的容量（旧字段名保留，语义已从「会话档位」变成
      // 「按模型窗口收敛后的可用窗口」）。新增字段解释这个数从哪来、是否用了安全回退。
      context_budget_tokens: plan.contextBudgetTokens,
      model_context_window_tokens: plan.modelContextWindowTokens,
      provider_call_cap_tokens: plan.providerCallCapTokens,
      context_window_source: plan.contextWindowSource,
      // 缺这个键的旧快照一律按 LEGACY 处理：升级前冻结的在途消息不能因新口径被误杀。
      budget_basis: plan.budgetBasis,
      fallback_applied: plan.fallbackApplied },
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
