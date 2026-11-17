import { afterEach, describe, expect, it, vi } from "vitest";

import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 2026-11-15 任务页刷新专项：区分首读 / 手动刷新 / 刷新失败。
 * - 手动刷新在途不清空列表，也不发第二次请求；
 * - 暂时失败保留旧数据与游标，并标明「屏幕上的内容是上次成功读取的结果」；
 * - 失权（401/403/404）仍必须清空，不能继续显示无权数据。
 *
 * 左栏「近期工作」也读同一个 `tasks?scope=all`：同一 URL 的前两次读取分别是左栏与主列表，
 * 之后的读取才是手工刷新，因此响应按「第几次读取」排队，而不是按调用方猜。
 */
const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const taskA = "33333333-3333-4333-8333-333333333333";
const taskB = "44444444-4444-4444-8444-444444444444";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function connect(id = workspaceId): void {
  activateRelayConnection({ baseUrl, workspaceId: id, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function task(id: string, title: string) {
  return { id, title, project_id: null, status: "READY", mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] };
}
function firstPage() {
  return response(200, { items: [task(taskA, "首读任务甲"), task(taskB, "首读任务乙")], next_cursor: null });
}

/** 任务页桩：任务列表的每次读取按序取 `responses` 里的一项；超出的按最后一项处理。 */
function stubLive(responses: readonly (() => Response | Promise<Response>)[]) {
  const taskReads: number[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
    if (url.startsWith(`${root}/projects?ids=`)) return response(200, { items: [], next_cursor: null });
    if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
    if (url === `${root}/tasks?scope=all`) {
      reads += 1;
      taskReads.push(reads);
      return await (responses[Math.min(reads - 1, responses.length - 1)] as () => Response | Promise<Response>)();
    }
    throw new Error(`unexpected ${url}`);
  }));
  return taskReads;
}

