import type { AssistSessionRow, SessionModelSelectionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { getRuntimeLogger } from '../infrastructure/runtime-log.js';
import type { Repositories } from './unit-of-work.js';
import { estimateTokens } from './assist-context-usage.js';
import { readModelPortConfig, readOpenRouterModelPortConfig } from '../workflow/model-port-config.js';

/**
 * 上下文压缩策略（0162，2026-11-12）。
 *
 * 这一层只做**纯算术与读数**，不写库、不调模型、不改消息：
 *   · 产品目标窗口是 1M，但 1M 不是所有模型的真实能力。模型真实窗口优先；
 *     读不到时按会话自己的档位（`assist_sessions.context_budget_tokens`）估算，
 *     并如实标记 `window_source`——不假定、不虚报。
 *   · 自动压缩阈值是**用户可配置的 token 数**（默认 350K）。它必须给输出、工具/
 *     协议开销与安全预留让路，并且要早于硬上限发生（安全输入上限的 90%），因此
 *     生效值 = min(用户阈值, 安全输入上限 × 0.9)；收敛时由界面明说，不静默使用无效配置。
 *   · 推荐区间 256K–400K 只是提示，不参与任何判定。
 *
 * 判定与执行分开：这里给出「该不该压、按什么阈值压」，`assist-memory.ts` 负责
 * 幂等请求、重排队与并发闸门，`assist-memory-runner.ts` 负责真实外呼与发布。
 */

/** 产品目标窗口（2026-11-12 用户口径）。它是默认档位的来源，不是所有模型的真实窗口。 */
export const CONTEXT_WINDOW_TARGET_TOKENS = 1_000_000;
/** 默认自动压缩阈值。 */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 350_000;
/** 推荐区间：只用于界面提示，不强制。 */
export const COMPACTION_THRESHOLD_RECOMMENDED = Object.freeze({ min: 256_000, max: 400_000 });
/** 阈值可保存范围：下限避免「每轮都压」，上限就是产品目标窗口。 */
export const COMPACTION_THRESHOLD_BOUNDS = Object.freeze({
  min: 16_384, max: CONTEXT_WINDOW_TARGET_TOKENS });
/** 压缩后的目标规模；实际取 `min(该值, 生效阈值的一半)`，避免小窗口追求不现实的目标。 */
export const POST_COMPACTION_TARGET_TOKENS = 100_000;
/**
 * 工具声明与协议信封的固定预留（tokens）。
 *
 * 它是估算而不是实测：一轮请求里工具规格、JSON 信封与角色分隔没有独立的计量口径。
 * 取值覆盖当前只读词表（十余个工具）与常见协议开销；它不随模型变化，也不参与
 * 「模型是否装得下」的结论——那是 Provider 窗口的事。
 */
export const CONTEXT_PROTOCOL_OVERHEAD_TOKENS = 8_192;
/** 安全预留比例：在输出与协议开销之外，再给下一轮留出余量。 */
export const CONTEXT_SAFETY_RESERVE_RATIO = 0.05;
/**
 * 生效阈值最多占安全输入上限的比例。
 *
 * 为什么不是 100%：阈值与「硬上限」必须留出可观察的间隔，否则「自动压缩」和
 * 「溢出保护」会在同一个数上同时成立——小窗口的默认 350K 一收敛就直接等于硬上限，
 * 用户永远看不到「到阈值先整理」这一步。留 10% 让自动压缩先发生；真正跳过阈值的
 * 情况（例如单条巨大输入）仍由溢出保护兜住。
 */
export const COMPACTION_TRIGGER_MARGIN_RATIO = 0.9;
/** 读不到模型配置时的输出预留（与会话档位解耦，保守取值）。 */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;

export type ContextWindowSource = 'MODEL_CATALOG' | 'SESSION_TIER';
export type CompactionTrigger = 'MANUAL' | 'THRESHOLD' | 'OVERFLOW';

export interface ContextCompactionPolicyInput {
  /** 会话档位：这一次调用最多申请多少（256K / 512K / 1M）。 */
  readonly targetWindowTokens: number;
  /** Provider 声明的真实窗口；null = 未知（不当作无限）。 */
  readonly modelWindowTokens: number | null;
  /** 模型配置里的最大输出预留。 */
  readonly outputReserveTokens?: number;
  readonly protocolOverheadTokens?: number;
  readonly safetyReserveRatio?: number;
  /** 用户保存的阈值；null = 使用产品默认。 */
  readonly userThresholdTokens: number | null;
}

export interface ContextCompactionPolicy {
  readonly targetWindowTokens: number;
  readonly modelWindowTokens: number | null;
  readonly windowSource: ContextWindowSource;
  /** min(档位, 真实窗口)：这次调用实际可用的窗口。 */
  readonly effectiveWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly protocolOverheadTokens: number;
  readonly safetyReserveTokens: number;
  /** 扣掉输出、协议与安全预留之后的输入上限。 */
  readonly safeInputTokens: number;
  readonly defaultThresholdTokens: number;
  readonly userThresholdTokens: number | null;
  /** 用户真正要求的阈值（没有设置时就是默认值）。 */
  readonly requestedThresholdTokens: number;
  /** 实际生效的阈值：不会超过安全输入上限的 90%（留给自动压缩先于硬上限发生）。 */
  readonly effectiveThresholdTokens: number;
  /** 生效阈值因模型窗口/输出预留被下调。 */
  readonly thresholdClamped: boolean;
  readonly postCompactionTargetTokens: number;
}

/**
 * 计算一次会话的压缩策略。
 *
 * 三条不可让步的口径：
 *   1. `effectiveWindow = min(档位, 真实窗口)`——档位高于 Provider 窗口时按窗口截断，
 *      与 `planAssistModelBudget` 的冻结口径一致；
 *   2. 安全输入上限必须先扣掉**输出预留**（端口的外呼前闸门是
 *      `estimatedInput + maxOutput <= callLimit`），再扣协议开销与安全预留；
 *   3. 生效阈值只能 ≤ 安全输入上限 × 0.9。用户把阈值设得比模型装得下的还大时，
 *      不是「按用户值硬发」，而是收敛并让界面说明。
 */
export function planContextCompaction(input: ContextCompactionPolicyInput): ContextCompactionPolicy {
  const outputReserveTokens = Math.max(0, Math.floor(input.outputReserveTokens ??
    DEFAULT_OUTPUT_RESERVE_TOKENS));
  const protocolOverheadTokens = Math.max(0, Math.floor(input.protocolOverheadTokens ??
    CONTEXT_PROTOCOL_OVERHEAD_TOKENS));
  const safetyReserveRatio = clampRatio(input.safetyReserveRatio ?? CONTEXT_SAFETY_RESERVE_RATIO);
  const targetWindowTokens = Math.max(1, Math.floor(input.targetWindowTokens));
  const modelWindowTokens = input.modelWindowTokens === null ||
    !Number.isFinite(input.modelWindowTokens) || input.modelWindowTokens <= 0
    ? null : Math.floor(input.modelWindowTokens);
  const effectiveWindowTokens = modelWindowTokens === null
    ? targetWindowTokens : Math.min(targetWindowTokens, modelWindowTokens);
  const safetyReserveTokens = Math.ceil(effectiveWindowTokens * safetyReserveRatio);
  // 上限至少留 1：极小窗口下也不能算出 0 或负数，否则任何请求都会被判「必须压缩」。
  const safeInputTokens = Math.max(1, effectiveWindowTokens - outputReserveTokens -
    protocolOverheadTokens - safetyReserveTokens);
  const userThresholdTokens = normalizeThreshold(input.userThresholdTokens);
  const requestedThresholdTokens = userThresholdTokens ?? DEFAULT_COMPACTION_THRESHOLD_TOKENS;
  // 自动触发必须早于硬上限：见 COMPACTION_TRIGGER_MARGIN_RATIO 的说明。
  const triggerCeilingTokens = Math.max(1, Math.floor(safeInputTokens * COMPACTION_TRIGGER_MARGIN_RATIO));
  const effectiveThresholdTokens = Math.max(1, Math.min(requestedThresholdTokens, triggerCeilingTokens));
  return {
    targetWindowTokens,
    modelWindowTokens,
    windowSource: modelWindowTokens === null ? 'SESSION_TIER' : 'MODEL_CATALOG',
    effectiveWindowTokens,
    outputReserveTokens,
    protocolOverheadTokens,
    safetyReserveTokens,
    safeInputTokens,
    defaultThresholdTokens: DEFAULT_COMPACTION_THRESHOLD_TOKENS,
    userThresholdTokens,
    requestedThresholdTokens,
    effectiveThresholdTokens,
    thresholdClamped: effectiveThresholdTokens < requestedThresholdTokens,
    postCompactionTargetTokens: Math.max(1, Math.min(POST_COMPACTION_TARGET_TOKENS,
      Math.floor(effectiveThresholdTokens / 2))),
  };
}

/** 保存值的合法化：只接受可保存范围内的整数；其余一律视为「没有设置」。 */
export function normalizeThreshold(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value < COMPACTION_THRESHOLD_BOUNDS.min || value > COMPACTION_THRESHOLD_BOUNDS.max) return null;
  return value;
}

