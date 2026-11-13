import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelayContextCompaction, RelaySessionContextUsage } from "../src/api/dtos/assist";
import { contextCompactionFixture } from "./contextUsageFixture";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact } from "./mountApp";

/**
 * 自动压缩区（0162）的界面口径。
 *
 * 这一区只回答三件不同的事，不能混成一句：
 *   · 模型真实上下文窗口有多大（读不到就写未知，不按 1M 冒充）；
 *   · 自动压缩阈值生效在哪个数（保存值高于安全上限时收敛并明说）；
 *   · 距离下次压缩还有多少（达到阈值不是达到窗口上限）。
 * 手动压缩的 202 也只是受理，完成状态必须从服务端读回。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function usage(compaction: Partial<RelayContextCompaction> = {}): RelaySessionContextUsage {
  return { sessionId, budget: { tokens: 524288, revision: "3" },
    nextCall: { reservationTokens: 524288, contextBudgetTokens: 524288,
      providerWindowTokens: null, windowSource: "UNKNOWN" },
    lastCall: null, compaction: contextCompactionFixture(compaction) };
}

async function mount(data: RelaySessionContextUsage) {
  const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={sessionId}
    sessionRevision="7" usage={data} loading={false} error={null}
    onReload={() => {}} onSaved={() => {}} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

function text(wrapper: Awaited<ReturnType<typeof mount>>, testId: string): string {
  return wrapper.get(`[data-testid="${testId}"]`).text();
}

function optional(wrapper: Awaited<ReturnType<typeof mount>>, testId: string): boolean {
  return wrapper.findAll(`[data-testid="${testId}"]`).length > 0;
}

describe("自动压缩区", () => {
  it("模型窗口、会话档位与生效阈值分三行；距离按生效阈值算", async () => {
    const wrapper = await mount(usage());
    expect(text(wrapper, "context-compaction-current")).toBe("280,000");
    expect(text(wrapper, "context-compaction-threshold")).toBe("350,000");
    // 窗口行给真实窗口，档位另给一行：两枚数字不同，不能被读成同一个上限。
    expect(text(wrapper, "context-compaction-window-row")).toContain("1,048,576");
    expect(text(wrapper, "context-compaction-target-row")).toContain("524,288");
    expect(text(wrapper, "context-compaction-threshold-row")).toContain("350,000");
    expect(text(wrapper, "context-compaction-distance")).toContain("70,000");
    expect(wrapper.get('[data-testid="context-compaction-state"]').text()).toBe("已开启");
  });

  it("读数来源分开标注：真实基线 + 估算增量与整份估算不是同一个口径", async () => {
    const real = await mount(usage({ contextSource: "PROVIDER_USAGE" }));
    expect(text(real, "context-compaction-source")).toBe("真实基线 + 估算增量");
    unmount?.(); unmount = null;
    const estimated = await mount(usage({ contextSource: "ESTIMATED" }));
    expect(text(estimated, "context-compaction-source")).toBe("估算");
  });

  it("保存值高于模型安全上限时写明按哪个数生效，不把用户设置当成生效值", async () => {
    const wrapper = await mount(usage({ thresholdClamped: true, thresholdTokens: 500_000,
      requestedThresholdTokens: 500_000, effectiveThresholdTokens: 209_386,
      modelWindowTokens: 262_144, effectiveWindowTokens: 262_144, safeInputTokens: 232_652,
      distanceTokens: -70_614 }));
    const clamped = text(wrapper, "context-compaction-clamped");
    expect(clamped).toContain("500,000");
    expect(clamped).toContain("209,386");
    expect(text(wrapper, "context-compaction-threshold")).toBe("209,386");
    expect(text(wrapper, "context-compaction-distance")).toContain("已超过自动压缩阈值");
  });

  it("关闭普通自动压缩后说明溢出保护仍在，不暗示「不会再压缩」", async () => {
    const wrapper = await mount(usage({ enabled: false }));
    expect(wrapper.get('[data-testid="context-compaction-state"]').text()).toBe("已关闭");
    expect(text(wrapper, "context-compaction-disabled-note")).toContain("溢出保护");
  });

  it("压缩中只说明正在压缩并把按钮禁用，不宣称已完成", async () => {
    const wrapper = await mount(usage({ active: { requestId: "44444444-4444-4444-8444-444444444444",
      status: "RUNNING", trigger: "THRESHOLD" } }));
    expect(text(wrapper, "context-compaction-active")).toContain("正在压缩上下文");
    expect(wrapper.get('[data-testid="context-compaction-now"]').attributes("disabled")).toBeDefined();
  });

  it("最近一次结果显示压缩前后对照与减少量", async () => {
    const wrapper = await mount(usage({ lastResult: { requestId: "55555555-5555-4555-8555-555555555555",
      reason: "AUTO", trigger: "THRESHOLD", status: "COMPLETED", errorCode: null,
      throughSeq: "10", tokensBefore: 350_000, tokensAfter: 42_000, budgetUnmet: false,
      safeInputTokens: 481_689, at: "2026-11-12T08:00:00.000Z" } }));
    const last = text(wrapper, "context-compaction-last-result");
    expect(last).toContain("压缩前 350,000 tokens");
    expect(last).toContain("压缩后 42,000 tokens");
    expect(last).toContain("减少 308,000");
    // 预算够用时不给 unmet 提示。
    expect(optional(wrapper, "context-compaction-budget-unmet")).toBe(false);
  });

  it("压后仍超预算时明确说明下一步，不把「压缩成功」说成问题已解决", async () => {
    const wrapper = await mount(usage({ safeInputTokens: 232_652,
      lastResult: { requestId: "55555555-5555-4555-8555-555555555555", reason: "AUTO",
        trigger: "OVERFLOW", status: "COMPLETED", errorCode: null, throughSeq: "10",
        tokensBefore: 300_000, tokensAfter: 256_000, budgetUnmet: true,
        safeInputTokens: 232_652, at: "2026-11-12T08:00:00.000Z" } }));
    const unmet = text(wrapper, "context-compaction-budget-unmet");
    expect(unmet).toContain("256,000");
    expect(unmet).toContain("232,652");
    expect(unmet).toContain("明确中止");
  });

  it("没有压后读数时不编造减少量", async () => {
    const wrapper = await mount(usage({ lastResult: { requestId: "55555555-5555-4555-8555-555555555555",
      reason: "MANUAL", trigger: "MANUAL", status: "COMPLETED", errorCode: null,
      throughSeq: "10", tokensBefore: 300_000, tokensAfter: null, budgetUnmet: null,
      safeInputTokens: null, at: "2026-11-12T08:00:00.000Z" } }));
    const last = text(wrapper, "context-compaction-last-result");
    expect(last).toContain("压缩前 300,000 tokens");
    expect(last).not.toContain("压缩后");
    expect(optional(wrapper, "context-compaction-budget-unmet")).toBe(false);
  });
});
