import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { mountWorkbench } from "./mountApp";

// 消息级复制（页面原型 V5.0 的悬停操作落地的第一步）：助手回复的复制既有（2026-10-16），
// 这里补用户消息一侧，并锁两条共同语义——复制是纯客户端剪贴板动作、失败不装成功。

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const userMessageId = "44444444-4444-4444-8444-444444444444";
const assistantMessageId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
  return () => {
    if (original === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
    else Object.defineProperty(window.navigator, "clipboard", original);
  };
}

let unmount: (() => void) | null = null;
let restoreClipboard: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  restoreClipboard?.(); restoreClipboard = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

async function mountConversation(userContent: string = "帮我整理这段安排") {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname;
    if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/assist-sessions`) return response({ items: [{ id: sessionId,
      workspace_id: workspaceId, project_id: projectId, task_id: null, title: "会话", status: "ACTIVE",
      revision: "1", created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z" }] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
      { id: userMessageId, session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED",
        intent: "DISCUSS", content: userContent, error_code: null, provider_error_kind: null,
        sources: [], skill: null, skill_input: null, skill_output: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: null,
          cache_creation_tokens: null }, cancel_requested: false, attachments: [],
        created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:00:00.000Z" },
      { id: assistantMessageId, session_id: sessionId, seq: "2", role: "ASSISTANT", status: "COMPLETED",
        intent: "DISCUSS", content: "回复", error_code: null, provider_error_kind: null, sources: [],
        skill: null, skill_input: null, skill_output: null,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: null,
          cache_creation_tokens: null }, cancel_requested: false, attachments: [],
        created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:01:05.000Z" }] });
    if (path === `${prefix}/assist-proposals`) return response({ items: [] });
    if (path === `${prefix}/skill-definitions`) return response({ items: [] });
    throw new Error(`unexpected request ${path}`);
  }));
  const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
  unmount = view.unmount;
  return view.wrapper;
}

describe("消息级复制", () => {
  it("用户消息带复制键：点击把正文写进剪贴板并短暂改可读名；助手回复的复制键仍在场", async () => {
    const writeText = vi.fn(async () => undefined);
    restoreClipboard = stubClipboard(writeText);
    const wrapper = await mountConversation();
    const userCopy = wrapper.get(`[data-testid="assist-copy-user-${userMessageId}"]`);
    expect(userCopy.attributes("aria-label")).toBe("复制这条消息");
    // 对照：助手回复的复制键是既有行为，两条消息各有一枚。
    expect(wrapper.get(`[data-testid="assist-copy-${assistantMessageId}"]`).attributes("aria-label"))
      .toBe("复制这条回复");
    await userCopy.trigger("click");
    expect(writeText).toHaveBeenCalledWith("帮我整理这段安排");
    expect(wrapper.get(`[data-testid="assist-copy-user-${userMessageId}"]`).attributes("aria-label"))
      .toBe("已复制这条消息");
  });

  it("剪贴板写失败时按钮还原成可重试，不发成功回执", async () => {
    restoreClipboard = stubClipboard(vi.fn(async () => { throw new Error("denied"); }));
    const wrapper = await mountConversation();
    const userCopy = wrapper.get(`[data-testid="assist-copy-user-${userMessageId}"]`);
    await userCopy.trigger("click");
    expect(wrapper.get(`[data-testid="assist-copy-user-${userMessageId}"]`).attributes("aria-label"))
      .toBe("复制这条消息");
  });

  it("空正文的用户消息不摆复制键：没有可复制的内容就不占一行", async () => {
    const wrapper = await mountConversation("");
    expect(wrapper.findAll('[data-testid^="assist-copy-user-"]')).toHaveLength(0);
    // 对照：有正文的助手回复仍有复制键。
    expect(wrapper.findAll('[data-testid^="assist-copy-"]')).toHaveLength(1);
  });
});
