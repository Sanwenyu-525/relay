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
    expect(wrapper.text()).toContain("本会话独立保存，新会话继承上一会话的选择。");
  });

  it("选档与保存分开：单选组只改已选值，「保存档位」才写服务端", async () => {
    const wrapper = await mount(usage());
    expect(wrapper.find('[data-testid="context-budget-save"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="context-budget-reload"]').exists()).toBe(true);
    // 没动过选择时：状态行说的是服务端已保存的档位，而不是某一枚按钮。
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("当前生效：512K");
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
    // 只选不保存：一个写请求都不发，界面也不宣称已经切换。
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("尚未保存；现在生效的是 512K");
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="context-budget-notice"]').text()).toContain("1,048,576");
    expect(onSaved).toHaveBeenCalledTimes(1);
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
      .toContain("暂无分项统计");
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
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
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
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
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
