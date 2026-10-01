import { createElement, act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import InterventionNotifications from "../src/components/InterventionNotifications";
import AttentionQueue from "../src/components/AttentionQueue";
import AppShell from "../src/components/AppShell";
import type { RelayApiClient, RelayInterventionItem } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
const windowCalls = vi.hoisted(() => ({ isFocused: vi.fn(async () => false),
  show: vi.fn(async () => {}), unminimize: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowCalls }));

const item: RelayInterventionItem = { itemKey: "review:one", changeKey: "0",
  kind: "REVIEW", title: "待审批", reason: "请核对", targetUrl: "/reviews?id=one" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetRelayConnectionForTest(); windowCalls.isFocused.mockReset();
  windowCalls.isFocused.mockResolvedValue(false); windowCalls.show.mockClear();
  windowCalls.unminimize.mockClear(); windowCalls.setFocus.mockClear(); });

function LocationProbe() { const location = useLocation(); return createElement("span", {
  "data-testid": "notification-location" }, `${location.pathname}${location.search}`); }

describe("人工介入提醒聚合", () => {
  it("空队列仍有紧凑入口，只有显式点击才开启 Windows 通知", async () => {
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = "granted";
        return FakeNotification.permission;
      });
    }
    vi.stubGlobal("Notification", FakeNotification);
    const client = { getInterventions: async () => [] } as unknown as RelayApiClient;
    const mounted = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client })));
    try {
      await flush();
      const disclosure = mounted.wrapper.get('[data-testid="intervention-notifications"]').element as HTMLDetailsElement;
      const trigger = mounted.wrapper.get('[data-testid="intervention-notifications-open"]');
      expect(disclosure.open).toBe(false);
      expect(trigger.attributes("class")).toContain("icon-button");
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

      await trigger.trigger("click");
      expect(disclosure.open).toBe(true);
      const enable = mounted.wrapper.get('button[aria-label="开启 Windows 通知"]');
      expect(enable.attributes("title")).toBe("开启 Windows 通知");
      await enable.trigger("click");
      expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.text()).toContain("已允许 Windows 通知");
      expect(mounted.wrapper.find('button[aria-label="开启 Windows 通知"]').exists()).toBe(false);

      const summary = trigger.element as HTMLElement;
      summary.focus();
      await act(async () => { summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(disclosure.open).toBe(false);
      expect(document.activeElement).toBe(summary);
    } finally { mounted.unmount(); }
  });

  it("读取失败可展开查看，后续轮询成功恢复计数与原待处理入口", async () => {
    vi.useFakeTimers();
    const getInterventions = vi.fn().mockRejectedValueOnce(new Error("暂不可读取")).mockResolvedValue([item]);
    const client = { getInterventions } as unknown as RelayApiClient;
    const mounted = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client }), createElement(LocationProbe)));
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      const trigger = mounted.wrapper.get('[data-testid="intervention-notifications-open"]');
      expect(trigger.attributes("aria-label")).toContain("状态读取暂不可用");
      await trigger.trigger("click");
      expect(mounted.wrapper.get('[role="status"]').text()).toContain("人工介入状态暂不可刷新");

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(trigger.attributes("aria-label")).toContain("需人工介入 1 项");
      expect(mounted.wrapper.find('[role="status"]').exists()).toBe(false);
      await mounted.wrapper.get('a[href="/tasks?tab=attention"]').trigger("click");
      expect(mounted.wrapper.get('[data-testid="notification-location"]').text()).toBe("/tasks?tab=attention");
      expect((mounted.wrapper.get('[data-testid="intervention-notifications"]').element as HTMLDetailsElement).open).toBe(false);
    } finally { mounted.unmount(); }
  });

  it("应用通知入口挂在顶栏内，主内容前没有独立提示块", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace-test", bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    })));
    const mounted = await mountReact(createElement(MemoryRouter, {}, createElement(AppShell, {
      desktopStatus: "idle", commandOpen: false, onCommandOpen: vi.fn(), onCommandClose: vi.fn(),
      children: createElement("h1", {}, "当前工作")
    })));
    try {
      await flush();
      expect(mounted.wrapper.get('.app-topbar [data-testid="intervention-notifications"]').exists()).toBe(true);
      expect(mounted.wrapper.find('.app-content > [data-testid="intervention-notifications"]').exists()).toBe(false);
      expect(mounted.wrapper.find('.intervention-notifications-panel [role="status"]').exists()).toBe(false);
      expect(mounted.wrapper.get("main h1").text()).toBe("当前工作");
    } finally { mounted.unmount(); }
  });

  it("仅有必须介入事项时不显示空队列结论", async () => {
    const client = { getInterventions: async () => [{ ...item, itemKey: "run-failed:old",
      kind: "RUN_FAILED", title: "执行失败，需要人工核对", targetUrl: "/runs/old" }],
      getReviews: async () => [], getWorkspaceTasksPage: async () => ({ items: [{
        id: "task-one", title: "已人工接手的任务", status: "IN_PROGRESS", executor: "HUMAN",
        executorRunId: null, unresolvedBlockerIds: [], waitingReason: null,
      }], nextCursor: null }) } as unknown as RelayApiClient;
    const mounted = await mountReact(createElement(MemoryRouter, {},
      createElement(AttentionQueue, { client })));
    try {
      await flush();
      expect(mounted.wrapper.get('[data-testid="required-interventions"]').text()).toContain("必须介入 · 1");
      expect(mounted.wrapper.text()).not.toContain("当前读取范围内没有待处理项");
    } finally { mounted.unmount(); }
  });

  it("失焦后默认等待 3 秒才认领，并保留应用内事项", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => [item]);
    const settle = vi.fn(async () => undefined);
    const client = { getInterventions: async () => [item],
      claimInterventionNotifications: claim, settleInterventionNotification: settle } as unknown as RelayApiClient;
    const notifications: { title: string; body: string }[] = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body ?? "" });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const mounted = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mounted.wrapper.text()).toContain("需人工介入 1 项");
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(claim).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(notifications).toEqual([{ title: "待审批", body: "请核对" }]);
    expect(settle).toHaveBeenCalledWith(item, "DISPATCHED");
    mounted.unmount();
  });

  it("前台不认领系统通知，失焦后单项点击恢复窗口并进入原入口", async () => {
    vi.useFakeTimers();
    windowCalls.isFocused.mockResolvedValueOnce(true).mockResolvedValue(false);
    const claim = vi.fn(async () => [item]);
    const client = { getInterventions: async () => [item],
      claimInterventionNotifications: claim,
      settleInterventionNotification: vi.fn(async () => undefined) } as unknown as RelayApiClient;
    let clicked: (() => void) | null = null;
    class FakeNotification {
      static permission = "granted";
      set onclick(handler: (() => void) | null) { clicked = handler; }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const mounted = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client }), createElement(LocationProbe)));
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(claim).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(claim).toHaveBeenCalledTimes(1);
      expect(clicked).not.toBeNull();
      await act(async () => { clicked?.(); await Promise.resolve(); await Promise.resolve(); });
      expect(windowCalls.show).toHaveBeenCalledTimes(1);
      expect(windowCalls.unminimize).toHaveBeenCalledTimes(1);
      expect(windowCalls.setFocus).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.get('[data-testid="notification-location"]').text()).toBe("/reviews?id=one");
    } finally { mounted.unmount(); }
  });

  it("多项聚合点击进入待处理列表，通知拒绝时应用内事项仍可见", async () => {
    vi.useFakeTimers();
    const second = { ...item, itemKey: "run:two", kind: "RUN_FAILED" as const,
      targetUrl: "/runs/two" };
    const claim = vi.fn(async () => [item, second]);
    const settle = vi.fn(async () => undefined);
    const client = { getInterventions: async () => [item, second],
      claimInterventionNotifications: claim, settleInterventionNotification: settle } as unknown as RelayApiClient;
    let clicked: (() => void) | null = null;
    const titles: string[] = [];
    class FakeNotification {
      static permission = "granted";
      set onclick(handler: (() => void) | null) { clicked = handler; }
      constructor(title: string) { titles.push(title); }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const mounted = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client }), createElement(LocationProbe)));
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(titles).toEqual(["2 个事项需要你处理"]);
      expect(settle).toHaveBeenCalledWith(item, "DISPATCHED");
      expect(settle).toHaveBeenCalledWith(second, "DISPATCHED");
      await act(async () => { clicked?.(); await Promise.resolve(); });
      expect(mounted.wrapper.get('[data-testid="notification-location"]').text()).toBe("/tasks?tab=attention");
      expect(mounted.wrapper.text()).toContain("需人工介入 2 项");
    } finally { mounted.unmount(); }
    FakeNotification.permission = "denied";
    const denied = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client })));
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(denied.wrapper.text()).toContain("需人工介入 2 项");
      expect(settle).toHaveBeenCalledWith(item, "DENIED");
      expect(settle).toHaveBeenCalledWith(second, "DENIED");
    } finally { denied.unmount(); }
    class FailingNotification {
      static permission = "granted";
      constructor() { throw new Error("notification unavailable"); }
    }
    vi.stubGlobal("Notification", FailingNotification);
    const failed = await mountReact(createElement(MemoryRouter, {},
      createElement(InterventionNotifications, { client })));
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(failed.wrapper.text()).toContain("需人工介入 2 项");
      expect(settle).toHaveBeenCalledWith(item, "FAILED");
      expect(settle).toHaveBeenCalledWith(second, "FAILED");
    } finally { failed.unmount(); }
  });
});
