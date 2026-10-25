import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 回复生命周期：草稿 → 最终正文的交接（2026-10-25 综合优化 P0）。
 *
 * 服务端在结算那一句 UPDATE 里同时写 status 与 content，所以「终态预览帧」与「正文可读」
 * 之间差的只是一次 GET messages。这段空档此前的呈现是：草稿被整块删掉 → 露出一行三点 →
 * 正文出现。读起来是「内容消失又长出来」，还夹着一次假的在途状态。
 *
 * 这里钉四条口径：
 *   * 终态帧到达但正文未读回时，最后一次草稿**留在同一个阅读区**，标记改成「正在核对最终正文」；
 *     不显示三点（那会假装还在生成），也不把草稿说成最终内容。
 *   * 只有 GET messages 读回终态**且带正文**时才交接；交接后的内容只出现一次。
 *   * 那次重读失败时标「状态待核对」并给重读入口，不假装完成。
 *   * 失败/取消/失权不交接：立即清掉草稿，多留一帧就是把失效内容当结论。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "原会话", status: "ACTIVE", revision: "1",
    created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" };
}

function message(status = "RUNNING", content: string | null = null) {
  return { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT", status,
    intent: "DISCUSS", content, error_code: null, sources: [], skill: null,
    usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}

function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

type Stream = ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();
function frame(status: string, text: string | null): Uint8Array {
  return encoder.encode(`id: 1\nevent: assist_preview\ndata: ${JSON.stringify({ session_id: sessionId,
    message_id: messageId, status, preview_revision: text === null ? "0" : "1",
    preview_text: text, preview_truncated: false, preview_available: status === "RUNNING" })}\n\n`);
}

/** 一套统一的路由桩：消息列表与预览流可控，其余端点给最小空体。 */
function install(options: {
  messages: () => Promise<Response> | Response;
  previewStream?: (controller: Stream) => void;
}) {
  const fetchMock = vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return options.messages();
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview/events`) {
      return { ok: true, status: 200, headers: { get: () => "text/event-stream" },
        body: new ReadableStream<Uint8Array>({ start(controller) { options.previewStream?.(controller); } })
      } as unknown as Response;
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`)
      return response({ session_id: sessionId, message_id: messageId, status: "RUNNING",
        preview_revision: "1", preview_text: "轮询到的草稿", preview_truncated: false,
        preview_available: true });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    return response({ items: [], next_cursor: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("草稿到最终正文的交接", () => {
  it("终态帧到达但正文未读回：草稿留在原位并标核对中，三点撤掉；读回后只出现最终正文", async () => {
    connect();
    let finished = false;
    let hold = false;
    let release: ((value: Response) => void) | null = null;
    let stream: Stream | undefined;
    install({
      messages: () => hold
        ? new Promise<Response>((resolve) => { release = resolve; })
        : response({ items: [message(finished ? "COMPLETED" : "RUNNING",
          finished ? "## 最终回复\n\n这是核对之后的完整正文。" : null)] }),
      previewStream: (controller) => { stream = controller; }
    });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(stream).toBeDefined();

    stream!.enqueue(frame("RUNNING", "草稿：先写了一段还没结束的话"));
    await flush(60);
    expect(view.wrapper.text()).toContain("生成中草稿");
    expect(view.wrapper.text()).toContain("草稿：先写了一段还没结束的话");
    expect(view.wrapper.find(".assist-inflight-dots").exists()).toBe(true);

    // 终态帧：正文还差一次 GET messages（这一次故意挂住）。
    finished = true; hold = true;
    stream!.enqueue(frame("COMPLETED", null));
    await flush(60);
    const verifying = view.wrapper.get(`[data-testid="assist-reply-verify-${messageId}"]`);
    expect(verifying.attributes("data-state")).toBe("verifying");
    expect(verifying.text()).toContain("正在核对最终正文");
    // 草稿继续可读：不出现「草稿没了、正文还没来」的空白。
    expect(verifying.text()).toContain("草稿：先写了一段还没结束的话");
    // 但不能再装作还在生成。
    expect(view.wrapper.find(".assist-inflight-dots").exists()).toBe(false);
    expect(view.wrapper.text()).toContain("正在核对最终回复");
    expect(view.wrapper.find(`[data-testid="assist-live-preview-${messageId}"]`).exists()).toBe(false);

    // 正文读回：交接成立，且只出现最终内容一次。
    hold = false;
    release!(response({ items: [message("COMPLETED", "## 最终回复\n\n这是核对之后的完整正文。")] }));
    await flush(60);
    const final = view.wrapper.get(`[data-testid="assist-reply-final-${messageId}"]`);
    expect(final.attributes("data-state")).toBe("final");
    expect(final.attributes("data-handover")).toBe("true");
    expect(final.text()).toContain("这是核对之后的完整正文");
    expect(view.wrapper.find(`[data-testid="assist-reply-verify-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.text()).not.toContain("草稿：先写了一段还没结束的话");
    expect(view.wrapper.findAll(`[data-testid="assist-reply-final-${messageId}"]`)).toHaveLength(1);
  });

  it("正文那次重读失败：标状态待核对并给重读入口，重读成功后交接", async () => {
    connect();
    let broken = false;
    let finished = false;
    let stream: Stream | undefined;
    install({
      messages: async () => {
        if (broken) throw new TypeError("messages connection lost");
        return response({ items: [message(finished ? "COMPLETED" : "RUNNING",
          finished ? "重读后拿到的最终正文" : null)] });
      },
      previewStream: (controller) => { stream = controller; }
    });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    stream!.enqueue(frame("RUNNING", "待核对的草稿正文"));
    await flush(60);

    broken = true;
    stream!.enqueue(frame("COMPLETED", null));
    await flush(120);
    const verifying = view.wrapper.get(`[data-testid="assist-reply-verify-${messageId}"]`);
    expect(verifying.text()).toContain("状态待核对");
    expect(verifying.text()).toContain("待核对的草稿正文");
    expect(view.wrapper.text()).toContain("状态待核对");
    // 列表还在（网络不明不等于没有消息），并明确说明这份是上次读到的。
    expect(view.wrapper.find(`[data-testid="assist-transcript-error"]`).text()).toContain("可能已过期");

    broken = false; finished = true;
    await verifying.find(`[data-testid="assist-verify-final-${messageId}"]`).trigger("click");
    await flush(80);
    expect(view.wrapper.get(`[data-testid="assist-reply-final-${messageId}"]`).text())
      .toContain("重读后拿到的最终正文");
    expect(view.wrapper.find(`[data-testid="assist-reply-verify-${messageId}"]`).exists()).toBe(false);
  });

  it("失败终态不交接：草稿立即清掉，不保留失效内容", async () => {
    connect();
    let stream: Stream | undefined;
    install({ messages: () => response({ items: [message("RUNNING", null)] }),
      previewStream: (controller) => { stream = controller; } });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    stream!.enqueue(frame("RUNNING", "这一段后来失败了"));
    await flush(60);
    expect(view.wrapper.text()).toContain("这一段后来失败了");
    stream!.enqueue(frame("FAILED", null));
    await flush(80);
    expect(view.wrapper.text()).not.toContain("这一段后来失败了");
    expect(view.wrapper.find(`[data-testid="assist-reply-verify-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.find(".assist-inflight-dots").exists()).toBe(false);
  });

  it("失权时连过渡草稿一起清空：不为了一段淡入保留未授权内容", async () => {
    connect();
    let revoked = false;
    let stream: Stream | undefined;
    install({
      messages: () => revoked
        ? Promise.resolve(response({ code: "FORBIDDEN", detail: "revoked" }, 403))
        : Promise.resolve(response({ items: [message("RUNNING", null)] })),
      previewStream: (controller) => { stream = controller; }
    });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    stream!.enqueue(frame("RUNNING", "只在授权时可见的草稿"));
    await flush(60);
    expect(view.wrapper.text()).toContain("只在授权时可见的草稿");
    revoked = true;
    stream!.enqueue(frame("COMPLETED", null));
    await flush(120);
    expect(view.wrapper.find(".assist-message").exists()).toBe(false);
    expect(view.wrapper.text()).not.toContain("只在授权时可见的草稿");
  });

  it("终态是真的但没有正文：明说一句，不留一块解释不清的空白", async () => {
    connect();
    let stream: Stream | undefined;
    let finished = false;
    install({
      messages: () => response({ items: [finished
        ? message("COMPLETED", null) : message("RUNNING", null)] }),
      previewStream: (controller) => { stream = controller; }
    });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    stream!.enqueue(frame("RUNNING", "短暂的草稿"));
    await flush(60);
    finished = true;
    stream!.enqueue(frame("COMPLETED", null));
    await flush(80);
    expect(view.wrapper.get(`[data-testid="assist-empty-reply-${messageId}"]`).text())
      .toContain("没有可显示的正文");
    expect(view.wrapper.text()).not.toContain("短暂的草稿");
  });
});
