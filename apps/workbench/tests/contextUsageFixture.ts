import type { RelayContextCompaction } from "../src/api/dtos/assist";

/**
 * 上下文压缩投影的测试夹具（0162）。
 *
 * 默认是一份「1M 模型 + 512K 档位 + 默认 350K 阈值 + 当前 280K」的正常读数：
 * 它同时覆盖两种分母（模型窗口与档位不同）、真实窗口来源与「还有 70K 才压缩」。
 * 用例只覆盖需要变化的那几项，避免每个 spec 各自抄一份 20 字段的对象。
 */
export function contextCompactionFixture(
  overrides: Partial<RelayContextCompaction> = {},
): RelayContextCompaction {
  return { enabled: true, thresholdTokens: null, defaultThresholdTokens: 350_000,
    recommended: { min: 256_000, max: 400_000 }, requestedThresholdTokens: 350_000,
    effectiveThresholdTokens: 350_000, thresholdClamped: false, targetWindowTokens: 524_288,
    modelWindowTokens: 1_048_576, windowSource: "MODEL_CATALOG", effectiveWindowTokens: 524_288,
    outputReserveTokens: 8_192, protocolOverheadTokens: 8_192, safetyReserveTokens: 26_215,
    safeInputTokens: 481_689, postCompactionTargetTokens: 100_000, contextTokens: 280_000,
    contextSource: "PROVIDER_USAGE", distanceTokens: 70_000, active: null, lastResult: null,
    ...overrides };
}