/** 边界校验的明确结论：值不合法时给出可执行的说明，不静默改成默认值。 */
export function validateThreshold(value: unknown): { ok: true; value: number | null } |
{ ok: false; message: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return { ok: false, message: '压缩阈值必须是整数 tokens（或留空表示使用默认 350,000）。' };
  }
  if (value < COMPACTION_THRESHOLD_BOUNDS.min || value > COMPACTION_THRESHOLD_BOUNDS.max) {
    return { ok: false, message:
      `压缩阈值必须在 ${COMPACTION_THRESHOLD_BOUNDS.min.toLocaleString()}–`
      + `${COMPACTION_THRESHOLD_BOUNDS.max.toLocaleString()} tokens 之间；`
      + `超出当前模型安全上限的值可以保存，但生效时会按窗口收敛。` };
  }
  return { ok: true, value };
}

export interface ContextCompactionDecision {
  readonly action: 'NONE' | 'COMPACT';
  readonly trigger: 'THRESHOLD' | 'OVERFLOW' | null;
  /** 距离生效阈值还有多少 tokens；已超过时为负。 */
  readonly distanceTokens: number;
  /** 当前上下文已经触及安全输入上限，必须处理。 */
  readonly overflow: boolean;
}

/**
 * 请求前的统一判定。
 *
 *   · 达到生效阈值且自动压缩开启 → `THRESHOLD`；
 *   · 触及安全输入上限 → `OVERFLOW`，**不受自动压缩开关影响**。用户关掉的是
 *     「普通的到阈值就压」，不是「允许发出装不下的请求」；溢出保护只做安全压缩，
 *     压不动时由调用方明确中止并说明，不静默丢消息；
 *   · 其余情况 → `NONE`。
 *
 * 同一请求不会重复触发：调用方在真正发起前还有 `activeRequest` 幂等闸门与
 * 「上一条自动请求未完成不重试」的守卫（`assist-memory.ts`）。
 */
