import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, folderStripName, mountWorkbench } from "./mountApp";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const root = `/api/v1/workspaces/${workspaceId}`;
const oldSession = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
  title: "已有普通讨论", status: "ACTIVE", revision: "1", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" };
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });
function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
async function mount(path = "/agent", withOldSession = false,
  failure?: "CREATE_RESPONSE_LOST" | "MESSAGE_RESPONSE_LOST", withTaskSession = false, messageGate?: Promise<void>) {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
  const posts: { path: string; body: Record<string, unknown> }[] = []; let created = false;
  const messages: unknown[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({ path, body });
      if (path === `${root}/assist-sessions`) {
        created = true;
        const receipt = { command_id: body.command_id, command_type: "CreateAssistSession", payload_hash: "a".repeat(64),
          committed_at: "2026-10-05T00:00:00Z", result: { session_id: sessionId, ...oldSession } };
        receipts.set(String(body.command_id), receipt);
        if (failure === "CREATE_RESPONSE_LOST") throw new TypeError("response lost");
        return response(receipt, 201);
      }
      if (path === `${root}/assist-sessions/${sessionId}/messages`) {
        await messageGate;
        const index = messages.length / 2 + 1;
        messages.push({ id: `u${index}`, session_id: sessionId, seq: String(index * 2 - 1), role: "USER",
          status: "COMPLETED", intent: "DISCUSS", content: body.content, error_code: null,
          sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false },
        { id: `a${index}`, session_id: sessionId, seq: String(index * 2), role: "ASSISTANT",
          status: "COMPLETED", intent: "DISCUSS", content: `第 ${index} 条回复`, error_code: null,
          sources: [], usage: { input_tokens: 10, output_tokens: 5 }, cancel_requested: false });
        const receipt = { command_id: body.command_id, command_type: "RequestAssistMessage", payload_hash: "a".repeat(64),
          committed_at: "2026-10-05T00:00:00Z",
          result: { session_id: sessionId, user_message_id: `u${index}`, assistant_message_id: `a${index}` } };
        receipts.set(String(body.command_id), receipt);
        if (failure === "MESSAGE_RESPONSE_LOST") throw new TypeError("response lost");
        return response(receipt, 202);
      }
      throw new Error(`Unexpected command: ${path}`);
    }
    if (path === `${root}/assist-sessions`) return response({ items: [
      ...(withTaskSession ? [{ ...oldSession, id: "77777777-7777-4777-8777-777777777777",
        task_id: "33333333-3333-4333-8333-333333333333", title: "无项目任务的专属会话" }] : []),
      ...(withOldSession || created ? [oldSession] : [])] });
    if (path === `${root}/assist-sessions/${sessionId}`) return response(oldSession);
    if (path.startsWith(`${root}/commands/`)) return response(receipts.get(path.split("/").at(-1)!) ?? {}, 200);
    if (path.endsWith("/messages")) return response({ items: messages });
    if (path.endsWith("/skills")) return response({ items: [] });
    return response({ items: [], next_cursor: null });
  }));
  const view = await mountWorkbench(path); unmount = view.unmount; await flush(80);
  return { ...view, posts };
}

