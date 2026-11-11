import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

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
    created_at: "2026-11-01T06:59:00Z", updated_at: "2026-11-01T06:59:00Z" };
}
type Stage = "WAITING_MODEL" | "MODEL_STREAMING" | "MODEL_OUTPUT" | "PROCESSING";
function stage(phase: Stage) {
  return {
    phase,
    call_count: 1,
    latest_call: {
      status: phase === "PROCESSING" ? "COMPLETED" : "STARTED",
      started_at: "2026-11-01T07:00:00.000Z",
      first_stream_event_at: phase === "WAITING_MODEL" ? null : "2026-11-01T07:00:01.000Z",
      first_text_delta_at: phase === "WAITING_MODEL" || phase === "MODEL_STREAMING"
        ? null : "2026-11-01T07:00:03.000Z",
      first_preview_persisted_at: null,
      settled_at: phase === "PROCESSING" ? "2026-11-01T07:00:05.000Z" : null,
    },
  };
}
function message(status: string, content: string | null = null,
  generationProgress: unknown = stage("WAITING_MODEL")) {
  return { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT",
    status, intent: "DISCUSS", content, error_code: null, sources: [], skill: null,
    usage: { input_tokens: null, output_tokens: null }, cancel_requested: false,
    created_at: "2026-11-01T06:59:58.000Z", updated_at: "2026-11-01T07:00:05.000Z",
    generation_progress: status === "RUNNING" ? generationProgress : null };
}
function preview(text: string | null, status = "RUNNING") {
  return { session_id: sessionId, message_id: messageId, status,
    preview_revision: text === null ? "0" : "1", preview_text: text,
    preview_truncated: false, preview_available: status === "RUNNING", usage: null };
}
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

function install(holder: { status: string; content?: string | null; progress: unknown;
  previewText?: string | null }) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
      message(holder.status, holder.content ?? null, holder.progress)] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`)
      return response(preview(holder.previewText ?? null));
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/tool-calls`)
      return response({ session_id: sessionId, message_id: messageId,
        message_status: holder.status, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/todos`) return response({ snapshot: null });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    throw new Error(`unexpected request ${path}`);
  }));
}

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("在途回复的阶段行", () => {
  it("按服务端阶段切换文案，不按等待时长猜模型是否响应", async () => {
    connect();
    const holder = { status: "RUNNING", progress: stage("WAITING_MODEL") };
    install(holder);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    const line = () => view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`);
    expect(line().text()).toBe("等待模型响应");
    expect(view.wrapper.find(`[data-testid="assist-inflight-${messageId}"]`).attributes("data-phase"))
      .toBe("WAITING_MODEL");
    // 聊天流只有一行阶段：逐段耗时不再就地展开，原始时间戳随会话导出提供。
    expect(view.wrapper.text()).not.toContain("延迟诊断");
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).element
      ?.closest("details") ?? null).toBeNull();

    holder.progress = stage("MODEL_STREAMING");
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
    await flush();
    expect(line().text()).toBe("模型已响应，等待正文");

    holder.progress = stage("MODEL_OUTPUT");
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
    await flush();
    expect(line().text()).toBe("已收到模型输出，正在整理为回复");
  });

  it("PENDING 说等待处理；正文出现后阶段行让位", async () => {
    connect();
    const holder = { status: "PENDING", progress: null as unknown,
      previewText: null as string | null, content: null as string | null };
    install(holder);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).text()).toBe("等待处理");
    expect(view.wrapper.text()).not.toContain("正在生成回复");

    holder.status = "RUNNING";
    holder.progress = stage("WAITING_MODEL");
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
    await flush();
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).text())
      .toBe("等待模型响应");

    holder.previewText = "已经出现的一段草稿";
    await flush(450);
    // 草稿可见后阶段行整行卸下；草稿末尾仍保留唯一的 inline 三点。
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.find(".assist-inflight-dots").exists()).toBe(true);
    expect(view.wrapper.text()).toContain("已经出现的一段草稿");

    holder.status = "COMPLETED"; holder.content = "最终完整回复"; holder.progress = null;
    holder.previewText = null;
    await flush(1_700);
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.text()).toContain("最终完整回复");
  });

  it("取消中不显示阶段行，由 meta 行的取消说明接管", async () => {
    connect();
    const holder = { status: "RUNNING", progress: stage("WAITING_MODEL") };
    install(holder);
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(true);
    // 取消意图是消息行事实：改成 cancel_requested 后阶段行必须撤下。
    const messageBody = message("RUNNING");
    messageBody.cancel_requested = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
        return response({ items: [messageBody] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`)
        return response(preview(null));
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/tool-calls`)
        return response({ session_id: sessionId, message_id: messageId,
          message_status: "RUNNING", rounds: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/todos`) return response({ snapshot: null });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click");
    await flush();
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.text()).toContain("正在生成（正在取消）");
  });
});
