/**
 * 免费模型目录的严格价格判定与能力解析（专项阶段 B，测试 FM-01）。
 *
 * 规则（roadmap §9.1 / runtime §8.6）：OpenRouter 官方目录要求文本输入/输出计价项
 * （prompt / completion）为**合法零值**；可选 request 项若来源声明也必须是合法零值。
 * 缺失 prompt/completion、非法、负数、
 * 极小非零、来源新增且非零的未知收费项都不能判免费；仅名称带 `:free` 不足以入选。
 *
 * 关键约束：价格用**字符串精确判零**，绝不 `parseFloat` 后与 0 比较——浮点舍入会把
 * `0.0000000001` 这类极小非零误判为零。未知（MISSING/能力字段缺失）与确认非零分开，
 * 缺值不默认零。
 */

export type PriceParse =
  | { readonly kind: 'ZERO' }
  | { readonly kind: 'NONZERO' }
  | { readonly kind: 'NEGATIVE' }
  | { readonly kind: 'MISSING' }
  | { readonly kind: 'INVALID' };

export type NotFreeReason =
  | 'MISSING_PRICE'
  | 'INVALID_PRICE'
  | 'NEGATIVE_PRICE'
  | 'NONZERO_PRICE'
  | 'UNKNOWN_BILLABLE_ITEM';

export interface FreeDecision {
  readonly isFree: boolean;
  readonly reason: NotFreeReason | null;
}

/** OpenRouter /models 目录必需的文本计价项；request 是可选字段，见下方单独校验。 */
export const REQUIRED_CHAT_PRICE_KEYS = ['prompt', 'completion'] as const;

/**
 * 已知计价键：这些项要么属于文本调用，要么是媒体/搜索等本批**未启用**、
 * 因而不会由本次文本调用触发的能力。对它们**不因非零而拒绝文本免费**，但不会据此宣称可用。
 * 出现在此集合之外且非零的键，视为「无法确认为零的未知收费项」，保守拒绝（UNKNOWN_BILLABLE_ITEM）。
 */
const KNOWN_PRICE_KEYS: ReadonlySet<string> = new Set([
  'prompt', 'completion', 'request',
  'image', 'image_output', 'image_input',
  'audio', 'audio_input', 'audio_output', 'video', 'video_output', 'search', 'web_search',
]);

// 合法十进制或科学计数（可带正负号）。不接受非字符串，避免把 JSON number 的浮点值当成价格真相。
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** 解析单个价格字段。零的判定只看尾数是否含非零数字，与指数无关，杜绝极小非零被舍入为零。 */
export function parsePriceValue(raw: unknown): PriceParse {
  if (raw === undefined || raw === null) return { kind: 'MISSING' };
  if (typeof raw !== 'string') return { kind: 'INVALID' };
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'MISSING' };
  if (!NUMBER_PATTERN.test(trimmed)) return { kind: 'INVALID' };
  if (trimmed.startsWith('-')) return { kind: 'NEGATIVE' };
  const mantissa = trimmed.split(/[eE]/u)[0] ?? '';
  return /[1-9]/u.test(mantissa) ? { kind: 'NONZERO' } : { kind: 'ZERO' };
}

function missingToReason(kind: PriceParse['kind']): NotFreeReason {
  switch (kind) {
    case 'MISSING': return 'MISSING_PRICE';
    case 'INVALID': return 'INVALID_PRICE';
    case 'NEGATIVE': return 'NEGATIVE_PRICE';
    case 'NONZERO': return 'NONZERO_PRICE';
    case 'ZERO': return 'NONZERO_PRICE'; // 不会走到：调用方只在非 ZERO 时映射。
  }
}

/**
 * 判定一条目录项是否严格免费。
 * pricing 逐字保留来源的原始计价项（键→字符串单价）；这里只做规则判定，不改写原值。
 */
