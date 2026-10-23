import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 排队消息的「插话」手势（2026-10-19，工作台 §35）。
 *
 * 上游语义（`.research/upstream/deepseek-harness`）：运行中按 Enter 把消息放进队列
 * （`followup` → next-turn）；输入框为空时再按一次 Enter 把整队消息插进**当前这一轮**
 * （`steer` → next-step）。本项目对应两个动作：
 *   1. 有正文时 Enter 仍是发送（排队），行为不变；
 *   2. 草稿为空、正在生成、队列非空时，Enter 改为插话——它不再是一次空提交；
 *   3. 队列每一项也有「插话」按钮，与空草稿 Enter 走同一条命令。
 * 断言只看请求形状与界面反馈，不声称插话已经在服务端并入上下文（那是生成方的事）。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const runningId = "88888888-8888-4888-8888-888888888888";
const queuedId = "99999999-9999-4999-8999-999999999999";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "关于测试项目", status: "ACTIVE", revision: "1",
    created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" };
}

function message(id: string, seq: string, role: string, status: string, content: string | null,
  extra: Record<string, unknown> = {}) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null },
    cancel_requested: false, steer_requested: false, attachments: [], ...extra };
}

/** 一条正在生成 + 一条排队等着的会话。 */
function conversation() {
  return [
    message("66666666-6666-4666-8666-666666666666", "1", "USER", "COMPLETED", "早先消息"),
    message("77777777-7777-4777-8777-777777777777", "2", "ASSISTANT", "COMPLETED", "好的。"),
    message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "3", "USER", "COMPLETED", "正在回答的这条"),
    message(runningId, "4", "ASSISTANT", "RUNNING", "先写一半"),
    message("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "5", "USER", "COMPLETED", "排队的一条"),
    message(queuedId, "6", "ASSISTANT", "PENDING", null),
  ];
}

interface Harness {
  steers: string[];
  sends: string[];
}

function stubFetch(harness: Harness) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return response({ project_id: projectId, revision: "1",
      phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/projects`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return response({ items: [], next_cursor: null });
    if (path === `${prefix}/assistant-profiles`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    if (path === `${prefix}/model-port`) return response({ provider: "fake", configured: false, model: null,
      base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return response({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response(session());
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return response({ model: null, revision: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST")
      return response({ items: conversation() });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
      harness.sends.push(String(init.body));
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
        result: { session_id: sessionId, user_message_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          assistant_message_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } }, 202);
    }
    const steer = new RegExp(`^${prefix}/assist-messages/([^/]+)/steer$`, "u").exec(path);
    if (steer !== null && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      harness.steers.push(String(steer[1]));
      return response({ command_id: body.command_id, committed_at: "2026-09-26T00:00:00Z",
        result: { message_id: steer[1], status: "STEER_REQUESTED" } });
    }
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/conversation-state-requests`) return response({ items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return response({ items: [] });
    if (path.startsWith(`${prefix}/search`)) return response({ items: [], next_cursor: null });
    if (/\/commands\/([^/]+)$/u.test(path)) return response({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    throw new Error(`unexpected request ${path}`);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.motion = "on";
});
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("排队消息的插话手势", () => {
  it("空草稿的 Enter 把排队消息插进当前回复，而不是空提交", async () => {
    const harness: Harness = { steers: [], sends: [] };
    vi.stubGlobal("fetch", stubFetch(harness));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      await flush(200);
      // 有 RUNNING 且有 PENDING 才构成队列；输入框为空时手势才成立。
      expect(view.wrapper.get('[data-testid="assist-queue"]').text()).toContain("等待中 · 1 项");

      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      expect((draft.element as HTMLTextAreaElement).value).toBe("");
      await draft.trigger("keydown", { key: "Enter" });
      await flush(120);

      expect(harness.steers).toEqual([queuedId]);
      expect(harness.sends).toHaveLength(0);
      expect(document.body.textContent).toContain("已请求插话");
    } finally { view.unmount(); }
  });

  it("有正文时 Enter 仍是发送：插话手势不劫持正常发送", async () => {
    const harness: Harness = { steers: [], sends: [] };
    vi.stubGlobal("fetch", stubFetch(harness));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      await flush(200);
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      await draft.setValue("新的一条");
      await flush();
      await draft.trigger("keydown", { key: "Enter" });
      await flush(120);

      expect(harness.sends).toHaveLength(1);
      expect(harness.steers).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("队列每一项的「插话」按钮与空草稿 Enter 走同一条命令", async () => {
    const harness: Harness = { steers: [], sends: [] };
    vi.stubGlobal("fetch", stubFetch(harness));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      await flush(200);
      await view.wrapper.get('[data-testid="assist-queue-steer-1"]').trigger("click");
      await flush(120);
      expect(harness.steers).toEqual([queuedId]);
      expect(harness.sends).toHaveLength(0);
    } finally { view.unmount(); }
  });
});