describe("新对话直接起步", () => {
  it("无项目任务的专属会话不会混入普通讨论", async () => {
    const view = await mount("/agent", false, undefined, true);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.text()).not.toContain("无项目任务的专属会话");
    expect(view.posts).toHaveLength(0);
  });
  it("明确新对话不恢复旧会话；空白页只有输入主区，目录与已有任务按需展开", async () => {
    const view = await mount("/agent?new=entry", true);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists(), view.wrapper.text()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="collab-side-empty"]').exists()).toBe(false);
    // 目录作用域已收成常驻细条（不再是要先展开的 details），「查找更多任务 / 会话」默认收起。
    expect(view.wrapper.get('[data-testid="folder-scope-strip"]').exists()).toBe(true);
    expect(folderStripName()).toBe("未选择目录");
    expect(view.wrapper.get('[data-testid="recent-work-find-more"]').attributes("aria-expanded")).toBe("false");
    expect(view.wrapper.find('[data-testid="collab-target-picker"]').exists()).toBe(false);
    expect(view.posts).toHaveLength(0);
  });

  it("全局新对话可重复打开真正的空白输入，不创建空会话", async () => {
    const view = await mount("/agent", true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists(), view.wrapper.text()).toBe(true);
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    const firstHref = view.wrapper.get('[data-testid="context-new-conversation"]').attributes("href");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="context-new-conversation"]').attributes("href")).not.toBe(firstHref);
    expect(view.posts).toHaveLength(0);
  });

  it("没有项目或目录也能直接发送，首条只建一次会话并保存原文，不发执行请求", async () => {
    const view = await mount("/agent?new=entry");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("先帮我想清楚下一步");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush(); await flush();
    expect(view.posts.map(p => p.path)).toEqual([`${root}/assist-sessions`, `${root}/assist-sessions/${sessionId}/messages`]);
    expect(view.posts[0]?.body.project_id).toBeNull(); expect(view.posts[0]?.body.task_id).toBeNull();
    expect(view.posts[1]?.body.content).toBe("先帮我想清楚下一步");
    expect(view.posts[1]?.body.intent).toBe("DISCUSS");
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第 1 条回复");
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("接着讨论刚才的想法");
    await view.wrapper.get('[data-testid="assist-send"]').trigger("click"); await flush(); await flush();
    expect(view.posts.map(p => p.path)).toEqual([`${root}/assist-sessions`,
      `${root}/assist-sessions/${sessionId}/messages`, `${root}/assist-sessions/${sessionId}/messages`]);
    expect(view.posts[2]?.body.intent).toBe("DISCUSS");
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第 2 条回复");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.posts).toHaveLength(3);
  });

  it("会话内新建同样先打开输入框，不提前创建空会话", async () => {
    const view = await mount("/agent", true);
    await view.wrapper.get('[data-testid="assist-new-session"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.posts).toHaveLength(0);
  });

  it("会话先读到空列表、首条稍后提交时，送达后自动读到消息", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const view = await mount("/agent?new=entry", false, undefined, false, gate);
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("稍后送达的首条消息");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("还没有消息");
    release(); await flush(); await flush();
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("稍后送达的首条消息");
    expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第 1 条回复");
    expect(view.posts).toHaveLength(2);
  });

  it("核对首条回执后另开新对话，迟到原响应不清空新草稿", async () => {
    const view = await mount("/agent?new=entry");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const result = await original(input, init);
      if (init?.method === "POST" && String(input).endsWith("/messages")) await gate;
      return result;
    }));
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("原会话的首条消息");
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="assist-first-receipt"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="assist-new-session"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("新会话还没发送的草稿");
    release(); await flush(); await flush();
    expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value)
      .toBe("新会话还没发送的草稿");
    expect(view.posts).toHaveLength(2);
  });

  it("新对话不丢未发送输入；取消离开后仍可继续原草稿", async () => {
    const view = await mount("/agent?new=entry");
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("还没有发送的想法");
    await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("未保存");
    const keep = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "保留并继续编辑");
    expect(keep).toBeDefined(); keep!.click(); await flush();
    expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value).toBe("还没有发送的想法");
    expect(view.posts).toHaveLength(0);
  });

  it.each(["CREATE_RESPONSE_LOST", "MESSAGE_RESPONSE_LOST"] as const)(
    "%s：新对话不得丢弃未决命令，核对原回执后接续普通讨论", async (failure) => {
      const view = await mount("/agent?new=entry", false, failure);
      await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("保留这条原始消息");
      await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click"); await flush();
      await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("命令结果待核对");
      expect(document.querySelector('[data-testid="discard-draft-leave"]')).toBeNull();
      const keep = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "保留并继续编辑");
      keep!.click(); await flush();
      const check = Array.from(view.wrapper.element!.querySelectorAll("button")).find(b =>
        b.textContent === (failure === "CREATE_RESPONSE_LOST" ? "查询创建回执" : "查询首条回执"));
      expect(check).toBeDefined(); await new DomWrapper(check!).trigger("click"); await flush(); await flush();
      expect(view.wrapper.find('[data-testid="assist-first-pending"]').exists()).toBe(false);
      expect(view.posts.filter(p => p.path === `${root}/assist-sessions`)).toHaveLength(1);
      expect(view.posts.filter(p => p.path.endsWith("/messages"))).toHaveLength(1);
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("保留这条原始消息");
      await view.wrapper.get('[data-testid="context-new-conversation"]').trigger("click"); await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    });
});
