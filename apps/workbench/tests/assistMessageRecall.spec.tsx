import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 0132 消息撤回（文件回退）的工作台契约：
 *   * 「回退文件」只出现在完成、未撤回的用户消息上；
 *   * 提交成功后两行标记「已撤回」，原文默认收起，回执摘要可见；
 *   * 逐文件结果按需读取，不在每次刷新时额外查历史回执；
 *   * 崩溃遗留的 RUNNING 回执给出「继续回退」，而不是永远停在「正在回退」；
 *   * 预检阻断逐路径原因原样露出，且消息不被标记撤回。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const userMessageId = "44444444-4444-4444-8444-444444444444";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const recallId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const recallPath = `${prefix}/assist-messages/${userMessageId}/recall`;
const withdrawnAt = "2026-10-24T01:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" } });
}

function recallSummary(status = "COMPLETED", overrides: Record<string, unknown> = {}) {
  return { id: recallId, message_id: userMessageId, assistant_message_id: assistantMessageId,
    status, planned_files: 1, restored_files: status === "COMPLETED" ? 1 : 0, skipped_files: 0,
    completed_at: status === "RUNNING" ? null : withdrawnAt, ...overrides };
}

function recallReceipt(overrides: Record<string, unknown> = {}) {
  return { ...recallSummary(), root_path: "D:\\work", detail: {},
    requested_at: "2026-10-24T01:00:00.000Z",
    files: [{ path: "notes/a.md", status: "RESTORED", reason: null,
      baseline: "PRESENT", baseline_sha256: "a".repeat(64) }],
    ...overrides };
}

function message(id: string, seq: string, role: "USER" | "ASSISTANT", status: string,
  content: string | null, recall: unknown = null, withdrawn = false) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, skill_input: null,
    skill_output: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: null,
      cache_creation_tokens: null }, cancel_requested: false, attachments: [],
    withdrawn_at: withdrawn ? withdrawnAt : null,
    withdrawn_by_recall_id: withdrawn ? recallId : null,
    recall,
    created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:00:00.000Z" };
}

