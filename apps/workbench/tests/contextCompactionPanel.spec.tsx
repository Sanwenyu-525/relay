import { afterEach, describe, expect, it } from "vitest";
import type { RelayContextCompaction, RelaySessionContextUsage } from "../src/api/dtos/assist";
import { contextCompactionFixture } from "./contextUsageFixture";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact } from "./mountApp";

/**
 * 自动压缩区（0162 / 0165；2026-11-15 CONTEXT-USAGE-MINIMAL）的界面口径。
 *
 * 压缩区现在只留三件事：开关状态、阈值被模型容量收敛时的一行原因、
 * 失败时的错误码。成功记录、减少量、预算未达、手动按钮都不再渲染；
 * 数据本身与 `/compact` 入口仍由服务端/浮层外部承担。
 */

const sessionId = "22222222-2222-4222-8222-222222222222";
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; });

function usage(compaction: Partial<RelayContextCompaction> = {}): RelaySessionContextUsage {
  return { sessionId,
    nextCall: { reservationTokens: 1_000_000, effectiveWindowTokens: 1_000_000,
      modelWindowTokens: 1_000_000, providerCallCapTokens: 1_048_576,
      windowSource: "MODEL_CATALOG", fallbackApplied: false },
    lastCall: null, compaction: contextCompactionFixture(compaction) };
}

async function mount(data: RelaySessionContextUsage) {
  const mounted = await mountReact(<ContextUsagePanel usage={data} loading={false}
    error={null} onReload={() => {}} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

function text(wrapper: Awaited<ReturnType<typeof mount>>, testId: string): string {
  return wrapper.get(`[data-testid="${testId}"]`).text();
}

describe("自动压缩区", () => {
  it("只显示开启状态；阈值相同时不重复用户设置", async () => {
    const wrapper = await mount(usage());
    expect(text(wrapper, "context-compaction-state")).toBe("已开启");
    expect(text(wrapper, "context-usage-current-threshold")).toBe("350,000");
    expect(wrapper.find('[data-testid="context-compaction-clamped"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-compaction-configured-row"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-compaction-now"]').exists()).toBe(false);
  });

  it("保存值高于模型安全上限时只留一行原因，不展开公式", async () => {
    const wrapper = await mount(usage({ thresholdClamped: true, thresholdTokens: 500_000,
      requestedThresholdTokens: 500_000, effectiveThresholdTokens: 209_386,
      modelWindowTokens: 262_144, effectiveWindowTokens: 262_144,
      safetyReserveTokens: 13_108, safeInputTokens: 232_652,
      distanceTokens: -70_614 }));
    const clamp = text(wrapper, "context-compaction-clamped");
    expect(clamp).toContain("用户设置 500,000");
    expect(clamp).toContain("容量受限，按 209,386 生效");
    expect(text(wrapper, "context-usage-current-threshold")).toBe("209,386");
    expect(wrapper.find('[data-testid="context-usage-capacity-formula"]').exists()).toBe(false);
  });

  it("关闭普通自动压缩后只显示一次已关闭，超过阈值不说会先整理", async () => {
    const wrapper = await mount(usage({ enabled: false, distanceTokens: -70_614 }));
    expect(text(wrapper, "context-compaction-state")).toBe("已关闭");
    expect(text(wrapper, "context-usage-current-remaining"))
      .toBe("已超过压缩阈值 70,614 tokens。");
    expect(wrapper.text()).not.toContain("下一次请求前会先整理");
    expect(wrapper.text()).not.toContain("溢出保护");
  });

  it("压缩失败保留错误码；成功记录与预算未达提示不再渲染", async () => {
    const failed = await mount(usage({ lastResult: {
      requestId: "55555555-5555-4555-8555-555555555555", reason: "AUTO",
      trigger: "THRESHOLD", status: "FAILED", errorCode: "MODEL_TIMEOUT", throughSeq: "10",
      tokensBefore: 350_000, tokensAfter: null, budgetUnmet: null,
      safeInputTokens: null, at: "2026-11-12T08:00:00.000Z" } }));
    expect(text(failed, "context-compaction-failed")).toContain("MODEL_TIMEOUT");

    unmount?.(); unmount = null;
    const completed = await mount(usage({ lastResult: {
      requestId: "55555555-5555-4555-8555-555555555555", reason: "AUTO",
      trigger: "THRESHOLD", status: "COMPLETED", errorCode: null, throughSeq: "10",
      tokensBefore: 350_000, tokensAfter: 42_000, budgetUnmet: true,
      safeInputTokens: 232_652, at: "2026-11-12T08:00:00.000Z" } }));
    expect(completed.find('[data-testid="context-compaction-last-result"]').exists()).toBe(false);
    expect(completed.find('[data-testid="context-compaction-budget-unmet"]').exists()).toBe(false);
    expect(completed.text()).not.toContain("减少");
    expect(completed.text()).not.toContain("安全输入上限");
  });
});
