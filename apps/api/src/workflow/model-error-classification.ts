/**
 * 模型调用失败的分类词表（单一来源）。
 *
 * 连接验证（model-port-verify）与运行期账本（model-call-recorder）共用同一套
 * Provider 失败分类，这样 `model_calls.error_kind` 与 `error_category` 可聚合，
 * 不再一处写 6 类、一处只写 `error.name`。
 *
 * 借鉴 deepseek-harness 的错误码体系（.research/upstream/deepseek-harness/packages/llm/llm/src/error.ts）：
 * 分类只依赖 HTTP 状态与传输层特征，不解析自由文本；无法归因给 Provider 的失败
 * 返回 undefined，由调用方保留 Relay 自身的错误名（预算、工具拒绝、语义解析等
 * 不是 Provider 故障，套用 AUTH/RATE_LIMIT 会误导排查）。
 */

export type ModelErrorCategory =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'STREAM_BROKEN'
  | 'PROTOCOL'
  | 'NETWORK';

export const MODEL_ERROR_CATEGORIES: readonly ModelErrorCategory[] = [
  'AUTH', 'RATE_LIMIT', 'TIMEOUT', 'STREAM_BROKEN', 'PROTOCOL', 'NETWORK',
];

const ENDPOINT_POLICY_MARKERS = [
  'MODEL_ENDPOINT_NOT_ALLOWED', 'MODEL_ENDPOINT_NOT_PUBLIC', 'MODEL_ENDPOINT_REDIRECTED',
] as const;

const TRANSPORT_MARKERS = [
  'fetch failed', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
] as const;

/**
 * 把一次失败归因到 Provider 传输层类别；无法归因时返回 undefined。
 * 沿 cause 链检查，覆盖 undici 把真实原因包在 `TypeError: fetch failed` 里的形态。
 */
export function classifyProviderError(error: unknown): ModelErrorCategory | undefined {
  for (const current of errorChain(error)) {
    const category = classifyOne(current);
    if (category !== undefined) return category;
  }
  return undefined;
}

/** 无法归因时按协议错误收口，供需要封闭词表的调用方（连接验证响应）使用。 */
export function classifyProviderErrorOrProtocol(error: unknown): ModelErrorCategory {
  return classifyProviderError(error) ?? 'PROTOCOL';
}

export function categoryOfProviderStatus(status: number): ModelErrorCategory {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 404 || status === 422) return 'PROTOCOL';
  if (status >= 500) return 'NETWORK';
  return 'PROTOCOL';
}

export function readProviderHttpStatus(error: unknown): number | undefined {
  for (const current of errorChain(error)) {
    if (typeof current !== 'object' || current === null) continue;
    const candidate = current as { status?: unknown; statusCode?: unknown };
    const value = typeof candidate.status === 'number' ? candidate.status
      : typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value < 600) {
      return value;
    }
  }
  return undefined;
}

function classifyOne(error: unknown): ModelErrorCategory | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, message, category } = error as {
    name?: unknown; message?: unknown; category?: unknown;
  };
  if (typeof category === 'string' &&
      (MODEL_ERROR_CATEGORIES as readonly string[]).includes(category)) {
    return category as ModelErrorCategory;
  }
  const text = `${typeof message === 'string' ? message : ''}`;
  if (name === 'ModelTimeoutError' || name === 'TimeoutError' || name === 'AbortError') {
    return 'TIMEOUT';
  }
  if (name === 'MODEL_STREAM_INCOMPLETE' || text.includes('MODEL_STREAM_INCOMPLETE') ||
      text.includes('MODEL_SSE_LINE_TOO_LARGE')) {
    return 'STREAM_BROKEN';
  }
  if (ENDPOINT_POLICY_MARKERS.some((marker) => text.includes(marker))) return 'NETWORK';
  const status = readProviderHttpStatus(error);
  if (status !== undefined) return categoryOfProviderStatus(status);
  if (TRANSPORT_MARKERS.some((marker) => text.includes(marker))) {
    return 'NETWORK';
  }
  return undefined;
}

/** 有限深度展开 cause / AggregateError，避免构造环时无限递归。 */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) &&
      chain.length < 8) {
    seen.add(current);
    chain.push(current);
    if (typeof current !== 'object') break;
    const next = (current as { cause?: unknown }).cause;
    current = Array.isArray(next) ? next[0] : next;
  }
  return chain;
}