export function evaluateFreeEligibility(
  pricing: Readonly<Record<string, unknown>>,
): FreeDecision {
  for (const key of REQUIRED_CHAT_PRICE_KEYS) {
    const parsed = parsePriceValue(pricing[key]);
    if (parsed.kind !== 'ZERO') {
      return { isFree: false, reason: missingToReason(parsed.kind) };
    }
  }
  // OpenRouter 的 request 价格在目录协议中可省略。保留省略状态，不补写 0；如果来源
  // 明确给出该项，则必须证明为合法零值。provider.max_price.request=0 是外呼时的第二道约束。
  if (Object.hasOwn(pricing, 'request')) {
    const parsed = parsePriceValue(pricing.request);
    if (parsed.kind !== 'ZERO') {
      return { isFree: false, reason: missingToReason(parsed.kind) };
    }
  }
  // 来源新增、且不在已知能力计价集合内的键：只有**明确为零**才放行。非零、负数、非法
  // 固然要拒绝，值缺失、null 或空串同样不能判免费——「这一项没给出价格」不等于「这一项
  // 不收费」，把缺值读成零会让一个真实收费项悄悄进入免费集合。
  for (const key of Object.keys(pricing)) {
    if (key === 'prompt' || key === 'completion' || key === 'request') continue;
    if (KNOWN_PRICE_KEYS.has(key)) continue;
    const parsed = parsePriceValue(pricing[key]);
    if (parsed.kind !== 'ZERO') {
      return { isFree: false, reason: 'UNKNOWN_BILLABLE_ITEM' };
    }
  }
  return { isFree: true, reason: null };
}

export interface CatalogCapabilities {
  readonly tools: boolean | null;
  readonly structured_outputs: boolean | null;
  readonly response_format: boolean | null;
  readonly text_input: boolean | null;
  readonly text_output: boolean | null;
  /** 0093：目录来源是否声明图片输入（input_modalities 含 'image'）；null=来源未给出。 */
  readonly image_input: boolean | null;
}

/** 三态解析：true=明确具备，false=明确不具备，null=来源未给出（未知，不能冒充可用）。 */
function containsFlag(list: readonly unknown[] | undefined, flag: string): boolean | null {
  if (!Array.isArray(list)) return null;
  return list.some((item) => typeof item === 'string' && item.toLowerCase() === flag);
}

function asObject(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === 'object') ? value as Record<string, unknown> : {};
}

/**
 * 从 OpenRouter 的**整个模型对象**解析已知能力。字段缺失即标未知（null），供阶段 C 的
 * 「所需工具能力未知/不足则拒绝新调用」使用；本批不因能力缺失影响价格判定。
 *
 * **字段位置按官方真实目录结构**：`supported_parameters` 在**模型对象顶层**（与 `pricing`、
 * `context_length` 同级），`input_modalities` / `output_modalities` 才在 `architecture` 内。
 * 早期实现把 `supported_parameters` 也从 `architecture` 内取，于是「来源明确声明 tools」的
 * 受控完整条目仍得到 `tools: null`——阶段 C 的「所需工具能力未知则拒绝新调用」会把一个
 * 真正可用的免费模型误判为未知。回归 fixture 必须用真实结构，不能用错误嵌套自证能力可用。
 */
export function parseCapabilities(model: unknown): CatalogCapabilities {
  const node = asObject(model);
  const architecture = asObject(node.architecture);
  return {
    tools: containsFlag(node.supported_parameters as readonly unknown[] | undefined, 'tools'),
    structured_outputs: containsFlag(node.supported_parameters as readonly unknown[] | undefined,
      'structured_outputs'),
    response_format: containsFlag(node.supported_parameters as readonly unknown[] | undefined,
      'response_format'),
    text_input: containsFlag(architecture.input_modalities as readonly unknown[] | undefined, 'text'),
    text_output: containsFlag(architecture.output_modalities as readonly unknown[] | undefined, 'text'),
    image_input: containsFlag(architecture.input_modalities as readonly unknown[] | undefined, 'image'),
  };
}

export interface ResolvedCatalogEntry {
  readonly source_model_id: string;
  readonly display_name: string;
  readonly context_window: number | null;
  readonly pricing: Record<string, string>;
  readonly capabilities: CatalogCapabilities;
  readonly is_free: boolean;
  readonly not_free_reason: NotFreeReason | null;
}

/**
 * 把一条来源目录项解析为可入库的条目。来源对象是不可信外部数据：
 * 缺失/非法字段一律保守处理（价格缺失→非免费、上下文非法→null、名称缺失→拒绝该条）。
 * 返回 null 表示该条目连身份都不完整，应丢弃而不是入库为免费。
 */
