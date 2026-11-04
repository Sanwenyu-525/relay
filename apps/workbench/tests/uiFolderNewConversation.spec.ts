import { describe, expect, it, vi } from "vitest";
import { activateRelayConnection } from "../src/lib/relayConnection";
import { rememberWorkingDirectory } from "../src/lib/recentWorkingDirectories";
import { flush, folderStripAssociation, folderStripName, mountWorkbench, openFolderDialog, openWorkingDirectory } from "./mountApp";

/**
 * UI-FOLDER-01：目录选择与新会话生命周期。
 *
 * 这一组反例锁的是**导航意图**本身，不是渲染结果：
 *   * 欢迎页选目录 → 该目录下的空白新会话，不恢复该项目任何历史会话；
 *   * 目录命令只改点击那一刻在屏上的那条会话，不按回执到达时的「当前会话」重猜；
 *   * 从已有会话新建 → 继承那条会话服务端确认过的目录，不继承本机最近目录。
 *
 * 夹具刻意让项目 P 里有一条历史会话 S_P、工作区里有一条未归属会话 S_W：
 * 只有两者同时存在，「目录命令改错了谁」和「自动选中了谁」才可分辨。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const projectSessionId = "77777777-7777-4777-8777-777777777777";
const workspaceSessionId = "66666666-6666-4666-8666-666666666666";
const createdSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const rootA = "D:\\Develop\\ProjectA";
const rootB = "D:\\Develop\\ProjectB";

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
}

function session(over: Record<string, unknown> = {}) {
  return { id: projectSessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "项目里的历史会话", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, assistant_profile_revision: null, assistant_role: null,
    remember: true, working_resource_id: "res-1",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over };
}

/** 会话上下文投影：`project_goals` 与 `working_directory` 是两条必读字段，缺一个整条读失败。 */
function sessionContext(rootPath: string | null, over: Record<string, unknown> = {}) {
  return { project_goals: [],
    working_directory: rootPath === null ? null : { resource_id: "res-1", canonical_root: rootPath,
      display_name: "ProjectA", source: "USER_PICKED" },
    ...over };
}

function message(over: Record<string, unknown> = {}) {
  return { id: "msg-old", session_id: projectSessionId, seq: "1", role: "USER", status: "COMPLETED",
    intent: "DISCUSS", content: "这是项目里那条历史会话的原文", sources: [], cancel_requested: false,
    error_code: null, provider_error_kind: null, created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
    skill: null, ...over };
}

