import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 一条回复失败时，常显那一行的语言（2026-11-01 P0-3 / P1-1）。
 *
 * 改之前这一行是 `生成失败：MODEL_EMPTY_REPLY`：用户读到的是服务端枚举名，不是一件能处理的
 * 事实；同时它用 `.action-error`（整幅填色加边框的红块），把「一次没产出正文」画得像事故现场。
 *
 * 钉住四条：
 *   * 常显行说人话，且这一行里不出现机器码；原始码留在就地展开的详情里。
 *   * 详情默认收起，展开语言沿用会话里已有的右向箭头。
 *   * 失败块里没有服务端不存在的操作按钮（重新发送走输入栏）。
 *   * Provider 分类已经说明原因时，主行不把同一个原因再说一遍。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const messageId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function failedMessage(fields: Record<string, unknown>) {
  return { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT", status: "FAILED",
    intent: "DISCUSS", content: null, error_code: "MODEL_EMPTY_REPLY", provider_error_kind: null,
    sources: [], skill: null, skill_input: null, skill_output: null,
    usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: null, cache_creation_tokens: null },
    cancel_requested: false, attachments: [],
    created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:12.000Z", ...fields };
}

async function openSession(messageFields: Record<string, unknown>) {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/assist-sessions`) return response({ items: [{ id: sessionId,
      workspace_id: workspaceId, project_id: projectId, task_id: null, title: "会话", status: "ACTIVE",
      revision: "1", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
      failedMessage(messageFields)] });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    throw new Error(`unexpected request ${path}`);
  }));
  const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
  await flush(40);
  return view;
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("回复失败行", () => {
  it("常显行是人和解，机器码只出现在展开的详情里", async () => {
    const { wrapper, unmount } = await openSession({});
    try {
      const line = wrapper.get(".assist-failure-line");
      expect(line.text()).toContain("没有给出正文");
      expect(line.text()).not.toContain("MODEL_EMPTY_REPLY");
      // 码没有消失，只是从常显位置退到第二层：Scenario Lab 与追溯仍读得到。
      expect(wrapper.get(".assist-failure-details").text()).toContain("MODEL_EMPTY_REPLY");
    } finally { unmount(); }
  });

  it("详情默认收起，展开用的是会话里已有的箭头", async () => {
    const { wrapper, unmount } = await openSession({});
    try {
      expect(wrapper.get(".assist-failure-details").attributes("open")).toBeUndefined();
      expect(wrapper.find(".assist-failure-details .chat-disclosure-chevron").exists()).toBe(true);
    } finally { unmount(); }
  });

  it("失败块里不造服务端没有的操作按钮", async () => {
    const { wrapper, unmount } = await openSession({});
    try {
      expect(wrapper.get(".assist-failure").find("button").exists()).toBe(false);
    } finally { unmount(); }
  });

  it("Provider 分类已说明原因时，主行不把同一个原因再讲一遍", async () => {
    const { wrapper, unmount } = await openSession({
      error_code: "MODEL_FAILED", provider_error_kind: "TIMEOUT" });
    try {
      const line = wrapper.get(".assist-failure-line").text();
      const guide = wrapper.get('[data-testid="assist-provider-error"]').text();
      expect(line).toBe("模型这一轮没有产出回复。已读取资料与工具记录保留，可再问一次。");
      expect(guide).toContain("模型服务：");
      expect(line).not.toBe(guide);
      // 分类只在该由 Provider 解释时才由那一行解释；两层各自只说一次。
      expect(wrapper.text().match(/模型这一轮没有产出回复/g)?.length).toBe(1);
    } finally { unmount(); }
  });
});