export function decideContextCompaction(input: { readonly policy: ContextCompactionPolicy;
  readonly tokens: number; readonly automaticCompaction: boolean }): ContextCompactionDecision {
  const tokens = Math.max(0, Math.floor(input.tokens));
  const distanceTokens = input.policy.effectiveThresholdTokens - tokens;
  const overflow = tokens >= input.policy.safeInputTokens;
  if (overflow) return { action: 'COMPACT', trigger: 'OVERFLOW', distanceTokens, overflow };
  if (input.automaticCompaction && tokens >= input.policy.effectiveThresholdTokens) {
    return { action: 'COMPACT', trigger: 'THRESHOLD', distanceTokens, overflow };
  }
  return { action: 'NONE', trigger: null, distanceTokens, overflow };
}

/** 一次「当前上下文有多少」的读数。 */
export interface ContextTokenMeasurement {
  readonly tokens: number;
  /**
   * `PROVIDER_USAGE`——基线来自 Provider 真实上报的 `input_tokens`，只对之后新增的
   * 消息按文本字节估算；`ESTIMATED`——还没有真实调用，整份窗口按文本估算。
   *
   * 两种都不是分词器的精确结果，但前者不含「把整段历史重新估一遍」的系统性偏差，
   * 因此界面对两者分别标注，不把估算说成实测。
   */
  readonly source: 'PROVIDER_USAGE' | 'ESTIMATED';
  readonly baselineInputTokens: number | null;
  readonly deltaTokens: number;
  readonly deltaMessages: number;
}

