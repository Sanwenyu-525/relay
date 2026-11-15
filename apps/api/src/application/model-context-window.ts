import type { ModelConnectionRow, SessionModelSelectionRow } from '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';
import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import { protocolOf, readModelPortConfig, readOpenRouterModelPortConfig,
  type ModelPortConfig, type ModelProviderKind } from '../workflow/model-port-config.js';

/**
 * 模型上下文容量解析（0165，2026-11-15）。
 *
 * 本次重构的核心边界：**模型窗口是能力参数，压缩阈值是用户偏好**。这个模块只回答
 * 「当前模型真实能用多大的窗口」，不读用户的压缩阈值，也不写任何设置。
 *
 * 证据优先级（每一档都必须能说清来源，未知就如实未知）：
 *
 *   · 进程默认模型：部署配置 `RELAY_MODEL_CONTEXT_WINDOW`（显式、最贴近这台机器的
 *     端点）→ 模型目录 `context_window`（服务商公开元数据）→ 高级能力声明；
 *   · 已登记连接：能力声明（连接是一个确切型号/端点，人已核对的声明优先）→ 目录；
 *   · 目录免费路由：目录（就是这个路由自己的公开元数据）→ 能力声明。
 *
 * 都读不到时使用 `UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS` 作为**安全回退**，并在
 * `windowSource` 标记 `UNKNOWN_FALLBACK`。回退值不是 1M：无法确认真实窗口时，
 * 不得假定模型支持 1M（3.1 的硬要求）。
 */

/**
 * 产品目标容量（1M tokens）。它是系统愿意为单次请求申请的上限，不是模型真实能力；
 * 真实模型窗口更小时必须按窗口收敛。取十进制 1,000,000，与用户口径的「1M Tokens」
 * 一致（不是 1,048,576 的二进制 MiB）。
 */
export const MODEL_CONTEXT_TARGET_TOKENS = 1_000_000;

/**
 * 模型窗口未知时的安全回退。
 *
 * 取 262,144（256K）：与 0145 以前的产品默认档位一致，是保守的已知可用规模；
 * 它既不冒充 1M，也不把大多数现代模型的默认 350K 阈值压到不可用。
 */
export const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 262_144;

/** 能力声明的合法区间：16K 下界 + 4M 上界，拒绝明显的单位错误。 */
export const MIN_DECLARED_CONTEXT_WINDOW_TOKENS = 16_384;
export const MAX_DECLARED_CONTEXT_WINDOW_TOKENS = 4_000_000;

export type ModelContextWindowSource =
  | 'MODEL_CATALOG'
  | 'CAPABILITY_DECLARATION'
  | 'MODEL_CONFIG'
  | 'UNKNOWN_FALLBACK';

export interface ModelContextCapacity {
  /** 当前解析到的模型 id；完全读不到配置时为 null。 */
  readonly model: string | null;
  /** 模型真实窗口的已知值；null = 未知（不当作无限，也不冒充 1M）。 */
  readonly modelWindowTokens: number | null;
  readonly windowSource: ModelContextWindowSource;
  /** 服务商/连接的单次请求硬上限；null = 没有额外上限。 */
  readonly providerCallCapTokens: number | null;
  readonly outputReserveTokens: number | null;
  /** 最终可用窗口 = min(1M 目标, 模型窗口/安全回退, 服务商硬上限)。 */
  readonly effectiveWindowTokens: number;
  readonly fallbackApplied: boolean;
}

/**
 * 纯算术：把「已知窗口（或回退）」与产品目标、服务商硬上限收敛成一个可用窗口。
 *
 * 只在这里取一次 min，压缩策略与冻结预算都调用它，避免两处各算一份而漂移。
 * 结果至少为 1：极小窗口下也不能算出 0，否则任何请求都会被判「必须压缩」。
 */
export function resolveEffectiveModelWindow(input: {
  readonly modelWindowTokens: number | null;
  readonly providerCallCapTokens?: number | null;
  readonly targetWindowTokens?: number;
  readonly fallbackWindowTokens?: number;
}): { readonly windowTokens: number; readonly fallbackApplied: boolean } {
  const target = positiveInteger(input.targetWindowTokens) ?? MODEL_CONTEXT_TARGET_TOKENS;
  const fallback = positiveInteger(input.fallbackWindowTokens) ?? UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS;
  const declared = positiveInteger(input.modelWindowTokens);
  const base = declared ?? fallback;
  const cap = positiveInteger(input.providerCallCapTokens);
  const windowTokens = Math.max(1, Math.min(target, base, cap ?? base));
  return { windowTokens, fallbackApplied: declared === null };
}

