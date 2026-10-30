import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import type { RelaySessionContextUsage } from "../src/api/dtos/assist";
import ContextUsagePanel from "../src/components/ContextUsagePanel";
import { flush, mountReact } from "./mountApp";

/**
 * 0145 复审的三处 P0 边界（2026-10-30）。
 *
 * 三条边界的共同点：界面不得替服务端先说话。
 *   P0-A 空白新会话：显示**来源会话那一行**的档位；读不到就说待确认，不拿 256K 冒充继承；
 *   P0-B 空白新会话的草稿按会话分开（导航链路用例在 contextBudgetInheritance.spec.tsx）；
 *   P0-C 选档与保存分开：只有服务端回执才能让界面宣称「已生效」。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const client = new RelayApiClient({ baseUrl, workspaceId,
  bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function usage(tokens: 262_144 | 524_288 | 1_048_576 = 524_288): RelaySessionContextUsage {
  return { sessionId, budget: { tokens, revision: "3" }, lastCall: null };
}

async function mountPanel(data: RelaySessionContextUsage | null, handlers: {
  readonly onSaved?: () => void; readonly onReload?: () => void } = {}) {
  const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={sessionId}
    usage={data} loading={false} error={null}
    onReload={handlers.onReload ?? (() => {})} onSaved={handlers.onSaved ?? (() => {})} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

/** 空白新会话的浮层：没有会话，档位由建会话命令落库。 */
async function mountBlank(props: {
  readonly draftTier: 262_144 | 524_288 | 1_048_576 | null;
  readonly inheritedTier: 262_144 | 524_288 | 1_048_576 | null;
  readonly inheritState: "none" | "loading" | "ready" | "failed";
  readonly onRetryInherit?: () => void }) {
  const mounted = await mountReact(<ContextUsagePanel client={client} sessionId={null}
    usage={null} loading={false} error={null} onReload={() => {}} onSaved={() => {}}
    draftTier={props.draftTier} onDraftTierChange={() => {}}
    inheritedTier={props.inheritedTier} inheritState={props.inheritState}
    {...(props.onRetryInherit === undefined ? {} : { onRetryInherit: props.onRetryInherit })} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

function checkedTiers(wrapper: {
  findAll: (selector: string) => { element: Element | null }[] }): string[] {
  return wrapper.findAll("input[type=radio]")
    .filter((item) => (item.element as HTMLInputElement).checked)
    .map((item) => (item.element as HTMLInputElement).value);
}

function stubSequence(handlers: readonly ((url: string, init: RequestInit) => Response)[]) {
  let index = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(String(input), init ?? {});
  }));
}

describe("P0-A 空白新会话显示它真正会继承到的档位", () => {
  it("来源会话是 512K：浮层选中的就是 512K，不是缺省的 256K", async () => {
    const wrapper = await mountBlank({ draftTier: null, inheritedTier: 524_288, inheritState: "ready" });
    expect(checkedTiers(wrapper)).toEqual(["524288"]);
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("继承来源会话：512K");
  });

  it("读来源途中或读失败：一枚档位也不预选，失败给重读入口", async () => {
    const loading = await mountBlank({ draftTier: null, inheritedTier: null, inheritState: "loading" });
    expect(checkedTiers(loading)).toEqual([]);
    expect(loading.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("正在读取来源会话的档位");
    unmount?.(); unmount = null;

    const onRetryInherit = vi.fn();
    const failed = await mountBlank({ draftTier: null, inheritedTier: null, inheritState: "failed",
      onRetryInherit });
    expect(checkedTiers(failed)).toEqual([]);
    expect(failed.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("读不到来源会话的档位");
    await failed.get('[data-testid="context-usage-inherit-retry"]').trigger("click");
    expect(onRetryInherit).toHaveBeenCalledTimes(1);
  });
});

describe("P0-C 只有回执才能说「已生效」", () => {
  it("保存请求在途：状态行明说仍按旧档位生效，回执到了才改口", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return json({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: sessionId, context_budget_tokens: 1048576, revision: "4" } });
    }));
    const onSaved = vi.fn();
    const wrapper = await mountPanel(usage(), { onSaved });
    await wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("正在保存 1024K；确认之前仍按 512K 生效");
    expect(onSaved).not.toHaveBeenCalled();
    gate.release?.();
    await flush();
    await flush();
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text()).toContain("当前生效：1024K");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("409 冲突：没写成功的档位不当成生效值，且不重发", async () => {
    let writes = 0;
    const onReload = vi.fn();
    stubSequence([() => { writes += 1; return json({ code: "REVISION_CONFLICT", detail: "档位已变化。",
      conflict: { expected_revision: "3", actual_revision: "7" } }, 409); }]);
    const wrapper = await mountPanel(usage(), { onReload });
    await wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="context-budget-conflict"]').text()).toContain("档位已被其他操作改动");
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="context-usage-tier-state"]').text())
      .toContain("现在生效的是 512K");
    expect(writes, "冲突不自动重试写").toBe(1);
  });

  it("保存中不能改档也不能重发：一次只允许一个未确认的写", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return json({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: sessionId, context_budget_tokens: 1048576, revision: "4" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountPanel(usage());
    await wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await flush();
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect((wrapper.get('[data-testid="context-budget-option-262144"]').element as HTMLInputElement).disabled)
      .toBe(true);
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gate.release?.();
    await flush();
    await flush();
  });
});