/**
 * 读当前上下文规模（用于压缩判定与用量面板）。
 *
 * 口径：最近一次已结算 PRIMARY 调用的真实输入量 + 它之后新增的终结消息。
 * 基线已经包含 system、工具声明与当时的历史，所以新增部分只需要补消息正文。
 * 没有真实调用时退回归一化估算：压缩摘要 + 工作窗口原文。
 *
 * 判定处还会与「装配后的请求字节估算」取较大值（见 `assist-memory.ts`）：
 * 资料正文这类还没写进历史行的注入内容，只有装配方知道它有多大。
 */
export async function measureSessionContextTokens(r: Repositories, session: AssistSessionRow):
Promise<ContextTokenMeasurement> {
  const baseline = await r.assist.latestPrimaryUsageBaseline(session.id);
  const state = await r.assistMemory.state(session.id);
  const checkpoint = state?.checkpoint_id == null ? undefined
    : await r.assistMemory.checkpoint(state.checkpoint_id);
  /*
   * 基线只在不早于当前摘要时有效：压缩会把「几百 K 的原文窗口」换成「摘要 + 最近原文」，
   * 而基线描述的是压缩前那次调用的输入。继续用它加增量，会让压缩后的读数原地不动，
   * 用户看不到整理的效果。此时退回归一化估算（摘要 + 当前原文），并如实标 ESTIMATED。
   */
  if (baseline !== undefined && baseline.settled_at !== null &&
      (checkpoint === undefined || checkpoint.created_at <= baseline.settled_at)) {
    // 基线调用的输入包含到「触发它的那条 user 消息」为止，**不包含**它自己生成的回复；
    // 下一次请求会带上那条回复，所以增量从 baseline.seq 起算（`seq > seq-1`）。
    const delta = await r.assistMemory.contentBytesSince(session.id, baseline.seq - 1n);
    const deltaTokens = estimateTokens(delta.bytes);
    return { tokens: baseline.input_tokens + deltaTokens, source: 'PROVIDER_USAGE',
      baselineInputTokens: baseline.input_tokens, deltaTokens, deltaMessages: delta.count };
  }
  const after = checkpoint?.through_seq ?? state?.cleared_through_seq ?? 0n;
  const delta = await r.assistMemory.contentBytesSince(session.id, after);
  const summaryBytes = checkpoint === undefined ? 0 : Buffer.byteLength(checkpoint.summary, 'utf8');
  const deltaTokens = estimateTokens(delta.bytes + summaryBytes);
  return { tokens: deltaTokens, source: 'ESTIMATED', baselineInputTokens: null,
    deltaTokens, deltaMessages: delta.count };
}

/**
 * 会话当前生效模型的真实容量读数。
 *
 * 只读、不冻结、不触发目录同步：它回答「按现在的选择，模型支持多大窗口、留多少输出」，
 * 真正能不能用仍由冻结快照与外呼前闸门决定。读不到配置/目录/连接时返回 null 字段，
 * 由策略退回到会话档位——不猜一个窗口出来。
 *
 * `workspaceId` 必须显式传入：注册连接的仓储按工作区隔离，而 `Repositories` 本身不带
 * 「当前工作区」。调用方本来就有会话行，工作区是会话的事实，不需要再查一次。
 */
export async function readSessionModelCapacity(r: Repositories, workspaceId: string,
  selection: SessionModelSelectionRow | undefined, env: NodeJS.ProcessEnv): Promise<{
  readonly model: string | null;
  readonly modelWindowTokens: number | null;
  readonly outputReserveTokens: number | null }> {
  if (selection === undefined) {
    const config = safePortConfig(() => readModelPortConfig(env));
    if (config === undefined) return { model: null, modelWindowTokens: null,
      outputReserveTokens: null };
    return { model: config.model,
      modelWindowTokens: await safeCatalogWindow(r, config.model),
      outputReserveTokens: config.maxOutputTokens };
  }
  if (selection.connection === 'default') {
    const config = safePortConfig(() => readModelPortConfig(env));
    return { model: selection.model,
      modelWindowTokens: await safeCatalogWindow(r, selection.model),
      outputReserveTokens: config?.maxOutputTokens ?? null };
  }
  if (selection.connection === 'registered') {
    const row = selection.connection_id === null ? undefined
      : await r.modelConnections.read(workspaceId, selection.connection_id).catch(() => undefined);
    return { model: selection.model,
      modelWindowTokens: await safeCatalogWindow(r, selection.model),
      outputReserveTokens: row?.max_output_tokens ?? null };
  }
  const config = safePortConfig(() => readOpenRouterModelPortConfig(env, selection.model));
  return { model: selection.model,
    modelWindowTokens: await safeCatalogWindow(r, selection.model),
    outputReserveTokens: config?.maxOutputTokens ?? null };
}

