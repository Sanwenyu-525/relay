import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { clearSessionTranscriptCache, writeCachedSessionTranscript }
  from "../src/lib/sessionTranscriptCache";
import type { RelayAssistMessage } from "../src/api/relayClient";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 消息过程槽位（2026-11-10）。
 *
 * 用户反馈「一句你好留下回复已完成 + 查看执行过程两行」「生成/完成时闪一下」。
 * 这里锁住新的呈现口径：
 *   * 生成中没有工具时只有一行阶段文案，活动快照到达也不再多一块状态区；
 *   * clean COMPLETED（无工具、无异常）不保留任何常驻过程块；
 *   * 审批/UNKNOWN 等例外仍由消息级状态块常驻，不能被「简洁」吞掉；
 *   * 有工具时由 SessionRoundTrace 独占，状态块不重复列出同一次调用。
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
    title: "过程槽位会话", status: "ACTIVE", revision: "1",
    created_at: "2026-11-10T08:00:00Z", updated_at: "2026-11-10T08:00:00Z" };
}

function message(input: { status: "RUNNING" | "COMPLETED"; content?: string | null }) {
  return { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT",
    status: input.status, intent: "DISCUSS", content: input.content ?? null,
    error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, steer_requested: false, attachments: [],
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_creation_tokens: null },
    usage_summary: null,
    created_at: "2026-11-10T08:00:00Z", updated_at: "2026-11-10T08:00:06Z",
    generation_progress: input.status === "RUNNING" ? {
      phase: "WAITING_MODEL", call_count: 1,
      latest_call: { status: "STARTED", started_at: "2026-11-10T08:00:01Z",
        first_stream_event_at: null, first_text_delta_at: null,
        first_preview_persisted_at: null, settled_at: null } } : null };
}

function activity(input: { status: "RUNNING" | "COMPLETED"; view: string; tone: string;
  detail: string; gaps?: readonly { code: string }[];
  activities?: readonly unknown[] }) {
  return { message_id: messageId, seq: "2", role: "ASSISTANT", status: input.status,
    intent: "DISCUSS", created_at: "2026-11-10T08:00:00Z",
    claimed_at: "2026-11-10T08:00:01Z",
    settled_at: input.status === "COMPLETED" ? "2026-11-10T08:00:06Z" : null,
    updated_at: "2026-11-10T08:00:06Z", cancel_requested: false,
    source_user_message_id: "c1111111-1111-4111-8111-111111111111",
    content_fingerprint: `slot-${input.view}`, process_evidence: "RECORDED",
    phase: { raw: input.status, view: input.view, tone: input.tone,
      since: "2026-11-10T08:00:01Z", detail: input.detail, wait: null },
    execution_request: null, run_summary: null,
    activities: input.activities ?? [],
    activity_counts: { model_calls: (input.activities ?? []).length, tool_calls: 0,
      todo_writes: 0, delegations: 0 },
    gaps: input.gaps ?? [] };
}

function modelCall() {
  return { activity_id: "model-call:m1", kind: "MODEL_CALL",
    state: { raw: "STARTED", view: "WAITING_RESPONSE", tone: "active", terminal: false },
    started_at: "2026-11-10T08:00:01.000Z", ended_at: null,
    order: { message_seq: "2", round: null, ordinal: null, rank: 1 },
    refs: { model_call_id: "m1", tool_call_id: null, operation_id: null, invocation_id: null },
    wait: { code: "PROVIDER_RESPONSE", detail: null }, error: null,
    evidence: { result_available: false, result_digest: null, failure_kind: null,
      detail_visibility: "USER" },
    recovery: null, facts: null };
}

function toolCall() {
  return { id: "t1", round: 0, ordinal: 0, tool_name: "read_file", status: "SETTLED",
    arguments: { path: "AGENTS.md" }, rejection_reason: null, rejection_detail: null,
    requested_at: "2026-11-10T08:00:02Z", settled_at: "2026-11-10T08:00:03Z" };
}

