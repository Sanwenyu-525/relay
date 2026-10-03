import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 工作台 §18.1/§18.2 的前端反例：打开目录直达输入区、首条发送自动建会话，
 * 以及明确执行请求进入真实执行链前的紧凑摘要与聚焦澄清。
 * 这里只断言客户端行为：请求来源、命令身份和阶段显示，不替代真实 API 与真实 Windows 取证。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const sessionId = "66666666-6666-4666-8666-666666666666";
const requestId = "abababab-abab-4bab-8bab-abababababab";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const root = "D:\\Develop\\MyProject";

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
}

function project(over: Record<string, unknown> = {}) {
  return { id: projectId, title: "MyProject", project_type: "GENERAL", revision: "1", state_revision: "1",
    archived_at: null, ...over };
}

function readyDirectory(over: Record<string, unknown> = {}) {
  return { canonical_root: root, display_name: "MyProject", status: "READY", reason: null,
    association: { project_id: projectId, project_title: "MyProject", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: true, created_resource: true, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" },
    ...over };
}

function execution(over: Record<string, unknown> = {}) {
  return { request_id: requestId, session_id: sessionId, source_message_id: "msg-1", resource_id: "res-1",
    root_path: root, decision: "PREPARE", status: "READY", candidate_status: "READY", questions: [],
    candidate: { title: "改写 answer.txt", objective: "内容变成 after" }, task_id: null, run_id: null,
    revision: "1", ...over };
}

interface Routes {
  open?: (body: Record<string, unknown>) => Response;
  messages?: () => Response;
  sessions?: () => Response;
}

function router(routes: Routes, posts: { path: string; body: unknown }[]) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (body: unknown, status = 200) => response(body, status);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) return routes.open?.(body) ?? json({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z", result: readyDirectory(),
        links: { resource: "" } }, 200);
      if (path === `${prefix}/assist-sessions`) return json({ command_id: body.command_id,
        committed_at: "2026-10-02T00:00:00Z",
        result: { session_id: sessionId, workspace_id: workspaceId, project_id: projectId,
          task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
          created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" },
        links: { resource: "" } }, 201);
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return json({ command_id: body.command_id,
        committed_at: "2026-10-02T00:00:00Z",
        result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" },
        links: { resource: "" } }, 202);
      if (path === `${prefix}/assist-sessions/${sessionId}/execution-requests`) return json({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z", result: execution(),
        links: { resource: "" } }, 202);
      if (path === `${prefix}/conversation-execution-requests/${requestId}/applications`) return json({
        command_id: "apply-1", committed_at: "2026-10-02T00:00:01Z",
        result: { request_id: requestId, status: "DELEGATED", task_id: taskId, run_id: runId, revision: "3" },
        links: { resource: "" } }, 200);
      throw new Error(`unexpected POST ${path}`);
    }
    if (path === `${prefix}/projects/${projectId}`) return json(project());
    if (path === `${prefix}/projects/${projectId}/state`) return json({ project_id: projectId, revision: "1",
      phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/projects`) return json({ items: [{ ...project(), archive_status: "ACTIVE",
      phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z" }], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) return routes.sessions?.() ?? json({ items: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return routes.messages?.() ?? json({ items: [{
      id: "msg-1", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS",
      content: "帮我把这个文件的内容改成 after", sources: [], cancel_requested: false,
      error_code: null, provider_error_kind: null, created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
      usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
      skill: null }] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return json({ items: [
      { request_id: requestId, session_id: sessionId, source_message_id: "msg-1", decision: "PREPARE",
        status: "DELEGATED", candidate_status: "READY", root_path: root, questions: [],
        task_id: taskId, run_id: runId, revision: "3", created_at: "2026-10-02T00:00:00Z",
        updated_at: "2026-10-02T00:00:01Z" }] });
    if (path === `${prefix}/assist-proposals`) return json({ items: [] });
    if (path === `${prefix}/skill-definitions`) return json({ items: [] });
    if (path === `${prefix}/model-port`) return json({ provider: "fake", configured: false, model: null,
      base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return json({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/search`)) return json({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return json({ items: [], next_cursor: null });
    throw new Error(`unexpected request GET ${path}`);
  });
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("文件夹入口与对话直接执行", () => {
  it("未打开目录时不进入任何写路径；打开目录后直达输入区且首条发送自动建会话", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({}, posts); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      expect(view.wrapper.get('[data-testid="folder-scope"]').exists()).toBe(true);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(false);
      // 非桌面宿主没有原生选择器：必须给出可用的手动路径，而不是一个死按钮。
      expect(view.wrapper.get('[data-testid="folder-manual-root"]').exists()).toBe(true);
      expect(posts.length).toBe(0);

      await view.wrapper.get('[data-testid="folder-manual-root"]').setValue(root);
      await flush();
      await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
      await flush();
      await flush();
      expect(posts.map((post) => post.path)).toContain(`${prefix}/working-directories/open`);
      expect((posts[0]?.body as { root_path?: string }).root_path).toBe(root);
      expect(view.wrapper.get('[data-testid="folder-scope-bar"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="folder-write-readiness"]').text())
        .toContain("还没有绑定该目录的文件写入连接");

      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("先讨论一下这个目录");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      const paths = posts.map((post) => post.path);
      expect(paths).toContain(`${prefix}/assist-sessions`);
      expect(paths).toContain(`${prefix}/assist-sessions/${sessionId}/messages`);
      const create = posts.find((post) => post.path === `${prefix}/assist-sessions`)?.body as
        { command_id?: string; project_id?: string };
      const message = posts.find((post) => post.path.endsWith("/messages"))?.body as
        { command_id?: string; content?: string };
      expect(create.command_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(create.project_id).toBe(projectId);
      expect(message.content).toBe("先讨论一下这个目录");
    } finally { view.unmount(); }
  });

  it("同一目录关联多个项目时要求一次显式选择，不替用户猜作用域", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const ambiguous = readyDirectory({ status: "AMBIGUOUS", reason: "MULTIPLE_PROJECTS", association: null,
      created_resource: false, candidates: [
        { project_id: projectId, project_title: "MyProject", project_archived: false, resource_id: "res-1",
          resource_status: "ACTIVE", file_write_identity_bound: true },
        { project_id: otherProjectId, project_title: "另一个项目", project_archived: false,
          resource_id: "res-2", resource_status: "ACTIVE", file_write_identity_bound: true }] });
    const fetchMock = router({ open: (body) => response({ command_id: body.command_id,
      committed_at: "2026-10-02T00:00:00Z", result: ambiguous, links: { resource: "" } }, 200) }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      await view.wrapper.get('[data-testid="folder-manual-root"]').setValue(root);
      await flush();
      await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
      await flush();
      await flush();
      expect(view.wrapper.get('[data-testid="folder-ambiguous"]').exists()).toBe(true);
      // 作用域未定前不进入对话，也不进入任何写路径。
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);
      expect(posts.length).toBe(1);

      await view.wrapper.get(`[data-testid="collab-folder-candidate-${otherProjectId}"]`).trigger("click");
      await flush();
      expect((posts[1]?.body as { project_id?: string }).project_id).toBe(otherProjectId);
    } finally { view.unmount(); }
  });

  it("明确执行请求显示紧凑摘要并按真实命令建立任务；纯讨论不建任务", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({
      open: (body) => response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
        result: readyDirectory(), links: { resource: "" } }, 200),
      sessions: () => response({ items: [{ id: sessionId, workspace_id: workspaceId, project_id: projectId,
        task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        updated_at: "2026-10-02T00:00:00Z" }] }) }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      await view.wrapper.get('[data-testid="folder-manual-root"]').setValue(root);
      await flush();
      await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
      await flush();
      await flush();
      expect(view.wrapper.get('[data-testid="assist-draft"]').exists()).toBe(true);

      await view.wrapper.get('[data-testid="assist-draft"]').setValue("帮我把这个文件的内容改成 after");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush();
      await flush();

      const summary = view.wrapper.get('[data-testid="execution-summary"]');
      expect(summary.attributes("data-decision")).toBe("PREPARE");
      expect(summary.attributes("data-status")).toBe("READY");
      expect(view.wrapper.get('[data-testid="execution-summary-title"]').text()).toContain("改写 answer.txt");
      expect(summary.text()).toContain(root);
      expect(summary.text()).toContain("开始执行不代表已完成");
      const requested = posts.find((post) => post.path.endsWith("/execution-requests"))?.body as
        { source_message_id?: string; resource_id?: string };
      expect(requested.source_message_id).toBe("msg-1");
      expect(requested.resource_id).toBe("res-1");

      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush();
      await flush();
      expect(posts.some((post) => post.path ===
        `${prefix}/conversation-execution-requests/${requestId}/applications`)).toBe(true);
      // 建立真实 Task 后工作台切到那个任务：执行摘要不再冒充「正在写文件」。
      expect(view.wrapper.find('[data-testid="collab-page"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("关键信息缺失时只给一个聚焦澄清，不显示开始执行", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const clarify = execution({ decision: "CLARIFY", status: "CLARIFY", candidate_status: "UNAVAILABLE",
      candidate: null, questions: ["这次要改的是哪个文件？"] });
    const fetchMock = router({
      open: (body) => response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
        result: readyDirectory(), links: { resource: "" } }, 200),
      sessions: () => response({ items: [{ id: sessionId, workspace_id: workspaceId, project_id: projectId,
        task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        updated_at: "2026-10-02T00:00:00Z" }] }) }, posts);
    const original = fetchMock.getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes("/execution-requests") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { command_id: string };
        return response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
          result: clarify, links: { resource: "" } }, 202);
      }
      return original(input, init);
    }));
    const view = await mountWorkbench("/agent");
    try {
      await view.wrapper.get('[data-testid="folder-manual-root"]').setValue(root);
      await flush();
      await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
      await flush();
      await flush();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("这个功能能不能改");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush();
      await flush();
      expect(view.wrapper.get('[data-testid="execution-clarify"]').text()).toContain("哪个文件");
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
});
