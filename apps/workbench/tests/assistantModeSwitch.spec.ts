import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

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
  /** 哪些会话有一条已完成的助手消息；人设标签要落在消息行上才有东西可断言。 */
  withMessages?: readonly string[];
  inflightSessionId?: string;
}

function stub(options: Stub) {
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
    if (path === `${prefix}/assistant-profiles`) return json({ items: [profile()] });
    if (path === `${prefix}/assist-sessions`) return json({ items: options.sessions });
    const messages = path.match(/^\/api\/v1\/workspaces\/[0-9a-f-]+\/assist-sessions\/([0-9a-f-]+)\/messages$/u);
    if (messages) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ command_id: body.command_id, committed_at: "2026-10-06T00:00:00Z",
          result: { session_id: messages[1], user_message_id: "77777777-7777-4777-8777-777777777777",
            assistant_message_id: "88888888-8888-4888-8888-888888888888" } }, 202);
      }
      if (options.inflightSessionId === messages[1]) {
        return json({ items: [{ ...message(messages[1]!), id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "RUNNING", content: null, cancel_requested: false }] });
      }
      return json({ items: options.withMessages?.includes(messages[1] ?? "") === true
        ? [message(messages[1]!)] : [] });
    }
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return json({ items: [] });
    if (path === `${prefix}/assist-proposals`) return json({ items: [] });
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
  await view.wrapper.get('[data-testid="folder-manual-root"]').setValue("D:/tmp/probe");
  await flush();
  await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
  await flush(80);
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
  it("两档都渲染，普通档标签不承诺尚未实现的子 Agent 派发", async () => {
    const options: Stub = { sessions: [agentSession()], posts: [] };
    const view = await openAgent(options);
    const radios = view.wrapper.findAll('[data-testid="conversation-mode"] input[type="radio"]')
      .map((item) => item.attributes("value"));
    expect(radios).toEqual(["AGENT", "ASSISTANT"]);
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
    // 新建成功后直接选中它，否则用户会看到「助手已建但当前仍无身份」。
    expect(selectValue("assist-assistant-picker")).toBe(createdProfileId);
    view.unmount();
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
    await view.wrapper.get('[data-testid="folder-manual-root"]').setValue("D:/tmp/probe");
    await flush();
    await view.wrapper.get('[data-testid="folder-open-manual"]').trigger("click");
    await flush(80);
    await flipToAssistant(view);
    expect(view.wrapper.get('[data-testid="assist-assistant-list-error"]').text()).toContain("助手清单暂不可读");
    view.unmount();
  });
});
