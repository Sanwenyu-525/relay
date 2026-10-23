import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 首条消息的提交相位（DEV-0110，2026-10-21 用户反馈「发送后输入框与聊天区变成截图那样，
 * 界面会闪烁一下」）。这一层锁三件事：
 *   1. 「正在发送首条消息…」只给辅助技术，不再以可见 helper-text 占一行流式高度——
 *      它出现/消失时会把输入卡抬高又放下，正是首条发送的闪源；
 *   2. 建会话成功后的重挂载首帧由创建投影种子直接渲染会话面板，列表还没读回时
 *      不得退回空白首条输入器或「当前目标还没有会话」这类未核实的结论；
 *   3. 202 回执确认了首条消息、但消息投影还没读回时，空态停在「还没有消息」，
 *      不闪回欢迎空态；真正没有消息的会话仍显示欢迎（命令 id 按会话归属过滤）。
 * 真实几何与配色由 Chromium 探针取证；这里只锁客户端行为与两条 CSS 契约。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sessionRow() {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "关于Relay-Agent", status: "ACTIVE", revision: "1", working_resource_id: null,
    context: { project_goals: [], working_directory: null },
    created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z" };
}

function userMessage(content: string) {
  return { id: "u-1", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED",
    intent: "DISCUSS", created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z",
    content, error_code: null, provider_error_kind: null, sources: [], skill: null,
    cancel_requested: false, attachments: [],
    usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null, cache_creation_tokens: null } };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** 样式表里是否存在选择器含指定片段的规则（jsdom 不解析 var()，只能按规则断言）。 */
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
  createGate: { promise: Promise<void>; release: () => void };
  sessionsGate: { promise: Promise<void>; release: () => void };
  messageGate: { promise: Promise<void>; release: () => void };
  /** 首条消息已确认后，消息列表是否已能看到这条投影；false 模拟读回之前的空窗。 */
  visible: { value: boolean };
  /** 第二条列表请求（重挂载那一拍）是否扣住，模拟种子先于列表读回渲染。 */
  sessionsGateFromSecondAfterCreate: number;
  /** 挂载时列表里就已有这条会话（真正没有消息的会话）。 */
  initiallyListed: boolean;
  requests: string[];
}