function baseMessages(): unknown[] {
  return [
    message(userMessageId, "1", "USER", "COMPLETED", "请修改 notes/a.md"),
    message(assistantMessageId, "2", "ASSISTANT", "COMPLETED", "已修改 notes/a.md。")];
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

interface Harness {
  items: () => unknown[];
  recallPost: (body: Record<string, unknown>) => Response;
  recallGet?: () => Response;
}

async function mountConversation(harness: Harness) {
  const posted: Record<string, unknown>[] = [];
  let recallReads = 0;
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
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
    if (path === `${prefix}/model-port/verification`) return response({
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/default-working-directory`) return response({ resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return response({ items: [{ id: sessionId,
      workspace_id: workspaceId, project_id: projectId, task_id: null, title: "会话",
      status: "ACTIVE", revision: "1", created_at: "2026-10-24T00:00:00Z",
      updated_at: "2026-10-24T00:00:00Z" }] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return response({ id: sessionId,
      workspace_id: workspaceId, project_id: projectId, task_id: null, title: "会话",
      status: "ACTIVE", revision: "1", created_at: "2026-10-24T00:00:00Z",
      updated_at: "2026-10-24T00:00:00Z" });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return response({
      model: null, revision: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST") {
      return response({ items: harness.items() });
    }
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === recallPath && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      posted.push(body);
      return harness.recallPost(body);
    }
    if (path === recallPath) {
      recallReads += 1;
      return harness.recallGet?.() ?? response({ type: "about:blank", title: "not found",
        status: 404, detail: "不存在。", code: "RESOURCE_NOT_FOUND" }, 404);
    }
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
  }));
  const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
  unmount = view.unmount;
  return { wrapper: view.wrapper, posted, recallReads: () => recallReads };
}

describe("消息撤回（文件回退）", () => {
  it("完成后可回退：回执摘要落位、两行标记已撤回、原文默认收起", async () => {
    let items = baseMessages();
    const { wrapper, posted } = await mountConversation({
      items: () => items,
      recallPost: (body) => {
        items = [
          message(userMessageId, "1", "USER", "COMPLETED", "请修改 notes/a.md",
            recallSummary(), true),
          message(assistantMessageId, "2", "ASSISTANT", "COMPLETED", "已修改 notes/a.md。",
            recallSummary(), true)];
        return response({ command_id: String(body.command_id), committed_at: withdrawnAt,
          result: recallReceipt(), links: { resource: "ignored" } });
      } });

    const action = wrapper.get(`[data-testid="assist-recall-action-${userMessageId}"]`);
    // 2026-10-24 用户指令：回退键改成与复制键同档的纯图标按钮，入口名由 aria-label 承载。
    expect(action.attributes("aria-label")).toBe("回退文件");
    await action.trigger("click");
    await flush();

    expect(posted).toHaveLength(1);
    expect(typeof posted[0]!.command_id).toBe("string");
    const note = wrapper.get(`[data-testid="assist-recall-${recallId}"]`);
    expect(note.attributes("data-status")).toBe("COMPLETED");
    expect(note.text()).toContain("已回退 1 个文件到该轮发送前。");
    expect(wrapper.find(`[data-testid="assist-recall-action-${userMessageId}"]`).exists()).toBe(false);
    const statuses = wrapper.findAll(".agent-message-status").map((node) => node.text());
    expect(statuses.filter((text) => text === "已撤回")).toHaveLength(2);
    const original = wrapper.get(`[data-testid="assist-withdrawn-original-${userMessageId}"]`);
    expect(original.find("summary").text()).toContain("查看已撤回原文（仅历史）");
    expect(original.attributes("open")).toBeUndefined();
    expect(wrapper.find(`[data-testid="assist-copy-${assistantMessageId}"]`).exists()).toBe(false);
  });

  it("逐文件结果按需读取：未点击前不请求回执，点击后展示逐项状态", async () => {
    const items = [
      message(userMessageId, "1", "USER", "COMPLETED", "请修改 notes/a.md",
        recallSummary(), true),
      message(assistantMessageId, "2", "ASSISTANT", "COMPLETED", "已修改 notes/a.md。",
        recallSummary(), true)];
    const { wrapper, recallReads } = await mountConversation({
      items: () => items,
      recallPost: () => response({}),
      recallGet: () => response(recallReceipt()) });

    const note = wrapper.get(`[data-testid="assist-recall-${recallId}"]`);
    expect(note.text()).toContain("查看逐文件回执");
    expect(recallReads()).toBe(0);
    await note.find("button").trigger("click");
    await flush();
    expect(recallReads()).toBe(1);
    const text = wrapper.get(`[data-testid="assist-recall-${recallId}"]`).text();
    expect(text).toContain("逐文件结果（1）");
    expect(text).toContain("notes/a.md");
    expect(text).toContain("已恢复");
    expect(text).toContain("发送前存在");
  });

  it("崩溃遗留的 RUNNING 回执提供「继续回退」，结算后按同一回执标记撤回", async () => {
    let items = [
      message(userMessageId, "1", "USER", "COMPLETED", "请修改 notes/a.md",
        recallSummary("RUNNING", { planned_files: 2 }), false),
      message(assistantMessageId, "2", "ASSISTANT", "COMPLETED", "已修改 notes/a.md。",
        recallSummary("RUNNING", { planned_files: 2 }), false)];
    const { wrapper, posted } = await mountConversation({
      items: () => items,
      recallPost: (body) => {
        items = [
          message(userMessageId, "1", "USER", "COMPLETED", "请修改 notes/a.md",
            recallSummary("COMPLETED", { planned_files: 2, restored_files: 2 }), true),
          message(assistantMessageId, "2", "ASSISTANT", "COMPLETED", "已修改 notes/a.md。",
            recallSummary("COMPLETED", { planned_files: 2, restored_files: 2 }), true)];
        return response({ command_id: String(body.command_id), committed_at: withdrawnAt,
          result: recallReceipt({ planned_files: 2, restored_files: 2,
            files: [
              { path: "notes/a.md", status: "RESTORED", reason: null,
                baseline: "PRESENT", baseline_sha256: "a".repeat(64) },
              { path: "notes/b.md", status: "RESTORED", reason: null,
                baseline: "ABSENT", baseline_sha256: null }] }) });
      } });

    const note = wrapper.get(`[data-testid="assist-recall-${recallId}"]`);
    expect(note.attributes("data-status")).toBe("RUNNING");
    expect(note.text()).toContain("正在回退文件（0/2）。");
    await note.find("button").trigger("click");
    await flush();

    expect(posted).toHaveLength(1);
    expect(wrapper.get(`[data-testid="assist-recall-${recallId}"]`).attributes("data-status"))
      .toBe("COMPLETED");
    expect(wrapper.get(`[data-testid="assist-recall-${recallId}"]`).text())
      .toContain("已回退 2 个文件到该轮发送前。");
    expect(wrapper.findAll(".agent-message-status").map((node) => node.text()))
      .toEqual(["已撤回", "已撤回"]);
  });

  it("预检阻断时逐路径原因露出，消息保持未撤回且仍可重试", async () => {
    const { wrapper, posted } = await mountConversation({
      items: baseMessages,
      recallPost: () => response({ type: "/problems/recall-preflight-blocked",
        title: "撤回预检未通过", status: 409,
        detail: "至少一个目标文件与发送前基线不一致或缺少可信前像；本次没有写入任何文件。",
        code: "RECALL_PREFLIGHT_BLOCKED", retryable: true, retry_action: "REFRESH_AND_REDECIDE",
        conflict: { recall_paths: ["notes/a.md｜CONFLICT｜CURRENT_CHANGED_SINCE_LAST_WRITE"] } },
      409) });

    await wrapper.get(`[data-testid="assist-recall-action-${userMessageId}"]`).trigger("click");
    await flush();

    expect(posted).toHaveLength(1);
    const alert = wrapper.get(`[data-testid="assist-recall-error-${userMessageId}"]`);
    expect(alert.text()).toContain("至少一个目标文件");
    expect(alert.text()).toContain("notes/a.md｜CONFLICT");
    expect(wrapper.findAll(".agent-message-status").map((node) => node.text()))
      .not.toContain("已撤回");
    expect(wrapper.find(`[data-testid="assist-recall-action-${userMessageId}"]`).exists()).toBe(true);
  });

  it("回执状态只接受封闭词表，未知值按契约失败而不是猜成完成", async () => {
    const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...recallReceipt(),
      status: "DONE" })));
    await expect(client.getAssistMessageRecall(userMessageId))
      .rejects.toThrow("Assist 消息撤回状态无法识别。");
  });
});
