import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const secondSessionId = "44444444-4444-4444-8444-444444444444";
const messageId = "55555555-5555-4555-8555-555555555555";
const prefix = `/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function session(id = sessionId) {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: id === sessionId ? "原会话" : "新会话", status: "ACTIVE", revision: "1", updated_at: "2026-09-26T00:00:00Z" };
}
function message(id = messageId, status = "RUNNING", content: string | null = null,
  intent = "DISCUSS", skill: unknown = null, currentSessionId = sessionId) {
  return { id, session_id: currentSessionId, seq: "2", role: "ASSISTANT", status, intent, content,
    error_code: null, sources: [], skill, usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}
function preview(text: string | null, status = "RUNNING") {
  return { session_id: sessionId, message_id: messageId, status,
    preview_revision: text === null ? "0" : "1", preview_text: text,
    preview_truncated: false, preview_available: status === "RUNNING" };
}
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("M04 Assist DISCUSS 生成中草稿", () => {
  it("首片段前只显示等待，随后展示纯文本草稿；终态清草稿并重读完整消息", async () => {
    connect(); let finish = false; let previewCalls = 0;
    let releaseFirst: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message(messageId, finish ? "COMPLETED" : "RUNNING", finish ? "最终完整回复" : null)] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`) {
        previewCalls++;
        if (previewCalls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
        return response(finish ? preview(null, "COMPLETED") : preview("<b>尚未完成的草稿</b>"));
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(releaseFirst).not.toBeNull();
    expect(view.wrapper.find(`[data-testid="assist-live-preview-${messageId}"]`).exists()).toBe(false);
    releaseFirst!(response(preview(null))); await flush();
    expect(view.wrapper.text()).toContain("正在生成");
    expect(view.wrapper.find(`[data-testid="assist-live-preview-${messageId}"]`).exists()).toBe(false);
    await flush(450);
    const draft = view.wrapper.get(`[data-testid="assist-live-preview-${messageId}"]`);
    expect(draft.text()).toContain("生成中草稿");
    expect(draft.text()).toContain("<b>尚未完成的草稿</b>");
    expect(draft.find("b").exists()).toBe(false);
    finish = true;
    await flush(450);
    expect(view.wrapper.find(`[data-testid="assist-live-preview-${messageId}"]`).exists()).toBe(false);
    expect(view.wrapper.text()).toContain("最终完整回复");
    expect(previewCalls).toBeGreaterThanOrEqual(3);
  });

  it("预览失权时清旧草稿，消息列表失权也清旧正文", async () => {
    connect(); let revoked = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return revoked
        ? response({ code: "FORBIDDEN", detail: "revoked" }, 403)
        : response({ items: [message()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`) return revoked
        ? response({ code: "RESOURCE_NOT_FOUND", detail: "revoked" }, 404)
        : response(preview("只在授权时可见的草稿"));
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(view.wrapper.text()).toContain("只在授权时可见的草稿");
    revoked = true;
    await flush(450);
    expect(view.wrapper.text()).not.toContain("只在授权时可见的草稿");
    expect(view.wrapper.find(".assist-message").exists()).toBe(false);
  });

  it("切换会话后旧预览迟到响应不能进入新会话", async () => {
    connect(); let previewCalls = 0;
    let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session(), session(secondSessionId)] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [message()] });
      if (path === `${prefix}/assist-sessions/${secondSessionId}/messages`) return response({ items: [
        message("66666666-6666-4666-8666-666666666666", "COMPLETED", "新会话完整消息", "DISCUSS", null, secondSessionId)] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`) {
        previewCalls++;
        return previewCalls === 1 ? response(preview("原会话已显示草稿"))
          : new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(view.wrapper.text()).toContain("原会话已显示草稿");
    await flush(450);
    expect(releaseOld).not.toBeNull();
    await view.wrapper.get('[data-testid="assist-session-select"]').setValue(secondSessionId);
    await flush();
    releaseOld!(response(preview("迟到的原会话草稿")));
    await flush();
    expect(view.wrapper.text()).toContain("新会话完整消息");
    expect(view.wrapper.text()).not.toContain("原会话已显示草稿");
    expect(view.wrapper.text()).not.toContain("迟到的原会话草稿");
  });

  it("连接重建后按原会话与消息 ID 重新读取草稿", async () => {
    connect(); const previewPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [message()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${messageId}/live-preview`) {
        previewPaths.push(path); return response(preview("原消息草稿"));
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    expect(view.wrapper.text()).toContain("原消息草稿");
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "renewed-token" });
    await flush();
    expect(previewPaths.length).toBeGreaterThanOrEqual(2);
    expect(previewPaths.every((path) => path.endsWith(`/${sessionId}/messages/${messageId}/live-preview`))).toBe(true);
    expect(view.wrapper.text()).toContain("原消息草稿");
  });

  it("Skill 与结构化提案消息不请求 raw 草稿预览", async () => {
    connect(); let previewCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message(messageId, "RUNNING", null, "PROPOSE_TASK"),
        message("77777777-7777-4777-8777-777777777777", "RUNNING", null, "DISCUSS", {
          id: "project-resume", version: "1.0.0", sha256: "hash", target: "PROJECT",
          definition_availability: "AVAILABLE", output_availability: "PENDING", missing_capabilities: []
        })] });
      if (path.includes("/live-preview")) { previewCalls++; throw new Error("raw preview requested"); }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    await flush(450);
    expect(previewCalls).toBe(0);
    expect(view.wrapper.find(`[data-testid="assist-live-preview-${messageId}"]`).exists()).toBe(false);
  });
});
