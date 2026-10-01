import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const projectC = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});
function connect(id = workspaceId) {
  activateRelayConnection({ baseUrl, workspaceId: id, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function recentTasksResponse(url: string): Response | null {
  return [workspaceId, otherWorkspaceId].some((id) => url === `${baseUrl}/api/v1/workspaces/${id}/tasks?scope=all`)
    ? response(200, { items: [], next_cursor: null }) : null;
}
function project(id: string, title: string) {
  return { id, title, project_type: "GENERAL", archived_at: null, archive_status: "ACTIVE",
    revision: "1", state_revision: "1", phase_key: "PLANNING", next_action_task_id: null,
    created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z" };
}
function creation(commandId: string, target: string | null): Response {
  return response(201, { command_id: commandId, committed_at: "2026-09-26T00:00:00.000Z",
    result: { task_id: taskId, project_id: target, status: "INBOX", mode: "ME",
      revision: "0", acceptance_revision: "1" }, links: {} });
}

describe("live 创建任务的真实项目选择", () => {
  it("按需读取进行中项目并按原 cursor 续页；搜索只覆盖已加载项，点击项目后才关联", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      urls.push(url);
      const recent = recentTasksResponse(url); if (recent) return recent;
      if (url === `${root}/projects?status=active`) return response(200, {
        items: [project(projectA, "甲项目")], next_cursor: "page+2" });
      if (url === `${root}/projects?status=active&cursor=page%2B2`) return response(200, {
        items: [project(projectB, "乙项目")], next_cursor: null });
      if (url === `${root}/tasks?project_id=${projectB}`) return response(200, { items: [], next_cursor: null });
      if (url === `${root}/projects/${projectB}`) return response(200, project(projectB, "乙项目"));
      if (url === `${root}/tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
        return creation(String(body.command_id), projectB);
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks?view=create"); unmount = mounted.unmount;
    // 全局近期工作已读取，但项目选择器仍须由用户打开后独立查询。
    expect(urls).toEqual([`${root}/tasks?scope=all`, `${root}/projects?status=active`]);
    expect(mounted.wrapper.find('[data-testid="task-project-list-count"]').exists()).toBe(false);
    expect((mounted.wrapper.get('input[name="task-project-id"]').element as HTMLInputElement).value).toBe("");
    await mounted.wrapper.get('[data-testid="task-project-list-open"]').trigger("click");
    await flush(30);
    expect(urls).toEqual([`${root}/tasks?scope=all`, `${root}/projects?status=active`, `${root}/projects?status=active`]);
    expect(mounted.wrapper.get('[data-testid="task-project-list-count"]').text())
      .toContain("已加载 1 项 · 当前搜索显示 1 项 · 仍有后续页");
    expect((mounted.wrapper.get('input[name="task-project-id"]').element as HTMLInputElement).value).toBe("");
    await mounted.wrapper.get('input[name="task-project-search"]').setValue("乙");
    expect(mounted.wrapper.get('[data-testid="task-project-list-count"]').text()).toContain("当前搜索显示 0 项");
    await mounted.wrapper.get('[data-testid="task-project-list-more"]').trigger("click");
    await flush(30);
    expect(urls.at(-1)).toBe(`${root}/projects?status=active&cursor=page%2B2`);
    expect(mounted.wrapper.get('[data-testid="task-project-list-count"]').text())
      .toContain("已加载 2 项 · 当前搜索显示 1 项 · 已到列表末页");
    await mounted.wrapper.get(`[data-testid="task-project-choice-${projectB}"]`).trigger("click");
    await flush(30);
    expect((mounted.wrapper.get('input[name="task-project-id"]').element as HTMLInputElement).value).toBe(projectB);
    await mounted.wrapper.get('input[name="task-title"]').setValue("显式项目任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("明确交付物");
    await mounted.wrapper.get('[data-testid="task-create-inbox"]').trigger("click");
    await flush(30);
    expect(posts).toHaveLength(1);
    expect(posts[0].project_id).toBe(projectB);
    expect(posts[0].title).toBe("显式项目任务");
    expect(urls).toEqual([`${root}/tasks?scope=all`, `${root}/projects?status=active`,
      `${root}/projects?status=active`, `${root}/projects?status=active&cursor=page%2B2`,
      `${root}/tasks?project_id=${projectB}`, `${root}/projects/${projectB}`, `${root}/tasks`]);
  });

  it("刷新失权清除旧项目，保留手动 ID 回退", async () => {
    connect();
    let authorized = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      const recent = recentTasksResponse(url); if (recent) return recent;
      if (url !== `${root}/projects?status=active`) throw new Error(`unexpected ${url}`);
      return authorized ? response(200, { items: [project(projectA, "旧项目")], next_cursor: null })
        : response(403, { code: "FORBIDDEN", detail: "项目列表失权" });
    }));
    const mounted = await mountWorkbench("/tasks?view=create"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-project-list-open"]').trigger("click"); await flush(30);
    expect(mounted.wrapper.find(`[data-testid="task-project-choice-${projectA}"]`).exists()).toBe(true);
    authorized = false;
    await mounted.wrapper.get('[data-testid="task-project-list-refresh"]').trigger("click"); await flush(30);
    expect(mounted.wrapper.find(`[data-testid="task-project-choice-${projectA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('#main-content [role="alert"]').text()).toContain("项目列表失权");
    expect(mounted.wrapper.get('input[name="task-project-id"]').attributes("disabled")).toBeUndefined();
  });

  it("切 Workspace 清除预填和列表，旧 Workspace 的迟到页不能回写", async () => {
    connect();
    let finishOld: ((result: Response) => void) | null = null;
    const oldPage = new Promise<Response>((resolve) => { finishOld = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      const recent = recentTasksResponse(url); if (recent) return recent;
      if (url === `${root}/projects?status=active`) return oldPage;
      if (url === `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}/projects?status=active`)
        return response(200, { items: [project(projectC, "新空间项目")], next_cursor: null });
      if (url === `${root}/tasks?project_id=${projectA}`) return response(200, { items: [], next_cursor: null });
      if (url === `${root}/projects/${projectA}`) return response(200, project(projectA, "甲项目"));
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/tasks?view=create&project=${projectA}`); unmount = mounted.unmount;
    expect((mounted.wrapper.get('input[name="task-project-id"]').element as HTMLInputElement).value).toBe(projectA);
    await mounted.wrapper.get('[data-testid="task-project-list-open"]').trigger("click");
    await act(async () => { connect(otherWorkspaceId); }); await flush(30);
    expect((mounted.wrapper.get('input[name="task-project-id"]').element as HTMLInputElement).value).toBe("");
    expect(mounted.wrapper.find(`[data-testid="task-project-choice-${projectA}"]`).exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="task-project-list-open"]').trigger("click"); await flush(30);
    finishOld!(response(200, { items: [project(projectA, "迟到旧空间项目")], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.get(`[data-testid="task-project-choice-${projectC}"]`).text()).toContain("新空间项目");
    expect(mounted.wrapper.text()).not.toContain("迟到旧空间项目");
  });

  it("创建响应不明先查原回执；仅 404 后用冻结的 Project、载荷与 command ID 重试", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      const recent = recentTasksResponse(url); if (recent) return recent;
      if (url === `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}/projects?status=active`)
        return response(200, { items: [], next_cursor: null });
      if (url === `${root}/projects?status=active`) return response(200, {
        items: [project(projectA, "甲项目"), project(projectB, "乙项目")], next_cursor: null });
      if (url === `${root}/tasks?project_id=${projectA}`) return response(200, { items: [], next_cursor: null });
      if (url === `${root}/projects/${projectA}`) return response(200, project(projectA, "甲项目"));
      if (url === `${root}/tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
        if (posts.length === 1) throw new TypeError("response lost");
        return creation(String(body.command_id), projectA);
      }
      if (url.startsWith(`${root}/commands/`)) return response(404, {
        code: "COMMAND_NOT_FOUND", detail: "not found" });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks?view=create"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-project-list-open"]').trigger("click"); await flush(30);
    await mounted.wrapper.get(`[data-testid="task-project-choice-${projectA}"]`).trigger("click"); await flush(30);
    await mounted.wrapper.get('input[name="task-title"]').setValue("冻结标题");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("冻结目标");
    await mounted.wrapper.get('[data-testid="task-create-inbox"]').trigger("click"); await flush(30);
    expect(posts).toHaveLength(1);
    expect(mounted.wrapper.get('input[name="task-project-id"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get(`[data-testid="task-project-choice-${projectB}"]`).attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.find('[data-testid="task-create-retry"]').exists()).toBe(false);
    const commandId = String(posts[0].command_id);
    expect(mounted.wrapper.get('[data-testid="task-create-command-id"]').text()).toContain(commandId);
    await act(async () => { connect(otherWorkspaceId); }); await flush(30);
    expect(mounted.wrapper.get('input[name="task-project-id"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('#main-content [role="alert"]').text()).toContain("Workspace 不同");
    expect(mounted.wrapper.find('[data-testid="task-create-retry"]').exists()).toBe(false);
    await act(async () => { connect(); }); await flush(30);
    expect(mounted.wrapper.get('[data-testid="task-create-command-id"]').text()).toContain(commandId);
    await act(async () => { connect(); }); await flush(30);
    expect(mounted.wrapper.find('[data-testid="task-create-receipt"]').exists()).toBe(true);
    expect(posts).toHaveLength(1);
    await mounted.wrapper.get('[data-testid="task-create-receipt"]').trigger("click"); await flush(30);
    expect(mounted.wrapper.get('[data-testid="task-create-retry"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="task-create-retry"]').trigger("click"); await flush(30);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.wrapper.get('[data-testid="task-created-result"]').text()).toContain(taskId);
  });

  it.each(["预填已归档", "手填失权"])("%s Project 在提交前单读，拒绝创建且保留草稿", async (caseName) => {
    connect();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") throw new Error("Project must be verified before CreateTask");
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      const recent = recentTasksResponse(url); if (recent) return recent;
      if (url === `${root}/projects?status=active`) return response(200, { items: [], next_cursor: null });
      if (url === `${root}/tasks?project_id=${projectA}`) return response(200, { items: [], next_cursor: null });
      if (url === `${root}/projects/${projectA}`) return caseName === "预填已归档"
        ? response(200, { ...project(projectA, "历史项目"), archived_at: "2026-09-26T00:00:00Z", archive_status: "ARCHIVED" })
        : response(403, { code: "FORBIDDEN", detail: "Project 不可读" });
      throw new Error(`unexpected ${url}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(caseName === "预填已归档"
      ? `/tasks?view=create&project=${projectA}` : "/tasks?view=create"); unmount = mounted.unmount;
    if (caseName === "手填失权") await mounted.wrapper.get('input[name="task-project-id"]').setValue(projectA);
    await mounted.wrapper.get('input[name="task-title"]').setValue("保留的标题");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("可核对成果");
    await mounted.wrapper.get('[data-testid="task-create-inbox"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('#main-content [role="alert"]').text()).toContain(caseName === "预填已归档" ? "已归档" : "无法确认");
    expect((mounted.wrapper.get('input[name="task-title"]').element as HTMLInputElement).value).toBe("保留的标题");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === `${root}/tasks?scope=all`)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === `${root}/projects?status=active`)).toHaveLength(1);
  });
});
