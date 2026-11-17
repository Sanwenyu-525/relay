import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelaySessionContextUsage } from "../src/api/dtos/assist";
import { contextCompactionFixture, unknownWindowCompactionFixture } from "./contextUsageFixture";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact, type DomWrapper } from "./mountApp";

/**
 * 上下文用量浮层（0165；2026-11-15 CONTEXT-USAGE-MINIMAL）。
 *
 * 默认只答四件事：当前 Token / 实际生效阈值、占比、余量、自动压缩开关。
 * 构成、容量、最近调用、成功压缩记录、时间戳、来源与手动按钮均不渲染；
 * 异常态仍保留读取失败、容量收敛与压缩失败。
 */

const sessionId = "22222222-2222-4222-8222-222222222222";
let unmount: (() => void) | null = null;
function cleanup(): void { unmount?.(); unmount = null; }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function usage(overrides: Partial<RelaySessionContextUsage> = {}): RelaySessionContextUsage {
  const compaction = overrides.compaction ?? contextCompactionFixture();
  return { sessionId,
    nextCall: { reservationTokens: compaction.effectiveWindowTokens,
      effectiveWindowTokens: compaction.effectiveWindowTokens,
      modelWindowTokens: compaction.modelWindowTokens,
      providerCallCapTokens: compaction.providerCallCapTokens,
      windowSource: compaction.windowSource, fallbackApplied: compaction.fallbackApplied },
    lastCall: { source: "MODEL_CALL", callId: "33333333-3333-4333-8333-333333333333",
      messageId: null, provider: "openai-compatible", model: "fixture-model",
      status: "COMPLETED", inputTokens: 10_607, outputTokens: 646,
      cacheReadTokens: null, cacheCreationTokens: null, reservedTokens: 65_536,
      settledAt: "2026-10-30T00:00:00.000Z",
      breakdown: { version: 1, method: "UTF8_BYTES_DIV_3", precision: "ESTIMATED",
        categories: [{ key: "HISTORY", tokens: 5_000, bytes: 15_000 },
          { key: "SYSTEM", tokens: 3_607, bytes: 10_821 },
          { key: "FILE_READS", tokens: 2_000, bytes: 6_000 }],
        estimatedTotalTokens: 10_607, coveredBytes: 31_821, imageParts: 0 } },
    compaction,
    ...overrides };
}

