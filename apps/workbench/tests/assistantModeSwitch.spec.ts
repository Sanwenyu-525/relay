import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, feedbackText, flush, mountWorkbench, openSessionSwitcher, openWorkingDirectory, pressEscape, switchToolbarSession, switcherCurrentSession, toolbarSessionTitle } from "./mountApp";

/**
 * 协作页聊天框的会话模式单选框与人设助手（工作台 §25、ADR-018、测试计划 §23.2）。
 *
 * 出口只有 jsdom 与 fetch 打桩。真实 Windows 窗口、原生 IME/DPI 与真实 Provider
 * 下的助手会话质量仍未验证，见统一功能验收表「会话模式与人设助手（2026-10-05）」行。
 *
 * 用 `/agent` 而不是项目子页：模式控件只在 standalone 的输入器工具行里，
 * 项目子页是嵌入式表单，没有那一行。
 *
 * 2026-10-16 助手配置从输入框内联改收进 AppDialog。AppDialog 是 Portal 到 body 的，
 * 而 `view.wrapper` 只覆盖挂载容器，因此弹窗内的节点一律经 `assistantDialogEl` 取，
 * 留在输入框里的节点（chip、只读说明、blocked 行）仍走 `view.wrapper`。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const agentSessionId = "33333333-3333-4333-8333-333333333333";
const assistantSessionId = "44444444-4444-4444-8444-444444444444";
const assistantProfileId = "55555555-5555-4555-8555-555555555555";
const createdProfileId = "99999999-9999-4999-8999-999999999999";
const createdSessionId = "77777777-7777-4777-8777-777777777777";
const learningSessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function agentSession() {
  return { id: agentSessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "普通会话", status: "ACTIVE", revision: "1",
    conversation_mode: "AGENT", assistant_profile_id: null, assistant_profile_revision: null,
    assistant_role: null, remember: true, updated_at: "2026-10-06T00:00:00Z" };
}
function assistantSession() {
  return { id: assistantSessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "人设会话", status: "ACTIVE", revision: "1",
    conversation_mode: "ASSISTANT", assistant_profile_id: assistantProfileId,
    assistant_profile_revision: "3",
    assistant_role: { name: "审读", role_description: "只读复核", tone: "简短", read_scope: {} },
    remember: true, updated_at: "2026-10-06T00:00:00Z" };
}
function learningSession() {
  return { ...agentSession(), id: learningSessionId, title: "学习幂等性", conversation_mode: "LEARNING" };
}
function profile(extra: Record<string, unknown> = {}) {
  return { id: assistantProfileId, workspace_id: workspaceId, name: "审读",
    role_description: "只读复核这份改动", tone: "简短", read_scope: { roots: ["src"] },
    status: "ACTIVE", revision: "3", created_at: "2026-10-06T00:00:00Z",
    updated_at: "2026-10-06T00:00:00Z", ...extra };
}
function project() {
  return { id: projectId, title: "当前项目", project_type: "GENERAL", revision: "1",
    state_revision: "1", archived_at: null };
}
function message(session: string) {
  return { id: "66666666-6666-4666-8666-666666666666", session_id: session, seq: "1",
    role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS",
    content: "看过了，这一段只读复核没问题。", sources: [],
    cancel_requested: false, error_code: null, provider_error_kind: null,
    created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null }, skill: null };
}

interface Stub {
  sessions: unknown[];
  posts: { path: string; body: Record<string, unknown> }[];
  profiles?: readonly unknown[];
  profileList?: () => Response | Promise<Response>;
  loseCreateResponse?: boolean;
  loseFirstMessageResponse?: boolean;
  loseChatResponse?: boolean;
  /** 哪些会话有一条已完成的助手消息；人设标签要落在消息行上才有东西可断言。 */
  withMessages?: readonly string[];
  withSources?: boolean;
  inflightSessionId?: string;
}

