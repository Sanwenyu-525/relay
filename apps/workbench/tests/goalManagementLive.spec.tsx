import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 正式 Goal 管理链（P0-B / P1-B / P2）：
 * 列表范围与游标、详情编辑/归档/解除、关联项目进展覆盖、Goal 与目录工作上下文。
 * 断言客户端行为与冻结命令，不替代真实 PG/HTTP 与 Windows 实窗。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const root = `/api/v1/workspaces/${workspaceId}`;
const goalId = "44444444-4444-4444-8444-444444444444";
const p1 = "22222222-2222-4222-8222-222222222222";
const p2 = "33333333-3333-4333-8333-333333333333";
const dir1 = "55555555-5555-4555-8555-555555555555";
const session1 = "66666666-6666-4666-8666-666666666666";
const session2 = "77777777-7777-4777-8777-777777777777";

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function goal(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: goalId, title: "完成毕业论文", description: "完成实验并整理结论",
    status: "ACTIVE", revision: "2", created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z", ...overrides };
}
function goalLink(projectId: string, title: string, overrides: Partial<Record<string, unknown>> = {}) {
  return { project_id: projectId, title, project_type: "GENERAL",
    archived_at: null, archive_status: "ACTIVE", project_revision: "2",
    linked_at: "2026-10-02T00:00:00Z", ...overrides };
}
function projectRecord(id: string, title: string, overrides: Partial<Record<string, unknown>> = {}) {
  return { id, title, project_type: "GENERAL", revision: "2", state_revision: "3",
    archived_at: null, ...overrides };
}
function state(projectId: string) {
  return { project_id: projectId, phase_key: "EXECUTING", next_action_task_id: null,
    revision: "3", updated_at: "2026-10-03T00:00:00Z", in_progress: [], blockers: [],
    risks: [], completed_highlight_refs: [],
    selected_artifact_version_refs: [], key_decision_refs: [], dependency_versions: {},
    allowed_actions: [] };
}
function task(id: string, title: string, projectId: string) {
  return { id, title, objective: title, project_id: projectId, status: "READY", mode: "ME",
    revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "", source: "HUMAN", criteria: [] },
    dependencies: [] };
}
function workContext() {
  return { kind: "GOAL",
    goal: { id: goalId, title: "完成毕业论文", description: "完成实验并整理结论",
      status: "ACTIVE", revision: "2" },
    projects: [
      { id: p1, title: "论文实验", project_type: "GENERAL", archive_status: "ACTIVE",
        archived_at: null, revision: "2",
        directories: [{ id: dir1, canonical_root: "D:/work/thesis", status: "ACTIVE", revision: "1" }] },
      { id: p2, title: "旧论文分支", project_type: "THESIS", archive_status: "ARCHIVED",
        archived_at: "2026-10-01T00:00:00Z", revision: "4", directories: [] }
    ],
    sessions: [
      { id: session1, project_id: p1, title: "实验讨论", status: "ACTIVE", revision: "1",
        working_resource_id: dir1 },
      { id: session2, project_id: p2, title: "旧分支讨论", status: "ARCHIVED", revision: "2",
        working_resource_id: null }
    ] };
}

interface Routes {
  readonly goal?: () => Response;
  readonly goalProjects?: () => Response;
  readonly workContext?: () => Response;
  readonly posts?: { path: string; method: string; body: Record<string, unknown> }[];
  readonly linkPosts?: (body: Record<string, unknown>) => Response;
}

