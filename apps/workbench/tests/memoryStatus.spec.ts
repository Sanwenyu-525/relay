import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const activeId = "33333333-3333-4333-8333-333333333333";
const expiredId = "44444444-4444-4444-8444-444444444444";
const retiredId = "55555555-5555-4555-8555-555555555555";
const unknownId = "66666666-6666-4666-8666-666666666666";
const created = "2026-10-01T00:00:00.000Z";
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function envelope(commandId: string, result: Record<string, unknown>) {
  return { command_id: commandId, committed_at: created, result };
}

function memory(overrides: Record<string, unknown> = {}) {
  return { id: activeId, project_id: null, title: "约定", status: "ACTIVE", revision: "1",
    current_version: "1", text: "需要留存的事实", confirmed_by: "local-user", confirmed_at: created,
    expires_at: "2026-12-31T00:00:00.000Z", effective_status: "ACTIVE",
    created_at: created, updated_at: created, ...overrides };
}

const active = memory({ id: activeId, title: "有效约定" });
const expired = memory({ id: expiredId, title: "过期约定", effective_status: "EXPIRED",
  expires_at: "2020-01-01T00:00:00.000Z" });
const retired = memory({ id: retiredId, title: "停用约定", status: "RETIRED",
  effective_status: "RETIRED", expires_at: "2020-01-01T00:00:00.000Z" });
const unknown = memory({ id: unknownId, title: "旧服务端约定" });
delete (unknown as Record<string, unknown>).effective_status;

const all = [active, expired, retired, unknown];

