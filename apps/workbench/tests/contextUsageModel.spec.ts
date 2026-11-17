import { describe, expect, it } from "vitest";
import type { RelaySessionContextUsage } from "../src/api/dtos/assist";
import { buildContextUsageViewModel, contextUsageStatus, formatRatioPercent,
  formatSharePercent } from "../src/lib/contextUsageModel";
import { contextCompactionFixture, unknownWindowCompactionFixture } from "./contextUsageFixture";

/**
 * 上下文用量视图模型（2026-11-15 浮层重排）的集中算术。
 *
 * 面板上的每一个派生数都出自这里：状态机、阈值口径与窗口口径的占比、
 * 分项份额、缺失数据。这里用纯函数用例把口径钉死，组件测试只核对呈现。
 */

function usage(overrides: Partial<RelaySessionContextUsage> = {}): RelaySessionContextUsage {
  return { sessionId: "22222222-2222-4222-8222-222222222222", nextCall: null, lastCall: null,
    compaction: contextCompactionFixture(overrides.compaction ?? {}),
    ...overrides } as RelaySessionContextUsage;
}

describe("buildContextUsageViewModel", () => {
  it("投影为空时没有视图快照，面板自己处理 loading/错误/无会话", () => {
    expect(buildContextUsageViewModel(null)).toBeNull();
  });

  it("核心区按生效阈值算占比与剩余；来源原样透传", () => {
    const vm = buildContextUsageViewModel(usage())!;
    expect(vm.current.tokens).toBe(280_000);
    expect(vm.current.threshold).toBe(350_000);
    expect(vm.current.percentLabel).toBe("80");
    expect(vm.current.remaining).toBe(70_000);
    expect(vm.current.source).toBe("PROVIDER_USAGE");
  });

  it("窗口区分子取最近一次调用的实报输入；没有调用时整个窗口区为空", () => {
    const withoutCall = buildContextUsageViewModel(usage())!;
    expect(withoutCall.window).toBeNull();
    expect(withoutCall.lastCall).toBeNull();
    const withCall = buildContextUsageViewModel(usage({
      lastCall: { source: "MODEL_CALL", callId: null, messageId: null, provider: null,
        model: null, status: "COMPLETED", inputTokens: 209_386, outputTokens: 10,
        cacheReadTokens: 100_000, cacheCreationTokens: null, reservedTokens: null,
        settledAt: null, breakdown: null } }))!;
    expect(withCall.window).not.toBeNull();
    expect(withCall.window!.used).toBe(209_386);
    // percentLabel 只保留数值；「%」由界面补。
    expect(withCall.window!.percentLabel).toBe("21");
    // 命中率只在读取量不超过输入量时成立：100,000 / 209,386 ≈ 48%。
    expect(withCall.lastCall!.hitRateLabel).toBe("48");
  });

  it("缓存读取超过输入时命中率没有分母，不显示 0% 也不显示 100%", () => {
    const vm = buildContextUsageViewModel(usage({
      lastCall: { source: "MODEL_CALL", callId: null, messageId: null, provider: null,
        model: null, status: "COMPLETED", inputTokens: 500, outputTokens: null,
        cacheReadTokens: 900, cacheCreationTokens: null, reservedTokens: null,
        settledAt: null, breakdown: null } }))!;
    expect(vm.lastCall!.hitRateLabel).toBeNull();
  });

  it("容量口径（窗口/来源/服务商上限）放在压缩块里，没有调用也能拿到", () => {
    const vm = buildContextUsageViewModel(usage({ compaction: unknownWindowCompactionFixture() }))!;
    expect(vm.compaction.effectiveWindow).toBe(262_144);
    expect(vm.compaction.modelWindow).toBeNull();
    expect(vm.compaction.windowSource).toBe("UNKNOWN_FALLBACK");
    expect(vm.current.threshold).toBe(209_386);
    expect(vm.compaction.clamped).toBe(true);
  });

  it("已知 128K 窗口按真实有效窗口计算，不套用产品 1M 目标", () => {
    const vm = buildContextUsageViewModel(usage({
      compaction: contextCompactionFixture({ modelWindowTokens: 131_072,
        windowSource: "MODEL_CONFIG", effectiveWindowTokens: 131_072,
        safetyReserveTokens: 6_554, safeInputTokens: 108_134,
        requestedThresholdTokens: 90_000, effectiveThresholdTokens: 90_000,
        thresholdClamped: false, postCompactionTargetTokens: 45_000,
        contextTokens: 65_536, distanceTokens: 24_464 }),
      lastCall: { source: "MODEL_CALL", callId: null, messageId: null, provider: null,
        model: null, status: "COMPLETED", inputTokens: 65_536, outputTokens: 20,
        cacheReadTokens: null, cacheCreationTokens: null, reservedTokens: null,
        settledAt: null, breakdown: null } }))!;
    expect(vm.window).not.toBeNull();
    expect(vm.window!.effectiveWindow).toBe(131_072);
    expect(vm.window!.percentLabel).toBe("50");
  });
});

