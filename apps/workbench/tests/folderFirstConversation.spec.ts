import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
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
  /** GET 单条会话（`?include_context=true`）：只在用例显式提供时命中，缺省维持原「未预期请求」行为。 */
  sessionRead?: () => Response;
  /** 目录绑定命令落账时调用：用例据此让随后的会话读回带上绑定事实（绑定前／后两种投影）。 */
  onDirectoryBound?: () => void;
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
        routes.onDirectoryBound?.();
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
    if (path === `${prefix}/default-working-directory`) return json({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null,
      revision: "0" });
    if (path === `${prefix}/projects/${projectId}`) return json(project());
    if (path === `${prefix}/projects/${projectId}/state`) return json({ project_id: projectId, revision: "1",
      phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/projects`) return json({ items: [{ ...project(), archive_status: "ACTIVE",
      phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z" }], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) return routes.sessions?.() ?? json({ items: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}` && routes.sessionRead) return routes.sessionRead();
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
      executionRequests: () => response({ items: attempts === 0
        ? [execution({ auto_start: false, status: "FAILED",
          questions: ["本项目还没有绑定该目录的 FILE_QUERY 连接；请在同页补齐后再执行。"] })]
        : [execution({ candidate: undefined, auto_start: false,
          status: attempts === 1 ? "TASK_PREPARED" : "DELEGATED",
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
      // 服务端自动推进已失败并把具体原因写回原请求：本页照实显示，不猜原因。
      const summary = view.wrapper.get('[data-testid="execution-summary"]');
      expect(summary.attributes("data-status")).toBe("FAILED");
      expect(summary.text()).toContain("FILE_QUERY");
      expect(summary.text()).toContain("改写 answer.txt");
      expect(view.wrapper.get('[data-testid="execution-start"]').text()).toBe("继续原请求");
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush();
      await flush();
      // 继续后仍有失败：停在 TASK_PREPARED，这个阶段由服务端继续接续，
      // 因此界面不再保留按钮——本页只负责把「已经推进到哪一步」如实说出来。
      expect(attempts).toBe(1);
      expect(view.wrapper.get('[data-testid="execution-summary"]').attributes("data-status"))
        .toBe("TASK_PREPARED");
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
      expect(posts.filter((post) => post.path.endsWith("/execution-requests"))).toHaveLength(0);
      expect(posts.filter((post) => post.path.endsWith("/applications")).map((post) => post.path))
        .toEqual([`${prefix}/conversation-execution-requests/${requestId}/applications`]);
    } finally { view.unmount(); }
  });
  /*
   * R3-02（2026-10-21 走查）：同一处目录在两个界面上读出结论。输入卡上方细条已经写出
   * 目录名与「已归入项目」，顶栏却仍说「尚未绑定目录」——那不是后端绑错，而是顶栏的目录
   * 这一项只读会话（`session.context.workingDirectory`），首条对话此刻合法地还没有会话。
   * 这里锁的是「两个界面不许互相否定」，并且修法不能靠提前建会话或放宽权限来抹掉措辞。
   */
  it("首条对话里顶栏与细条读同一个目录：写「已选，发送后绑定」，不写「尚未绑定目录」", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench(`/agent?new=r3-02&dir=${encodeURIComponent(root)}`);
    try {
      await flush(); await flush();
      expect(folderStripName()).toBe("MyProject");
      const chip = view.wrapper.get('[data-testid="collab-current-directory"]');
      const text = chip.text();
      // 细条已选中的目录必须同样出现在顶栏，且说清「还没绑到会话上」。
      expect(text).toContain("MyProject");
      expect(text).toContain("发送后绑定");
      expect(text).not.toContain("尚未绑定目录");
      expect(chip.attributes("aria-label")).toContain(root);
      // 措辞修好靠的是呈现同一份事实，不是提前建会话：这一条链路仍没有建会话的 POST。
      expect(posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    } finally { view.unmount(); }
  });

  /*
   * 2026-10-23 用户截图「目录不匹配」：左栏把当前会话列在「未绑定目录」组下，输入卡上方
   * 的细条却写着目录名与「已归入项目」——同一段讨论两个结论。核对服务端事实后确认
   * working_resource_id 早已落账（USER_PICKED），错在左栏的读数停在「建会话后、绑定前」
   * 那一瞬：绑定命令由 AssistView 直接发，成功后同一会话身份的再次上报被发布去重，
   * 再没人叫左栏重读。这里锁两件事：绑定确认后左栏按服务端事实重新分组；顶栏的会话
   * 目录也不再说「未绑定目录」。修法不提前建会话、不动服务端契约。
   */
  it("首条消息绑定目录后，左栏与顶栏按服务端事实重分组", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    // 绑定前／后两种会话投影：绑定前上下文里没有目录（working_directory 为 null），
    // 这正是左栏当年卡住的那一份读数——与服务端 listSessionContexts 的形状一致。
    let directoryBound = false;
    const sessionProjection = () => ({ id: sessionId, workspace_id: workspaceId, project_id: projectId,
      task_id: null, title: "关于MyProject", status: "ACTIVE", revision: directoryBound ? "2" : "1",
      working_resource_id: directoryBound ? "res-1" : null,
      context: { project_goals: [], working_directory: directoryBound
        ? { resource_id: "res-1", canonical_root: root, source: "USER_PICKED" } : null },
      created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" });
    vi.stubGlobal("fetch",router({
      onDirectoryBound: () => { directoryBound = true; },
      sessions: () => response({ items: [sessionProjection()] }),
      sessionRead: () => response(sessionProjection())
    }, posts));
    const view = await mountWorkbench(`/agent?new=rail-scope&dir=${encodeURIComponent(root)}`);
    try {
      await flush(); await flush();
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("读取这个目录");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush(80); await flush(); await flush(80); await flush();
      // 目录绑定随首条消息按原 command_id 落账；之后左栏必须重读这条会话。
      expect(posts.some((post) => post.path === `${prefix}/assist-sessions/${sessionId}/working-directory`)).toBe(true);
      expect(directoryBound).toBe(true);
      const row = document.querySelector(`[data-testid="recent-work-${sessionId}"]`);
      expect(row).not.toBeNull();
      const group = Array.from(
        document.querySelectorAll('[data-testid="recent-work-directories"] .recent-work-group'))
        .find((element) => element.contains(row));
      expect(group?.querySelector(".recent-work-group-title")?.textContent?.trim()).toBe("MyProject");
      // 顶栏的会话目录读同一份事实：不再停在「未绑定目录」。
      const chip = document.querySelector('[data-testid="collab-current-directory"]');
      expect(chip?.textContent).toContain("MyProject");
      expect(chip?.textContent).not.toContain("未绑定目录");
    } finally { view.unmount(); }
  });

  it("目录没打开成功时顶栏跟着读「未就绪」，不与细条的告警互相否定", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({
      open: (body) => response({ command_id: body.command_id, committed_at: "2026-10-02T00:00:00Z",
        result: readyDirectory({ status: "NOT_READY", reason: "目录暂时无法读取。" }), links: { resource: "" } })
    }, posts));
    const view = await mountWorkbench(`/agent?new=r3-02-bad&dir=${encodeURIComponent(root)}`);
    try {
      await flush(); await flush();
      const text = view.wrapper.get('[data-testid="collab-current-directory"]').text();
      expect(text).toContain("未就绪");
      expect(text).not.toContain("发送后绑定");
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
    // 扣住 open 响应：目录在途期间首条输入器已经在屏上，发送键按 `creationPending` 禁用；
    // 目录一回来换成项目作用域，但两拍都是同一张输入器，不再整页换成「正在打开目录…」。
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const base = router({}, posts);
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.endsWith("/working-directories/open")) await openGate;
      return base(input, init);
    }));
    // 左栏目录行「＋」带进来的种子：new 是一次性的空白对话意图，dir 是那条分组里的目录路径。
    const view = await mountWorkbench(`/agent?new=seed&dir=${encodeURIComponent(root)}`);
    try {
      // 目录在途：首条输入器直接在屏上，不再整页换成「正在打开目录…」；
      // 细条如实说正在打开，发送键等作用域落定，正文可以先写。
      expect(document.querySelector('[data-testid="collab-directory-pending"]')).toBeNull();
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(folderStripName()).toContain("正在打开目录");
      const pendingSend = view.wrapper.get('[data-testid="assist-first-send"]');
      expect(pendingSend.attributes("disabled")).toBeDefined();
      expect(pendingSend.attributes("title")).toContain("正在打开目录");
      // 在途期间写的草稿属于同一条首条过程，换作用域重挂载后必须原样保留。
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("从这个目录开始");
      releaseOpen();
      await flush(); await flush();
      // 挂载那一拍只发这一条目录命令，载荷就是种子路径；页面不自己登记第二份作用域。
      const opens = posts.filter((post) => post.path === `${prefix}/working-directories/open`);
      expect(opens).toHaveLength(1);
      expect((opens[0]?.body as { root_path?: string }).root_path).toBe(root);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
        .toBe("从这个目录开始");
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBeUndefined();
      expect(document.querySelector('[data-testid="collab-directory-pending"]')).toBeNull();
      expect(posts.some((post) => post.path === `${prefix}/assist-sessions`)).toBe(false);
      expect(folderStripName()).toBe("MyProject");
      expect(folderStripAssociation()).toContain("已归入项目：MyProject");

      // 目录打开后仍是既有链路：首条发送时建会话 → 先绑目录 → 再发消息。
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
    } finally { releaseOpen(); view.unmount(); }
  });

  it("目录已打开、项目事实仍在读时不退回整页核对态，首条照常可写可发", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let releaseProject!: () => void;
    const projectGate = new Promise<void>((resolve) => { releaseProject = resolve; });
    const base = router({}, posts);
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if ((init?.method ?? "GET") === "GET" && path === `${prefix}/projects/${projectId}`) await projectGate;
      return base(input, init);
    }));
    const view = await mountWorkbench(`/agent?new=seed&dir=${encodeURIComponent(root)}`);
    try {
      await flush();
      // 目录回执已到、项目详情与目标核对还没回来：首条输入器保持原样，不换整页核对态。
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(folderStripName()).toBe("MyProject");
      expect(document.body.textContent).not.toContain("正在核对对话目标与会话");
      expect(document.body.textContent).not.toContain("正在刷新目标与会话");
      expect(document.body.textContent).not.toContain("正在打开目录…");
      // 目录回执里的项目事实足够建会话：不因项目详情在途按住发送键，也不丢草稿。
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("项目事实稍后读回");
      await flush();
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBeUndefined();
      releaseProject();
      await flush(); await flush();
      expect(document.body.textContent).not.toContain("正在核对对话目标与会话");
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
        .toBe("项目事实稍后读回");
    } finally { releaseProject(); view.unmount(); }
  });

  it("目录打开无响应时不把用户困在途屏：慢阈值后给取消出口，取消只摘种子且不重发命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    const base = router({}, posts);
    let releaseOpen!: () => void;
    let openCalls = 0;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.endsWith("/working-directories/open")) { openCalls += 1; await openGate; }
      return base(input, init);
    }));
    const view = await mountWorkbench(`/agent?new=seed&dir=${encodeURIComponent(root)}`);
    try {
      // 输入器不因目录在途消失；快路径不加出口（本机 API 通常一瞬，不添视觉噪声）。
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(view.wrapper.find('[data-testid="collab-directory-slow-cancel"]').exists()).toBe(false);
      await flush(4200);
      expect(view.wrapper.find('[data-testid="collab-directory-slow"]').exists()).toBe(true);
      await view.wrapper.get('[data-testid="collab-directory-slow-cancel"]').trigger("click");
      await flush(); await flush();
      // 取消只摘 `?dir=` 种子：回到同一条新对话，面板就绪、输入区可见；不重发 open 命令。
      expect(view.router.currentRoute.value.query.dir).toBeUndefined();
      expect(view.router.currentRoute.value.query.new).toBe("seed");
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(openCalls).toBe(1);
    } finally { releaseOpen(); view.unmount(); }
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

  /* 「+」里不再有目录入口（2026-10-19 撤出弹层）：目录的常驻 Owner 是目录细条，
     「选择文件夹」归细条的「更换目录」按钮——细条在忙时禁用，绝不绕过禁用态。 */
  it("「+」没有目录行；目录选择只走常驻细条", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    host.available = true; host.picked = null; host.calls = 0;
    const view = await mountWorkbench("/agent");
    try {
      await view.wrapper.get('[data-testid="assist-attach"]').trigger("click");
      await flush();
      expect(document.querySelector('[data-testid="assist-attach-folder"]')).toBeNull();
      expect(document.querySelector('[data-testid="assist-attach-folder-pick"]')).toBeNull();
      expect(document.querySelector('[data-testid="folder-scope-strip"]')).not.toBeNull();
      expect(host.calls).toBe(0);
      expect(posts).toHaveLength(0);
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
      // 服务端推进：本页不提供第二次确认，也不暗示「已经写完」。
      expect(summary.text()).toContain("不需要再确认一次");
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
      const requested = posts.find((post) => post.path.endsWith("/execution-requests"))?.body as
        { source_message_id?: string; resource_id?: string };
      expect(requested).toBeUndefined();
      expect(posts.some((post) => post.path.includes("/applications"))).toBe(false);
    } finally { view.unmount(); }
  });

  it("候选就绪时本页不代为推进，只如实显示阶段并保留原会话", async () => {
    // 2026-10-20 第二轮：推进责任在服务端 Worker。这条用例锁的是「前端不再发
    // applications」——此前它由本设备的 effect 触发，页面关掉就会把一条已授权的
    // 请求留在 READY。
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
        ? [execution({ auto_start: true })] : [] })
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

      // 本页没有代推进：候选就绪只表达阶段，不再需要用户为同一件事点第二次。
      expect(applications).toBe(0);
      expect(posts.filter((post) => post.path ===
        `${prefix}/conversation-execution-requests/${requestId}/applications`)).toHaveLength(0);
      expect(view.wrapper.get('[data-testid="execution-summary-stage"]').text()).toBe("正在准备执行");
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
      const message = posts.find((post) => post.path.endsWith("/messages"))?.body as
        { content?: string };
      expect(message.content).toBe("把 luna-modify.txt 改成确认后的内容");
      expect(view.wrapper.get('[data-testid="assist-draft"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("自动推进失败时按原请求继续，成功后切到执行详情", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let applications = 0;
    const reason = "本项目还没有绑定该目录的 FILE_WRITE 连接；请在同页补齐后再执行。";
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
        ? [execution(applications > 0
          ? { auto_start: false, candidate: undefined, status: "DELEGATED", task_id: taskId,
            run_id: runId, revision: "3" }
          : { auto_start: false, status: "FAILED", questions: [reason] })] : [] })
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

      // 服务端已写回具体原因：界面照实呈现，而不是让用户猜或重新描述目标。
      expect(view.wrapper.get('[data-testid="execution-summary-failure"]').text()).toBe(reason);
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      await flush(); await flush();

      expect(applications).toBe(1);
      expect(posts.filter((post) => post.path ===
        `${prefix}/conversation-execution-requests/${requestId}/applications`)).toHaveLength(1);
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

  it("反例 P2：首条草稿不再拦离页，离开再回来原文仍在；全程不发送任何命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench("/agent");
    try {
      await openFolderAndType(view, "还没发送的首条草稿");
      await view.wrapper.get('nav[aria-label="主导航"]').get('[href="/projects"]').trigger("click");
      await flush(120);

      // 不再弹「保留未保存的修改」：直接进入项目页。
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(view.router.currentRoute.value.path).toBe("/projects");

      // 回到 /agent：首条草稿留在本机，原文仍在；离页与回页都不发业务命令。
      await view.router.push("/agent");
      await flush(120);
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
        .toBe("还没发送的首条草稿");
      expect(posts.some((post) => post.path.endsWith("/messages"))).toBe(false);
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
        // 候选就绪时摘要出现，但本页没有任何推进按钮（推进在服务端）。
        if (!delayed) expect(view.wrapper.find('[data-testid="execution-summary"]').exists()).toBe(true);
        await switchToolbarSession(secondSessionId); await flush();
        release(); await flush(); await flush();
        expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
        expect(view.wrapper.text()).not.toContain("改写 answer.txt");
        expect(posts.some(post => post.path.includes("/applications"))).toBe(false);
      } finally { release(); view.unmount(); }
    });

    it("反例 A1：换目录不再询问丢弃，草稿留在原作用域；未决消息时仍不得换目录", async () => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: { path: string; body: unknown }[] = [];
      vi.stubGlobal("fetch", router({}, posts));
      const view = await mountWorkbench("/agent");
      try {
        await openFolderAndType(view, "还没发送的首条草稿");
        const opened = posts.filter((post) => post.path.endsWith("/working-directories/open")).length;
        // 直接请求换到另一个目录：不再弹确认框，目录命令直接发出。
        await openWorkingDirectory("D:\\Develop\\OtherProject");
        await flush(120);

        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(posts.filter((post) => post.path.endsWith("/working-directories/open"))).toHaveLength(opened + 1);
        // 草稿属于原作用域，换目录后仍留在输入区，不需要用户先「保留」一次。
        expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
          .toBe("还没发送的首条草稿");
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

/**
 * 默认工作目录继承与来源呈现（0117 / 工作台 §18.1.5 / 运行架构 §2.8）。
 *
 * 反例口径：
 * - 新普通会话的作用域由**服务端**决定（创建事务继承默认目录），前端只按回执 session_id
 *   读回上下文，不补第二次目录绑定，也不把默认目录所属项目说成用户的选择；
 * - 2026-10-20 用户指令「只显示目录名」：细条与顶栏都不再追加来源后缀，任何 source
 *   都不产生可见文案；来源只留在 `data-source` 上供核对，缺字段（历史未知）不得被读成
 *   用户的选择；
 * - 空态说明句如实反映设置状态：默认生效时说会用它，未设置时只承诺普通讨论。
 * 真实 Windows/WebView2 与真实 Provider 不在这一层，只归统一验收表。
 */
describe("默认工作目录继承与目录名呈现", () => {
  const inheritedProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const inheritedSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const defaultRoot = "D://Develop//DefaultWork";
  const defaultProjection = { resource_id: "res-default", canonical_root: defaultRoot,
    display_name: "DefaultWork", write_tier: "READ_ONLY", default_write_tier: null,
    status: "READY", reason: null, revision: "2" };

  function sessionRow(source?: "WORKSPACE_DEFAULT" | "USER_PICKED" | null) {
    return { id: inheritedSessionId, workspace_id: workspaceId, project_id: inheritedProjectId,
      task_id: null, title: "从默认目录开始", status: "ACTIVE", revision: "1",
      working_resource_id: "res-default", conversation_mode: "AGENT", remember: true,
      created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z",
      context: { project_goals: [], working_directory: { resource_id: "res-default",
        canonical_root: defaultRoot, ...(source === undefined ? {} : { source }) } } };
  }

  function serve(options: { source?: "WORKSPACE_DEFAULT" | "USER_PICKED" | null;
    projectNotFound?: boolean }) {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const detail = sessionRow(options.source);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); const path = url.pathname;
      const json = (body: unknown, status = 200) => response(body, status);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === `${prefix}/assist-sessions`) return json({ command_id: body.command_id,
          committed_at: "2026-10-19T00:00:00Z",
          result: { session_id: inheritedSessionId, workspace_id: workspaceId,
            project_id: inheritedProjectId, task_id: null, title: "从默认目录开始",
            status: "ACTIVE", revision: "1", created_at: "2026-10-19T00:00:00Z",
            updated_at: "2026-10-19T00:00:00Z" },
          links: { resource: "" } }, 201);
        if (path === `${prefix}/assist-sessions/${inheritedSessionId}/messages`) return json({
          command_id: body.command_id, committed_at: "2026-10-19T00:00:00Z",
          result: { session_id: inheritedSessionId, user_message_id: "msg-1", assistant_message_id: "msg-2" },
          links: { resource: "" } }, 202);
        if (path.endsWith("/working-directory")) return json({ command_id: body.command_id,
          committed_at: "2026-10-19T00:00:00Z",
          result: { session_id: inheritedSessionId, working_resource_id: body.resource_id, revision: "2" },
          links: { resource: "" } });
        throw new Error(`unexpected POST ${path}`);
      }
      if (path.endsWith("/default-working-directory")) return json(defaultProjection);
      if (path.endsWith("/attention/interventions")) return json({ items: [] });
      if (path === `${prefix}/model-port`) return json({ provider: "fake", configured: false,
        model: null, base_url: null, max_call_tokens: null });
      if (path === `${prefix}/model-port/verification`) return json({ current_config_fingerprint: null,
        last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
      if (path === `${prefix}/skill-definitions`) return json({ items: [] });
      if (path === `${prefix}/assistant-profiles`) return json({ items: [] });
      if (path === `${prefix}/assist-proposals`) return json({ items: [] });
      if (path.startsWith(`${prefix}/conversation-execution-requests`)) return json({ items: [] });
      if (path === `${prefix}/assist-sessions/${inheritedSessionId}/messages`) return json({ items: [] });
      if (path === `${prefix}/assist-sessions/${inheritedSessionId}/model-selection`) return json({ selection: null });
      if (path === `${prefix}/assist-sessions/${inheritedSessionId}/conversation-diff`) return json({
        available: false, reason: "NO_BASELINE" });
      if (path === `${prefix}/assist-sessions/${inheritedSessionId}`) return json(detail);
      if (path === `${prefix}/assist-sessions`) return json({ items: [detail] });
      if (path === `${prefix}/projects/${inheritedProjectId}`) {
        if (options.projectNotFound) return json({ code: "RESOURCE_NOT_FOUND", detail: "no project" }, 404);
        return json(project({ id: inheritedProjectId, title: "DefaultProject" }));
      }
      if (path.startsWith(`${prefix}/search`)) return json({ items: [], next_cursor: null });
      if (path === `${prefix}/tasks`) return json({ items: [], next_cursor: null });
      throw new Error(`unexpected GET ${path}`);
    });
    return { fetchMock, posts };
  }

  it("新普通会话按服务端继承落在默认目录：不补绑定，细条与顶栏只显示目录名", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
    const { fetchMock, posts } = serve({ source: "WORKSPACE_DEFAULT" });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    try {
      await flush();
      // 空态如实说明默认目录会用于新会话，同时保留「不需要先创建项目、任务」。
      const welcome = view.wrapper.get('[data-testid="assist-first-welcome"]').text();
      expect(welcome).toContain("不需要先创建项目、任务");
      expect(welcome).toContain("默认目录「DefaultWork」");

      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("从默认目录开始");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush(); await flush(); await flush();

      // 建会话只带用户明确的目标（这里没有），项目由服务端在创建事务里补。
      const create = posts.find((post) => post.path === `${prefix}/assist-sessions`)?.body;
      expect(create?.project_id).toBeNull();
      // 默认作用域在创建时落定：前端不补第二次目录绑定。
      expect(posts.filter((post) => post.path.endsWith("/working-directory"))).toHaveLength(0);
      // 首条消息仍按原会话发送。
      expect(posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(1);

      // 细条只显示目录名 + 归属，不再追加来源后缀（2026-10-20 用户指令「只显示目录名」）。
      expect(folderStripName()).toBe("DefaultWork");
      expect(folderStripAssociation()).toContain("已归入项目：DefaultProject");
      expect(document.querySelector('[data-testid="folder-scope-source"]')).toBeNull();
      // 悬停目录名浮出绝对路径（2026-10-20 用户要求），移开即收起。
      await view.wrapper.get('[data-testid="folder-scope-change"]').trigger("mouseover");
      await flush();
      expect(document.querySelector('[data-testid="path-tooltip"]')?.textContent).toBe(defaultRoot);
      await view.wrapper.get('[data-testid="folder-scope-change"]').trigger("mouseout");
      await flush();
      expect(document.querySelector('[data-testid="path-tooltip"]')).toBeNull();
      // 顶栏同一说法：来源只留在 data-source 上供核对，不进可访问名称与可见文案。
      const toolbar = view.wrapper.get('[data-testid="collab-current-directory"]');
      expect(toolbar.attributes("data-source")).toBe("WORKSPACE_DEFAULT");
      expect(toolbar.attributes("aria-label")).toContain("DefaultWork");
      expect(toolbar.attributes("aria-label")).not.toContain("默认目录");
      expect(view.wrapper.find('[data-testid="collab-current-directory-source"]').exists()).toBe(false);
      // 目录名可能重名或被省略：完整路径在浮层顶部可核对（2026-10-20 用户要求）。
      await view.wrapper.get('[data-testid="folder-scope-change"]').trigger("click");
      await flush();
      expect(document.querySelector('[data-testid="folder-scope-path"]')?.textContent).toBe(defaultRoot);
    } finally { view.unmount(); }
  });

  it("用户当场选过的目录同样只显示目录名：USER_PICKED 与缺字段都不编造来源", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
    const picked = serve({ source: "USER_PICKED" });
    vi.stubGlobal("fetch", picked.fetchMock);
    const view = await mountWorkbench(`/agent?session=${inheritedSessionId}`);
    try {
      await flush(); await flush();
      expect(folderStripName()).toBe("DefaultWork");
      expect(document.querySelector('[data-testid="folder-scope-source"]')).toBeNull();
      const toolbar = view.wrapper.get('[data-testid="collab-current-directory"]');
      expect(toolbar.attributes("data-source")).toBe("USER_PICKED");
      expect(toolbar.attributes("aria-label")).not.toContain("默认目录");
      expect(view.wrapper.find('[data-testid="collab-current-directory-source"]').exists()).toBe(false);
    } finally { view.unmount(); }

    // 旧服务端缺 source：历史未知，同样不标——不能把缺字段读成用户的选择。
    const legacy = serve({ source: undefined });
    vi.stubGlobal("fetch", legacy.fetchMock);
    const reopened = await mountWorkbench(`/agent?session=${inheritedSessionId}`);
    try {
      await flush(); await flush();
      expect(document.querySelector('[data-testid="folder-scope-source"]')).toBeNull();
      expect(reopened.wrapper.get('[data-testid="collab-current-directory"]').attributes("data-source"))
        .toBe("UNKNOWN");
    } finally { reopened.unmount(); }
  });

  it("默认目录失效时空态说明不会使用它，读取前仍要求选目录", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
    const { fetchMock } = serve({ source: "WORKSPACE_DEFAULT" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/default-working-directory") && init?.method !== "POST") {
        return response({ ...defaultProjection, status: "UNAVAILABLE", reason: "PROJECT_ARCHIVED" });
      }
      return fetchMock(input, init);
    }));
    const view = await mountWorkbench("/agent");
    try {
      await flush();
      const welcome = view.wrapper.get('[data-testid="assist-first-welcome"]').text();
      expect(welcome).toContain("当前不可用");
      expect(welcome).toContain("读取文件前需要选择目录");
      expect(welcome).not.toContain("会使用设置里的默认目录");
    } finally { view.unmount(); }
  });
});
