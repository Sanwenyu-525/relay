import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { dialogText, flush, mountWorkbench, openUnresolvedDialog } from "./mountApp";

/**
 * 首条消息从「创建会话」到「回复完成」的过渡（2026-10-30）。
 *
 * 用户实机反馈：新会话发出首条后，欢迎页消失、标题出现、标题下方一行「正在发送首条消息…」，
 * 而**中央消息区整块空白**，看不到自己发了什么，也看不到 AI 在做什么。
 * 根因是这段空窗里那条用户消息没有任何可见位置：它不在 messages 里（服务端还没投影），
 * 首条输入器又已经换成了会话输入器。这一层锁的是修好后的状态机：
 *
 *   创建中        → 首条输入器仍在，原文可读（不出现空白页）；
 *   会话已建·发送中 → 过渡行显示原文与「发送中」，状态行挂在**这条消息上**；
 *   202 已回·投影未到 → 过渡行留下，状态改成「已送达 · 正在读取」；
 *   投影读回      → 过渡行卸载，真实消息行就位，正文只有一份（去重）；
 *   明确失败      → 过渡行给原因，原文可放回输入框改写重发；
 *   结果不明      → 原命令身份保留，核对入口仍可达。
 *
 * 真实几何与配色由 Chromium 用例取证（tests/browser/firstMessageTransitionLayout.spec.ts）；
 * 这里只锁客户端状态机与「每个状态都有可读内容」。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sessionRow(chatMode = "CHAT") {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "关于Relay-Agent", status: "ACTIVE", revision: "1", working_resource_id: null,
    conversation_mode: "AGENT", chat_mode: chatMode,
    context: { project_goals: [], working_directory: null },
    created_at: "2026-10-30T01:00:00Z", updated_at: "2026-10-30T01:00:00Z" };
}

function userMessage(content: string) {
  return { id: "u-1", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED",
    intent: "DISCUSS", created_at: "2026-10-30T01:00:00Z", updated_at: "2026-10-30T01:00:00Z",
    content, error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, attachments: [], withdrawn_at: null, withdrawn_by_recall_id: null,
    recall: null, steer_requested: false,
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null } };
}

function assistantMessage(status: "PENDING" | "RUNNING" | "COMPLETED", content: string | null) {
  return { id: "a-1", session_id: sessionId, seq: "2", role: "ASSISTANT", status,
    intent: "DISCUSS", created_at: "2026-10-30T01:00:01Z", updated_at: "2026-10-30T01:00:02Z",
    content, error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, attachments: [], withdrawn_at: null, withdrawn_by_recall_id: null,
    recall: null, steer_requested: false,
    usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null, cache_creation_tokens: null } };
}

interface Gate { readonly promise: Promise<void>; readonly release: () => void }
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface Harness {
  createGate: Gate;
  messageGate: Gate;
  /** 服务端消息投影：测试自己决定它什么时候出现。 */
  projection: { items: unknown[] };
  /** 非 null 时消息命令被服务端明确拒绝（命令没有落库）。 */
  reject: { status: number; body: unknown } | null;
  /** 提交后丢响应：命令已落库，但前端拿不到回执。 */
  loseResponse: boolean;
  created: boolean;
  requests: string[];
  uploads: string[];
  messageBodies: Record<string, unknown>[];
  createBodies: Record<string, unknown>[];
}

function harness(over: Partial<Harness> = {}): Harness {
  return { createGate: gate(), messageGate: gate(), projection: { items: [] }, reject: null,
    loseResponse: false, created: false, requests: [], uploads: [], messageBodies: [],
    createBodies: [], ...over };
}

