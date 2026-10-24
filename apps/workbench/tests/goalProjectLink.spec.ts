import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * Goal↔Project 关联入口的反例（工作台 §18.7、总纲 §0.8、LC-02）。
 *
 * 关联是**独立命令** LinkProjectGoal，不是 CreateGoal 的隐式后续：
 * - 未选择项目时不发命令；选择后按 Project 当前修订做 CAS。
 * - 修订变化返回冲突后重新读取，让用户按新事实重新确认，不覆盖他人变更。
 * - 响应丢失按原 command_id 核对，不换 ID 重发第二次关联。
 * - 关联只改 Project↔Goal 关系，不建 Task、不改 State、不触碰权限。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const goalId = "44444444-4444-4444-8444-444444444444";
/** 只含路径：URL 的 pathname 不带 host。 */
const root = `/api/v1/workspaces/${workspaceId}`;
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const intent = "把毕业论文的实验部分跑通并整理成可提交的初稿";

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function listItem(id: string, title: string, revision: string) {
  return { id, title, project_type: "GENERAL", revision, state_revision: "1", archived_at: null,
    archive_status: "ACTIVE", phase_key: "PLANNING", next_action_task_id: null,
    created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" };
}

interface Routes {
  /** Project 当前修订；用于验证 CAS 用的就是列表里那份。 */
  revision?: string;
  /** goal-links 命令的响应。 */
  link?: (body: Record<string, unknown>) => Response;
  /** 项目列表读取是否失败。 */
  failProjects?: boolean;
  /** 服务端是否已经用修订冲突拒绝过一次关联（由用例自己维护时机）。 */
  linkConflicted?: () => boolean;
  /** 冲突之后项目列表读到的新修订；不给就仍返回 revision。 */
  revisionAfterConflict?: string;
}

function router(routes: Routes, posts: { path: string; body: Record<string, unknown> }[]) {
  const revision = routes.revision ?? "2";
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (init?.method === "POST" && path === `${root}/goals`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      return response(201, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
        result: { goal_id: goalId, status: "ACTIVE", revision: "1" } });
    }
    if (init?.method === "POST" && path.endsWith("/goal-links")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path, body });
      return routes.link?.(body) ?? response(200, { command_id: body.command_id,
        committed_at: "2026-10-04T00:00:00Z",
        result: { project_id: otherProjectId, revision: "3", goal_ids: [goalId] } });
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return response(404, { code: "COMMAND_NOT_FOUND", detail: "命令回执不存在" });
    if (init?.method !== "POST" && path === `${root}/projects`) {
      if (routes.failProjects === true) return response(500, { code: "INTERNAL_ERROR", detail: "读取失败" });
      // 冲突被拒绝之后，别人已经推进了 Project 修订：此时读取必须返回新修订。
      // 否则「冲突后重新读取」与「沿用旧修订重发」在断言上无法区分。
      const current = routes.linkConflicted?.() === true
        ? routes.revisionAfterConflict ?? revision : revision;
      return response(200, { items: [listItem(otherProjectId, "论文项目", current)], next_cursor: null });
    }
    if (path.endsWith("/attention/interventions")) return response(200, { items: [] });
    if (path === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
    throw new Error(`Unexpected request ${path}${url.search}`);
  });
}