function readyDirectory(rootPath: string, displayName: string, over: Record<string, unknown> = {}) {
  return { canonical_root: rootPath, display_name: displayName, status: "READY", reason: null,
    association: { project_id: projectId, project_title: "ProjectA", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: false, created_resource: false, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" },
    ...over };
}

/**
 * 发送前风险审计：`state: OK` 且 `severity: NONE` 才直接放行。
 * 缺这一段时审计解析失败会被判成「风险未知」而拦住发送——那是另一条路径的断言，不在这里混用。
 */
function audit(rootPath: string) {
  return { state: "OK", detail: "", agent: { id: "relay", label: "Relay" }, root: rootPath,
    scanned_at: "2026-10-31T00:00:00Z", fingerprint: "fp-1", severity: "NONE", files: [],
    budget: { provider_window_tokens: null, provider_window_known: false, call_budget_tokens: 256000,
      call_budget_source: "APPLICATION_DEFAULT", effective_input_tokens: null,
      effective_basis: "CALL_BUDGET",
      reserves: { output_tokens: 0, system_prompt_tokens: 0, tool_definition_tokens: 0, history_tokens: 0 },
      estimated_total_input_tokens: null, required_total_tokens: 0, required_total_share: 0,
      confidence: "WINDOW_UNKNOWN",
      estimate: { method: "BYTES", bytes_per_token: 4, note: "" } },
    reasons: [], suggestions: [], skipped: [], access: null,
    thresholds: { single_file: { notice: 0.1, high: 0.3, severe: 0.6 },
      total_files: { notice: 0.1, high: 0.3, severe: 0.6 } } };
}

interface Harness {
  /** POST 命令流水：路径 + 载荷，用来核对「谁被改了」。 */
  readonly posts: { path: string; body: Record<string, unknown> }[];
  /** GET 请求流水，用来核对「谁被读了」。 */
  readonly gets: string[];
  /** 工作区级会话（`project_id` 为空）：`/agent` 自动续上的就是这一条。 */
  workspaceSessions: () => readonly unknown[];
  /** 单条会话读回（`include_context=true`）：目录继承的继承来源。 */
  sessionRead?: (id: string) => unknown;
  /**
   * 已被归属命令归入项目 P 的会话 id。
   *
   * 真实服务端在归属提交后，这条会话就出现在项目的会话分组里；夹具不跟上这一步，
   * 界面会读到一个「不在列表里的所选会话」而退回空白新对话——那不是这次操作的结果。
   */
  readonly boundToProject: string[];
}

function harness(over: Partial<Harness> = {}): Harness {
  return { posts: [], gets: [], workspaceSessions: () => [], boundToProject: [], ...over };
}

function router(h: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (body: unknown, status = 200) => response(body, status);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      h.posts.push({ path, body });
      if (path === `${prefix}/working-directories/open`) {
        const rootPath = String(body.root_path ?? rootA);
        const display = rootPath === rootB ? "ProjectB" : "ProjectA";
        return json({ command_id: body.command_id, committed_at: "2026-10-31T00:00:00Z",
          result: readyDirectory(rootPath, display), links: { resource: "" } });
      }
      if (path.endsWith("/binding")) {
        h.boundToProject.push(path.split("/").at(-2)!);
        return json({ command_id: body.command_id,
          committed_at: "2026-10-31T00:00:00Z",
          result: { session_id: path.split("/").at(-2), project_id: body.project_id, revision: "2" },
          links: { resource: "" } });
      }
      if (path.endsWith("/working-directory")) return json({ command_id: body.command_id,
        committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: path.split("/").at(-2), working_resource_id: body.resource_id, revision: "2" },
        links: { resource: "" } });
      if (path === `${prefix}/assist-sessions`) return json({ command_id: body.command_id,
        committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: createdSessionId,
          ...session({ id: createdSessionId, project_id: null, title: "新建的会话", working_resource_id: null }) },
        links: { resource: "" } }, 201);
      if (path.endsWith("/messages")) return json({ command_id: body.command_id,
        committed_at: "2026-10-31T00:00:00Z",
        result: { session_id: path.split("/").at(-2), user_message_id: "msg-new",
          assistant_message_id: "msg-reply" }, links: { resource: "" } }, 202);
      throw new Error(`unexpected POST ${path}`);
    }
    h.gets.push(`${path}${url.search}`);
    if (path === `${prefix}/default-working-directory`) return json({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path.startsWith(`${prefix}/working-directories/`) && path.endsWith("/required-context-audit")) {
      return json(audit(rootA));
    }
    if (path === `${prefix}/assist-sessions`) {
      // 按作用域分派：项目作用域读回项目 P 的历史会话 + 刚被归入 P 的会话，
      // 工作区作用域读回未归属会话。
      const scoped = url.searchParams.get("project_id");
      return json({ items: scoped === null ? h.workspaceSessions() : [session(),
        ...h.boundToProject.map((id) => session({ id, title: "未归属讨论", working_resource_id: null }))] });
    }
    if (path.startsWith(`${prefix}/assist-sessions/`)) {
      const rest = path.slice(`${prefix}/assist-sessions/`.length);
      const id = rest.split("/")[0]!;
      if (rest.endsWith("/messages")) {
        return json({ items: id === projectSessionId ? [message()] : [] });
      }
      if (rest === id) {
        const read = h.sessionRead?.(id);
        if (read !== undefined) return json(read);
        return json(id === projectSessionId ? session()
          : session({ id, project_id: null, title: "未归属会话", working_resource_id: null }));
      }
    }
    if (path === `${prefix}/projects/${projectId}`) return json({ id: projectId, title: "ProjectA",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    return json({ items: [], next_cursor: null });
  });
}

function mount(path: string, h: Harness) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", router(h));
  return mountWorkbench(path);
}

const openPosts = (h: Harness) => h.posts.filter((post) => post.path === `${prefix}/working-directories/open`);
const bindingPosts = (h: Harness) => h.posts.filter((post) => post.path.endsWith("/binding"));
const directoryBindingPosts = (h: Harness) =>
  h.posts.filter((post) => post.path.endsWith("/working-directory"));

