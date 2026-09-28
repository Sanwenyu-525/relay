import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const blockedId = "44444444-4444-4444-8444-444444444444";
const projectId = "22222222-2222-4222-8222-222222222222";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(body: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
function envelope(id: string, result: Record<string, unknown>) { return { command_id: id, committed_at: "2026-09-26T00:00:00Z", result, links: { resource: "today" } }; }
function task(id: string, fields: Record<string, unknown> = {}) { return {
  task_id: id, task_revision: "2", project_id: projectId, title: id === taskId ? "可执行任务" : "受阻置顶任务",
  status: "READY", priority: null, due_local_date: null, timezone: null,
  pin: id === blockedId, later_local_date: null, later_timezone: null,
  reason_codes: id === blockedId ? ["PINNED", "LATER_ACTIVE"] : ["READY_TO_START"],
  evidence_refs: [`task:${id}/revision:2`],
  allowed_actions: id === blockedId ? ["UNPIN", "SET_LATER", "SET_FOCUS"] : ["START", "PIN", "SET_LATER", "SET_FOCUS"], ...fields
}; }
function taskDetail(id: string, linkedProject: string | null = projectId) { return {
  id, project_id: linkedProject, title: "任务", status: "READY", mode: "ME", revision: "2",
  executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
  waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: []
}; }
function targetRead(path: string): Response | null {
  if (path === `/tasks/${taskId}`) return response(taskDetail(taskId));
  if (path === `/tasks/${blockedId}`) return response(taskDetail(blockedId));
  if (path === `/projects/${projectId}`) return response({
    id: projectId, title: "项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null
  });
  return null;
}
function today(path: string, fields: Record<string, unknown> = {}) {
  const query = new URL(path, baseUrl).searchParams;
  const waiting = task(blockedId);
  return { date: query.get("date"), timezone: query.get("timezone"), selection_revision: "1", focus: null,
    focus_has_eligible_candidate: false, eligible_items: [task(taskId)], waiting_items: [waiting],
    blocked_pinned_items: [waiting], ...fields };
}
function postBody(init?: RequestInit): Record<string, unknown> { return JSON.parse(String(init?.body)) as Record<string, unknown>; }

describe("P13 Today 真实投影", () => {
  it("fixture 不查询 Today；live 区分候选、等待子集和服务端准入，Pin 发送全量选择", async () => {
    const fixtureFetch = vi.fn(); vi.stubGlobal("fetch", fixtureFetch);
    let mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("没有真实 Today 投影");
    expect(fixtureFetch).not.toHaveBeenCalled(); unmount(); unmount = null;

    connect(); const posts: Record<string, unknown>[] = []; let selected = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      const target = targetRead(path); if (target) return target;
      if (path.startsWith("/today?")) return response(today(path, selected ? {
        selection_revision: "2", eligible_items: [task(taskId, { pin: true, allowed_actions: ["START", "UNPIN", "SET_LATER", "SET_FOCUS"] })]
      } : {}));
      if (path === `/task-selections/${taskId}` && init?.method === "POST") {
        posts.push(postBody(init)); selected = true; return response(envelope(String(posts.at(-1)!.command_id), { selection_revision: "2" }));
      }
      throw new Error(`Unexpected ${path}`);
    }));
    mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("可开始或继续 · 1");
    expect(mounted.wrapper.text()).toContain("已置顶，待处理 · 1");
    expect(mounted.wrapper.text()).toContain("其他等待 · 0");
    expect(mounted.wrapper.text()).toContain("LATER_ACTIVE");
    expect(mounted.wrapper.text()).toContain(`task:${blockedId}/revision:2`);
    const blocked = mounted.wrapper.get(".today-group:nth-of-type(2)");
    expect(blocked.text()).not.toContain("打开任务");
    await mounted.wrapper.get(".today-group .today-task__actions button").trigger("click"); await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ expected_revision: "1", pin: true, later_local_date: null, timezone: null });
    expect(mounted.wrapper.text()).toContain("选择版本 v2");
  });

  it("日期和 IANA 时区切换重查，旧响应不覆盖；Focus 显示原时区与查询时区", async () => {
    connect();
    const oldRequest: { resolve?: (value: Response) => void } = {};
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length); requests.push(path);
      if (!path.startsWith("/today?")) throw new Error(`Unexpected ${path}`);
      const query = new URL(path, baseUrl).searchParams;
      if (query.get("date") !== "2026-09-27") return new Promise<Response>((resolve) => { oldRequest.resolve = resolve; });
      return response(today(path, { focus: { date: "2026-09-27", timezone: "Asia/Shanghai", target_kind: "TASK",
        target_id: taskId, selection_revision: "3", active_in_query: query.get("timezone") === "Asia/Shanghai" },
        focus_has_eligible_candidate: query.get("timezone") === "Asia/Shanghai",
        eligible_items: [task(taskId, { title: "新查询任务" })] }));
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    await mounted.wrapper.get('.today-query input[type="date"]').setValue("2026-09-27"); await flush();
    const adjustToggle = Array.from(mounted.wrapper.element!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("调整时区"))!;
    await new DomWrapper(adjustToggle).trigger("click"); await flush();
    await mounted.wrapper.get('.today-query input:not([type="date"])').setValue("Asia/Tokyo");
    await mounted.wrapper.get(".today-query form").trigger("submit"); await flush();
    expect(requests.some((path) => path.includes("date=2026-09-27") && path.includes("Asia%2FTokyo"))).toBe(true);
    expect(mounted.wrapper.text()).toContain("新查询任务");
    expect(mounted.wrapper.text()).toContain("选择原时区：Asia/Shanghai；查询时区：Asia/Tokyo；本次查询不生效");
    oldRequest.resolve?.(response(today(requests[0]!, { eligible_items: [task(taskId, { title: "旧查询任务" })] }))); await flush();
    expect(mounted.wrapper.text()).not.toContain("旧查询任务");
  });

  it("旧 Today 候选的 Project 已归档时零选择命令并清旧候选", async () => {
    connect(); let reads = 0; let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path.startsWith("/today?")) return response(today(path, ++reads === 1 ? {} : {
        eligible_items: [], waiting_items: [], blocked_pinned_items: []
      }));
      if (path === `/tasks/${taskId}`) return response(taskDetail(taskId));
      if (path === `/projects/${projectId}`) return response({
        id: projectId, title: "已归档", project_type: "GENERAL", revision: "2", state_revision: "1",
        archived_at: "2026-09-26T00:00:00.000Z"
      });
      if (init?.method === "POST") { posts++; throw new Error("unexpected Today command"); }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    await mounted.wrapper.get(".today-group .today-task__actions button").trigger("click"); await flush();
    expect(posts).toBe(0);
    expect(mounted.wrapper.text()).toContain("项目已归档");
    expect(mounted.wrapper.text()).not.toContain("可执行任务");
  });

  it("无 Project 的 Inbox Task 可 Pin，不请求其他 Project", async () => {
    connect(); let projectReads = 0; const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path.startsWith("/today?")) return response(today(path, {
        eligible_items: [task(taskId, { project_id: null })], waiting_items: [], blocked_pinned_items: []
      }));
      if (path === `/tasks/${taskId}`) return response(taskDetail(taskId, null));
      if (path.startsWith("/projects/")) { projectReads++; throw new Error("unexpected Project read"); }
      if (path === `/task-selections/${taskId}` && init?.method === "POST") {
        const body = postBody(init); posts.push(body);
        return response(envelope(String(body.command_id), { selection_revision: "2" }));
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    await mounted.wrapper.get(".today-group .today-task__actions button").trigger("click"); await flush();
    expect(posts).toHaveLength(1);
    expect(projectReads).toBe(0);
  });

  it("计划编辑以 Task revision 提交；409 保留表单与原 ID，刷新后显式重提", async () => {
    connect(); const posts: Record<string, unknown>[] = []; let revision = "2";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      const target = targetRead(path); if (target) return target;
      if (path.startsWith("/today?")) return response(today(path, { eligible_items: [task(taskId, { task_revision: revision })] }));
      if (path === `/tasks/${taskId}/planning-metadata` && init?.method === "POST") {
        const body = postBody(init); posts.push(body);
        if (posts.length === 1) { revision = "3"; return response({ code: "REVISION_CONFLICT", detail: "revision conflict",
          conflict: { expected_revision: "2", actual_revision: "3" } }, 409); }
        revision = "4"; return response(envelope(String(body.command_id), { task_id: taskId, status: "READY", revision }));
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const form = mounted.wrapper.get(".today-task__forms form:nth-of-type(2)");
    await form.get("select").setValue("HIGH"); await form.get('input[type="date"]').setValue("2026-10-02");
    await form.trigger("submit"); await flush();
    expect(posts[0]).toMatchObject({ expected_revision: "2", priority: "HIGH", due_local_date: "2026-10-02" });
    expect(mounted.wrapper.text()).toContain("上次失败命令 ID");
    expect((form.get("select").element as HTMLSelectElement).value).toBe("HIGH");
    expect((form.get('input[type="date"]').element as HTMLInputElement).value).toBe("2026-10-02");
    await form.trigger("submit"); await flush();
    expect(posts[1]).toMatchObject({ expected_revision: "3", priority: "HIGH", due_local_date: "2026-10-02" });
    expect(posts[1]!.command_id).not.toBe(posts[0]!.command_id);
  });

  it("响应不明先查原回执，404 后只以原 ID/原 payload 重试；Focus 不能放行受阻任务", async () => {
    connect(); const posts: Record<string, unknown>[] = []; let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      const target = targetRead(path); if (target) return target;
      if (path.startsWith("/today?")) return response(today(path));
      if (path === "/focus-selections" && init?.method === "POST") {
        posts.push(postBody(init));
        if (posts.length === 1) throw new TypeError("disconnected");
        return response(envelope(String(posts[0]!.command_id), { selection_revision: "2" }));
      }
      if (path.startsWith("/commands/")) { receiptCount++; return response({ code: "COMMAND_NOT_FOUND", detail: "not found" }, 404); }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const blocked = mounted.wrapper.get(".today-group:nth-of-type(2)");
    const focusButton = Array.from(blocked.element!.querySelectorAll("button")).find((button) => button.textContent?.includes("设为今日焦点"))!;
    await new DomWrapper(focusButton).trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("提交结果待核对");
    expect(posts[0]).toMatchObject({ expected_revision: "1", target_kind: "TASK", target_id: blockedId });
    expect(blocked.text()).not.toContain("打开任务");
    await mounted.wrapper.get('[data-testid="today-pending"] button').trigger("click"); await flush();
    expect(receiptCount).toBe(1);
    expect(mounted.wrapper.text()).toContain("同一 ID 和原内容重试");
    const retry = Array.from(mounted.wrapper.get('[data-testid="today-pending"]').element!.querySelectorAll("button"))[1]!;
    await new DomWrapper(retry).trigger("click"); await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(mounted.wrapper.text()).not.toContain("提交结果待核对");
  });

  it("Later 设置与清除保留 Pin 并递增 selection revision；跨时区清除 Focus 使用原时区", async () => {
    connect(); const posts: { path: string; body: Record<string, unknown> }[] = [];
    let selectionRevision = 1;
    let laterDate: string | null = null;
    let focusVisible = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      const target = targetRead(path); if (target) return target;
      if (path.startsWith("/today?")) {
        const focusDate = new URL(path, baseUrl).searchParams.get("date");
        const waiting = task(blockedId, { later_local_date: laterDate, later_timezone: laterDate ? "Asia/Shanghai" : null,
          allowed_actions: laterDate ? ["UNPIN", "SET_LATER", "CLEAR_LATER", "SET_FOCUS"] : ["UNPIN", "SET_LATER", "SET_FOCUS"] });
        return response(today(path, { selection_revision: String(selectionRevision), waiting_items: [waiting], blocked_pinned_items: [waiting],
          focus: focusVisible ? { date: focusDate, timezone: "Asia/Shanghai", target_kind: "TASK", target_id: blockedId,
            selection_revision: "1", active_in_query: false } : null }));
      }
      if ((path === `/task-selections/${blockedId}` || path === "/focus-selections") && init?.method === "POST") {
        const body = postBody(init); posts.push({ path, body }); selectionRevision++;
        if (path === "/focus-selections") focusVisible = false;
        else laterDate = body.later_local_date as string | null;
        return response(envelope(String(body.command_id), { selection_revision: String(selectionRevision) }));
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const blocked = mounted.wrapper.get(".today-group:nth-of-type(2)");
    await blocked.get('.today-task__forms form input[type="date"]').setValue("2026-10-04");
    await blocked.get(".today-task__forms form").trigger("submit"); await flush();
    expect(posts[0]!.body).toMatchObject({ expected_revision: "1", pin: true, later_local_date: "2026-10-04" });
    const clearLater = Array.from(blocked.element!.querySelectorAll("button")).find((button) => button.textContent?.includes("取消延后"))!;
    await new DomWrapper(clearLater).trigger("click"); await flush();
    expect(posts[1]!.body).toMatchObject({ expected_revision: "2", pin: true, later_local_date: null, timezone: null });
    const clearFocus = Array.from(mounted.wrapper.element!.querySelectorAll(".today-focus button")).find((button) => button.textContent?.includes("清除今日焦点"))!;
    await new DomWrapper(clearFocus).trigger("click"); await flush();
    expect(posts[2]!.body).toMatchObject({ expected_revision: "3", timezone: "Asia/Shanghai", target_kind: null, target_id: null });
    expect(mounted.wrapper.text()).toContain("还未选择今日焦点");
  });

  it("响应不明时匹配原回执后重读事实，不重复提交选择命令", async () => {
    connect(); let revision = "1"; let post: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      const target = targetRead(path); if (target) return target;
      if (path.startsWith("/today?")) return response(today(path, { selection_revision: revision }));
      if (path === `/task-selections/${taskId}` && init?.method === "POST") {
        if (post !== null) throw new Error("重复提交");
        post = postBody(init); revision = "2"; throw new TypeError("connection closed");
      }
      if (path === `/commands/${post?.command_id}`) return response({ ...envelope(String(post?.command_id), { selection_revision: "2" }),
        command_type: "SetTaskSelection" });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    await mounted.wrapper.get(".today-group .today-task__actions button").trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("提交结果待核对");
    await mounted.wrapper.get('[data-testid="today-pending"] button').trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("选择版本 v2");
    expect(mounted.wrapper.text()).not.toContain("提交结果待核对");
  });

  it("live 提供待审入口指向待审中心，不伪造待审计数", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path.startsWith("/today?")) return response(today(path));
      const target = targetRead(path); if (target) return target;
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    const entry = mounted.wrapper.get('[data-testid="today-review-entry"]');
    expect(entry.text()).toContain("打开待审中心");
    expect(mounted.wrapper.element!.querySelector('a[href="/reviews"]')).not.toBeNull();
    expect(entry.text()).not.toMatch(/\d/);
  });
});
