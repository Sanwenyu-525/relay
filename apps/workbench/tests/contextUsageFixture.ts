import type { RelayContextCompaction } from "../src/api/dtos/assist";

/**
 * 上下文压缩投影的测试夹具（0162 / 0165）。
 *
 * 默认是一份「1M 模型 + 1M 目标容量 + 默认 350K 阈值 + 当前 280K」的正常读数：
 * 模型真实窗口、实际可用窗口、用户阈值与生效阈值四件事都能区分开，
 * 「还有 70K 才压缩」也一眼可算。用例只覆盖需要变化的那几项，
 * 避免每个 spec 各自抄一份 20 字段的对象。
 */
export function contextCompactionFixture(
  overrides: Partial<RelayContextCompaction> = {},
): RelayContextCompaction {
  return { enabled: true, thresholdTokens: null, defaultThresholdTokens: 350_000,
    recommended: { min: 256_000, max: 400_000 }, requestedThresholdTokens: 350_000,
    effectiveThresholdTokens: 350_000, thresholdClamped: false, targetWindowTokens: 1_000_000,
    modelWindowTokens: 1_000_000, windowSource: "MODEL_CATALOG",
    providerCallCapTokens: 1_000_000, fallbackApplied: false, effectiveWindowTokens: 1_000_000,
    outputReserveTokens: 8_192, protocolOverheadTokens: 8_192, safetyReserveTokens: 50_000,
    safeInputTokens: 933_616, postCompactionTargetTokens: 100_000, contextTokens: 280_000,
    contextSource: "PROVIDER_USAGE", distanceTokens: 70_000, active: null, lastResult: null,
    ...overrides };
}

/**
 * 同一份压缩投影的线上形状（snake_case）。
 *
 * 伪造 `/context-usage` 响应的用例必须用它，不能把 DTO 直接塞进 `json()`：
 * 解析器只认服务端的 `window_source` 等字段，camelCase 夹具会被读成缺字段。
 */
export function contextCompactionWireFixture(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const value = contextCompactionFixture();
  return {
    enabled: value.enabled,
    threshold_tokens: value.thresholdTokens,
    default_threshold_tokens: value.defaultThresholdTokens,
    recommended: { min: value.recommended.min, max: value.recommended.max },
    requested_threshold_tokens: value.requestedThresholdTokens,
    effective_threshold_tokens: value.effectiveThresholdTokens,
    threshold_clamped: value.thresholdClamped,
    target_window_tokens: value.targetWindowTokens,
    model_window_tokens: value.modelWindowTokens,
    window_source: value.windowSource,
    provider_call_cap_tokens: value.providerCallCapTokens,
    fallback_applied: value.fallbackApplied,
    effective_window_tokens: value.effectiveWindowTokens,
    output_reserve_tokens: value.outputReserveTokens,
    protocol_overhead_tokens: value.protocolOverheadTokens,
    safety_reserve_tokens: value.safetyReserveTokens,
    safe_input_tokens: value.safeInputTokens,
    post_compaction_target_tokens: value.postCompactionTargetTokens,
    context_tokens: value.contextTokens,
    context_source: value.contextSource,
    distance_tokens: value.distanceTokens,
    active: value.active === null ? null : {
      request_id: value.active.requestId,
      status: value.active.status,
      trigger: value.active.trigger,
    },
    last_result: value.lastResult === null ? null : {
      request_id: value.lastResult.requestId,
      reason: value.lastResult.reason,
      trigger: value.lastResult.trigger,
      status: value.lastResult.status,
      error_code: value.lastResult.errorCode,
      through_seq: value.lastResult.throughSeq,
      tokens_before: value.lastResult.tokensBefore,
      tokens_after: value.lastResult.tokensAfter,
      budget_unmet: value.lastResult.budgetUnmet,
      safe_input_tokens: value.lastResult.safeInputTokens,
      at: value.lastResult.at,
    },
    ...overrides,
  };
}