describe("contextUsageStatus", () => {
  it("默认夹具（280K/350K = 80%）落在「接近阈值」；低于 80% 才是正常", () => {
    expect(contextUsageStatus(contextCompactionFixture()).key).toBe("NEAR_THRESHOLD");
    const normal = contextUsageStatus(contextCompactionFixture({ contextTokens: 279_999 }));
    expect(normal.key).toBe("NORMAL");
    expect(normal.tone).toBe("neutral");
  });

  it("达到或超过生效阈值是「已达阈值」，但不盖过「正在压缩」与「最近失败」", () => {
    const over = contextUsageStatus(contextCompactionFixture({ distanceTokens: -70_614 }));
    expect(over.key).toBe("AT_THRESHOLD");
    expect(over.tone).toBe("warning");
    const compacting = contextUsageStatus(contextCompactionFixture({
      distanceTokens: -70_614,
      active: { requestId: "44444444-4444-4444-8444-444444444444", status: "RUNNING",
        trigger: "THRESHOLD" } }));
    expect(compacting.key).toBe("COMPACTING");
    const failed = contextUsageStatus(contextCompactionFixture({
      distanceTokens: -70_614,
      lastResult: { requestId: "55555555-5555-4555-8555-555555555555", reason: "AUTO",
        trigger: "THRESHOLD", status: "FAILED", errorCode: "MODEL_TIMEOUT",
        throughSeq: "10", tokensBefore: null, tokensAfter: null, budgetUnmet: null,
        safeInputTokens: null, at: "2026-11-12T08:00:00.000Z" } }));
    expect(failed.key).toBe("LAST_FAILED");
    expect(failed.tone).toBe("danger");
  });

  it("已关闭压过「已达阈值」：阈值不会触发整理，标成即将压缩会误导", () => {
    const disabled = contextUsageStatus(contextCompactionFixture({
      enabled: false, distanceTokens: -70_614 }));
    expect(disabled.key).toBe("DISABLED");
    expect(disabled.tone).toBe("neutral");
  });
});

describe("分项份额", () => {
  it("固定顺序、零值过滤、份额以估算合计为分母", () => {
    const vm = buildContextUsageViewModel(usage({
      lastCall: { source: "MODEL_CALL", callId: null, messageId: null, provider: null,
        model: null, status: "COMPLETED", inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheCreationTokens: null, reservedTokens: null,
        settledAt: null,
        breakdown: { version: 1, method: "UTF8_BYTES_DIV_3", precision: "ESTIMATED",
          categories: [{ key: "MEMORY", tokens: 0, bytes: 0 },
            { key: "HISTORY", tokens: 5_000, bytes: 15_000 },
            { key: "OTHER", tokens: 2_500, bytes: 7_500 }],
          estimatedTotalTokens: 7_500, coveredBytes: 22_500, imageParts: 0 } } }))!;
    expect(vm.breakdown!.entries.map((entry) => entry.key)).toEqual(["HISTORY", "OTHER"]);
    expect(vm.breakdown!.entries[0]!.share).toBeCloseTo(5_000 / 7_500);
    expect(vm.breakdown!.entries[0]!.share !== null &&
      formatSharePercent(vm.breakdown!.entries[0]!.share)).toBe("67");
  });

  it("估算合计为 0 时份额没有分母（null），不显示 0%", () => {
    const vm = buildContextUsageViewModel(usage({
      lastCall: { source: "MODEL_CALL", callId: null, messageId: null, provider: null,
        model: null, status: "COMPLETED", inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheCreationTokens: null, reservedTokens: null,
        settledAt: null,
        breakdown: { version: 1, method: "UTF8_BYTES_DIV_3", precision: "ESTIMATED",
          categories: [], estimatedTotalTokens: 0, coveredBytes: 0, imageParts: 0 } } }))!;
    expect(vm.breakdown!.entries).toEqual([]);
  });
});

describe("比例读数", () => {
  it("未满但会进位 100% 时保留小数；超额给真实比例", () => {
    expect(formatRatioPercent(0.996)).toBe("99.6");
    expect(formatRatioPercent(0.9999)).toBe("99.9");
    expect(formatRatioPercent(1)).toBe("100");
    expect(formatRatioPercent(1.004)).toBe("100.4");
    expect(formatRatioPercent(2)).toBe("200");
  });

  it("份额读数钳到 100%", () => {
    expect(formatSharePercent(0.4716)).toBe("47");
    expect(formatSharePercent(1)).toBe("100");
    expect(formatSharePercent(1.2)).toBe("100");
  });
});