/**
 * 路由停因的归因（2026-10-30）。
 *
 * `assist-free-model-routing` 停下来时抛的是**字符串停因**（普通 Error），而
 * `classifyProviderError` 只读 name / status / 传输标记，读不到这种 message —— runner
 * 的 catch 只能把 429、账户额度耗尽、候选耗尽一起写成 MODEL_FAILED，消息行上再也
 * 分不出来。截图里那条 MODEL_FAILED / 429 就是这样产生的。
 *
 * 这里只做一件事：把已知停因码映射成可聚合的原因，并给出它是否属于 Provider 侧。
 * 不认识的码一律返回 undefined：不做前缀匹配，也不把内部缺陷冒充成上游故障。
 */
export type ModelRoutingStopReason =
  | 'PROVIDER_RATE_LIMIT'
  | 'ACCOUNT_QUOTA_EXHAUSTED'
  | 'ACCOUNT_QUOTA_UNKNOWN'
  | 'CANDIDATES_EXHAUSTED'
  | 'CANDIDATE_UNAVAILABLE'
  | 'CANDIDATE_STATE_LOST'
  | 'CALL_OUTCOME_UNKNOWN'
  | 'SNAPSHOT_INVALID';

export interface ModelRoutingStop {
  readonly reason: ModelRoutingStopReason;
  /** 只有限流与额度两类写入 provider_error_kind；其余保持 undefined。 */
  readonly providerErrorKind: ModelErrorCategory | undefined;
}

const ROUTING_STOP_REASONS: Readonly<Record<string, ModelRoutingStopReason>> = {
  ASSIST_MODEL_ACCOUNT_QUOTA_EXHAUSTED: 'ACCOUNT_QUOTA_EXHAUSTED',
  ASSIST_MODEL_ACCOUNT_QUOTA_UNKNOWN: 'ACCOUNT_QUOTA_UNKNOWN',
  ASSIST_MODEL_ACCOUNT_COOLDOWN: 'PROVIDER_RATE_LIMIT',
  ASSIST_MODEL_FREE_MODEL_COOLDOWN: 'PROVIDER_RATE_LIMIT',
  ASSIST_FREE_MODEL_COOLDOWN: 'PROVIDER_RATE_LIMIT',
  ASSIST_FREE_MODEL_CANDIDATES_EXHAUSTED: 'CANDIDATES_EXHAUSTED',
  ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE: 'CANDIDATE_UNAVAILABLE',
  ASSIST_MODEL_CANDIDATE_NO_LONGER_ELIGIBLE: 'CANDIDATE_UNAVAILABLE',
  ASSIST_MODEL_CANDIDATE_CAS_LOST: 'CANDIDATE_STATE_LOST',
  ASSIST_MODEL_CALL_CAS_LOST: 'CANDIDATE_STATE_LOST',
  ASSIST_MODEL_CALL_OUTCOME_UNKNOWN: 'CALL_OUTCOME_UNKNOWN',
  ASSIST_MODEL_SNAPSHOT_MISSING: 'SNAPSHOT_INVALID',
  ASSIST_MODEL_SNAPSHOT_INVALID: 'SNAPSHOT_INVALID',
};

/** 停因码 → 原因与 Provider 归类；只认精确码，不做模糊匹配。 */
export function classifyRoutingStop(error: unknown): ModelRoutingStop | undefined {
  if (!(error instanceof Error)) return undefined;
  const reason = ROUTING_STOP_REASONS[error.message];
  if (reason === undefined) return undefined;
  // 2026-10-30 二修：候选耗尽是「本地可选模型用完了」，不等于上游限流。只有明确的
  // 限流与账户额度两类才写 Provider 归类；候选耗尽保留自己的 reason，避免把所有
  // 缺模型的情况都聚合到 RATE_LIMIT 里，让告警与排查同时失真。
  const providerErrorKind: ModelErrorCategory | undefined =
    reason === 'PROVIDER_RATE_LIMIT' || reason === 'ACCOUNT_QUOTA_EXHAUSTED' ||
      reason === 'ACCOUNT_QUOTA_UNKNOWN'
      ? 'RATE_LIMIT' : undefined;
  return { reason, providerErrorKind };
}
