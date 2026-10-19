import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { PLAN_EXECUTION_STORAGE_KEY } from "../src/lib/planExecutionPreference";
import { clickPortal, flush, folderStripAssociation, folderStripName, mountWorkbench, openFolderDialog, openWorkingDirectory, pressEscape, switchToolbarSession } from "./mountApp";

/**
 * 工作台 §18.1/§18.2 的前端反例：打开目录直达输入区、首条发送自动建会话，
 * 以及明确执行请求进入真实执行链前的紧凑摘要与聚焦澄清。
 * 这里只断言客户端行为：请求来源、命令身份和阶段显示，不替代真实 API 与真实 Windows 取证。
 */

/**
 * 桌面宿主的原生目录选择器（`isTauri()` 与 `invoke`）在 jsdom 里不存在，因此整仓默认
 * 「没有原生选择器」，其余用例继续走更换框里的手动绝对路径。只有「+ → 选择文件夹」
 * 那一条用例把 `available` 打开，用来锁住桌面宿主下「直接开文件浏览器」这条路径。
 */
const host = vi.hoisted(() => ({ available: false, picked: null as string | null, calls: 0 }));
vi.mock("../src/lib/desktopHost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/desktopHost")>();
  return { ...actual,
    nativeFolderPickerAvailable: () => host.available,
    selectWorkingDirectory: async () => { host.calls += 1; return host.picked; } };
});

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
  loseDirectoryResponse?: boolean;
  apply?: () => Response;
  executionRequests?: () => Response;
  open?: (body: Record<string, unknown>) => Response;
  messages?: () => Response;
  sessions?: () => Response;
  /** 受控故障：POST 消息在服务端已提交后丢响应。传数字则只丢前 n 次。 */
  loseMessageResponse?: boolean | number;
  /** GET /commands/:id —— 只按原 command_id 返回回执。 */
  receipt?: (commandId: string) => Response;
}

