import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * Task 轻量起步的反例（工作台 §18.7、总纲 §0.8、LC-01/LC-04）。
 *
 * 断言客户端行为与命令身份，不替代真实 API/PG 与真实 Windows 取证：
 * - 一句表达即可保存；标题与预期结果从这段话确定性派生，标题可改写。
 * - 这一步固定以「暂存待整理」提交：不带验收条件，也**不尝试**转为可开始。
 * - 服务端对「没有必需 criterion」另有 READY 栅栏，轻量入口不放宽它。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "66666666-6666-4666-8666-666666666666";
/** 只含路径：URL 的 pathname 不带 host。 */
const root = `/api/v1/workspaces/${workspaceId}`;
const intent = "把毕业论文的实验部分跑通并整理出可提交的初稿";

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Routes {
  /** 创建命令是否丢响应（服务端已提交，传输结果未知）。 */
  loseCreateResponse?: boolean;
  receipt?: (commandId: string) => Response;
}

function router(routes: Routes, posts: { path: string; body: Record<string, unknown> }[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (init?.method === "POST" && path === `${root}/tasks`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (routes.loseCreateResponse === true) throw new TypeError("response lost after commit");
      return response(201, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
        result: { task_id: taskId, project_id: null, status: "INBOX", mode: "ME",
          revision: "1", acceptance_revision: "1" } });
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return routes.receipt?.(receipt[1]!) ??
      response(404, { code: "COMMAND_NOT_FOUND", detail: "命令回执不存在" });
    if (init?.method !== "POST" && path === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
    if (init?.method !== "POST" && path === `${root}/projects`) return response(200, { items: [], next_cursor: null });
    if (path.endsWith("/attention/interventions")) return response(200, { items: [] });
    throw new Error(`Unexpected request ${path}${url.search}`);
  });
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("Task 轻量起步", () => {
  it("从任务页进入轻量入口；一句表达即可保存为待整理，不带验收条件也不转为可开始", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/tasks"); unmount = view.unmount;

    // 并列入口可达，完整表单仍保留为详细编辑入口。
    expect(view.wrapper.get('[data-testid="task-create-light-open"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="task-create-open"]').exists()).toBe(true);
    await view.router.push("/tasks?view=create&light=1");
    expect(view.wrapper.get('[data-testid="task-lightweight-form"]').exists()).toBe(true);
    // 轻量入口不要求验收标准字段。
    expect(view.wrapper.find('[data-testid="task-acceptance"]').exists()).toBe(false);

    // 空输入时不发命令。
    await view.wrapper.get('[data-testid="task-lightweight-save"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(0);

    await view.wrapper.get('[data-testid="task-lightweight-intent"]').setValue(intent);
    await flush();
    // 标题由首行确定性派生。
    expect(view.wrapper.get('[data-testid="task-lightweight-title"]').attributes("value")).toBe(intent);

    await view.wrapper.get('[data-testid="task-lightweight-save"]').trigger("click");
    await flush(); await flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.title).toBe(intent);
    expect(posts[0]?.body.objective).toBe(intent);
    // 关键：没有验收条件，也没有尝试 MarkTaskReady。
    expect(posts[0]?.body.criteria).toEqual([]);
    expect(posts.filter((post) => post.path.endsWith("/ready"))).toHaveLength(0);
    // 轻量入口不代填项目。
    expect(posts[0]?.body.project_id).toBeUndefined();
  });

  it("标题可改写且改写后不被输入覆盖；预期结果保存用户原话", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/tasks?view=create&light=1"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="task-lightweight-intent"]').setValue(`${intent}\n先跑通实验，再整理初稿`);
    await flush();
    expect(view.wrapper.get('[data-testid="task-lightweight-title"]').attributes("value")).toBe(intent);

    await view.wrapper.get('[data-testid="task-lightweight-title"]').setValue("论文实验与初稿");
    await flush();
    await view.wrapper.get('[data-testid="task-lightweight-intent"]').setValue("改写输入");
    await flush();
    expect(view.wrapper.get('[data-testid="task-lightweight-title"]').attributes("value")).toBe("论文实验与初稿");

    await view.wrapper.get('[data-testid="task-lightweight-save"]').trigger("click");
    await flush(); await flush();
    expect(posts[0]?.body.title).toBe("论文实验与初稿");
    expect(posts[0]?.body.objective).toBe("改写输入");
  });

  it("明确告知这一步不会变成「可开始」，也不靠放宽验收栅栏省步骤", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/tasks?view=create&light=1"); unmount = view.unmount;

    const scope = view.wrapper.get('[data-testid="task-lightweight-scope"]').text();
    expect(scope).toContain("待整理");
    expect(scope).toContain("不会");
    expect(view.wrapper.get('[data-testid="task-lightweight-save"]').text()).toBe("保存为待整理");
  });

  it("创建响应丢失后停在可核对状态，由用户手动查原 command_id；入口不自动核对，也不换 ID 重建第二个任务", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const fetchMock = router({
      loseCreateResponse: true,
      receipt: (commandId) => response(200, { command_id: commandId, command_type: "CreateTask",
        committed_at: "2026-10-04T00:00:05Z",
        result: { task_id: taskId, project_id: null, status: "INBOX", mode: "ME",
          revision: "1", acceptance_revision: "1" } }),
    }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/tasks?view=create&light=1"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="task-lightweight-intent"]').setValue(intent);
    await flush();
    await view.wrapper.get('[data-testid="task-lightweight-save"]').trigger("click");
    await flush(); await flush();

    const receiptRequests = () => fetchMock.mock.calls
      .map((call) => new URL(String(call[0])).pathname)
      .filter((path) => /\/commands\/[^/]+$/u.test(path));

    // 没有发生自动核对：整个失败路径没有查询过回执，也没有产生任何已创建证据。
    expect(receiptRequests()).toHaveLength(0);
    expect(view.wrapper.find('[data-testid="task-created-result"]').exists()).toBe(false);
    expect(view.wrapper.find(".receipt-message").exists()).toBe(false);
    // 还没查过回执，就没有依据给出「用原 ID 和载荷重试创建」。
    expect(view.wrapper.find('[data-testid="task-create-retry"]').exists()).toBe(false);

    // 手动核对（本入口现状，Goal 轻量创建才是自动核对）：pendingStep 保留原命令身份，
    // 页面继续停在表单上，并给出可点的「查询本次回执」和保留原 ID 的提示。
    const form = view.wrapper.get('[data-testid="task-lightweight-form"]');
    const commandIdText = view.wrapper.get('[data-testid="task-create-command-id"]').text();
    const commandId = /[0-9a-f-]{36}/u.exec(commandIdText)?.[0] ?? "";
    expect(commandIdText).toMatch(/[0-9a-f-]{36}/u);
    expect(posts[0]?.body.command_id).toBe(commandId);
    expect(view.wrapper.get('[data-testid="task-create-receipt"]').text()).toBe("查询本次回执");
    expect(form.find(".action-error").text()).toContain("请用同一个 command ID 查询回执");
    expect(view.wrapper.get('[data-testid="task-lightweight-save"]').attributes("disabled")).not.toBeNull();
    // 结果不确定时不换 ID 重建第二个任务：创建命令仍然只有一条。
    expect(posts.filter((post) => post.path === `${root}/tasks`)).toHaveLength(1);

    // 手动核对：只有用户点了「查询本次回执」，才发出唯一一条回执查询，用的还是原 command_id。
    await view.wrapper.get('[data-testid="task-create-receipt"]').trigger("click");
    await flush(); await flush();
    expect(receiptRequests().map((path) => /\/commands\/([^/]+)$/u.exec(path)?.[1])).toEqual([commandId]);
    expect(posts.filter((post) => post.path === `${root}/tasks`)).toHaveLength(1);
    const created = view.wrapper.get('[data-testid="task-created-result"]');
    expect(view.wrapper.get('[data-testid="task-created-open-detail"]').text()).toBe(taskId);
    expect(created.text()).toContain("待整理");
  });

  it("双击保存只发出一条创建命令", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/tasks?view=create&light=1"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="task-lightweight-intent"]').setValue(intent);
    await flush();
    const save = view.wrapper.get('[data-testid="task-lightweight-save"]');
    await save.trigger("click");
    await save.trigger("click");
    await flush(); await flush();

    expect(posts.filter((post) => post.path === `${root}/tasks`)).toHaveLength(1);
  });

  it("轻量入口仍受既有草稿保护约束，未保存内容离页要经过守卫", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/tasks?view=create&light=1"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="task-lightweight-intent"]').setValue(intent);
    await flush();
    await view.router.push("/projects");
    await flush();

    // 草稿保护是既有机制：轻量入口不另开一套，也不静默丢弃。
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("保留未保存的修改");
  });
});
