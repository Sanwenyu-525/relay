import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 回复底部的 Token 读数（AGENT_LIVE_TOKEN_USAGE，2026-11-01）。
 *
 * 用与正式会话相同的 AssistView + HTTP 客户端，只把网络换成可变的响应：
 * 生成中读预览投影（估算 → 部分确认），完成后只读消息的账本汇总。这里钉的是
 * 真实链路（解析 → 状态 → 文案 → 位置），不是静态模拟数据。
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
    title: "用量会话", status: "ACTIVE", revision: "1",
    created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
}

type UsageState = "ESTIMATED" | "PARTIAL" | "CONFIRMED" | "UNKNOWN";

function usage(state: UsageState, input: number | null, output: number | null, patch: {
  settled?: number; pending?: number; missing?: number } = {}) {
  return { state, input_tokens: input, output_tokens: output,
    cache_read_tokens: null, cache_creation_tokens: null,
    settled_calls: patch.settled ?? 0, pending_calls: patch.pending ?? 0,
    missing_usage_calls: patch.missing ?? 0 };
}

function message(status: string, content: string | null,
  summary: ReturnType<typeof usage> | null,
  legacy = { input_tokens: 1_000 as number | null, output_tokens: 1 as number | null }) {
  return { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT", status,
    intent: "DISCUSS", content, error_code: null, sources: [], skill: null,
    usage: legacy, ...(summary === null ? {} : { usage_summary: summary }),
    cancel_requested: false, attachments: [],
    created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:05Z" };
}

function preview(usageValue: ReturnType<typeof usage> | null, text: string | null = null,
  status = "RUNNING") {
  return { session_id: sessionId, message_id: messageId, status,
    preview_revision: text === null && usageValue === null ? "0" : "3",
    preview_text: text, preview_truncated: false,
    preview_available: status === "RUNNING", usage: usageValue };
}

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("Agent 回复的实时 Token 读数", () => {
  it("生成中显示估算，校准时变为部分确认，完成后改读账本汇总", async () => {
    connect();
    let status = "RUNNING";
    let content: string | null = null;
    let previewUsage: ReturnType<typeof usage> | null = usage("ESTIMATED", 5_000, 400, { pending: 1 });
    let summary: ReturnType<typeof usage> | null = usage("UNKNOWN", null, null);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
        return response({ items: [message(status, content, summary)] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`)
        return response(preview(previewUsage, content, status));
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;

    const live = () => view.wrapper.get(`[data-testid="assist-token-live-${messageId}"]`);
    expect(live().text()).toBe("本轮 ≈ 5.4k tokens");
    expect(live().attributes("data-state")).toBe("ESTIMATED");
    expect(live().attributes("title")).toContain("含估算");
    expect(live().attributes("data-total")).toBe("5400");

    // 第一次调用已确认、当前调用还在跑：数字变成下界，并明确说部分用量未知。
    previewUsage = usage("PARTIAL", 5_000, 400, { settled: 1, pending: 1, missing: 1 });
    await flush(450);
    expect(live().text()).toBe("本轮 ≥ 5.4k tokens · 部分用量未知");
    expect(live().attributes("data-state")).toBe("PARTIAL");

    // 结算：预览行已删除，页脚改读账本汇总（12.3k），与旧 usage 字段无关。
    status = "COMPLETED"; content = "最终回复";
    summary = usage("CONFIRMED", 12_000, 345, { settled: 2 });
    previewUsage = null;
    await flush(450);
    expect(view.wrapper.find(`[data-testid="assist-token-live-${messageId}"]`).exists()).toBe(false);
    const footer = view.wrapper.get(`[data-testid="assist-usage-${messageId}"]`);
    expect(footer.text()).toBe("本轮 12.3k tokens");
    expect(footer.attributes("data-state")).toBe("CONFIRMED");
    expect(footer.attributes("data-total")).toBe("12345");
    expect(view.wrapper.text()).not.toContain("部分用量未知");
  });

  it("Provider 不上报最终用量时如实说未上报，不退回旧数字", async () => {
    connect();
    let status = "RUNNING";
    let content: string | null = null;
    let summary: ReturnType<typeof usage> = usage("UNKNOWN", null, null);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
        return response({ items: [message(status, content, summary, { input_tokens: null,
          output_tokens: null })] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`)
        return response(preview(status === "RUNNING" ? usage("ESTIMATED", 900, 0, { pending: 1 }) : null,
          content, status));
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(view.wrapper.get(`[data-testid="assist-token-live-${messageId}"]`).text())
      .toBe("本轮 ≈ 900 tokens");
    status = "COMPLETED"; content = "完成了，但没有用量";
    await flush(450);
    expect(view.wrapper.get(`[data-testid="assist-usage-${messageId}"]`).text())
      .toBe("本轮 Token 未上报");
    expect(view.wrapper.get(`[data-testid="assist-usage-${messageId}"]`).attributes("data-total"))
      .toBeUndefined();
  });

  it("历史消息没有 usage_summary 时按旧 usage 字段回退，不凭空补调用次数", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("COMPLETED", "旧消息", null,
          { input_tokens: 4_757, output_tokens: 316 })] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    const footer = view.wrapper.get(`[data-testid="assist-usage-${messageId}"]`);
    expect(footer.text()).toBe("本轮 5.1k tokens");
    expect(footer.attributes("data-state")).toBe("CONFIRMED");
    expect(footer.attributes("title")).toBe("输入 4,757 · 输出 316 · 全部调用已确认");
  });
});
