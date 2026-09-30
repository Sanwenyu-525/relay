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