function stub(options: Stub) {
  let chatReceipt: Record<string, unknown> | null = null;
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (method === "POST") options.posts.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (path === `${prefix}/projects/${projectId}`) return json(project());
    if (path === `${prefix}/projects`) return json({ items: [{ ...project(), archive_status: "ACTIVE",
      phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z" }], next_cursor: null });
    if (path === `${prefix}/projects/${projectId}/state`) return json({ project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/working-directories/open`) {
      const body = options.posts.at(-1)?.body ?? {};
      return json({ command_id: body.command_id, committed_at: "2026-10-06T00:00:00Z",
        links: { resource: "" }, result: { canonical_root: body.root_path ?? "D:/tmp/probe",
          display_name: "probe", status: "READY", reason: null,
          association: { project_id: projectId, project_title: "当前项目", project_archived: false,
            resource_id: "aaaaaaa1-1111-4111-8111-111111111111", resource_status: "ACTIVE",
            file_write_identity_bound: true },
          created_project: true, created_resource: true, candidates: [],
          write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" } } }, 200);
    }
    if (path === `${prefix}/assistant-profiles` && method === "POST") {
      const body = options.posts.at(-1)?.body ?? {};
      return json({ command_id: body.command_id, committed_at: "2026-10-06T00:00:00Z",
        result: { assistant_profile_id: createdProfileId, workspace_id: workspaceId,
          name: body.name, role_description: body.role_description, tone: body.tone ?? null,
          read_scope: body.read_scope ?? {}, status: "ACTIVE", revision: "1" } }, 201);
    }
    if (path === `${prefix}/assistant-profiles`) return options.profileList?.()
      ?? json({ items: options.profiles ?? [profile()] });
    if (path.endsWith("/working-directory") && method === "POST") {
      const body = options.posts.at(-1)!.body;
      return json({ command_id: body.command_id, committed_at: "2026-10-16T00:00:00Z",
        result: { session_id: path.split("/").at(-2), working_resource_id: body.resource_id, revision: "2" } });
    }
    if (path === `${prefix}/assist-sessions` && method === "POST") {
      const body = options.posts.at(-1)?.body ?? {};
      const assistant = body.conversation_mode === "ASSISTANT";
      const created = { ...(assistant ? assistantSession() : agentSession()), id: createdSessionId,
        project_id: body.project_id ?? null, task_id: body.task_id ?? null, title: String(body.title ?? "新讨论"),
        conversation_mode: body.conversation_mode ?? "AGENT",
        assistant_profile_id: assistant ? body.assistant_profile_id ?? null : null,
        assistant_profile_revision: assistant ? "3" : null,
        assistant_role: assistant ? assistantSession().assistant_role : null };
      if (options.loseCreateResponse) { options.loseCreateResponse = false; throw new TypeError("response lost after commit"); }
      options.sessions.push(created);
      return json({ command_id: body.command_id, committed_at: "2026-10-07T00:00:00Z",
        result: { ...created, session_id: createdSessionId }, links: { resource: "" } }, 201);
    }
    if (path === `${prefix}/assist-sessions`) return json({ items: options.sessions });
    const control = path.match(/\/assist-sessions\/([0-9a-f-]+)\/chat-commands$/u);
    if (control && method === "POST") {
      const body = options.posts.at(-1)!.body;
      const source = options.sessions.find((item) => (item as { id: string }).id === control[1]) as ReturnType<typeof agentSession>;
      const created = { ...source, id: createdSessionId };
      options.sessions.push(created);
      chatReceipt = { command_id: body.command_id, command_type: "ExecuteChatCommand",
        committed_at: "2026-10-13T00:00:00Z", links: { resource: "" }, result: {
          ...created, kind: "NEW_SESSION", system: body.text === "/new" ? "new" : "clear",
          source_session_id: source.id, session_id: created.id } };
      if (options.loseChatResponse) { options.loseChatResponse = false; throw new TypeError("chat response lost"); }
      return json(chatReceipt);
    }
    if (chatReceipt !== null && path.endsWith(`/commands/${String(chatReceipt.command_id)}`)) return json(chatReceipt);
    if (path === `${prefix}/learning-records`) return json({ epoch: "0", cleared_at: null, concepts: [] });
    if (path.endsWith("/state") && path.includes("/learning-sessions/")) return json({
      session_id: path.split("/").at(-2), records_enabled: true, revision: "0", rounds: [] });
    if (path.endsWith("/continuation") && path.includes("/learning-sessions/")) return json({
      session_id: path.split("/").at(-2), goal: "学习幂等性", last_observed_at: null, topics: [], open_items: [] });
    const sessionDetail = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/([0-9a-f-]+)$/u);
    if (sessionDetail) return json(options.sessions.find((item) =>
      (item as { id?: string }).id === sessionDetail[1]) ?? { code: "NOT_FOUND", detail: "会话不存在" },
      options.sessions.some((item) => (item as { id?: string }).id === sessionDetail[1]) ? 200 : 404);
    const messages = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/([0-9a-f-]+)\/messages$/u);
    if (messages) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (options.loseFirstMessageResponse) {
          options.loseFirstMessageResponse = false;
          throw new TypeError("response lost after commit");
        }
        return json({ command_id: body.command_id, committed_at: "2026-10-06T00:00:00Z",
          result: { session_id: messages[1], user_message_id: "77777777-7777-4777-8777-777777777777",
            assistant_message_id: "88888888-8888-4888-8888-888888888888" } }, 202);
      }
      if (options.inflightSessionId === messages[1]) {
        return json({ items: [{ ...message(messages[1]!), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "RUNNING", content: null, cancel_requested: false }] });
      }
      return json({ items: options.withMessages?.includes(messages[1] ?? "") === true
        ? [{ ...message(messages[1]!), sources: options.withSources ? [{ kind: "KNOWLEDGE", root_id: assistantProfileId,
          version: "1", status: "FROZEN" }] : [] }] : [] });
    }
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return json({ items: [] });
    if (path === `${prefix}/assist-proposals`) return json({ items: [] });
    if (path === `${prefix}/chat-commands`) return json({ items: [
      { kind: "METHOD", name: "review", aliases: ["代码审查", "审查"], title: "代码审查",
        summary: "阅读当前改动，不自动修复。", usage: "/review [目标]", method_id: "code-review" },
      { kind: "SYSTEM", name: "clear", aliases: ["清空"], title: "/clear",
        summary: "新建空会话，保留项目与目录。", usage: "/clear", system_id: "clear" },
      { kind: "SYSTEM", name: "model", aliases: ["模型"], title: "/model <模型名>",
        summary: "选择模型。", usage: "/model <模型名>", system_id: "model" }
    ] });
    if (path === `${prefix}/skill-definitions`) return json({ items: [] });
    if (path === `${prefix}/model-port`) return json({ provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return json({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/search`)) return json({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return json({ items: [], next_cursor: null });
    if (path.includes("/command-receipts")) return json({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    throw new Error(`unexpected request ${method} ${path}`);
  });
}

/**
 * 打开一个目录，拿到带文件夹入口的协作页。
 *
 * 不用 `?mode=` 深链进入：协作页自己拥有查询串并在切换目录时整体重写，
 * 深链参数活不到输入器出现那一刻。真实用户路径也是「打开目录 → 拨单选框」。
 */
async function openAgent(options: Stub) {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", stub(options));
  const view = await mountWorkbench("/agent");
  await openWorkingDirectory("D:/tmp/probe");
  return view;
}

const configDialogSelector = '[role="dialog"][aria-label="人设助手"]';
function assistantDialogOpen(): boolean { return document.querySelector(configDialogSelector) !== null; }
/** 助手配置在弹窗里，而弹窗挂在 body 上：必须从 document 取，不能从 view.wrapper 取。 */
function assistantDialogEl(testId: string): DomWrapper {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`assistant config selector not found: ${testId}`);
  return new DomWrapper(element);
}
async function openAssistantConfig(view: Awaited<ReturnType<typeof openAgent>>): Promise<void> {
  if (assistantDialogOpen()) return;
  await view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').trigger("click");
  await flush();
}
async function closeAssistantConfig(): Promise<void> {
  if (!assistantDialogOpen()) return;
  await act(async () => { pressEscape(); });
  await flush();
}
/** 在弹窗里选一个助手。选中即收起弹窗：遮罩挡着输入框，留着不让人继续打字是刻意的。 */
async function pickAssistant(view: Awaited<ReturnType<typeof openAgent>>, profileId: string): Promise<void> {
  await openAssistantConfig(view);
  await assistantDialogEl('assist-assistant-picker').setValue(profileId);
  await flush();
}

/** 拨到助手档，等导航与面板挂载完。配置弹窗不随切档自动打开，需要它的用例显式 open。 */
/**
 * 切档入口（2026-10-22 DEV-0116 起：芯片 + 自绘浮层，不再是原生 select）。
 * 先把 details 打开再点行——jsdom 没有布局，闭合的 details 里元素也在 DOM 中，
 * 显式打开是让用例走真实点击路径，而不是依赖「隐藏元素也点得到」这个只有测试里成立的前提。
 */
async function chooseMode(view: Awaited<ReturnType<typeof openAgent>>, mode: "AGENT" | "ASSISTANT" | "LEARNING") {
  const menu = view.wrapper.get('[data-testid="conversation-mode-menu"]').element as HTMLDetailsElement;
  await act(async () => { menu.open = true; });
  await view.wrapper.get(`[data-testid="conversation-mode-option-${mode}"]`).trigger("click");
  await flush(80);
}
async function flipToAssistant(view: Awaited<ReturnType<typeof openAgent>>) {
  await chooseMode(view, "ASSISTANT");
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("会话模式单选框", () => {
  it("首条输入的命令菜单按中文检索，选择只改草稿且保留焦点", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    try {
      const input = view.wrapper.get('[data-testid="assist-first-draft"]');
      await act(async () => (input.element as HTMLTextAreaElement).focus());
      await input.setValue("/审查");
      await flush();
      await view.wrapper.get('[data-testid="chat-command-review"]').trigger("click");
      expect((input.element as HTMLTextAreaElement).value).toBe("/review ");
      expect(document.activeElement).toBe(input.element);
      expect(view.wrapper.find('[data-testid="chat-command-menu"]').exists()).toBe(false);
      expect(options.posts.filter((p) => !p.path.endsWith("/working-directories/open"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  /**
   * 首条输入器的底栏顺序（2026-10-20 用户指令「上下文和模型下拉按钮整体移动到发送按钮的左边」）。
   * jsdom 看不见 CSS，但文档序就是渲染序；真实 Chromium 侧的同一条锁在 `composerSourcePanel.spec.ts` 3c。
   */
  it("首条输入器：计量环与模型在发送键左边成组，其余邻接关系不变", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    try {
      const actions = document.querySelector(".agent-chat-composer-actions");
      if (actions === null) throw new Error("首条输入器没有底栏");
      const order = Array.from(actions.children).map((element) => element.className);
      // 底栏只剩三个直接子件：工具行、右端一组（计量 + 模型）、发送键；一组紧贴发送键左边。
      expect(order).toHaveLength(3);
      expect(order[0]).toBe("agent-chat-composer-tools");
      expect(order[1]).toBe("agent-chat-composer-tail");
      expect(order[2]).toBe("primary-button agent-chat-send");
      const tail = actions.children[1];
      expect(Array.from(tail.children).map((element) => element.className))
        .toEqual(["agent-chat-usage", "model-selector"]);
      const tools = actions.querySelector(".agent-chat-composer-tools");
      if (tools === null) throw new Error("首条输入器没有工具行");
      const toolOrder = Array.from(tools.children).map((element) => element.className);
      // 这次只搬两枚：「+」与写档位仍相邻，禁用资料说明芯片仍紧跟「普通讨论」浮层。
      expect(toolOrder.indexOf("agent-chat-permission")).toBe(toolOrder.indexOf("agent-chat-attach") + 1);
      expect(toolOrder.indexOf("agent-chat-tool")).toBe(toolOrder.indexOf("agent-chat-options") + 1);
    } finally { view.unmount(); }
  });

  it("已有会话从菜单选 clear 后仍需发送，沿原会话命令创建", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    try {
      const input = view.wrapper.get('[data-testid="assist-draft"]');
      await act(async () => (input.element as HTMLTextAreaElement).focus());
      await input.setValue("/清空");
      await flush();
      await input.trigger("keydown", { key: "Enter" });
      expect((input.element as HTMLTextAreaElement).value).toBe("/clear ");
      expect(options.posts.filter((p) => p.path.endsWith("/chat-commands"))).toHaveLength(0);
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(100);
      expect(options.posts.filter((p) => p.path.endsWith("/chat-commands"))).toHaveLength(1);
      expect(options.posts.some((p) => p.path.endsWith("/messages"))).toBe(false);
    } finally { view.unmount(); }
  });

  it.each([
    { mode: "AGENT", command: "/clear", source: agentSession() },
    { mode: "ASSISTANT", command: "/new", source: assistantSession() },
    { mode: "LEARNING", command: "/清空", source: learningSession() }
  ])("$mode 的 $command 建空会话并保留身份与历史", async ({ mode, command, source }) => {
    const options: Stub = { sessions: [source], posts: [], withMessages: [source.id] };
    const view = await openAgent(options);
    try {
      if (mode !== "AGENT") {
        await chooseMode(view, mode as "AGENT" | "ASSISTANT" | "LEARNING");
      }
      await view.wrapper.get('[data-testid="assist-draft"]').setValue(command);
      await view.wrapper.get('[data-testid="assist-composer"] form').trigger("submit");
      await flush(100);
      expect(options.posts.filter((p) => p.path.endsWith("/chat-commands"))).toHaveLength(1);
      expect(options.posts.some((p) => p.path.endsWith("/messages") || p.path.endsWith("/interpret"))).toBe(false);
      expect(options.sessions).toHaveLength(2);
      expect(options.sessions[1]).toMatchObject({ id: createdSessionId, conversation_mode: mode,
        project_id: projectId, assistant_profile_id: source.assistant_profile_id });
      // 顶栏左翼只显示会话名；界面停在哪个会话由右翼「切换讨论」浮层读（取代旧下拉的 value 与文案）。
      // 同名讨论仍在同一个入口里分开：同名才补更新时刻，且只有一条标「当前」。
      const labels = (await openSessionSwitcher()).filter((label) => label.includes(source.title));
      expect(labels).toHaveLength(2);
      expect(labels.every((label) => label.includes("更新"))).toBe(true);
      expect(labels.filter((label) => label.includes("当前"))).toHaveLength(1);
      expect(switcherCurrentSession()).toBe(createdSessionId);
      expect(view.wrapper.find('[data-role="ASSISTANT"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
  it("新会话响应丢失后按原回执接续，不重复创建", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [], loseChatResponse: true };
    const view = await openAgent(options);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("/clear");
      await view.wrapper.get('[data-testid="assist-composer"] form').trigger("submit");
      await flush(80);
      expect(view.wrapper.find(".assist-pending").exists()).toBe(true);
      expect((document.querySelector('[data-testid="assist-draft"]') as HTMLTextAreaElement).value).toBe("/clear");
      await view.wrapper.findAll("button").find((item) => item.text() === "查询原命令回执")!.trigger("click");
      await flush(100);
      // 回执接续之后停在按原 command_id 建出的那条讨论上（顶栏浮层的当前标记，取代旧下拉的 value）。
      await openSessionSwitcher();
      expect(switcherCurrentSession()).toBe(createdSessionId);
      expect(options.posts.filter((p) => p.path.endsWith("/chat-commands"))).toHaveLength(1);
      expect(options.sessions).toHaveLength(2);
    } finally { view.unmount(); }
  });
  it("撤回命令提示具体调整回执，不作为模型消息或猜测撤回目标", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("/undo");
      await view.wrapper.get('[data-testid="assist-composer"] form').trigger("submit");
      await flush(60);
      expect(feedbackText("assist-receipt-notice")).toContain("撤回本次调整");
      expect(options.posts.filter((p) => !p.path.endsWith("/working-directories/open"))).toHaveLength(0);
    } finally { view.unmount(); }
  });
  it("明确转执行新建普通身份，带目标和方案，不改原学习会话", async () => {
    const options: Stub = { sessions: [agentSession(), learningSession()], posts: [], withMessages: [learningSessionId], withSources: true };
    const view = await openAgent(options);
    await chooseMode(view, "LEARNING");
    await flush(80);
    const panel = view.wrapper.get('[data-testid="learning-records-panel"]');
    await panel.findAll("summary").find((item) => item.text() === "转入普通执行会话")!.trigger("click");
    await panel.findAll("textarea")[0]!.setValue("按这个方案实现");
    await panel.findAll("button").find((item) => item.text() === "转入执行")!.trigger("click");
    await flush(120);
    const creates = options.posts.filter((p) => p.path.endsWith("/assist-sessions"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({ conversation_mode: "AGENT", project_id: projectId });
    const send = options.posts.find((p) => p.path.endsWith("/messages"));
    expect(send?.body.content).toContain("按这个方案实现");
    expect(send?.body.content).toContain(learningSessionId);
    expect(send?.body.content).toContain("学习幂等性");
    expect(send?.body.content).toContain(message(learningSessionId).content);
    expect(send?.body.source_refs).toEqual([{ kind: "KNOWLEDGE", root_id: assistantProfileId, version: "1" }]);
    expect((options.sessions.find((s) => (s as { id: string }).id === learningSessionId) as { conversation_mode: string }).conversation_mode).toBe("LEARNING");
    view.unmount();
  });
  it("学习档复用已有身份，发送不带执行意图，不触发执行或状态维护解释", async () => {
    const options: Stub = { sessions: [agentSession(), learningSession()], posts: [] };
    const view = await openAgent(options);
    await chooseMode(view, "LEARNING");
    await flush(80);
    expect(view.wrapper.get('[data-testid="learning-readonly-note"]').text()).toContain("对项目只读");
    expect(view.wrapper.find('[data-testid="assist-intent"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="learning-records-panel"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="learning-message-no-record"]').setValue(true);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("解释重复提交");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    // 图标按钮关联表单，在 jsdom 中显式提交与浏览器相同的表单。
    await view.wrapper.get('[data-testid="assist-composer"] form').trigger("submit");
    await flush(100);
    const sends = options.posts.filter((p) => p.path.endsWith("/messages"));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.path).toContain(learningSessionId);
    expect(sends[0]!.body).toMatchObject({ content: "解释重复提交", record_learning: false });
    expect(sends[0]!.body).not.toHaveProperty("intent");
    expect(sends[0]!.body).not.toHaveProperty("skill_ref");
    expect(options.posts.filter((p) => p.path.includes("execution") || p.path.includes("maintenance") || p.path.endsWith("/assist-sessions"))).toHaveLength(0);
    view.unmount();
  });

  it("自由学习不要求目录；首条响应丢失后原命令重试仍保留学习身份与不记录载荷", async () => {
    const options: Stub = { sessions: [], posts: [], loseFirstMessageResponse: true };
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", stub(options));
    const view = await mountWorkbench("/agent");
    await chooseMode(view, "LEARNING");
    await view.wrapper.get('[data-testid="learning-message-no-record"]').setValue(true);
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("带我理解幂等性");
    await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
    await flush(120);
    const create = options.posts.find((p) => p.path.endsWith("/assist-sessions"));
    expect(create?.body).toMatchObject({ conversation_mode: "LEARNING", project_id: null, task_id: null });
    expect(view.wrapper.find('[data-testid="assist-first-retry"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="assist-first-retry"]').trigger("click");
    await flush(100);
    const sends = options.posts.filter((p) => p.path.endsWith("/messages"));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body).toEqual(sends[1]!.body);
    expect(sends[0]!.body.record_learning).toBe(false);
    expect(sends[0]!.body).not.toHaveProperty("intent");
    expect(options.posts.filter((p) => p.path.endsWith("/assist-sessions"))).toHaveLength(1);
    view.unmount();
  });
  it("三档收在一枚芯片与一个浮层里，普通档标签不承诺尚未实现的子 Agent 派发", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    // 2026-10-18 用户指令「普通 agent，人设助手，学习合并到一个下拉框中」：三档不再各占一枚 radio；
    // 2026-10-22 DEV-0116 按用户「优化一下下拉框ui」把浮层改由本应用自绘，候选仍是这三行。
    expect(view.wrapper.findAll('[data-testid="conversation-mode"] input[type="radio"]')).toHaveLength(0);
    expect(view.wrapper.findAll('[data-testid="conversation-mode"] [data-mode-row]')
      .map((item) => item.text())).toEqual(["普通 Agent", "人设助手", "学习"]);
    // ADR-017 的子 Agent 至今零代码，标签不能预先承诺。
    expect(view.wrapper.get('[data-testid="conversation-mode"]').text()).not.toContain("子 Agent");
    expect(view.wrapper.get('[data-testid="conversation-mode-select"]').attributes("data-mode")).toBe("AGENT");
    // 当前档在浮层里只标一行，且勾号只画在这一行上。
    expect(view.wrapper.findAll("[data-mode-row][data-current=\"true\"]")).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="conversation-mode-option-AGENT"]').text()).toContain("普通 Agent");
    view.unmount();
  });

  /**
   * 自绘浮层的键盘与焦点（DEV-0116）。换成自绘的代价就是这几件事要自己实现，因此逐条钉住：
   * 芯片上按方向键＝原生 select 的那一次按键（打开浮层并把焦点落在目标档）、浮层内上下与
   * Home/End 在三行间移动（端点回绕）、Esc 与点当前档都不换档、焦点回到芯片。
   *
   * 这里刻意不做「选定另一档后焦点回芯片」这一步：切档是导航到另一条会话，协作页给
   * AssistView 的 key 带 sessionId，芯片节点会随重挂载换掉，焦点只能落在新芯片上——
   * 那是导航的结果，不是浮层的行为，硬断言旧节点会拿到 body。换档本身由上面的
   * chooseMode 用例覆盖，导航后的焦点归 DEV-0110 那组发送态用例。
   */
  it("模式浮层：方向键落在目标档，行内移动回绕，Esc 与点当前档都不换档", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    try {
      const chip = () => view.wrapper.get('[data-testid="conversation-mode-select"]');
      const row = (mode: string) => view.wrapper.get(`[data-testid="conversation-mode-option-${mode}"]`);
      const menuOpen = () => (view.wrapper.get('[data-testid="conversation-mode-menu"]')
        .element as HTMLDetailsElement).open;

      await chip().trigger("keydown", { key: "ArrowDown" });
      expect(menuOpen()).toBe(true);
      expect(document.activeElement).toBe(row("ASSISTANT").element);
      expect(chip().attributes("data-mode")).toBe("AGENT");   // 打开与移动焦点都不改档，只有选定才改

      await row("ASSISTANT").trigger("keydown", { key: "ArrowDown" });
      expect(document.activeElement).toBe(row("LEARNING").element);
      await row("LEARNING").trigger("keydown", { key: "ArrowDown" });
      expect(document.activeElement).toBe(row("AGENT").element);   // 末档向下回绕，不跑出这三行
      await row("AGENT").trigger("keydown", { key: "ArrowUp" });
      expect(document.activeElement).toBe(row("LEARNING").element);
      await row("LEARNING").trigger("keydown", { key: "Home" });
      expect(document.activeElement).toBe(row("AGENT").element);
      await row("AGENT").trigger("keydown", { key: "End" });
      expect(document.activeElement).toBe(row("LEARNING").element);

      // Esc：收起浮层，焦点回芯片，档位不变——收起不是选择。
      await act(async () => { pressEscape(); });
      await flush(20);
      expect(menuOpen()).toBe(false);
      expect(document.activeElement).toBe(chip().element);
      expect(chip().attributes("data-mode")).toBe("AGENT");

      // 点当前那一档：收起且不换档（否则一次误点就会把自己导航走）。
      await chip().trigger("keydown", { key: "ArrowDown" });
      await row("AGENT").trigger("click");
      await flush(20);
      expect(menuOpen()).toBe(false);
      expect(chip().attributes("data-mode")).toBe("AGENT");
      expect(view.wrapper.findAll('[data-mode-row][data-current="true"]')
        .map((item) => item.attributes("data-testid"))).toEqual(["conversation-mode-option-AGENT"]);
    } finally { view.unmount(); }
  });

  /**
   * 在途时浮层打不开、也换不了档（DEV-0116 把这条从「select 被 disabled」改成显式挡住）。
   * 原先的用例是「先切到助手档再看在途」——原生 select 上 `setValue` 会绕过 disabled 直接发
   * change，所以那一步在测试里成立、在真实浏览器里不成立。自绘浮层按真实语义挡住之后，
   * 进入在途会话改走顶栏「切换讨论」，与用户实际怎么到达那条会话一致。
   */
  it("在途时浮层打不开、点行也不换档：切档不是停止", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [],
      inflightSessionId: assistantSessionId };
    const view = await openAgent(options);
    try {
      await switchToolbarSession(assistantSessionId);
      const menu = view.wrapper.get('[data-testid="conversation-mode-menu"]').element as HTMLDetailsElement;
      const chip = view.wrapper.get('[data-testid="conversation-mode-select"]');
      expect(chip.attributes("aria-disabled")).toBe("true");
      await chip.trigger("keydown", { key: "ArrowDown" });
      expect(menu.open).toBe(false);
      await chip.trigger("click");
      expect(menu.open).toBe(false);
      // 就算浮层是别处打开的（例如在途刚开始时它已开着），点行也不发切档命令。
      await act(async () => { menu.open = true; });
      await view.wrapper.get('[data-testid="conversation-mode-option-AGENT"]').trigger("click");
      await flush(60);
      expect(view.wrapper.get('[data-testid="conversation-mode-select"]').attributes("data-mode"))
        .toBe("ASSISTANT");
    } finally { view.unmount(); }
  });

  it("默认按普通档解析，不虚构助手关系", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    expect(view.wrapper.get('[data-testid="conversation-mode-select"]').attributes("data-mode")).toBe("AGENT");
    expect(view.wrapper.find('[data-testid="assist-assistant-picker"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-assistant-config-toggle"]').exists()).toBe(false);
    view.unmount();
  });

  it("切档是导航到那条已有的助手会话：不建会话，也不改当前会话的身份", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    const before = options.posts.length;
    await flipToAssistant(view);
    // 建会话是写命令；切档如果偷偷建了一条，这里就会多一个 POST。
    expect(options.posts.slice(before).filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    // 落到了那一条已有的助手会话上，而不是另开一条。配置收进弹窗后，
    // 「跟谁说话」这件事必须不点开弹窗就看得见，所以断言落在 chip 上。
    expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').text()).toContain("审读 · v3");
    expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(true);
    view.unmount();
  });

  it("助手档隐藏发送选项，显示只读边界说明", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    expect(view.wrapper.find('[data-testid="assist-intent"]').exists()).toBe(true);
    await flipToAssistant(view);
    expect(view.wrapper.find('[data-testid="assist-intent"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-skill"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-readonly-note"]').text()).toContain("只读");
    view.unmount();
  });

  it("切到助手档不自动弹遮罩：chip 说清还缺什么，撑高的东西一个都不进输入框", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    const view = await openAgent(options);
    try {
      await chooseMode(view, "ASSISTANT");
      expect(assistantDialogOpen()).toBe(false);
      const chip = view.wrapper.get('[data-testid="assist-assistant-config-toggle"]');
      expect(chip.text()).toContain("选择助手");
      expect(chip.attributes("aria-expanded")).toBe("false");
      // 下一步由常驻的 blocked 行说，不靠自动弹窗把人按在遮罩里。
      expect(view.wrapper.get('[data-testid="assist-first-blocked"]').text()).toContain("先新建一个");
      // 清单提示、下拉与新建表单都只在弹窗里，输入框卡内不留副本。
      expect(view.wrapper.find('[data-testid="assist-assistant-picker"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-assistant-create-toggle"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-assistant-list-empty"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("chip 点开配置弹窗，Esc 关闭后焦点回到 chip", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    const view = await openAgent(options);
    try {
      await flipToAssistant(view);
      const chip = view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').element as HTMLElement;
      // jsdom 的 click() 不移动焦点，真实浏览器会：先聚焦再点，才测得到关闭后的归位目标。
      await act(async () => { chip.focus(); chip.click(); });
      await flush();
      expect(assistantDialogOpen()).toBe(true);
      expect(assistantDialogEl('assist-assistant-list-empty').text()).toContain("重新读取助手清单");
      await closeAssistantConfig();
      expect(assistantDialogOpen()).toBe(false);
      expect(document.activeElement).toBe(chip);
      expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').attributes("aria-expanded")).toBe("false");
    } finally { view.unmount(); }
  });

  it("只读边界说明常驻输入框，不跟着配置一起收进弹窗", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    const view = await openAgent(options);
    try {
      await flipToAssistant(view);
      await openAssistantConfig(view);
      // 这档最容易被误当成「什么都能干的另一个聊天窗口」，边界必须不点开也看得见。
      expect(view.wrapper.get('[data-testid="assist-readonly-note"]').text()).toContain("不派子 Agent");
      expect(document.querySelector(configDialogSelector)!.querySelector('[data-testid="assist-readonly-note"]'))
        .toBeNull();
    } finally { view.unmount(); }
  });

  it("没有可用助手时新建入口就地可见：点开同一弹窗，表单已展开、焦点在名字", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      expect(view.wrapper.get('[data-testid="assist-assistant-create-entry"]').text()).toBe("新建助手");
      await view.wrapper.get('[data-testid="assist-assistant-create-entry"]').trigger("click");
      await flush();
      expect(assistantDialogOpen()).toBe(true);
      // 就地入口与 chip 点开的是同一个弹窗，差别只在表单已展开、焦点直接落在名字上。
      const details = document.querySelector(`${configDialogSelector} details.agent-chat-assistant-create`);
      expect(details?.hasAttribute("open")).toBe(true);
      expect(document.activeElement).toBe(assistantDialogEl("assist-assistant-name").element);
      // 入口只开配置，不替代发送：到此刻为止没有创建会话或消息。
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  /* 菜单里不再有整段说明（2026-10-19 用户指认「每个菜单下面都有文字……这个文字很影响体验」，
     上游同类菜单也没有）：禁用原因只挂在行上的 `title`，面板高度只由选项行决定。 */
  it("「+」弹层：选项恒定单行，禁用原因只挂在悬停 title，不再渲染底部脚注", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", stub(options));
    const view = await mountWorkbench("/agent");
    try {
      expect(document.querySelectorAll(".agent-chat-attach-note")).toHaveLength(0);
      expect(document.querySelector(".agent-chat-attach-item-reason")).toBeNull();
      // 资料在首条消息仍是禁用，原因只在悬停里；Skill 与连接器可点开。
      const sources = document.querySelector('[data-testid="assist-attach-sources"]');
      expect(sources?.hasAttribute("disabled")).toBe(true);
      expect(sources?.getAttribute("title")).toBe("资料在会话中选择");
      // 一行都没挂 aria-describedby：原来指向的脚注已经不存在，留着就是悬空引用。
      for (const key of ["sources", "skill", "command", "connectors"]) {
        expect(document.querySelector(`[data-testid="assist-attach-${key}"]`)?.getAttribute("aria-describedby"))
          .toBeNull();
      }
      expect(document.querySelector('[data-testid="assist-attach-skill"]')?.hasAttribute("disabled")).toBe(false);
      expect(document.querySelector('[data-testid="assist-attach-connectors"]')?.getAttribute("title"))
        .toContain("连接器随项目配置");
      // 目录入口不在「+」里（2026-10-19）：一级只有四项，目录归协作页目录细条。
      expect(document.querySelector('[data-testid="assist-attach-folder"]')).toBeNull();
    } finally { view.unmount(); }
  });

  /* 「+」二级菜单（2026-10-16，工作台 §32）：一级只表达「想做什么」，具体选择在二级，
     执行仍走各自原有的 Owner。菜单框架本身的契约在 composerAttachMenu.spec.tsx 里单独锁，
     这里补的是「真实路由下确实接到既有能力」这一段。 */
  it("「+」里没有目录行：目录入口归协作页目录细条（2026-10-19 撤出弹层）", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", stub(options));
    const view = await mountWorkbench("/agent");
    try {
      await view.wrapper.get('[data-testid="assist-attach"]').trigger("click");
      await flush();
      // 一级只剩四项；目录与「更换目录」只由目录细条一处承担，弹层里不再放第二个入口。
      for (const key of ["sources", "skill", "command", "connectors"]) {
        expect(document.querySelector(`[data-testid="assist-attach-${key}"]`)).not.toBeNull();
      }
      expect(document.querySelector('[data-testid="assist-attach-folder"]')).toBeNull();
      expect(document.querySelector('[data-testid="assist-attach-folder-pick"]')).toBeNull();
      // 细条仍在，且是活的：目录名即入口。
      expect(document.querySelector('[data-testid="folder-scope-strip"]')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("「+」命令二级：清单读真实登记，点击只把命令填进首条草稿", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", stub(options));
    const view = await mountWorkbench("/agent");
    try {
      await view.wrapper.get('[data-testid="assist-attach"]').trigger("click");
      await flush();
      await view.wrapper.get('[data-testid="assist-attach-command"]').trigger("click");
      await flush();
      expect(document.querySelector('[data-testid="assist-attach-command-review"]')?.textContent)
        .toContain("/review · 代码审查");
      await view.wrapper.get('[data-testid="assist-attach-command-review"]').trigger("click");
      await flush();
      // 只编辑草稿：不发送、不建会话，用户仍可继续改写这条命令。
      expect((document.querySelector('[data-testid="assist-first-draft"]') as HTMLTextAreaElement).value)
        .toBe("/review ");
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("从就地入口建完助手：弹窗收起、入口消失、chip 更新，全程不创建会话", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await view.wrapper.get('[data-testid="assist-assistant-create-entry"]').trigger("click");
      await flush();
      await assistantDialogEl("assist-assistant-name").setValue("审读");
      await assistantDialogEl("assist-assistant-role").setValue("只读复核这份改动");
      await assistantDialogEl("assist-assistant-save").trigger("click");
      await flush(80);
      expect(assistantDialogOpen()).toBe(false);
      expect(view.wrapper.find('[data-testid="assist-assistant-create-entry"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').text()).toContain("审读 · v1");
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("有可用助手时新建入口不再就地出现，只留在弹窗里", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      expect(view.wrapper.find('[data-testid="assist-assistant-create-entry"]').exists()).toBe(false);
      await openAssistantConfig(view);
      expect(assistantDialogEl("assist-assistant-create-toggle").exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("清单读取失败时新建入口同样就地可见，与弹窗里「可以先新建助手」的说法一致", async () => {
    const options: Stub = { sessions: [], posts: [],
      profileList: () => json({ code: "SERVICE_UNAVAILABLE", detail: "暂不可读" }, 503) };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      expect(view.wrapper.get('[data-testid="assist-assistant-create-entry"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("首条助手档隐藏普通讨论入口；没有可用身份时按钮、Enter 与 submit 都被拦截", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      expect(view.wrapper.get('[data-testid="assist-first-message"]').find("details.agent-chat-options").exists()).toBe(false);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("没有助手时不得创建会话");
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBe("");
      expect(view.wrapper.get('[data-testid="assist-first-blocked"]').text()).toContain("先新建一个");
      await draft.trigger("keydown", { key: "Enter" });
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(80);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("助手清单读取失败时保留错误并提供重读，不能建首条会话", async () => {
    const options: Stub = { sessions: [], posts: [],
      profileList: () => json({ code: "SERVICE_UNAVAILABLE", detail: "暂不可读" }, 503) };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await openAssistantConfig(view);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("读取失败时不得创建会话");
      expect(assistantDialogEl('assist-assistant-list-error').text()).toContain("暂不可读");
      expect(assistantDialogEl('assist-assistant-list-reload').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBe("");
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(80);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("助手清单仍在加载时不能通过 Enter 新建首条会话", async () => {
    let finishProfiles!: (response: Response) => void;
    const profileResponse = new Promise<Response>((resolve) => { finishProfiles = resolve; });
    const options: Stub = { sessions: [], posts: [], profileList: () => profileResponse };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      // 清单还在读取时无从判断「没有助手」，就地入口要等读取结束再决定去留。
      expect(view.wrapper.find('[data-testid="assist-assistant-create-entry"]').exists()).toBe(false);
      await openAssistantConfig(view);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("加载中不得创建会话");
      expect(assistantDialogEl('assist-assistant-list-loading').exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBe("");
      await draft.trigger("keydown", { key: "Enter" });
      await flush(80);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally {
      finishProfiles(json({ items: [profile()] }));
      await flush();
      view.unmount();
    }
  });

  it("首条助手消息使用有效助手身份并省略普通 intent 与 Skill 字段", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("只读复核这份改动");
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(120);
      const create = options.posts.find((post) => post.path === `${prefix}/assist-sessions`);
      expect(create?.body).toMatchObject({ conversation_mode: "ASSISTANT", assistant_profile_id: assistantProfileId });
      const messagePost = options.posts.find((post) => post.path.endsWith("/messages"));
      expect(messagePost?.body).toMatchObject({ content: "只读复核这份改动" });
      expect(messagePost?.body).not.toHaveProperty("intent");
      expect(messagePost?.body).not.toHaveProperty("skill_ref");
      expect(options.posts.some((post) => post.path.endsWith("/execution-requests"))).toBe(false);
    } finally { view.unmount(); }
  });

  it("首条普通档保留普通讨论入口，切档保留草稿且仍按普通消息提交", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    try {
      expect(view.wrapper.get('[data-testid="assist-first-message"]').find("details.agent-chat-options").exists()).toBe(true);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("首条草稿切档后保留");
      await flipToAssistant(view);
      expect((draft.element as HTMLTextAreaElement).value).toBe("首条草稿切档后保留");
      expect(view.wrapper.get('[data-testid="assist-first-message"]').find("details.agent-chat-options").exists()).toBe(false);
      await chooseMode(view, "AGENT");
      await flush(80);
      expect((draft.element as HTMLTextAreaElement).value).toBe("首条草稿切档后保留");
      expect(view.wrapper.get('[data-testid="assist-first-message"]').find("details.agent-chat-options").exists()).toBe(true);
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(120);
      const create = options.posts.find((post) => post.path === `${prefix}/assist-sessions`);
      expect(create?.body).toMatchObject({ conversation_mode: "AGENT" });
      const sent = options.posts.find((post) => post.path.endsWith("/messages"));
      expect(sent?.body).toMatchObject({ content: "首条草稿切档后保留", intent: "DISCUSS" });
    } finally { view.unmount(); }
  });

  it.each([
    { label: "只剩已归档助手", profiles: [profile({ status: "ARCHIVED" })], invalidId: null,
      reason: "当前没有可用助手" },
    { label: "所选 ID 已不在可用清单", profiles: [profile()], invalidId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      reason: "所选助手已归档或不在当前可用清单中" }
  ])("首条助手档在$label 时阻止所有新建入口", async ({ profiles, invalidId, reason }) => {
    const options: Stub = { sessions: [], posts: [], profiles };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await openAssistantConfig(view);
      if (invalidId !== null) await assistantDialogEl('assist-assistant-picker').setValue(invalidId);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("无效助手身份不得发送");
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBe("");
      expect(view.wrapper.get('[data-testid="assist-first-blocked"]').text()).toContain(reason);
      if (profiles[0] && (profiles[0] as { status?: string }).status === "ARCHIVED") {
        expect(assistantDialogEl('assist-assistant-list-empty').text()).toContain("重新读取助手清单");
        expect(assistantDialogEl('assist-assistant-list-reload').exists()).toBe(true);
      }
      await draft.trigger("keydown", { key: "Enter" });
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(80);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("建会话回执不确定时按原命令恢复助手身份，不随当前选择变化", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [profile(), profile({
      id: createdProfileId, name: "编辑", role_description: "从编辑角度复核" })], loseCreateResponse: true };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await pickAssistant(view, assistantProfileId);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("原命令必须保留第一位助手");
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(100);
      const firstCreate = options.posts.find((post) => post.path === `${prefix}/assist-sessions`);
      expect(firstCreate?.body.assistant_profile_id).toBe(assistantProfileId);
      expect(view.wrapper.get('[data-testid="assist-first-create-retry"]').exists()).toBe(true);

      await pickAssistant(view, createdProfileId);
      await view.wrapper.get('[data-testid="assist-first-create-retry"]').trigger("click");
      await flush(160);
      const createPosts = options.posts.filter((post) => post.path === `${prefix}/assist-sessions`);
      expect(createPosts).toHaveLength(2);
      expect(createPosts[1]?.body).toEqual(firstCreate?.body);
      const sent = options.posts.find((post) => post.path.endsWith("/messages"));
      expect(sent?.body).toMatchObject({ content: "原命令必须保留第一位助手" });
      expect(sent?.body).not.toHaveProperty("intent");
      expect(sent?.body).not.toHaveProperty("skill_ref");
    } finally { view.unmount(); }
  });

  it("首条助手消息响应丢失后重试保持原消息 ID 和无 intent 载荷", async () => {
    const options: Stub = { sessions: [], posts: [], profiles: [profile(), profile({
      id: createdProfileId, name: "编辑", role_description: "从编辑角度复核" })], loseFirstMessageResponse: true };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await pickAssistant(view, assistantProfileId);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("重试不新增 intent");
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(140);
      const firstSend = options.posts.find((post) => post.path.endsWith("/messages"));
      expect(firstSend?.body).toMatchObject({ content: "重试不新增 intent" });
      expect(firstSend?.body).not.toHaveProperty("intent");
      expect(view.wrapper.get('[data-testid="assist-first-retry"]').exists()).toBe(true);
      await pickAssistant(view, createdProfileId);
      await view.wrapper.get('[data-testid="assist-first-retry"]').trigger("click");
      await flush(120);
      const sends = options.posts.filter((post) => post.path.endsWith("/messages"));
      expect(sends).toHaveLength(2);
      expect(sends[1]?.body).toEqual(firstSend?.body);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("助手档消息按冻结人设标注，不写「AI」", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [],
      withMessages: [assistantSessionId] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    expect(view.wrapper.get('[data-testid="assist-persona-label"]').text()).toBe("审读 · 人设 v3");
    view.unmount();
  });

  it("助手档不渲染提案入口，因为这一档没有 Task", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [],
      withMessages: [assistantSessionId] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    expect(view.wrapper.find(".assist-proposal").exists()).toBe(false);
    view.unmount();
  });

  it("助手档发送不带 intent 也不带 skill_ref", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("这份改动有没有问题");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
    await flush(80);
    const sent = options.posts.find((post) => post.path.endsWith("/messages"));
    expect(sent?.body).toMatchObject({ content: "这份改动有没有问题" });
    expect(sent?.body).not.toHaveProperty("intent");
    expect(sent?.body).not.toHaveProperty("skill_ref");
    view.unmount();
  });

  it("有在途回复时两档都禁用切换，不靠切档隐式取消", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [],
      inflightSessionId: assistantSessionId };
    const view = await openAgent(options);
    // 到达那条在途会话走顶栏「切换讨论」，不再靠切档：原生 select 时代 `setValue` 会绕过
    // disabled 发 change，那一步只在测试里成立；自绘浮层按真实语义挡住后必须先换一种到达方式。
    await switchToolbarSession(assistantSessionId);
    // 禁用落在芯片与三行上：原生 details 没有 disabled，因此读作 aria-disabled，点击在组件里挡住。
    expect(view.wrapper.get('[data-testid="conversation-mode-select"]').attributes("aria-disabled")).toBe("true");
    expect(view.wrapper.get('[data-testid="conversation-mode-option-AGENT"]').attributes("aria-disabled")).toBe("true");
    expect(view.wrapper.get('[data-testid="conversation-mode-locked"]').text()).toContain("停止后才能切换");
    // 2026-10-17：原因原文同时挂在模式盒的 title 上（悬停可读），可见行已转视觉隐藏。
    expect(view.wrapper.get('[data-testid="conversation-mode"]').attributes("title")).toContain("停止后才能切换");
    view.unmount();
  });

  /**
   * 2026-10-16 布局回归（两轮）。用户先报「执行中输入框布局乱掉」，再按截图指认
   * 「这些都导致输入框变化了」——档位锁定原因、学习/助手档说明、命令回执原先都渲染在
   * 输入卡内部，卡片于是随状态长高、变矮，用户正在打字的光标与工具行跟着跳。
   *
   * 现在的契约：**卡内恒定只有正文、工具行与发送键**；模式说明与回执都在卡外这一列里
   * （`.agent-chat-mode-hints` 与 `.receipt-message` 作为 `.agent-assist` 列的子项）。
   * 说明行也不能退回模式盒：模式盒是 auto 宽 + `flex-wrap` 的内联 flex，长文本会让它
   * 按可用宽度撑开（真实 Chromium 实测 241px → 483px、两行）把 chip 挤到别的行。
   * jsdom 不做布局，所以这里锁的是结构不变式（父子关系与卡内子项清单），几何证据见验收表该行。
   */
  it("在途时输入卡不变形：锁定原因与档位说明都在卡外", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [],
      inflightSessionId: agentSessionId };
    const view = await openAgent(options);
    try {
      const card = view.wrapper.get('[data-testid="assist-composer"]');
      expect([...card.element!.children].map((element) => element.className.split(" ")[0]))
        .toEqual(["agent-chat-composer-spark", "agent-chat-message-form", "agent-chat-composer-actions"]);
      const locked = view.wrapper.get('[data-testid="conversation-mode-locked"]');
      expect(locked.element?.closest(".agent-chat-composer")).toBeNull();
      expect(locked.element?.closest(".agent-chat-mode")).toBeNull();
      expect(locked.element?.parentElement?.classList.contains("agent-chat-mode-hints")).toBe(true);
      expect(locked.element?.classList.contains("disabled-reason")).toBe(true);
      // 2026-10-17（用户指认执行中「不要弹出这个东西，整个布局都被他打乱了」）：锁定原因
      // 不再占一行可见文字，转为视觉隐藏——在途开始/结束时卡下方这一列不增减可见行。
      expect(locked.element?.classList.contains("visually-hidden")).toBe(true);
    } finally { view.unmount(); }
  });

  it("收到命令回执时输入卡同样不变形：回执在卡外", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("/undo");
      await view.wrapper.get('[data-testid="assist-composer"] form').trigger("submit");
      await flush(60);
      const card = view.wrapper.get('[data-testid="assist-composer"]');
      expect([...card.element!.children].map((element) => element.className.split(" ")[0]))
        .toEqual(["agent-chat-composer-spark", "agent-chat-message-form", "agent-chat-composer-actions"]);
      const receipt = document.querySelector('[data-testid="assist-receipt-notice"]');
      expect(receipt?.textContent ?? "").toContain("撤回本次调整");
      // 2026-10-17：回执从「卡外的一条正文」变成 body 上的浮层栈条目，
      // 因此它既不在输入卡内，也不再占文档流——卡的高度与它出现与否无关。
      expect(receipt?.closest(".agent-chat-composer")).toBeNull();
    } finally { view.unmount(); }
  });

  it("学习档与助手档的常驻说明也在卡外", async () => {
    const options: Stub = { sessions: [agentSession(), learningSession(), assistantSession()], posts: [],
      withMessages: [learningSessionId] };
    const view = await openAgent(options);
    try {
      await chooseMode(view, "LEARNING");
      await flush(80);
      const learning = view.wrapper.get('[data-testid="learning-readonly-note"]');
      expect(learning.element?.closest(".agent-chat-composer")).toBeNull();
      expect(learning.element?.closest(".agent-chat-mode")).toBeNull();
      expect(learning.element?.parentElement?.classList.contains("agent-chat-mode-hints")).toBe(true);
      await flipToAssistant(view);
      const assistant = view.wrapper.get('[data-testid="assist-readonly-note"]');
      expect(assistant.element?.closest(".agent-chat-composer")).toBeNull();
      expect(assistant.element?.closest(".agent-chat-mode")).toBeNull();
      expect(assistant.element?.parentElement?.classList.contains("agent-chat-mode-hints")).toBe(true);
    } finally { view.unmount(); }
  });

  it("消息底栏：复制键排在用量左侧，因此左缘与正文左缘对齐", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [], withMessages: [agentSessionId] };
    const view = await openAgent(options);
    try {
      // 同一排的先后就是左缘的依据：flex 行首第一项贴着正文左缘，用量跟在它后面。
      const children = Array.from(view.wrapper.get(".agent-message-footer").element?.children ?? []);
      expect(children.map((element) => element.className.split(" ")[0])).toEqual(["icon-button", "helper-text"]);
      expect(children[0]!.getAttribute("data-testid")).toContain("assist-copy-");
      expect(children[1]!.getAttribute("data-testid")).toContain("assist-usage-");
    } finally { view.unmount(); }
  });

  it("助手档不渲染暂停与人工接管入口", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [],
      withMessages: [assistantSessionId] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    expect(view.wrapper.find('[data-testid="assist-handoff"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-pause"]').exists()).toBe(false);
    view.unmount();
  });

  it("新建助手直接落库，并在成功后选中它", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("保存助手不能提交这条首条草稿");
    await openAssistantConfig(view);
    await assistantDialogEl('assist-assistant-create-toggle').trigger("click");
    await assistantDialogEl('assist-assistant-name').setValue("审读");
    await assistantDialogEl('assist-assistant-role').setValue("只读复核这份改动");
    await assistantDialogEl('assist-assistant-scope').setValue("src; tests");
    await assistantDialogEl('assist-assistant-save').trigger("click");
    await flush(80);
    const created = options.posts.find((post) => post.path === `${prefix}/assistant-profiles`);
    // 只读范围只能缩小受管根：提交的是受管根内相对路径，不是绝对路径。
    expect(created?.body).toMatchObject({ name: "审读", role_description: "只读复核这份改动",
      read_scope: { roots: ["src", "tests"] } });
    expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
      post.path.endsWith("/messages"))).toHaveLength(0);
    // 新建成功后直接选中它并收起弹窗，否则用户会看到「助手已建但当前仍无身份」，
    // 或以为还要自己关掉遮罩才能继续。新助手是 v1，与清单里那条 v3 可分辨。
    expect(assistantDialogOpen()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').text()).toContain("审读 · v1");
    expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
      .toBe("保存助手不能提交这条首条草稿");
    view.unmount();
  });

  it("迟到的初次助手清单不能覆盖刚创建并选中的有效身份", async () => {
    let finishProfiles!: (response: Response) => void;
    const profileResponse = new Promise<Response>((resolve) => { finishProfiles = resolve; });
    const options: Stub = { sessions: [], posts: [], profileList: () => profileResponse };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await openAssistantConfig(view);
      expect(assistantDialogEl('assist-assistant-list-loading').exists()).toBe(true);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("使用刚创建的助手");
      await assistantDialogEl('assist-assistant-create-toggle').trigger("click");
      await assistantDialogEl('assist-assistant-name').setValue("新审读");
      await assistantDialogEl('assist-assistant-role').setValue("只读复核");
      await assistantDialogEl('assist-assistant-save').trigger("click");
      await flush(80);
      expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').text()).toContain("新审读 · v1");
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);

      finishProfiles(json({ items: [profile()] }));
      await flush(80);
      expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').text()).toContain("新审读 · v1");
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBeUndefined();
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(120);
      const create = options.posts.find((post) => post.path === `${prefix}/assist-sessions`);
      expect(create?.body).toMatchObject({ conversation_mode: "ASSISTANT", assistant_profile_id: createdProfileId });
    } finally {
      finishProfiles(json({ items: [profile()] }));
      await flush();
      view.unmount();
    }
  });

  it("助手清单读不到时说明原因，不把空下拉当成「你没有助手」", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/assistant-profiles` && (init?.method ?? "GET") === "GET") {
        return json({ code: "SERVICE_UNAVAILABLE", detail: "暂不可读" }, 503);
      }
      return stub(options)(input, init);
    }));
    const view = await mountWorkbench("/agent");
    await openWorkingDirectory("D:/tmp/probe");
    await flipToAssistant(view);
    // 读不到清单时 chip 先说清是读取失败而不是「你没有助手」，原因正文在配置弹窗里。
    expect(view.wrapper.get('[data-testid="assist-assistant-config-toggle"]').text()).toContain("助手清单读取失败");
    await openAssistantConfig(view);
    expect(assistantDialogEl('assist-assistant-list-error').text()).toContain("助手清单暂不可读");
    view.unmount();
  });

  it("已建会话内切档直接生效：草稿按会话留在原处，切回时原样恢复", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    try {
      // 默认落在普通会话上（顶栏左翼只显示会话名）。
      expect(toolbarSessionTitle()).toBe("普通会话");
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("切档前未发送的草稿");
      await flipToAssistant(view);
      // 不再弹「未发送的内容」：直接切到助手会话，草稿留在普通会话，不跟过去。
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(toolbarSessionTitle()).toBe("人设会话");
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("");

      // 切回普通档：草稿按会话留在本机，原样恢复；全程不建会话、不发消息。
      await chooseMode(view, "AGENT");
      expect(toolbarSessionTitle()).toBe("普通会话");
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
        .toBe("切档前未发送的草稿");
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("首条输入法合成中 Enter 不发送，普通 Enter 才发送", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await pickAssistant(view, assistantProfileId);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("合成中的中文");
      // 合成态（isComposing / keyCode 229）下的回车只是确认候选，不得提交。
      for (const init of [{ key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 }]) {
        await act(async () => {
          draft.element!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
        });
        await flush(40);
        expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
          post.path.endsWith("/messages"))).toHaveLength(0);
      }
      // 非合成回车才真正发送。
      await act(async () => {
        draft.element!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
      });
      await flush(120);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(1);
    } finally { view.unmount(); }
  });
});