/** 组装一个可展示、可计算的容量读数；来源与回退标记必须自洽。 */
export function assembleModelContextCapacity(input: {
  readonly model: string | null;
  readonly modelWindowTokens: number | null;
  readonly windowSource: ModelContextWindowSource;
  readonly providerCallCapTokens?: number | null;
  readonly outputReserveTokens?: number | null;
  readonly targetWindowTokens?: number;
}): ModelContextCapacity {
  const declared = positiveInteger(input.modelWindowTokens);
  const source: ModelContextWindowSource = declared === null
    ? 'UNKNOWN_FALLBACK'
    : input.windowSource === 'UNKNOWN_FALLBACK' ? 'MODEL_CATALOG' : input.windowSource;
  const resolved = resolveEffectiveModelWindow({
    modelWindowTokens: declared,
    ...(input.providerCallCapTokens === undefined || input.providerCallCapTokens === null ? {}
      : { providerCallCapTokens: input.providerCallCapTokens }),
    ...(input.targetWindowTokens === undefined ? {}
      : { targetWindowTokens: input.targetWindowTokens }),
  });
  return {
    model: input.model,
    modelWindowTokens: declared,
    windowSource: source,
    providerCallCapTokens: positiveInteger(input.providerCallCapTokens),
    outputReserveTokens: positiveInteger(input.outputReserveTokens),
    effectiveWindowTokens: resolved.windowTokens,
    fallbackApplied: resolved.fallbackApplied,
  };
}

/**
 * 会话当前生效模型的容量读数。
 *
 * `workspaceId` 必须显式传入：注册连接的仓储按工作区隔离，而 `Repositories` 本身
 * 不带「当前工作区」。`modelHint` 只服务没有进程配置/选择行的消费者（离线 Fake
 * 回归、压缩执行端已经知道本次外呼用哪个模型）：它不是用户输入，也不改变解析优先级。
 */
export async function readSessionModelCapacity(r: Repositories, workspaceId: string,
  selection: SessionModelSelectionRow | undefined, env: NodeJS.ProcessEnv,
  modelHint?: string | null): Promise<ModelContextCapacity> {
  if (selection === undefined) {
    const config = safePortConfig(() => readModelPortConfig(env));
    return capacityFromConfig(r, config, env, modelHint);
  }
  if (selection.connection === 'default') {
    const config = safePortConfig(() => readModelPortConfig(env));
    return capacityFromConfig(r, config?.model === selection.model ? config : undefined,
      env, selection.model);
  }
  if (selection.connection === 'registered') {
    const row: ModelConnectionRow | undefined = selection.connection_id === null ? undefined
      : await r.modelConnections.read(workspaceId, selection.connection_id).catch(() => undefined);
    if (row === undefined) {
      return connectionCapacity(r, null, null);
    }
    return connectionCapacity(r, row, selection.model);
  }
  const config = safePortConfig(() => readOpenRouterModelPortConfig(env, selection.model));
  const catalog = await readCatalogWindow(r, selection.model);
  const declared = catalog === null
    ? await readDeclaredWindow(r, 'openrouter', selection.model) : null;
  const capacity = assembleModelContextCapacity({
    model: selection.model,
    modelWindowTokens: catalog ?? declared,
    windowSource: catalog !== null ? 'MODEL_CATALOG'
      : declared !== null ? 'CAPABILITY_DECLARATION' : 'UNKNOWN_FALLBACK',
    ...(config === undefined ? {} : { providerCallCapTokens: config.maxCallTokens,
      outputReserveTokens: config.maxOutputTokens }),
  });
  logResolution('openrouter_free', capacity);
  return capacity;
}

/**
 * 一条已登记连接的容量读数（冻结连接计划时使用）。
 *
 * 连接是「确切型号 + 确切端点」，所以人已核对的能力声明优先于公共目录；连接的
 * `max_call_tokens` / `max_output_tokens` 是这条端点的硬约束。
 */
export async function readConnectionModelCapacity(r: Repositories, row: ModelConnectionRow,
  modelHint?: string | null): Promise<ModelContextCapacity> {
  return connectionCapacity(r, row, modelHint);
}

async function connectionCapacity(r: Repositories, row: ModelConnectionRow | null,
  modelHint: string | null | undefined): Promise<ModelContextCapacity> {
  const model = normalizeModel(modelHint) ?? normalizeModel(row?.default_model);
  if (model === null) {
    return assembleModelContextCapacity({ model: null, modelWindowTokens: null,
      windowSource: 'UNKNOWN_FALLBACK' });
  }
  const declared = await readDeclaredWindow(r, row?.provider_kind ?? 'openai-compatible', model);
  const catalog = await readCatalogWindow(r, model);
  const known = declared ?? catalog;
  const capacity = assembleModelContextCapacity({
    model,
    modelWindowTokens: known,
    windowSource: declared !== null ? 'CAPABILITY_DECLARATION'
      : known !== null ? 'MODEL_CATALOG' : 'UNKNOWN_FALLBACK',
    ...(row === null ? {} : { providerCallCapTokens: row.max_call_tokens,
      outputReserveTokens: row.max_output_tokens }),
  });
  logResolution('registered_connection', capacity);
  return capacity;
}

/** 按模型 id 解析（不绑定会话/连接）：发送前风险审计、部署诊断使用。 */
export async function readModelContextCapacityByModel(r: Repositories, model: string | null,
  env: NodeJS.ProcessEnv, provider: ModelProviderKind = 'openai-compatible'):