export function resolveCatalogEntry(raw: unknown): ResolvedCatalogEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const model = raw as Record<string, unknown>;
  const sourceModelId = typeof model.id === 'string' ? model.id.trim() : '';
  if (sourceModelId === '') return null;
  const displayName = typeof model.name === 'string' && model.name.trim() !== ''
    ? model.name.trim() : sourceModelId;

  const rawPricing = (model.pricing !== null && typeof model.pricing === 'object')
    ? model.pricing as Record<string, unknown> : {};
  // 逐字保留字符串价格；非字符串计价项原样转成标记串，判定仍按 MISSING/INVALID 保守处理。
  const pricing: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawPricing)) {
    pricing[key] = typeof value === 'string' ? value : String(value);
  }

  const decision = evaluateFreeEligibility(rawPricing);

  const contextLength = model.context_length;
  const contextWindow = typeof contextLength === 'number' && Number.isInteger(contextLength)
    && contextLength >= 0 ? contextLength : null;

  return {
    source_model_id: sourceModelId,
    display_name: displayName.length > 200 ? displayName.slice(0, 200) : displayName,
    context_window: contextWindow,
    pricing,
    capabilities: parseCapabilities(model),
    is_free: decision.isFree,
    not_free_reason: decision.reason,
  };
}

/** 一份来源结果整体解析后的结论。 */
export type CatalogSnapshotResolution =
  | { readonly kind: 'OK'; readonly entries: readonly ResolvedCatalogEntry[] }
  | { readonly kind: 'INCOMPLETE'; readonly detail: string }
  | { readonly kind: 'CONFLICT'; readonly detail: string };

/**
 * 把来源返回的**整份**目录数组解析成可发布的条目集合，或给出「不能发布」的结论。
 *
 * 这一步是「非空畸形结果不得被解析成合法空目录」的执行点：空数组是**合法的空目录**
 * （如实清空可选免费集合），但**非空**输入若连一条身份完整的条目都解析不出，说明这是
 * 畸形/截断的结果，绝不能当成「目录变成空」去覆盖最近一次成功快照。
 *
 * 重复模型 ID 也不能简单取第一条：两条记录若在身份、定价、能力或免费判定上不一致，
 * 就是来源自相矛盾，无法确定该信任哪一份，必须整份拒绝（CONFLICT），而不是按数组顺序
 * 静默挑一条——静默取首见者会让结果取决于来源的内部排序，且可能把收费条目读成免费。
 * 完全一致的重复条目仍可去重（来源偶发重复不是矛盾）。
 *
 * 返回的条目按 `source_model_id` 稳定排序，便于入库顺序确定、后续候选排序可复现。
 */
export function resolveCatalogSnapshot(rawEntries: readonly unknown[]): CatalogSnapshotResolution {
  const byId = new Map<string, ResolvedCatalogEntry>();
  let malformed = 0;
  for (const item of rawEntries) {
    const entry = resolveCatalogEntry(item);
    if (entry === null) { malformed += 1; continue; }
    const existing = byId.get(entry.source_model_id);
    if (existing === undefined) { byId.set(entry.source_model_id, entry); continue; }
    if (entrySignature(existing) !== entrySignature(entry)) {
      return { kind: 'CONFLICT',
        detail: `来源对同一模型 id「${entry.source_model_id}」给出互相矛盾的记录` };
    }
  }
  if (rawEntries.length > 0 && malformed > 0) {
    // 身份不完整的条目本身就是不该出现的形状；出现即认为整份结果不可信。
    return { kind: 'INCOMPLETE',
      detail: `目录里有 ${malformed} 条身份不完整的条目（共 ${rawEntries.length} 条）` };
  }
  if (rawEntries.length > 0 && byId.size === 0) {
    return { kind: 'INCOMPLETE', detail: '非空的目录结果没有解析出任何可用条目' };
  }
  const entries = [...byId.values()].sort((a, b) =>
    a.source_model_id < b.source_model_id ? -1 : a.source_model_id > b.source_model_id ? 1 : 0);
  return { kind: 'OK', entries };
}

/** 影响「免费判定 / 展示 / 能力」的字段的规范签名；不含来源无关字段，纯用于比对两条记录是否同一事实。 */
function entrySignature(entry: ResolvedCatalogEntry): string {
  return JSON.stringify([
    entry.source_model_id, entry.display_name, entry.context_window,
    entry.is_free, entry.not_free_reason,
    Object.keys(entry.pricing).sort().map((key) => [key, entry.pricing[key] ?? '']),
    [entry.capabilities.tools, entry.capabilities.text_input,
      entry.capabilities.text_output, entry.capabilities.image_input,
      entry.capabilities.structured_outputs, entry.capabilities.response_format],
  ]);
}