describe("欢迎页选择目录不恢复历史会话", () => {
  it("项目里已有历史会话时，欢迎页选目录仍落在该目录的空白新会话上", async () => {
    const h = harness();
    const view = await mount("/agent", h);
    try {
      await flush();
      // 起点是空白欢迎页：没有会话面板、没有任何历史原文。
      expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);

      await openWorkingDirectory(rootA);
      await flush(); await flush(); await flush();

      // 目录已就绪并归入项目，但这条讨论仍是新对话。
      expect(folderStripName()).toBe("ProjectA");
      expect(folderStripAssociation()).toContain("已归入项目");
      expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
      // 项目 P 的会话列表被读过（用于确认作用域），但那条历史会话没有被选中、没有被读消息。
      expect(h.gets.some((path) => path.includes(`project_id=${projectId}`))).toBe(true);
      expect(h.gets.some((path) => path.startsWith(`${prefix}/assist-sessions/${projectSessionId}/messages`)))
        .toBe(false);
      expect(view.wrapper.text()).not.toContain("这是项目里那条历史会话的原文");
      // 也没有对任何会话发出归属/目录绑定命令。
      expect(bindingPosts(h)).toHaveLength(0);
      expect(directoryBindingPosts(h)).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("欢迎页选目录后首条发送：只建一条新会话，归属与目录都按这次选择落定", async () => {
    const h = harness();
    const view = await mount("/agent", h);
    try {
      await openWorkingDirectory(rootA);
      await flush(); await flush();
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("从这个目录开始");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush(); await flush();

      const creates = h.posts.filter((post) => post.path === `${prefix}/assist-sessions`);
      expect(creates).toHaveLength(1);
      expect(creates[0]!.body.project_id).toBe(projectId);
      expect(String(creates[0]!.body.command_id)).toMatch(/^[0-9a-f-]{36}$/u);
      // 首条发送链先绑目录再发消息，且绑定的是这条新会话，不是项目里的历史会话。
      const directory = directoryBindingPosts(h);
      expect(directory).toHaveLength(1);
      expect(directory[0]!.path).toBe(`${prefix}/assist-sessions/${createdSessionId}/working-directory`);
      expect(directory[0]!.path).not.toContain(projectSessionId);
      const messagePost = h.posts.find((post) => post.path.endsWith("/messages"));
      expect(messagePost?.body.content).toBe("从这个目录开始");
    } finally { view.unmount(); }
  });
});

describe("目录命令只改它自己那条会话", () => {
  it("自动续上未归属会话后打开目录：进入新对话，不改写这条会话", async () => {
    const h = harness({ workspaceSessions: () => [session({ id: workspaceSessionId, project_id: null,
      title: "未归属讨论", working_resource_id: null })] });
    const view = await mount("/agent", h);
    try {
      await flush(); await flush();
      // 自动续上的是那条未归属会话：用户看到的是它，不是项目里的历史会话。
      expect(view.wrapper.text()).toContain("未归属讨论");

      await openWorkingDirectory(rootA);
      await flush(); await flush(); await flush();

      // P0-D：已有会话里选目录 = 进入该目录的新对话；旧会话不收到任何归属/绑定命令。
      expect(view.router.currentRoute.value.query.new).toBeTruthy();
      expect(view.router.currentRoute.value.query.dir).toBe(rootA);
      expect(bindingPosts(h)).toHaveLength(0);
      expect(directoryBindingPosts(h)).toHaveLength(0);
      expect(folderStripName()).toBe("ProjectA");
      expect(document.querySelector('[data-testid="assist-first-draft"]')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("新对话里再换目录只改这次草稿的目录，不回头改写旧会话", async () => {
    const h = harness({ workspaceSessions: () => [session({ id: workspaceSessionId, project_id: null,
      title: "未归属讨论", working_resource_id: null })] });
    const view = await mount("/agent", h);
    try {
      await flush(); await flush();
      await openWorkingDirectory(rootA);
      await flush(); await flush(); await flush();
      const newKey = view.router.currentRoute.value.query.new;
      expect(newKey).toBeTruthy();

      // 新对话欢迎页还没有会话：再选 B 仍作用在这份草稿上，不建会话、不产生绑定。
      await openWorkingDirectory(rootB);
      await flush(); await flush(); await flush();
      expect(view.router.currentRoute.value.query.new).toBe(newKey);
      expect(folderStripName()).toBe("ProjectB");
      expect(bindingPosts(h)).toHaveLength(0);
      expect(directoryBindingPosts(h)).toHaveLength(0);
      expect(h.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("目录在途时触发键禁用：同一次操作只发一条目录命令，落定后再换以最后一次为准", async () => {
    const h = harness();
    const base = router(h);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path === `${prefix}/working-directories/open`) await gate;
      return base(input, init);
    }));
    const view = await mountWorkbench("/agent");
    try {
      await openWorkingDirectory(rootA);
      await flush();
      // 在途：细条说正在打开，触发键不可再点——所以不存在两个目录同时在途。
      expect(folderStripName()).toContain("正在打开目录");
      expect(document.querySelector('[data-testid="folder-scope-change"]')?.getAttribute("disabled"))
        .not.toBeNull();
      release();
      await flush(); await flush(); await flush();
      expect(openPosts(h)).toHaveLength(1);
      expect(folderStripName()).toBe("ProjectA");

      // 落定后再换一次：以最后一次为准，旧目录不再回写。
      await openWorkingDirectory(rootB);
      await flush(); await flush(); await flush();
      expect(folderStripName()).toBe("ProjectB");
      expect(openPosts(h)).toHaveLength(2);
    } finally { release(); view.unmount(); }
  });
});

describe("从已有会话新建时继承目录", () => {
  it("继承来源会话服务端确认的目录，不用本机最近打开目录顶替", async () => {
    // 本机最近目录是 B，来源会话绑定的是 A：新对话必须进 A。
    rememberWorkingDirectory(rootB, "ProjectB", "2026-10-30T00:00:00Z");
    const h = harness({ sessionRead: (id) => session({ id, project_id: projectId,
      context: sessionContext(rootA) }) });
    const view = await mount(`/agent?new=inherit&source_session=${projectSessionId}`, h);
    try {
      await flush(); await flush(); await flush();
      const opens = openPosts(h);
      expect(opens).toHaveLength(1);
      expect(opens[0]!.body.root_path).toBe(rootA);
      expect(folderStripName()).toBe("ProjectA");
      // 新建路径不预建会话、不改写来源会话。
      expect(h.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
      expect(bindingPosts(h)).toHaveLength(0);
      expect(directoryBindingPosts(h)).toHaveLength(0);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("来源会话没有绑定目录时如实说明，不拿本机最近目录顶上", async () => {
    rememberWorkingDirectory(rootB, "ProjectB", "2026-10-30T00:00:00Z");
    const h = harness({ sessionRead: (id) => session({ id, project_id: projectId,
      working_resource_id: null, context: sessionContext(null) }) });
    const view = await mount(`/agent?new=inherit&source_session=${projectSessionId}`, h);
    try {
      await flush(); await flush(); await flush();
      expect(openPosts(h)).toHaveLength(0);
      expect(folderStripName()).toBe("选择工作目录");
      expect(view.wrapper.get('[data-testid="collab-inherit-directory-missing"]').text())
        .toContain("没有绑定工作目录");
    } finally { view.unmount(); }
  });

  it("来源会话读不回来时显式说明，不把别的目录伪装成已继承", async () => {
    rememberWorkingDirectory(rootB, "ProjectB", "2026-10-30T00:00:00Z");
    const h = harness({ sessionRead: () => { throw new TypeError("source session unavailable"); } });
    const view = await mount(`/agent?new=inherit&source_session=${projectSessionId}`, h);
    try {
      await flush(); await flush(); await flush();
      expect(openPosts(h)).toHaveLength(0);
      expect(view.wrapper.get('[data-testid="collab-inherit-directory-failed"]').text())
        .toContain("无法读取原会话的工作目录");
      expect(folderStripName()).toBe("选择工作目录");
    } finally { view.unmount(); }
  });

  it("会话内点新对话：URL 带来源会话，重挂载后继承其目录且原会话不变", async () => {
    const h = harness({ workspaceSessions: () => [session({ id: workspaceSessionId, project_id: null,
      title: "未归属讨论", working_resource_id: "res-1" })],
      sessionRead: (id) => id === workspaceSessionId
        ? session({ id, project_id: null, title: "未归属讨论", working_resource_id: "res-1",
          context: sessionContext(rootA) })
        : session({ id, project_id: projectId, context: sessionContext(rootA) }) });
    rememberWorkingDirectory(rootB, "ProjectB", "2026-10-30T00:00:00Z");
    const view = await mount("/agent", h);
    try {
      await flush(); await flush();
      await openFolderDialog();
      const newConversation = document.querySelector<HTMLElement>('[data-testid="collab-new-conversation"]');
      expect(newConversation).not.toBeNull();
      newConversation!.click();
      await flush(); await flush(); await flush();

      // 自动续上的会话同样是来源：URL 必须带上它，否则新对话继承不到任何上下文。
      expect(view.router.currentRoute.value.query.source_session).toBe(workspaceSessionId);
      const opens = openPosts(h);
      expect(opens.at(-1)?.body.root_path).toBe(rootA);
      expect(folderStripName()).toBe("ProjectA");
      // 新对话是空白输入器：没有把原会话的原文拉回来，也没有改写原会话。
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value).toBe("");
      expect(bindingPosts(h)).toHaveLength(0);
      expect(directoryBindingPosts(h)).toHaveLength(0);
    } finally { view.unmount(); }
  });
});