Promise<ModelContextCapacity> {  const normalized = normalizeModel(model);
  if (normalized === null) {
    return assembleModelContextCapacity({ model: null, modelWindowTokens: null,
      windowSource: 'UNKNOWN_FALLBACK' });
  }
  const config = safePortConfig(() => readModelPortConfig(env));
  const envWindow = config?.model === normalized ? readEnvWindow(env) : null;
  const catalog = await readCatalogWindow(r, normalized);
  const declared = envWindow === null && catalog === null
    ? await readDeclaredWindow(r, provider, normalized) : null;
  const known = envWindow ?? catalog ?? declared;
  const capacity = assembleModelContextCapacity({
    model: normalized,
    modelWindowTokens: known,
    windowSource: envWindow !== null ? 'MODEL_CONFIG'
      : catalog !== null ? 'MODEL_CATALOG'
        : declared !== null ? 'CAPABILITY_DECLARATION' : 'UNKNOWN_FALLBACK',
    ...(config === undefined ? {} : { providerCallCapTokens: config.maxCallTokens,
      outputReserveTokens: config.maxOutputTokens }),
  });
  logResolution('by_model', capacity);
  return capacity;
}

/** 进程默认模型：部署声明 > 目录 > 能力声明。 */
async function capacityFromConfig(r: Repositories, config: ModelPortConfig | undefined,
  env: NodeJS.ProcessEnv, modelHint?: string | null): Promise<ModelContextCapacity> {
  const model = normalizeModel(config?.model) ?? normalizeModel(modelHint);
  const envWindow = config !== undefined && model === normalizeModel(config.model)
    ? readEnvWindow(env) : null;
  const catalog = model === null ? null : await readCatalogWindow(r, model);
  const declared = envWindow === null && catalog === null && model !== null
    ? await readDeclaredWindow(r, protocolOf(config ?? { provider: 'openai-compatible' }), model)
    : null;
  const capacity = assembleModelContextCapacity({
    model,
    modelWindowTokens: envWindow ?? catalog ?? declared,
    windowSource: envWindow !== null ? 'MODEL_CONFIG'
      : catalog !== null ? 'MODEL_CATALOG'
        : declared !== null ? 'CAPABILITY_DECLARATION' : 'UNKNOWN_FALLBACK',
    ...(config === undefined ? {} : { providerCallCapTokens: config.maxCallTokens,
      outputReserveTokens: config.maxOutputTokens }),
  });
  logResolution('process_default', capacity);
  return capacity;
}

/** 目录窗口：未知或异常都不升级成业务失败；异常留一条可追踪的日志。 */
async function readCatalogWindow(r: Repositories, model: string | null): Promise<number | null> {
  if (model === null) return null;
  try {
    return positiveInteger((await r.modelCatalog.readEntryBySourceModelId(model))?.context_window);
  } catch (error) {
    getRuntimeLogger('context-compaction').warn('context_window_catalog_lookup_failed', {
      model, error });
    return null;
  }
}

/** 高级能力声明：人已核对过的模型窗口；读不到就是「未声明」。 */
async function readDeclaredWindow(r: Repositories, provider: string,
  model: string): Promise<number | null> {
  try {
    const row = await r.modelCapabilities.readDeclaration(provider, model);
    return positiveInteger(row?.context_window_tokens);
  } catch (error) {
    getRuntimeLogger('context-compaction').warn('context_window_declaration_lookup_failed', {
      provider, model, error });
    return null;
  }
}

/**
 * 部署配置声明：`RELAY_MODEL_CONTEXT_WINDOW`。
 *
 * 只给进程默认模型使用；非法值不改变配置读取的成败（`readModelPortConfig` 不校验它），
 * 但会留一条 warn，拒绝静默使用一个坏值。
 */
function readEnvWindow(env: NodeJS.ProcessEnv): number | null {
  const raw = env.RELAY_MODEL_CONTEXT_WINDOW?.trim();
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_DECLARED_CONTEXT_WINDOW_TOKENS ||
      parsed > MAX_DECLARED_CONTEXT_WINDOW_TOKENS) {
    getRuntimeLogger('context-compaction').warn('context_window_config_invalid', {
      value: raw, min: MIN_DECLARED_CONTEXT_WINDOW_TOKENS,
      max: MAX_DECLARED_CONTEXT_WINDOW_TOKENS });
    return null;
  }
  return parsed;
}

function logResolution(scope: string, capacity: ModelContextCapacity): void {
  getRuntimeLogger('context-compaction').debug('model_context_window_resolved', {
    scope, model: capacity.model, model_context_window: capacity.modelWindowTokens,
    window_source: capacity.windowSource, effective_window: capacity.effectiveWindowTokens,
    provider_call_cap: capacity.providerCallCapTokens,
    fallback_applied: capacity.fallbackApplied,
  });
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeModel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function safePortConfig(read: () => ModelPortConfig | undefined): ModelPortConfig | undefined {
  try { return read(); } catch { return undefined; }
}
