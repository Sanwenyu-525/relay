import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, folderStripName, mountWorkbench, openWorkingDirectory, toolbarSessionTitle } from "./mountApp";

/**
 * 已有会话里切换工作目录（P0-D，2026-11-04）。
 *
 * 产品行为变了：输入卡下方的目录选择器不再是「把当前会话改绑到另一个目录」，而是
 * 「切换工作上下文 → 进入该目录的新对话」。这里锁四件事：
 *   1. 旧会话不收到任何归属/目录绑定写命令；
 *   2. 新对话有独立的导航身份（`?new=` + `?dir=` + `?source_session=`），
 *      同一次选择只发一条 OpenWorkingDirectory；
 *   3. 选中的就是当前会话已绑定的同一目录时保留原页面，不乱建新对话；
 *   4. 目录打不开时留在旧会话并显示可行动的原因。
 *
 * 真实 API、数据库身份与首条消息建会话/绑目录由浏览器验收覆盖；这里只锁客户端行为。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
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
    created_project: false, created_resource: false, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" },
    ...over };
}

function session(over: Record<string, unknown> = {}) {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "关于这个目录", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, assistant_profile_revision: null, assistant_role: null,
    remember: true, working_resource_id: null,
    created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...over };
}

function message(over: Record<string, unknown> = {}) {
  return { id: "msg-1", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS",
    content: "先讨论一下这个目录", sources: [], cancel_requested: false, error_code: null,
    provider_error_kind: null, created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
    skill: null, ...over };
}

interface Routes {
  open?: (body: Record<string, unknown>) => Response;
  messages?: () => Response;
  workspaceSessions?: () => Response;
}

interface Harness {
  readonly posts: { readonly path: string; readonly body: Record<string, unknown> }[];
  readonly gets: string[];
  /** 会话行上已绑定的受管目录；null = 未绑定。 */
  readonly directory: { value: string | null };
}

function router(routes: Routes, harness: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const contextOf = () => url.searchParams.get("include_context") === "true"
      ? { context: { project_goals: [], working_directory: harness.directory.value === null ? null
        : { resource_id: harness.directory.value, canonical_root: root } } } : {};
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      harness.posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) return routes.open?.(body) ?? response({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z", result: readyDirectory(),
        links: { resource: "" } }, 200);
      throw new Error(`unexpected POST ${path}`);
    }
    harness.gets.push(path);
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return response({ code: "COMMAND_NOT_FOUND", detail: "命令回执不存在" }, 404);
    if (path === `${prefix}/assist-sessions`) {
      const projectFilter = url.searchParams.get("project_id");
      if (projectFilter !== null) return response({ items: [] });
      return routes.workspaceSessions?.() ?? response({ items: [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}`) {
      return response(session({ working_resource_id: harness.directory.value, ...contextOf() }));
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return routes.messages?.() ?? response({ items: [message()] });
    }
    if (path === `${prefix}/conversation-execution-requests`) return response({ items: [] });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/assistant-profiles`) return response({ items: [] });
    if (path === `${prefix}/projects/${projectId}`) return response(project());
    if (path === `${prefix}/projects`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false, model: null,
      base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null, last: null,
      matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/search`)) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return response({ items: [], next_cursor: null });
    throw new Error(`unexpected GET ${path}`);
  });
}

function harness(): Harness {
  return { posts: [], gets: [], directory: { value: null } };
}

async function mountSession(h: Harness, overrides: Partial<Routes> = {}) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", router({ ...overrides,
    workspaceSessions: overrides.workspaceSessions
      ?? (() => response({ items: [session({ working_resource_id: h.directory.value })] })) }, h));
  const view = await mountWorkbench(`/agent?session=${sessionId}`);
  await flush(); await flush(); await flush();
  return view;
}

function openPosts(h: Harness) {
  return h.posts.filter((post) => post.path === `${prefix}/working-directories/open`);
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("已有会话里切换工作目录：进入新对话，不改写旧会话", () => {
  it("选另一个目录：跳到该目录的欢迎页，旧会话不收到归属/目录绑定写命令", async () => {
    const h = harness();
    const view = await mountSession(h);
    try {
      expect(toolbarSessionTitle()).toBe("关于这个目录");
      await openWorkingDirectory(root);
      await flush(); await flush();

      const query = view.router.currentRoute.value.query;
      expect(query.new).toBeTruthy();
      expect(query.dir).toBe(root);
      expect(query.source_session).toBe(sessionId);
      // 欢迎页已经有新对话自己的输入器与目录事实。
      expect(document.querySelector('[data-testid="assist-first-draft"]')).not.toBeNull();
      expect(folderStripName()).toBe("MyProject");
      // 旧会话一个字都不改：没有归属命令，也没有目录绑定命令。
      expect(h.posts.filter((post) => post.path.endsWith("/binding"))).toHaveLength(0);
      expect(h.posts.filter((post) => post.path.endsWith("/working-directory"))).toHaveLength(0);
      // 同一次目录选择只发一条 OpenWorkingDirectory：交接页不重复打开。
      expect(openPosts(h)).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("选中当前会话已绑定的同一目录：保留当前页面，不重复发打开命令", async () => {
    const h = harness();
    h.directory.value = "res-1";
    const view = await mountSession(h, {
      workspaceSessions: () => response({ items: [session({ working_resource_id: "res-1" })] }) });
    try {
      // 等作用域读回，确保比较的是服务端已确认的绑定，而不是占位种子。
      for (let i = 0; i < 10; i++) {
        const label = document.querySelector('[data-testid="collab-current-directory"]')?.getAttribute("aria-label") ?? "";
        if (label.includes(root)) break;
        await flush();
      }
      const before = { path: view.router.currentRoute.value.path,
        query: { ...view.router.currentRoute.value.query } };
      await openWorkingDirectory(root);
      await flush(); await flush();
      expect({ path: view.router.currentRoute.value.path,
        query: { ...view.router.currentRoute.value.query } }).toEqual(before);
      expect(toolbarSessionTitle()).toBe("关于这个目录");
      expect(openPosts(h)).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("目录打不开：留在旧会话并显示可行动的原因", async () => {
    const h = harness();
    const view = await mountSession(h, {
      open: () => response({ code: "RESOURCE_NOT_FOUND", detail: "目录不存在或已移动。" }, 404) });
    try {
      await openWorkingDirectory(root);
      await flush(); await flush();
      expect(view.router.currentRoute.value.query.session).toBe(sessionId);
      expect(toolbarSessionTitle()).toBe("关于这个目录");
      const error = document.querySelector('[data-testid="folder-error"]')?.textContent ?? "";
      expect(error).toContain("无法打开这个工作目录");
      expect(error).not.toBe("");
      expect(openPosts(h)).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("切到新对话后返回旧会话：原消息与原目录身份不变，草稿仍按旧会话恢复", async () => {
    const h = harness();
    const view = await mountSession(h);
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      await draft.setValue("旧会话里还没发出去的文字");
      await flush();
      await openWorkingDirectory(root);
      await flush(); await flush();

      await view.router.push(`/agent?session=${sessionId}`);
      await flush(); await flush(); await flush();
      expect(toolbarSessionTitle()).toBe("关于这个目录");
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("先讨论一下这个目录");
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
        .toBe("旧会话里还没发出去的文字");
      expect(h.directory.value).toBeNull();
    } finally { view.unmount(); }
  });
});