/** 先建一个 Goal，停在成功页（关联面板所在处）。 */
async function createGoalAndWait(view: Awaited<ReturnType<typeof mountWorkbench>>) {
  await view.wrapper.get('[data-testid="goal-intent"]').setValue(intent);
  await flush();
  await view.wrapper.get('[data-testid="goal-form"]').trigger("submit");
  await flush(); await flush();
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  // 待核对关联现在按作用域暂存会话存储（#20 整页重开恢复）：用例之间清掉，
  // 避免上一条未收口的命令被下一用例的恢复逻辑读到。
  sessionStorage.clear();
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("Goal↔Project 关联入口", () => {
  it("创建 Goal 不隐式关联；未选项目时不发关联命令，选定后按当前修订关联", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ revision: "2" }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await createGoalAndWait(view);

    // 创建本身不带任何关联：载荷里没有 project 字段，也没有 goal-links 请求。
    expect(posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(0);
    expect(Object.keys(posts[0]!.body).sort()).toEqual(["command_id", "description", "title"]);
    expect(view.wrapper.get('[data-testid="goal-link-panel"]').exists()).toBe(true);

    // 未选项目时不得发出关联命令。
    expect(view.wrapper.get('[data-testid="goal-link-submit"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
    await flush();
    expect(posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(0);

    await view.wrapper.get('[data-testid="goal-link-project"]').setValue(otherProjectId);
    await flush();
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
    await flush(); await flush();

    const link = posts.find((post) => post.path.endsWith("/goal-links"));
    // CAS 用的是列表里那份 Project 修订，不是猜的。
    expect(link?.body.expected_revision).toBe("2");
    expect(link?.body.goal_id).toBe(goalId);
    expect(link?.body.command_id).toMatch(/^[0-9a-f-]{36}$/u);
    // 关联只发这一条命令，且不带任何 Task/State/权限字段。
    expect(Object.keys(link!.body).sort()).toEqual(["command_id", "expected_revision", "goal_id"]);
    const receipt = view.wrapper.get('[data-testid="goal-link-receipt"]').text();
    expect(receipt).toContain(otherProjectId);
    expect(receipt).toContain(goalId);
  });

  it("Project 修订变化时重新读取并要求再次确认，不覆盖他人变更", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let conflicted = false;
    vi.stubGlobal("fetch", router({
      revision: "2",
      // 冲突之后他人已把 Project 推到 v5：重新读取必须真的读到 v5。
      linkConflicted: () => conflicted,
      revisionAfterConflict: "5",
      link: (body) => {
        if (!conflicted) {
          conflicted = true;
          return response(409, { code: "REVISION_CONFLICT", detail: "修订已变化",
            conflict: { expected_revision: "2", actual_revision: "5" } });
        }
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { project_id: otherProjectId, revision: "3", goal_ids: [goalId] } });
      },
    }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await createGoalAndWait(view);

    await view.wrapper.get('[data-testid="goal-link-project"]').setValue(otherProjectId);
    await flush();
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
    await flush(); await flush();

    // 冲突后不得显示成功，也不得自动用新修订重发。
    expect(view.wrapper.find('[data-testid="goal-link-result"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-link-error"]').text()).toContain("v5");
    expect(posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(1);
    // 没有待核对命令：这是一次明确拒绝，不是结果不明。
    expect(view.wrapper.find('[data-testid="goal-link-pending"]').exists()).toBe(false);
    // 重新读取确实换了新事实：下拉项按新修订呈现，而不是仍显示旧修订。
    expect(view.wrapper.get('[data-testid="goal-link-project"]').text()).toContain("v5");

    // 用户再次确认时才发起第二次，且用新的 command ID。
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
    await flush(); await flush();
    const links = posts.filter((post) => post.path.endsWith("/goal-links"));
    expect(links).toHaveLength(2);
    // 命令身份不同：不是同一条命令重发。
    expect(links[1]?.body.command_id).not.toBe(links[0]?.body.command_id);
    // 第二次基于重新读取到的新修订：这条断言锁住「冲突后已重新读取项目」，
    // 沿用旧修订 v2 重发（甚至不重新读取）都会在这里红。
    expect(links[0]?.body.expected_revision).toBe("2");
    expect(links[1]?.body.expected_revision).toBe("5");
    expect(view.wrapper.get('[data-testid="goal-link-receipt"]').text()).toContain(otherProjectId);
  });

  it("项目列表读取失败时不提供关联，也不据此推断项目范围", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ failProjects: true }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await createGoalAndWait(view);

    expect(view.wrapper.get('[data-testid="goal-link-projects-failed"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="goal-link-submit"]').exists()).toBe(false);
    expect(posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(0);

    // 显式重新读取成功后入口恢复。
    vi.stubGlobal("fetch", router({ revision: "2" }, posts));
    await view.wrapper.get('[data-testid="goal-link-reload"]').trigger("click");
    await flush(); await flush();
    expect(view.wrapper.find('[data-testid="goal-link-panel"]').exists()).toBe(true);
  });

  it("服务端拒绝重复关联时如实呈现，不假装已关联", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    // 服务端对「已关联」用 invalidTransition（409 INVALID_TRANSITION），不是字段校验失败。
    vi.stubGlobal("fetch", router({
      link: () => response(409, { code: "INVALID_TRANSITION", detail: "该 Goal 已关联到当前 Project。" }),
    }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await createGoalAndWait(view);

    await view.wrapper.get('[data-testid="goal-link-project"]').setValue(otherProjectId);
    await flush();
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="goal-link-result"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-link-error"]').text()).toContain("已关联");
    // 明确的业务拒绝可以直接再发起，不要求先核对不存在的回执。
    expect(view.wrapper.find('[data-testid="goal-link-pending"]').exists()).toBe(false);
  });

  it("双击确认只发出一条关联命令", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", router({ revision: "2" }, posts));
    const view = await mountWorkbench("/projects?view=goal"); unmount = view.unmount;
    await createGoalAndWait(view);

    await view.wrapper.get('[data-testid="goal-link-project"]').setValue(otherProjectId);
    await flush();
    const submit = view.wrapper.get('[data-testid="goal-link-submit"]');
    await submit.trigger("click");
    await submit.trigger("click");
    await flush(); await flush();

    expect(posts.filter((post) => post.path.endsWith("/goal-links"))).toHaveLength(1);
  });
});
