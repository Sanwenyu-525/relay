import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 今日计划表单与服务器事实的基线绑定（#21 / DEV-0139）。
 *
 * - 未编辑的表单在刷新拿到同任务新事实时整体同步，提交用新修订 + 新值；
 * - 已编辑的草稿保留并冻结原编辑基线：保存暂停、展示新旧差异，由用户明确选择
 *   「按最新事实重填」或「保留我的修改（按新基线提交）」，不能拿新修订静默回写旧字段；
 * - 冲突（409）后的重读保持既有语义：保留草稿、显式重提按新修订走；
 * - 未决命令的冻结载荷不因刷新改写。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const root = `/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  sessionStorage.clear();
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function taskDetail(id: string) {
  return { id, project_id: projectId, title: "任务", status: "READY", mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] };
}
function todayItem(fields: Record<string, unknown> = {}) {
  return { task_id: taskId, task_revision: "2", project_id: projectId, title: "表单基线探针",
    status: "READY", priority: null, due_local_date: null, timezone: null,
    pin: false, later_local_date: null, later_timezone: null,
    reason_codes: ["READY_TO_START"], evidence_refs: [], allowed_actions: ["PIN", "SET_LATER"], ...fields };
}
function todayBody(item: ReturnType<typeof todayItem>) {
  return { date: "2026-10-24", timezone: "Asia/Shanghai", selection_revision: "1", focus: null,
    focus_has_eligible_candidate: false, eligible_items: [item], waiting_items: [], blocked_pinned_items: [] };
}

interface HarnessRoutes {
  /** 初次 /today 读取的任务事实（缺省 v2 基线）。 */
  initialItem?: Record<string, unknown>;
  /** 后续读取（刷新或冲突重读）返回的任务事实；缺省沿用初版。 */
  nextItem?: Record<string, unknown>;
  /** 计划 POST 的响应：缺省 409 REVISION_CONFLICT（探针式，不真写）。 */
  planningResponse?: (body: Record<string, unknown>) => Response;
}

async function mountToday(routes: HarnessRoutes) {
  const posts: Record<string, unknown>[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (init?.method === "POST" && path === `${root}/tasks/${taskId}/planning-metadata`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return routes.planningResponse?.(body) ??
        response(409, { code: "REVISION_CONFLICT", detail: "probe does not write actual state" });
    }
    if (path === `${root}/today`) {
      reads += 1;
      // 首读按初版事实，之后（刷新或冲突重读）按新事实；date/timezone 按查询参数回显。
      const fields = reads === 1 ? (routes.initialItem ?? {}) : (routes.nextItem ?? routes.initialItem ?? {});
      return response(200, { ...todayBody(todayItem(fields)),
        date: url.searchParams.get("date"), timezone: url.searchParams.get("timezone") });
    }
    if (path === `${root}/tasks/${taskId}`) return response(200, taskDetail(taskId));
    if (path === `${root}/projects/${projectId}`) return response(200, {
      id: projectId, title: "项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${root}/attention/interventions` || path === `${root}/assist-sessions`) return response(200, { items: [], next_cursor: null });
    if (path === `${root}/reviews`) return response(200, { items: [] });
    if (path === `${root}/tasks` || path === `${root}/projects`) return response(200, { items: [], next_cursor: null });
    throw new Error(`Unexpected ${path}`);
  }));
  const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
  await flush();
  return { mounted, posts };
}

function planningForm(mounted: NonNullable<Awaited<ReturnType<typeof mountToday>>["mounted"]>) {
  return mounted.wrapper.get(".today-task__forms form:nth-of-type(2)");
}

