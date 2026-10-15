import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 返回项目的顶部接续卡（总纲 §0.8.1、工作台 §18.9）的组件证据：
 * 无基线只展示当前事实；有基线显示相对上次已确认查看的变化；确认只记录阅读进度
 * （一次 presentation_id 一次，失败最多一次自动重试），不是接受候选或完成任务；
 * 项目切换后迟到响应不回写；命名接续点面板不被日常查看重设。
 * 桩数据只是组件证据，不替代真实 API 与真实 Windows 取证。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const taskId = "33333333-3333-4333-8333-333333333333";
const otherTaskId = "35555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
}

function project(id = projectId, title = "人机协作工作流研究") {
  return { id, title, project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
}

function state(id = projectId) {
  return { project_id: id, revision: "7", phase_key: "EXPERIMENT",
    next_action_task_id: taskId, selected_artifact_version_refs: [], completed_highlight_refs: [] };
}

function task(id: string, title: string) {
  return { id, project_id: projectId, title, status: "IN_PROGRESS", mode: "ME", revision: "2",
    created_at: "2026-09-28T02:00:00Z", updated_at: "2026-09-29T03:42:00Z", executor: null,
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
    unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "o", source: "CREATE",
      created_at: "2026-09-28T02:00:00Z", criteria: [] }, dependencies: [] };
}

function current(over: Record<string, unknown> = {}) {
  return { state_revision: "7", phase_key: "EXPERIMENT", next_action_task_id: taskId,
    open_task_ids: [taskId, otherTaskId], open_task_count: 2, open_task_ids_truncated: false,
    waiting_task_count: 1, blocked_task_count: 0, unresolved_blocker_count: 0, ...over };
}

function baseline(over: Record<string, unknown> = {}) {
  return { presentation_id: "prev-presentation", viewed_state_revision: "5",
    viewed_fact_refs: { phase_key: "DESIGN", next_action_task_id: null, open_task_ids: [] },
    viewed_presentation_seq: "4",
    confirmed_at: "2026-10-08T09:00:00Z", ...over };
}

/** 服务端签发的展示身份：确认必须回显它，前端不再自造 presentation_id。 */
const serverPresentation = { presentation_id: "9d0e1f20-2122-4324-8425-262728292a2b",
  presentation_seq: "5" };

function dailyContinuation(over: Record<string, unknown> = {}) {
  return { project_id: projectId, current: current(), baseline: null, delta: null,
    presentation: serverPresentation, revision: "3", ...over };
}

function fullDelta(over: Record<string, unknown> = {}) {
  return { phase_changed: true, phase_before: "DESIGN", phase_after: "EXPERIMENT",
    next_action_changed: true, next_action_before: null, next_action_after: taskId,
    new_open_task_ids: [taskId, otherTaskId], closed_task_ids: ["35666666-6666-4666-8666-666666666666"],
    unresolved_blocker_count_changed: true, open_tasks_unknown: false, ...over };
}

interface Routes {
  daily?: () => Response | Promise<Response>;
  confirm?: (body: Record<string, unknown>) => Response;
  otherDaily?: () => Response;
}