function stubFetch(h: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    h.requests.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (path === `${prefix}/assist-sessions`) {
        await h.createGate.promise;
        h.created = true; h.createBodies.push(body);
        return response({ command_id: body.command_id, committed_at: "2026-10-30T01:00:00Z",
          result: { session_id: sessionId, ...sessionRow(String(body.chat_mode ?? "CHAT")),
            created_at: "2026-10-30T01:00:00Z", updated_at: "2026-10-30T01:00:00Z" } }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/message-attachments`) {
        h.uploads.push(String(body.name));
        return response({ attachment_id: `att-${h.uploads.length}`, byte_length: 12,
          content_hash: "c".repeat(64) }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        h.messageBodies.push(body);
        await h.messageGate.promise;
        if (h.reject !== null) return response(h.reject.body, h.reject.status);
        if (h.loseResponse) throw new TypeError("response lost after commit");
        return response({ command_id: body.command_id, committed_at: "2026-10-30T01:00:02Z",
          result: { session_id: sessionId, user_message_id: "u-1", assistant_message_id: "a-1" } }, 202);
      }
      throw new Error(`unexpected POST ${path}`);
    }
    if (path === `${prefix}/assist-sessions`) return response({ items: h.created ? [sessionRow()] : [] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response(sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: h.projection.items });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return response({ model: null, revision: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff`) {
      return response({ available: false, reason: "NO_BASELINE" });
    }
    if (path === `${prefix}/model-port`) {
      return response({ provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    }
    if (path.startsWith(`${prefix}/commands/`)) return response({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    return response({ items: [], next_cursor: null });
  });
}

/** 文本里出现了几次 needle（用来证明「没有第二条重复的用户消息」）。 */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function transitionRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="assist-first-transition"]');
}

/** jsdom 没有剪贴板实现：造一个带 clipboardData 的 paste 事件，走输入器既有附件入口。 */
async function pasteFile(target: Element, file: File): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    files: [file], types: ["Files"] } });
  await act(async () => { target.dispatchEvent(event); });
}

beforeEach(() => { window.localStorage.clear(); document.documentElement.dataset.motion = "on"; });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

async function start(h: Harness, text: string) {
  vi.stubGlobal("fetch", stubFetch(h));
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
  const view = await mountWorkbench("/agent?new=transition");
  await flush(200);
  await view.wrapper.get('[data-testid="assist-first-draft"]').setValue(text);
  await flush();
  await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
  await flush(0);
  return view;
}

