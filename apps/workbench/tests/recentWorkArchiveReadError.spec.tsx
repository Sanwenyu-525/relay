import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecentWorkRail from "../src/components/RecentWorkRail";
import { RelayApiClient } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 左栏「已归档」首次读取失败后的状态表达（禅道 #134）。
 *
 * 归档段按需读取：展开才读、失败只影响这一段。已结束的失败请求必须把错误如实显示出来，
 * 不能落回「展开时读取归档列表」的未读占位，也不能把失败写成 [] 冒充「暂无归档会话」；
 * 失败给只读重试（与收起再展开等效），活跃列表不被归档错误清空。
 * 重复 toggle 与迟到旧回包由请求版本守卫收敛，不引发请求风暴。
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function unavailable(detail: string): Response {
  return json({ status: 503, code: "DATABASE_UNAVAILABLE", title: "数据库暂不可用", detail,
    retryable: true, retry_action: "RETRY" }, 503);
}

function session(id: string, title: string, status: "ACTIVE" | "ARCHIVED") {
  return { id, project_id: null, task_id: null, title, status, revision: "1", pinned_at: null,
    unread_at: null, last_message_at: "2026-10-20T08:00:00Z", has_messages: true,
    created_at: "2026-10-20T08:00:00Z", updated_at: "2026-10-20T08:00:00Z", conversation_mode: "AGENT" };
}

