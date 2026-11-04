import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { readLastModel, writeLastModel } from "../src/lib/modelPreferences";
import { clickPortal, DomWrapper, flush, folderStripName, mountWorkbench, openUnresolvedDialog } from "./mountApp";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const root = `/api/v1/workspaces/${workspaceId}`;
/* 顶栏右翼的「新建会话」已整条删除（2026-10-17 工作空间级、2026-10-18 任务/目录归属，均为
   用户指令）：作用域内另开会话只剩目录细条浮层里的「新对话」，所以「会话内新建」的不变量改在
   那条路径上验证：同一份 deferSessionCreation 与首条命令 owner，换入口不换语义。 */
const taskId = "33333333-3333-4333-8333-333333333333";
const taskProjectId = "22222222-2222-4222-8222-222222222222";
const taskSessionId = "77777777-7777-4777-8777-777777777777";
const taskSession = { id: taskSessionId, workspace_id: workspaceId, project_id: taskProjectId, task_id: taskId,
  title: "任务内的会话", status: "ACTIVE", revision: "1", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" };
const oldSession = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
  title: "已有普通讨论", status: "ACTIVE", revision: "1", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" };
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
async function mount(path = "/agent", withOldSession = false,
  failure?: "CREATE_RESPONSE_LOST" | "MESSAGE_RESPONSE_LOST" | "MODEL_SELECTION_RESPONSE_LOST", withTaskSession = false, messageGate?: Promise<void>,
  withConnection = false) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
  const posts: { path: string; body: Record<string, unknown> }[] = []; let created = false;
  const messages: unknown[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  let modelSelected = false;
  /** 首条选择的已登记连接：型号由服务端按连接声明解析，客户端只报 connection_id。 */
  const connectionId = "44444444-4444-4444-8444-444444444444";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({ path, body });
      if (path === `${root}/assist-sessions/${sessionId}/model-selection`) {
        const receipt = { command_id: body.command_id, command_type: "SelectSessionConnection", payload_hash: "a".repeat(64),
          committed_at: "2026-11-02T00:00:00Z",
          result: { kind: "MODEL_SELECTION", session_id: sessionId, connection: "registered",
            connection_id: connectionId, model: "vendor/registered", free_only: false, revision: "3" } };
        receipts.set(String(body.command_id), receipt);
        return response(receipt);
      }
      if (path.endsWith("/chat-commands")) {
        const firstSelection = !modelSelected; modelSelected = true;
        const receipt = { command_id: body.command_id, committed_at: "2026-10-17T00:00:00Z",
          result: { kind: "MODEL_SELECTION", session_id: sessionId, connection: "openrouter",
            model: "v/a:free", free_only: true, revision: "7" } };
        receipts.set(String(body.command_id), { ...receipt, command_type: "SelectSessionModel" });
        if (failure === "MODEL_SELECTION_RESPONSE_LOST" && firstSelection) throw new TypeError("selection response lost");
        return response(receipt);
      }
      if (path === `${root}/assist-sessions`) {
        created = true;
        const receipt = { command_id: body.command_id, command_type: "CreateAssistSession", payload_hash: "a".repeat(64),
          committed_at: "2026-10-05T00:00:00Z", result: { session_id: sessionId, ...oldSession } };
        receipts.set(String(body.command_id), receipt);
        if (failure === "CREATE_RESPONSE_LOST") throw new TypeError("response lost");
        return response(receipt, 201);
      }
      if (path === `${root}/assist-sessions/${sessionId}/messages`) {
        await messageGate;
        const index = messages.length / 2 + 1;
        messages.push({ id: `u${index}`, session_id: sessionId, seq: String(index * 2 - 1), role: "USER",
          status: "COMPLETED", intent: "DISCUSS", content: body.content, error_code: null,
          sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false },
        { id: `a${index}`, session_id: sessionId, seq: String(index * 2), role: "ASSISTANT",
          status: "COMPLETED", intent: "DISCUSS", content: `第 ${index} 条回复`, error_code: null,
          sources: [], usage: { input_tokens: 10, output_tokens: 5 }, cancel_requested: false });
        const receipt = { command_id: body.command_id, command_type: "RequestAssistMessage", payload_hash: "a".repeat(64),
          committed_at: "2026-10-05T00:00:00Z",
          result: { session_id: sessionId, user_message_id: `u${index}`, assistant_message_id: `a${index}` } };
        receipts.set(String(body.command_id), receipt);
        if (failure === "MESSAGE_RESPONSE_LOST") throw new TypeError("response lost");
        return response(receipt, 202);
      }
      throw new Error(`Unexpected command: ${path}`);
    }
    if (path === `${root}/assist-sessions`) return response({ items: [
      ...(withTaskSession ? [{ ...oldSession, id: "88888888-8888-4888-8888-888888888888",
        task_id: taskId, title: "无项目任务的专属会话" }, taskSession] : []),
      ...(withOldSession || created ? [oldSession] : [])] });
    if (path.endsWith("/model-selection")) return response({ selection: modelSelected ? {
      session_id: sessionId, connection: "openrouter", model: "v/a:free", free_only: true, revision: "7" } : null });
    if (path.endsWith("/model-port")) return response({ provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path.endsWith("/model-connections/chat-default"))
      return response({ connection_id: null, revision: null });
    if (path.endsWith("/model-connections")) return response({ items: withConnection ? [{
      id: connectionId, name: "团队网关", provider_kind: "openai-compatible",
      base_url: "https://fixture.invalid/v1", default_model: "vendor/registered",
      budget: { timeout_ms: 30000, max_output_tokens: 4096, max_call_tokens: 65536,
        max_scope_calls: 30, max_scope_tokens: 512000 },
      credential_version: 1, status: "ACTIVE", revision: "1",
      created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" }] : [] });
    if (path.endsWith("/model-catalog")) return response({ configured: true, chat_configured: true,
      snapshot_seq: "9", last_success_at: "2026-10-17T00:00:00Z", last_failure_reason: null, cache_stale: false, free_count: 1,
      entries: [{ source_model_id: "v/a:free", display_name: "免费 A", context_window: 65536, is_free: true,
        capabilities: { tools: true, text_input: true, text_output: true } }] });
    if (path === `${root}/assist-sessions/${sessionId}`) return response(oldSession);
    if (path === `${root}/assist-sessions/${taskSessionId}`) return response(taskSession);
    if (path === `${root}/tasks/${taskId}`) return response({ id: taskId, project_id: taskProjectId,
      title: "任务内的会话", status: "IN_PROGRESS", mode: "ME", revision: "1",
      created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" }, current_completion_id: null,
      waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "1", objective: "只读夹具。", source: "CREATE",
        created_at: "2026-10-05T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${root}/projects/${taskProjectId}`) return response({ id: taskProjectId, title: "任务会话入口项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path.startsWith(`${root}/commands/`)) return response(receipts.get(path.split("/").at(-1)!) ?? {}, 200);
    if (path.endsWith("/messages")) return response({ items: messages });
    if (path.endsWith("/skills")) return response({ items: [] });
    return response({ items: [], next_cursor: null });
  }));
  const view = await mountWorkbench(path); unmount = view.unmount; await flush(80);
  return { ...view, posts };
}

describe("新对话直接起步", () => {
  it.each(["retry", "receipt"])("首条选免费模型先绑定后发送，选择回执丢失通过 %s 沿原命令接续并携带原版本", async (recovery) => {
    const view = await mount("/agent?new=entry", false, "MODEL_SELECTION_RESPONSE_LOST");
    await view.wrapper.get('[data-testid="model-selector-open"]').trigger("click"); await flush();
    // 首条场景点清单条目即写入本地草稿，不再经过确认键；下拉不是对话框。
    const option = [...document.querySelectorAll<HTMLButtonElement>('.model-selector-menu [role="option"]')]
      .find((item) => item.querySelector(".model-selector-option-name")?.textContent === "免费 A")!;
    await act(async () => option.click()); await flush();
    expect(view.posts).toHaveLength(0);
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("首条使用我选择的免费模型");
    await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit"); await flush();
    expect(view.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(0);
    // 模型选择响应丢失后命令未决：核对与重试出口在正文状态行点开的弹窗里。
    await openUnresolvedDialog("assist-first-pending");
    await clickPortal(`assist-first-${recovery}`); await flush();
    const selections = view.posts.filter((post) => post.path.endsWith("/chat-commands"));
    // P0-B（2026-11-04）：回执核对证明模型选择已落库后，后续恢复不得再提交一次已确认的
    // 前置命令；只有「按原命令重试」这条明确重放路径才重新提交同一份载荷。
    expect(selections).toHaveLength(recovery === "retry" ? 2 : 1);
    if (recovery === "retry") expect(selections[1]?.body).toEqual(selections[0]?.body);
    expect(view.posts.filter((post) => post.path === `${root}/assist-sessions`)).toHaveLength(1);
    expect(view.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(1);
    expect(view.posts.find((post) => post.path.endsWith("/messages"))?.body).toMatchObject({ expected_model_selection_revision: "7" });
  });
  it("无项目任务的专属会话不会混入普通讨论", async () => {
    const view = await mount("/agent", false, undefined, true);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.text()).not.toContain("无项目任务的专属会话");
    expect(view.posts).toHaveLength(0);
  });
  /**
   * MODEL-SETTINGS-03（P0-4）取代 2026-10-20 的「记住上次模型」：
   * 本机历史偏好不得悄悄覆盖工作区默认连接。新会话在没有显式选择时显示「跟随默认」，
   * 并且**不提交** SelectSessionModel——优先级由服务端按
   * 「会话显式选择 > 工作区聊天默认 > 进程默认」解析。
   */
  it("本机历史偏好不覆盖默认：新对话显示跟随默认，首条发送不提交模型选择", async () => {
    writeLastModel(workspaceId, "v/a:free");
    const view = await mount("/agent?new=entry");
    const triggerName = view.wrapper.get('[data-testid="model-selector-open"] .model-selector-trigger-name');
    expect(triggerName.text()).toBe("跟随默认");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("按工作区默认发送");
    await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit"); await flush();
    expect(view.posts.filter((post) => post.path === `${root}/assist-sessions`)).toHaveLength(1);
    // 没有显式选择就不发选择命令；消息也不带 expected_model_selection_revision。
    expect(view.posts.filter((post) => post.path.endsWith("/chat-commands"))).toHaveLength(0);
    expect(view.posts.find((post) => post.path.endsWith("/messages"))?.body)
      .not.toHaveProperty("expected_model_selection_revision");
  });
  it("首条选择已登记连接：只提交 connection_id，消息携带该连接声明的型号修订", async () => {
    const view = await mount("/agent?new=conn", false, undefined, false, undefined, true);
    const chip = () => document
      .querySelector('[data-testid="model-selector-open"] .model-selector-trigger-name')?.textContent ?? "";
    await view.wrapper.get('[data-testid="model-selector-open"]').trigger("click"); await flush();
    expect(document.body.textContent).toContain("已登记连接");
    const option = [...document.querySelectorAll<HTMLButtonElement>('.model-selector-menu [role="option"]')]
      .find((item) => item.querySelector(".model-selector-option-name")?.textContent === "团队网关")!;
    await act(async () => option.click()); await flush();
    expect(chip()).toBe("vendor/registered");
    // 连接选择不写本机偏好：下一条新会话不能用 /model 解析别的连接身份。
    expect(readLastModel(workspaceId)).toBeNull();
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("首条走团队网关");
    await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit"); await flush();
    const selections = view.posts.filter((post) => post.path.endsWith("/model-selection"));
    expect(selections).toHaveLength(1);
    expect(selections[0]?.body).toMatchObject({ connection_id: "44444444-4444-4444-8444-444444444444" });
    expect(selections[0]?.body).not.toHaveProperty("model");
    expect(view.posts.find((post) => post.path.endsWith("/messages"))?.body)
      .toMatchObject({ expected_model_selection_revision: "3" });
  });
  it("首条选择只作用于本会话，不写本机偏好；下一条新对话仍跟随默认", async () => {
    const first = await mount("/agent?new=entry");
    await first.wrapper.get('[data-testid="model-selector-open"]').trigger("click"); await flush();
    const option = [...document.querySelectorAll<HTMLButtonElement>('.model-selector-menu [role="option"]')]
      .find((item) => item.querySelector(".model-selector-option-name")?.textContent === "免费 A")!;
    await act(async () => option.click()); await flush();
    // 显式选择仍是本会话的草稿选择，但不落本机存储。
    expect(readLastModel(workspaceId)).toBeNull();
    first.unmount();
    const second = await mount("/agent?new=second");
    const secondChip = () => second.wrapper
      .get('[data-testid="model-selector-open"] .model-selector-trigger-name').text();
    expect(secondChip()).toBe("跟随默认");
    second.unmount();
  });
  // 2026-10-21 接续：上一条用例覆盖「重新挂载那一拍的 useState 种子」，这一条覆盖挂在它
  // 后面的那次重置——协作页的新对话 effect 会把首条输入器清成空白，模型偏好不能跟着一起被抹。
  // 用户实机指认「每次点新建会话，模型芯片又变回『模型』两个字」。
  it("同页再点「新对话」：清空草稿并把芯片重置为跟随默认，不继承上一条的显式选择", async () => {
    const view = await mount("/agent?new=entry");
    const chip = () => document
      .querySelector('[data-testid="model-selector-open"] .model-selector-trigger-name')?.textContent ?? "";
    expect(chip()).toBe("跟随默认");
    // 先在首条输入器里写字，再开一次新对话：草稿要清空，型号要留下。
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("这段不该带进下一条"); await flush();
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush(120);
    expect((document.querySelector('[data-testid="assist-first-draft"]') as HTMLTextAreaElement | null)?.value)
      .toBe("");
    expect(chip(), "新对话重置后应回到跟随默认，而不是保留上一条会话的显式选择")
      .toBe("跟随默认");
  });
  it("回到同一个新对话地址恢复未发送草稿；换新键保持空白且不串写", async () => {
    const firstDraft = () => document
      .querySelector<HTMLTextAreaElement>('[data-testid="assist-first-draft"]')?.value ?? null;
    const view = await mount("/agent?new=draft-a", true);
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("保留的草稿 A，请勿发送"); await flush();
    expect(firstDraft()).toBe("保留的草稿 A，请勿发送");
    // A → 已有会话 → 后退回同一个 ?new= 键：正文逐字恢复。
    await view.router.push(`/agent?session=${sessionId}`); await flush(120);
    await view.router.back(); await flush(120);
    expect(firstDraft()).toBe("保留的草稿 A，请勿发送");
    // A → 新的 ?new= 键：空白；返回 A 仍恢复，不能把 A 的正文先写进 B。
    await view.router.push("/agent?new=draft-b"); await flush(120);
    expect(firstDraft()).toBe("");
    await view.router.back(); await flush(120);
    expect(firstDraft()).toBe("保留的草稿 A，请勿发送");
    // 重新挂载同一键：从本机草稿恢复，而不是被新对话初始化清空。
    view.unmount(); unmount = null;
    const remount = await mount("/agent?new=draft-a"); unmount = remount.unmount;
    expect(firstDraft()).toBe("保留的草稿 A，请勿发送");
  });
  it("明确新对话不恢复旧会话；空白页只有输入主区，目录与已有任务按需展开", async () => {
    const view = await mount("/agent?new=entry", true);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists(), view.wrapper.text()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="collab-side-empty"]').exists()).toBe(false);
    // 目录作用域已收成常驻细条（不再是要先展开的 details）；栏底「查找更多任务 / 会话」
    // 入口已按用户决定删除（2026-10-16 第四轮），左栏行是任务与会话的唯一导航入口。
    expect(view.wrapper.get('[data-testid="folder-scope-strip"]').exists()).toBe(true);
    expect(folderStripName()).toBe("选择工作目录");
    // 写入档位入口不因未选目录而消失（用户实机截图回归）：芯片读作「不可写入」这句权限结论，
    // 而不是整颗隐藏；目录状态由上方细条承担（2026-10-18 用户指认芯片只读权限；
    // 2026-10-21 措辞修正：原「未开放写入」会被读成一个没开发的档位）。
    expect(view.wrapper.get('[data-testid="write-permission-chip"]').text()).toContain("不可写入");
    expect(view.wrapper.find('[data-testid="recent-work-find-more"]').exists()).toBe(false);
    expect(view.posts).toHaveLength(0);
  });

  it("全局新对话可重复打开真正的空白输入，不创建空会话", async () => {
    const view = await mount("/agent", true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists(), view.wrapper.text()).toBe(true);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    const firstHref = view.wrapper.get('[data-testid="context-new-conversation"]').attributes("href");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="context-new-conversation"]').attributes("href")).not.toBe(firstHref);
    expect(view.posts).toHaveLength(0);
  });

  it("没有项目或目录也能直接发送，首条只建一次会话并保存原文，不发执行请求", async () => {
    const view = await mount("/agent?new=entry");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("先帮我想清楚下一步");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush(); await flush();
    expect(view.posts.map(p => p.path)).toEqual([`${root}/assist-sessions`, `${root}/assist-sessions/${sessionId}/messages`]);
    expect(view.posts[0]?.body.project_id).toBeNull(); expect(view.posts[0]?.body.task_id).toBeNull();
    expect(view.posts[1]?.body.content).toBe("先帮我想清楚下一步");
    expect(view.posts[1]?.body.intent).toBe("DISCUSS");
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第 1 条回复");
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("接着讨论刚才的想法");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click"); await flush(); await flush();
    expect(view.posts.map(p => p.path)).toEqual([`${root}/assist-sessions`,
      `${root}/assist-sessions/${sessionId}/messages`, `${root}/assist-sessions/${sessionId}/messages`]);
    expect(view.posts[2]?.body.intent).toBe("DISCUSS");
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第 2 条回复");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.posts).toHaveLength(3);
  });

  it("会话内新建同样先打开输入框，不提前创建空会话", async () => {
    // 顶栏右翼的「新建会话」已按用户指令删除（2026-10-18）：作用域内另开会话只剩目录细条
    // 浮层这一条路径，它和左栏「新对话」共用同一个离开保护 Owner，换入口不换语义。
    const view = await mount(`/agent?work=${taskId}&session=${taskSessionId}`, false, undefined, true);
    await view.wrapper.get('[data-testid="folder-scope-change"]').trigger("click"); await flush();
    await expect(view.wrapper.find('[data-testid="collab-new-conversation"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="collab-new-conversation"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.posts).toHaveLength(0);
  });

  it("会话先读到空列表、首条稍后提交时，送达后自动读到消息", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const view = await mount("/agent?new=entry", false, undefined, false, gate);
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("稍后送达的首条消息");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
    // 首条在途：事实由发送状态行独自承担，对话区不摆「还没有消息。」那行空态——
    // 2026-10-23 用户截图指认它把在途读成空会话（先显示空页、之后才是对话）。
    expect(view.wrapper.get('[data-testid="assist-first-pending"]').attributes("data-state")).toBe("sending");
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).not.toContain("还没有消息");
    release(); await flush(); await flush();
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("稍后送达的首条消息");
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第 1 条回复");
    expect(view.posts).toHaveLength(2);
  });

  it("未决首条命令收口前另开新对话：不静默新建，迟到原响应只收口一次", async () => {
    /* 顶栏改左右两翼后，工作空间级讨论不再有「新建会话」（与左栏「新对话」重复），
       本轮这颗键只在任务/目录归属的顶栏保留。此例因此改从左栏「新对话」另开——
       验证的仍是同一条不变量（迟到响应不得清空新草稿），但入口换了，不再覆盖
       「同一实例内就地新建」这一档；就地新建仍由上一例在有归属的顶栏上守住。 */
    const view = await mount("/agent?new=entry");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const result = await original(input, init);
      if (init?.method === "POST" && String(input).endsWith("/messages")) await gate;
      return result;
    }));
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("原会话的首条消息");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
    // 2026-11-03 用户指令：行内「查询回执」按钮已删除，在途状态行不再提供核对入口，
    // 因此本用例改为「未决首条命令仍在时另开新对话」：迟到原响应同样不得清空新草稿。
    expect(view.wrapper.find('[data-testid="assist-first-receipt"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    // 未决命令未收口：不静默另开新对话，弹层只给「留在本页」这一个出口。
    // 在途（IN_FLIGHT）与结果未知（UNRESOLVED）用不同文案，但都不能离开。
    const dialogText = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(dialogText).toMatch(/命令正在提交|命令结果待核对/);
    expect(document.querySelector('[data-testid="pending-keep-and-leave"]')).toBeNull();
    const keep = Array.from(document.querySelectorAll("button"))
      .find(button => ["留在本页等待结果", "留在本页核对回执"].includes(button.textContent?.trim() ?? ""));
    expect(keep).toBeDefined();
    await new DomWrapper(keep!).trigger("click"); await flush();
    release(); await flush(); await flush();
    // 迟到原响应照常收口：只解释一次，也不复活已收口的 pending。
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    expect(view.posts.filter(post => post.path === `${root}/assist-sessions`)).toHaveLength(1);
    expect(view.posts.filter(post => post.path.endsWith("/messages"))).toHaveLength(1);
  });

  it("新对话不丢未发送输入：直接进入空白新对话，不继承上一处正文", async () => {
    const view = await mount("/agent?new=entry");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("还没有发送的想法");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush(80);
    // 不再弹确认：直接进入新对话，新对话是空白输入，不继承上一处的正文；
    // 原作用域的草稿留在本机（跨路由恢复由 folderFirstConversation 的「反例 P2」覆盖）。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value).toBe("");
    expect(view.posts).toHaveLength(0);
  });

  it("MESSAGE_RESPONSE_LOST：不打开核对弹窗也会按原回执自动收口，不产生第二条消息", async () => {
    const view = await mount("/agent?new=entry", false, "MESSAGE_RESPONSE_LOST");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("响应丢失但服务端已落库");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    // P0-B：消息命令已落库、响应丢失时，按原 command_id 自动核对并收口；
    // 不打开弹窗也不留下「首条消息还没有确认送达」。
    await flush(600);
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-first-transition"]').exists()).toBe(false);
    const transcript = view.wrapper.get('[data-testid="assist-transcript"]').text();
    expect(transcript).toContain("响应丢失但服务端已落库");
    expect(transcript.split("响应丢失但服务端已落库").length - 1).toBe(1);
    expect(view.posts.filter(p => p.path.endsWith("/messages"))).toHaveLength(1);
    expect(view.posts.filter(p => p.path === `${root}/assist-sessions`)).toHaveLength(1);
  });

  it("CREATE_RESPONSE_LOST：新对话不得丢弃未决命令，核对原回执后接续普通讨论", async () => {
    const view = await mount("/agent?new=entry", false, "CREATE_RESPONSE_LOST");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("保留这条原始消息");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("命令结果待核对");
    expect(document.querySelector('[data-testid="discard-draft-leave"]')).toBeNull();
    // 无任务作用域的首条命令没进本页恢复区：离开即丢核对入口，弹层不提供离开出口。
    expect(document.querySelector('[data-testid="pending-keep-and-leave"]')).toBeNull();
    const keep = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "留在本页核对回执");
    keep!.click(); await flush();
    // 未决命令在正文只留一行状态；核对弹窗从那一行点开（不再自动弹出，也不再把细节铺在正文）。
    await openUnresolvedDialog("assist-first-create-pending");
    const check = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "查询创建回执");
    expect(check).toBeDefined(); await new DomWrapper(check!).trigger("click"); await flush(); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    expect(view.posts.filter(p => p.path === `${root}/assist-sessions`)).toHaveLength(1);
    expect(view.posts.filter(p => p.path.endsWith("/messages"))).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("保留这条原始消息");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
  });
});