describe("工作空间任务列表刷新", () => {
  it("手动刷新暂时失败：旧数据与计数保留，明确标出这是上次成功读取的结果", async () => {
    connect();
    const taskReads = stubLive([firstPage, firstPage,
      () => response(503, { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达" })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 2 项");
    expect(mounted.wrapper.text()).toContain("上次成功读取");

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);

    expect(taskReads).toHaveLength(3);
    // 旧数据仍在：失败刷新不等于清空。
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 2 项");
    const error = mounted.wrapper.get('[data-testid="tasks-live-refresh-error"]');
    expect(error.text()).toContain("本次刷新没有成功");
    expect(error.text()).toContain("数据库不可达");
    expect(error.text()).toContain("读取的结果");
    // 刷新提示撤下，错误不是全页错误态。
    expect(mounted.wrapper.find('[data-testid="tasks-live-refreshing"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("还没有任务");
  });

  it("刷新在途时保留旧内容并显示刷新中，重复点击只发一次请求", async () => {
    connect();
    let complete: ((result: Response) => void) | null = null;
    const taskReads = stubLive([firstPage, firstPage, () =>
      new Promise<Response>((resolve) => { complete = resolve; })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(5);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-live-refreshing"]').text()).toContain("已显示上次读取的内容");
    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(5);

    complete!(response(200, { items: [task(taskB, "刷新后任务乙")], next_cursor: null }));
    await flush(30);
    expect(taskReads).toHaveLength(3);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 1 项");
    expect(mounted.wrapper.find('[data-testid="tasks-live-refreshing"]').exists()).toBe(false);
  });

  it("刷新遇凭据失效（401）清空旧行并回到全页错误态", async () => {
    connect();
    stubLive([firstPage, firstPage,
      () => response(401, { code: "AUTH_REQUIRED", detail: "凭据未被接受" })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);

    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get("div.page-state--error").text()).toContain("凭据未被接受");
    expect(mounted.wrapper.find('[data-testid="tasks-live-refresh-error"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="tasks-live-count"]').exists()).toBe(false);
  });

  it("刷新遇作用域失效（404 RESOURCE_NOT_FOUND）同样清空，不保留旧数据", async () => {
    connect();
    stubLive([firstPage, firstPage,
      () => response(404, { code: "RESOURCE_NOT_FOUND", detail: "工作空间不可见" })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);

    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("要查看的内容不存在");
  });

  it("刷新遇无权（403）同样清空，不把无权数据留在屏幕上", async () => {
    connect();
    stubLive([firstPage, firstPage,
      () => response(403, { code: "FORBIDDEN", detail: "工作空间访问权已撤销" })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);

    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("工作空间访问权已撤销");
    expect(mounted.wrapper.find('[data-testid="tasks-live-count"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="tasks-live-refresh-error"]').exists()).toBe(false);
  });

  it("手动刷新在途时禁用加载更多，不把点击静默丢给 busy 锁", async () => {
    connect();
    let complete: ((result: Response) => void) | null = null;
    const cursors: (string | null)[] = [];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
      if (url.startsWith(`${root}/projects?ids=`)) return response(200, { items: [], next_cursor: null });
      if (url === `${root}/assist-sessions?include_context=true`) return response(200, { items: [] });
      if (url.startsWith(`${root}/tasks?scope=all`)) {
        cursors.push(new URL(url).searchParams.get("cursor"));
        reads += 1;
        if (reads <= 2) return response(200, {
          items: [task(taskA, "首屏任务")], next_cursor: "t+2" });
        return new Promise<Response>((resolve) => { complete = resolve; });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(mounted.wrapper.find('[data-testid="tasks-live-load-more"]').exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(10);
    expect(mounted.wrapper.get('[data-testid="tasks-live-refreshing"]').exists()).toBe(true);
    // 刷新在途：加载更多必须是 disabled，不能「看起来可点、请求却被 busy 锁丢掉」。
    const loadMore = mounted.wrapper.get('[data-testid="tasks-live-load-more"]');
    expect(loadMore.attributes("disabled")).toBeDefined();
    await loadMore.trigger("click");
    await flush(10);
    expect(cursors.filter((cursor) => cursor !== null)).toEqual([]);

    complete!(response(200, { items: [task(taskA, "刷新结果")], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.find('[data-testid="tasks-live-refreshing"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="tasks-live-load-more"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 1 项");
  });

  it("刷新在途时切换 Workspace：旧请求迟到不覆盖新范围", async () => {
    connect();
    const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
    const otherRoot = `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}`;
    const taskC = "55555555-5555-4555-8555-555555555555";
    let completeOld: ((result: Response) => void) | null = null;
    let oldReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if ([root, otherRoot].some((prefix) => url === `${prefix}/projects?status=active`))
        return response(200, { items: [], next_cursor: null });
      if (url.startsWith(`${root}/projects?ids=`) || url.startsWith(`${otherRoot}/projects?ids=`))
        return response(200, { items: [], next_cursor: null });
      if ([root, otherRoot].some((prefix) => url === `${prefix}/assist-sessions?include_context=true`))
        return response(200, { items: [] });
      if (url === `${otherRoot}/tasks?scope=all`) return response(200, {
        items: [task(taskC, "新空间任务")], next_cursor: null });
      if (url === `${root}/tasks?scope=all`) {
        oldReads += 1;
        if (oldReads <= 2) return response(200, {
          items: [task(taskA, "旧空间任务")], next_cursor: null });
        return new Promise<Response>((resolve) => { completeOld = resolve; });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(10);
    connect(otherWorkspaceId);
    await flush(30);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskC}"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);

    // 旧空间的刷新响应此刻才到：不得把旧行写回新 Workspace 的列表。
    completeOld!(response(200, { items: [task(taskA, "旧空间迟到任务")], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 1 项");
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).not.toContain("旧空间");
  });

  it("刷新成功后错误提示消失，计数改用新结果与新的读取时间", async () => {
    connect();
    stubLive([firstPage, firstPage,
      () => response(503, { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达" }),
      () => response(200, { items: [task(taskA, "刷新成功任务甲")], next_cursor: null })]);
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.find('[data-testid="tasks-live-refresh-error"]').exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.find('[data-testid="tasks-live-refresh-error"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 1 项");
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("上次成功读取");
  });
});
