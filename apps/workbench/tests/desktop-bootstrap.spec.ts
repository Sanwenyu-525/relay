import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn()
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => undefined,
    onResized: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    isMaximized: async () => false,
    startDragging: async () => undefined,
    toggleMaximize: async () => undefined,
    minimize: async () => undefined,
    close: async () => undefined,
    destroy: async () => undefined
  })
}));

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.mocked(invoke).mockReset();
  vi.unstubAllGlobals();
  resetRelayConnectionForTest();
});

describe("桌面引导失败", () => {
  it("bootstrap 被宿主拒绝时只显示阻断页，不进入可操作示例工作台", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("desktop API is no longer running"));
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="desktop-service-unavailable"]').text()).toContain("重新启动 Relay Agent");
    expect(mounted.wrapper.find('[data-testid="desktop-titlebar"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="relay-connection-open"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="project-create-open"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("示例数据");
  });

  it("bootstrap 成功但浏览器 readiness 失败时同样阻断", async () => {
    vi.mocked(invoke).mockResolvedValue({
      baseUrl: "http://127.0.0.1:5774", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token"
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const mounted = await mountWorkbench("/projects");
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="desktop-service-unavailable"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="desktop-titlebar"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="relay-connection-open"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="project-create-open"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("示例数据");
  });
});

it("桌面标题栏搜索打开原命令面板，应用顶栏不重复显示搜索按钮", async () => {
  vi.mocked(invoke).mockResolvedValue({
    baseUrl: "http://127.0.0.1:5774", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token"
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const ready = String(input).endsWith("/health/ready");
    return new Response(JSON.stringify(ready ? { status: "ready" } : { code: "TEST_OFFLINE" }), {
      status: ready ? 200 : 503,
      headers: { "Content-Type": "application/json" }
    });
  }));
  const mounted = await mountWorkbench("/today");
  unmount = mounted.unmount;
  expect(mounted.wrapper.get('[data-testid="titlebar-search"]').exists()).toBe(true);
  await mounted.wrapper.get('[data-testid="titlebar-search"]').trigger("click");
  expect(document.querySelector('[data-testid="command-palette"]')).not.toBeNull();
  expect(mounted.wrapper.get('[data-testid="command-open"]').attributes("class")).toContain("app-topbar__command-open");
});

it("标题栏后退遵守新建任务未保存草稿保护", async () => {
  vi.mocked(invoke).mockResolvedValue({
    baseUrl: "http://127.0.0.1:5774", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token"
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const ready = String(input).endsWith("/health/ready");
    return new Response(JSON.stringify(ready ? { status: "ready" } : { code: "TEST_OFFLINE" }), {
      status: ready ? 200 : 503,
      headers: { "Content-Type": "application/json" }
    });
  }));
  const mounted = await mountWorkbench("/today");
  unmount = mounted.unmount;
  await mounted.wrapper.get('[data-testid="titlebar-create-task"]').trigger("click");
  await flush();
  expect(mounted.router.currentRoute.value.path).toBe("/tasks");
  await mounted.wrapper.get('input[name="task-title"]').setValue("保留草稿");
  await mounted.wrapper.get('[data-testid="titlebar-back"]').trigger("click");
  expect(document.querySelector('[role="dialog"][aria-label="保留未保存的修改"]')).not.toBeNull();
  expect(mounted.router.currentRoute.value.path).toBe("/tasks");
  const keep = document.querySelector<HTMLButtonElement>('[role="dialog"][aria-label="保留未保存的修改"] .secondary-button');
  await keep?.click();
  expect(mounted.wrapper.get('input[name="task-title"]').attributes("value")).toBe("保留草稿");
});