function baseRouter(routes: Routes) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "POST" && path === `${root}/goals/${goalId}/revisions`) return routes.linkPosts!(
      JSON.parse(String(init!.body)) as Record<string, unknown>);
    if (method === "POST" && path === `${root}/goals/${goalId}/archive`) return routes.linkPosts!(
      JSON.parse(String(init!.body)) as Record<string, unknown>);
    if (method === "POST" && path.endsWith("/goal-unlinks")) return routes.linkPosts!(
      JSON.parse(String(init!.body)) as Record<string, unknown>);
    if (method === "GET" && path === `${root}/goals/${goalId}`) return routes.goal?.() ?? response(200, goal());
    if (method === "GET" && path === `${root}/goals/${goalId}/projects`) {
      return routes.goalProjects?.() ?? response(200, { items: [
        goalLink(p1, "论文实验"), goalLink(p2, "旧论文分支",
          { archive_status: "ARCHIVED", archived_at: "2026-10-01T00:00:00Z", project_revision: "4" }) ] });
    }
    if (method === "GET" && path === `${root}/goals/${goalId}/work-context`) {
      return routes.workContext?.() ?? response(200, workContext());
    }
    if (method === "GET" && path === `${root}/projects/${p1}`) return response(200, projectRecord(p1, "论文实验"));
    if (method === "GET" && path === `${root}/projects/${p2}`) return response(200, projectRecord(p2, "旧论文分支",
      { archived_at: "2026-10-01T00:00:00Z", revision: "4" }));
    if (method === "GET" && path === `${root}/projects/${p1}/state`) return response(200, state(p1));
    if (method === "GET" && path === `${root}/projects/${p2}/state`) return response(200, state(p2));
    if (method === "GET" && path === `${root}/projects/${p1}/goals`) return response(200, { items: [
      { goal_id: goalId, title: "完成毕业论文", status: "ACTIVE", revision: "2",
        explicit_task_ids: ["88888888-8888-4888-8888-888888888888"] }] });
    if (method === "GET" && path === `${root}/projects/${p2}/goals`) return response(200, { items: [] });
    if (method === "GET" && path === `${root}/tasks`) return response(200, { items: [
      task("99999999-9999-4999-8999-999999999999", "跑实验", p1)], next_cursor: null });
    if (method === "GET" && path === `${root}/attention/interventions`) return response(200, { items: [] });
    throw new Error(`Unexpected request ${method} ${path}${url.search}`);
  });
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  sessionStorage.clear(); resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("正式 Goal 列表", () => {
  it("按范围读取并逐页合并去重，末页才收口", async () => {
    connect();
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `${root}/goals`) {
        reads.push(url.search);
        if (!url.searchParams.has("cursor")) return response(200, {
          items: [goal(), goal({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "第二个目标", revision: "1" })],
          next_cursor: "page-2" });
        return response(200, { items: [goal({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "第二个目标", revision: "1" }),
          goal({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "第三个目标", revision: "1" })],
          next_cursor: null });
      }
      if (url.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.pathname === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountWorkbench("/goals"); unmount = view.unmount;

    expect(view.wrapper.get('[data-testid="goal-list-count"]').text()).toContain("仍有后续页");
    await view.wrapper.get('[data-testid="goal-list-more"]').trigger("click");
    await flush();

    expect(reads.some((search) => search.includes("status=active"))).toBe(true);
    const text = view.wrapper.get('[data-testid="goal-list-items"]').text();
    expect(text.match(/第二个目标/g)?.length).toBe(1);
    expect(text).toContain("第三个目标");
    expect(view.wrapper.find('[data-testid="goal-list-more"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-list-count"]').text()).toContain("已到列表末页");
  });

  it("续页明确失权时撤下已读目标，不把前页当当前事实", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `${root}/goals`) {
        if (!url.searchParams.has("cursor")) return response(200, { items: [goal()], next_cursor: "page-2" });
        return response(403, { code: "FORBIDDEN", detail: "访问已撤销" });
      }
      if (url.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.pathname === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountWorkbench("/goals"); unmount = view.unmount;

    await view.wrapper.get('[data-testid="goal-list-more"]').trigger("click");
    await flush();

    expect(view.wrapper.get('[data-testid="goal-list-reload"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="goal-list-items"]').exists()).toBe(false);
    expect(document.body.textContent).toContain("已清除之前读到的目标");
  });
});

