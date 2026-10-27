import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { clickPortal, dialogText, flush, mountWorkbench } from "./mountApp";

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
  sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); resetRelayConnectionForTest(); vi.unstubAllGlobals();
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
  it("窗口会话结束后恢复原 Goal 编辑命令，不发第二条", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", baseRouter({ linkPosts: (body) => { posts.push(body); throw new TypeError("response lost"); } }));
    const first = await mountWorkbench(`/goals/${goalId}`); await flush();
    await first.wrapper.get('[data-testid="goal-edit-title"]').setValue("等待核对的标题");
    await first.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click"); await flush();
    const commandId = String(posts[0]?.command_id);
    expect(first.wrapper.get('[data-testid="goal-detail-pending"]').text()).toContain(commandId);
    first.unmount(); sessionStorage.clear();
    const reopened = await mountWorkbench(`/goals/${goalId}`); unmount = reopened.unmount; await flush();
    expect(reopened.wrapper.get('[data-testid="goal-detail-pending"]').text()).toContain(commandId);
    expect(posts).toHaveLength(1);
  });
  it("无法保存 Goal 编辑命令时不发送请求并保留草稿", async () => {
    connect();
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", baseRouter({ linkPosts: (body) => { posts.push(body); return response(500, {}); } }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount; await flush();
    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("需要保留的草稿");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("relay:goal-detail-pending:")) throw new DOMException("unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    });
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click"); await flush();
    expect(posts).toHaveLength(0);
    expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value).toBe("需要保留的草稿");
    expect(view.wrapper.text()).toContain("未发送");
  });
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
    await view.router.attempt(`/projects/${p1}`);
    expect(view.router.currentRoute.value.path).toBe(`/projects/${p1}`);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Goal 标题草稿触发全局路由守卫，继续编辑恢复焦点，显式丢弃后离开且无残留守卫", async () => {
    connect();
    vi.stubGlobal("fetch", baseRouter({}));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("只改标题的草稿");
    const title = view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement;
    title.focus();
    await view.router.attempt(`/projects/${p1}`);
    expect(dialogText()).toContain("未保存的修改");
    expect(view.router.currentRoute.value.path).toBe(`/goals/${goalId}`);

    await clickPortal("keep-editing");
    expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value)
      .toBe("只改标题的草稿");
    expect(document.activeElement).toBe(title);

    await view.router.attempt(`/projects/${p1}`);
    await clickPortal("discard-draft-leave");
    await flush();
    expect(view.router.currentRoute.value.path).toBe(`/projects/${p1}`);

    await view.router.push(`/goals/${goalId}`);
    expect(view.router.currentRoute.value.path).toBe(`/goals/${goalId}`);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("清空 Goal 说明同样受全局离页保护，改回基线后不再误拦", async () => {
    connect();
    vi.stubGlobal("fetch", baseRouter({}));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-description"]').setValue("");
    await view.router.attempt(`/projects/${p1}`);
    expect(dialogText()).toContain("未保存的修改");
    await clickPortal("keep-editing");
    await view.wrapper.get('[data-testid="goal-edit-description"]').setValue("完成实验并整理结论");
    await view.router.attempt(`/projects/${p1}`);
    expect(view.router.currentRoute.value.path).toBe(`/projects/${p1}`);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Goal 草稿与 Goal–Project pending 共存：明确丢弃草稿后可保留原命令离开并恢复", async () => {
    connect();
    const pendingPosts: Record<string, unknown>[] = [];
    const fallback = baseRouter({});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === `${root}/projects`) return response(200, { items: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "待关联项目", project_type: "GENERAL",
        revision: "2", state_revision: "3", archived_at: null, archive_status: "ACTIVE",
        phase_key: "PLANNING", next_action_task_id: null,
        created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z"
      }], next_cursor: null });
      if (method === "GET" && url.pathname === `${root}/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/goals`)
        return response(200, { items: [] });
      if (method === "POST" && url.pathname.endsWith("/goal-links")) {
        pendingPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response(500, { code: "INTERNAL_ERROR", detail: "结果尚未确认" });
      }
      return fallback(input, init);
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-link-project"]').setValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await view.wrapper.get('[data-testid="goal-link-submit"]').trigger("click");
    await flush(); await flush();
    expect(view.wrapper.get('[data-testid="goal-link-pending"]').exists()).toBe(true);
    expect(pendingPosts).toHaveLength(1);
    const originalId = pendingPosts[0]?.command_id;

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("另外一份本地草稿");
    await view.router.attempt(`/projects/${p1}`);
    expect(dialogText()).toContain(String(originalId));
    expect(dialogText()).toContain("未提交草稿");
    await clickPortal("discard-draft-keep-pending-leave");
    await flush();
    expect(view.router.currentRoute.value.path).toBe(`/projects/${p1}`);
    expect(pendingPosts).toHaveLength(1);

    await view.router.push(`/goals/${goalId}`);
    await flush();
    expect(view.wrapper.get('[data-testid="goal-link-pending"]').text()).toContain(String(originalId));
    expect(pendingPosts).toHaveLength(1);
    await view.router.attempt(`/projects/${p1}`);
    expect(dialogText()).toContain(String(originalId));
    await clickPortal("pending-keep-and-leave");
    await flush();
    expect(view.router.currentRoute.value.path).toBe(`/projects/${p1}`);
    expect(pendingPosts).toHaveLength(1);
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

  /** 内容错配：身份与修订都对、但 title/description 与冻结命令不一致的响应不能假成功。 */
  const editContentMismatchCases: readonly { readonly name: string;
    readonly patch: (body: Record<string, unknown>) => Record<string, unknown> }[] = [
    { name: "标题与冻结命令不一致", patch: (body) => ({ command_id: body.command_id,
      committed_at: "2026-10-04T00:00:00Z",
      result: { goal_id: goalId, title: "他人写入的标题", description: body.description,
        status: "ACTIVE", revision: "3" } }) },
    { name: "说明与冻结命令不一致", patch: (body) => ({ command_id: body.command_id,
      committed_at: "2026-10-04T00:00:00Z",
      result: { goal_id: goalId, title: body.title, description: "他人写入的说明",
        status: "ACTIVE", revision: "3" } }) },
    { name: "标题与说明同时错配", patch: (body) => ({ command_id: body.command_id,
      committed_at: "2026-10-04T00:00:00Z",
      result: { goal_id: goalId, title: "他人写入的标题", description: "他人写入的说明",
        status: "ACTIVE", revision: "3" } }) },
  ];

  for (const testCase of editContentMismatchCases) {
    it(`编辑成功响应内容错配（${testCase.name}）时不宣布成功、不清 pending`, async () => {
      connect();
      const posts: { body: Record<string, unknown> }[] = [];
      vi.stubGlobal("fetch", baseRouter({
        linkPosts: (body) => {
          posts.push({ body });
          return response(200, testCase.patch(body));
        }
      }));
      const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
      await flush();

      await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("冻结的标题");
      await view.wrapper.get('[data-testid="goal-edit-description"]').setValue("冻结的说明");
      await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
      await flush(); await flush();

      expect(view.wrapper.find('[data-testid="goal-detail-receipt"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="goal-detail-pending"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("不匹配");
      expect(posts).toHaveLength(1);
    });
  }

  it("原回执内容错配（标题被改写）时同样不宣布成功，pending 原样保留", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", baseRouter({
      linkPosts: (body) => {
        posts.push({ body });
        throw new TypeError("response lost after commit");
      }
    }));
    const fetchStub = vi.mocked(globalThis.fetch);
    const original = fetchStub.getMockImplementation()!;
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (/\/commands\/[^/]+$/u.test(path)) {
        const issued = posts[0]?.body.command_id;
        return response(200, { command_id: issued, command_type: "EditGoal",
          committed_at: "2026-10-04T00:00:05Z",
          result: { goal_id: goalId, title: "回执里的他人标题", description: issued ? posts[0]!.body.description : "",
            status: "ACTIVE", revision: "3" } });
      }
      return original(input, init);
    });
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("冻结的标题");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush();
    expect(view.wrapper.get('[data-testid="goal-detail-pending"]').exists()).toBe(true);

    await view.wrapper.get('[data-testid="goal-detail-check-receipt"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="goal-detail-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-detail-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("不匹配");
    expect(posts).toHaveLength(1);
  });

  it("响应丢失后按原 ID 原载荷幂等重放，同一命令收口", async () => {    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", baseRouter({
      linkPosts: (body) => {
        posts.push({ body });
        if (posts.length === 1) throw new TypeError("response lost after commit");
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { goal_id: goalId, title: body.title, description: body.description,
            status: "ACTIVE", revision: "3" } });
      }
    }));
    const fetchStub = vi.mocked(globalThis.fetch);
    const original = fetchStub.getMockImplementation()!;
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (/\/commands\/[^/]+$/u.test(path)) {
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "命令回执不存在" });
      }
      return original(input, init);
    });
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("幂等重放的标题");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();
    expect(view.wrapper.get('[data-testid="goal-detail-pending"]').exists()).toBe(true);

    // 回执 404 后才开放原样重试：同 ID、同标题、同说明。
    await view.wrapper.get('[data-testid="goal-detail-check-receipt"]').trigger("click");
    await flush(); await flush();
    await view.wrapper.get('[data-testid="goal-detail-retry"]').trigger("click");
    await flush(); await flush();

    expect(posts).toHaveLength(2);
    expect(posts[1]?.body.command_id).toBe(posts[0]?.body.command_id);
    expect(posts[1]?.body.title).toBe(posts[0]?.body.title);
    expect(posts[1]?.body.description).toBe(posts[0]?.body.description);
    expect(view.wrapper.get('[data-testid="goal-detail-receipt"]').text()).toContain("幂等重放的标题");
  });

  /** 409 冲突重读必须保留未保存草稿：服务端新事实以差异呈现，再提交由用户显式确认。 */
  it("编辑 409 冲突重读后草稿保留、差异可见，再次确认按新修订提交", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    let current = goal();
    vi.stubGlobal("fetch", baseRouter({
      goal: () => response(200, current),
      linkPosts: (body) => {
        posts.push({ body });
        if (posts.length === 1) {
          current = goal({ title: "他人修改的标题", description: "他人修改的说明", revision: "3" });
          return response(409, { code: "REVISION_CONFLICT", detail: "修订已变化",
            conflict: { expected_revision: "2", actual_revision: "3" } });
        }
        current = goal({ title: String(body.title), description: String(body.description), revision: "4" });
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { goal_id: goalId, title: body.title, description: body.description,
            status: "ACTIVE", revision: "4" } });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("我的草稿标题");
    await view.wrapper.get('[data-testid="goal-edit-description"]').setValue("我的草稿说明");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();

    // 提示「草稿未被覆盖」必须为真：输入框仍是我的草稿，而不是服务端新值。
    expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value).toBe("我的草稿标题");
    expect((view.wrapper.get('[data-testid="goal-edit-description"]').element as HTMLTextAreaElement).value).toBe("我的草稿说明");
    expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("修订已变化");
    // 最新事实可见：差异以服务端当前值呈现，不静默替换草稿。
    expect(view.wrapper.get('[data-testid="goal-edit-conflict-facts"]').text()).toContain("他人修改的标题");
    expect(view.wrapper.get('[data-testid="goal-edit-conflict-facts"]').text()).toContain("他人修改的说明");

    const draftTitle = view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement;
    draftTitle.focus();
    await view.router.attempt(`/projects/${p1}`);
    expect(dialogText()).toContain("未保存的修改");
    await clickPortal("keep-editing");
    expect(document.activeElement).toBe(draftTitle);
    expect(draftTitle.value).toBe("我的草稿标题");

    // 显式再确认：用重读后的新修订提交同一条草稿。
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();

    expect(posts).toHaveLength(2);
    expect(posts[1]?.body.expected_revision).toBe("3");
    expect(posts[1]?.body.title).toBe("我的草稿标题");
    expect(posts[1]?.body.description).toBe("我的草稿说明");
    expect(view.wrapper.get('[data-testid="goal-detail-receipt"]').text()).toContain("我的草稿标题");
  });

  it("409 冲突后选择放弃时，草稿恢复为最新服务端事实", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    let current = goal();
    vi.stubGlobal("fetch", baseRouter({
      goal: () => response(200, current),
      linkPosts: (body) => {
        posts.push({ body });
        current = goal({ title: "他人修改的标题", description: "他人修改的说明", revision: "3" });
        return response(409, { code: "REVISION_CONFLICT", detail: "修订已变化",
          conflict: { expected_revision: "2", actual_revision: "3" } });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("我的草稿标题");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();
    expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value).toBe("我的草稿标题");

    await view.wrapper.get('[data-testid="goal-edit-reset"]').trigger("click");
    await flush();

    expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value).toBe("他人修改的标题");
    expect((view.wrapper.get('[data-testid="goal-edit-description"]').element as HTMLTextAreaElement).value).toBe("他人修改的说明");
    expect(view.wrapper.find('[data-testid="goal-edit-conflict-facts"]').exists()).toBe(false);
  });

  /** 三种草稿形态：只有标题变、只有说明变、说明被清空——409 后都必须保留并可按新修订显式重发。 */
  const draftShapeCases: readonly { readonly name: string; readonly title: string;
    readonly description: string }[] = [
    { name: "仅标题修改", title: "只改标题的草稿", description: "完成实验并整理结论" },
    { name: "仅说明修改", title: "完成毕业论文", description: "只改说明的草稿" },
    { name: "说明被清空", title: "完成毕业论文", description: "" },
  ];

  for (const shape of draftShapeCases) {
    it(`409 冲突后${shape.name}的草稿保留并按新修订显式重发`, async () => {
      connect();
      const posts: { body: Record<string, unknown> }[] = [];
      let current = goal();
      vi.stubGlobal("fetch", baseRouter({
        goal: () => response(200, current),
        linkPosts: (body) => {
          posts.push({ body });
          if (posts.length === 1) {
            current = goal({ revision: "3" });
            return response(409, { code: "REVISION_CONFLICT", detail: "修订已变化",
              conflict: { expected_revision: "2", actual_revision: "3" } });
          }
          current = goal({ title: String(body.title), description: String(body.description), revision: "4" });
          return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
            result: { goal_id: goalId, title: body.title, description: body.description,
              status: "ACTIVE", revision: "4" } });
        }
      }));
      const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
      await flush();

      await view.wrapper.get('[data-testid="goal-edit-title"]').setValue(shape.title);
      await view.wrapper.get('[data-testid="goal-edit-description"]').setValue(shape.description);
      await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
      await flush(); await flush();

      expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value).toBe(shape.title);
      expect((view.wrapper.get('[data-testid="goal-edit-description"]').element as HTMLTextAreaElement).value).toBe(shape.description);

      await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
      await flush(); await flush();

      expect(posts).toHaveLength(2);
      expect(posts[1]?.body.expected_revision).toBe("3");
      expect(posts[1]?.body.title).toBe(shape.title);
      expect(posts[1]?.body.description).toBe(shape.description);
    });
  }

  it("解除关联成功触发事实刷新时，未保存草稿不被覆盖", async () => {
    connect();
    vi.stubGlobal("fetch", baseRouter({
      linkPosts: (body) => response(200, { command_id: body.command_id,
        committed_at: "2026-10-04T00:00:00Z",
        result: { project_id: p1, revision: "3",
          impacted_tasks: [{ task_id: "88888888-8888-4888-8888-888888888888", revision: "2" }] } })
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("解除期间不打断的草稿");
    await view.wrapper.get(`[data-testid="goal-unlink-open-${p1}"]`).trigger("click");
    await flush();
    await view.wrapper.get(`[data-testid="goal-unlink-submit-${p1}"]`).trigger("click");
    await flush(); await flush();

    expect(view.wrapper.get('[data-testid="goal-detail-receipt"]').text()).toContain("已解除");
    expect((view.wrapper.get('[data-testid="goal-edit-title"]').element as HTMLInputElement).value).toBe("解除期间不打断的草稿");
  });

  it("编辑 2xx 回执格式无效时保留冻结命令等待核对", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", baseRouter({
      linkPosts: (body) => {
        posts.push({ body });
        return response(200, { command_id: body.command_id,
          committed_at: "2026-10-04T00:00:00Z", result: null });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get('[data-testid="goal-edit-title"]').setValue("改写标题");
    await view.wrapper.get('[data-testid="goal-edit-submit"]').trigger("click");
    await flush(); await flush();

    expect(view.wrapper.find('[data-testid="goal-detail-receipt"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="goal-detail-pending"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("已保留原 command_id");
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

  it("GOAL_LINK_IN_USE 后基于重读事实再确认：新清单配新 Project 修订，不沿旧修订重发", async () => {
    connect();
    const posts: { body: Record<string, unknown> }[] = [];
    let projectRevision = "2";
    vi.stubGlobal("fetch", baseRouter({
      goalProjects: () => response(200, { items: [
        goalLink(p1, "论文实验", { project_revision: projectRevision }),
        goalLink(p2, "旧论文分支",
          { archive_status: "ARCHIVED", archived_at: "2026-10-01T00:00:00Z", project_revision: "4" }) ] }),
      linkPosts: (body) => {
        posts.push({ body });
        if (posts.length === 1) {
          // 冲突期间其他客户端推进了 Project 修订：重读必须读到 v3，再确认不得沿用 v2。
          projectRevision = "3";
          return response(409, { code: "GOAL_LINK_IN_USE", detail: "清单已变化",
            conflict: { goal_id: goalId, impacted_task_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] } });
        }
        return response(200, { command_id: body.command_id, committed_at: "2026-10-04T00:00:00Z",
          result: { project_id: p1, revision: "4",
            impacted_tasks: [{ task_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: "5" }] } });
      }
    }));
    const view = await mountWorkbench(`/goals/${goalId}`); unmount = view.unmount;
    await flush();

    await view.wrapper.get(`[data-testid="goal-unlink-open-${p1}"]`).trigger("click");
    await flush();
    await view.wrapper.get(`[data-testid="goal-unlink-submit-${p1}"]`).trigger("click");
    await flush(); await flush();
    expect(view.wrapper.get('[data-testid="goal-detail-error"]').text()).toContain("清单已变化");

    // 重读后再次确认：新清单 + 重读到的 Project 修订。
    await view.wrapper.get(`[data-testid="goal-unlink-submit-${p1}"]`).trigger("click");
    await flush(); await flush();

    expect(posts).toHaveLength(2);
    expect(posts[1]?.body.expected_impacted_task_ids)
      .toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(posts[1]?.body.expected_revision).toBe("3");
    expect(view.wrapper.get('[data-testid="goal-detail-receipt"]').text()).toContain("v4");
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
