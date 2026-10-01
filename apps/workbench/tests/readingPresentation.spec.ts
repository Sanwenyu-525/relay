import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import KnowledgeReader from "../src/components/KnowledgeReader";
import { DISPLAY_PREFERENCES_STORAGE_KEY, formatReadableDateTime, saveDisplayPreferences } from "../src/lib/displayPreferences";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-4333-4333-8333-333333333333";
const knowledgeId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";
const runningMessageId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const runUrl = `${baseUrl}${prefix}/runs/${runId}`;
let unmount: (() => void) | null = null;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "原会话", status: "ACTIVE", revision: "1", updated_at: "2026-09-26T00:00:00Z" };
}
function message(id: string, seq: string, role: string, status: string, content: string | null) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}
function preview(text: string | null) {
  return { session_id: sessionId, message_id: runningMessageId, status: "RUNNING", preview_revision: "1",
    preview_text: text, preview_truncated: false, preview_available: true };
}
function knowledge() {
  return { id: knowledgeId, projectId: null, title: "设计资料", status: "ACTIVE", revision: "0",
    currentVersion: "1", createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" };
}
function knowledgeVersion() {
  return { id: "88888888-8888-4888-8888-888888888888", knowledgeId, version: "1",
    sourceKind: "NOTE", mediaType: "text/markdown", contentSha256: "a".repeat(64),
    availability: "AVAILABLE", excerpt: "受管摘录", sourceRefs: {}, createdAt: "2026-09-23T00:00:05.000Z" };
}
function task() {
  return { id: taskId, project_id: null, title: "运行页任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
    revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "目标", source: "CREATE", criteria: [] }, dependencies: [] };
}
function run() {
  return { id: runId, task_id: taskId, status: "RUNNING", revision: "3", ownership_epoch: "1", retry_of_run_id: null,
    current_step_id: "step-1", wait_reason: null, created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:01:00.000Z", terminal_at: null,
    contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1",
      acceptance_revision: "1", contract_hash: "a".repeat(64) }, current_step: null,
    steps: [{ step_id: "step-0", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED",
      started_at: "2026-09-23T00:00:00.000Z", finished_at: "2026-09-23T00:00:05.000Z", reason: null },
    { step_id: "step-1", step_index: 1, step_kind: "DRAFT", status: "RUNNING",
      started_at: "2026-09-23T00:00:06.000Z", finished_at: null, reason: null }],
    recent_attempts: [], result_refs: [], blocking_review_ids: [], pending_control_request: null,
    unresolved_operation_ids: [] };
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
  localStorage.removeItem(DISPLAY_PREFERENCES_STORAGE_KEY);
});

describe("AI 最终回复的 Markdown 展示", () => {
  it("已完成回复按安全 Markdown 呈现粗体、列表、行内代码、代码块与链接", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const markdown = ["**CANCELLED**", "", "- 第一项 `pnpm test`", "- 第二项", "",
      "```bash", "pnpm build", "```", "", "依据见 [原始记录](https://example.com/evidence)。"].join("\n");
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("99999999-9999-4999-8999-999999999999", "1", "USER", "COMPLETED", "**不要渲染**"),
        message("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2", "ASSISTANT", "COMPLETED", markdown)] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    const reply = view.wrapper.get('.agent-message[data-role="ASSISTANT"] .assist-message-markdown');
    expect(reply.text()).not.toContain("**CANCELLED**");
    expect(reply.get("strong").text()).toBe("CANCELLED");
    expect(reply.findAll("ul li").map((item) => item.text())).toEqual(["第一项 pnpm test", "第二项"]);
    expect(reply.get("li code").text()).toBe("pnpm test");
    expect(reply.get("pre code").text()).toBe("pnpm build");
    expect(reply.get("a").attributes("href")).toBe("https://example.com/evidence");
    expect(reply.get("a").attributes("rel")).toBe("noreferrer noopener");
    const user = view.wrapper.get('.agent-message[data-role="USER"] .assist-message-content');
    expect(user.text()).toBe("**不要渲染**");
    expect(user.find(".markdown-preview").exists()).toBe(false);
  });

  it("生成中草稿仍按纯文本显示，不提前渲染 Markdown", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message(runningMessageId, "1", "ASSISTANT", "RUNNING", null)] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages/${runningMessageId}/live-preview`) {
        return response(preview("**尚未完成**\n- 草稿项"));
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`); unmount = view.unmount;
    await flush(450);
    const draft = view.wrapper.get(`[data-testid="assist-live-preview-${runningMessageId}"]`);
    expect(draft.get(".assist-message-content").text()).toBe("**尚未完成** - 草稿项");
    expect(draft.find(".markdown-preview").exists()).toBe(false);
    expect(view.wrapper.find(".assist-message-markdown").exists()).toBe(false);
  });
});

