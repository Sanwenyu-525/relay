import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "../tests/mountApp";

/**
 * 同会话接续：先做普通讨论（workspace-level 会话，project_id 为空），再选择目录并把它归入项目。
 *
 * 断言的是客户端行为本身：归属走真实服务端身份与回执核对，迟到响应只更新它原本那次绑定，
 * 归属失败如实呈现服务端拒绝并保留用户输入；归属不等于授权，不产生执行或提案。
 * 真实 Windows 取证与真实 API 事务仍由后端测试覆盖。
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
    remember: true, created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...over };
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
  /** 自定义归属命令响应；缺省为成功。 */
  binding?: (body: Record<string, unknown>) => Response;
  /** 受控故障：归属命令已提交但响应丢失。 */
  loseBindingResponse?: boolean;
  /** 归属命令在响应前先等这个闸，用来验证在途/迟到场景。 */
  bindingGate?: Promise<void>;
  /** GET /commands/:id —— 只按原 command_id 返回回执。 */
  receipt?: (commandId: string) => Response;
  messages?: () => Response;
  workspaceSessions?: () => Response;
}

interface Harness {
  readonly posts: { readonly path: string; readonly body: Record<string, unknown> }[];
  readonly gets: string[];
  readonly created: { value: boolean };
  readonly bound: { value: boolean; projectId: string | null };
}