describe("今日计划表单的基线同步与冻结", () => {
  it("未编辑表单随刷新同步新事实，提交用新修订与新值，不回写旧字段", async () => {
    connect();
    let updated = false;
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (init?.method === "POST" && path === `${root}/tasks/${taskId}/planning-metadata`) {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(409, { code: "REVISION_CONFLICT", detail: "probe does not write actual state" });
      }
      if (path === `${root}/today`) return response(200, { ...todayBody(todayItem(updated ? {
        task_revision: "3", priority: "HIGH", due_local_date: "2026-11-01", timezone: "Asia/Shanghai"
      } : {})), date: url.searchParams.get("date"), timezone: url.searchParams.get("timezone") });
      if (path === `${root}/tasks/${taskId}`) return response(200, taskDetail(taskId));
      if (path === `${root}/projects/${projectId}`) return response(200, {
        id: projectId, title: "项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${root}/attention/interventions`) return response(200, { items: [] });
      if (path === `${root}/reviews`) return response(200, { items: [] });
      if (path === `${root}/tasks` || path === `${root}/projects`) return response(200, { items: [], next_cursor: null });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench("/today"); unmount = mounted.unmount;
    expect((mounted.wrapper.get('.today-task select').element as HTMLSelectElement).value).toBe("");

    updated = true;
    await mounted.wrapper.get('.today-query .secondary-button').trigger("click"); await flush();
    expect(mounted.wrapper.get('.today-task__trace').text()).toContain("任务修订 v3");
    expect((mounted.wrapper.get('.today-task select').element as HTMLSelectElement).value).toBe("HIGH");
    expect((mounted.wrapper.get('.today-task__forms form:nth-of-type(2) input[type="date"]').element as HTMLInputElement).value).toBe("2026-11-01");

    await planningForm(mounted).trigger("submit"); await flush();
    expect(posts[0]).toMatchObject({ expected_revision: "3", priority: "HIGH", due_local_date: "2026-11-01" });
  });

  it("已编辑草稿遇外部更新被冻结：保存暂停、展示差异，明确选择后才有下一步", async () => {
    connect();
    const { mounted, posts } = await mountToday({
      nextItem: { task_revision: "3", priority: "HIGH", due_local_date: "2026-11-01", timezone: "Asia/Shanghai" } });
    const form = planningForm(mounted);
    // 用户先按 v2 编辑：优先级改为 LOW。
    await form.get("select").setValue("LOW"); await flush();
    expect(mounted.wrapper.find('[data-testid="today-task-stale"]').exists()).toBe(false);

    // 刷新拿到 v3 新事实：草稿保留，基线冻结，出现差异提示。
    await mounted.wrapper.get('.today-query .secondary-button').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="today-task-stale"]').text()).toContain("优先级 未设 → 高");
    expect(mounted.wrapper.get('[data-testid="today-task-stale"]').text()).toContain("截止 无 → 2026-11-01");
    expect((form.get("select").element as HTMLSelectElement).value).toBe("LOW");

    // 冻结期间提交被阻止，不产生「新修订 + 旧值」的载荷。
    await form.trigger("submit"); await flush();
    expect(posts).toHaveLength(0);
    expect(form.get('button[type="submit"]').attributes("disabled")).toBeDefined();

    // 放弃修改：表单按最新事实重填，提交用新修订与新值。
    await mounted.wrapper.get('[data-testid="today-task-stale-adopt"]').trigger("click"); await flush();
    expect(mounted.wrapper.find('[data-testid="today-task-stale"]').exists()).toBe(false);
    expect((form.get("select").element as HTMLSelectElement).value).toBe("HIGH");
    await form.trigger("submit"); await flush();
    expect(posts[0]).toMatchObject({ expected_revision: "3", priority: "HIGH", due_local_date: "2026-11-01" });
  });

  it("冻结后选择保留修改：草稿按新基线显式提交，不用旧值静默回写", async () => {
    connect();
    const { mounted, posts } = await mountToday({
      nextItem: { task_revision: "3", priority: "HIGH", due_local_date: "2026-11-01", timezone: "Asia/Shanghai" } });
    const form = planningForm(mounted);
    await form.get("select").setValue("LOW"); await flush();
    await mounted.wrapper.get('.today-query .secondary-button').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="today-task-stale"]').exists()).toBe(true);

    await mounted.wrapper.get('[data-testid="today-task-stale-keep"]').trigger("click"); await flush();
    expect(mounted.wrapper.find('[data-testid="today-task-stale"]').exists()).toBe(false);
    // 明确认可差异后，保存恢复可用：提交是草稿值 + 新修订，用户看过差异，不是静默覆盖。
    expect(form.get('button[type="submit"]').attributes("disabled")).toBeUndefined();
    await form.trigger("submit"); await flush();
    expect(posts[0]).toMatchObject({ expected_revision: "3", priority: "LOW" });
  });

  it("服务端 409 冲突后的重读保留草稿，显式重提按新修订走（既有语义不退化）", async () => {
    connect();
    const { mounted, posts } = await mountToday({
      planningResponse: (body) => {
        if (posts.length === 1) {
          return response(409, { code: "REVISION_CONFLICT", detail: "revision conflict",
            conflict: { expected_revision: "2", actual_revision: "3" } }); }
        return response(200, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
          result: { task_id: taskId, status: "READY", revision: "4" } });
      },
      nextItem: { task_revision: "3" }
    });
    const form = planningForm(mounted);
    await form.get("select").setValue("HIGH");
    await form.get('input[type="date"]').setValue("2026-10-02");
    await form.trigger("submit"); await flush();
    expect(posts[0]).toMatchObject({ expected_revision: "2", priority: "HIGH", due_local_date: "2026-10-02" });
    expect(mounted.wrapper.text()).toContain("上次失败命令 ID");
    expect((form.get("select").element as HTMLSelectElement).value).toBe("HIGH");

    // 冲突重读（v3）后再次提交：新修订 + 原草稿，命令 ID 不同。
    await form.trigger("submit"); await flush();
    expect(posts[1]).toMatchObject({ expected_revision: "3", priority: "HIGH", due_local_date: "2026-10-02" });
    expect(posts[1]?.command_id).not.toBe(posts[0]?.command_id);
  });

  it("延后字段的本地草稿同样受基线冻结约束", async () => {
    connect();
    const { mounted } = await mountToday({
      nextItem: { task_revision: "3", later_local_date: "2026-12-01", later_timezone: "Asia/Shanghai" } });
    const laterForm = mounted.wrapper.get(".today-task__forms form:nth-of-type(1)");
    await laterForm.get('input[type="date"]').setValue("2026-10-30"); await flush();

    await mounted.wrapper.get('.today-query .secondary-button').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="today-task-stale"]').text()).toContain("延后 无 → 2026-12-01");
    expect((laterForm.get('input[type="date"]').element as HTMLInputElement).value).toBe("2026-10-30");
    expect(laterForm.get('button[type="submit"]').attributes("disabled")).toBeDefined();

    await mounted.wrapper.get('[data-testid="today-task-stale-adopt"]').trigger("click"); await flush();
    expect((laterForm.get('input[type="date"]').element as HTMLInputElement).value).toBe("2026-12-01");
  });
});