function install(holder: { message: ReturnType<typeof message>;
  activity: ReturnType<typeof activity>;
  rounds?: readonly unknown[] }) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
      return response({ items: [holder.message] });
    if (path === `${prefix}/assist-sessions/${sessionId}/activity`)
      return response({ schema_version: 1, session: session(),
        generated_at: "2026-11-10T08:00:07Z", snapshot_at: "2026-11-10T08:00:07Z",
        messages: [holder.activity], next_before_seq: null, has_more: false });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`)
      return response({ session_id: sessionId, message_id: messageId,
        status: holder.message.status, preview_revision: "0", preview_text: null,
        preview_truncated: false, preview_available: false, usage: null });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/tool-calls`)
      return response({ session_id: sessionId, message_id: messageId,
        message_status: holder.message.status, rounds: holder.rounds ?? [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/todos`)
      return response({ snapshot: null });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    throw new Error(`unexpected request ${path}`);
  }));
}

async function mount() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "process-slot" });
  const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
  unmount = view.unmount;
  return view;
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); clearSessionTranscriptCache(); vi.unstubAllGlobals();
});

describe("消息过程槽位", () => {
  it("生成中没有工具时只有一行阶段文案，活动快照到达不再多一块", async () => {
    install({ message: message({ status: "RUNNING" }),
      activity: activity({ status: "RUNNING", view: "WAITING_MODEL_RESPONSE", tone: "wait",
        detail: "模型请求已登记，等待响应", activities: [modelCall()] }) });
    const view = await mount();
    await flush(80);
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(true);
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).text())
      .toBe("等待模型响应");
    expect(view.wrapper.find(`[data-testid="message-execution-status"]`).exists()).toBe(false);
  });

  it("clean COMPLETED 不保留任何常驻过程块", async () => {
    install({ message: message({ status: "COMPLETED", content: "你好，我是 Relay 助手。" }),
      activity: activity({ status: "COMPLETED", view: "COMPLETED", tone: "success",
        detail: "回复已完成", activities: [modelCall()] }) });
    const view = await mount();
    await flush(120);
    expect(view.wrapper.text()).toContain("你好，我是 Relay 助手。");
    // 工具账本终态要先读回零条才会按事实收起；并行跑文件时 120ms 可能不够。
    await vi.waitFor(() => {
      const slot = view.wrapper.find(`[data-testid="assist-process-${messageId}"]`).element;
      expect(slot?.childElementCount ?? -1).toBe(0);
    }, { timeout: 3_000 });
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.find(`[data-testid="message-execution-status"]`).exists()).toBe(false);
    expect(view.wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists())
      .toBe(false);
  });

  it("待核对例外仍常驻状态块，不被简洁口径吞掉", async () => {
    install({ message: message({ status: "RUNNING" }),
      activity: activity({ status: "RUNNING", view: "WAITING_CONFIRMATION", tone: "wait",
        detail: "工具有结果待核对", gaps: [{ code: "UNRESOLVED_UNKNOWN" }],
        activities: [modelCall()] }) });
    const view = await mount();
    await flush(80);
    expect(view.wrapper.find(`[data-testid="message-execution-status"]`).exists()).toBe(true);
    expect(view.wrapper.find(`[data-testid="message-execution-status"]`).text())
      .toContain("1 项待核对");
    // 例外状态块占位时阶段行不再重复同一段等待。
    expect(view.wrapper.find(`[data-testid="assist-stage-${messageId}"]`).exists()).toBe(false);
  });

  it("会话重挂载时先用展示缓存渲染，不等消息读回", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "process-slot" });
    writeCachedSessionTranscript(workspaceId, sessionId, {
      messages: [message({ status: "COMPLETED",
        content: "缓存里的最终回复" }) as unknown as RelayAssistMessage],
      proposals: [] });
    // 消息读回永远挂起：首帧能出现内容，只可能来自展示缓存。
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
        return new Promise<Response>(() => {});
      if (path === `${prefix}/assist-sessions/${sessionId}/activity`)
        return new Promise<Response>(() => {});
      if (path === `${prefix}/assist-sessions/${sessionId}/todos`)
        return response({ snapshot: null });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      return response({ items: [], next_cursor: null });
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    unmount = view.unmount;
    expect(view.wrapper.text()).toContain("缓存里的最终回复");
  });

  it("有工具时由工具账本独占，状态块不重复同一次调用", async () => {
    install({ message: message({ status: "RUNNING" }),
      activity: activity({ status: "RUNNING", view: "RUNNING_TOOL", tone: "active",
        detail: "正在执行工具", activities: [modelCall()] }),
      rounds: [{ round: 0, calls: [toolCall()] }] });
    const view = await mount();
    await flush(120);
    expect(view.wrapper.find(`[data-testid="session-round-trace-${messageId}"]`).exists())
      .toBe(true);
    expect(view.wrapper.find(`[data-testid="message-execution-status"]`).exists()).toBe(false);
  });
});
