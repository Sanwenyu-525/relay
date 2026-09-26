import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const taskId1 = "22222222-2222-4222-8222-222222222222";
const taskId2 = "33333333-3333-4333-8333-333333333333";
const taskId3 = "55555555-5555-4555-8555-555555555555";
const path = `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks?inbox=true`;
const allPath = `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks?scope=all`;
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
function task(id: string, title: string, status = "INBOX", projectId: string | null = null,
  mode = "ME", executorKind = "HUMAN") {
  return { id, project_id: projectId, title, status, mode, revision: "2",
    executor: { kind: executorKind, run_id: null }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] };
}

describe("live 任务收件箱", () => {
  it("/inbox 直达真实收件箱 API", async () => {
    connect();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(path);
      return response(200, { items: [task(taskId1, "直达任务")], next_cursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/inbox"); unmount = mounted.unmount;
    expect(mounted.router.currentRoute.value.path).toBe("/tasks");
    expect(mounted.router.currentRoute.value.query.tab).toBe("inbox");
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskId1}"]`).text()).toContain("直达任务");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("按真实游标追加页，状态、模式和标题只筛选已加载任务且计数准确", async () => {
    connect();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url === path) return response(200, { items: [
        task(taskId1, "整理资料"), task(taskId2, "讨论提纲", "READY")], next_cursor: "opaque+2" });
      if (url === `${path}&cursor=opaque%2B2`) return response(200, {
        items: [task(taskId3, "检查结果")], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks?tab=inbox"); unmount = mounted.unmount;
    expect(urls).toEqual([path]);
    expect(mounted.wrapper.get('[data-testid="inbox-count"]').text())
      .toContain("已加载 2 项 · 当前筛选显示 2 项 · 仍有后续页");
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskId1}"]`).text()).toContain("未归属项目");
    await mounted.wrapper.get('select[name="task-filter-status"]').setValue("READY");
    expect(mounted.wrapper.get('[data-testid="inbox-count"]').text()).toContain("当前筛选显示 1 项");
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskId1}"]`).exists()).toBe(false);
    await mounted.wrapper.get('select[name="task-filter-mode"]').setValue("DELEGATE_AI");
    expect(mounted.wrapper.get('[data-testid="inbox-count"]').text()).toContain("当前筛选显示 0 项");
    expect(mounted.wrapper.text()).toContain("后续页可能仍有匹配任务");
    await mounted.wrapper.get('select[name="task-filter-mode"]').setValue("all");
    await mounted.wrapper.get('select[name="task-filter-status"]').setValue("all");
    await mounted.wrapper.get('input[name="task-search"]').setValue("资料");
    expect(mounted.wrapper.get('[data-testid="inbox-count"]').text()).toContain("当前筛选显示 1 项");
    await mounted.wrapper.get('[data-testid="inbox-load-more"]').trigger("click");
    await flush(40);
    expect(urls).toEqual([path, `${path}&cursor=opaque%2B2`]);
    expect(mounted.wrapper.get('[data-testid="inbox-count"]').text())
      .toContain("已加载 3 项 · 当前筛选显示 1 项 · 已到列表末页");
    expect(mounted.wrapper.find('[data-testid="inbox-load-more"]').exists()).toBe(false);
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskId1}"]`).attributes("href"))
      .toBe(`/tasks/${taskId1}`);
  });

  it("刷新遇到失权清空旧条目，允许重新读取", async () => {
    connect();
    let authorized = true;
    vi.stubGlobal("fetch", vi.fn(async () => authorized
      ? response(200, { items: [task(taskId1, "旧的已读任务")], next_cursor: null })
      : response(403, { code: "FORBIDDEN", detail: "收件箱不可读" })));
    const mounted = await mountWorkbench("/tasks?tab=inbox"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskId1}"]`).exists()).toBe(true);
    authorized = false;
    await mounted.wrapper.get('[data-testid="inbox-refresh"]').trigger("click");
    await flush(40);
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskId1}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("收件箱不可读");
    expect(mounted.wrapper.find('[data-testid="inbox-count"]').exists()).toBe(false);
  });

  it("切换范围和 Workspace 后不保留旧页，也不让晚到响应覆盖当前范围", async () => {
    connect();
    let finishOld: ((value: Response) => void) | null = null;
    const oldRequest = new Promise<Response>((resolve) => { finishOld = resolve; });
    let inboxReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === path) return ++inboxReads === 1
        ? response(200, { items: [task(taskId1, "旧空间任务")], next_cursor: null }) : oldRequest;
      if (url === allPath) return response(200, { items: [], next_cursor: null });
      if (url.includes(otherWorkspaceId)) return response(200, {
        items: [task(taskId2, "新空间任务")], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/tasks?tab=inbox"); unmount = mounted.unmount;
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskId1}"]`).text()).toContain("旧空间任务");
    await mounted.wrapper.get('[data-testid="tasks-tab-all"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="tasks-live-all"]').text())
      .toContain("当前工作空间没有任务");
    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    expect(mounted.wrapper.text()).toContain("正在读取真实收件箱任务");
    expect(mounted.wrapper.text()).not.toContain("旧空间任务");
    await mounted.wrapper.get('[data-testid="tasks-tab-all"]').trigger("click");
    finishOld!(response(200, { items: [task(taskId1, "晚到旧任务")], next_cursor: null }));
    await flush(40);
    expect(mounted.wrapper.text()).not.toContain("晚到旧任务");
    connect(otherWorkspaceId);
    await mounted.wrapper.get('[data-testid="tasks-tab-inbox"]').trigger("click");
    await flush(40);
    expect(mounted.wrapper.get(`[data-testid="task-row-${taskId2}"]`).text()).toContain("新空间任务");
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskId1}"]`).exists()).toBe(false);
  });

  it("拒绝混入有 Project 或非人工模式的错误列表响应", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async () => response(200, { items: [
      task(taskId1, "不应显示", "INBOX", "66666666-6666-4666-8666-666666666666")],
      next_cursor: null })));
    const mounted = await mountWorkbench("/tasks?tab=inbox"); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`[data-testid="task-row-${taskId1}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get('[role="alert"]').text()).toContain("非未归属人工任务");
  });
});
