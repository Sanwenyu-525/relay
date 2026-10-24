import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { dialogText, flush, mountWorkbench } from "./mountApp";

/**
 * 今日页未决命令的生命周期（#22 / DEV-0138）。
 *
 * 未决 Today 命令（PIN / Focus / Planning）在结果未知时：
 * - 页内离开被导航守卫拦截，弹窗提示原命令 ID 且没有「丢弃」出口；
 * - 整页重开（卸载后按同一连接作用域重新挂载）恢复原 ID 与冻结载荷，核对前不允许新的 Today 写入；
 * - 回执 404 后只能按原 ID 原载荷重试，成功后收口；
 * - 原命令不跨 Workspace 复用或重发。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const root = `/api/v1/workspaces/${workspaceId}`;
const otherRoot = `/api/v1/workspaces/${otherWorkspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  sessionStorage.clear();
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

function connect(workspace = workspaceId) {
  activateRelayConnection({ baseUrl, workspaceId: workspace, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function taskDetail() {
  return { id: taskId, project_id: null, title: "未知命令恢复探针", status: "READY", mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] };
}
function todayItem(fields: Record<string, unknown> = {}) {
  return { task_id: taskId, task_revision: "2", project_id: null, title: "未知命令恢复探针",
    status: "READY", priority: null, due_local_date: null, timezone: null,
    pin: false, later_local_date: null, later_timezone: null,
    reason_codes: ["READY_TO_START"], evidence_refs: [], allowed_actions: ["PIN", "SET_LATER", "SET_FOCUS"], ...fields };
}
function envelope(commandId: string, commandType: string, result: Record<string, unknown>) {
  return { command_id: commandId, command_type: commandType, committed_at: "2026-10-24T00:00:00Z", result, links: {} };
}

interface Routes {
  /** 丢响应的 POST 路径后缀列表；未列出的 POST 返回成功。 */
  losePosts?: readonly string[];
  /** 回执查询是否命中；缺省 404 COMMAND_NOT_FOUND。 */
  receiptHit?: boolean;
  /** /today 返回的任务事实；缺省初版。 */
  nextItem?: Record<string, unknown>;
  /** Project 读取作用域（跨连接隔离用例）。 */
  apiRoot?: string;
}

async function mountToday(routes: Routes = {}) {
  const apiRoot = routes.apiRoot ?? root;
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if ((routes.losePosts ?? []).some((suffix) => path.endsWith(suffix))) throw new TypeError("lost after commit");
      if (path.endsWith("/task-selections/" + taskId) || path.endsWith("/focus-selections")) {
        return response(200, envelope(body.command_id as string,
          path.endsWith("/focus-selections") ? "SetFocusSelection" : "SetTaskSelection", { selection_revision: "2" }));
      }
      return response(200, envelope(body.command_id as string, "SetTaskPlanningMetadata",
        { task_id: taskId, status: "READY", revision: "3" }));
    }
    if (path.startsWith(`${apiRoot}/commands/`)) {
      const commandId = decodeURIComponent(path.slice(apiRoot.length + "/commands/".length));
      const issued = posts.find((post) => post.body.command_id === commandId);
      if (routes.receiptHit === true && issued) {
        const commandType = issued.path.endsWith("/focus-selections") ? "SetFocusSelection"
          : issued.path.endsWith("/planning-metadata") ? "SetTaskPlanningMetadata" : "SetTaskSelection";
        const result = commandType === "SetTaskPlanningMetadata"
          ? { task_id: taskId, status: "READY", revision: "3" } : { selection_revision: "2" };
        return response(200, envelope(commandId, commandType, result));
      }
      return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found yet" });
    }
    if (path === `${apiRoot}/today`) {
      return response(200, { date: url.searchParams.get("date"), timezone: url.searchParams.get("timezone"),
        selection_revision: "1", focus: null, focus_has_eligible_candidate: false,
        eligible_items: [todayItem(routes.nextItem)], waiting_items: [], blocked_pinned_items: [] });
    }
    if (path === `${apiRoot}/tasks/${taskId}`) return response(200, taskDetail());
    if (path === `${apiRoot}/attention/interventions` || path === `${apiRoot}/assist-sessions`) return response(200, { items: [], next_cursor: null });
    if (path === `${apiRoot}/reviews`) return response(200, { items: [] });
    if (path === `${apiRoot}/tasks` || path === `${apiRoot}/projects`) return response(200, { items: [], next_cursor: null });
    throw new Error(`Unexpected ${path}`);
  }));
  const mounted = await mountWorkbench("/today");
  await flush();
  return { mounted, posts };
}

