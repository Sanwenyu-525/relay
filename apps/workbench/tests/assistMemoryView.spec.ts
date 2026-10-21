import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 记忆在真实协作页里的接线（工作台 §40）。
 *
 * 2026-10-20 用户指认：消息级的「保存为长期记忆」「记忆来源」与输入卡上方的「会话记忆」
 * 控制带都从聊天里移除。本文件因此改成**移除后的守卫**——聊天页不再发记忆读取请求、
 * 不再渲染这三处入口；`/compact` 与 `/clear` 的命令路由保持不变（它们不依赖面板）。
 * 面板与确认层自身的组件行为仍由 `sessionMemory` / `saveMemory` 两个单测文件覆盖。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const newSessionId = "44444444-4444-4444-8444-444444444444";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const userMessageId = "66666666-6666-4666-8666-666666666666";
const requestId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session(id = sessionId) {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "关于测试项目", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" };
}

function message(id: string, seq: string, role: string, status: string, content: string | null) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null },
    cancel_requested: false, steer_requested: false, attachments: [] };
}

function memoryBody(overrides: Record<string, unknown> = {}) {
  return { session_id: sessionId, session_revision: "1", revision: "0", remember: true,
    cleared_through_seq: "0", checkpoint: null, requests: [], ...overrides };
}

interface Harness { chatCommands: string[]; memoryReads: number; memoryClears: number }

function stubFetch(harness: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return response({ project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/projects`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/assistant-profiles`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, status: "UNSET", reason: null,
      revision: "0" });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response(session());
    if (path === `${prefix}/assist-sessions/${newSessionId}`) return response(session(newSessionId));
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`)
      return response({ model: null, revision: "0" });
    /* 会话窗口与消息足迹的读取入口已从聊天页移除：这两条路由仍计数，
       一旦被重新接上（读取数 > 0）用例会直接失败，不靠肉眼回归。 */
    if (path === `${prefix}/assist-sessions/${sessionId}/memory`) {
      harness.memoryReads += 1;
      return response(memoryBody());
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages/${assistantMessageId}/memory`) {
      harness.memoryReads += 1;
      return response({ session_id: sessionId, message_id: assistantMessageId, recorded: true,
        available: true, checkpoint_id: null, sources: [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/memory/clear` && init?.method === "POST") {
      harness.memoryClears += 1;
      return response({ code: "INVALID_TRANSITION", detail: "不该走到这里" }, 409);
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/chat-commands` && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { command_id: string; text: string };
      harness.chatCommands.push(body.text);
      if (body.text.includes("clear") || body.text.includes("新会话")) {
        return response({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00Z",
          result: { kind: "NEW_SESSION", system: "clear", source_session_id: sessionId,
            session_id: newSessionId, conversation_mode: "AGENT", project_id: projectId,
            task_id: null, revision: "1", assistant_profile_id: null,
            assistant_profile_revision: null } });
      }
      return response({ command_id: body.command_id, committed_at: "2026-10-20T00:00:00Z",
        result: { kind: "MEMORY_COMPACTION", system: "compact", session_id: sessionId,
          request_id: requestId, status: "PENDING" } }, 202);
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST")
      return response({ items: [
        message(userMessageId, "1", "USER", "COMPLETED", "我们定了用 PostgreSQL。"),
        message(assistantMessageId, "2", "ASSISTANT", "COMPLETED", "记下了：唯一业务数据库是 PostgreSQL。")
      ] });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/conversation-state-requests`) return response({ items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return response({ items: [] });
    if (path.startsWith(`${prefix}/search`)) return response({ items: [], next_cursor: null });
    if (path.includes("/attention/")) return response({ items: [] });
    if (path.includes("conversation-diff")) return response({ session_id: sessionId, files: [],
      unavailable_files: 0, unverifiable_files: 0, baseline: null, incomplete: false });
    if (/\/commands\/([^/]+)$/u.test(path)) return response({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
  });
}

beforeEach(() => { window.localStorage.clear(); document.documentElement.dataset.motion = "on"; });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

async function mountConversation() {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
  const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
  await flush(240);
  return view;
}

describe("聊天页不再渲染记忆 UI（2026-10-20 用户指认）", () => {
  it("既没有会话记忆控制带，也没有消息级的保存/足迹入口，且不预读记忆", async () => {
    const harness: Harness = { chatCommands: [], memoryReads: 0, memoryClears: 0 };
    vi.stubGlobal("fetch", stubFetch(harness));
    const view = await mountConversation();
    try {
      expect(view.wrapper.find('[data-testid="session-memory"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="session-memory-summary"]').exists()).toBe(false);
      expect(view.wrapper.find(`[data-testid="assist-save-memory-${assistantMessageId}"]`).exists()).toBe(false);
      expect(view.wrapper.find(`[data-testid="assist-save-memory-${userMessageId}"]`).exists()).toBe(false);
      expect(view.wrapper.find(`[data-testid="message-memory-${assistantMessageId}"]`).exists()).toBe(false);
      // 面板被移除后不应再发这条 GET：读取计数就是「入口没被重新接上」的证据。
      expect(harness.memoryReads).toBe(0);
      expect(document.body.textContent).not.toContain("保存为长期记忆");
      expect(document.body.textContent).not.toContain("会话记忆");
    } finally { view.unmount(); }
  });
});

describe("斜杠命令路由不依赖记忆面板", () => {
  it("输入 /compact 发送后才执行整理：走 chat-commands，界面只承认「已受理」", async () => {
    const harness: Harness = { chatCommands: [], memoryReads: 0, memoryClears: 0 };
    vi.stubGlobal("fetch", stubFetch(harness));
    const view = await mountConversation();
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      await draft.setValue("/compact");
      await flush();
      // 只插草稿不执行：命令尚未发出。
      expect(harness.chatCommands).toHaveLength(0);
      await draft.trigger("keydown", { key: "Enter" });
      await flush(200);
      expect(harness.chatCommands).toEqual(["/compact"]);
      expect(document.body.textContent).toContain("已受理整理请求");
      expect((draft.element as HTMLTextAreaElement).value).toBe("");
    } finally { view.unmount(); }
  });

  it("/压缩 是同一条命令的别名", async () => {
    const harness: Harness = { chatCommands: [], memoryReads: 0, memoryClears: 0 };
    vi.stubGlobal("fetch", stubFetch(harness));
    const view = await mountConversation();
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      await draft.setValue("/压缩");
      await flush();
      await draft.trigger("keydown", { key: "Enter" });
      await flush(200);
      expect(harness.chatCommands).toEqual(["/压缩"]);
    } finally { view.unmount(); }
  });

  it("/clear 仍然新建会话，绝不调用清除工作记忆", async () => {
    const harness: Harness = { chatCommands: [], memoryReads: 0, memoryClears: 0 };
    vi.stubGlobal("fetch", stubFetch(harness));
    const view = await mountConversation();
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      await draft.setValue("/clear");
      await flush();
      await draft.trigger("keydown", { key: "Enter" });
      await flush(240);
      expect(harness.chatCommands).toEqual(["/clear"]);
      expect(harness.memoryClears).toBe(0);
    } finally { view.unmount(); }
  });
});
