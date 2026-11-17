import type { RelayContextCompaction } from "../src/api/dtos/assist";

/** 产品目标窗口是十进制 1M；默认连接单次调用预算是 1,048,576，不是产品目标本身。 */
const PRODUCT_TARGET_TOKENS = 1_000_000;
const DEFAULT_PROVIDER_CALL_BUDGET_TOKENS = 1_048_576;

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
    effectiveThresholdTokens: 350_000, thresholdClamped: false, targetWindowTokens: PRODUCT_TARGET_TOKENS,
    modelWindowTokens: 1_000_000, windowSource: "MODEL_CATALOG",
    providerCallCapTokens: DEFAULT_PROVIDER_CALL_BUDGET_TOKENS, fallbackApplied: false,
    effectiveWindowTokens: 1_000_000,
    outputReserveTokens: 8_192, protocolOverheadTokens: 8_192, safetyReserveTokens: 50_000,
    safeInputTokens: 933_616, postCompactionTargetTokens: 100_000, contextTokens: 280_000,
    contextSource: "PROVIDER_USAGE", measuredAt: "2026-11-15T10:00:00.000Z",
    distanceTokens: 70_000, active: null, lastResult: null,
    ...overrides };
}

/**
 * 真实未知窗口的投影：模型窗口 null → UNKNOWN_FALLBACK 安全回退 262,144；
 * 默认 350K 被收敛到 209,386（safeInput 232,652 × 90%）。
 * 这一份特意把目标窗口、回退标记、预留、阈值和距离一起写全，
 * 防止只改 `modelWindowTokens: null` 却留下 1M 的 safeInput/阈值。
 */
export function unknownWindowCompactionFixture(
  overrides: Partial<RelayContextCompaction> = {},
): RelayContextCompaction {
  return contextCompactionFixture({
    targetWindowTokens: PRODUCT_TARGET_TOKENS,
    modelWindowTokens: null, windowSource: "UNKNOWN_FALLBACK",
    providerCallCapTokens: DEFAULT_PROVIDER_CALL_BUDGET_TOKENS,
    fallbackApplied: true, effectiveWindowTokens: 262_144,
    outputReserveTokens: 8_192, protocolOverheadTokens: 8_192,
    safetyReserveTokens: 13_108, safeInputTokens: 232_652,
    requestedThresholdTokens: 350_000, effectiveThresholdTokens: 209_386,
    thresholdClamped: true, postCompactionTargetTokens: 100_000,
    contextTokens: 100_000, distanceTokens: 109_386,
    ...overrides });
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
    measured_at: value.measuredAt,
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

/** 未知窗口的线上形状：字段必须与 `unknownWindowCompactionFixture` 完全同源。 */
export function unknownWindowCompactionWireFixture(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return contextCompactionWireFixture({
    target_window_tokens: PRODUCT_TARGET_TOKENS,
    model_window_tokens: null,
    window_source: "UNKNOWN_FALLBACK",
    provider_call_cap_tokens: DEFAULT_PROVIDER_CALL_BUDGET_TOKENS,
    fallback_applied: true,
    effective_window_tokens: 262_144,
    output_reserve_tokens: 8_192,
    protocol_overhead_tokens: 8_192,
    safety_reserve_tokens: 13_108,
    safe_input_tokens: 232_652,
    requested_threshold_tokens: 350_000,
    effective_threshold_tokens: 209_386,
    threshold_clamped: true,
    post_compaction_target_tokens: 100_000,
    context_tokens: 100_000,
    distance_tokens: 109_386,
    ...overrides,
  });
}