function listFor(status: string | null): readonly Record<string, unknown>[] {
  if (status === "ACTIVE") return [active];
  if (status === "EXPIRED") return [expired];
  if (status === "RETIRED") return [retired];
  return all;
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function rows(wrapper: DomWrapper): DomWrapper[] {
  return wrapper.findAll(".knowledge-row");
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("长期记忆有效状态与筛选", () => {
  it("四个筛选各发一次真实查询，列表与详情按服务端有效状态展示", async () => {
    activate();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === "/memories" || path.startsWith("/memories?")) {
        urls.push(path);
        const status = path.includes("?")
          ? new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("effective_status") : null;
        return response(200, listFor(status));
      }
      const detail = all.find((item) => path === `/memories/${item.id}`);
      if (detail) return response(200, detail);
      if (path.endsWith("/revisions")) return response(200, []);
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;

    // 默认「全部」保持旧请求形状，不额外发参数。
    expect(urls).toEqual(["/memories"]);
    const labels = () => rows(mounted.wrapper).map((row) => row.text());
    expect(labels()).toHaveLength(4);
    expect(labels()[0]).toContain("有效");
    expect(labels()[1]).toContain("已过期");
    expect(labels()[2]).toContain("已停用");
    expect(labels()[3]).toContain("状态待核对");
    // 有效期是原确认事实，不因有效状态而省略。
    expect(labels()[1]).toContain("到期 2020-01-01");
    expect(mounted.wrapper.get('[data-testid="memory-effective-status"]').text())
      .toContain("持久状态 ACTIVE · 有效状态 有效");

    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-EXPIRED"]').trigger("click"); await flush();
    expect(urls.at(-1)).toBe("/memories?effective_status=EXPIRED");
    expect(labels()).toHaveLength(1);
    expect(labels()[0]).toContain("已过期");
    expect(mounted.wrapper.get('[data-testid="memory-expired-hint"]').text()).toContain("恢复状态不会延长有效期");

    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-RETIRED"]').trigger("click"); await flush();
    expect(urls.at(-1)).toBe("/memories?effective_status=RETIRED");
    // 已停用且已到期仍归「已停用」，到期只作为原事实展示。
    expect(labels()[0]).toContain("已停用");
    expect(labels()[0]).toContain("到期 2020-01-01");

    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-ACTIVE"]').trigger("click"); await flush();
    expect(urls.at(-1)).toBe("/memories?effective_status=ACTIVE");
    expect(labels()[0]).toContain("有效约定");

    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-ALL"]').trigger("click"); await flush();
    expect(urls.at(-1)).toBe("/memories");
    expect(labels()).toHaveLength(4);
  });

  it("状态只读服务端快照，不按本机时钟推断", async () => {
    activate();
    const pastButActive = memory({ id: activeId, title: "服务端判有效", effective_status: "ACTIVE",
      expires_at: "2020-01-01T00:00:00.000Z" });
    const futureButExpired = memory({ id: expiredId, title: "服务端判过期", effective_status: "EXPIRED",
      expires_at: "2099-01-01T00:00:00.000Z" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === "/memories") return response(200, [pastButActive, futureButExpired]);
      if (path === `/memories/${activeId}`) return response(200, pastButActive);
      if (path === `/memories/${expiredId}`) return response(200, futureButExpired);
      if (path.endsWith("/revisions")) return response(200, []);
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    expect(rows(mounted.wrapper)[0]!.text()).toContain("有效");
    expect(rows(mounted.wrapper)[1]!.text()).toContain("已过期");
    // 选中项的有效状态同样来自详情响应，而不是列表或浏览器时间。
    await rows(mounted.wrapper)[1]!.trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="memory-effective-status"]').text())
      .toContain("有效状态 已过期");
  });

  it("首次没有记忆、筛选无匹配与读取失败分开表达", async () => {
    activate();
    let rowsForList: readonly Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === "/memories") return response(200, rowsForList);
      if (path === "/memories?effective_status=EXPIRED") return response(200, []);
      if (path === `/memories/${activeId}`) return response(200, active);
      if (path.endsWith("/revisions")) return response(200, []);
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="knowledge-list-empty"]').text()).toContain("还没有记忆");
    expect(mounted.wrapper.get('[data-testid="knowledge-detail-empty-state"]').text()).toContain("当前范围没有记忆");

    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-EXPIRED"]').trigger("click"); await flush();
    const noMatch = mounted.wrapper.get('[data-testid="knowledge-memory-filter-empty"]');
    expect(noMatch.text()).toContain("当前筛选没有已过期的记忆");
    expect(noMatch.text()).toContain("不代表工作空间没有记忆");
    expect(mounted.wrapper.get('[data-testid="knowledge-detail-empty-state"]').text())
      .toContain("当前筛选没有匹配的记忆");
    expect(mounted.wrapper.find('[data-testid="knowledge-list-empty"]').exists()).toBe(false);

    rowsForList = [active];
    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-clear"]').trigger("click"); await flush();
    expect(rows(mounted.wrapper)).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="knowledge-memory-filter-ALL"]').attributes("aria-pressed")).toBe("true");

    mounted.unmount(); unmount = null;
    activate();
    vi.stubGlobal("fetch", vi.fn(async () => response(500, { code: "INTERNAL", detail: "记忆不可读取" })));
    const failed = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = failed.unmount; await flush();
    expect(failed.wrapper.get('[data-testid="knowledge-read-error"]').text()).toContain("记忆不可读取");
    const failedDetail = failed.wrapper.get('[data-testid="knowledge-detail-empty-state"]').text();
    expect(failedDetail).toContain("读取失败");
    expect(failedDetail).not.toContain("当前范围没有记忆");
  });

  it("切筛选后丢弃迟到的旧结果，不把上一个筛选的记忆写进新列表", async () => {
    activate();
    let releaseExpired: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === "/memories") return response(200, [expired]);
      if (path === "/memories?effective_status=EXPIRED")
        return new Promise<Response>((resolve) => { releaseExpired = resolve; });
      if (path === "/memories?effective_status=ACTIVE") return response(200, [active]);
      if (path === `/memories/${activeId}`) return response(200, active);
      if (path === `/memories/${expiredId}`) return response(200, expired);
      if (path.endsWith("/revisions")) return response(200, []);
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-EXPIRED"]').trigger("click"); await flush(10);
    expect(releaseExpired).not.toBeNull();
    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-ACTIVE"]').trigger("click"); await flush();
    expect(rows(mounted.wrapper).map((row) => row.text())).toHaveLength(1);
    expect(rows(mounted.wrapper)[0]!.text()).toContain("有效约定");
    releaseExpired!(response(200, [expired])); await flush();
    expect(rows(mounted.wrapper)).toHaveLength(1);
    expect(rows(mounted.wrapper)[0]!.text()).toContain("有效约定");
    expect(mounted.wrapper.get('[data-testid="knowledge-memory-filter-ACTIVE"]').attributes("aria-pressed")).toBe("true");
  });

  it("已过期的 ACTIVE 记忆仍可停用与修订，续期走原修订流程并重新显示有效", async () => {
    activate();
    let state = memory({ id: activeId, title: "过期但未停用", status: "ACTIVE",
      effective_status: "EXPIRED", expires_at: "2020-01-01T00:00:00.000Z" });
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/memories") return response(200, [state]);
      if (path === `/memories/${activeId}`) return response(200, state);
      if (path === `/memories/${activeId}/revisions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        state = memory({ id: activeId, title: "过期但未停用", status: "ACTIVE",
          revision: "2", current_version: "2", effective_status: "ACTIVE", expires_at: null });
        return response(200, envelope(String(body.command_id),
          { memory_id: activeId, revision: "2", version: "2", status: "ACTIVE" }));
      }
      if (path === `/memories/${activeId}/revisions`) return response(200, []);
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    expect(rows(mounted.wrapper)[0]!.text()).toContain("已过期");
    // 过期不等于停用：停用与修订入口都必须在。
    expect(mounted.wrapper.findAll("button").some((item) => item.text() === "停用记忆")).toBe(true);
    expect(mounted.wrapper.get('[data-testid="knowledge-new-version"]').attributes("disabled")).toBeUndefined();
    const hint = mounted.wrapper.get('[data-testid="memory-expired-hint"]');
    expect(hint.text()).toContain("已过有效期");
    expect(hint.text()).toContain("追加新版本");
    expect(hint.text()).toContain("明确确认");

    await mounted.wrapper.get('[data-testid="memory-renew"]').trigger("click"); await flush();
    await mounted.wrapper.get('[data-testid="memory-expires-at"]').setValue("");
    await mounted.wrapper.get('[data-testid="memory-confirmed"]').setValue(true);
    await mounted.wrapper.get('[data-testid="knowledge-save"]').trigger("submit"); await flush(60);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ expected_revision: "1", expires_at: null, confirmed: true });
    // 成功后定向重读完整 DTO：有效状态来自重读，而不是回执里的 ACTIVE。
    expect(rows(mounted.wrapper)[0]!.text()).toContain("有效");
    expect(mounted.wrapper.find('[data-testid="memory-expired-hint"]').exists()).toBe(false);
  });

  it("恢复过期记忆后重读仍显示已过期，回执不宣称记忆现已有效", async () => {
    activate();
    let state = memory({ id: retiredId, title: "停用且过期", status: "RETIRED", revision: "1",
      effective_status: "RETIRED", expires_at: "2020-01-01T00:00:00.000Z" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/memories") return response(200, [state]);
      if (path === `/memories/${retiredId}`) return response(200, state);
      if (path === `/memories/${retiredId}/revisions`) return response(200, []);
      if (path === `/memories/${retiredId}/reactivate` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        // 恢复只改根状态：有效期不动，因此有效状态仍是 EXPIRED。
        state = memory({ id: retiredId, title: "停用且过期", status: "ACTIVE", revision: "2",
          effective_status: "EXPIRED", expires_at: "2020-01-01T00:00:00.000Z" });
        return response(200, envelope(String(body.command_id),
          { memory_id: retiredId, revision: "2", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="knowledge-restore-entry"]').text()).toContain("不延长有效期");
    await mounted.wrapper.get('[data-testid="knowledge-restore"]').trigger("click"); await flush();
    expect(rows(mounted.wrapper)[0]!.text()).toContain("已过期");
    expect(mounted.wrapper.get('[data-testid="memory-effective-status"]').text())
      .toContain("持久状态 ACTIVE · 有效状态 已过期");
    expect(mounted.wrapper.find('[data-testid="knowledge-restore-entry"]').exists()).toBe(false);
    const receipt = mounted.wrapper.get(".receipt-message").text();
    expect(receipt).toContain("有效期");
    expect(receipt).not.toContain("已恢复为有效记忆");
    expect(receipt).not.toContain("现已有效");
  });

  it("停用后条目不再匹配当前筛选时从列表移除，详情回到剩余项", async () => {
    activate();
    const other = memory({ id: expiredId, title: "另一条约定" });
    let retiredNow = false;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/memories" || path.startsWith("/memories?")) {
        urls.push(path);
        return response(200, retiredNow ? [other] : [active, other]);
      }
      if (path === `/memories/${activeId}`) return response(200, active);
      if (path === `/memories/${expiredId}`) return response(200, other);
      if (path === `/memories/${activeId}/revisions`) return response(200, []);
      if (path === `/memories/${expiredId}/revisions`) return response(200, []);
      if (path === `/memories/${activeId}/retire` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        retiredNow = true;
        return response(200, envelope(String(body.command_id),
          { memory_id: activeId, revision: "2", status: "RETIRED" }));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="knowledge-memory-filter-ACTIVE"]').trigger("click"); await flush();
    expect(rows(mounted.wrapper)).toHaveLength(2);
    await mounted.wrapper.findAll("button").find((item) => item.text() === "停用记忆")!.trigger("click");
    await flush();
    // 重读沿用当前筛选：停用项不再出现在「有效」列表里，详情落到剩余项。
    expect(urls.at(-1)).toBe("/memories?effective_status=ACTIVE");
    expect(rows(mounted.wrapper)).toHaveLength(1);
    expect(rows(mounted.wrapper)[0]!.text()).toContain("另一条约定");
    expect(mounted.wrapper.text()).not.toContain("有效约定");
    expect(mounted.wrapper.find('[data-testid="knowledge-restore-entry"]').exists()).toBe(false);
  });
});