describe("资料与 Run 时间的可读展示", () => {
  it("统一按本设备显示时区呈现日期时间，原始 ISO 仍保留在 time.dateTime", () => {
    expect(formatReadableDateTime("2026-09-23T00:00:05.000Z", "Asia/Shanghai")).toBe("2026-09-23 08:00:05");
    expect(formatReadableDateTime("2026-09-23T00:00:05.000Z", "UTC")).toBe("2026-09-23 00:00:05");
    expect(formatReadableDateTime("2026-09-22T16:00:00.000Z", "Asia/Shanghai")).toBe("2026-09-23 00:00:00");
    expect(formatReadableDateTime("不是时间", "Asia/Shanghai")).toBe("不是时间");
  });

  it("资料保存时间随本设备时区变化且保留原始值", async () => {
    const client = { getKnowledgeVersionContent: vi.fn(async () => ({
      ...knowledgeVersion(), title: "设计资料", projectId: null, currentVersion: "1", sourceUri: null,
      contentStatus: "FULL", content: "# 正文" })) };
    const mounted = await mountReact(createElement(KnowledgeReader, {
      client: client as never, knowledge: knowledge() as never, versions: [knowledgeVersion()] as never,
      initialVersion: null }));
    unmount = mounted.unmount;
    await flush();
    const saved = mounted.wrapper.get(".knowledge-reader__toolbar time");
    expect(saved.text()).toBe("2026-09-23 08:00:05");
    expect(saved.attributes("dateTime")).toBe("2026-09-23T00:00:05.000Z");
    expect(saved.attributes("title")).toBe("Asia/Shanghai");
    expect(mounted.wrapper.get(".knowledge-reader__source time").text()).toBe("2026-09-23 08:00:05");
    mounted.unmount(); unmount = null;
    saveDisplayPreferences({ timeZone: "UTC", defaultWorkbench: "general" });
    const utc = await mountReact(createElement(KnowledgeReader, {
      client: client as never, knowledge: knowledge() as never, versions: [knowledgeVersion()] as never,
      initialVersion: null }));
    unmount = utc.unmount;
    await flush();
    expect(utc.wrapper.get(".knowledge-reader__toolbar time").text()).toBe("2026-09-23 00:00:05");
  });

  it("Run 步骤起止时间可读，空值仍按未开始/未结束表达", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const address = String(input);
      if (address === runUrl) return response(run());
      if (address === `${baseUrl}${prefix}/tasks/${taskId}`) return response(task());
      if (address === `${runUrl}/reviews`) return response({ items: [] });
      throw new Error(`unexpected request ${address}`);
    }));
    const view = await mountWorkbench(`/runs/${runId}`); unmount = view.unmount;
    await flush(30);
    const steps = view.wrapper.findAll(".run-step-time").map((item) => item.text());
    expect(steps[0]).toBe("2026-09-23 08:00:00 → 2026-09-23 08:00:05");
    expect(steps[1]).toBe("2026-09-23 08:00:06 → 未结束");
    const times = view.wrapper.findAll(".run-step-time time");
    expect(times[0]!.attributes("dateTime")).toBe("2026-09-23T00:00:00.000Z");
    expect(times[0]!.attributes("title")).toBe("Asia/Shanghai");
    expect(view.wrapper.get('[data-testid="run-steps"]').text()).not.toContain("2026-09-23T00:00:00.000Z");
  });
});
