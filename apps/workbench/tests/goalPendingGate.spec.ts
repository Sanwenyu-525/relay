import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { dialogText, flush, mountWorkbench } from "./mountApp";

/**
 * Goal 创建与项目关联的未决命令准入（#20 / DEV-0140）。
 *
 * 原命令未收口前，普通提交/确认按钮不得通过 handler 开始新命令：
 * - 响应丢失 + 回执 404 后，原 command_id 待核对入口持续可见；
 * - 重复提交、快速连点都只产生同一个命令 ID；
 * - 原样重试（同 ID 同载荷）与明确业务拒绝后的编辑路径保持可用；
 * - 切页被导航守卫拦截，整页重开按 API/Workspace 作用域恢复原命令。
 * 断言客户端行为与命令身份，不替代真实 API/PG 与真实 Windows 取证。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const projectId = "55555555-5555-4555-8555-555555555555";
const goalId = "44444444-4444-4444-8444-444444444444";
/** 只含路径：URL 的 pathname 不带 host，比对时不能拼 baseUrl。 */
const root = `/api/v1/workspaces/${workspaceId}`;
const otherRoot = `/api/v1/workspaces/${otherWorkspaceId}`;
const intent = "把毕业论文的实验部分跑通并整理成可提交的初稿";

function connect(workspace = workspaceId) {
  activateRelayConnection({ baseUrl, workspaceId: workspace, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function project(id: string, title: string, revision = "2") {
  return { id, title, project_type: "GENERAL", revision, state_revision: "1", archived_at: null,
    archive_status: "ACTIVE", phase_key: "PLANNING", next_action_task_id: null,
    created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" };
}

interface Routes {
  /** 创建/关联 POST 是否丢响应。 */
  loseWrite?: boolean;
  /** 明确业务拒绝：返回 422 VALIDATION_FAILED。 */
  rejectWrite?: boolean;
  /** GET /commands/:id 是否返回 CreateGoal/LinkProjectGoal 回执。 */
  receiptHit?: boolean;
  /** 项目列表作用的工作空间（跨连接隔离用）。 */
  rootOverride?: string;
}

interface RouterState {
  posts: { path: string; body: Record<string, unknown> }[];
}

function router(routes: Routes, state: RouterState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const apiRoot = routes.rootOverride ?? root;
    const path = url.pathname;
    if (init?.method === "POST" && (path === `${apiRoot}/goals` || path.endsWith("/goal-links"))) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.posts.push({ path, body });
      if (routes.loseWrite === true) throw new TypeError("response lost");
      if (routes.rejectWrite === true) {
        return response(422, { code: "VALIDATION_FAILED", detail: "标题或说明不满足要求", command_id: body.command_id });
      }
      if (path === `${apiRoot}/goals`) {
        return response(201, { command_id: body.command_id, committed_at: "2026-10-22T00:00:00Z",
          result: { goal_id: goalId, status: "ACTIVE", revision: "1" } });
      }
      return response(200, { command_id: body.command_id, committed_at: "2026-10-22T00:00:00Z",
        result: { project_id: body.project_id, revision: "3", goal_ids: [goalId] } });
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) {
      const commandId = decodeURIComponent(receipt[1]!);
      const issued = state.posts.find((post) => post.body.command_id === commandId);
      if (routes.receiptHit === true && issued) {
        const commandType = issued.path.endsWith("/goal-links") ? "LinkProjectGoal" : "CreateGoal";
        const result = commandType === "CreateGoal"
          ? { goal_id: goalId, status: "ACTIVE", revision: "1" }
          : { project_id: issued.body.project_id, revision: "3", goal_ids: [goalId] };
        return response(200, { command_id: commandId, command_type: commandType,
          committed_at: "2026-10-22T00:00:05Z", result });
      }
      return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found yet" });
    }
    if (init?.method !== "POST" && path === `${apiRoot}/projects`) {
      return response(200, { items: [project(projectId, "合法项目")], next_cursor: null });
    }
    if (path.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (path === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
    throw new Error(`Unexpected request ${path}${url.search}`);
  });
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  sessionStorage.clear();
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("Goal 创建与关联的未决命令准入", () => {
  it("创建待核对时重复提交与快速连点都被拒绝，原样重试按原 ID 原载荷收口", async () => {
    connect();
    const state: RouterState = { posts: [] };
    vi.stubGlobal("fetch", router({ loseWrite: true }, state));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    const form = view.wrapper.get('[data-testid="goal-form"]');
    await form.trigger("submit"); await flush();
    const commandId = state.posts[0]?.body.command_id as string;

    // 回执 404 后普通按钮保持可用（拒绝发生在 handler，不靠置灰），pending 持续可见。
    await view.wrapper.get('[data-testid="goal-receipt"]').trigger("click"); await flush();
    expect(view.wrapper.get('[data-testid="goal-pending"]').text()).toContain(commandId);
    expect(view.wrapper.get('[data-testid="goal-submit"]').attributes("disabled")).toBeUndefined();

    // 重复提交与快速连点：不产生第二个命令 ID。
    await form.trigger("submit"); await form.trigger("submit"); await flush();
    expect(state.posts.filter((post) => post.path === `${root}/goals`)).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="goal-pending"]').text()).toContain(commandId);

    // 原样重试：同 ID 同载荷。
    await view.wrapper.get('[data-testid="goal-retry"]').trigger("click"); await flush();
    const attempts = state.posts.filter((post) => post.path === `${root}/goals`);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body.command_id).toBe(commandId);
    expect(attempts[1]?.body.title).toBe(attempts[0]?.body.title);
    expect(attempts[1]?.body.description).toBe(attempts[0]?.body.description);
  });

  it("明确业务拒绝后清 pending 并允许修改后以新命令重新提交", async () => {
    connect();
    const state: RouterState = { posts: [] };
    vi.stubGlobal("fetch", router({ rejectWrite: true }, state));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await view.wrapper.get('[data-testid="goal-intent"]').setValue("第一版目标表述");
    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    expect(view.wrapper.find('[data-testid="goal-pending"]').exists()).toBe(false);
    expect(state.posts).toHaveLength(1);

    await view.wrapper.get('[data-testid="goal-intent"]').setValue("修订后的目标表述");
    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1]?.body.command_id).not.toBe(state.posts[0]?.body.command_id);
    expect(state.posts[1]?.body.description).toBe("修订后的目标表述");
  });

  it("待核对时切页被导航守卫拦截，弹窗提示原命令 ID 且不丢弃", async () => {
    connect();
    const state: RouterState = { posts: [] };
    vi.stubGlobal("fetch", router({ loseWrite: true }, state));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    const commandId = state.posts[0]?.body.command_id as string;
    expect(view.wrapper.get('[data-testid="goal-pending"]').text()).toContain(commandId);

    await view.router.push("/projects"); await flush();
    expect(view.router.currentRoute.value.path).toBe("/projects");
    expect(view.router.currentRoute.value.query).toEqual({ view: "goal" });
    const dialog = dialogText();
    expect(dialog).toContain("命令结果待核对");
    expect(dialog).toContain(commandId);
    expect(dialog).not.toContain("丢弃草稿并离开");
    expect(view.wrapper.get('[data-testid="goal-pending"]').exists()).toBe(true);
  });

  it("整页重开按当前 Workspace 作用域恢复原命令，原 ID 重试可收口", async () => {
    connect();
    const state: RouterState = { posts: [] };
    vi.stubGlobal("fetch", router({ loseWrite: true }, state));
    const first = await mountWorkbench("/projects?view=goal");
    await first.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await first.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    const commandId = state.posts[0]?.body.command_id as string;
    const originalTitle = state.posts[0]?.body.title;
    first.unmount();

    // 同一作用域重新打开：原命令的待核对入口仍在，恢复期间普通提交被拒绝，不产生第二个 Goal 命令。
    const reopened = await mountWorkbench("/projects?view=goal"); unmount = reopened.unmount; await flush();
    expect(reopened.wrapper.get('[data-testid="goal-pending"]').text()).toContain(commandId);
    await reopened.wrapper.get('[data-testid="goal-intent"]').setValue("另一个目标");
    await reopened.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    expect(state.posts.filter((post) => post.path === `${root}/goals`)).toHaveLength(1);

    // 回执 404 → 原样重试 → 同 ID 同载荷收口。
    await reopened.wrapper.get('[data-testid="goal-receipt"]').trigger("click"); await flush();
    await reopened.wrapper.get('[data-testid="goal-retry"]').trigger("click"); await flush();
    const attempts = state.posts.filter((post) => post.path === `${root}/goals`);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body.command_id).toBe(commandId);
    expect(attempts[1]?.body.title).toBe(originalTitle);
  });

  it("待核对关联不因再次确认发出第二条命令，整页重开恢复原关联核对身份", async () => {
    connect();
    const state: RouterState = { posts: [] };
    vi.stubGlobal("fetch", router({}, state));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await view.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    expect(view.wrapper.get('[data-testid="goal-link-panel"]').exists()).toBe(true);

    // 第一条关联丢响应：pending 冻结原 ID/原 Project/原修订。
    vi.stubGlobal("fetch", router({ loseWrite: true }, state));
    await view.wrapper.get('[data-testid="goal-link-project"]').setValue(projectId); await flush();
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click"); await flush();
    const linkCommandId = state.posts.find((post) => post.path.endsWith("/goal-links"))?.body.command_id as string;
    expect(view.wrapper.get('[data-testid="goal-link-pending"]').text()).toContain(linkCommandId);
    expect(view.wrapper.get('[data-testid="goal-link-submit"]').attributes("disabled")).toBeUndefined();

    // 再次确认不发第二条关联命令。
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click"); await flush();
    expect(state.posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(1);
    view.unmount(); unmount = null;

    // 整页重开：重新创建成功进入关联区后，原关联核对身份按 Goal 作用域恢复。
    vi.stubGlobal("fetch", router({}, state));
    const reopened = await mountWorkbench("/projects?view=goal"); unmount = reopened.unmount; await flush();
    await reopened.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await reopened.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    expect(reopened.wrapper.get('[data-testid="goal-link-panel"]').exists()).toBe(true);
    const pending = reopened.wrapper.get('[data-testid="goal-link-pending"]');
    expect(pending.text()).toContain(linkCommandId);
    expect(pending.text()).toContain(projectId);
    // 恢复后的普通确认同样被拒绝。
    await reopened.wrapper.get('[data-testid="goal-link-submit"]').trigger("click"); await flush();
    expect(state.posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(1);
  });

  it("原命令属于其他 Workspace 时不恢复也不可在此重试，切回原作用域仍可核对", async () => {
    connect();
    const state: RouterState = { posts: [] };
    vi.stubGlobal("fetch", router({ loseWrite: true }, state));
    const first = await mountWorkbench("/projects?view=goal");
    await first.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
    await first.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    const originalCommandId = state.posts[0]?.body.command_id as string;
    expect(first.wrapper.get('[data-testid="goal-pending"]').exists()).toBe(true);
    first.unmount();

    // 切换到另一个 Workspace：原命令不跨作用域出现，新命令也不复用原 ID。
    connect(otherWorkspaceId);
    vi.stubGlobal("fetch", router({ rootOverride: otherRoot }, state));
    const switched = await mountWorkbench("/projects?view=goal"); unmount = switched.unmount; await flush();
    expect(switched.wrapper.find('[data-testid="goal-pending"]').exists()).toBe(false);
    await switched.wrapper.get('[data-testid="goal-intent"]').setValue("另一个工作区的目标");
    await switched.wrapper.get('[data-testid="goal-form"]').trigger("submit"); await flush();
    const otherAttempts = state.posts.filter((post) => post.path === `${otherRoot}/goals`);
    expect(otherAttempts).toHaveLength(1);
    expect(otherAttempts[0]?.body.command_id).not.toBe(originalCommandId);
    switched.unmount(); unmount = null;

    // 切回原 Workspace：原命令仍在原作用域里可继续核对。
    connect();
    vi.stubGlobal("fetch", router({ loseWrite: true }, state));
    const back = await mountWorkbench("/projects?view=goal"); unmount = back.unmount; await flush();
    expect(back.wrapper.get('[data-testid="goal-pending"]').text()).toContain(originalCommandId);
  });
});