describe("正式 Goal 详情", () => {
  it("展示 Goal、关联项目、进展覆盖与只读工作上下文，保留原 Session ID", async () => {
    connect();
    vi.stubGlobal("fetch", baseRouter({}));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    expect(view.wrapper.get('[data-testid="goal-detail-head"]').text()).toContain("完成毕业论文");
    expect(view.wrapper.get(`[data-testid="goal-project-${p1}"]`).text()).toContain("论文实验");
    expect(view.wrapper.get(`[data-testid="goal-project-${p2}"]`).text()).toContain("已归档项目");
    expect(view.wrapper.get('[data-testid="goal-progress-coverage"]').text()).toContain("2/2");
    expect(view.wrapper.get(`[data-testid="goal-progress-${p1}"]`).text()).toContain("执行");
    const sessionLink = view.wrapper.get(`[data-testid="goal-context-session-${session1}"]`);
    expect(sessionLink.attributes("href")).toContain(`session=${session1}`);
    expect(view.wrapper.get(`[data-testid="goal-context-project-${p1}"]`).text())
      .toContain("D:/work/thesis");
  });

  it("编辑 Goal 走 revision CAS 与冻结命令，成功后按新事实重读", async () => {
    connect();
    const posts: { path: string; method: string; body: Record<string, unknown> }[] = [];
    let current = goal();
    const router = baseRouter({
      goal: () => response(200, current),
      posts,
      linkPosts: (body) => {
        posts.push({ path: "revisions", method: "POST", body });
        if (body.title === "完成毕业论文（修订）" && body.expected_revision !== "2") {
          return response(409, { code: "REVISION_CONFLICT", detail: "修订已变化",
            conflict: { expected_revision: "2", actual_revision: "3" } });
        }
        current = goal({ title: String(body.title), description: String(body.description),
          revision: "3", updated_at: "2026-10-04T00:00:00Z" });
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { goal_id: goalId, title: body.title, description: body.description,
            status: "ACTIVE", revision: "3" } });
      }
    });
    vi.stubGlobal("fetch", router);
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("完成毕业论文（修订）");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();

    const post = posts.find((entry) => entry.path === "revisions");
    expect(post?.body.expected_revision).toBe("2");
    expect(post?.body.description).toBe("完成实验并整理结论");
    expect(view.wrapper.get('[data-testid="goal-detail-receipt"]').text()).toContain("v3");
    expect(view.wrapper.get('[data-testid="goal-detail-head"]').text()).toContain("完成毕业论文（修订）");
  });

  it("编辑响应修订与冻结命令错配时不宣布成功，pending 保留", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", baseRouter({
      linkPosts: (body) => {
        posts.push({ body });
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { goal_id: goalId, title: body.title, description: body.description,
            status: "ACTIVE", revision: "9" } });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("改写标题");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="goal-detail-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-detail-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("不匹配");
    expect(posts).toHaveLength(1);
  });

  it("归档需显式确认，成功后保留历史并停止编辑与新增关联", async () => {
    connect();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let current = goal();
    vi.stubGlobal("fetch", baseRouter({
      goal: () => response(200, current),
      linkPosts: (body) => {
        posts.push({ path: "archive", body });
        current = goal({ status: "ARCHIVED", revision: "3" });
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { goal_id: goalId, status: "ARCHIVED", revision: "3" } });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-archive-open"]').trigger("click");
    await flush();
    await view.wrapper.get('[data-testid="goal-archive-submit"]').trigger("click");
    await flush(); await flush();

    expect(posts[0]?.body.expected_revision).toBe("2");
    expect(view.wrapper.get('[data-testid="goal-detail-archived-note"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="goal-edit-section"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="goal-link-panel"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-projects-section"]').text()).toContain("论文实验");
  });

  it("解除关联先展示影响清单；服务端清单变化时拒绝旧操作并要求再次确认", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", baseRouter({
      linkPosts: (body) => {
        posts.push({ body });
        return response(409, { code: "GOAL_LINK_IN_USE", detail: "清单已变化",
          conflict: { goal_id: goalId, impacted_task_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] } });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get(`[data-testid="goal-unlink-open-${p1}"]`).trigger("click");
    await flush();
    const confirm = view.wrapper.get(`[data-testid="goal-unlink-confirm-${p1}"]`);
    expect(confirm.text()).toContain("88888888-8888-4888-8888-888888888888");

    await view.wrapper.get(`[data-testid="goal-unlink-submit-${p1}"]`).trigger("click");
    await flush(); await flush();

    expect(posts[0]?.body.expected_impacted_task_ids)
      .toEqual(["88888888-8888-4888-8888-888888888888"]);
    expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("清单已变化");
    expect(view.wrapper.get(`[data-testid="goal-unlink-confirm-${p1}"]`).text())
      .toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    // 明确拒绝不是结果不明：不得留下待核对命令，也不得自动重发。
    expect(view.wrapper.find('[data-testid="goal-detail-pending"]').exists()).toBe(false);
    expect(posts).toHaveLength(1);
  });
});

describe("目录工作上下文", () => {
  it("只显示精确绑定该目录的会话，并保留原 Session ID 与 Goal/Project 入口", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `${root}/working-directories/${dir1}/work-context`) {
        return response(200, { kind: "DIRECTORY",
          directory: { id: dir1, canonical_root: "D:/work/thesis", status: "ACTIVE", revision: "1",
            project: { id: p1, title: "论文实验", project_type: "GENERAL",
              archive_status: "ACTIVE", archived_at: null, revision: "2" } },
          linked_goals: [{ id: goalId, title: "完成毕业论文", status: "ACTIVE", revision: "2" }],
          sessions: [{ id: session1, project_id: p1, title: "实验讨论", status: "ACTIVE",
            revision: "1", working_resource_id: dir1 }] });
      }
      if (url.pathname.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.pathname === `${root}/tasks`) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const view = await mountWorkbench(`/working-directories/${dir1}`); unmount = view.unmount;
    await flush();

    const link = view.wrapper.get(`[data-testid="directory-session-open-${session1}"]`);
    expect(link.attributes("href")).toContain(`session=${session1}`);
    expect(view.wrapper.get('[data-testid="directory-context-goals"]').text()).toContain("完成毕业论文");
    expect(view.wrapper.get('[data-testid="directory-context-sessions"]').text()).toContain("实验讨论");
    expect(view.wrapper.find(`[data-testid="directory-session-${session2}"]`).exists()).toBe(false);
  });
});
