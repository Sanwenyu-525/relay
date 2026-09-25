import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { mountWorkbench } from "./mountApp";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn()
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => undefined, destroy: async () => undefined })
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
    expect(mounted.wrapper.find('[data-testid="relay-connection-open"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="project-create-open"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("示例数据");
  });
});
