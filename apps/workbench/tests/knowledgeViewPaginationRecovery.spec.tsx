import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 禅道 #31（DEV-0129）：资料搜索续页暂时失败会清空已读结果及游标，无法原地重试。
 *
 * 事实口径（与 ActivityView 的续页失败处理同一口径）：
 * - 首屏失败＝整页错误态，不能渲染成「没有匹配」；
 * - 续页失败＝局部错误，已核实的第一页与原游标留着，用户按同一游标重试；
 * - 失权（401/403）＝清空，不保留无权查看的资料；
 * - 换关键词／换项目／换连接＝清空并保持版本隔离，迟到响应不得写回当前查询。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const pageOneId = "22222222-2222-4222-8222-222222222222";
const pageTwoId = "33333333-3333-4333-8333-333333333333";
const pageThreeId = "44444444-4444-4444-8444-444444444444";

let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function searchItem(id: string, title: string) {
  return { type: "KNOWLEDGE", id, version: "1", title, snippet: title,
    matched_fields: ["title"], source_ref: `knowledge:${id}:v1`, status: "ACTIVE", project_id: null };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

/** 搜索之外的读取：资料列表为空，其余按通用形状回，避免噪声干扰被断言的搜索区域。 */
function common(url: string): Response {
  if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
  if (url.endsWith("/tasks?scope=all")) return response(200, { items: [], next_cursor: null });
  if (url.includes("/assist-sessions")) return response(200, { items: [] });
  if (url.includes("/projects?")) return response(200, { items: [], next_cursor: null });
  if (url === `${base}/knowledge`) return response(200, []);
  return response(200, []);
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("知识库搜索续页失败恢复", () => {
  it("首屏成功但续页暂时失败时保留第一页与原游标，并给出可重试的局部错误", async () => {
    activate();
    const cursorRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) {
        const cursor = new URL(url).searchParams.get("cursor");
        if (cursor === null) return response(200, { items: [searchItem(pageOneId, "第一页结果")], next_cursor: "cursor-2" });
        cursorRequests.push(cursor);
        return response(503, { code: "DATABASE_UNAVAILABLE", detail: "next page temporary failure" });
      }
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("探针"); await flush(320);
    expect(mounted.wrapper.text()).toContain("第一页结果");

    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(40);

    // 已读结果不能消失：服务端数据没被删，是客户端读取恢复退化。
    expect(mounted.wrapper.text()).toContain("第一页结果");
    // 原游标与续页入口都要留着，用户才能原地重试。
    expect(mounted.wrapper.find('[data-testid="knowledge-more"]').exists()).toBe(true);
    expect(cursorRequests).toEqual(["cursor-2"]);
    // 续页失败是局部错误，不是首屏整页错误，也不冒充「没有匹配」。
    expect(mounted.wrapper.get('[data-testid="knowledge-search-more-error"]').text()).toContain("续页失败");
    expect(mounted.wrapper.find('[data-testid="knowledge-search-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-empty"]').exists()).toBe(false);
  });

  it("按原游标重试成功后错误消失，且结果只追加一次", async () => {
    activate();
    let continuationFails = true;
    const cursorRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) {
        const cursor = new URL(url).searchParams.get("cursor");
        if (cursor === null) return response(200, { items: [searchItem(pageOneId, "第一页结果")], next_cursor: "cursor-2" });
        cursorRequests.push(cursor);
        if (continuationFails) return response(503, { code: "DATABASE_UNAVAILABLE", detail: "next page temporary failure" });
        return response(200, { items: [searchItem(pageTwoId, "第二页结果")], next_cursor: null });
      }
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("探针"); await flush(320);
    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(40);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-more-error"]').exists()).toBe(true);

    continuationFails = false;
    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(40);

    // 重试必须按原游标请求：换游标等于换一次查询，之前的读取就接不上了。
    expect(cursorRequests).toEqual(["cursor-2", "cursor-2"]);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-more-error"]').exists()).toBe(false);
    const results = mounted.wrapper.findAll(".knowledge-result");
    expect(results.map((result) => result.text())).toHaveLength(2);
    expect(results.map((result) => result.text()).join(" ")).toContain("第一页结果");
    expect(results.map((result) => result.text()).join(" ")).toContain("第二页结果");
    // 没有后续游标时续页入口收起。
    expect(mounted.wrapper.find('[data-testid="knowledge-more"]').exists()).toBe(false);
  });

  it("续页在途时连点不会重复请求，重复返回的结果也只排一次", async () => {
    activate();
    let resolveContinuation: ((value: Response) => void) | null = null;
    const cursorRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) {
        const cursor = new URL(url).searchParams.get("cursor");
        if (cursor === null) return response(200, { items: [searchItem(pageOneId, "第一页结果")], next_cursor: "cursor-2" });
        cursorRequests.push(cursor);
        return new Promise<Response>((resolve) => { resolveContinuation = resolve; });
      }
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("探针"); await flush(320);
    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(20);
    // 请求在途时入口是禁用的：连点不会再发一次请求。
    expect(mounted.wrapper.get('[data-testid="knowledge-more"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(20);
    expect(cursorRequests).toEqual(["cursor-2"]);

    resolveContinuation!(response(200, { items: [searchItem(pageTwoId, "第二页结果"), searchItem(pageTwoId, "第二页结果")], next_cursor: null }));
    await flush(40);
    const results = mounted.wrapper.findAll(".knowledge-result");
    expect(results).toHaveLength(2);
    expect(results.filter((result) => result.text().includes("第二页结果"))).toHaveLength(1);
  });

  it("首屏失败仍是整页错误态，不冒充没有匹配", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) return response(503, { code: "DATABASE_UNAVAILABLE", detail: "search temporarily unavailable" });
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("探针"); await flush(320);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-error"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-empty"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-more-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="knowledge-more"]').exists()).toBe(false);
  });

  it("续页遇到失权（403）时清空结果，不保留无权查看的资料", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) {
        const cursor = new URL(url).searchParams.get("cursor");
        if (cursor === null) return response(200, { items: [searchItem(pageOneId, "第一页结果")], next_cursor: "cursor-2" });
        return response(403, { code: "FORBIDDEN", detail: "当前工作空间无权读取这些资料。" });
      }
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("探针"); await flush(320);
    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(40);
    expect(mounted.wrapper.text()).not.toContain("第一页结果");
    expect(mounted.wrapper.find('[data-testid="knowledge-search-error"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="knowledge-search-more-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="knowledge-more"]').exists()).toBe(false);
  });

  it("换关键词后旧结果不残留，在途的旧续页响应也不写回当前查询", async () => {
    activate();
    let resolveOldContinuation: ((value: Response) => void) | null = null;
    const cursorRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search?")) {
        const params = new URL(url).searchParams;
        const q = params.get("q");
        const cursor = params.get("cursor");
        if (cursor === null && q === "旧词") return response(200, { items: [searchItem(pageOneId, "旧词结果")], next_cursor: "cursor-2" });
        if (cursor === null && q === "新词") return response(200, { items: [searchItem(pageThreeId, "新词结果")], next_cursor: null });
        cursorRequests.push(String(cursor));
        return new Promise<Response>((resolve) => { resolveOldContinuation = resolve; });
      }
      return common(url);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("旧词"); await flush(320);
    expect(mounted.wrapper.text()).toContain("旧词结果");
    await mounted.wrapper.get('[data-testid="knowledge-more"]').trigger("click"); await flush(20);
    expect(cursorRequests).toEqual(["cursor-2"]);

    // 换关键词：旧结果与旧游标都要清掉。
    await mounted.wrapper.get('[data-testid="knowledge-search"]').setValue("新词"); await flush(320);
    expect(mounted.wrapper.text()).not.toContain("旧词结果");
    expect(mounted.wrapper.text()).toContain("新词结果");
    expect(mounted.wrapper.find('[data-testid="knowledge-more"]').exists()).toBe(false);

    // 迟到的旧续页响应不得写回当前查询。
    resolveOldContinuation!(response(200, { items: [searchItem(pageTwoId, "旧续页结果")], next_cursor: null }));
    await flush(40);
    expect(mounted.wrapper.text()).not.toContain("旧续页结果");
    expect(mounted.wrapper.text()).toContain("新词结果");
  });
});
