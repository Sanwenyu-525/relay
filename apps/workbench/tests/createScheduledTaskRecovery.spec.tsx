import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomWrapper, dialogText, flush, mountWorkbench } from "./mountApp";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const otherRoot = `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function project(id: string, title: string) {
  return { id, title, project_type: "GENERAL", archived_at: null, archive_status: "ACTIVE",
    revision: "1", state_revision: "1", phase_key: "PLANNING", next_action_task_id: null,
    created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z" };
}
function created(id: string) {
  return { scheduled_task_id: id, project_id: projectId, status: "ENABLED", revision: "1",
    schedule_generation: "1", next_due_at: "2026-10-22T01:00:00.000Z" };
}
function detail(id: string) {
  return {
    ...created(id), title: "每早整理", template: { task_title: "每早整理", objective: "整理昨日进展",
      criteria: [{ statement: "覆盖三项进展" }], mode: "AI_ASSIST" },
    repeat_rule: { kind: "DAILY", interval_days: 1 }, timezone: "Asia/Shanghai", local_time: "09:00",
    first_run_at: "2026-10-22T01:00:00.000Z", max_runs: 10, runs_started: 0,
    authorization_expires_at: "2026-11-18T01:00:00.000Z", created_at: "2026-10-21T00:00:00.000Z",
    project: { title: "甲项目", revision: "1", archived: false }, occurrences: [],
  };
}
function envelope(commandId: string, result: unknown) {
  return { command_id: commandId, committed_at: "2026-10-21T00:00:00.000Z", result, links: {} };
}
function common(url: string): Response | null {
  if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
  for (const prefix of [root, otherRoot]) {
    if (url === `${prefix}/tasks?scope=all`) return response(200, { items: [], next_cursor: null });
    if (url === `${prefix}/assist-sessions?include_context=true`) return response(200, { items: [] });
    if (url === `${prefix}/projects?status=active`) return response(200, {
      items: prefix === root ? [project(projectId, "甲项目")] : [], next_cursor: null });
  }
  if (url === `${root}/scheduled-tasks`) return response(200, { project_id: null, items: [] });
  if (url === `${root}/scheduled-tasks/${taskId}`) return response(200, detail(taskId));
  return null;
}

async function fill(mounted: Awaited<ReturnType<typeof mountWorkbench>>) {
  await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue("每早整理");
  await mounted.wrapper.get('[data-testid="scheduled-task-objective"]').setValue("整理昨日进展");
  await mounted.wrapper.get('[data-testid="scheduled-task-criteria"]').setValue("覆盖三项进展");
}
async function submit(mounted: Awaited<ReturnType<typeof mountWorkbench>>) {
  await mounted.wrapper.get("form.create-form").trigger("submit");
  await flush(30);
}

describe("新建定时任务的草稿与结果核对", () => {
  it("默认项目落位不算未保存；改过字段后离开要提示，保留后输入仍在", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const commonResponse = common(String(input));
      if (commonResponse) return commonResponse;
      throw new Error(`unexpected ${String(input)}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    expect((mounted.wrapper.get('[data-testid="scheduled-task-project"]').element as HTMLSelectElement).value).toBe(projectId);

    // 项目默认值落位后仍是干净表单：直接离开不应弹确认。
    await mounted.router.push("/scheduled-tasks"); await flush(30);
    expect(mounted.router.currentRoute.value.query.view).toBeUndefined();
    expect(dialogText()).toBe("");

    await mounted.router.push("/scheduled-tasks?view=create"); await flush(30);
    await mounted.wrapper.get('[data-testid="scheduled-task-title"]').setValue("每早整理");
    await mounted.router.push("/scheduled-tasks"); await flush(30);
    expect(mounted.router.currentRoute.value.query.view).toBe("create");
    expect(dialogText()).toContain("即将离开的页面还有未保存的修改");
    const dialog = new DomWrapper(document.querySelector('[role="dialog"]'));
    await dialog.findAll("button").find((button) => button.text() === "保留并继续编辑")!.trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.query.view).toBe("create");
    expect((mounted.wrapper.get('[data-testid="scheduled-task-title"]').element as HTMLInputElement).value)
      .toBe("每早整理");
  });

  it("响应丢失后冻结原 command_id；回执命中即进详情，不重复创建", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    let receiptChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        throw new TypeError("response lost");
      }
      if (url.startsWith(`${root}/commands/`)) {
        receiptChecks += 1;
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        return response(200, { ...envelope(commandId, created(taskId)), command_type: "CreateScheduledTask" });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);

    expect(posts).toHaveLength(1);
    const commandId = String(posts[0]!.command_id);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-pending"]').text()).toContain(commandId);
    expect(mounted.wrapper.text()).toContain("创建结果未确认");
    expect(mounted.wrapper.get('[data-testid="scheduled-task-title"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="scheduled-task-submit"]').attributes("disabled")).toBeDefined();

    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(receiptChecks).toBe(1);
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
    expect(posts).toHaveLength(1);
  });

  it("HTTP 500 可能已提交，同样按结果未知冻结原 command_id；回执命中即进详情", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    let receiptChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(500, { code: "INTERNAL_ERROR", detail: "服务端已处理，但响应链失败" });
      }
      if (url.startsWith(`${root}/commands/`)) {
        receiptChecks += 1;
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        return response(200, { ...envelope(commandId, created(taskId)), command_type: "CreateScheduledTask" });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);

    expect(posts).toHaveLength(1);
    const commandId = String(posts[0]!.command_id);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-pending"]').text()).toContain(commandId);
    // 500 不是明确拒绝：再点提交不能替用户生成第二个创建意图。
    await submit(mounted);
    expect(posts).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-submit"]').attributes("disabled")).toBeDefined();

    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(receiptChecks).toBe(1);
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
    expect(posts).toHaveLength(1);
  });

  it("HTTP 500 后回执未找到：只按原 ID 与原载荷重试，不生成新命令", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) return response(500, { code: "INTERNAL_ERROR", detail: "服务端已处理，但响应链失败" });
        return response(201, envelope(String(body.command_id), created(taskId)));
      }
      if (url.startsWith(`${root}/commands/`)) return response(404, {
        code: "COMMAND_NOT_FOUND", detail: "command not found" });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);

    expect(posts).toHaveLength(1);
    expect(mounted.wrapper.find('[data-testid="scheduled-task-pending"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("原命令暂未查到回执");
    await mounted.wrapper.get('[data-testid="scheduled-task-retry-original"]').trigger("click");
    await flush(30);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
  });

  it("回执未找到时只允许按原 ID 与原内容重试；重试成功后离开且载荷不变", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) throw new TypeError("response lost");
        return response(201, envelope(String(body.command_id), created(taskId)));
      }
      if (url.startsWith(`${root}/commands/`)) return response(404, {
        code: "COMMAND_NOT_FOUND", detail: "command not found" });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);

    expect(posts).toHaveLength(1);
    expect(mounted.wrapper.find('[data-testid="scheduled-task-retry-original"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("原命令暂未查到回执");
    expect(mounted.wrapper.get('[data-testid="scheduled-task-retry-original"]').text()).toContain("按原 ID 和原内容重试");

    await mounted.wrapper.get('[data-testid="scheduled-task-retry-original"]').trigger("click");
    await flush(30);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
  });

  it("服务端明确拒绝时解除锁定，下一次提交使用新 command_id", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) return response(422, { code: "VALIDATION_FAILED", detail: "模板无效",
          field_errors: [{ field: "template", message: "验收标准不能为空" }] });
        return response(201, envelope(String(body.command_id), created(taskId)));
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);

    expect(posts).toHaveLength(1);
    expect(mounted.wrapper.text()).toContain("创建失败");
    expect(mounted.wrapper.find('[data-testid="scheduled-task-pending"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-title"]').attributes("disabled")).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="scheduled-task-submit"]').attributes("disabled")).toBeUndefined();

    await submit(mounted);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.command_id).not.toBe(posts[0]!.command_id);
    expect({ ...posts[1], command_id: "" }).toEqual({ ...posts[0], command_id: "" });
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
  });

  it("响应未知时切换 API/Workspace 不解锁；切回原连接后才核对并可重试", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    let crossWorkspaceReceiptChecks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) throw new TypeError("response lost");
        return response(201, envelope(String(body.command_id), created(taskId)));
      }
      if (url.startsWith(`${otherRoot}/commands/`)) { crossWorkspaceReceiptChecks += 1; throw new Error("不得在新 Workspace 核对旧命令"); }
      if (url.startsWith(`${root}/commands/`)) return response(404, { code: "COMMAND_NOT_FOUND", detail: "command not found" });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);
    const commandId = String(posts[0]!.command_id);

    await act(async () => {
      activateRelayConnection({ baseUrl, workspaceId: otherWorkspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    });
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-pending"]').text()).toContain(commandId);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-title"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("原命令属于之前的 API 或 Workspace");
    expect(crossWorkspaceReceiptChecks).toBe(0);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-pending"]').text()).toContain(commandId);

    await act(async () => { connect(); });
    await flush(30);
    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-retry-original"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="scheduled-task-retry-original"]').trigger("click");
    await flush(30);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.router.currentRoute.value.path).toBe(`/scheduled-tasks/${taskId}`);
  });

  it("回执类型或对象不匹配时不放行，仍停留在待核对", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const commonResponse = common(url);
      if (commonResponse) return commonResponse;
      if (url === `${root}/projects/${projectId}/scheduled-tasks` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        throw new TypeError("response lost");
      }
      if (url.startsWith(`${root}/commands/`)) {
        const commandId = decodeURIComponent(url.slice(`${root}/commands/`.length));
        return response(200, { ...envelope(commandId, { ...created(taskId), project_id: "88888888-8888-4888-8888-888888888888" }),
          command_type: "CreateScheduledTask" });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/scheduled-tasks?view=create"); unmount = mounted.unmount;
    await flush(30);
    await fill(mounted);
    await submit(mounted);
    expect(posts).toHaveLength(1);

    await mounted.wrapper.get('[data-testid="scheduled-task-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("仍需核对");
    expect(mounted.wrapper.find('[data-testid="scheduled-task-pending"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="scheduled-task-submit"]').attributes("disabled")).toBeDefined();
    expect(mounted.router.currentRoute.value.query.view).toBe("create");
    expect(posts).toHaveLength(1);
  });
});