function router(routes: Routes, posts: { path: string; body: unknown }[]) {
  let directoryAttempts = 0;
  let messageCommitted = false;
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (body: unknown, status = 200) => response(body, status);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      if (path === `${prefix}/assist-sessions/${sessionId}/working-directory`) {
        if (routes.loseDirectoryResponse && directoryAttempts++ === 0) throw new TypeError("directory response lost");
        return json({
        command_id: body.command_id, committed_at: "2026-10-16T00:00:00Z",
        result: { session_id: sessionId, working_resource_id: body.resource_id, revision: "2" },
        links: { resource: "" } });
      }
      if (path === `${prefix}/working-directories/open`) return routes.open?.(body) ?? json({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z", result: readyDirectory(),
        links: { resource: "" } }, 200);
      if (path === `${prefix}/assist-sessions`) return json({ command_id: body.command_id,
        committed_at: "2026-10-02T00:00:00Z",
        result: { session_id: sessionId, workspace_id: workspaceId, project_id: projectId,
          task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
          created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" },
        links: { resource: "" } }, 201);
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        messageCommitted = true;
        const lose = routes.loseMessageResponse === true
          ? true : typeof routes.loseMessageResponse === "number" && routes.loseMessageResponse > 0;
        if (lose) {
          if (typeof routes.loseMessageResponse === "number") routes.loseMessageResponse -= 1;
          throw new TypeError("response lost after commit");
        }
        return json({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
          result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" },
          links: { resource: "" } }, 202);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/execution-requests`) return json({
        command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z", result: execution(),
        links: { resource: "" } }, 202);
      if (path === `${prefix}/conversation-execution-requests/${requestId}/applications`) return routes.apply?.() ?? json({
        command_id: "apply-1", committed_at: "2026-10-02T00:00:01Z",
        result: { request_id: requestId, status: "DELEGATED", task_id: taskId, run_id: runId, revision: "3" },
        links: { resource: "" } }, 200);
      throw new Error(`unexpected POST ${path}`);
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) {
      return routes.receipt?.(receipt[1]!) ?? json({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
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
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) {
      if (url.searchParams.get("session_id") !== sessionId) return json({ items: [] });
      return routes.executionRequests?.() ?? json({ items: messageCommitted ? [execution()] : [] });
    }
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
  it("执行准备失败后读回原任务并继续，保留目标和原请求身份", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let attempts = 0;
    vi.stubGlobal("fetch", router({
      sessions: () => response({ items: [{ id: sessionId, workspace_id: workspaceId, project_id: projectId,
        task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        updated_at: "2026-10-02T00:00:00Z" }] }),
      apply: () => {
        attempts += 1;
        return attempts === 1 ? response({ code: "INVALID_TRANSITION", detail: "未绑定 FILE_QUERY 连接" }, 409)
          : response({ result: { request_id: requestId, status: "DELEGATED", task_id: taskId,
            run_id: runId, revision: "3" }, links: {} });
      },
      executionRequests: () => response({ items: attempts === 0 ? [execution()] : [execution({
        candidate: undefined, status: attempts === 1 ? "TASK_PREPARED" : "DELEGATED",
        task_id: taskId, run_id: attempts === 1 ? null : runId, revision: "2" })] })
    }, posts));
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(root);
      await flush();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("帮我读取目录");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush();
      await flush();
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush();
      await flush();
      const summary = view.wrapper.get('[data-testid="execution-summary"]');
      expect(summary.attributes("data-status")).toBe("TASK_PREPARED");
      expect(summary.text()).toContain("FILE_QUERY");
      expect(summary.text()).toContain("改写 answer.txt");
      expect(view.wrapper.get('[data-testid="execution-start"]').text()).toContain("继续");
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush();
      await flush();
      expect(attempts).toBe(2);
      expect(posts.filter((post) => post.path.endsWith("/execution-requests"))).toHaveLength(0);
      expect(posts.filter((post) => post.path.endsWith("/applications")).map((post) => post.path))
        .toEqual(Array(2).fill(`${prefix}/conversation-execution-requests/${requestId}/applications`));
    } finally { view.unmount(); }
  });
  it("未打开目录时不进入任何写路径；打开目录后直达输入区且首条发送自动建会话", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({}, posts); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      // 页面读取本身不发任何写命令：打开目录之前不登记任何东西。
      // 作用域细条常驻在输入卡上方，没有目录可显示时那颗键写的就是动作（2026-10-18 用户指认
      // 「未选择目录」读起来像提示、看不出是按钮）。
      expect(view.wrapper.get('[data-testid="folder-scope-strip"]').exists()).toBe(true);
      expect(folderStripName()).toBe("选择工作目录");
      expect(folderStripAssociation()).toBe("未归入项目");
      // 非桌面宿主没有原生选择器：更换目录框里必须给出可用的手动路径，而不是一个死按钮。
      expect(view.wrapper.get('[data-testid="folder-scope-change"]').attributes("aria-haspopup")).toBe("dialog");
      expect(posts.length).toBe(0);

      await openWorkingDirectory(root);
      await flush();
      await flush();
      expect(posts.map((post) => post.path)).toContain(`${prefix}/working-directories/open`);
      expect((posts[0]?.body as { root_path?: string }).root_path).toBe(root);
      expect(folderStripName()).toBe("MyProject");
      expect(folderStripAssociation()).toContain("已归入项目：MyProject");
      // 写入就绪说明归更换目录浮层里的目录控件，细条只承担目录名与归属。
      await openFolderDialog();
      expect(document.querySelector('[data-testid="folder-write-readiness"]')?.textContent ?? "")
        .toContain("还没有绑定该目录的文件写入连接");
      // 选择面是锚在细条上的紧凑浮层，不是居中模态弹窗（2026-10-18 用户指令「弹窗太大了」）：
      // 没有遮罩层，面板就在细条自己的子树里，选完目录仍看得见刚更新的细条；Esc 即收。
      expect(document.querySelector(".dialog-backdrop")).toBeNull();
      expect(view.wrapper.get('[data-testid="folder-scope-strip"]')
        .find('[data-testid="folder-scope"]').exists()).toBe(true);
      await pressEscape();
      await flush();
      expect(document.querySelector('[data-testid="folder-scope"]')).toBeNull();

      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("先讨论一下这个目录");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      const paths = posts.map((post) => post.path);
      expect(paths).toContain(`${prefix}/assist-sessions`);
      const bindingPath = `${prefix}/assist-sessions/${sessionId}/working-directory`;
      expect(paths).toContain(bindingPath);
      expect(paths.indexOf(bindingPath)).toBeLessThan(paths.indexOf(`${prefix}/assist-sessions/${sessionId}/messages`));
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

  it("?dir= 种子按同一条 openFolder 打开目录、落在空对话上，首条发送才建会话并绑定", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    // 左栏目录行「＋」带进来的种子：new 是一次性的空白对话意图，dir 是那条分组里的目录路径。
    const view = await mountWorkbench(`/agent?new=seed&dir=${encodeURIComponent(root)}`);
    try {
      await flush(); await flush();
      // 挂载那一拍只发这一条目录命令，载荷就是种子路径；页面不自己登记第二份作用域。
      const opens = posts.filter((post) => post.path === `${prefix}/working-directories/open`);
      expect(opens).toHaveLength(1);
      expect((opens[0]?.body as { root_path?: string }).root_path).toBe(root);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(posts.some((post) => post.path === `${prefix}/assist-sessions`)).toBe(false);
      expect(folderStripName()).toBe("MyProject");
      expect(folderStripAssociation()).toContain("已归入项目：MyProject");

      // 目录打开后仍是既有链路：首条发送时建会话 → 先绑目录 → 再发消息。
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("从这个目录开始");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      const paths = posts.map((post) => post.path);
      expect(paths).toContain(`${prefix}/assist-sessions`);
      const bindingPath = `${prefix}/assist-sessions/${sessionId}/working-directory`;
      expect(paths).toContain(bindingPath);
      expect(paths.indexOf(bindingPath)).toBeLessThan(paths.indexOf(`${prefix}/assist-sessions/${sessionId}/messages`));
      const create = posts.find((post) => post.path === `${prefix}/assist-sessions`)?.body as
        { project_id?: string };
      expect(create.project_id).toBe(projectId);
    } finally { view.unmount(); }
  });

  it("首条目录绑定响应丢失时不发送消息，重试沿原绑定命令和原消息载荷", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ loseDirectoryResponse: true }, posts));
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(root); await flush();
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("读取目录清单");
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
      expect(posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(0);
      const firstBinding = posts.find((post) => post.path.endsWith("/working-directory"));
      expect(firstBinding).toBeDefined();
      await view.wrapper.get('[data-testid="assist-first-retry"]').trigger("click"); await flush();
      const bindings = posts.filter((post) => post.path.endsWith("/working-directory"));
      expect(bindings).toHaveLength(2);
      expect(bindings[1]?.body).toEqual(firstBinding?.body);
      expect(posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
      expect((posts.find((post) => post.path.endsWith("/messages"))?.body as { content: string }).content).toBe("读取目录清单");
    } finally { view.unmount(); }
  });

  it("目录落在另一个受管根之内时说明真实原因，不只丢一个原因码", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({ open: (body) => response({
      command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
      result: readyDirectory({ status: "NOT_READY", reason: "OVERLAPPING_OTHER_PROJECT",
        association: null, candidates: [{ project_id: otherProjectId, project_title: "另一个项目",
          project_archived: false, resource_id: "res-other", resource_status: "ACTIVE",
          file_write_identity_bound: true }],
        write_readiness: { status: "RESOURCE_BUSY", detail: "这个目录落在另一个已受管根之内或包含它。" } }),
      links: { resource: "" } }, 200) }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(root);
      await flush();
      await flush();
      // 需要再选一次作用域时更换目录浮层保持打开（候选按钮就在浮层里）；浮层挂在细条子树里，
      // 这里按 body 查是为了与弹窗形态的旧断言共用一条读法。
      const reason = document.querySelector('[data-testid="folder-not-ready"]')?.textContent ?? "";
      // 原因码本身不是解释：用户必须知道这个目录为什么不能写、接下来该做什么。
      expect(reason).toContain("另一个已受管根");
      expect(reason).not.toContain("UNKNOWN");
      expect(document.querySelector('[data-testid="folder-ambiguous"]')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("没打开目录时中栏就是可输入的对话，而不是只有两个按钮", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({}, posts); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      // 用户不必先选目录才能说话：工作空间级会话（project_id 为空）就能讨论。
      expect(view.wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="folder-scope-strip"]').exists()).toBe(true);
      // 未归属时不得给出执行入口：0051 的 project_id NOT NULL 会让请求必然失败。
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="collab-unassigned-execution-hint"]').text())
        .toContain("归入项目");

      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("还没选目录，先聊聊");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      const create = posts.find((post) => post.path === `${prefix}/assist-sessions`)?.body as
        { project_id?: string | null };
      expect(create.project_id).toBeNull();
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
      await openWorkingDirectory(root);
      await flush();
      await flush();
      expect(document.querySelector('[data-testid="folder-ambiguous"]')).not.toBeNull();
      // 作用域未定只是不能写文件，讨论仍然可用：这里只登记了目录，没有别的写命令。
      expect(view.wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="collab-unassigned-execution-hint"]').exists()).toBe(true);
      expect(posts.length).toBe(1);

      await clickPortal(`collab-folder-candidate-${otherProjectId}`);
      await flush();
      expect((posts[1]?.body as { project_id?: string }).project_id).toBe(otherProjectId);
    } finally { view.unmount(); }
  });

  /* 「+ → 选择工作文件夹 → 选择文件夹」（2026-10-18 用户指令：这一步直接开文件浏览器，
     不再隔一层更换目录框）。选定之后仍是同一条守卫与同一条 OpenWorkingDirectory 入口。 */
  it("桌面宿主：「+」里的「选择文件夹」直接开原生选择器，取消不发命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    host.available = true; host.picked = null; host.calls = 0;
    const view = await mountWorkbench("/agent");
    /** 一级行执行后会收起两层（保留草稿），因此每次重新选都要把菜单再开一遍。 */
    const openFolderSub = async () => {
      await view.wrapper.get('[data-testid="assist-attach"]').trigger("click");
      await flush();
      await view.wrapper.get('[data-testid="assist-attach-folder"]').trigger("click");
      await flush();
      await view.wrapper.get('[data-testid="assist-attach-folder-pick"]').trigger("click");
      await flush();
    };
    try {
      // 取消选择：不发任何目录命令，也不退回更换目录框——用户只是没选。
      await openFolderSub();
      expect(host.calls).toBe(1);
      expect(posts).toHaveLength(0);
      expect(document.querySelector('[data-testid="folder-manual-root"]')).toBeNull();
      // 选定后直接登记目录，细条同步到那个目录；更换框全程没有打开过。
      host.picked = root;
      await openFolderSub();
      await flush();
      expect(host.calls).toBe(2);
      expect(posts.map((post) => post.path)).toContain(`${prefix}/working-directories/open`);
      expect((posts[0]?.body as { root_path?: string }).root_path).toBe(root);
      expect(folderStripName()).toBe("MyProject");
      expect(document.querySelector('[data-testid="folder-scope"]')).toBeNull();
    } finally {
      host.available = false; host.picked = null;
      view.unmount();
    }
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
      await openWorkingDirectory(root);
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
      // 此刻还没有任何具体正文：确认文案不得暗示「你正在确认一份写好的改动」。
      // 工作台 §18.4.1 的规则，方案 B 下正文由 Run 内模型读过真实文件后决定。
      const startLabel = view.wrapper.get('[data-testid="execution-start"]').text();
      expect(startLabel).not.toContain("按这个执行");
      expect(startLabel).toContain("按这个目标执行");
      expect(summary.text()).toContain("文件内容会在执行时读取后决定");
      const requested = posts.find((post) => post.path.endsWith("/execution-requests"))?.body as
        { source_message_id?: string; resource_id?: string };
      expect(requested).toBeUndefined();

      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush();
      await flush();
      expect(posts.some((post) => post.path ===
        `${prefix}/conversation-execution-requests/${requestId}/applications`)).toBe(true);
      // 建立真实 Task 后工作台切到那个任务：执行摘要不再冒充「正在写文件」。
      expect(view.wrapper.find('[data-testid="collab-page"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("服务端标记就绪的明确文件请求自动应用原候选并保留原会话反馈", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let applications = 0;
    const fetchMock = router({
      open: (body) => response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
        result: readyDirectory(), links: { resource: "" } }, 200),
      sessions: () => response({ items: [{ id: sessionId, workspace_id: workspaceId, project_id: projectId,
        task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        updated_at: "2026-10-02T00:00:00Z" }] }),
      messages: () => {
        const sent = posts.find((post) => post.path.endsWith("/messages"))?.body as
          { content?: string } | undefined;
        return response({ items: sent === undefined ? [] : [{ id: "msg-1", session_id: sessionId,
          seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS", content: sent.content ?? "",
          sources: [], cancel_requested: false, error_code: null, provider_error_kind: null,
          created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
          usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          skill: null }] });
      },
      apply: () => {
        applications += 1;
        return response({ command_id: "apply-1", committed_at: "2026-10-02T00:00:01Z",
          result: { request_id: requestId, status: "DELEGATED", task_id: taskId,
            run_id: runId, revision: "3" }, links: { resource: "" } });
      },
      executionRequests: () => response({ items: posts.some((post) => post.path.endsWith("/messages"))
        ? [execution({ auto_start: true,
          ...(applications > 0 ? { candidate: undefined, status: "DELEGATED", task_id: taskId,
            run_id: runId, revision: "3" } : {}) })]
        : [] })
    }, posts);
    const original = fetchMock.getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(`/runs/${runId}/tool-calls`)) {
        return response({ run_id: runId, run_status: "RUNNING", wait_reason: null, rounds: [] });
      }
      if (path.endsWith(`/runs/${runId}/tool-call-previews`)) {
        return response({ run_id: runId, previews: [] });
      }
      return original(input, init);
    }));
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(root);
      await flush(); await flush();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("把 luna-modify.txt 改成确认后的内容");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      expect(applications).toBe(1);
      expect(posts.filter((post) => post.path ===
        `${prefix}/conversation-execution-requests/${requestId}/applications`)).toHaveLength(1);
      const message = posts.find((post) => post.path.endsWith("/messages"))?.body as
        { content?: string };
      expect(message.content).toBe("把 luna-modify.txt 改成确认后的内容");
      expect(view.wrapper.get('[data-testid="execution-summary"]').text()).toContain("这次执行没有调用工具");
      expect(view.wrapper.text()).toContain("把 luna-modify.txt 改成确认后的内容");
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("本设备选择人工确认时就绪候选不自动应用，点击后按原请求进入执行", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let applications = 0;
    localStorage.setItem(PLAN_EXECUTION_STORAGE_KEY, "CONFIRM");
    const fetchMock = router({
      open: (body) => response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
        result: readyDirectory(), links: { resource: "" } }, 200),
      sessions: () => response({ items: [{ id: sessionId, workspace_id: workspaceId, project_id: projectId,
        task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        updated_at: "2026-10-02T00:00:00Z" }] }),
      messages: () => {
        const sent = posts.find((post) => post.path.endsWith("/messages"))?.body as
          { content?: string } | undefined;
        return response({ items: sent === undefined ? [] : [{ id: "msg-1", session_id: sessionId,
          seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS", content: sent.content ?? "",
          sources: [], cancel_requested: false, error_code: null, provider_error_kind: null,
          created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
          usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
          skill: null }] });
      },
      apply: () => {
        applications += 1;
        return response({ command_id: "apply-1", committed_at: "2026-10-02T00:00:01Z",
          result: { request_id: requestId, status: "DELEGATED", task_id: taskId,
            run_id: runId, revision: "3" }, links: { resource: "" } });
      },
      executionRequests: () => response({ items: posts.some((post) => post.path.endsWith("/messages"))
        ? [execution({ auto_start: true,
          ...(applications > 0 ? { candidate: undefined, status: "DELEGATED", task_id: taskId,
            run_id: runId, revision: "3" } : {}) })]
        : [] })
    }, posts);
    const original = fetchMock.getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(`/runs/${runId}/tool-calls`)) {
        return response({ run_id: runId, run_status: "RUNNING", wait_reason: null, rounds: [] });
      }
      if (path.endsWith(`/runs/${runId}/tool-call-previews`)) {
        return response({ run_id: runId, previews: [] });
      }
      return original(input, init);
    }));
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(root);
      await flush(); await flush();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("把 luna-modify.txt 改成确认后的内容");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      // 候选已就绪，但本设备选了人工确认：不自动应用，「按这个目标执行」留在摘要里。
      expect(applications).toBe(0);
      expect(view.wrapper.get('[data-testid="execution-summary"]').attributes("data-auto-start")).toBe("false");
      expect(view.wrapper.get('[data-testid="execution-start"]').text()).toContain("按这个目标执行");
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush(); await flush();

      expect(applications).toBe(1);
      expect(posts.filter((post) => post.path ===
        `${prefix}/conversation-execution-requests/${requestId}/applications`)).toHaveLength(1);
      // 人工确认成功后按 §18.4 自动切到原 Task，原会话仍可回到对话。
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
      if (String(input).includes("/conversation-execution-requests?") && !init?.method) {
        return response({ items: [clarify] });
      }
      return original(input, init);
    }));
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(root);
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

  // 以下三条是 2026-10-03 独立验收的反例：首条发送的未决命令、草稿保护与执行解释。
  // 「已提交但响应丢失」由受控故障模拟，明确不是服务端真实失败。

  async function openFolderAndType(view: { wrapper: { get(s: string): { setValue(v: string): Promise<void>;
    trigger(e: string): Promise<void> } } }, text: string) {
    await openWorkingDirectory(root);
    await flush();
    await flush();
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue(text);
    await flush();
  }

  it("反例 P1：建会话成功但首条消息响应丢失时保留原命令与原载荷，可按原 ID 核对", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const fetchMock = router({
      loseMessageResponse: true,
      receipt: (commandId) => response({ command_id: commandId, command_type: "RequestAssistMessage",
        committed_at: "2026-10-02T00:00:05Z",
        result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" } })
    }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      await openFolderAndType(view, "帮我把这个文件的内容改成 after");
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      await flush();

      const messagePost = posts.find((post) => post.path.endsWith("/messages"));
      const commandId = (messagePost?.body as { command_id?: string }).command_id;
      expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);

      // 部分成功事实必须可见：会话已建、消息待核对，且带原 command_id 的回执入口可达。
      const pending = view.wrapper.get('[data-testid="assist-first-pending"]');
      expect(pending.text()).toContain(commandId!);
      expect(pending.text()).toContain("会话已创建");
      expect(pending.text()).toContain("消息结果待核对");
      expect(view.wrapper.get('[data-testid="assist-first-receipt"]').exists()).toBe(true);
      // 未核对前不得把传输失败说成业务失败，也不得宣称已完成。
      expect(view.wrapper.text()).not.toContain("已完成");

      // 用户继续修改输入后，核对与重试仍按原载荷、原 ID 走。
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("后来改写的别的内容");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-receipt"]').trigger("click");
      await flush();
      await flush();

      expect(posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
      const retried = posts.filter((post) => post.path.endsWith("/messages"));
      expect(retried.every((post) => (post.body as { command_id?: string }).command_id === commandId)).toBe(true);
      expect((retried[retried.length - 1]?.body as { content?: string }).content)
        .toBe("帮我把这个文件的内容改成 after");
      expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("反例 P1：同 ID 重试按原载荷恢复，且回执与原命令不匹配时不冒充已完成", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    // 只丢第一次响应：重试时服务端接受同一条命令并返回真实 user_message_id。
    const fetchMock = router({ loseMessageResponse: 1 }, posts);
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      await openFolderAndType(view, "帮我把这个文件的内容改成 after");
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      await flush();

      const commandId = (posts.find((post) => post.path.endsWith("/messages"))?.body as { command_id?: string }).command_id;
      expect(view.wrapper.get('[data-testid="assist-first-retry"]').exists()).toBe(true);

      // 用户此后改写了输入；重试仍必须走原命令 ID 与原载荷。
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("后来改写的别的内容");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-retry"]').trigger("click");
      await flush();
      await flush();

      expect(posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
      const messages = posts.filter((post) => post.path.endsWith("/messages"));
      expect(messages).toHaveLength(2);
      expect(messages.every((post) => (post.body as { command_id?: string }).command_id === commandId)).toBe(true);
      expect((messages[1]?.body as { content?: string }).content).toBe("帮我把这个文件的内容改成 after");
      // 重试成功即完成解释，未决状态清空，且没有多余的会话创建。
      expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    } finally { view.unmount(); }

    // 回执与原命令不匹配时必须停在未决状态，不猜结果、不宣称已完成。
    const posts2: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ loseMessageResponse: true }, posts2));
    const other = await mountWorkbench("/agent");
    try {
      await openFolderAndType(other, "帮我把这个文件的内容改成 after");
      await other.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      await flush();
      const otherCommandId = (posts2.find((post) => post.path.endsWith("/messages"))?.body as { command_id?: string }).command_id;
      // 回执声称属于别的会话：不得当作本条消息已送达。
      vi.stubGlobal("fetch", router({ receipt: () => response({ command_id: otherCommandId,
        command_type: "RequestAssistMessage", committed_at: "2026-10-02T00:00:05Z",
        result: { session_id: "00000000-0000-4000-8000-000000000000", user_message_id: "msg-x" } }) }, posts2));
      await other.wrapper.get('[data-testid="assist-first-receipt"]').trigger("click");
      await flush();
      await flush();

      expect(other.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(true);
      expect(other.wrapper.text()).not.toContain("已完成");
    } finally { other.unmount(); }
  });

  it("反例 P2：首条草稿未发送时离页被拦截，保留后原文仍在，显式放弃才清除", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/agent");
    try {
      await openFolderAndType(view, "还没发送的首条草稿");
      await view.wrapper.get('nav[aria-label="主导航"]').get('[href="/projects"]').trigger("click");
      await flush();

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-label")).toBe("保留未保存的修改");
      const keep = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("保留并继续编辑"));
      keep?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
      expect(view.router.currentRoute.value.path).toBe("/agent");
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
        .toBe("还没发送的首条草稿");
      // 草稿保护不发任何业务命令，也不能用自动发送代替。
      expect(posts.some((post) => post.path.endsWith("/messages"))).toBe(false);

      await view.wrapper.get('nav[aria-label="主导航"]').get('[href="/projects"]').trigger("click");
      await flush();
      const discard = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("丢弃草稿并离开"));
      discard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush(80);
      expect(view.router.currentRoute.value.path).toBe("/projects");
      expect(posts.some((post) => post.path === `${prefix}/assist-sessions`)).toBe(false);
    } finally { view.unmount(); }
  });

  it("反例 P3：首条明确执行输入同样走执行解释，纯讨论不进入执行链", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/agent");
    try {
      await openFolderAndType(view, "帮我把这个文件的内容改成 after");
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      await flush();

      // 解释依据必须是消息回执里的真实 user message id 与确切目录资源，不能由前端关键词判断。
      const requested = posts.find((post) => post.path.endsWith("/execution-requests"))?.body as
        { source_message_id?: string; resource_id?: string } | undefined;
      expect(requested).toBeUndefined();
      expect(posts.some((post) => post.path.endsWith("/working-directory"))).toBe(true);
      // 解释仍由服务端决定；候选就绪也只是等待人工确认，不因首条发送自动建立 Task。
      expect(posts.some((post) => post.path.includes("/applications"))).toBe(false);
    } finally { view.unmount(); }

    // 纯讨论同样走解释链（与普通发送一致），但服务端判定 DISCUSS，不建立任务。
    const discussPosts: { path: string; body: unknown }[] = [];
    const discussMock = router({}, discussPosts);
    const original = discussMock.getMockImplementation()!;
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/execution-requests") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { command_id: string };
        discussPosts.push({ path, body });
        return response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
          result: execution({ decision: "DISCUSS", status: "DISCUSSED", candidate_status: "UNAVAILABLE",
            candidate: null, questions: [] }), links: { resource: "" } }, 202);
      }
      return original(input, init);
    }));
    const discuss = await mountWorkbench("/agent");
    try {
      await openFolderAndType(discuss, "先讨论一下这个目录");
      await discuss.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush();
      await flush();
      expect(discussPosts.some((post) => post.path.endsWith("/execution-requests"))).toBe(false);
      expect(discussPosts.some((post) => post.path.includes("/applications"))).toBe(false);
    } finally { discuss.unmount(); }
  });

  /**
   * 整改提示词第 6 节的四项接续任务（五项实际失败反例）。
   * 共同点是首条过程跨越「协作页按会话 key 重新挂载 AssistView」这一次重挂载：
   * 只有命令身份、在途阶段、首条原文与解释结果同属一个 Owner，事实才不会留在旧实例。
   */
  describe("整改后独立复验的接续反例", () => {
    /**
     * 会话列表在创建前必须为空、创建后才返回确切会话：
     * 否则首条输入区根本不会渲染，下面的重挂载也不会真的发生。
     */
    function createdSessions(created: { value: boolean }): () => Response {
      return () => response({ items: created.value ? [{ id: sessionId, workspace_id: workspaceId,
        project_id: projectId, task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
        created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" }] : [] });
    }

    it.each([false, true])("切换会话不沿用首条执行候选（解释迟到：%s）", async (delayed) => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      const secondSessionId = "88888888-8888-4888-8888-888888888888";
      let created = false; let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const fetchMock = router({ sessions: () => response({ items: created ? [sessionId, secondSessionId].map(id => ({
        id, workspace_id: workspaceId, project_id: projectId, task_id: null,
        title: id === sessionId ? "原会话" : "其他会话", status: "ACTIVE", revision: "1",
        created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" })) : [] }) }, posts);
      const original = fetchMock.getMockImplementation()!;
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "POST" && path === `${prefix}/assist-sessions`) created = true;
        if (delayed && init?.method === "POST" && path.endsWith("/execution-requests")) await gate;
        return original(input, init);
      }));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "帮我把这个文件的内容改成 after");
        await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush(); await flush();
        if (!delayed) expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(true);
        await switchToolbarSession(secondSessionId); await flush();
        release(); await flush(); await flush();
        expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
        expect(view.wrapper.text()).not.toContain("改写 answer.txt");
        expect(posts.some(post => post.path.includes("/applications"))).toBe(false);
      } finally { release(); view.unmount(); }
    });

    it("反例 A1：换目录必须先经过未保存保护，保留后原文不丢；未决消息时不得换目录", async () => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      vi.stubGlobal("fetch", router({}, posts));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "还没发送的首条草稿");
        const opened = posts.filter((post) => post.path.endsWith("/working-directories/open")).length;
        // 直接请求换到另一个目录：必须先弹保护，且在用户决定前不得发出 OpenWorkingDirectory。
        await openWorkingDirectory("D:\\Develop\\OtherProject");
        await flush();

        expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("未发送的内容");
        expect(posts.filter((post) => post.path.endsWith("/working-directories/open"))).toHaveLength(opened);

        const keep = Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "留在当前工作区");
        keep?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush(80);
        // 保留即不换目录，原文完整；目录命令不因「仅选择」被重复发出。
        expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
          .toBe("还没发送的首条草稿");
        expect(posts.filter((post) => post.path.endsWith("/working-directories/open"))).toHaveLength(opened);
      } finally { view.unmount(); }

      // 未决消息时换目录：守卫按「原命令待核对」处理，不允许静默换作用域。
      const pendingPosts: { path: string; body: unknown }[] = [];
      vi.stubGlobal("fetch", router({ loseMessageResponse: true }, pendingPosts));
      const pending = await mountWorkbench("/agent");
      try {
        await openFolderAndType(pending, "帮我把这个文件的内容改成 after");
        await pending.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
        await flush();
        await flush();
        const before = pendingPosts.filter((post) => post.path.endsWith("/working-directories/open")).length;

        await openWorkingDirectory("D:\\Develop\\OtherProject");
        await flush();

        expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("命令结果待核对");
        expect(pendingPosts.filter((post) => post.path.endsWith("/working-directories/open"))).toHaveLength(before);
      } finally { pending.unmount(); }
    });

    it("反例 A2：未决消息的解释绑定原资源，换目录后不改用新资源", async () => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      // 首条消息响应丢失；回执可查。目录作用域在解释前换成 res-2。
      const created = { value: false };
      const fetchMock = router({
        sessions: createdSessions(created),
        loseMessageResponse: true,
        receipt: (commandId) => response({ command_id: commandId, command_type: "RequestAssistMessage",
          committed_at: "2026-10-02T00:00:05Z",
          result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" } }),
      }, posts);
      const original = fetchMock.getMockImplementation()!;
      let scopeResourceId = "res-1";
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "POST" && path.endsWith("/working-directories/open")) {
          const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          posts.push({ path, body });
          return response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
            result: readyDirectory({ association: { project_id: projectId, project_title: "OtherProject",
              project_archived: false, resource_id: scopeResourceId, resource_status: "ACTIVE",
              file_write_identity_bound: true }, display_name: "OtherProject" }),
            links: { resource: "" } }, 200);
        }
        if (init?.method === "POST" && path === `${prefix}/assist-sessions`) {
          const result = await original(input, init);
          created.value = true;
          return result;
        }
        return original(input, init);
      }));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "帮我把这个文件的内容改成 after");
        await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
        await flush();
        await flush();
        const messageCommandId = (posts.find((post) => post.path.endsWith("/messages"))?.body as
          { command_id?: string }).command_id;
        expect(view.wrapper.get('[data-testid="assist-first-pending"]').exists()).toBe(true);

        // 未决消息时换目录被守卫拦住：作用域不变，也就无从把解释指向别的资源。
        scopeResourceId = "res-2";
        const opened = posts.filter((post) => post.path.endsWith("/working-directories/open")).length;
        await openWorkingDirectory("D:\\Develop\\OtherProject");
        await flush();
        expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("命令结果待核对");
        expect(posts.filter((post) => post.path.endsWith("/working-directories/open"))).toHaveLength(opened);
        const stay = Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "留在当前工作区");
        stay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush(80);

        // 核对成功后解释必须用该命令产生时绑定的 res-1，而不是任何当前作用域取值。
        await view.wrapper.get('[data-testid="assist-first-receipt"]').trigger("click");
        await flush();
        await flush();

        const requested = posts.find((post) => post.path.endsWith("/execution-requests"))?.body as
          { resource_id?: string } | undefined;
        expect(requested).toBeUndefined();
        expect(posts.some((post) => post.path.endsWith("/working-directory") && (post.body as { resource_id: string }).resource_id === "res-1")).toBe(true);
        expect(posts.filter((post) => post.path.endsWith("/messages")))
          .toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.objectContaining(
            { command_id: messageCommandId }) })]));
      } finally { view.unmount(); }
    });

    it("反例 B：首条解释成功后摘要交接到重挂载后的当前会话", async () => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      // 动态会话列表：创建后返回确切会话，触发真实的按会话重挂载。
      const created = { value: false };
      const fetchMock = router({ sessions: createdSessions(created) }, posts);
      const original = fetchMock.getMockImplementation()!;
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "POST" && path === `${prefix}/assist-sessions`) {
          const result = await original(input, init);
          created.value = true;
          return result;
        }
        // 解释响应延迟，让重挂载先发生，摘要必须仍落在当前实例。
        if (init?.method === "POST" && path.endsWith("/execution-requests")) {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return original(input, init);
      }));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "帮我把这个文件的内容改成 after");
        await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
        await flush();
        await flush(120);

        expect(posts.filter((post) => post.path.endsWith("/execution-requests"))).toHaveLength(0);
        // 建会话只发生一次；解释只发生一次。
        expect(posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
        // PREPARE 摘要必须出现在当前会话面板，而不是只断言 POST 数量。
        expect(view.wrapper.find('[data-testid="execution-summary"]').exists()).toBe(true);
        expect(view.wrapper.text()).toContain("改写 answer.txt");
        // 解释只是候选，仍须人工确认，不自动建立 Task。
        expect(posts.some((post) => post.path.includes("/applications"))).toBe(false);
      } finally { view.unmount(); }
    });

    it("反例 C：先核对回执再收到原响应，同一原消息只解释一次；迟到失败不复活已清空的 pending", async () => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      let releaseOriginal: (() => void) | null = null;
      const releaseLate: { run: () => void } = { run: () => { releaseOriginal?.(); } };
      const created = { value: false };
      const fetchMock = router({
        sessions: createdSessions(created),
        receipt: (commandId) => response({ command_id: commandId, command_type: "RequestAssistMessage",
          committed_at: "2026-10-02T00:00:05Z",
          result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" } }),
      }, posts);
      const original = fetchMock.getMockImplementation()!;
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        // 受控故障：原消息请求已提交但响应被扣住，先让回执核对完成。
        if (init?.method === "POST" && path.includes("/assist-sessions/") && path.endsWith("/messages")) {
          const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          posts.push({ path, body });
          await new Promise<void>((resolve) => { releaseOriginal = resolve; });
          return response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
            result: { session_id: sessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" },
            links: { resource: "" } }, 202);
        }
        if (init?.method === "POST" && path === `${prefix}/assist-sessions`) {
          const result = await original(input, init);
          created.value = true;
          return result;
        }
        return original(input, init);
      }));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "帮我把这个文件的内容改成 after");
        await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
        await flush();
        await flush();

        // 原响应仍在途：新实例必须已经能从共享 Owner 看到这条未决命令。
        expect(view.wrapper.get('[data-testid="assist-first-pending"]').exists()).toBe(true);
        await view.wrapper.get('[data-testid="assist-first-receipt"]').trigger("click");
        await flush();
        await flush();
        const afterCheck = posts.filter((post) => post.path.endsWith("/execution-requests")).length;
        expect(afterCheck).toBe(0);

        // 现在放行迟到响应：不得第二次解释，也不得复活已清空的 pending。
        releaseLate.run();
        await flush(120);
        await flush();

        expect(posts.filter((post) => post.path.endsWith("/execution-requests"))).toHaveLength(afterCheck);
        expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
      } finally { view.unmount(); }
    });

    it("反例 D：创建响应丢失后按原回执恢复确切会话，并续发原首条载荷", async () => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      let createCommandIdSeen: string | null = null;
      const created = { value: false };
      const fetchMock = router({ sessions: createdSessions(created) }, posts);
      const original = fetchMock.getMockImplementation()!;
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        // 受控故障：创建命令已在服务端提交，但响应丢失。
        if (init?.method === "POST" && path === `${prefix}/assist-sessions` && createCommandIdSeen === null) {
          const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          posts.push({ path, body });
          createCommandIdSeen = String(body.command_id);
          throw new TypeError("response lost after commit");
        }
        if (path.endsWith(`/commands/${createCommandIdSeen}`)) {
          // 会话确已在服务端存在：从这一刻起动态列表才返回它。
          created.value = true;
          return response({ command_id: createCommandIdSeen, command_type: "CreateAssistSession",
            committed_at: "2026-10-02T00:00:05Z",
            result: { session_id: sessionId, workspace_id: workspaceId, project_id: projectId,
              task_id: null, title: "关于MyProject", status: "ACTIVE", revision: "1",
              created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" } });
        }
        return original(input, init);
      }));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "帮我把这个文件的内容改成 after");
        await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
        await flush();
        await flush();

        // 创建未决且首条尚未发出：不得凭空出现空白普通会话。
        expect(createCommandIdSeen).toMatch(/^[0-9a-f-]{36}$/u);
        expect(posts.some((post) => post.path.endsWith("/messages"))).toBe(false);
        const checkCreate = Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === "查询创建回执");
        expect(checkCreate).toBeDefined();

        checkCreate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
        await flush(120);

        // 恢复后必须续发原首条原文：不重建会话、不混入后来输入、不换命令身份。
        const messages = posts.filter((post) => post.path.endsWith("/messages"));
        expect(messages).toHaveLength(1);
        expect((messages[0]?.body as { content?: string }).content).toBe("帮我把这个文件的内容改成 after");
        expect(posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
        expect(posts.filter((post) => post.path.endsWith("/execution-requests"))).toHaveLength(0);
        expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
      } finally { view.unmount(); }
    });
  });
});