function button(mounted: Awaited<ReturnType<typeof mountToday>>["mounted"], label: string) {
  const found = mounted.wrapper.findAll("button").find((node) => node.text() === label);
  expect(found, `按钮 ${label}`).toBeDefined();
  return found!;
}

describe("今日未决命令的恢复与准入", () => {
  it("置顶响应丢失后切页被拦截，弹窗给出原命令 ID 且不提供丢弃出口", async () => {
    connect();
    const { mounted, posts } = await mountToday({ losePosts: ["/task-selections/" + taskId] });
    await button(mounted, "置顶").trigger("click"); await flush();
    expect(posts).toHaveLength(1);
    const commandId = posts[0]?.body.command_id as string;
    expect(mounted.wrapper.get('[data-testid="today-pending"]').text()).toContain(commandId);

    await mounted.router.push("/reviews"); await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/today");
    const dialog = dialogText();
    expect(dialog).toContain("命令结果待核对");
    expect(dialog).toContain(commandId);
    expect(dialog).not.toContain("丢弃草稿并离开");
  });

  it("整页重开恢复置顶原命令：核对前禁止新写，404 后原 ID 原载荷重试收口", async () => {
    connect();
    const first = await mountToday({ losePosts: ["/task-selections/" + taskId] });
    await button(first.mounted, "置顶").trigger("click"); await flush();
    const commandId = first.posts[0]?.body.command_id as string;
    const originalPayload = first.posts[0]!.body;
    first.mounted.unmount();

    const reopened = await mountToday(); unmount = reopened.mounted.unmount; await flush();
    const pending = reopened.mounted.wrapper.get('[data-testid="today-pending"]');
    expect(pending.text()).toContain(commandId);
    expect(pending.text()).toContain("Pin 开");
    // 核对前禁止新的 Today 写入：置顶按钮禁用，点击不产生第二条命令。
    expect(button(reopened.mounted, "置顶").attributes("disabled")).toBeDefined();
    await button(reopened.mounted, "置顶").trigger("click"); await flush();
    expect(reopened.posts).toHaveLength(0);

    // 回执 404 → 只能原 ID 原内容重试，收口后允许新的 Today 写入。
    await reopened.mounted.wrapper.get('[data-testid="today-pending"] button').trigger("click"); await flush();
    expect(reopened.mounted.wrapper.text()).toContain("同一 ID 和原内容重试");
    const retry = Array.from(reopened.mounted.wrapper.get('[data-testid="today-pending"]').element!.querySelectorAll("button"))
      .find((node) => node.textContent === "用原 ID 和内容重试");
    expect(retry, "原样重试按钮").toBeDefined();
    await (retry as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush();
    expect(reopened.posts).toHaveLength(1);
    expect(reopened.posts[0]?.body.command_id).toBe(commandId);
    expect(reopened.posts[0]!.body).toEqual(originalPayload);
    expect(reopened.mounted.wrapper.find('[data-testid="today-pending"]').exists()).toBe(false);
  });

  it("整页重开恢复计划原命令的精确载荷并按原 ID 重试", async () => {
    connect();
    const planningForm = (mounted: Awaited<ReturnType<typeof mountToday>>["mounted"]) =>
      mounted.wrapper.get(".today-task__forms form:nth-of-type(2)");
    const first = await mountToday({ losePosts: ["/planning-metadata"] });
    const form = planningForm(first.mounted);
    await form.get("select").setValue("HIGH");
    await form.get('input[type="date"]').setValue("2026-11-02");
    await form.trigger("submit"); await flush();
    expect(first.posts).toHaveLength(1);
    const commandId = first.posts[0]?.body.command_id as string;
    const originalPayload = first.posts[0]!.body;
    first.mounted.unmount();

    const reopened = await mountToday(); unmount = reopened.mounted.unmount; await flush();
    const pending = reopened.mounted.wrapper.get('[data-testid="today-pending"]');
    expect(pending.text()).toContain(commandId);
    expect(pending.text()).toContain("优先级 HIGH");
    expect(pending.text()).toContain("2026-11-02");

    // 回执 404 → 只能原 ID 原内容重试。
    await reopened.mounted.wrapper.get('[data-testid="today-pending"] button').trigger("click"); await flush();
    const pendingBox = reopened.mounted.wrapper.get('[data-testid="today-pending"]');
    const retry = Array.from(pendingBox.element!.querySelectorAll("button"))
      .find((node) => node.textContent === "用原 ID 和内容重试");
    expect(retry, "原样重试按钮").toBeDefined();
    await (retry as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush();
    expect(reopened.posts).toHaveLength(1);
    expect(reopened.posts[0]?.body.command_id).toBe(commandId);
    expect(reopened.posts[0]!.body).toEqual(originalPayload);
  });

  it("整页重开恢复今日焦点原命令", async () => {
    connect();
    const first = await mountToday({ losePosts: ["/focus-selections"] });
    const focusButton = Array.from(first.mounted.wrapper.get(".today-task__actions").element!.querySelectorAll("button"))
      .find((node) => node.textContent === "设为今日焦点");
    expect(focusButton, "设为今日焦点").toBeDefined();
    await (focusButton as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush();
    expect(first.posts).toHaveLength(1);
    const commandId = first.posts[0]?.body.command_id as string;
    first.mounted.unmount();

    const reopened = await mountToday(); unmount = reopened.mounted.unmount; await flush();
    const pending = reopened.mounted.wrapper.get('[data-testid="today-pending"]');
    expect(pending.text()).toContain(commandId);
    expect(pending.text()).toContain(`Focus TASK ${taskId}`);

    await reopened.mounted.wrapper.get('[data-testid="today-pending"] button').trigger("click"); await flush();
    const retry = Array.from(reopened.mounted.wrapper.get('[data-testid="today-pending"]').element!.querySelectorAll("button"))
      .find((node) => node.textContent === "用原 ID 和内容重试");
    expect(retry, "原样重试按钮").toBeDefined();
    await (retry as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush();
    expect(reopened.posts).toHaveLength(1);
    expect(reopened.posts[0]?.body.command_id).toBe(commandId);
    expect(reopened.posts[0]!.body).toEqual(first.posts[0]!.body);
  });

  it("原命令不跨 Workspace：切换后不恢复也不复用，切回原作用域仍可核对", async () => {
    connect();
    const first = await mountToday({ losePosts: ["/task-selections/" + taskId] });
    await button(first.mounted, "置顶").trigger("click"); await flush();
    const originalCommandId = first.posts[0]?.body.command_id as string;
    first.mounted.unmount();

    // 切到另一个 Workspace：不恢复原命令，新置顶用新 ID。
    connect(otherWorkspaceId);
    const switched = await mountToday({ apiRoot: otherRoot }); unmount = switched.mounted.unmount; await flush();
    expect(switched.mounted.wrapper.find('[data-testid="today-pending"]').exists()).toBe(false);
    await button(switched.mounted, "置顶").trigger("click"); await flush();
    expect(switched.posts).toHaveLength(1);
    expect(switched.posts[0]?.body.command_id).not.toBe(originalCommandId);
    switched.mounted.unmount();

    // 切回原 Workspace：原命令仍在原作用域内可继续核对。
    connect();
    const back = await mountToday(); unmount = back.mounted.unmount; await flush();
    expect(back.mounted.wrapper.get('[data-testid="today-pending"]').text()).toContain(originalCommandId);
    expect(back.posts).toHaveLength(0);
  });

  it("未决命令的冻结载荷不因刷新或日期范围变化被改写", async () => {
    connect();
    const { mounted, posts } = await mountToday({ losePosts: ["/task-selections/" + taskId] });
    await button(mounted, "置顶").trigger("click"); await flush();
    const commandId = posts[0]?.body.command_id as string;
    const originalPayload = posts[0]!.body;
    expect(mounted.wrapper.get('[data-testid="today-pending"]').text()).toContain(commandId);

    // 刷新与日期变化都不触碰未决命令：气泡仍在，载荷不变，也无新写入。
    await mounted.wrapper.get('.today-query .secondary-button').trigger("click"); await flush();
    await mounted.wrapper.get('.today-query input[type="date"]').setValue("2026-10-25"); await flush();
    expect(mounted.wrapper.get('[data-testid="today-pending"]').text()).toContain(commandId);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual(originalPayload);
  });
});
