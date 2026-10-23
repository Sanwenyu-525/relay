import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 发送键的提交态契约（2026-10-19 用户反馈「发送消息界面会闪一下」）。
 *
 * 点发送后 busy/pending 会把发送键 disabled，全局禁用配色（浅灰底）随之盖上来，
 * 回执一到又跳回主色——协作页上这一次变色读起来就是界面闪一下。契约：
 *   1. 提交窗口内发送键带 `data-busy="true"` 且仍 disabled（不重复提交）；
 *   2. CSS 按 data-busy 保持主色（.primary-button:disabled 的浅灰被覆盖），
 *      键在提交前后配色不变，闪源消除；
 *   3. 「命令结果待核对」块只在结果不明（pendingUnresolved）时出现，
 *      正常发送的在途窗口不得闪现（2026-10-19 同源反馈的另一半）。
 * 走 /projects/:id?skill=assist（重定向到协作页 /agent?project=…）：
 * 与用户实际看到的独立对话卡共用同一份 AssistSessionPanel 发送链路。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "关于测试项目", status: "ACTIVE", revision: "1",
    created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" };
}

function message(id: string, seq: string, role: string, status: string, content: string | null) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}

/** 样式表里是否存在选择器含指定片段的规则（jsdom 的 getComputedStyle 不解析 var()，只能按规则断言）。 */
function hasCssRule(fragment: string): boolean {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(fragment)) return true;
    }
  }
  return false;
}

interface Harness {
  release: (result: Record<string, unknown>) => void;
  setAssistantStatus: (status: "RUNNING" | "COMPLETED" | null) => void;
}

function stubFetch(harness: Harness) {
  let assistantStatus: "RUNNING" | "COMPLETED" | null = null;
  harness.setAssistantStatus = (status) => { assistantStatus = status; };
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
    if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST") {
      const items = [message("66666666-6666-4666-8666-666666666666", "1", "USER", "COMPLETED", "早先消息")];
      if (assistantStatus !== null) {
        items.push(message("88888888-8888-4888-8888-888888888888", "2", "USER", "COMPLETED", "新的一条"));
        items.push(message("99999999-9999-4999-8999-999999999999", "3", "ASSISTANT", assistantStatus, "好的。"));
      }
      return response({ items });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
      const commandId = (JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>).command_id;
      return await new Promise<Response>((resolve) => { harness.release = (result) =>
        resolve(response({ command_id: commandId, committed_at: "2026-09-26T00:00:00Z", result }, 202)); });
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

describe("发送键提交态（发送消息不闪禁用灰）", () => {
  it("提交窗口内 data-busy 置位、键仍禁用、CSS 保持主色，且待核对块不闪现", async () => {
    const harness: Harness = { release: () => undefined, setAssistantStatus: () => undefined };
    vi.stubGlobal("fetch", stubFetch(harness));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      await flush(200);
      // 视觉契约的 CSS 侧：主色覆盖规则必须在样式表里，否则 data-busy 形同虚设。
      expect(hasCssRule('.agent-chat-send[data-busy="true"]')).toBe(true);

      const send = () => view.wrapper.get('[data-testid="assist-send"]');
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("新的一条");
      await flush();
      expect(send().attributes("data-busy")).toBeUndefined();
      expect(send().attributes("disabled")).toBeUndefined();

      await send().trigger("click");
      await flush(0);
      // 提交窗口（POST 未返回）：键被禁用防重复提交，但 data-busy 让它保持主色不闪灰；
      // 「命令结果待核对」块只在结果不明时出现，在途窗口不得闪现。
      expect(send().attributes("data-busy")).toBe("true");
      expect(send().attributes("disabled")).toBeDefined();
      expect(document.querySelector(".assist-pending")).toBeNull();

      harness.setAssistantStatus("RUNNING");
      harness.release({ session_id: sessionId, user_message_id: "88888888-8888-4888-8888-888888888888",
        assistant_message_id: "99999999-9999-4999-8999-999999999999" });
      await flush(120);
      // 回执后进入在途：停止键同位接棒，输入卡在途标记置位，待核对块依旧不出现。
      expect(document.querySelector('[data-testid="assist-stop"]')).not.toBeNull();
      expect(view.wrapper.get('[data-testid="assist-composer"]').attributes("data-inflight")).toBe("true");
      expect(document.querySelector(".assist-pending")).toBeNull();
    } finally { view.unmount(); }
  });

  /**
   * 停止键在提交窗口内接棒时同样不画禁用灰（DEV-0110）：有 RUNNING 回复时发送键的位置
   * 由停止键承担，点发送后 busy/pending 把它 disabled；若它退回全局禁用色，用户看到的是
   * 「发送时那个键又变灰，回执后才变绿」。契约与发送键一致：data-busy 保持主色，
   * 输入卡边框在提交窗口内也保持主色（data-busy），回执后焦点接回正文。
   */
  it("在途回复下的提交窗口：停止键保持主色、输入卡边框不变、回执后焦点回到正文", async () => {
    const harness: Harness = { release: () => undefined, setAssistantStatus: () => undefined };
    vi.stubGlobal("fetch", stubFetch(harness));
    harness.setAssistantStatus("RUNNING");
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    try {
      await flush(200);
      expect(hasCssRule('.agent-chat-send[data-busy="true"]')).toBe(true);
      expect(hasCssRule('.agent-chat-composer[data-busy="true"]')).toBe(true);

      const composer = () => view.wrapper.get('[data-testid="assist-composer"]');
      const stop = () => view.wrapper.get('[data-testid="assist-stop"]');
      expect(stop().attributes("data-busy")).toBeUndefined();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("在途时再发一条");
      await flush();
      // 在途回复把发送键位让给停止键；此时 Enter 仍是「排队发送」，走同一条提交通路。
      await view.wrapper.get('[data-testid="assist-draft"]').trigger("keydown", { key: "Enter" });
      await flush(0);

      // 提交窗口：停止键仍 disabled（不重复提交/停止），但 data-busy 让它保持主色。
      expect(stop().attributes("data-busy")).toBe("true");
      expect(stop().attributes("disabled")).toBeDefined();
      expect((stop().element as HTMLElement).matches('.agent-chat-composer-actions .agent-chat-send[data-busy="true"]'))
        .toBe(true);
      // 正文被禁用不可再输入，但输入卡仍按主色描边，不随焦点掉到 body 而淡回灰边。
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).disabled).toBe(true);
      expect(composer().attributes("data-busy")).toBe("true");
      expect((composer().element as HTMLElement).matches('.agent-chat-composer[data-busy="true"]')).toBe(true);

      harness.release({ session_id: sessionId, user_message_id: "88888888-8888-4888-8888-888888888888",
        assistant_message_id: "99999999-9999-4999-8999-999999999999" });
      await flush(120);

      // 回执后：键回到可操作档，data-busy 撤销；焦点接回正文，边框继续由焦点维持主色。
      expect(stop().attributes("data-busy")).toBeUndefined();
      expect(stop().attributes("disabled")).toBeUndefined();
      expect(composer().attributes("data-busy")).toBeUndefined();
      const draft = view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement;
      expect(draft.disabled).toBe(false);
      expect(document.activeElement).toBe(draft);
    } finally { view.unmount(); }
  });
});
