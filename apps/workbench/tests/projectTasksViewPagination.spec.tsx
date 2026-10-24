import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 禅道 #102：项目任务页只读首批 50 项并丢弃 next_cursor，没有续页入口；
 * 名称搜索只在这 50 项内过滤，却把第 51 项的缺失报告为「当前项目没有匹配该关键词的任务」。
 * 这里覆盖：续页入口、游标续页追加、搜索口径（未读全不得断言全量）、读完后才给全量结论。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function connect(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function taskId(index: number): string {
  return `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
}

function taskRow(index: number) {
  return {
    id: taskId(index),
    project_id: projectId,
    title: index === 51 ? "EXISTING_TASK_51_UNIQUE" : `FIRST_PAGE_TASK_${index}`,
    status: "INBOX",
    mode: "ME",
    revision: "1",
    executor: { kind: "HUMAN", run_id: null },
    current_completion_id: null,
    waiting_reason: null,
    blocking_task_ids: [],
    unresolved_blocker_ids: [],
    allowed_actions: []
  };
}

function projectRow() {
  return { id: projectId, title: "51 任务项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
}

function taskDetail(index: number) {
  return {
    ...taskRow(index),
    acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] },
    dependencies: []
  };
}

function loadMoreButton(mounted: Awaited<ReturnType<typeof mountWorkbench>>) {
  return mounted.wrapper.findAll("button").find((button) => button.text().includes("继续加载"));
}

describe("项目任务页分页与搜索口径（#102）", () => {
  it("首读 50 项且 next_cursor 非空时给出继续加载入口，并说明还有后续页", async () => {
    connect();
    const cursors: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${projectId}`)) return response(projectRow());
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === projectId) {
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        return response({ items: Array.from({ length: 50 }, (_, index) => taskRow(index + 1)), next_cursor: "task-page+51" });
      }
      if (url.pathname.endsWith(`/tasks/${taskId(1)}`)) return response(taskDetail(1));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    expect(cursors).toEqual([null]);
    expect(mounted.wrapper.findAll('[data-testid^="project-task-row-"]')).toHaveLength(50);
    expect(mounted.wrapper.get('[data-testid="project-tasks-scope"]').text()).toContain("已读取 50 条；还有后续页");
    const more = loadMoreButton(mounted);
    expect(more).toBeDefined();
    expect(more!.text()).toContain("继续加载");
  });

  it("续页请求带上原 cursor，追加第 51 项且只追加一次", async () => {
    connect();
    const cursors: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${projectId}`)) return response(projectRow());
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === projectId) {
        const cursor = url.searchParams.get("cursor");
        cursors.push(cursor);
        if (cursor === null) return response({ items: Array.from({ length: 50 }, (_, index) => taskRow(index + 1)), next_cursor: "task-page+51" });
        if (cursor === "task-page+51") return response({ items: [taskRow(51)], next_cursor: "task-page+52" });
        return response({ items: [], next_cursor: null });
      }
      if (url.pathname.endsWith(`/tasks/${taskId(1)}`)) return response(taskDetail(1));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    await loadMoreButton(mounted)!.trigger("click"); await flush();
    expect(cursors).toEqual([null, "task-page+51"]);
    expect(mounted.wrapper.findAll('[data-testid^="project-task-row-"]')).toHaveLength(51);
    expect(mounted.wrapper.findAll(`[data-testid="project-task-row-${taskId(51)}"]`)).toHaveLength(1);
    expect(mounted.wrapper.text()).toContain("EXISTING_TASK_51_UNIQUE");
    // 再读一页空的：第 51 项不会被重复追加。
    await loadMoreButton(mounted)!.trigger("click"); await flush();
    expect(cursors).toEqual([null, "task-page+51", "task-page+52"]);
    expect(mounted.wrapper.findAll('[data-testid^="project-task-row-"]')).toHaveLength(51);
    expect(mounted.wrapper.findAll(`[data-testid="project-task-row-${taskId(51)}"]`)).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="project-tasks-scope"]').text()).toContain("已读取 51 条；本次查询没有后续游标");
    expect(loadMoreButton(mounted)).toBeUndefined();
  });

  it("搜索只命中未加载的第 51 项时不声称全项目无匹配，改为已加载范围未命中", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${projectId}`)) return response(projectRow());
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === projectId) {
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) return response({ items: Array.from({ length: 50 }, (_, index) => taskRow(index + 1)), next_cursor: "task-page+51" });
        return response({ items: [taskRow(51)], next_cursor: null });
      }
      if (url.pathname.endsWith(`/tasks/${taskId(1)}`)) return response(taskDetail(1));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    await mounted.wrapper.get('input[name="project-task-search"]').setValue("EXISTING_TASK_51_UNIQUE"); await flush();
    expect(mounted.wrapper.text()).not.toContain("当前项目没有匹配该关键词的任务");
    expect(mounted.wrapper.text()).toContain("已加载范围未命中");
    expect(mounted.wrapper.text()).toContain("后续页尚未读取");
    // 未读全时续页入口仍在，后续任务可从主列表发现。
    expect(loadMoreButton(mounted)).toBeDefined();
    await loadMoreButton(mounted)!.trigger("click"); await flush();
    expect(mounted.wrapper.find(`[data-testid="project-task-row-${taskId(51)}"]`).exists()).toBe(true);
    expect(mounted.wrapper.text()).not.toContain("已加载范围未命中");
  });

  it("首读没有 next_cursor 时不显示续页入口，搜索断言按全量口径", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${projectId}`)) return response(projectRow());
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === projectId)
        return response({ items: [taskRow(1), taskRow(2)], next_cursor: null });
      if (url.pathname.endsWith(`/tasks/${taskId(1)}`)) return response(taskDetail(1));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    expect(loadMoreButton(mounted)).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="project-tasks-scope"]').text()).toContain("已读取 2 条；本次查询没有后续游标");
    await mounted.wrapper.get('input[name="project-task-search"]').setValue("不存在的关键词"); await flush();
    expect(mounted.wrapper.text()).toContain("当前项目没有匹配该关键词的任务");
    expect(mounted.wrapper.text()).not.toContain("后续页尚未读取");
  });

  it("续页失败保留已加载结果并就地提示，不清空列表", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/projects/${projectId}`)) return response(projectRow());
      if (url.pathname.endsWith("/tasks") && url.searchParams.get("project_id") === projectId) {
        if (url.searchParams.get("cursor") === null)
          return response({ items: Array.from({ length: 50 }, (_, index) => taskRow(index + 1)), next_cursor: "task-page+51" });
        return response({ code: "INTERNAL_ERROR", detail: "读取后续页失败" }, 500);
      }
      if (url.pathname.endsWith(`/tasks/${taskId(1)}`)) return response(taskDetail(1));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    await loadMoreButton(mounted)!.trigger("click"); await flush();
    expect(mounted.wrapper.findAll('[data-testid^="project-task-row-"]')).toHaveLength(50);
    expect(mounted.wrapper.get('[data-testid="project-tasks-more-error"]').text()).toContain("续页失败");
    expect(mounted.wrapper.get('[data-testid="project-tasks-more-error"]').text()).toContain("已保留前面加载的结果");
    // 游标保留，可以再次尝试。
    expect(loadMoreButton(mounted)).toBeDefined();
  });
});
