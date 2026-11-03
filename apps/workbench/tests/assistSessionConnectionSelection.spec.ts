import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 会话模型选择器接入已登记连接（MODEL-SETTINGS-01）。
 *
 * 选择提交的是稳定 connection_id，不是型号文本：服务端按连接当前声明解析型号。
 * 另一条连接即使型号相同也不算本次成功；这里核对请求形状与回执落地后的界面事实。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "关于测试项目", status: "ACTIVE", revision: "1",
    created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" };
}

function connection() {
  return { id: connectionId, name: "团队网关", provider_kind: "openai-compatible",
    base_url: "https://fixture.invalid/v1", default_model: "vendor/registered",
    budget: { timeout_ms: 30000, max_output_tokens: 4096, max_call_tokens: 65536,
      max_scope_calls: 30, max_scope_tokens: 512000 },
    credential_version: 1, status: "ACTIVE", revision: "1",
    created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" };
}

interface Harness { selections: Record<string, unknown>[] }

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
    if (path === `${prefix}/model-catalog`) return response({ configured: true, chat_configured: true,
      last_success_at: null, last_failure_reason: null, cache_stale: false, snapshot_seq: "0", free_count: 0,
      entries: [] });
    if (path === `${prefix}/model-connections`) return response({ items: [connection()] });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response(session());
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection` && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      harness.selections.push(body);
      return response({ command_id: body.command_id, committed_at: "2026-11-02T00:00:00Z",
        result: { kind: "MODEL_SELECTION", session_id: sessionId, connection: "registered",
          connection_id: body.connection_id, model: "vendor/registered", free_only: false, revision: "1" } });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return response({ selection: null });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
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

describe("会话选择已登记连接", () => {
  it("点连接条目提交 connection_id，回执落地后芯片显示连接当前型号", async () => {
    const harness: Harness = { selections: [] };
    vi.stubGlobal("fetch", stubFetch(harness));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      await flush(200);
      const trigger = view.wrapper.get('[data-testid="assist-composer"] [data-testid="model-selector-open"]');
      await trigger.trigger("click");
      await flush(120);
      expect(document.body.textContent).toContain("已登记连接");
      const option = document.querySelector<HTMLButtonElement>(
        `[data-testid="model-selector-option-${connectionId}"]`);
      expect(option).not.toBeNull();
      expect(option!.disabled).toBe(false);
      await option!.click();
      await flush(200);

      expect(harness.selections).toHaveLength(1);
      expect(harness.selections[0]).toMatchObject({ connection_id: connectionId });
      expect(typeof harness.selections[0]?.command_id).toBe("string");
      expect(harness.selections[0]).not.toHaveProperty("model");
      expect(trigger.text()).toContain("vendor/registered");
      expect(document.body.textContent).toContain("已登记连接「团队网关」");
    } finally { view.unmount(); }
  });
});