/** 真实 Client + 受控 fetch：活跃清单恒返回一条，归档段由 `archived` 决定每次的结果。 */
async function mountRail(archived: () => Response | Promise<Response>) {
  let archiveReads = 0;
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/assist-sessions")) {
      if (url.searchParams.get("status") === "ARCHIVED") {
        archiveReads += 1;
        return archived();
      }
      return json({ items: [session("s-active", "留下的讨论", "ACTIVE")], next_cursor: null });
    }
    return json({ items: [], next_cursor: null });
  });
  vi.stubGlobal("fetch", fetchStub);
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787",
    workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
  const mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(RecentWorkRail, { client, currentTaskId: null })));
  await flush();
  const section = () => mounted.wrapper.get('[data-testid="recent-work-archived"]').element as HTMLDetailsElement;
  /** 与真实披露控件同一触发方式：原生 toggle 事件。 */
  async function toggle(open: boolean) {
    await act(async () => {
      section().open = open;
      section().dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await flush(0);
  }
  return { mounted, section, toggle, reads: () => archiveReads };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("归档列表读取失败的表达与恢复（禅道 #134）", () => {
  it("首次读取503后显示原因与重试入口，不落回未读占位，活跃列表不受影响", async () => {
    let failing = true;
    const rail = await mountRail(() => failing ? unavailable("archive read unavailable")
      : json({ items: [session("s-archived", "早先归档的讨论", "ARCHIVED")], next_cursor: null }));
    try {
      await rail.toggle(true);
      expect(rail.reads()).toBeGreaterThan(0);
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')?.textContent)
        .toContain("数据库不可达");
      // 失败不冒充「还没展开」的占位，也不冒充「暂无归档会话」。
      expect(rail.section().textContent).not.toContain("展开时读取归档列表");
      expect(rail.section().textContent).not.toContain("暂无归档会话");
      // 错误只影响归档段：活跃会话行照常在列。
      expect(document.querySelector('[data-testid="recent-work-s-active"]')).not.toBeNull();
      // 失败后的只读重试：恢复后归档行回到这一段，错误消失。
      failing = false;
      await act(async () => {
        (document.querySelector('[data-testid="recent-work-archived-retry"]') as HTMLButtonElement).click();
      });
      await flush(0);
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')).toBeNull();
      expect(document.querySelector('[data-testid="recent-work-s-archived"]')?.textContent).toContain("早先归档的讨论");
      expect(rail.section().querySelector(".recent-work-group-count")?.textContent).toBe("1");
    } finally { rail.mounted.unmount(); }
  });

  it("连续失败可再次重试，成功前错误一直在；重试之外不自动重读", async () => {
    let reads = 0;
    const rail = await mountRail(() => {
      reads += 1;
      return reads <= 2 ? unavailable("archive read unavailable")
        : json({ items: [], next_cursor: null });
    });
    try {
      await rail.toggle(true);
      expect(rail.reads()).toBe(1);
      await act(async () => {
        (document.querySelector('[data-testid="recent-work-archived-retry"]') as HTMLButtonElement).click();
      });
      await flush(0);
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')).not.toBeNull();
      expect(rail.reads()).toBe(2);
      await act(async () => {
        (document.querySelector('[data-testid="recent-work-archived-retry"]') as HTMLButtonElement).click();
      });
      await flush(0);
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')).toBeNull();
      expect(rail.section().textContent).toContain("暂无归档会话");
      expect(rail.reads()).toBe(3);
      // 不点击就不再读：重试是显式入口，不是轮询。
      await flush(80);
      expect(rail.reads()).toBe(3);
    } finally { rail.mounted.unmount(); }
  });

  it("健康空列表读「暂无归档会话」，与失败文案分开", async () => {
    const rail = await mountRail(() => json({ items: [], next_cursor: null }));
    try {
      await rail.toggle(true);
      expect(rail.section().textContent).toContain("暂无归档会话");
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')).toBeNull();
    } finally { rail.mounted.unmount(); }
  });

  it("重复开合每次展开最多各读一次，读取中重开不叠加请求", async () => {
    let release!: (response: Response) => void;
    const gated = new Promise<Response>((resolve) => { release = resolve; });
    let reads = 0;
    const rail = await mountRail(() => {
      reads += 1;
      // 第一次请求停在在途：随后的重开不应叠加第二趟。
      return reads === 1 ? gated : unavailable("archive read unavailable");
    });
    try {
      await rail.toggle(true);
      await rail.toggle(false);
      await rail.toggle(true);
      expect(rail.reads()).toBe(1);
      // 在途请求以失败收场：错误如实显示，可再读（收起再展开与重试等效）。
      await act(async () => { release(unavailable("archive read unavailable")); });
      await flush(0);
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')).not.toBeNull();
      expect(rail.reads()).toBe(1);
      await rail.toggle(false);
      await rail.toggle(true);
      expect(rail.reads()).toBe(2);
    } finally { rail.mounted.unmount(); }
  });

  it("读取中收起后迟到的回包如实落位：成功落行、失败落错误，重开不重复读", async () => {
    // 成功回包迟到：读取中收起，数据回来后这一段照常拥有它；重开不再发第二趟。
    let releaseOk!: (response: Response) => void;
    const okGate = new Promise<Response>((resolve) => { releaseOk = resolve; });
    const successRail = await mountRail(() => okGate);
    try {
      await successRail.toggle(true);
      await successRail.toggle(false);
      await act(async () => {
        releaseOk(json({ items: [session("s-late", "迟到的归档讨论", "ARCHIVED")], next_cursor: null }));
      });
      await flush(0);
      await successRail.toggle(true);
      expect(document.querySelector('[data-testid="recent-work-s-late"]')).not.toBeNull();
      expect(successRail.reads()).toBe(1);
    } finally { successRail.mounted.unmount(); }
    // 失败回包迟到：仍收起时错误已记录，重开如实显示失败（并按需再读一次），不落回未读占位。
    let releaseFail!: (response: Response) => void;
    const failGate = new Promise<Response>((resolve) => { releaseFail = resolve; });
    const failRail = await mountRail(() => failGate);
    try {
      await failRail.toggle(true);
      await failRail.toggle(false);
      await act(async () => { releaseFail(unavailable("late archive failure")); });
      await flush(0);
      await failRail.toggle(true);
      expect(document.querySelector('[data-testid="recent-work-archived-error"]')).not.toBeNull();
      expect(failRail.section().textContent).not.toContain("展开时读取归档列表");
      // 重开按需再读了一次（归档段从未成功过），回包仍是同一失败。
      expect(failRail.reads()).toBe(2);
    } finally { failRail.mounted.unmount(); }
  });

  it("403 与 503 各自给出不同说明", async () => {
    const samples: readonly { readonly respond: () => Response; readonly fragment: string }[] = [
      { respond: () => json({ status: 403, code: "PERMISSION_DENIED", title: "来源未被允许",
        detail: "origin forbidden", retryable: false, retry_action: null }, 403),
        fragment: "请求来源未被允许" },
      { respond: () => unavailable("archive read unavailable"), fragment: "数据库不可达" }
    ];
    for (const sample of samples) {
      const rail = await mountRail(sample.respond);
      try {
        await rail.toggle(true);
        expect(document.querySelector('[data-testid="recent-work-archived-error"]')?.textContent)
          .toContain(sample.fragment);
      } finally { rail.mounted.unmount(); }
    }
  });
});
