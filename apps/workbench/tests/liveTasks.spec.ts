import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const tasksUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks`;
const projectsUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/projects?status=active`;
/** 左栏自 2026-10-10 起把工作区级会话与任务并列（协作页 §3.1），因此每次读列表都会带上这一次读取。
    2026-10-16 起目标/目录分组要读会话上下文，这次读取带 include_context=true。 */
const sessionsUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/assist-sessions?include_context=true`;
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
  it("近期工作独立读取，任务主区按 scope=all/inbox=true 切换且保留真实 ID 入口", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/attention/interventions")) return { ok: true, status: 200,
        json: async () => ({ items: [] }) } as Response;
      if (String(input) === projectsUrl) return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null }) } as Response;
      if (String(input) === `${tasksUrl}?inbox=true` || String(input) === `${tasksUrl}?scope=all`) return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null }) } as Response;
      throw new TypeError("offline");
    }));
    const mounted = await mountWorkbench("/tasks");
    unmount = mounted.unmount;

    // 首装空态按新文案与 testId 断言；断的是呈现方式，不是「不混入示例数据」这一行为。
    expect(mounted.wrapper.find('[data-testid="tasks-empty"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-empty"]').text()).toContain("还没有任务");
    expect(mounted.wrapper.text()).not.toContain("确定实验评价指标");
    expect(fixtureAdapter.getCallCount("listTasks")).toBe(0);
    expect(fixtureAdapter.getCallCount("loadTaskOptions")).toBe(0);
    const requestedUrls = () => vi.mocked(fetch).mock.calls.map(([input]) => String(input))
      .filter((url) => !url.endsWith("/attention/interventions"));
    // 一次来自全局近期工作（任务 + 会话），一次来自当前全部任务页。
    expect(requestedUrls()).toEqual([`${tasksUrl}?scope=all`, projectsUrl, sessionsUrl, `${tasksUrl}?scope=all`]);

    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    await flush();
    // 收件箱为空与整个工作空间为空是不同状态，各自用自己的空态。
    expect(mounted.wrapper.find('[data-testid="inbox-empty"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="inbox-empty"]').text()).toContain("收件箱里没有任务");
    expect(mounted.wrapper.text()).not.toContain("完善文献综述");
    expect(fixtureAdapter.getCallCount("listTasks")).toBe(0);
    expect(fixtureAdapter.getCallCount("loadTaskOptions")).toBe(0);
    expect(requestedUrls()).toEqual([`${tasksUrl}?scope=all`, projectsUrl, sessionsUrl,
      `${tasksUrl}?scope=all`, `${tasksUrl}?inbox=true`]);

    await mounted.router.push("/tasks");
    await flush();
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
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("真实创建回执返回任务入口后不混入示例列表", async () => {
    activate();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/attention/interventions")) return { ok: true, status: 200,
        json: async () => ({ items: [] }) } as Response;
      if (String(input) === projectsUrl) return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null }) } as Response;
      if (String(input) === `${tasksUrl}?scope=all`) return { ok: true, status: 200,
        json: async () => ({ items: [], next_cursor: null }) } as Response;
      if (String(input) === sessionsUrl) return { ok: true, status: 200,
        json: async () => ({ items: [] }) } as Response;
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
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => !url.endsWith("/attention/interventions")))
      .toEqual([`${tasksUrl}?scope=all`, projectsUrl, sessionsUrl]);

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
    // 换工作空间后重新落回首装空态；仍不得混入任何示例数据。
    expect(mounted.wrapper.find('[data-testid="tasks-empty"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="tasks-empty"]').text()).toContain("还没有任务");
    expect(mounted.wrapper.text()).not.toContain("确定实验评价指标");
    expect(fixtureAdapter.getCallCount("listTasks")).toBe(0);
    expect(fixtureAdapter.getCallCount("loadTaskOptions")).toBe(0);
    expect(fixtureAdapter.getCallCount("createTask")).toBe(0);
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => !url.endsWith("/attention/interventions")))
      .toEqual([`${tasksUrl}?scope=all`, projectsUrl, sessionsUrl, tasksUrl, `${tasksUrl}?scope=all`]);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