function router(routes: Routes, harness: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      harness.posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) return routes.open?.(body) ?? response({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z", result: readyDirectory(),
        links: { resource: "" } }, 200);
      if (path === `${prefix}/assist-sessions`) {
        harness.created.value = true; harness.bound.value = false; harness.bound.projectId = null;
        return response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
          result: { ...session(), session_id: sessionId, project_id: null, task_id: null },
          links: { resource: "" } }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
        result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" },
        links: { resource: "" } }, 202);
      if (path === `${prefix}/assist-sessions/${sessionId}/binding`) {
        if (routes.bindingGate) await routes.bindingGate;
        if (routes.loseBindingResponse) throw new TypeError("response lost after commit");
        if (routes.binding) return routes.binding(body);
        harness.bound.value = true; harness.bound.projectId = String(body.project_id);
        return response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:01Z",
          result: { session_id: sessionId, project_id: body.project_id, revision: "2" },
          links: { resource: "" } }, 200);
      }
      throw new Error(`unexpected POST ${path}`);
    }
    harness.gets.push(path);
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return routes.receipt?.(receipt[1]!) ?? response({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    if (path === `${prefix}/assist-sessions`) {
      const projectFilter = url.searchParams.get("project_id");
      if (projectFilter !== null) return response({ items: harness.bound.value && harness.bound.projectId === projectFilter
        ? [session({ project_id: projectFilter })] : [] });
      // 工作空间级列表默认为空：首条消息建会话后才返回它，与真实服务端一致。
      return routes.workspaceSessions?.() ?? response({ items: harness.created.value && !harness.bound.value ? [session()] : [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response(
      session({ project_id: harness.bound.value ? harness.bound.projectId : null }));
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return routes.messages?.() ?? response({ items: [message()] });
    if (path === `${prefix}/conversation-execution-requests`) return response({ items: [] });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/assistant-profiles`) return response({ items: [] });
    if (path === `${prefix}/projects/${projectId}`) return response(project());
    if (path === `${prefix}/projects`) return response({ items: [{ ...project(), archive_status: "ACTIVE",
      phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z" }], next_cursor: null });
    if (path === `${prefix}/projects/${projectId}/state`) return response({ project_id: projectId, revision: "1",
      phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
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
  return { posts: [], gets: [], created: { value: false }, bound: { value: false, projectId: null } };
}

async function startDiscussion(view: Awaited<ReturnType<typeof mountWorkbench>>, text: string) {
  await view.wrapper.get('[data-testid="assist-first-draft"]').setValue(text);
  await flush();
  await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
  await flush();
  await flush();
}

async function openFolder(view: Awaited<ReturnType<typeof mountWorkbench>>) {
  await view.wrapper.get('[data-testid="folder-manual-root"]').setValue(root);
  await flush();
  await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
  await flush();
  await flush();
}

function bindingPosts(h: Harness) {
  return h.posts.filter((post) => post.path === `${prefix}/assist-sessions/${sessionId}/binding`);
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("普通讨论归入项目（同会话接续）", () => {
  it("打开目录把既有普通讨论归入项目：只改归属，不新建会话、不产生执行或提案", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const h = harness();
    vi.stubGlobal("fetch", router({}, h));
    const view = await mountWorkbench("/agent");
    try {
      await startDiscussion(view, "先讨论一下这个目录");
      // 首条讨论建了一条 project_id 为空的会话；此刻还没有任何归属命令。
      expect(bindingPosts(h)).toHaveLength(0);

      await openFolder(view);

      // 归属命令带真实会话身份与目录解析出的确切项目，回执只核对原 command_id。
      const binding = bindingPosts(h);
      expect(binding).toHaveLength(1);
      expect((binding[0]!.body as { command_id?: string }).command_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(binding[0]!.body.project_id).toBe(projectId);
      expect(view.wrapper.get('[data-testid="collab-binding"]').attributes("data-status")).toBe("CONFIRMED");
      expect(view.wrapper.get('[data-testid="collab-binding"]').attributes("data-session")).toBe(sessionId);
      // 归属不等于授权：不进入执行链、不产生提案、不新建第二个会话。
      expect(h.posts.some((post) => post.path.endsWith("/execution-requests"))).toBe(false);
      expect(h.posts.some((post) => post.path.includes("/applications"))).toBe(false);
      expect(h.posts.some((post) => post.path === `${prefix}/assist-proposals`)).toBe(false);
      expect(h.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
      // 既有历史续读：仍按原会话读取消息，中文原文保留。
      expect(h.gets).toContain(`${prefix}/assist-sessions/${sessionId}/messages`);
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("先讨论一下这个目录");
    } finally { view.unmount(); }
  });

  it("当前没有可绑定的既有会话时只登记目录，不虚构归属", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const h = harness();
    vi.stubGlobal("fetch", router({ workspaceSessions: () => response({ items: [] }) }, h));
    const view = await mountWorkbench("/agent");
    try {
      // 用户尚未发首条：没有会话可接续，打开目录只做本地目录选择。
      await openFolder(view);
      expect(bindingPosts(h)).toHaveLength(0);
      expect(view.wrapper.find('[data-testid="collab-binding"]').exists()).toBe(false);
      // 只读了目录列表，没有按会话身份读取，也就没有虚构「已归属」。
      expect(h.gets).toContain(`${prefix}/assist-sessions`);
      expect(h.gets).not.toContain(`${prefix}/assist-sessions/${sessionId}`);
    } finally { view.unmount(); }
  });

  it.each([[409, "INVALID_TRANSITION", "这段讨论还有消息在途，等它结束再归入项目。"],
    [403, "PERMISSION_DENIED", "请求来源未被允许。"],
    [404, "RESOURCE_NOT_FOUND", "Assist session在当前作用域中不可见或不存在。"]])(
    "归属被服务端拒绝（%i）时如实分类，并保留在途时输入的中文草稿", async (status, code, detail) => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const h = harness();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.stubGlobal("fetch", router({
        bindingGate: gate,
        binding: () => response({ code, detail }, status) }, h));
      const view = await mountWorkbench("/agent");
      try {
        await startDiscussion(view, "先讨论一下这个目录");
        // 归属命令在途：用户继续在输入区写下中文草稿。
        await openFolder(view);
        await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("这段中文草稿不能丢");
        await flush();
        release();
        await flush();
        await flush();

        const notice = view.wrapper.get('[data-testid="collab-binding"]');
        expect(notice.attributes("data-status")).toBe("FAILED");
        expect(notice.text()).toContain(String(status));
        expect(notice.text()).toContain("未归入项目");
        expect(view.wrapper.find('[data-testid="assist-transcript"]').exists()).toBe(true);
        // 归属失败不改写会话：原会话仍按项目为空呈现，草稿原样保留。
        expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
          .toBe("这段中文草稿不能丢");
        expect(bindingPosts(h)).toHaveLength(1);
        expect(h.posts.some((post) => post.path.endsWith("/execution-requests"))).toBe(false);
      } finally { release(); view.unmount(); }
    });
});

describe("归属命令的结果未知与迟到响应", () => {
  it("响应丢失时按原 command_id 核对，不换新 ID 重试", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const h = harness();
    vi.stubGlobal("fetch", router({
      loseBindingResponse: true,
      receipt: (commandId) => response({ command_id: commandId, command_type: "BindAssistSessionProject",
        committed_at: "2026-10-02T00:00:02Z",
        result: { session_id: sessionId, project_id: projectId, revision: "2" } }) }, h));
    const view = await mountWorkbench("/agent");
    try {
      await startDiscussion(view, "先讨论一下这个目录");
      await openFolder(view);

      const commandId = (bindingPosts(h)[0]!.body as { command_id?: string }).command_id;
      expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
      const unknown = view.wrapper.get('[data-testid="collab-binding"]');
      expect(unknown.attributes("data-status")).toBe("UNKNOWN");
      expect(unknown.text()).toContain(commandId!);
      expect(view.wrapper.get('[data-testid="collab-binding-receipt"]').exists()).toBe(true);

      await view.wrapper.get('[data-testid="collab-binding-receipt"]').trigger("click");
      await flush();
      await flush();

      // 只按原 command_id 查询，且没有换新 ID 重发归属命令。
      expect(h.gets).toContain(`${prefix}/commands/${commandId}`);
      expect(bindingPosts(h)).toHaveLength(1);
      expect(view.wrapper.get('[data-testid="collab-binding"]').attributes("data-status")).toBe("CONFIRMED");
    } finally { view.unmount(); }
  });

  it("归属命令在途时离页不产生重复归属", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", router({ bindingGate: gate }, h));
    const view = await mountWorkbench("/agent");
    try {
      await startDiscussion(view, "先讨论一下这个目录");
      await openFolder(view);
      expect(bindingPosts(h)).toHaveLength(1);
      expect(view.wrapper.get('[data-testid="collab-binding"]').attributes("data-status")).toBe("PENDING");

      await view.wrapper.get('nav[aria-label="主导航"]').get('[href="/projects"]').trigger("click");
      await flush();
      expect(view.router.currentRoute.value.path).toBe("/projects");
      release();
      await flush();
      await flush();
      // 离开后原命令仍只发了一次，没有换新 ID 重发。
      expect(bindingPosts(h)).toHaveLength(1);
    } finally { release(); view.unmount(); }
  });

  it("迟到的归属成功不把界面拉回旧会话或旧项目", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", router({ bindingGate: gate }, h));
    const view = await mountWorkbench("/agent");
    try {
      await startDiscussion(view, "先讨论一下这个目录");
      await openFolder(view);
      expect(bindingPosts(h)).toHaveLength(1);

      // 归属仍在途时用户显式新开一段讨论：不沿用旧会话，也不停在旧项目。
      await view.wrapper.get('[data-testid="collab-new-conversation"]').trigger("click");
      await flush();
      release();
      await flush();
      await flush();

      expect(view.router.currentRoute.value.query.new).toBeTruthy();
      // 当前是用户新开的这段讨论：输入区是空白首条，旧会话的原文没有被拉回来。
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value).toBe("");
      expect(view.wrapper.text()).not.toContain("先讨论一下这个目录");
      expect(bindingPosts(h)).toHaveLength(1);
    } finally { release(); view.unmount(); }
  });

  /**
   * 最常见的「普通讨论开始」其实不是发首条，而是打开 /agent 时应用自动续上最近一条
   * 未归属会话。此前 AssistView 只在用户显式切换时才把会话回报给协作页，这条路径下
   * 协作页始终不知道当前会话，归属命令就永远发不出去。
   */
  it("自动续上既有未归属会话（未发新消息）后打开目录，也把这段讨论归入项目", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const h = harness();
    vi.stubGlobal("fetch", router({ workspaceSessions: () => response({ items: [session()] }) }, h));
    const view = await mountWorkbench("/agent");
    try {
      await flush(); await flush();
      // 用户只是打开协作页续上最近一段讨论，没有发新消息。
      expect(view.wrapper.text()).toContain("先讨论一下这个目录");

      await openFolder(view);

      const binding = bindingPosts(h);
      expect(binding).toHaveLength(1);
      expect(binding[0]!.body.project_id).toBe(projectId);
      expect(view.wrapper.get('[data-testid="collab-binding"]').attributes("data-status")).toBe("CONFIRMED");
      // 归属后按项目身份重读同一会话，历史仍可读，没有新建第二个会话。
      expect(h.gets).toContain(`${prefix}/assist-sessions/${sessionId}/messages`);
      expect(h.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    } finally { view.unmount(); }
  });
});
