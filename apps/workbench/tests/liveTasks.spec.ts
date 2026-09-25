import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const tasksUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

describe("live 任务入口", () => {
  it("全部和收件箱均不读取示例任务，并保留真实项目与任务 ID 入口", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;

    expect(mounted.wrapper.get('[data-testid="tasks-live-gap"]').text()).toContain("全工作空间任务列表端点");
    expect(mounted.wrapper.text()).not.toContain("确定实验评价指标");
    expect(fixtureAdapter.getCallCount("listTasks")).toBe(0);
    expect(fixtureAdapter.getCallCount("loadTaskOptions")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="tasks-live-gap"]').text()).toContain("收件箱列表");
    expect(mounted.wrapper.text()).not.toContain("完善文献综述");
    expect(fixtureAdapter.getCallCount("listTasks")).toBe(0);
    expect(fixtureAdapter.getCallCount("loadTaskOptions")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    await mounted.wrapper.get('input[name="live-task-project-id"]').setValue(projectId);
    await mounted.wrapper.get('[data-testid="tasks-live-open-project"]').trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/projects/${projectId}/tasks`);

    await mounted.router.push("/tasks");
    await flush();
    await mounted.wrapper.get('input[name="live-task-id"]').setValue(taskId);
    await mounted.wrapper.get('[data-testid="tasks-live-open-task"]').trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe(`/tasks/${taskId}`);
  });

  it("真实创建回执返回任务入口后不混入示例列表", async () => {
    activate();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(tasksUrl);
      expect(init?.method).toBe("POST");
      const commandId = (JSON.parse(String(init?.body)) as { command_id: string }).command_id;
      return { ok: true, status: 201, json: async () => ({
        command_id: commandId,
        committed_at: "2026-09-24T00:00:00.000Z",
        result: { task_id: taskId, project_id: null, status: "INBOX", mode: "ME", revision: "0", acceptance_revision: "1" },
        links: { resource: `/api/v1/workspaces/${workspaceId}/tasks/${taskId}` }
      }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/tasks?view=create");
    unmount = mounted.unmount;

    await mounted.wrapper.get('input[name="task-title"]').setValue("本次真实任务");
    await mounted.wrapper.get('input[name="task-expected-result"]').setValue("真实结果");
    await mounted.wrapper.get('[data-testid="task-create-inbox"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="task-created-result"]').text()).toContain(taskId);
    const back = mounted.wrapper.findAll('[data-testid="task-created-result"] button').find((button) => button.text() === "返回任务入口");
    expect(back).toBeDefined();
    await back!.trigger("click");
    await flush();

    expect(mounted.router.currentRoute.value.path).toBe("/tasks");
    expect(mounted.wrapper.get('[data-testid="tasks-live-gap"]').text()).toContain("当前界面尚未接入");
    expect(mounted.wrapper.text()).not.toContain("确定实验评价指标");
    expect(fixtureAdapter.getCallCount("listTasks")).toBe(0);
    expect(fixtureAdapter.getCallCount("loadTaskOptions")).toBe(0);
    expect(fixtureAdapter.getCallCount("createTask")).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
