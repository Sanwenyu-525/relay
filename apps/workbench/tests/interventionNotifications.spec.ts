import { createElement, act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import InterventionNotifications from "../src/components/InterventionNotifications";
import AttentionQueue from "../src/components/AttentionQueue";
import type { RelayApiClient, RelayInterventionItem } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
const windowCalls = vi.hoisted(() => ({ isFocused: vi.fn(async () => false),
  show: vi.fn(async () => {}), unminimize: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowCalls }));

const item: RelayInterventionItem = { itemKey: "review:one", changeKey: "0",
  kind: "REVIEW", title: "待审批", reason: "请核对", targetUrl: "/reviews?id=one" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); windowCalls.isFocused.mockReset();
  windowCalls.isFocused.mockResolvedValue(false); windowCalls.show.mockClear();
  windowCalls.unminimize.mockClear(); windowCalls.setFocus.mockClear(); });

function LocationProbe() { const location = useLocation(); return createElement("span", {
  "data-testid": "notification-location" }, `${location.pathname}${location.search}`); }

describe("人工介入提醒聚合", () => {
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
