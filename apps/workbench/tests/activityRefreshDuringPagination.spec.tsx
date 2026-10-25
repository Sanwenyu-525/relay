import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 动态页续页与刷新的竞争（禅道 #132）。
 *
 * 锁两件事：
 *   * 续页在途时刷新：旧回包被版本守卫丢弃后，新列表必须能继续加载，Loading 不得卡死；
 *   * 旧续页的迟到 finally 不得解除新一轮续页的在途 Loading。
 */
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200,
  headers: { "content-type": "application/json" } });

function activity(id: string) {
  return { id, created_at: "2026-10-23T00:00:00Z", actor_kind: "SYSTEM", actor_ref: "system",
    command_id: null, event_type: "PROBE_EVENT", summary: id, project_id: null, task_id: null,
    run_id: null, entity_refs: [] };
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === text);
}

async function mountActivity() {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787",
    workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
  return mountWorkbench("/activity");
}

describe("动态页刷新与续页竞争", () => {
  it("续页在途时刷新：旧回包丢弃后新列表可继续加载，Loading 不卡死", async () => {
    let firstReads = 0;
    let resolveOld: ((value: Response) => void) | undefined;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/activities")) return json({ items: [], next_cursor: null });
      const cursor = url.searchParams.get("cursor");
      calls.push(cursor ?? "FIRST");
      if (cursor === "old-page")
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      if (cursor === "new-page") return json({ items: [activity("new-page-item")], next_cursor: null });
      firstReads++;
      return json({ items: [activity(firstReads === 1 ? "initial-item" : "refreshed-item")],
        next_cursor: firstReads === 1 ? "old-page" : "new-page" });
    }));
    const mounted = await mountActivity();
    try {
      await act(async () => { findButton("继续加载")!.click(); });
      await flush();
      expect(resolveOld).toBeDefined();
      const refresh = findButton("刷新当前范围")!;
      expect(refresh.disabled).toBe(false);
      await act(async () => { refresh.click(); });
      await flush();
      expect(mounted.wrapper.find('[data-testid="activity-basis-refreshed-item"]').exists()).toBe(true);
      // 旧回包迟到落定：被版本守卫丢弃，不得串入新首页。
      await act(async () => { resolveOld!(json({ items: [activity("old-page-item")], next_cursor: null })); });
      await flush();
      expect(mounted.wrapper.find('[data-testid="activity-basis-old-page-item"]').exists()).toBe(false);
      // Loading 已随新首页查询重置：按钮可继续加载新游标之后的记录。
      const more = findButton("继续加载");
      expect(more).toBeDefined();
      expect(more!.disabled).toBe(false);
      await act(async () => { more!.click(); });
      await flush();
      expect(mounted.wrapper.find('[data-testid="activity-basis-new-page-item"]').exists()).toBe(true);
    } finally { mounted.unmount(); }
  });

  it("旧续页迟到结束时不得解除新一轮续页的在途 Loading", async () => {
    let firstReads = 0;
    let resolveOld: ((value: Response) => void) | undefined;
    let resolveNew: ((value: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/activities")) return json({ items: [], next_cursor: null });
      const cursor = url.searchParams.get("cursor");
      if (cursor === "old-page")
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      if (cursor === "new-page")
        return new Promise<Response>((resolve) => { resolveNew = resolve; });
      firstReads++;
      return json({ items: [activity(firstReads === 1 ? "initial-item" : "refreshed-item")],
        next_cursor: firstReads === 1 ? "old-page" : "new-page" });
    }));
    const mounted = await mountActivity();
    try {
      await act(async () => { findButton("继续加载")!.click(); });
      await flush();
      await act(async () => { findButton("刷新当前范围")!.click(); });
      await flush();
      expect(mounted.wrapper.find('[data-testid="activity-basis-refreshed-item"]').exists()).toBe(true);
      // 新一轮续页已在途：此刻旧回包迟到落定，它的 finally 因版本失效不得解除新 Loading。
      await act(async () => { findButton("继续加载")!.click(); });
      await flush();
      expect(findButton("正在读取后续页")).toBeDefined();
      await act(async () => { resolveOld!(json({ items: [activity("old-page-item")], next_cursor: null })); });
      await flush();
      expect(findButton("正在读取后续页")).toBeDefined();
      expect(mounted.wrapper.find('[data-testid="activity-basis-old-page-item"]').exists()).toBe(false);
      // 新回包落定后才收口：新条目追加，Loading 恢复。
      await act(async () => { resolveNew!(json({ items: [activity("new-page-item")], next_cursor: null })); });
      await flush();
      expect(findButton("正在读取后续页")).toBeUndefined();
      expect(mounted.wrapper.find('[data-testid="activity-basis-new-page-item"]').exists()).toBe(true);
    } finally { mounted.unmount(); }
  });
});
