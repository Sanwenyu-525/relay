import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayAssistMessage } from "../src/api/relayClient";
import { assistMessageFrom } from "../src/api/parse/assist";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { MessageElapsed } from "../src/views/AssistView";
import { mountReact, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function message(overrides: Partial<RelayAssistMessage>): RelayAssistMessage {
  return { id: "m-1", sessionId: "s-1", seq: "1", role: "ASSISTANT", status: "COMPLETED",
    createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z", intent: "DISCUSS",
    content: null, errorCode: null, providerErrorKind: null, sources: [], skill: null,
    skillInput: null, skillOutput: null,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    cancelRequested: false, steerRequested: false, attachments: [],
    withdrawnAt: null, withdrawnByRecallId: null, recall: null, ...overrides };
}

const rawMessage = { id: "m-1", session_id: "s-1", seq: "1", role: "ASSISTANT", status: "COMPLETED",
  intent: "DISCUSS", content: "ok", error_code: null, provider_error_kind: null, sources: [],
  skill: null, skill_input: null, skill_output: null,
  usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: null, cache_creation_tokens: null },
  cancel_requested: false, attachments: [],
  created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:00:07.000Z" };

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

afterEach(() => { vi.useRealTimers(); resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("消息头部的任务耗时", () => {
  it("解析服务端 updated_at：终态结算时刻不能丢成 null", () => {
    expect(assistMessageFrom(rawMessage).updatedAt).toBe("2026-10-18T00:00:07.000Z");
  });

  it("完成后用结算时刻冻结，不随页面停留继续增长", async () => {
    const view = await mountReact(createElement(MessageElapsed, { message: message({
      createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:01:05Z" }) }));
    try {
      expect(view.wrapper.get('[data-testid="assist-elapsed-m-1"]').text()).toBe("耗时 1 分 05 秒");
    } finally { view.unmount(); }
  });

  it("在途从提交时刻起算并每秒刷新", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:05Z"));
    const view = await mountReact(createElement(MessageElapsed, { message: message({
      status: "RUNNING", createdAt: "2026-10-18T12:00:00Z",
      // 在途的 updated_at 是心跳，不是这次执行的终点。
      updatedAt: "2026-10-18T12:00:05Z" }) }));
    try {
      expect(view.wrapper.get('[data-testid="assist-elapsed-m-1"]').text()).toBe("已用 5 秒");
      await act(async () => { vi.advanceTimersByTime(2_000); });
      expect(view.wrapper.get('[data-testid="assist-elapsed-m-1"]').text()).toBe("已用 7 秒");
    } finally { view.unmount(); }
  });

  it("用户消息与缺少时间戳的消息不显示耗时", async () => {
    const user = await mountReact(createElement(MessageElapsed, { message: message({
      role: "USER", createdAt: "2026-10-18T00:00:00Z" }) }));
    const unknown = await mountReact(createElement(MessageElapsed, { message: message({
      createdAt: null, updatedAt: null }) }));
    try {
      expect(user.wrapper.find('[data-testid="assist-elapsed-m-1"]').exists()).toBe(false);
      expect(unknown.wrapper.find('[data-testid="assist-elapsed-m-1"]').exists()).toBe(false);
    } finally { user.unmount(); unknown.unmount(); }
  });

  it("整条消息行里，耗时落在角色与时间之后", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [{ id: sessionId,
        workspace_id: workspaceId, project_id: projectId, task_id: null, title: "会话", status: "ACTIVE",
        revision: "1", created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" }] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT", status: "COMPLETED",
          intent: "DISCUSS", content: "回复", error_code: null, provider_error_kind: null, sources: [],
          skill: null, skill_input: null, skill_output: null,
          usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: null,
            cache_creation_tokens: null }, cancel_requested: false, attachments: [],
          created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:01:05.000Z" }] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      const meta = view.wrapper.get(".agent-message-meta").text();
      expect(meta).toContain("耗时 1 分 05 秒");
      expect(meta.indexOf("耗时")).toBeGreaterThan(meta.indexOf("AI"));
    } finally { view.unmount(); }
  });
});
