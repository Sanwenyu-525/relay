import { describe, expect, it } from "vitest";
import { formatTokenCount, formatTokenUsageDetail, formatTokenUsageLine,
  legacyTokenUsage, tokenUsageTotal } from "../src/lib/tokenCount";
import type { RelayTokenUsage } from "../src/api/dtos/assist";

/**
 * Token 读数口径（AGENT_LIVE_TOKEN_USAGE，2026-11-01）。
 *
 * 十进制缩写：1k = 1,000、1m = 1,000,000；最多一位小数，去掉 `.0`；四舍五入跨过
 * 单位边界时改用下一个单位（999,950 → 1m，不会出现 1000k）。这些是展示规则，
 * 累计与判断始终使用原始整数。
 */

const usage = (patch: Partial<RelayTokenUsage> = {}): RelayTokenUsage => ({
  state: "CONFIRMED", inputTokens: 5_000, outputTokens: 400,
  cacheReadTokens: null, cacheCreationTokens: null,
  settledCalls: 1, pendingCalls: 0, missingUsageCalls: 0, ...patch });

describe("formatTokenCount：十进制缩写", () => {
  it.each([
    [0, "0"],
    [35, "35"],
    [999, "999"],
    [1_000, "1k"],
    [1_250, "1.3k"],
    [5_326, "5.3k"],
    [12_345, "12.3k"],
    [125_000, "125k"],
    [999_949, "999.9k"],
    [999_950, "1m"],
    [1_000_000, "1m"],
    [1_050_000, "1.1m"],
    [2_450_000, "2.5m"],
  ])("%i → %s", (value, expected) => {
    expect(formatTokenCount(value)).toBe(expected);
  });

  it("不使用大写单位，且负数或非有限值不产生脏读数", () => {
    expect(formatTokenCount(1_000)).not.toContain("K");
    expect(formatTokenCount(1_000_000)).not.toContain("M");
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });
});

describe("formatTokenUsageLine：状态决定符号", () => {
  it("估算显示 ≈，部分确认显示 ≥ 并写明未知，确认后只写数字", () => {
    expect(formatTokenUsageLine(usage({ state: "ESTIMATED" }), "LIVE"))
      .toBe("本轮 ≈ 5.4k tokens");
    expect(formatTokenUsageLine(usage({ state: "PARTIAL", missingUsageCalls: 1 }), "LIVE"))
      .toBe("本轮 ≥ 5.4k tokens · 部分用量未知");
    expect(formatTokenUsageLine(usage(), "FINAL")).toBe("本轮 5.4k tokens");
  });

  it("没有可靠数据时不写 0：生成中统计中，完成后未上报", () => {
    expect(formatTokenUsageLine(null, "LIVE")).toBe("Token 统计中");
    expect(formatTokenUsageLine(null, "FINAL")).toBe("本轮 Token 未上报");
    expect(formatTokenUsageLine(usage({ state: "UNKNOWN", inputTokens: null,
      outputTokens: null, settledCalls: 0 }), "LIVE")).toBe("Token 统计中");
  });

  it("只上报一项时仍给出可读总量，但状态不冒充精确值", () => {
    expect(tokenUsageTotal(usage({ outputTokens: null }))).toBe(5_000);
    expect(formatTokenUsageLine(usage({ state: "PARTIAL", outputTokens: null }), "FINAL"))
      .toBe("本轮 ≥ 5k tokens · 部分用量未知");
  });
});

describe("formatTokenUsageDetail：悬停详情用精确整数", () => {
  it("确认态给出未缩写整数与调用次数", () => {
    expect(formatTokenUsageDetail(usage({ inputTokens: 5_326, outputTokens: 74 })))
      .toBe("输入 5,326 · 输出 74 · 已结算 1 次调用 · 全部调用已确认");
  });

  it("估算态逐项标注，未上报的缓存字段不制造零值", () => {
    const detail = formatTokenUsageDetail(usage({ state: "ESTIMATED",
      inputTokens: 900, outputTokens: 20, settledCalls: 0, pendingCalls: 1,
      missingUsageCalls: 1 }));
    expect(detail).toContain("输入 900（含估算）");
    expect(detail).toContain("1 次调用进行中");
    expect(detail).not.toContain("缓存读取");
  });
});

describe("legacyTokenUsage：旧服务端的消息用量回退", () => {
  it("两项齐全按已确认，缺一项按部分确认，全缺按未知", () => {
    expect(legacyTokenUsage({ inputTokens: 4_757, outputTokens: 316,
      cacheReadTokens: null, cacheCreationTokens: null }).state).toBe("CONFIRMED");
    expect(legacyTokenUsage({ inputTokens: 4_757, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null }).state).toBe("PARTIAL");
    expect(legacyTokenUsage({ inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null }).state).toBe("UNKNOWN");
  });
});
