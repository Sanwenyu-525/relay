import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, dialogText, flush, mountWorkbench, openWorkingDirectory } from "./mountApp";

/**
 * 协作页聊天框的会话模式单选框与人设助手（工作台 §25、ADR-018、测试计划 §23.2）。
 *
 * 出口只有 jsdom 与 fetch 打桩。真实 Windows 窗口、原生 IME/DPI 与真实 Provider
 * 下的助手会话质量仍未验证，见统一功能验收表「会话模式与人设助手（2026-10-05）」行。
 *
 * 用 `/agent` 而不是项目子页：模式控件只在 standalone 的输入器工具行里，
 * 项目子页是嵌入式表单，没有那一行。
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

/** select 的当前值：React 写的是 DOM property，getAttribute 读不到。 */
function selectValue(testId: string): string {
  const element = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`selector not found: ${testId}`);
  return element.value;
}

/** 拨到助手档，等导航与面板挂载完。 */
async function flipToAssistant(view: Awaited<ReturnType<typeof openAgent>>) {
  await view.wrapper.get('[data-testid="assist-conversation-mode-assistant"]').setValue(true);
  await flush(80);
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
        await view.wrapper.get(`[data-testid="assist-conversation-mode-${mode.toLowerCase()}"]`).setValue(true);
        await flush(80);
      }
      await view.wrapper.get('[data-testid="assist-draft"]').setValue(command);
      await view.wrapper.get('[data-testid="assist-composer"] form').trigger("submit");
      await flush(100);
      expect(options.posts.filter((p) => p.path.endsWith("/chat-commands"))).toHaveLength(1);
      expect(options.posts.some((p) => p.path.endsWith("/messages") || p.path.endsWith("/interpret"))).toBe(false);
      expect(options.sessions).toHaveLength(2);
      expect(options.sessions[1]).toMatchObject({ id: createdSessionId, conversation_mode: mode,
        project_id: projectId, assistant_profile_id: source.assistant_profile_id });
      expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain(createdSessionId);
      expect(view.wrapper.find('[data-role="ASSISTANT"]').exists()).toBe(false);
      const labels = view.wrapper.get('[data-testid="assist-session-select"]').findAll("option")
        .map((option) => option.text()).filter((label) => label.includes(source.title));
      expect(labels).toHaveLength(2);
      expect(labels.every((label) => label.includes("更新"))).toBe(true);
      expect(labels.filter((label) => label.includes("当前"))).toHaveLength(1);
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
      expect(view.wrapper.get('[data-testid="assist-session"]').text()).toContain(createdSessionId);
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
      expect(view.wrapper.get('[data-testid="assist-receipt-notice"]').text()).toContain("撤回本次调整");
      expect(options.posts.filter((p) => !p.path.endsWith("/working-directories/open"))).toHaveLength(0);
    } finally { view.unmount(); }
  });
  it("明确转执行新建普通身份，带目标和方案，不改原学习会话", async () => {
    const options: Stub = { sessions: [agentSession(), learningSession()], posts: [], withMessages: [learningSessionId], withSources: true };
    const view = await openAgent(options);
    await view.wrapper.get('[data-testid="assist-conversation-mode-learning"]').setValue(true);
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
    await view.wrapper.get('[data-testid="assist-conversation-mode-learning"]').setValue(true);
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
    await view.wrapper.get('[data-testid="assist-conversation-mode-learning"]').setValue(true);
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
  it("三档都渲染，普通档标签不承诺尚未实现的子 Agent 派发", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    const radios = view.wrapper.findAll('[data-testid="conversation-mode"] input[type="radio"]')
      .map((item) => item.attributes("value"));
    expect(radios).toEqual(["AGENT", "ASSISTANT", "LEARNING"]);
    // ADR-017 的子 Agent 至今零代码，标签不能预先承诺。
    expect(view.wrapper.get('[data-testid="conversation-mode"]').text()).not.toContain("子 Agent");
    expect(view.wrapper.get('[data-testid="assist-conversation-mode-agent"]').attributes("checked")).toBe("");
    view.unmount();
  });

  it("默认按普通档解析，不虚构助手关系", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    expect(view.wrapper.get('[data-testid="assist-conversation-mode-agent"]').attributes("checked")).toBe("");
    expect(view.wrapper.find('[data-testid="assist-assistant-picker"]').exists()).toBe(false);
    view.unmount();
  });

  it("切档是导航到那条已有的助手会话：不建会话，也不改当前会话的身份", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    const before = options.posts.length;
    await flipToAssistant(view);
    // 建会话是写命令；切档如果偷偷建了一条，这里就会多一个 POST。
    expect(options.posts.slice(before).filter((post) => post.path === `${prefix}/assist-sessions`)).toHaveLength(0);
    // 落到了那一条已有的助手会话上，而不是另开一条。
    expect(selectValue("assist-assistant-picker")).toBe(assistantProfileId);
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
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("读取失败时不得创建会话");
      expect(view.wrapper.get('[data-testid="assist-assistant-list-error"]').text()).toContain("暂不可读");
      expect(view.wrapper.get('[data-testid="assist-assistant-list-reload"]').exists()).toBe(true);
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
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("加载中不得创建会话");
      expect(view.wrapper.get('[data-testid="assist-assistant-list-loading"]').exists()).toBe(true);
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
      await view.wrapper.get('[data-testid="assist-conversation-mode-agent"]').setValue(true);
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
      if (invalidId !== null) await view.wrapper.get('[data-testid="assist-assistant-picker"]').setValue(invalidId);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]');
      await draft.setValue("无效助手身份不得发送");
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBe("");
      expect(view.wrapper.get('[data-testid="assist-first-blocked"]').text()).toContain(reason);
      if (profiles[0] && (profiles[0] as { status?: string }).status === "ARCHIVED") {
        expect(view.wrapper.get('[data-testid="assist-assistant-list-empty"]').text()).toContain("重新读取助手清单");
        expect(view.wrapper.get('[data-testid="assist-assistant-list-reload"]').exists()).toBe(true);
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
      await view.wrapper.get('[data-testid="assist-assistant-picker"]').setValue(assistantProfileId);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("原命令必须保留第一位助手");
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(100);
      const firstCreate = options.posts.find((post) => post.path === `${prefix}/assist-sessions`);
      expect(firstCreate?.body.assistant_profile_id).toBe(assistantProfileId);
      expect(view.wrapper.get('[data-testid="assist-first-create-retry"]').exists()).toBe(true);

      await view.wrapper.get('[data-testid="assist-assistant-picker"]').setValue(createdProfileId);
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
      await view.wrapper.get('[data-testid="assist-assistant-picker"]').setValue(assistantProfileId);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("重试不新增 intent");
      await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit");
      await flush(140);
      const firstSend = options.posts.find((post) => post.path.endsWith("/messages"));
      expect(firstSend?.body).toMatchObject({ content: "重试不新增 intent" });
      expect(firstSend?.body).not.toHaveProperty("intent");
      expect(view.wrapper.get('[data-testid="assist-first-retry"]').exists()).toBe(true);
      await view.wrapper.get('[data-testid="assist-assistant-picker"]').setValue(createdProfileId);
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
    await flipToAssistant(view);
    // 整组禁用落在 fieldset 上：HTML 里这就是「这一组都不可选」，
    // 给每个 radio 再复制一份 disabled 只会多一个可能漂移的地方。
    expect(view.wrapper.get('[data-testid="conversation-mode"] fieldset').attributes("disabled")).toBe("");
    expect(view.wrapper.get('[data-testid="conversation-mode-locked"]').text()).toContain("停止后才能切换");
    view.unmount();
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
    await view.wrapper.get('[data-testid="assist-assistant-create-toggle"]').trigger("click");
    await view.wrapper.get('[data-testid="assist-assistant-name"]').setValue("审读");
    await view.wrapper.get('[data-testid="assist-assistant-role"]').setValue("只读复核这份改动");
    await view.wrapper.get('[data-testid="assist-assistant-scope"]').setValue("src; tests");
    await view.wrapper.get('[data-testid="assist-assistant-save"]').trigger("click");
    await flush(80);
    const created = options.posts.find((post) => post.path === `${prefix}/assistant-profiles`);
    // 只读范围只能缩小受管根：提交的是受管根内相对路径，不是绝对路径。
    expect(created?.body).toMatchObject({ name: "审读", role_description: "只读复核这份改动",
      read_scope: { roots: ["src", "tests"] } });
    expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
      post.path.endsWith("/messages"))).toHaveLength(0);
    // 新建成功后直接选中它，否则用户会看到「助手已建但当前仍无身份」。
    expect(selectValue("assist-assistant-picker")).toBe(createdProfileId);
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
      expect(view.wrapper.get('[data-testid="assist-assistant-list-loading"]').exists()).toBe(true);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("使用刚创建的助手");
      await view.wrapper.get('[data-testid="assist-assistant-create-toggle"]').trigger("click");
      await view.wrapper.get('[data-testid="assist-assistant-name"]').setValue("新审读");
      await view.wrapper.get('[data-testid="assist-assistant-role"]').setValue("只读复核");
      await view.wrapper.get('[data-testid="assist-assistant-save"]').trigger("click");
      await flush(80);
      expect(selectValue("assist-assistant-picker")).toBe(createdProfileId);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);

      finishProfiles(json({ items: [profile()] }));
      await flush(80);
      expect(selectValue("assist-assistant-picker")).toBe(createdProfileId);
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
    expect(view.wrapper.get('[data-testid="assist-assistant-list-error"]').text()).toContain("助手清单暂不可读");
    view.unmount();
  });

  it("已建会话内切档是导航：先走同一离页守卫，草稿留在原会话，明确丢弃才切", async () => {
    const options: Stub = { sessions: [agentSession(), assistantSession()], posts: [] };
    const view = await openAgent(options);
    try {
      // 默认落在普通会话上。
      expect(selectValue("assist-session-select")).toBe(agentSessionId);
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("切档前未发送的草稿");
      await flipToAssistant(view);
      // 有未发草稿时切档必须先经离页守卫：不静默丢草稿，也不静默换会话。
      expect(dialogText()).toContain("未发送的内容");
      expect(selectValue("assist-session-select")).toBe(agentSessionId);
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
        .toBe("切档前未发送的草稿");

      // 选择留下：不切档、草稿保留、零业务提交。
      const keep = Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("留在当前工作区"));
      await act(async () => { keep?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await flush(80);
      expect(selectValue("assist-session-select")).toBe(agentSessionId);
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
        .toBe("切档前未发送的草稿");

      // 明确丢弃后才真正导航到助手会话，且全程不建会话、不发消息。
      await flipToAssistant(view);
      const discard = document.querySelector('[data-testid="collab-discard-draft"]');
      expect(discard).not.toBeNull();
      await new DomWrapper(discard).trigger("click");
      await flush(120);
      expect(selectValue("assist-session-select")).toBe(assistantSessionId);
      expect(options.posts.filter((post) => post.path === `${prefix}/assist-sessions` ||
        post.path.endsWith("/messages"))).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("首条输入法合成中 Enter 不发送，普通 Enter 才发送", async () => {
    const options: Stub = { sessions: [], posts: [] };
    const view = await openAgent(options);
    await flipToAssistant(view);
    try {
      await view.wrapper.get('[data-testid="assist-assistant-picker"]').setValue(assistantProfileId);
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
