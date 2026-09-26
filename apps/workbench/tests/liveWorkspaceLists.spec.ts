import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const projectC = "44444444-4444-4444-8444-444444444444";
const taskA = "55555555-5555-4555-8555-555555555555";
const taskB = "66666666-6666-4666-8666-666666666666";
const taskC = "77777777-7777-4777-8777-777777777777";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const created = "2026-09-26T00:00:00.000Z";
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
function project(id: string, title: string, archived = false, nextTaskId: string | null = null) {
  return { id, title, project_type: "GENERAL", archived_at: archived ? created : null,
    archive_status: archived ? "ARCHIVED" : "ACTIVE", revision: "2", state_revision: "3",
    phase_key: "PLANNING", next_action_task_id: nextTaskId, created_at: created, updated_at: created };
}
function task(id: string, title: string, projectId: string | null, status = "INBOX") {
  return { id, title, project_id: projectId, status, mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] };
}

describe("live Workspace 项目与任务列表", () => {
  it("项目按归档范围游标分页；名称搜索和计数仅覆盖已加载项，下一步不伪造标题", async () => {
    connect();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url === `${root}/projects?status=active`) return response(200, { items: [
        project(projectA, "甲项目", false, taskA), project(projectB, "乙项目")], next_cursor: "p+2" });
      if (url === `${root}/projects?status=active&cursor=p%2B2`) return response(200, {
        items: [project(projectC, "丙项目")], next_cursor: null });
      if (url === `${root}/projects?status=archived`) return response(200, {
        items: [project(projectB, "历史项目", true)], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    expect(urls).toEqual([`${root}/projects?status=active`]);
    expect(mounted.wrapper.get('[data-testid="projects-live-count"]').text())
      .toContain("已加载 2 项 · 当前搜索显示 2 项 · 仍有后续页");
    expect(mounted.wrapper.get(`[data-testid="project-row-${projectA}"]`).text()).toContain(taskA);
    expect(mounted.wrapper.get('[data-testid="project-archive"]').attributes("disabled")).toBeUndefined();
    expect(mounted.wrapper.text()).toContain("归档前会单读当前 Project");
    expect(urls.every((url) => url.includes("/projects?status="))).toBe(true);
    await mounted.wrapper.get('input[name="live-project-search"]').setValue("乙");
    expect(mounted.wrapper.get('[data-testid="projects-live-count"]').text()).toContain("当前搜索显示 1 项");
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectA}"]`).exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="projects-live-load-more"]').trigger("click");
    await flush(30);
    expect(urls.at(-1)).toBe(`${root}/projects?status=active&cursor=p%2B2`);
    expect(mounted.wrapper.get('[data-testid="projects-live-count"]').text())
      .toContain("已加载 3 项 · 当前搜索显示 1 项 · 已到列表末页");
    await mounted.wrapper.get('[data-testid="projects-tab-archived"]').trigger("click");
    await flush(30);
    expect(urls.at(-1)).toBe(`${root}/projects?status=archived`);
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get(`[data-testid="project-row-${projectB}"]`).text()).toContain("历史项目");
    expect(mounted.wrapper.text()).not.toContain("归档项目只读");
  });

  it("项目刷新失权清旧数据，切范围和 Workspace 后迟到响应不能回写", async () => {
    connect();
    let authorized = true;
    let completeArchived: ((result: Response) => void) | null = null;
    const archivedPending = new Promise<Response>((resolve) => { completeArchived = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${root}/projects?status=active`) return authorized
        ? response(200, { items: [project(projectA, "旧项目")], next_cursor: null })
        : response(403, { code: "FORBIDDEN", detail: "项目列表不可读" });
      if (url === `${root}/projects?status=archived`) return archivedPending;
      if (url.includes(otherWorkspaceId)) return response(200, { items: [project(projectC, "新空间项目")], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/projects"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectA}"]`).exists()).toBe(true);
    authorized = false;
    await mounted.wrapper.get('[data-testid="projects-live-refresh"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("项目列表不可读");
    await mounted.wrapper.get('[data-testid="projects-tab-archived"]').trigger("click");
    expect(mounted.wrapper.text()).toContain("正在读取已归档项目");
    await mounted.wrapper.get('[data-testid="projects-tab-active"]').trigger("click");
    completeArchived!(response(200, { items: [project(projectB, "迟到历史项目", true)], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.text()).not.toContain("迟到历史项目");
    connect(otherWorkspaceId);
    await flush(30);
    expect(mounted.wrapper.get(`[data-testid="project-row-${projectC}"]`).text()).toContain("新空间项目");
    expect(mounted.wrapper.find(`[data-testid="project-row-${projectA}"]`).exists()).toBe(false);
  });

  it("全空间任务用 scope=all 游标分页，保留项目内与未归属项并按已加载范围筛选", async () => {
    connect();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url === `${root}/tasks?scope=all`) return response(200, { items: [
        task(taskA, "项目任务", projectA, "READY"), task(taskB, "收件箱任务", null)], next_cursor: "t+2" });
      if (url === `${root}/tasks?scope=all&cursor=t%2B2`) return response(200, {
        items: [task(taskC, "后续任务", projectB)], next_cursor: null });
      if (url === `${root}/tasks?inbox=true`) return response(200, {
        items: [task(taskB, "收件箱任务", null)], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(urls).toEqual([`${root}/tasks?scope=all`]);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text())
      .toContain("已加载 2 项 · 当前筛选显示 2 项 · 仍有后续页");
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskA}"]`).text()).toContain(projectA);
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskB}"]`).text()).toContain("未归属项目");
    await mounted.wrapper.get('select[name="task-filter-project"]').setValue(projectA);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("当前筛选显示 1 项");
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskB}"]`).exists()).toBe(false);
    await mounted.wrapper.get('select[name="task-filter-project"]').setValue("inbox");
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("当前筛选显示 1 项");
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    await mounted.wrapper.get('select[name="task-filter-project"]').setValue("all");
    await mounted.wrapper.get('select[name="task-filter-status"]').setValue("READY");
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("当前筛选显示 1 项");
    await mounted.wrapper.get('select[name="task-filter-status"]').setValue("all");
    await mounted.wrapper.get('input[name="task-search"]').setValue("项目");
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("当前筛选显示 1 项");
    await mounted.wrapper.get('[data-testid="tasks-live-load-more"]').trigger("click");
    await flush(30);
    expect(urls.at(-1)).toBe(`${root}/tasks?scope=all&cursor=t%2B2`);
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text())
      .toContain("已加载 3 项 · 当前筛选显示 1 项 · 已到列表末页");
    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    await flush(30);
    expect(urls.at(-1)).toBe(`${root}/tasks?inbox=true`);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
  });

  it("全空间任务刷新失权清旧行，换 Workspace 不保留旧计数", async () => {
    connect();
    let authorized = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(otherWorkspaceId)) return response(200, { items: [task(taskC, "新空间任务", null)], next_cursor: null });
      return authorized ? response(200, { items: [task(taskA, "旧任务", projectA)], next_cursor: null })
        : response(403, { code: "FORBIDDEN", detail: "任务列表不可读" });
    }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(true);
    authorized = false;
    await mounted.wrapper.get('[data-testid="tasks-live-refresh"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskA}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("任务列表不可读");
    connect(otherWorkspaceId); await flush(30);
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskC}"]`).text()).toContain("新空间任务");
    expect(mounted.wrapper.get('[data-testid="tasks-live-count"]').text()).toContain("已加载 1 项");
  });

  it("全空间任务切到收件箱后忽略旧范围迟到页", async () => {
    connect();
    let completeAll: ((result: Response) => void) | null = null;
    const allPending = new Promise<Response>((resolve) => { completeAll = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${root}/tasks?scope=all`) return allPending;
      if (url === `${root}/tasks?inbox=true`) return response(200, {
        items: [task(taskB, "当前收件箱任务", null)], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    await flush(30);
    completeAll!(response(200, { items: [task(taskA, "迟到全空间任务", projectA)], next_cursor: null }));
    await flush(30);
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskB}"]`).text()).toContain("当前收件箱任务");
    expect(mounted.wrapper.text()).not.toContain("迟到全空间任务");
    expect(mounted.wrapper.get('[data-testid="inbox-count"]').text()).toContain("已加载 1 项");
  });
});