/**
 * 会话的策略 + 当前读数，供压缩判定与用量投影共用。
 */
export async function resolveSessionCompactionPolicy(r: Repositories, session: AssistSessionRow,
  env: NodeJS.ProcessEnv): Promise<{ readonly policy: ContextCompactionPolicy;
    readonly automaticCompaction: boolean; readonly model: string | null }> {
  const settings = await r.information.readMemorySettings(session.workspace_id);
  const selection = await r.modelSelection.readForSession(session.id);
  const capacity = await readSessionModelCapacity(r, session.workspace_id, selection, env);
  const policy = planContextCompaction({
    targetWindowTokens: session.context_budget_tokens,
    modelWindowTokens: capacity.modelWindowTokens,
    ...(capacity.outputReserveTokens === null ? {}
      : { outputReserveTokens: capacity.outputReserveTokens }),
    userThresholdTokens: settings?.compaction_threshold_tokens ?? null,
  });
  return { policy, automaticCompaction: settings?.automatic_compaction !== false,
    model: capacity.model };
}

/** 目录窗口读不到就是未知；异常不升级成业务失败。 */
async function safeCatalogWindow(r: Repositories, model: string | null): Promise<number | null> {
  if (model === null || model.trim() === '') return null;
  try {
    const entry = await r.modelCatalog.readEntryBySourceModelId(model);
    return entry?.context_window ?? null;
  } catch (error) {
    getRuntimeLogger('context-compaction').warn('context_window_lookup_failed', {
      model, error });
    return null;
  }
}

function safePortConfig(read: () => { maxOutputTokens: number; model: string } | undefined):
{ maxOutputTokens: number; model: string } | undefined {
  try { return read(); } catch { return undefined; }
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return CONTEXT_SAFETY_RESERVE_RATIO;
  return Math.min(0.5, Math.max(0, value));
}

/**
 * 从压缩请求的 `model_snapshot.memory_compaction` 读触发方式与前后读数。
 *
 * 请求行只区分 MANUAL/AUTO（0119 的 CHECK），触发方式（到阈值 / 溢出保护）是
 * 0162 新增的**派生元数据**，放在同一份快照里而不是再加一列：它解释这次请求
 * 为什么发生，不构成新的业务事实或闸门。旧行没有这些键时按 reason 推回：
 * AUTO → THRESHOLD，MANUAL → MANUAL。
 */
export function readCompactionAudit(row: { readonly reason: 'MANUAL' | 'AUTO';
  readonly model_snapshot: JsonObject }): { readonly trigger: CompactionTrigger;
  readonly tokensBefore: number | null; readonly tokensAfter: number | null;
  readonly thresholdTokens: number | null; readonly windowTokens: number | null;
  /** 判定时冻结的安全输入上限与压缩后目标：完成后据此复核「预算是否真的够了」。 */
  readonly safeInputTokens: number | null; readonly postCompactionTargetTokens: number | null;
  /** 这次压缩用的是哪个模型（派生的可读元数据，不是新的业务事实或闸门）。 */
  readonly model: string | null } {
  const raw = row.model_snapshot.memory_compaction;
  const object = isJsonObject(raw) ? raw : {};
  const trigger = object.trigger === 'OVERFLOW' || object.trigger === 'THRESHOLD' ||
    object.trigger === 'MANUAL'
    ? object.trigger : (row.reason === 'AUTO' ? 'THRESHOLD' : 'MANUAL');
  return { trigger,
    tokensBefore: positiveInteger(object.tokens_before),
    // 压后规模允许为 0（例如只剩空摘要的窗口）；0 是读数，不是「没有读数」。
    tokensAfter: nonNegativeInteger(object.tokens_after),
    thresholdTokens: positiveInteger(object.threshold_tokens),
    windowTokens: positiveInteger(object.window_tokens),
    safeInputTokens: positiveInteger(object.safe_input_tokens),
    postCompactionTargetTokens: positiveInteger(object.post_compaction_target_tokens),
    model: typeof object.model === 'string' && object.model.trim() !== ''
      ? object.model : null };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
