import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelaySessionContextUsage } from "../src/api/dtos/assist";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact } from "./mountApp";

/**
 * 上下文用量浮层（0145 / 2026-10-30 复审整改）。
 *
 * 这一轮的口径变化：
 *   · **选中即改变**——点档位立刻写服务端，没有「保存 / 重新读取」两枚按钮；
 *   · 没有会话时（首条消息之前）也能选，档位先落在新会话草稿作用域；
 *   · 历史调用没有可靠冻结预算时只写「预算未知」，不拿当前档位冒充历史预算、
 *     不显示未经证实的百分比；
 *   · 分项没有就写「暂无分项统计」，总用量照常可读。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function usage(overrides: Partial<RelaySessionContextUsage> = {}): RelaySessionContextUsage {
  return { sessionId, budget: { tokens: 524288, revision: "3" },
    nextCall: { reservationTokens: 524288, contextBudgetTokens: 524288,
      providerWindowTokens: null, windowSource: "UNKNOWN" },
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
    ...overrides };
}

async function mount(data: RelaySessionContextUsage | null, handlers: {
  readonly onSaved?: () => void; readonly onReload?: () => void } = {}) {
  const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={sessionId}
    usage={data} loading={false} error={null}
    onReload={handlers.onReload ?? (() => {})} onSaved={handlers.onSaved ?? (() => {})} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

function stubSequence(handlers: readonly ((url: string, init: RequestInit) => Response)[]) {
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(String(input), init ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("上下文用量浮层", () => {
  it("三档严格一行且没有「跟随应用默认」；选中态来自服务端档位", async () => {
    const wrapper = await mount(usage({ budget: { tokens: 1_048_576, revision: "4" } }));
    const group = wrapper.get('[data-testid="context-usage-tiers"]');
    expect(group.findAll("input[type=radio]")).toHaveLength(3);
    expect(wrapper.text()).toContain("256K");
    expect(wrapper.text()).toContain("512K");
    expect(wrapper.text()).toContain("1024K");
    expect(wrapper.text()).not.toContain("跟随应用默认");
    expect((wrapper.get('[data-testid="context-budget-option-1048576"]').element as HTMLInputElement).checked)
      .toBe(true);
    // 2026-11-01 用户指令：删掉「当前档位 256K」标题行——当前值只看单选态，不再重复一遍。
    expect(wrapper.text()).not.toContain("当前档位");
  });

  it("档位就是写入口：没有「保存 / 重新读取」两枚按钮，未点之前只显示服务端已保存的单选态", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.find('[data-testid="context-budget-save"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-budget-reload"]').exists()).toBe(false);
    expect(wrapper.find(".context-usage-tier-actions").exists()).toBe(false);
    // 正常状态不再常驻说明行：三档的单选态已经说完了。
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text()).toBe("");
    expect((wrapper.get('[data-testid="context-budget-option-524288"]').element as HTMLInputElement).checked)
      .toBe(true);
  });

  it("点档位立刻写服务端：带该会话的档位修订与所选档位，成功后回执确认", async () => {
    const onSaved = vi.fn();
    const fetchMock = stubSequence([(_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ expected_revision: "3", context_budget_tokens: 1048576 });
      return json({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: sessionId, context_budget_tokens: 1048576, revision: "4" } });
    }]);
    const wrapper = await mount(usage(), { onSaved });
    await wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    // 点下去就是一次写，不需要第二枚「保存」按钮。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="context-budget-notice"]').text()).toContain("1,048,576");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("连点两档只发出一条写：第二条不生成新命令", async () => {
    const fetchMock = stubSequence([(_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: sessionId, context_budget_tokens: body.context_budget_tokens,
          revision: "4" } });
    }]);
    const wrapper = await mount(usage());
    const first = wrapper.get('[data-testid="context-budget-option-262144"]')
      .element as HTMLInputElement;
    const second = wrapper.get('[data-testid="context-budget-option-1048576"]')
      .element as HTMLInputElement;
    // 两次点击落在同一帧：闸门必须是同步可见的 ref，不能只看渲染后的 disabled。
    first.click();
    second.click();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("历史调用与当前档位分开：历史按那次冻结的预算解释，档位另说", async () => {
    const wrapper = await mount(usage({
      budget: { tokens: 1_048_576, revision: "4" },
      nextCall: { reservationTokens: 1_048_576, contextBudgetTokens: 1_048_576,
        providerWindowTokens: null, windowSource: "UNKNOWN" },
    }));
    // 历史占比仍按那次调用冻结的 65,536 算，不拿当前 1024K 去除。
    expect(wrapper.get('[data-testid="assist-context-meter-percent"]').text()).toBe("16%");
    expect((wrapper.get('[data-testid="context-budget-option-1048576"]').element as HTMLInputElement).checked)
      .toBe(true);
    expect(wrapper.find('[data-testid="context-usage-history"]').exists()).toBe(true);
    // 两个数字不同时补一句口径说明：冻结预算解释历史，档位从下一次调用生效。
    const note = wrapper.get('[data-testid="context-usage-frozen-note"]').text();
    expect(note).toContain("这次调用冻结的 65,536");
    expect(note).toContain("1024K 从下一次调用生效");
  });

  it("冻结预算与档位一致时不补差异说明", async () => {
    const wrapper = await mount(usage({
      budget: { tokens: 524288, revision: "3" },
      lastCall: { ...usage().lastCall!, reservedTokens: 524288 },
    }));
    expect(wrapper.find('[data-testid="context-usage-frozen-note"]').exists()).toBe(false);
  });

  it("分项估算合计与 Provider 实报不同时写明两边口径", async () => {
    const wrapper = await mount(usage({
      lastCall: { ...usage().lastCall!, inputTokens: 5_549,
        breakdown: { ...usage().lastCall!.breakdown!, estimatedTotalTokens: 7_452 } },
    }));
    const note = wrapper.get('[data-testid="context-usage-estimate-note"]').text();
    expect(note).toContain("分项合计约 7,452");
    expect(note).toContain("Provider 本次实报输入 5,549");
  });

  it("估算合计与实报一致时不重复解释", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.find('[data-testid="context-usage-estimate-note"]').exists()).toBe(false);
  });

  it("档位区只留三档：不再渲染「当前档位」标题行与「下次调用申请」行", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.text()).not.toContain("当前档位");
    expect(wrapper.text()).not.toContain("下次调用申请");
    expect(wrapper.find('[data-testid="context-budget-current"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-budget-next"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="context-usage-tiers"]').findAll("input[type=radio]")).toHaveLength(3);
  });

  it("读序是最近一次模型调用 → 上下文构成 → 上下文档位，档位排在菜单最底部的停靠区", async () => {
    const wrapper = await mount(usage());
    const order = ["context-usage-history", "context-usage-breakdown", "context-budget-inline"]
      .map((id) => wrapper.get(`[data-testid="${id}"]`).element as HTMLElement);
    for (let i = 1; i < order.length; i += 1) {
      // compareDocumentPosition 的 FOLLOWING 位为真：DOM 顺序就是用户要的阅读顺序。
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
    // 停靠区是布局的参与者而不是覆盖层：档位区在滚动区之后，自己那一段里没有分项与错误提示。
    const dock = wrapper.get(".context-usage-dock").element as HTMLElement;
    const scroll = wrapper.get(".context-usage-scroll").element as HTMLElement;
    expect(dock.contains(wrapper.get('[data-testid="context-usage-tiers"]').element as Node)).toBe(true);
    expect(dock.contains(wrapper.get('[data-testid="context-usage-breakdown"]').element as Node)).toBe(false);
    expect(scroll.contains(dock)).toBe(false);
  });

  it("占比按那次调用冻结的预算解释；冻结预算缺失时写「预算未知」且不给百分比", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.get('[data-testid="assist-context-meter-percent"]').text()).toBe("16%");
    expect(wrapper.get('[data-testid="assist-context-meter-remaining"]').text()).toContain("54,929");
    expect(wrapper.get('[data-testid="assist-context-meter-output"]').text()).toContain("646");

    unmount?.(); unmount = null;
    const unknown = await mount(usage({ lastCall: { ...usage().lastCall!, reservedTokens: null } }));
    expect(unknown.get('[data-testid="assist-context-meter-budget-unknown"]').text())
      .toBe("预算未知");
    expect(unknown.find('[data-testid="assist-context-meter-percent"]').exists()).toBe(false);
    // 不拿当前档位（524,288）去除历史读数伪造一个百分比。
    expect(unknown.find('[data-testid="assist-context-meter-remaining"]').exists()).toBe(false);
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
    const legacy = await mount(usage({ lastCall: { ...usage().lastCall!, breakdown: null } }));
    expect(legacy.get('[data-testid="context-usage-breakdown-empty"]').text())
      .toContain("当前记录没有分项统计");
    expect(legacy.findAll('[data-testid^="context-usage-row-"]')).toHaveLength(0);
    // 旧数据没有分项，但总用量照常可读。
    expect(legacy.get('[data-testid="assist-context-meter-percent"]').text()).toBe("16%");
  });

  it("409 冲突不覆盖别人写入的值：重读最新档位并说明", async () => {
    const onReload = vi.fn();
    stubSequence([
      () => json({ code: "REVISION_CONFLICT", detail: "档位已变化。",
        conflict: { expected_revision: "3", actual_revision: "7" } }, 409),
    ]);
    const wrapper = await mount(usage(), { onReload });
    await wrapper.get('[data-testid="context-budget-option-262144"]').setValue(true);
    await flush();
    expect(wrapper.get('[data-testid="context-budget-conflict"]').text()).toContain("档位已被其他操作改动");
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("传输失败保留原 command_id 与载荷，可按原命令查回执", async () => {
    const saved: Record<string, unknown>[] = [];
    stubSequence([
      () => { throw new TypeError("Failed to fetch"); },
      (url, init) => {
        if (url.includes("/commands/")) {
          // 回执查询：按原 command_id 返回同一份结果。
          const commandId = url.slice(url.lastIndexOf("/") + 1);
          return json({ command_id: commandId, command_type: "SetSessionContextBudget",
            committed_at: "2026-10-30T00:00:00Z",
            result: { session_id: sessionId, context_budget_tokens: 262144, revision: "4" } });
        }
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        saved.push(body);
        return json({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
          result: { session_id: sessionId, context_budget_tokens: body.context_budget_tokens,
            revision: "4" } });
      },
    ]);
    const wrapper = await mount(usage());
    await wrapper.get('[data-testid="context-budget-option-262144"]').setValue(true);
    await flush();
    const pending = wrapper.get('[data-testid="context-budget-pending"]').text();
    expect(pending).toContain("保存结果待核对");
    expect(pending).toContain("原 command_id：");
    await wrapper.get('[data-testid="context-budget-receipt"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="context-budget-notice"]').text()).toContain("已核对");
    // 回执核对不产生新的写请求：档位没有被改第二次。
    expect(saved).toHaveLength(0);
  });

  it("没有模型调用时只说明，不画 0% 也不编分项", async () => {
    const wrapper = await mount(usage({ lastCall: null }));
    expect(wrapper.get('[data-testid="assist-context-meter-empty"]').text()).toContain("尚无模型调用");
    expect(wrapper.find('[data-testid="assist-context-meter-percent"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="context-usage-breakdown"]').exists()).toBe(false);
    // 档位选择仍然可用：空会话也要能先把档位定下来。
    expect(wrapper.findAll("input[type=radio]")).toHaveLength(3);
  });

  it("读取失败时显示原因与重读入口，不拿旧值顶替", async () => {
    const onReload = vi.fn();
    const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={sessionId}
      usage={null} loading={false} error="网络不可用" onReload={onReload} onSaved={() => {}} />);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="context-usage-error"]').text()).toContain("网络不可用");
    await mounted.wrapper.get('[data-testid="context-usage-error"] button').trigger("click");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(mounted.wrapper.find('[data-testid="assist-context-meter-percent"]').exists()).toBe(false);
  });

  it("还没有会话时：三档可选，选择落在新会话草稿作用域，不发任何写请求", async () => {
    const onDraftTierChange = vi.fn();
    const fetchMock = vi.fn(async () => json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={null}
      usage={null} loading={false} error={null} onReload={() => {}} onSaved={() => {}}
      draftTier={262144}
      onDraftTierChange={onDraftTierChange as (tier: 262144 | 524288 | 1048576) => void} />);
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.findAll("input[type=radio]")).toHaveLength(3);
    const checked = mounted.wrapper.get('[data-testid="context-budget-option-262144"]')
      .element as HTMLInputElement;
    expect(checked.checked).toBe(true);
    await mounted.wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    expect(onDraftTierChange).toHaveBeenCalledWith(1_048_576);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
