import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelaySessionContextUsage } from "../src/api/dtos/assist";
import { contextCompactionFixture } from "./contextUsageFixture";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact } from "./mountApp";

/**
 * 上下文用量浮层（0165）。
 *
 * 本次重构后的口径：
 *   · 会话三档窗口入口已取消；普通用户只在设置页配置压缩阈值；
 *   · 圆环与浮层共用「实际可用窗口」作分母（min(1M, 模型窗口/安全回退, 服务商上限)）；
 *   · 模型窗口只读展示并标出来源；未知时显示安全回退，不伪造 1M；
 *   · 用户保存阈值与生效阈值分开显示，收敛时不静默改写用户设置。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function usage(overrides: Partial<RelaySessionContextUsage> = {}): RelaySessionContextUsage {
  return { sessionId,
    nextCall: { reservationTokens: 1_000_000, effectiveWindowTokens: 1_000_000,
      modelWindowTokens: 1_000_000, providerCallCapTokens: 1_000_000,
      windowSource: "MODEL_CATALOG", fallbackApplied: false },
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
    compaction: contextCompactionFixture(),
    ...overrides };
}

async function mount(data: RelaySessionContextUsage | null, handlers: {
  readonly onReload?: () => void } = {}) {
  const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={sessionId}
    sessionRevision="7" usage={data} loading={false} error={null}
    onReload={handlers.onReload ?? (() => {})} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

describe("上下文用量浮层", () => {
  it("不再有会话窗口档位入口；模型窗口只读展示并标出来源", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.findAll("input[type=radio]")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("当前档位");
    expect(wrapper.text()).not.toContain("跟随应用默认");
    expect(wrapper.find('[data-testid="context-usage-tiers"]').exists()).toBe(false);
    const row = wrapper.get('[data-testid="context-compaction-window-row"]').text();
    expect(row).toContain("1,000,000");
    expect(row).toContain("自动识别 · 模型目录");
    expect(row).toContain("不可在此修改");
  });

  it("用户设置阈值与生效阈值分两行；默认 350K 只作为默认值说明", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.get('[data-testid="context-compaction-configured-row"]').text())
      .toContain("350,000");
    expect(wrapper.get('[data-testid="context-compaction-threshold-row"]').text())
      .toContain("350,000");
    expect(wrapper.get('[data-testid="context-compaction-default-note"]').text())
      .toContain("默认值 350,000");
    expect(wrapper.get('[data-testid="context-compaction-default-note"]').text())
      .toContain("256,000–400,000");
  });

  it("圆环分母是实际可用窗口，不是旧会话档位或模型宣传数", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.get('[data-testid="assist-context-meter-input"]').text()).toBe("10,607");
    expect(wrapper.get('[data-testid="assist-context-meter-window"]').text()).toBe("1,000,000");
    // 10,607 / 1,000,000 ≈ 1.06%，取整 1%。
    expect(wrapper.get('[data-testid="assist-context-meter-percent"]').text()).toBe("1%");
    expect(wrapper.get('[data-testid="assist-context-meter-remaining"]').text()).toContain("989,393");
    const note = wrapper.get('[data-testid="context-usage-frozen-note"]').text();
    expect(note).toContain("这次调用当时冻结 65,536 tokens");
    expect(note).toContain("当前模型可用窗口 1,000,000 tokens");
  });

  it("冻结预算与当前窗口一致时不补差异说明", async () => {
    const wrapper = await mount(usage({ lastCall: { ...usage().lastCall!, reservedTokens: 1_000_000 } }));
    expect(wrapper.find('[data-testid="context-usage-frozen-note"]').exists()).toBe(false);
  });

  it("模型窗口未知时显示安全回退，不伪造 1M", async () => {
    const wrapper = await mount(usage({
      compaction: contextCompactionFixture({ modelWindowTokens: null,
        windowSource: "UNKNOWN_FALLBACK", fallbackApplied: true,
        effectiveWindowTokens: 262_144, safeInputTokens: 232_652 }),
      nextCall: { reservationTokens: 262_144, effectiveWindowTokens: 262_144,
        modelWindowTokens: null, providerCallCapTokens: null,
        windowSource: "UNKNOWN_FALLBACK", fallbackApplied: true },
    }));
    const row = wrapper.get('[data-testid="context-compaction-window-row"]').text();
    expect(row).toContain("未知（按安全回退 262,144 tokens）");
    expect(wrapper.get('[data-testid="context-compaction-window-source"]').text())
      .toContain("未知 · 安全回退");
    expect(wrapper.get('[data-testid="assist-context-meter-window"]').text()).toBe("262,144");
  });

  it("用户阈值高于安全上限时显示「用户设置 / 实际生效 / 原因」", async () => {
    const wrapper = await mount(usage({ compaction: contextCompactionFixture({
      thresholdClamped: true, thresholdTokens: 500_000, requestedThresholdTokens: 500_000,
      effectiveThresholdTokens: 209_386, modelWindowTokens: 262_144,
      effectiveWindowTokens: 262_144, safeInputTokens: 232_652, distanceTokens: -70_614 }) }));
    const clamped = wrapper.get('[data-testid="context-compaction-clamped"]').text();
    expect(clamped).toContain("用户设置 500,000 tokens");
    expect(clamped).toContain("实际生效 209,386 tokens");
    expect(clamped).toContain("当前模型上下文容量不足");
    expect(wrapper.get('[data-testid="context-compaction-threshold"]').text()).toBe("209,386");
  });

  it("分项按固定顺序渲染并标注估算；没有分项时只写「暂无分项统计」", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.get('[data-testid="context-usage-estimate"]').text()).toBe("估算");
    const rows = wrapper.findAll('[data-testid^="context-usage-row-"]');
    expect(rows.map((row) => row.attributes("data-testid")))
      .toEqual(["context-usage-row-HISTORY", "context-usage-row-SYSTEM", "context-usage-row-FILE_READS"]);
    expect(rows[0]!.text()).toContain("历史消息");
    expect(rows[0]!.text()).toContain("5,000");

    unmount?.(); unmount = null;
    const empty = await mount(usage({ lastCall: { ...usage().lastCall!, breakdown: null } }));
    expect(empty.get('[data-testid="context-usage-breakdown-empty"]').text())
      .toContain("当前记录没有分项统计");
    expect(empty.findAll('[data-testid^="context-usage-row-"]')).toHaveLength(0);
    expect(empty.get('[data-testid="assist-context-meter-percent"]').text()).toBe("1%");
  });

  it("没有模型调用时只说明，不画 0% 也不编分项；手动压缩仍可用", async () => {
    const wrapper = await mount(usage({ lastCall: null }));
    expect(wrapper.get('[data-testid="assist-context-meter-empty"]').text()).toContain("尚无模型调用");
    expect(wrapper.find('[data-testid="assist-context-meter-percent"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-usage-breakdown"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="context-compaction-now"]').attributes("disabled")).toBeUndefined();
  });

  it("读取失败时显示原因与重读入口，不拿旧值顶替", async () => {
    const onReload = vi.fn();
    const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={sessionId}
      sessionRevision="7" usage={null} loading={false} error="网络不可用"
      onReload={onReload} />);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="context-usage-error"]').text()).toContain("网络不可用");
    await mounted.wrapper.get('[data-testid="context-usage-error"] button').trigger("click");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(mounted.wrapper.find('[data-testid="assist-context-meter-percent"]').exists()).toBe(false);
  });

  it("还没有会话时只显示读数，手动压缩不可用；没有档位可写", async () => {
    const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={null}
      sessionRevision={null} usage={null} loading={false} error={null}
      onReload={() => {}} />);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.findAll("input[type=radio]")).toHaveLength(0);
    expect(mounted.wrapper.get('[data-testid="context-compaction-now"]')
      .attributes("disabled")).toBeDefined();
  });
});