function stubFetch(harness: Harness) {
  let created = false;
  let listAfterCreate = 0;
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    harness.requests.push(`${init?.method ?? "GET"} ${path}`);
    const getSession = path === `${prefix}/assist-sessions/${sessionId}`;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (path === `${prefix}/assist-sessions`) {
        await harness.createGate.promise;
        created = true;
        return response({ command_id: body.command_id, committed_at: "2026-10-21T10:00:00Z",
          result: { session_id: sessionId, project_id: null, task_id: null,
            title: "关于Relay-Agent", status: "ACTIVE", revision: "1",
            created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z",
            conversation_mode: "AGENT", chat_mode: "CHAT" } }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        await harness.messageGate.promise;
        return response({ command_id: body.command_id, committed_at: "2026-10-21T10:00:00Z",
          result: { session_id: sessionId, user_message_id: "u-1", assistant_message_id: "a-1" } }, 202);
      }
      throw new Error(`unexpected POST ${path}`);
    }
    if (path === `${prefix}/assist-sessions`) {
      // 创建后的第二次列表请求（重挂载那一拍）被扣住：首帧必须靠创建投影种子渲染。
      if (created) {
        listAfterCreate += 1;
        if (listAfterCreate >= harness.sessionsGateFromSecondAfterCreate) await harness.sessionsGate.promise;
      }
      return response({ items: created || harness.initiallyListed ? [sessionRow()] : [] });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return response({ items: harness.visible.value ? [userMessage("在根目录下创建一个aa.md")] : [] });
    }
    if (getSession) return response(sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) {
      return response({ model: null, revision: "0" });
    }
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff`) {
      return response({ available: false, reason: "NO_BASELINE" });
    }
    if (path === `${prefix}/model-port`) {
      return response({ provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    }
    return response({ items: [], next_cursor: null });
  });
}

beforeEach(() => { window.localStorage.clear(); document.documentElement.dataset.motion = "on"; });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

function harness(over: Partial<Harness> = {}): Harness {
  return { createGate: gate(), sessionsGate: gate(), messageGate: gate(), visible: { value: false },
    sessionsGateFromSecondAfterCreate: 2, initiallyListed: false, requests: [], ...over };
}

describe("首条消息提交相位（不闪、不异常变色）", () => {
  it("状态行只给辅助技术；建会话后首帧由种子渲染；回执后不闪欢迎空态", async () => {
    const state = harness();
    vi.stubGlobal("fetch", stubFetch(state));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench("/agent");
    try {
      await flush(200);
      expect(view.wrapper.get('[data-testid="assist-first-draft"]').exists()).toBe(true);
      expect(hasCssRule('.agent-chat-composer[data-busy="true"]')).toBe(true);
      expect(hasCssRule('.agent-chat-send[data-busy="true"]')).toBe(true);

      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("在根目录下创建一个aa.md");
      await flush();
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
      await flush(0);

      // 建会话在途：状态只给辅助技术，不再以可见行占高度；输入卡保持主色档。
      const status = view.wrapper.get('[data-testid="assist-first-sending-status"]');
      expect(status.attributes("class")).toContain("visually-hidden");
      expect(status.attributes("class")).not.toContain("helper-text");
      expect(view.wrapper.get('[data-testid="assist-first-message"]')
        .find(".agent-chat-composer").attributes("data-busy")).toBe("true");
      expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("data-busy")).toBe("true");
      expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).disabled)
        .toBe(true);

      // 创建回执已到、重挂载那一拍的列表仍被扣住：新实例必须直接用创建投影渲染会话面板，
      // 不能先退回空白首条输入器，也不能显示「当前目标还没有会话」这类未核实的结论。
      state.createGate.release();
      await flush(80); await flush();
      expect(view.wrapper.get('[data-testid="assist-composer"]').exists()).toBe(true);
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(false);
      expect(document.body.textContent).not.toContain("当前目标还没有会话");
      // 首条消息仍在途：只留一行安静状态，欢迎空态不出现。
      const pending = view.wrapper.get('[data-testid="assist-first-pending"]');
      expect(pending.attributes("data-state")).toBe("sending");
      expect(pending.text()).toContain("正在发送首条消息");
      expect(document.querySelector('[data-testid="assist-empty-welcome"]')).toBeNull();

      // 列表读回后仍是同一张会话面板，没有第二次整页替换。
      state.sessionsGate.release();
      await flush(80);
      expect(view.wrapper.get('[data-testid="assist-composer"]').exists()).toBe(true);

      // 202 回执确认了首条消息，但消息投影还没读回：停在「还没有消息」，不闪回欢迎。
      state.messageGate.release();
      await flush(120); await flush();
      expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
      expect(document.querySelector('[data-testid="assist-empty-welcome"]')).toBeNull();
      expect(view.wrapper.text()).toContain("还没有消息");
    } finally { view.unmount(); }
  });

  it("真正没有消息的会话仍显示欢迎空态（确认命令按会话归属过滤）", async () => {
    const state = harness({ initiallyListed: true });
    state.sessionsGate.release(); state.createGate.release(); state.messageGate.release();
    vi.stubGlobal("fetch", stubFetch(state));
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const view = await mountWorkbench(`/agent?session=${sessionId}`);
    try {
      await flush(200);
      expect(document.querySelector('[data-testid="assist-empty-welcome"]')).not.toBeNull();
      expect(view.wrapper.get('[data-testid="assist-empty-welcome"]').text()).toContain("有什么想一起完成的");
    } finally { view.unmount(); }
  });
});
