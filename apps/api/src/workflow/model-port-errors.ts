import type { ModelUsage } from './fake-model-port.js';

/**
 * 模型端口的协议无关失败类型（MODEL-SETTINGS-03）。
 *
 * 这些错误不是某个 SDK 的产物，而是「一次外呼越过了预算 / 超时 / 输出协议」的事实。
 * 应用层按 `instanceof` 把它们映射成消息失败码（见 `assistant-readonly-round`），
 * 因此两种协议必须抛**同一组类**——各自复制一份会让 Anthropic 连接上的预算耗尽
 * 退化成裸 MODEL_FAILED。
 */

export class ModelCallBudgetError extends Error {
  override readonly name = 'ModelCallBudgetError';
  constructor(readonly providerRequestId = '',
    readonly usage?: ModelUsage) {
    super('model call exceeds configured token budget');
  }
}

export class ModelSourcePolicyError extends Error {
  override readonly name = 'ModelSourcePolicyError';
  constructor() { super('recent fallback material requires explicit source selection'); }
}

export class ModelOutputBudgetError extends Error {
  override readonly name = 'ModelOutputBudgetError';
  constructor(readonly providerRequestId: string, readonly usage: ModelUsage) {
    super('model output exceeds the configured bound');
  }
}

export class ModelTimeoutError extends Error {
  override readonly name = 'ModelTimeoutError';
  constructor() { super('model call timed out'); }
}

export class ModelToolOutputError extends Error {
  override readonly name = 'ModelToolOutputError';
  constructor(readonly providerRequestId?: string, readonly usage?: ModelUsage) {
    super('model returned an unsupported tool or content block');
  }
}

/** A response arrived and may be billable even though its verdict was invalid.
 * Keep only request/usage metadata; the raw response is never logged. */
export class SemanticResponseError extends Error {
  override readonly name = 'SemanticResponseError';
  constructor(readonly providerRequestId: string, readonly usage: ModelUsage) {
    super('semantic verdict is not a valid JSON verdict');
  }
}

/**
 * 协议明确不支持某项能力（不静默降级）。
 *
 * 例如 Anthropic Messages 没有 OpenAI 的 `response_format: json_object`：要么声明支持并
 * 真的注入等价约束，要么在**外呼之前**拒绝。这里选后者：请求不会被发出去，调用方看到
 * 一个可诊断的错误，而不是「请求发出去了、格式约束其实没生效」。
 */
export class ModelCapabilityUnsupportedError extends Error {
  override readonly name = 'ModelCapabilityUnsupportedError';
  constructor(readonly capability: string,
    detail: string) {
    super(`MODEL_CAPABILITY_UNSUPPORTED: ${detail}`);
  }
}

export function isAbortByName(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
