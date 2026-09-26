import { describe, expect, it, afterEach, vi } from "vitest";
import { act } from "react";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals();
});

describe("项目任务", () => {
  it("切项目立即清旧任务快照，旧项目迟到读取不能覆盖新项目", async () => {
    const baseUrl = "http://127.0.0.1:8787";
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const oldId = "22222222-2222-4222-8222-222222222222";
    const slowId = "33333333-3333-4333-8333-333333333333";
    const nextId = "44444444-4444-4444-8444-444444444444";
    const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
    let finishSlow: ((value: Response) => void) | null = null;
    const slowProject = new Promise<Response>((resolve) => { finishSlow = resolve; });
    const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === `/projects/${slowId}`) return slowProject;
      const projectId = [oldId, nextId].find((candidate) => path === `/projects/${candidate}`);
      if (projectId) return response({ id: projectId, title: projectId === oldId ? "旧项目" : "新项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if ([oldId, slowId, nextId].some((candidate) => path === `/tasks?project_id=${candidate}`))
        return response({ items: [], next_cursor: null });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${oldId}/tasks`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("旧项目");
    await mounted.router.push(`/projects/${slowId}/tasks`);
    expect(mounted.wrapper.text()).toContain("正在读取项目任务");
    expect(mounted.wrapper.text()).not.toContain("旧项目");
    await mounted.router.push(`/projects/${nextId}/tasks`); await flush();
    expect(mounted.wrapper.text()).toContain("新项目");
    await act(async () => finishSlow?.(response({ id: slowId, title: "迟到项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null })));
    await flush();
    expect(mounted.wrapper.text()).toContain("新项目");
    expect(mounted.wrapper.text()).not.toContain("迟到项目");
  });
  it("开始响应为 5xx 时保留原命令，回执未找到后仅用同 ID 与修订重试", async () => {
    const baseUrl = "http://127.0.0.1:8787";
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const taskId = "33333333-3333-4333-8333-333333333333";
    const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
    const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
    const otherRoot = `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}`;
    const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status,
      json: async () => body }) as Response;
    const posts: Record<string, unknown>[] = [];
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(otherRoot)) {
        const otherPath = String(input).slice(otherRoot.length);
        if (init?.method === "POST" || otherPath.startsWith("/commands/"))
          throw new Error(`Unexpected command in new Workspace ${otherPath}`);
        if (otherPath === `/projects/${projectId}`) return response(200, { id: projectId, title: "其他 Workspace 项目",
          project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
        if (otherPath === `/tasks?project_id=${projectId}`) return response(200, { items: [], next_cursor: null });
      }
      const path = String(input).slice(root.length);
      if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "进行中项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `/tasks?project_id=${projectId}`) return response(200, { items: [{ id: taskId,
        project_id: projectId, title: "待开始任务", status: posts.length > 1 ? "IN_PROGRESS" : "READY",
        mode: "ME", revision: posts.length > 1 ? "2" : "1",
        executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
        waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["START"] }],
      next_cursor: null });
      if (path === `/tasks/${taskId}`) return response(200, { id: taskId, project_id: projectId,
        title: "待开始任务", status: "READY", mode: "ME", revision: "1",
        executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
        waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["START"],
        acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] },
        dependencies: [] });
      if (path.startsWith("/commands/")) {
        expect(path).toBe(`/commands/${posts[0].command_id}`);
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "未找到回执" });
      }
      if (path === `/tasks/${taskId}/start` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return posts.length === 1 ? response(500, { code: "INTERNAL_ERROR", detail: "请求结果未知" }) :
          response(200, { command_id: posts[0].command_id, committed_at: "2026-09-26T00:00:00Z",
            result: { task_id: taskId, status: "IN_PROGRESS", revision: "2" } });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="project-task-start"]').trigger("click"); await flush(30);
    expect(mounted.wrapper.get('[data-testid="project-task-unresolved"]').text()).toContain("原开始命令待核对");
    await act(async () => activateRelayConnection({ baseUrl, workspaceId: otherWorkspaceId,
      bearerToken: "other-test-bearer-token-0123456789" }));
    await flush();
    expect(mounted.wrapper.text()).toContain("其他 Workspace 项目");
    expect(mounted.wrapper.find('[data-testid="project-task-unresolved"]').exists()).toBe(false);
    await act(async () => activateRelayConnection({ baseUrl, workspaceId,
      bearerToken: "test-bearer-token-0123456789abcdef" }));
    await flush();
    expect(mounted.wrapper.get('[data-testid="project-task-unresolved"]').text()).toContain("原开始命令待核对");
    expect(mounted.wrapper.get('[data-testid="project-task-receipt"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="project-task-receipt"]').trigger("click"); await flush(30);
    await mounted.wrapper.get('[data-testid="project-task-retry"]').trigger("click"); await flush(30);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[1]).toMatchObject({ expected_revision: "1" });
    expect(mounted.wrapper.text()).toContain("原命令已确认");
  });
  it("归档项目深链保留任务只读列表，禁新建和开始", async () => {
    const baseUrl = "http://127.0.0.1:8787";
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const taskId = "33333333-3333-4333-8333-333333333333";
    const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") throw new Error(`Unexpected write ${path}`);
      if (path === `/projects/${projectId}`) return { ok: true, status: 200, json: async () => ({
        id: projectId, title: "归档项目", project_type: "GENERAL", revision: "2",
        state_revision: "1", archived_at: "2026-09-26T00:00:00Z" }) } as Response;
      if (path === `/tasks?project_id=${projectId}`) return { ok: true, status: 200, json: async () => ({
        items: [{ id: taskId, project_id: projectId, title: "历史任务", status: "READY", mode: "ME",
          revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
          waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["START"] }],
        next_cursor: null }) } as Response;
      if (path === `/tasks/${taskId}`) return { ok: true, status: 200, json: async () => ({
        id: taskId, project_id: projectId, title: "历史任务", status: "READY", mode: "ME",
        revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
        waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["START"],
        acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] },
        dependencies: [] }) } as Response;
      throw new Error(`Unexpected read ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/tasks`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("历史任务");
    expect(mounted.wrapper.get('[data-testid="project-tasks-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.find(`a[href="/tasks?view=create&project=${projectId}"]`).exists()).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("固定在当前项目范围，并给出项目内导航", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("人机协作工作流研究");
    expect(mounted.wrapper.text()).toContain("项目任务");
    const active = mounted.wrapper.get(".subnav-item--active");
    expect(active.text()).toBe("任务");
    expect(active.attributes("aria-current")).toBe("page");
    expect(mounted.wrapper.find('[data-testid="project-task-row-task-recovery-logic"]').exists()).toBe(false);
  });

  it("默认选中被阻塞的任务，并展示阻塞原因与前置依赖", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("为什么暂不能开始");
    expect(mounted.wrapper.text()).toContain("前置任务“确定实验评价指标”尚未完成");
    expect(mounted.wrapper.text()).toContain("完成以下前置任务后，方可开始本任务。");
    expect(mounted.wrapper.text()).toContain("本任务完成后，将为论文的实验结果与分析提供关键数据支持。");
  });

  it("依赖不满足时禁用开始并说明原因，可开始任务才能开始", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="project-task-start-reason"]').text()).toContain("阻塞");

    await mounted.wrapper.get('[data-testid="project-task-row-task-organize-material"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="project-task-start"]').attributes("disabled")).toBeUndefined();

    await mounted.wrapper.get('[data-testid="project-task-start"]').trigger("click");
    await flush(80);

    expect(fixtureAdapter.getCallCount("startTask")).toBe(1);
    expect(mounted.wrapper.text()).toContain("本次演示已开始");
    expect(mounted.wrapper.text()).toContain("开始不等于完成");
    expect(mounted.wrapper.get('[data-testid="project-task-start-reason"]').text()).toContain("进行中");
  });

  it("搜索只在当前项目范围内过滤", async () => {
    const mounted = await mountWorkbench("/projects/project-hci/tasks");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="project-task-search"]').setValue("文献");
    await flush();

    expect(mounted.wrapper.find('[data-testid="project-task-row-task-literature-review"]').exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="project-task-row-task-organize-material"]').exists()).toBe(false);
  });

  it("未知项目给出空状态，不据此创建项目", async () => {
    const mounted = await mountWorkbench("/projects/unknown-project/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.text()).toContain("没有这个示例项目");
    expect(mounted.wrapper.text()).toContain("不会据此创建项目或任务");
  });
});
