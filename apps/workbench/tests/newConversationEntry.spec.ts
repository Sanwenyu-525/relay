import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { readLastModel, writeLastModel } from "../src/lib/modelPreferences";
import { DomWrapper, flush, folderStripName, mountWorkbench } from "./mountApp";

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
  failure?: "CREATE_RESPONSE_LOST" | "MESSAGE_RESPONSE_LOST" | "MODEL_SELECTION_RESPONSE_LOST", withTaskSession = false, messageGate?: Promise<void>) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
  const posts: { path: string; body: Record<string, unknown> }[] = []; let created = false;
  const messages: unknown[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  let modelSelected = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({ path, body });
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
    await view.wrapper.get(`[data-testid="assist-first-${recovery}"]`).trigger("click"); await flush();
    const selections = view.posts.filter((post) => post.path.endsWith("/chat-commands"));
    expect(selections).toHaveLength(2);
    expect(selections[1]?.body).toEqual(selections[0]?.body);
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
  // 2026-10-20 用户指令「模型的话要持久化，要记住上一次选择的模型而不是每一个会话都先显示
  // 模型这两个字」：新对话的芯片初始就是上次选的型号，首条发送时按原命令绑定给新会话。
  it("新对话记住上一次选择的模型：芯片初始就是上次型号，首条发送按原命令绑定", async () => {
    writeLastModel(workspaceId, "v/a:free");
    const view = await mount("/agent?new=entry");
    const triggerName = view.wrapper.get('[data-testid="model-selector-open"] .model-selector-trigger-name');
    expect(triggerName.text()).toBe("v/a:free");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("沿用上次选择的模型发送");
    await view.wrapper.get('[data-testid="assist-first-message"] form').trigger("submit"); await flush();
    // 先建会话，再把上次选择按 SelectSessionModel 原命令落到这个会话，消息带期望修订。
    expect(view.posts.filter((post) => post.path === `${root}/assist-sessions`)).toHaveLength(1);
    const selections = view.posts.filter((post) => post.path.endsWith("/chat-commands"));
    expect(selections).toHaveLength(1);
    expect(selections[0]?.body).toMatchObject({ text: "/model v/a:free" });
    expect(view.posts.find((post) => post.path.endsWith("/messages"))?.body)
      .toMatchObject({ expected_model_selection_revision: "7" });
  });
  it("首条选择模型即写本机偏好；下一条新对话（重新挂载）从它开始", async () => {
    const first = await mount("/agent?new=entry");
    await first.wrapper.get('[data-testid="model-selector-open"]').trigger("click"); await flush();
    const option = [...document.querySelectorAll<HTMLButtonElement>('.model-selector-menu [role="option"]')]
      .find((item) => item.querySelector(".model-selector-option-name")?.textContent === "免费 A")!;
    await act(async () => option.click()); await flush();
    expect(readLastModel(workspaceId)).toBe("v/a:free");
    first.unmount();
    // 下一条新对话：路由按 ?new= 重新挂载，种子从本机偏好读回，不再是「模型」两个字。
    // 断言只锁芯片可见文字（用户指令原话是「不要每个新会话都先显示模型两个字」）：
    // 整页文字里本来就允许出现「模型」（如计量行的「尚无模型调用」），扫全页会假红。
    const second = await mount("/agent?new=second");
    const secondChip = () => second.wrapper
      .get('[data-testid="model-selector-open"] .model-selector-trigger-name').text();
    expect(secondChip()).toBe("v/a:free");
    expect(secondChip()).not.toBe("模型");
    second.unmount();
  });
  // 2026-10-21 接续：上一条用例覆盖「重新挂载那一拍的 useState 种子」，这一条覆盖挂在它
  // 后面的那次重置——协作页的新对话 effect 会把首条输入器清成空白，模型偏好不能跟着一起被抹。
  // 用户实机指认「每次点新建会话，模型芯片又变回『模型』两个字」。
  it("同页再点「新对话」：清空草稿但不退回「模型」占位，芯片仍按本机偏好起步", async () => {
    writeLastModel(workspaceId, "v/a:free");
    const view = await mount("/agent?new=entry");
    const chip = () => document
      .querySelector('[data-testid="model-selector-open"] .model-selector-trigger-name')?.textContent ?? "";
    expect(chip()).toBe("v/a:free");
    // 先在首条输入器里写字，再开一次新对话：草稿要清空，型号要留下。
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("这段不该带进下一条"); await flush();
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush(120);
    expect((document.querySelector('[data-testid="assist-first-draft"]') as HTMLTextAreaElement | null)?.value)
      .toBe("");
    expect(chip(), "新对话重置把模型偏好一起抹掉了，芯片退回「模型」占位").toBe("v/a:free");
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

  it("核对首条回执后另开新对话，迟到原响应不清空新草稿", async () => {
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
    await view.wrapper.get('[data-testid="assist-first-receipt"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("新会话还没发送的草稿");
    release(); await flush(); await flush();
    expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
      .toBe("新会话还没发送的草稿");
    expect(view.posts).toHaveLength(2);
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

  it.each(["CREATE_RESPONSE_LOST", "MESSAGE_RESPONSE_LOST"] as const)(
    "%s：新对话不得丢弃未决命令，核对原回执后接续普通讨论", async (failure) => {
      const view = await mount("/agent?new=entry", false, failure);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("保留这条原始消息");
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
      await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("命令结果待核对");
      expect(document.querySelector('[data-testid="discard-draft-leave"]')).toBeNull();
      const keep = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "保留并继续编辑");
      keep!.click(); await flush();
      const check = Array.from(view.wrapper.element!.querySelectorAll("button")).find(b =>
        b.textContent === (failure === "CREATE_RESPONSE_LOST" ? "查询创建回执" : "查询首条回执"));
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
