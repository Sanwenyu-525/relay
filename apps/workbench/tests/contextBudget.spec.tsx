import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import ContextBudgetCard from "../src/components/ContextBudgetCard";
import { flush, mountReact } from "./mountApp";

/**
 * 设置页的上下文长度三档（0135 / P1-A）。
 *
 * 断言用户能看见的事实：初始档位来自服务端投影、保存提交的是同一行修订与所选档位、
 * 冲突时重读最新修订但保留用户选择（不把服务端值当成用户已改回）。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function directory(contextBudgetTokens: number | null, revision: string) {
  return { status: "UNSET", resource_id: null, canonical_root: null, display_name: null,
    write_tier: null, default_write_tier: null, context_budget_tokens: contextBudgetTokens,
    reason: null, revision };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubSequence(handlers: readonly Handler[]) {
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(String(input), init ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function mount() {
  const mounted = await mountReact(<ContextBudgetCard client={client} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

describe("上下文长度档位的读取与保存", () => {
  it("圆环紧凑入口共用保存流程，保存后通知读数刷新", async () => {
    const onSaved = vi.fn();
    stubSequence([
      () => json(directory(262144, "2")),
      (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ expected_revision: "2", context_budget_tokens: 1048576 });
        return json({ command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
          result: { workspace_id: workspaceId, context_budget_tokens: 1048576, revision: "3" } });
      },
      () => json(directory(1048576, "3")),
    ]);
    const mounted = await mountReact(<ContextBudgetCard client={client} compact onSaved={onSaved} />);
    unmount = mounted.unmount;
    await flush();
    const wrapper = mounted.wrapper;
    expect(wrapper.get('[data-testid="context-budget-inline"]').text()).toContain("上下文档位");
    expect(wrapper.find(".settings-card").exists()).toBe(false);
    await wrapper.get('[data-testid="context-budget-option-1048576"]').setValue(true);
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect((wrapper.get('[data-testid="context-budget-option-1048576"]').element as HTMLInputElement).checked)
      .toBe(true);
  });

  it.each([262144, 524288, 1048576] as const)("三档可选择并读回：%s", async (tokens) => {
    stubSequence([() => json(directory(tokens, "3"))]);
    const wrapper = await mount();
    expect(wrapper.text()).toContain("256K");
    expect(wrapper.text()).toContain("512K");
    expect(wrapper.text()).toContain("1024K");
    expect(wrapper.text()).toContain("自动压缩");
    expect((wrapper.get(`[data-testid="context-budget-option-${tokens}"]`).element as HTMLInputElement).checked)
      .toBe(true);
  });

  it("初始档位读服务端投影：未选择时选「跟随应用默认」，并显示当前修订", async () => {
    const fetchMock = stubSequence([() => json(directory(null, "2"))]);
    const wrapper = await mount();
    expect(String((fetchMock.mock.calls[0] as [RequestInfo | URL])[0]))
      .toBe(`${root}/default-working-directory`);
    expect((wrapper.get('[data-testid="context-budget-option-default"]').element as HTMLInputElement).checked)
      .toBe(true);
    expect(wrapper.get('[data-testid="context-budget-revision"]').text()).toContain("v2");
    expect((wrapper.get('[data-testid="context-budget-save"]').element as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("保存提交所选档位与读回修订；成功后按回执显示并重读同一投影", async () => {
    const fetchMock = stubSequence([
      () => json(directory(262_144, "2")),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ expected_revision: "2", context_budget_tokens: 524_288 });
        expect(typeof body.command_id).toBe("string");
        return json({ command_id: body.command_id, committed_at: "2026-10-24T00:00:00.000Z",
          result: { workspace_id: workspaceId, context_budget_tokens: 524_288, revision: "3" } });
      },
      () => json(directory(524_288, "3")),
    ]);
    const wrapper = await mount();
    expect((wrapper.get('[data-testid="context-budget-option-262144"]').element as HTMLInputElement).checked)
      .toBe(true);
    await wrapper.get('[data-testid="context-budget-option-524288"]').setValue(true);
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-testid="context-budget-notice"]').text()).toContain("524,288");
    expect(wrapper.get('[data-testid="context-budget-revision"]').text()).toContain("v3");
    expect((wrapper.get('[data-testid="context-budget-option-524288"]').element as HTMLInputElement).checked)
      .toBe(true);
  });

  it("冲突时重读最新修订但不覆盖用户选择；随后可按新修订保存", async () => {
    const fetchMock = stubSequence([
      () => json(directory(262_144, "2")),
      () => json({ code: "REVISION_CONFLICT", detail: "配置已变更。",
        conflict: { expected_revision: "2", actual_revision: "5" } }, 409),
      () => json(directory(1_048_576, "5")),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ expected_revision: "5", context_budget_tokens: 524_288 });
        return json({ command_id: body.command_id, committed_at: "2026-10-24T00:00:00.000Z",
          result: { workspace_id: workspaceId, context_budget_tokens: 524_288, revision: "6" } });
      },
      () => json(directory(524_288, "6")),
    ]);
    const wrapper = await mount();
    await wrapper.get('[data-testid="context-budget-option-524288"]').setValue(true);
    await wrapper.get('[data-testid="context-budget-save"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="context-budget-conflict"]').text()).toContain("保存冲突");
    expect(wrapper.get('[data-testid="context-budget-revision"]').text()).toContain("v5");
    // 重读只更新基线修订，用户选的 512K 仍是草稿——不能被服务端现在的 1M 改回去。
    expect((wrapper.get('[data-testid="context-budget-option-524288"]').element as HTMLInputElement).checked)
      .toBe(true);
    await wrapper.get('[data-testid="context-budget-conflict-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(wrapper.get('[data-testid="context-budget-revision"]').text()).toContain("v6");
  });
});
