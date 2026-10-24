import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 禅道 #101：工作空间任务页（/tasks）续页失败时不得清空已读任务与游标。
 * 首读失败仍走全页错误态；失权（403 等）不得保留已失权数据。
 */
const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskA = "33333333-3333-4333-8333-333333333333";
const taskB = "44444444-4444-4444-8444-444444444444";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function connect(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function task(id: string, title: string) {
  return { id, title, project_id: null, status: "READY", mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] };
}

/**
 * 工作空间任务读取桩。cursor 为 null 是首屏，否则是续页；每次请求的游标按序记在 cursors 里。
 * 左栏「近期工作」也读同一个首屏 URL，因此首屏会被读两次——断言只看游标请求。
 */
function stubTasks(handle: (cursor: string | null) => Response | Promise<Response>) {
  const cursors: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
    if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
    if (url.startsWith(`${root}/tasks?scope=all`)) {
      const cursor = new URL(url).searchParams.get("cursor");
      cursors.push(cursor);
      return await handle(cursor);
    }
    throw new Error(`unexpected ${url}`);
  }));
  return cursors;
}

/** 续页请求（带游标）被发出的次数与游标序列。 */
function pageReads(cursors: readonly (string | null)[]): string[] {
  return cursors.filter((cursor): cursor is string => cursor !== null);
}

describe("禅道 #101 工作空间任务列表续页失败可原地重试", () => {
  it("续页 503 时保留首屏任务与游标，就地提示并保留重试入口", async () => {
    connect();
    const cursors = stubTasks((cursor) => cursor === null
      ? response(200, { items: [task(taskA, "首屏任务")], next_cursor: "t+2" })
      : response(503, { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达" }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("仍有后续页");

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(30);

    // 一次续页失败不能把已读结果与游标清掉。
    expect(pageReads(cursors)).toEqual(["t+2"]);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("仍有后续页");
    // 局部续页错误：不是全页错误态，列表与更多入口都还在。
    const moreError = mounted.wrapper.get('[data-testid="tasks-live-more-error"]');
    expect(moreError.text()).toContain("续页失败");
    expect(moreError.text()).toContain("已保留前面加载的结果");
    expect(mounted.wrapper.find('[data-testid="tasks-live-count"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="tasks-live-load-more"]').exists()).toBe(true);
  });

  it("按原游标重试成功后错误消失，结果只追加一次", async () => {
    connect();
    let failed = false;
    const cursors = stubTasks((cursor) => {
      if (cursor === null) return response(200, { items: [task(taskA, "首屏任务")], next_cursor: "t+2" });
      if (!failed) {
        failed = true;
        return response(503, { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达" });
      }
      // 重试返回的页里含首屏已有任务：不得重复追加。
      return response(200, { items: [task(taskA, "首屏任务"), task(taskB, "续页任务")], next_cursor: null });
    });
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.find('[data-testid="tasks-live-more-error"]').exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(30);

    // 重试沿用同一个游标：失败没有推进游标。
    expect(pageReads(cursors)).toEqual(["t+2", "t+2"]);
    expect(mounted.wrapper.find('[data-testid="tasks-live-more-error"]').exists()).toBe(false);
    // 只追加一次：首屏任务不重复，续页任务出现一次。
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 2 项");
    expect(mounted.wrapper.findAll(`[data-testid="task-row-${taskA}"]`)).toHaveLength(1);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskB}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已到列表末页");
  });

  it("首读失败仍是全页错误态，不出现「已保留」", async () => {
    connect();
    stubTasks(() => response(503, { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达" }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    // 全页错误态：重新读取入口在，列表与计数都不渲染。
    expect(mounted.wrapper.text()).toContain("数据库不可达");
    expect(mounted.wrapper.text()).toContain("重新读取");
    expect(mounted.wrapper.text()).not.toContain("已保留前面加载的结果");
    expect(mounted.wrapper.find('[data-testid="tasks-live-more-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="tasks-live-count"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="tasks-live-load-more"]').exists()).toBe(false);
  });

  it("续页失权（403）不保留已失权内容，回到全页错误态", async () => {
    connect();
    stubTasks((cursor) => cursor === null
      ? response(200, { items: [task(taskA, "首屏任务")], next_cursor: "t+2" })
      : response(403, { code: "FORBIDDEN", detail: "任务访问权已撤销" }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(30);

    // 失权不是「暂时不可用」：已读任务必须清掉，不能继续显示无权数据。
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("任务访问权已撤销");
    expect(mounted.wrapper.text()).not.toContain("已保留前面加载的结果");
    expect(mounted.wrapper.find('[data-testid="tasks-live-more-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="tasks-live-count"]').exists()).toBe(false);
  });

  it("续页作用域失效（404 RESOURCE_NOT_FOUND）同样不保留已读内容", async () => {
    connect();
    stubTasks((cursor) => cursor === null
      ? response(200, { items: [task(taskA, "首屏任务")], next_cursor: "t+2" })
      : response(404, { code: "RESOURCE_NOT_FOUND", detail: "工作空间已不可见" }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(30);

    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    // 404 RESOURCE_NOT_FOUND 走 liveErrors 的既有说明：内容可能已被删除或已不属于当前范围。
    expect(mounted.wrapper.text()).toContain("要查看的内容不存在");
    expect(mounted.wrapper.text()).not.toContain("已保留前面加载的结果");
    expect(mounted.wrapper.find('[data-testid="tasks-live-more-error"]').exists()).toBe(false);
  });

  it("续页在途时重复点击只发一次请求，结果不重复追加", async () => {
    connect();
    let complete: ((result: Response) => void) | null = null;
    const cursors = stubTasks((cursor) => {
      if (cursor === null) return response(200, { items: [task(taskA, "首屏任务")], next_cursor: "t+2" });
      return new Promise<Response>((resolve) => { complete = resolve; });
    });
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(10);
    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(10);
    expect(pageReads(cursors)).toEqual(["t+2"]);

    complete!(response(200, { items: [task(taskA, "首屏任务"), task(taskB, "续页任务")], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 2 项");
    expect(mounted.wrapper.findAll(`[data-testid="task-row-${taskA}"]`)).toHaveLength(1);
  });
});
