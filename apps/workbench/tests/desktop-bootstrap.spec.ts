import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../src/lib/draftGuard";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 关窗守卫需要真正拿到宿主注册的事件回调，否则「窗口关闭是否被拦」这一层永远是空跑。
 * 未保存事实本身怎么产生（附件、技能输入）由 collaborationWorkspace 的离页保护族锁住；
 * 这里锁的是宿主事件 → hasUnsavedDraft → 确认弹层 → 明确丢弃后才 destroy 这条链。
 */
const tauriWindow = vi.hoisted(() => ({
  closeHandler: null as null | ((event: { preventDefault: () => void }) => void),
  destroyed: 0
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn()
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: { preventDefault: () => void }) => void) => {
      tauriWindow.closeHandler = handler;
      return () => { tauriWindow.closeHandler = null; };
    },
    onResized: async () => () => undefined,
    onFocusChanged: async () => () => undefined,
    isMaximized: async () => false,
    startDragging: async () => undefined,
    toggleMaximize: async () => undefined,
    minimize: async () => undefined,
    close: async () => undefined,
    destroy: async () => { tauriWindow.destroyed += 1; }
  })
}));

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  tauriWindow.closeHandler = null;
  tauriWindow.destroyed = 0;
  vi.mocked(invoke).mockReset();
  vi.unstubAllGlobals();
  resetRelayConnectionForTest();
});

function stubOfflineDesktop(): void {
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
}

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
  expect(mounted.wrapper.find('.desktop-titlebar [data-testid="titlebar-search"]').exists()).toBe(true);
  expect(mounted.wrapper.find('.app-topbar [data-testid="titlebar-search"]').exists()).toBe(false);
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

it("窗口关闭请求遵守未保存保护：先拦住并弹确认，明确丢弃后才销毁窗口", async () => {
  stubOfflineDesktop();
  const mounted = await mountWorkbench("/today");
  unmount = mounted.unmount;
  await flush();
  if (tauriWindow.closeHandler === null) throw new Error("宿主关窗回调没有注册（onCloseRequested 未被调用）");
  const closeRequested = tauriWindow.closeHandler;

  // 未保存事实用一份合成守卫表示：它代表 AssistView 投影进 unsaved 的暂存附件
  // （附件 → unsaved → 同一 hasUnsavedDraft 的投影链由 collaborationWorkspace 的离页保护族锁住）。
  let discarded = 0;
  const guard: DraftGuard = { hasUnsavedChanges: () => true, discard: () => { discarded += 1; } };
  setDraftGuard(guard);
  try {
    let prevented = 0;
    await act(async () => { closeRequested({ preventDefault: () => { prevented += 1; } }); });
    await flush();
    expect(prevented).toBe(1);
    expect(tauriWindow.destroyed).toBe(0);
    expect(document.querySelector('[role="dialog"][aria-label="保留未保存的修改"]')).not.toBeNull();

    // 保留并继续编辑：弹层关闭，守卫不丢内容，窗口不销毁。
    const keep = Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent === "保留并继续编辑");
    if (keep === undefined) throw new Error("关窗弹层没有「保留并继续编辑」按钮");
    await act(async () => { keep.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="dialog"][aria-label="保留未保存的修改"]')).toBeNull();
    expect(discarded).toBe(0);
    expect(tauriWindow.destroyed).toBe(0);

    // 丢弃草稿并关闭：先清守卫，再放行销毁。
    await act(async () => { closeRequested({ preventDefault: () => { prevented += 1; } }); });
    await flush();
    const discard = Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent === "丢弃草稿并关闭");
    if (discard === undefined) throw new Error("关窗弹层没有「丢弃草稿并关闭」按钮");
    await act(async () => { discard.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    await flush();
    expect(discarded).toBe(1);
    expect(tauriWindow.destroyed).toBe(1);
    // 用户已明确选择丢弃：同一次关窗意图不再被反复拦住。
    const before = prevented;
    await act(async () => { closeRequested({ preventDefault: () => { prevented += 1; } }); });
    expect(prevented).toBe(before);
  } finally {
    clearDraftGuard(guard);
  }
});

it.each([true, false])("关窗提示按待核对命令能否跨重启恢复说明风险（可恢复=%s）", async (durable) => {
  stubOfflineDesktop();
  const mounted = await mountWorkbench("/today"); unmount = mounted.unmount; await flush();
  const closeRequested = tauriWindow.closeHandler;
  if (closeRequested === null) throw new Error("宿主关窗回调没有注册");
  const guard: DraftGuard = { hasUnsavedChanges: () => true, discard: () => {},
    pendingCommandId: () => "original-command", pendingRecoversAfterLeave: () => durable,
    pendingRecoversAfterRestart: () => durable };
  setDraftGuard(guard);
  try {
    await act(async () => { closeRequested({ preventDefault: () => {} }); }); await flush();
    const dialog = document.querySelector('[role="dialog"][aria-label="命令结果待核对"]');
    expect(dialog?.textContent).toContain("original-command");
    expect(dialog?.textContent).toContain(durable ? "重新打开后返回原工作空间" : "核对入口可能无法恢复");
    expect(tauriWindow.destroyed).toBe(0);
  } finally { clearDraftGuard(guard); }
});