describe("首条消息的过渡状态（不空白、不重复、不伪造）", () => {
  it("创建中保留原文；会话建好后过渡行显示原文与发送中；202 后转「已送达」；投影读回后去重", async () => {
    const h = harness();
    const view = await start(h, "在根目录下创建一个aa.md");
    try {
      // ① 创建会话在途：首条输入器仍在，原文可读——不是一块空白页。
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
        .toBe("在根目录下创建一个aa.md");
      expect(transitionRow()).toBeNull();

      // ② 会话已建、消息命令在途：同一条消息以过渡行出现在消息时间线里。
      h.createGate.release();
      await flush(120); await flush();
      const sending = transitionRow();
      expect(sending, "会话建好后消息区必须有可读内容").not.toBeNull();
      expect(sending!.getAttribute("data-phase")).toBe("sending");
      expect(sending!.textContent).toContain("在根目录下创建一个aa.md");
      expect(sending!.querySelector('[data-testid="assist-first-transition-state"]')!.textContent).toBe("发送中");
      // 状态行属于这条消息，而不是会话标题下方另起的一行。
      expect(sending!.querySelector('[data-testid="assist-first-pending"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="assist-first-pending"]')!.closest('[data-testid="assist-first-transition"]'))
        .not.toBeNull();
      // 欢迎页与「还没有消息。」都不与在途事实同时出现。
      expect(document.querySelector('[data-testid="assist-empty-welcome"]')).toBeNull();
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).not.toContain("还没有消息");

      // ③ 202 回执已到、消息投影还没读回：过渡行留下，状态说清下一步。
      h.messageGate.release();
      await flush(160); await flush();
      const awaiting = transitionRow();
      expect(awaiting).not.toBeNull();
      expect(awaiting!.getAttribute("data-phase")).toBe("awaiting");
      expect(awaiting!.textContent).toContain("已送达");
      expect(awaiting!.textContent).toContain("在根目录下创建一个aa.md");
      expect(awaiting!.querySelector('[data-testid="assist-first-pending"]')).toBeNull();
      // 投影仍未到：这时刷新也不会把消息区读成空会话。
      await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
      await flush(80);
      expect(transitionRow()).not.toBeNull();
      expect(document.querySelector('[data-testid="assist-empty-welcome"]')).toBeNull();

      // ④ 真实消息读回：过渡行卸载，正文只出现一次（不产生重复用户消息）。
      h.projection.items = [userMessage("在根目录下创建一个aa.md"), assistantMessage("PENDING", null)];
      await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
      await flush(120);
      expect(transitionRow()).toBeNull();
      const transcript = view.wrapper.get('[data-testid="assist-transcript"]').text();
      expect(occurrences(transcript, "在根目录下创建一个aa.md")).toBe(1);
      // ⑤ AI 在跑：在途三点在回复行上，不在别处另起一块加载态。
      expect(document.querySelector('[data-testid="assist-inflight-a-1"]')).not.toBeNull();

      // ⑥ 完成：正文就位，进度动效停止。
      h.projection.items = [userMessage("在根目录下创建一个aa.md"),
        assistantMessage("COMPLETED", "已经创建 aa.md。")];
      await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
      await flush(120);
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("已经创建 aa.md。");
      expect(document.querySelector('[data-testid="assist-inflight-a-1"]')).toBeNull();
      expect(transitionRow()).toBeNull();
      // 全程只建了一个会话、只发了一条消息命令。
      expect(h.createBodies).toHaveLength(1);
      expect(h.messageBodies).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("明确失败：过渡行给出原因，原文可放回输入框改写重发", async () => {
    const h = harness({ reject: { status: 422, body: { code: "VALIDATION_FAILED",
      detail: "请求字段不满足端点契约。", retryable: false, retry_action: "NONE",
      field_errors: [{ field: "content", message: "内容超出当前模型限制。" }] } } });
    const view = await start(h, "这条会被拒绝的消息");
    try {
      h.createGate.release(); await flush(120);
      h.messageGate.release(); await flush(160); await flush();
      const failed = transitionRow();
      expect(failed, "明确失败也必须留下这条消息").not.toBeNull();
      expect(failed!.getAttribute("data-phase")).toBe("failed");
      expect(failed!.textContent).toContain("这条会被拒绝的消息");
      expect(failed!.querySelector('[data-testid="assist-first-transition-state"]')!.textContent).toBe("发送失败");
      // 明确拒绝没有可核对的结果：不得保留 command_id 或核对入口。
      expect(document.querySelector('[data-testid="assist-first-pending"]')).toBeNull();
      expect(document.querySelector('[data-testid="assist-first-receipt"]')).toBeNull();
      const reason = document.querySelector('[data-testid="assist-first-transition-reason"]')!.textContent ?? "";
      expect(reason).toContain("内容超出当前模型限制");

      // 恢复方式：原文回到会话输入器，用户改写后作为新命令重发。
      await view.wrapper.get('[data-testid="assist-first-transition-restore"]').trigger("click");
      await flush();
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
        .toBe("这条会被拒绝的消息");
      expect(transitionRow()).toBeNull();
      // 没有因为失败再建一次会话，也没有偷偷重发。
      expect(h.createBodies).toHaveLength(1);
      expect(h.messageBodies).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("结果不明：原命令身份与核对入口仍挂在消息上，重试不改命令 ID", async () => {
    const h = harness({ loseResponse: true });
    const view = await start(h, "这条命令的响应丢了");
    try {
      h.createGate.release(); await flush(120);
      h.messageGate.release(); await flush(160); await flush();
      const unresolved = transitionRow();
      expect(unresolved).not.toBeNull();
      expect(unresolved!.getAttribute("data-phase")).toBe("unresolved");
      expect(unresolved!.textContent).toContain("这条命令的响应丢了");
      // 未决命令的回执操作在正文里只有一行结论，完整身份在核对弹窗里。
      expect(unresolved!.querySelector('[data-testid="assist-first-pending"]')).not.toBeNull();
      expect(unresolved!.textContent).toContain("待核对");
      expect(unresolved!.textContent).not.toContain("已完成");
      await openUnresolvedDialog("assist-first-pending");
      expect(dialogText()).toContain(String(h.messageBodies[0]?.command_id));
      // 未决命令不重建会话。
      expect(h.createBodies).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("附件与 /plan 模式随同一份载荷进入过渡行，不只支持纯文本", async () => {
    const h = harness();
    vi.stubGlobal("fetch", stubFetch(h));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench("/agent?new=plan");
    try {
      await flush(200);
      const draft = view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement;
      await pasteFile(draft, new File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" }));
      await flush();
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("/plan 先给我一个方案");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush(0);
      h.createGate.release(); await flush(120); await flush();

      const row = transitionRow();
      expect(row).not.toBeNull();
      // 模式与附件都是这条消息载荷的一部分，过渡行必须一并承载。
      expect(row!.textContent).toContain("计划模式");
      expect(row!.textContent).toContain("screen.png");
      // `/plan` 是命令前缀，正文从它后面开始——原文照发，不把命令词塞进消息正文。
      expect(row!.textContent).toContain("先给我一个方案");
      // 载荷事实：会话按计划模式建立，消息带同一组附件 id。
      expect(h.createBodies[0]?.chat_mode).toBe("PLAN");
      expect(h.uploads).toEqual(["screen.png"]);
      h.messageGate.release(); await flush(160);
      expect(h.messageBodies[0]?.attachment_ids).toEqual(["att-1"]);
      expect(h.messageBodies[0]?.chat_mode).toBe("PLAN");
    } finally { view.unmount(); }
  });
});