async function mount(data: RelaySessionContextUsage | null, handlers: {
  readonly onReload?: () => void } = {}): Promise<DomWrapper> {
  const mounted = await mountReact(<ContextUsagePanel usage={data} loading={false}
    error={null} onReload={handlers.onReload ?? (() => {})} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

function text(wrapper: DomWrapper, testId: string): string {
  return wrapper.get(`[data-testid="${testId}"]`).text();
}

describe("上下文用量浮层", () => {
  it("核心区：当前上下文、实际生效阈值、占比、进度条与距离", async () => {
    const wrapper = await mount(usage());
    expect(text(wrapper, "context-usage-current-tokens")).toBe("280,000");
    expect(text(wrapper, "context-usage-current-threshold")).toBe("350,000");
    expect(text(wrapper, "context-usage-current-percent")).toBe("80%");
    expect(text(wrapper, "context-usage-current-remaining"))
      .toContain("距离自动压缩还剩 70,000 tokens");
    expect(wrapper.get('[data-testid="context-usage-current-bar"]').exists()).toBe(true);
    expect(text(wrapper, "context-compaction-state")).toBe("已开启");
    // 来源标签和用户设置阈值不占正文。
    expect(wrapper.text()).not.toContain("真实 + 估算");
    expect(wrapper.text()).not.toContain("估算");
    expect(wrapper.text()).not.toContain("用户设置阈值");
  });

  it("默认不渲染构成、容量、最近调用、成功记录与手动压缩按钮", async () => {
    const wrapper = await mount(usage());
    for (const testId of ["context-usage-breakdown-section", "context-usage-breakdown",
      "context-usage-composition-bar", "context-usage-capacity", "context-usage-window",
      "context-usage-window-used", "context-usage-window-value", "context-usage-window-percent",
      "context-usage-window-meta", "context-usage-frozen-note", "context-usage-estimate",
      "context-compaction-now", "context-compaction-last-result", "context-compaction-window-row",
      "context-compaction-window-source", "context-compaction-configured-row",
      "context-compaction-threshold-row", "context-compaction-post-target-row"]) {
      expect(wrapper.find(`[data-testid="${testId}"]`).exists(), testId).toBe(false);
    }
    expect(wrapper.find(".context-usage-scroll").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("上下文构成");
    expect(wrapper.text()).not.toContain("容量限制");
    expect(wrapper.text()).not.toContain("最近一次调用");
    expect(wrapper.text()).not.toContain("最近压缩");
    expect(wrapper.text()).not.toContain("最近一次记录");
    expect(wrapper.text()).not.toContain("立即压缩");
    expect(wrapper.text()).not.toContain("压缩后目标");
  });

  it("阈值相同时不展示用户设置；容量收敛时只留一行原因", async () => {
    const same = await mount(usage());
    expect(same.find('[data-testid="context-compaction-clamped"]').exists()).toBe(false);

    cleanup();
    const clamped = await mount(usage({ compaction: contextCompactionFixture({
      thresholdClamped: true, thresholdTokens: 500_000, requestedThresholdTokens: 500_000,
      effectiveThresholdTokens: 209_386, modelWindowTokens: 262_144,
      effectiveWindowTokens: 262_144, safetyReserveTokens: 13_108,
      safeInputTokens: 232_652, distanceTokens: -70_614 }) }));
    expect(text(clamped, "context-compaction-clamped"))
      .toBe("用户设置 500,000；容量受限，按 209,386 生效。");
    expect(text(clamped, "context-usage-current-threshold")).toBe("209,386");
    expect(text(clamped, "context-usage-current-remaining"))
      .toContain("已超过自动压缩阈值 70,614 tokens");
    expect(clamped.find('[data-testid="context-usage-capacity"]').exists()).toBe(false);

    cleanup();
    const unknown = await mount(usage({ compaction: unknownWindowCompactionFixture() }));
    expect(text(unknown, "context-usage-current-threshold")).toBe("209,386");
    expect(text(unknown, "context-compaction-clamped"))
      .toBe("当前阈值 350,000；模型窗口未知，按 209,386 生效。");
    expect(unknown.find('[data-testid="context-compaction-window-unknown"]').exists()).toBe(false);
    expect(unknown.text()).not.toContain("262,144");
    expect(unknown.text()).not.toContain("933,616"); // 没有把 1M 的 safeInput 留在未知窗口里
  });

  it("已知 1M 窗口、用户阈值低于容量上限时按原值生效，不错误收敛", async () => {
    const wrapper = await mount(usage({ compaction: contextCompactionFixture({
      thresholdTokens: 300_000, requestedThresholdTokens: 300_000,
      effectiveThresholdTokens: 300_000, thresholdClamped: false, distanceTokens: 20_000 }) }));
    expect(text(wrapper, "context-usage-current-threshold")).toBe("300,000");
    expect(wrapper.find('[data-testid="context-compaction-clamped"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-compaction-window-unknown"]').exists()).toBe(false);
  });

  it("自动压缩关闭时只显示一次状态；超过阈值不说会先整理", async () => {
    const wrapper = await mount(usage({ compaction: contextCompactionFixture({
      enabled: false, distanceTokens: -70_614 }) }));
    expect(text(wrapper, "context-compaction-state")).toBe("已关闭");
    expect(text(wrapper, "context-usage-current-remaining"))
      .toBe("已超过压缩阈值 70,614 tokens。");
    expect(wrapper.text()).not.toContain("下一次请求前会先整理");
    // 自动压缩状态只在自动压缩行出现一次，距离行不重复。
    expect(wrapper.text().split("自动压缩已关闭").length - 1).toBe(1);
  });

  it("压缩失败保留错误码；成功记录与减少量不再出现", async () => {
    const failed = await mount(usage({ compaction: contextCompactionFixture({
      lastResult: { requestId: "55555555-5555-4555-8555-555555555555", reason: "AUTO",
        trigger: "THRESHOLD", status: "FAILED", errorCode: "MODEL_TIMEOUT", throughSeq: "10",
        tokensBefore: 350_000, tokensAfter: null, budgetUnmet: null,
        safeInputTokens: null, at: "2026-11-12T08:00:00.000Z" } }) }));
    expect(text(failed, "context-compaction-failed"))
      .toBe("上次压缩失败 · MODEL_TIMEOUT");
    expect(failed.find('[data-testid="context-compaction-last-result"]').exists()).toBe(false);

    cleanup();
    const completed = await mount(usage({ compaction: contextCompactionFixture({
      lastResult: { requestId: "55555555-5555-4555-8555-555555555555", reason: "AUTO",
        trigger: "THRESHOLD", status: "COMPLETED", errorCode: null, throughSeq: "10",
        tokensBefore: 350_000, tokensAfter: 42_000, budgetUnmet: false,
        safeInputTokens: 481_689, at: "2026-11-12T08:00:00.000Z" } }) }));
    expect(completed.find('[data-testid="context-compaction-failed"]').exists()).toBe(false);
    expect(completed.text()).not.toContain("最近压缩");
    expect(completed.text()).not.toContain("减少");
  });

  it("没有模型调用时仍有核心读数，不编造调用详情", async () => {
    const wrapper = await mount(usage({ lastCall: null }));
    expect(text(wrapper, "context-usage-current-tokens")).toBe("280,000");
    expect(text(wrapper, "context-usage-current-remaining"))
      .toContain("距离自动压缩还剩 70,000 tokens");
    expect(wrapper.find('[data-testid="context-usage-window"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("尚无模型调用");
  });

  it("读取失败时显示原因与重读入口，不渲染旧读数", async () => {
    const onReload = vi.fn();
    const mounted = await mountReact(<ContextUsagePanel usage={null} loading={false}
      error="网络不可用" onReload={onReload} />);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="context-usage-error"]').text()).toContain("网络不可用");
    await mounted.wrapper.get('[data-testid="context-usage-error"] button').trigger("click");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(mounted.wrapper.find('[data-testid="context-usage-current"]').exists()).toBe(false);
  });

  it("加载与空态各自有短说明，不显示空壳读数", async () => {
    const loading = await mountReact(<ContextUsagePanel usage={null} loading
      error={null} onReload={() => {}} />);
    unmount = loading.unmount;
    await flush();
    expect(text(loading.wrapper, "context-usage-loading")).toBe("正在读取上下文用量…");

    cleanup();
    const empty = await mountReact(<ContextUsagePanel usage={null} loading={false}
      error={null} onReload={() => {}} />);
    unmount = empty.unmount;
    await flush();
    expect(text(empty.wrapper, "context-usage-empty")).toBe("暂无可用的上下文用量读数。");
  });
});