function router(routes: Routes, posts: { path: string; body: unknown }[]) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (body: unknown, status = 200) => response(body, status);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      if (path === `${prefix}/projects/${projectId}/daily-view-confirmations`) {
        return routes.confirm?.(body) ?? json({ command_id: body.command_id,
          committed_at: "2026-10-09T10:00:00Z", result: dailyContinuation({
            baseline: baseline() }), links: { resource: "" } }, 200);
      }
      if (path === `${prefix}/projects/${otherProjectId}/daily-view-confirmations`) {
        return json({ command_id: body.command_id, committed_at: "2026-10-09T10:00:00Z",
          result: dailyContinuation({ project_id: otherProjectId, baseline: baseline() }),
          links: { resource: "" } }, 200);
      }
      // 返回轻量核对（Slice C / NLS-05）：只读核对记录，服务端按事实指纹复用。
      if (path === `${prefix}/projects/${projectId}/return-reviews` ||
        path === `${prefix}/projects/${otherProjectId}/return-reviews`) {
        const reviewProject = path.includes(otherProjectId) ? otherProjectId : projectId;
        return json({ command_id: body.command_id, committed_at: "2026-10-09T10:00:01Z",
          result: { review_id: "7a1c9b22-5566-4738-99aa-bbccddeeff00",
            project_id: reviewProject, status: "APPLICABLE",
            fingerprint: "a".repeat(64), reused: false, changed_dimensions: [],
            delta: null, evidence: [], created_at: "2026-10-09T10:00:01Z" },
          links: { resource: "" } }, 200);
      }
      throw new Error(`unexpected POST ${path}`);
    }
    if (path === `${prefix}/projects/${projectId}/daily-continuation`) {
      return routes.daily?.() ?? json(dailyContinuation());
    }
    if (path === `${prefix}/projects/${otherProjectId}/daily-continuation`) {
      return routes.otherDaily?.() ?? json(dailyContinuation({
        project_id: otherProjectId, current: current({ state_revision: "9",
          phase_key: "VALIDATION", next_action_task_id: otherTaskId, open_task_count: 4,
          waiting_task_count: 2, blocked_task_count: 1, unresolved_blocker_count: 1 }),
        baseline: baseline(), delta: fullDelta({ phase_before: "EXPERIMENT",
          phase_after: "VALIDATION" }), revision: "5" }));
    }
    if (path === `${prefix}/projects/${projectId}` ||
      path === `${prefix}/projects/${otherProjectId}`) {
      return json(path.endsWith(otherProjectId) ? project(otherProjectId, "另一项目") : project());
    }
    if (path === `${prefix}/projects/${projectId}/state` ||
      path === `${prefix}/projects/${otherProjectId}/state`) {
      // 注意 path 以 /state 结尾，判断项目归属用 includes 而不是 endsWith。
      return json(path.includes(otherProjectId)
        ? { ...state(otherProjectId), revision: "9", phase_key: "VALIDATION",
          next_action_task_id: otherTaskId }
        : state());
    }
    if (path === `${prefix}/projects/${projectId}/goals` ||
      path === `${prefix}/projects/${otherProjectId}/goals`) return json({ items: [] });
    if (path === `${prefix}/projects/${projectId}/continuation-points` ||
      path === `${prefix}/projects/${otherProjectId}/continuation-points`) return json({ items: [] });
    if (path === `${prefix}/reviews`) return json({ items: [] });
    if (path === `${prefix}/decisions`) return json([]);
    if (path === `${prefix}/tasks/${taskId}`) return json(task(taskId, "补齐基线"));
    if (path === `${prefix}/tasks/${otherTaskId}`) return json(task(otherTaskId, "跑验证"));
    if (path === `${prefix}/tasks`) return json({ items: [], next_cursor: null });
    if (path === `${prefix}/model-port`) return json({ provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return json({
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/search`)) return json({ items: [], next_cursor: null });
    throw new Error(`unexpected request GET ${path}`);
  });
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("返回项目的顶部接续卡", () => {
  it("无基线首帧：显示当前事实与「首次查看」，确认 POST 恰一次且 viewed_fact_refs 等于展示的 current", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush();
      const card = view.wrapper.get('[data-testid="daily-continuation"]');
      expect(card.attributes("data-state")).toBe("unchanged");
      expect(view.wrapper.get('[data-testid="daily-continuation-summary"]').text())
        .toContain("首次查看，以下是当前事实");
      expect(view.wrapper.find('[data-testid="daily-continuation-delta"]').exists()).toBe(false);
      // 当前事实：阶段、下一步、在途与阻塞计数原样可见。
      const facts = view.wrapper.get('[data-testid="daily-continuation-facts"]').text();
      expect(facts).toContain("实验");
      expect(facts).toContain(taskId);
      expect(facts).toContain("进行中任务 2");
      expect(facts).toContain("等待验收 1");
      expect(facts).toContain("未决阻塞 0");
      // 确认恰一次：viewed_fact_refs 回显本次展示的 current，viewed_state_revision 同源。
      const confirms = posts.filter((post) => post.path.endsWith("/daily-view-confirmations"));
      expect(confirms).toHaveLength(1);
      const body = confirms[0]!.body as { command_id: string; presentation_id: string;
        presentation_seq: string; viewed_state_revision: string;
        viewed_fact_refs: Record<string, unknown> };
      expect(body.command_id).toMatch(/^[0-9a-f-]{36}$/u);
      // 展示身份与顺序都来自服务端签发的那次读取，不由客户端生成。
      expect(body.presentation_id).toBe(serverPresentation.presentation_id);
      expect(body.presentation_seq).toBe(serverPresentation.presentation_seq);
      expect(body.viewed_state_revision).toBe("7");
      expect(body.viewed_fact_refs).toEqual({ phase_key: "EXPERIMENT",
        next_action_task_id: taskId, open_task_ids: [taskId, otherTaskId],
        open_task_ids_truncated: false, unresolved_blocker_count: 0 });
      // 确认成功不改变卡片内容，「已查看」不是接受：没有接受/通过/完成措辞。
      expect(card.text()).not.toContain("接受");
      expect(card.text()).not.toContain("通过");
      expect(card.text()).not.toContain("完成");
      expect(view.wrapper.find('[data-testid="daily-continuation-confirm-retry"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("有基线且有实质变化：摘要列出阶段/下一步/新增/关闭，展开区含 before/after 明细", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ daily: () => response(dailyContinuation({
      baseline: baseline(), delta: fullDelta() })) }, posts));
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush();
      const card = view.wrapper.get('[data-testid="daily-continuation"]');
      expect(card.attributes("data-state")).toBe("changed");
      const summary = view.wrapper.get('[data-testid="daily-continuation-summary"]').text();
      expect(summary).toContain("自上次查看：");
      expect(summary).toContain("设计 → 实验");
      expect(summary).toContain("下一步已变更");
      expect(summary).toContain("新增 2 个任务");
      expect(summary).toContain("关闭 1 个任务");
      expect(summary).toContain("未决阻塞有变化");
      // 展开区：before/after 明细可核对。
      const delta = view.wrapper.get('[data-testid="daily-continuation-delta"]').text();
      expect(delta).toContain("设计 → 实验");
      expect(delta).toContain("未指定 →");
      expect(delta).toContain("35666666-6666-4666-8666-666666666666");
      expect(delta).toContain("计数有变化");
      // 阻塞计数仍在折叠态可见（当前值 0，来自 current）。
      expect(view.wrapper.get('[data-testid="daily-continuation-facts"]').text()).toContain("阻塞 0");
      // 确认仍恰一次。
      expect(posts.filter((post) => post.path.endsWith("/daily-view-confirmations"))).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("有基线但无实质变化：显示「与上次查看一致」，不显示「自上次查看」", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ daily: () => response(dailyContinuation({
      baseline: baseline(), delta: fullDelta({ phase_changed: false, next_action_changed: false,
        new_open_task_ids: [], closed_task_ids: [], unresolved_blocker_count_changed: false }) })) },
    posts));
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush();
      const summary = view.wrapper.get('[data-testid="daily-continuation-summary"]').text();
      expect(summary).toContain("与上次查看一致");
      expect(summary).not.toContain("自上次查看");
      // 当前事实仍然展示：一致不等于隐藏事实。
      expect(view.wrapper.get('[data-testid="daily-continuation-facts"]').text()).toContain("实验");
      expect(view.wrapper.get('[data-testid="daily-continuation"]').attributes("data-state")).toBe("unchanged");
    } finally { view.unmount(); }
  });

  it("GET 失败：不显示任何「没有变化/一致」措辞，可重试且重试成功后才确认", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let failing = true;
    vi.stubGlobal("fetch", router({ daily: () => failing
      ? response({ code: "HTTP_ERROR", detail: "接续投影暂不可用" }, 500)
      : response(dailyContinuation()) }, posts));
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush();
      const card = view.wrapper.get('[data-testid="daily-continuation"]');
      expect(card.attributes("data-state")).toBe("failed");
      expect(card.text()).toContain("接续进度读取失败");
      expect(card.text()).not.toContain("与上次查看一致");
      expect(card.text()).not.toContain("首次查看");
      expect(card.text()).not.toContain("自上次查看");
      expect(posts.filter((post) => post.path.endsWith("/daily-view-confirmations"))).toHaveLength(0);

      failing = false;
      await view.wrapper.get('[data-testid="daily-continuation-retry"]').trigger("click");
      await flush(); await flush();
      expect(view.wrapper.get('[data-testid="daily-continuation"]').attributes("data-state")).toBe("unchanged");
      expect(view.wrapper.get('[data-testid="daily-continuation-summary"]').text()).toContain("首次查看");
      const confirms = posts.filter((post) => post.path.endsWith("/daily-view-confirmations"));
      expect(confirms).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("确认失败最多一次自动重试（同 command_id 同 presentation_id），之后手动触发", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let failures = 2;
    vi.stubGlobal("fetch", router({ confirm: () => failures-- > 0
      ? response({ code: "HTTP_ERROR", detail: "确认暂不可用" }, 500)
      : response({ command_id: "ok", committed_at: "2026-10-09T10:00:00Z",
        result: dailyContinuation({ baseline: baseline() }), links: { resource: "" } }, 200) },
    posts));
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush(); await flush();
      // 自动确认 2 次（首次 + 恰一次自动重试），命令身份与展示身份都沿用同一份。
      let confirms = posts.filter((post) => post.path.endsWith("/daily-view-confirmations"));
      expect(confirms).toHaveLength(2);
      const firstCommandId = (confirms[0]!.body as { command_id: string }).command_id;
      const firstPresentationId = (confirms[0]!.body as { presentation_id: string }).presentation_id;
      expect((confirms[1]!.body as { command_id: string }).command_id).toBe(firstCommandId);
      expect((confirms[1]!.body as { presentation_id: string }).presentation_id).toBe(firstPresentationId);
      // 不循环重试：显示手动入口。
      expect(view.wrapper.get('[data-testid="daily-continuation-confirm-retry"]').exists()).toBe(true);

      await view.wrapper.get('[data-testid="daily-continuation-confirm-retry"]').trigger("click");
      await flush(); await flush();
      confirms = posts.filter((post) => post.path.endsWith("/daily-view-confirmations"));
      expect(confirms).toHaveLength(3);
      expect((confirms[2]!.body as { command_id: string }).command_id).toBe(firstCommandId);
      expect((confirms[2]!.body as { presentation_id: string }).presentation_id).toBe(firstPresentationId);
      // 成功后入口收敛，卡片内容不变；也不再自动重试。
      expect(view.wrapper.find('[data-testid="daily-continuation-confirm-retry"]').exists()).toBe(false);
      await flush();
      expect(posts.filter((post) => post.path.endsWith("/daily-view-confirmations"))).toHaveLength(3);
      expect(view.wrapper.get('[data-testid="daily-continuation-summary"]').text())
        .toContain("首次查看，以下是当前事实");
    } finally { view.unmount(); }
  });

  it("项目切换后迟到 GET 不回写：旧响应释放后新项目卡片仍是自己的事实，旧项目零确认", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let release: ((value: Response) => void) | null = null;
    const gated = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = router({ daily: () => gated }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush();
      // p1 的接续读取被扣住，切换到 p2。
      await view.router.push(`/projects/${otherProjectId}`);
      await flush(); await flush(); await flush(); await flush();
      // p2 有自己的卡片与自己的确认（p1 未取得投影，不可能确认）。
      expect(posts.filter((post) => post.path.endsWith("/daily-view-confirmations"))).toHaveLength(1);
      expect((posts[0]!.path).startsWith(`${prefix}/projects/${otherProjectId}/`)).toBe(true);

      // 释放 p1 的迟到响应：不得回写 p2 的卡片，也不得产生 p1 的确认。
      release!(response(dailyContinuation()));
      await flush(); await flush(); await flush();
      const cards = view.wrapper.findAll('[data-testid="daily-continuation"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]!.attributes("data-state")).toBe("changed");
      const summary = view.wrapper.get('[data-testid="daily-continuation-summary"]').text();
      expect(summary).toContain("自上次查看：");
      expect(summary).toContain("实验 → 验证");
      expect(summary).not.toContain("首次查看");
      // p2 的确认仍然只有一次（迟到响应不触发第二次确认）。
      expect(posts.filter((post) => post.path.endsWith("/daily-view-confirmations"))).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("命名接续点面板不被日常查看重设：resume 页原逻辑照常渲染", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({}, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush();
      // 日常查看已发生：接续卡确认恰一次，且没有对接续点的任何写命令。
      expect(posts.some((post) => post.path.endsWith("/daily-view-confirmations"))).toBe(true);
      expect(posts.some((post) => post.path.includes("/continuation-points"))).toBe(false);

      // 切到「继续项目」页签：命名接续点面板按原逻辑读取与渲染，未被日常查看重设。
      await view.router.push(`/projects/${projectId}?skill=resume`);
      await flush(); await flush();
      expect(view.wrapper.get('[data-testid="continuation-panel"]').exists()).toBe(true);
      const pointsRequested = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/continuation-points")).length;
      expect(pointsRequested).toBeGreaterThanOrEqual(1);
      // 面板没有把「已查看」当成接续点操作：零捕获命令。
      expect(posts.some((post) => post.path.includes("/continuation-points"))).toBe(false);
    } finally { view.unmount(); }
  });

  it("返回轻量核对（NLS-05）：展示核对结论，恰一次触发，只读不伪造 Run 或修复", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench(`/projects/${projectId}`);
    try {
      await flush(); await flush();
      const review = view.wrapper.get('[data-testid="daily-continuation-review"]');
      expect(review.exists()).toBe(true);
      expect(review.text()).toContain("轻量核对");
      expect(review.text()).toContain("既有证据仍适用");
      // 核对是独立只读命令：恰一次触发，且不是 Run/修复/任务类写入。
      const reviews = posts.filter((post) => post.path.endsWith("/return-reviews"));
      expect(reviews).toHaveLength(1);
      const body = reviews[0]!.body as { command_id: string };
      expect(body.command_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(posts.some((post) =>
        post.path.includes("/runs") || post.path.includes("/tasks"))).toBe(false);
    } finally { view.unmount(); }
  });
});
