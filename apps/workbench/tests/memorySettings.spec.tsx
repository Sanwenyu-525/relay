import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import MemorySettingsCard from "../src/components/MemorySettingsCard";
import { flush, mountReact } from "./mountApp";

/**
 * 设置页的记忆开关（工作台 §40）。
 *
 * 断言三件用户能看见的事实：初始状态来自服务端、保存提交的是两个开关与读回修订、
 * 冲突与未知结果不被说成「已保存」。组件内部不维护第二套默认值。
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

function settings(overrides: Record<string, unknown> = {}) {
  return { workspace_id: workspaceId, revision: "3", recall_enabled: true,
    automatic_compaction: true, auto_capture: true, ...overrides };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** 按调用顺序给 handler：读设置、保存、再读，各自可断言。 */
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
  const mounted = await mountReact(<MemorySettingsCard client={client} />);
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

describe("记忆设置的读取与保存", () => {
  it("初始状态读服务端：两个开关各自反映真实值，不按默认 true 铺开", async () => {
    const fetchMock = stubSequence([() => json(settings({ recall_enabled: false, automatic_compaction: true }))]);
    const wrapper = await mount();
    expect(String((fetchMock.mock.calls[0] as [RequestInfo | URL])[0])).toBe(`${root}/memory-settings`);
    expect((wrapper.get('[data-testid="memory-settings-recall"]').element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.get('[data-testid="memory-settings-compaction"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('[data-testid="memory-settings-revision"]').text()).toContain("v3");
  });

  it("读取失败时说明失败并给重读入口，不把空状态当成「两个开关都关」", async () => {
    stubSequence([() => json({ code: "DATABASE_UNAVAILABLE", detail: "库不可用" }, 503)]);
    const wrapper = await mount();
    expect(wrapper.get('[data-testid="memory-settings-error"]').text()).toContain("读取失败");
    expect(wrapper.find('[data-testid="memory-settings-recall"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="memory-settings-reload"]').exists()).toBe(false);
  });

  it("保存同时提交两个开关与读回的修订，成功后用服务端回执更新修订", async () => {
    const fetchMock = stubSequence([
      () => json(settings()),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ expected_revision: "3", recall_enabled: false,
          automatic_compaction: true, auto_capture: true });
        expect(typeof body.command_id).toBe("string");
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: settings({ revision: "4", recall_enabled: false }) });
      }
    ]);
    const wrapper = await mount();
    await wrapper.get('[data-testid="memory-settings-recall"]').setValue(false);
    await wrapper.get('[data-testid="memory-settings-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="memory-settings-revision"]').text()).toContain("v4");
    expect(wrapper.get('[data-testid="memory-settings-notice"]').text()).toContain("已保存");
    // 保存后两个开关一起回写：不能只更新被改的那一个，另一个仍是读回值。
    expect((wrapper.get('[data-testid="memory-settings-compaction"]').element as HTMLInputElement).checked).toBe(true);
  });

  it("第三个开关：自动记住默认读服务端值，关掉后提交 auto_capture=false", async () => {
    const fetchMock = stubSequence([
      () => json(settings({ auto_capture: true })),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ auto_capture: false, recall_enabled: true,
          automatic_compaction: true });
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: settings({ revision: "4", auto_capture: false }) });
      }
    ]);
    const wrapper = await mount();
    const toggle = wrapper.get('[data-testid="memory-settings-auto-capture"]');
    expect((toggle.element as HTMLInputElement).checked).toBe(true);
    await toggle.setValue(false);
    await wrapper.get('[data-testid="memory-settings-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="memory-settings-notice"]').text()).toContain("自动记住已关闭");
  });

  it("旧服务端不返回 auto_capture 时按开启显示，不谎称已关闭", async () => {
    const legacy = settings();
    delete (legacy as Record<string, unknown>).auto_capture;
    stubSequence([() => json(legacy)]);
    const wrapper = await mount();
    expect((wrapper.get('[data-testid="memory-settings-auto-capture"]').element as HTMLInputElement).checked)
      .toBe(true);
  });


  it("409 时重读基线并保留草稿，由用户决定按新修订保存还是丢弃", async () => {
    const fetchMock = stubSequence([
      () => json(settings()),
      () => json({ code: "REVISION_CONFLICT", detail: "配置已变更。",
        conflict: { expected_revision: "3", actual_revision: "5" } }, 409),
      () => json(settings({ revision: "5", recall_enabled: true, automatic_compaction: false })),
      (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ expected_revision: "5", recall_enabled: false,
          automatic_compaction: true, auto_capture: true });
        return json({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00.000Z",
          result: settings({ revision: "6", recall_enabled: false, automatic_compaction: true }) });
      }
    ]);
    const wrapper = await mount();
    await wrapper.get('[data-testid="memory-settings-recall"]').setValue(false);
    await wrapper.get('[data-testid="memory-settings-save"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="memory-settings-conflict"]').text()).toContain("保存冲突");
    // 重读后的基线是 v5，但用户改的那个开关仍是关——草稿没有被服务端值覆盖。
    expect(wrapper.get('[data-testid="memory-settings-revision"]').text()).toContain("v5");
    expect((wrapper.get('[data-testid="memory-settings-recall"]').element as HTMLInputElement).checked).toBe(false);
    await wrapper.get('[data-testid="memory-settings-conflict-save"]').trigger("click");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(wrapper.get('[data-testid="memory-settings-revision"]').text()).toContain("v6");
  });

  it("传输失败保留原 command_id 与载荷，只给查回执与原命令重试两个出口", async () => {
    const fetchMock = stubSequence([
      () => json(settings()),
      () => { throw new TypeError("Failed to fetch"); }
    ]);
    const wrapper = await mount();
    await wrapper.get('[data-testid="memory-settings-compaction"]').setValue(false);
    await wrapper.get('[data-testid="memory-settings-save"]').trigger("click");
    await flush();
    const pending = wrapper.get('[data-testid="memory-settings-pending"]').text();
    expect(pending).toContain("待核对");
    expect(pending).toMatch(/command_id：[0-9a-f-]{36}/u);
    // 未核对前不显示「已保存」，也不把开关当成已生效。
    expect(wrapper.find('[data-testid="memory-settings-notice"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="memory-settings-compaction"]').element as HTMLInputElement).checked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("查到的回执类型不是 SetMemorySettings 时明确拒绝，不当作保存已生效", async () => {
    stubSequence([
      () => json(settings()),
      () => { throw new TypeError("Failed to fetch"); },
      () => json({ command_id: "77777777-7777-4777-8777-777777777777",
        committed_at: "2026-10-20T00:00:00.000Z", command_type: "CreateMemory",
        result: { memory_id: workspaceId } })
    ]);
    const wrapper = await mount();
    await wrapper.get('[data-testid="memory-settings-recall"]').setValue(false);
    await wrapper.get('[data-testid="memory-settings-save"]').trigger("click");
    await flush();
    await wrapper.get('[data-testid="memory-settings-receipt"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="memory-settings-error"]').text()).toContain("不是记忆设置");
  });
});
