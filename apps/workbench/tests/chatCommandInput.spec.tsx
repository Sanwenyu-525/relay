import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatCommandInput from "../src/components/ChatCommandInput";
import { RelayApiClient, type RelayConversationMode } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const client = new RelayApiClient({ baseUrl: "http://relay.test", workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });
const entries = [
  { kind: "METHOD", name: "review", aliases: ["代码审查", "审查"], title: "代码审查", summary: "检查当前改动，不自动修复。", usage: "/review [目标]", method_id: "code-review" },
  { kind: "METHOD", name: "diagnose", aliases: ["故障诊断", "诊断"], title: "故障诊断", summary: "默认定位，明确修好才修改。", usage: "/diagnose [目标]", method_id: "fault-diagnosis" },
  ...["clear", "undo", "model", "compact"].map((name) => ({ kind: "SYSTEM", name, aliases: [],
    title: `/${name}`, summary: `会话 ${name}`, usage: `/${name}`, system_id: name }))
];
function stubCatalog() {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ items: entries }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function Composer({ mode = "AGENT", hasSession = true, disabled = false,
  onKey = () => {}, onEscape = () => {}, onSubmit = () => {} }: {
  mode?: RelayConversationMode; hasSession?: boolean; disabled?: boolean;
  onKey?: (key: string) => void; onEscape?: () => void; onSubmit?: () => void;
}) {
  const [draft, setDraft] = useState("");
  return <section onKeyDown={(event) => { if (event.key === "Escape") onEscape(); }}>
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <ChatCommandInput client={client} mode={mode} hasSession={hasSession} value={draft}
        disabled={disabled} onValueChange={setDraft} data-testid="input" onKeyDown={(event) => {
          onKey(event.key);
          if (event.key === "Enter" && !event.shiftKey) event.currentTarget.form?.requestSubmit();
        }} />
      <button type="button" data-testid="outside">其他操作</button>
    </form>
  </section>;
}
async function focus(view: Awaited<ReturnType<typeof mountReact>>) {
  await act(async () => (view.wrapper.get('[data-testid="input"]').element as HTMLTextAreaElement).focus());
}
async function key(input: Element, keyName: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init });
  await act(async () => { input.dispatchEvent(event); });
  return event;
}
afterEach(() => vi.unstubAllGlobals());

describe("聊天命令输入", () => {
  it("只读登记按中英文检索，选择只插入且普通编辑不重读清单", async () => {
    const fetcher = stubCatalog(); const submit = vi.fn();
    const view = await mountReact(<Composer onSubmit={submit} />);
    try {
      await focus(view);
      const input = view.wrapper.get('[data-testid="input"]');
      await input.setValue("/"); await flush();
      expect(view.wrapper.findAll('[role="option"]')).toHaveLength(6);
      await input.setValue("/诊断");
      expect(view.wrapper.findAll('[role="option"]')).toHaveLength(1);
      expect(view.wrapper.get('[role="option"]').text()).toContain("当前任务");
      await key(input.element!, "Enter");
      expect((input.element as HTMLTextAreaElement).value).toBe("/diagnose ");
      expect(document.activeElement).toBe(input.element);
      expect(submit).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    } finally { view.unmount(); }
  });

  it("上下键选中，Esc 只关闭菜单，Shift+Enter 和后续发送仍归原处理器", async () => {
    stubCatalog(); const submit = vi.fn(); const escape = vi.fn(); const forwarded = vi.fn();
    const view = await mountReact(<Composer onSubmit={submit} onEscape={escape} onKey={forwarded} />);
    try {
      await focus(view); const input = view.wrapper.get('[data-testid="input"]');
      await input.setValue("/"); await flush();
      await key(input.element!, "ArrowDown");
      expect(input.attributes("aria-activedescendant")).toBe(view.wrapper.get('[data-testid="chat-command-diagnose"]').attributes("id"));
      await key(input.element!, "ArrowUp");
      await key(input.element!, "Enter");
      expect((input.element as HTMLTextAreaElement).value).toBe("/review ");
      expect(submit).not.toHaveBeenCalled();
      await key(input.element!, "Enter"); expect(submit).toHaveBeenCalledTimes(1);
      await input.setValue("/");
      expect((await key(input.element!, "Escape")).defaultPrevented).toBe(true);
      expect(escape).not.toHaveBeenCalled();
      expect((input.element as HTMLTextAreaElement).value).toBe("/");
      expect(view.wrapper.find('[data-testid="chat-command-menu"]').exists()).toBe(false);
      await input.setValue("/r");
      expect((await key(input.element!, "Enter", { shiftKey: true })).defaultPrevented).toBe(false);
      expect(forwarded).toHaveBeenLastCalledWith("Enter");
      expect(submit).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });

  it("中文组词和 229 不选择或发送，结束组词后可按别名继续选择", async () => {
    stubCatalog(); const forwarded = vi.fn();
    const view = await mountReact(<Composer onKey={forwarded} />);
    try {
      await focus(view); const input = view.wrapper.get('[data-testid="input"]');
      await input.setValue("/"); await flush();
      await act(async () => { input.element!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
      await input.setValue("/审查");
      await key(input.element!, "Enter", { isComposing: true });
      expect(view.wrapper.find('[data-testid="chat-command-menu"]').exists()).toBe(false);
      expect((input.element as HTMLTextAreaElement).value).toBe("/审查");
      await act(async () => { input.element!.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
      await key(input.element!, "Enter", { keyCode: 229 });
      expect(forwarded).not.toHaveBeenCalled();
      await key(input.element!, "Enter");
      expect((input.element as HTMLTextAreaElement).value).toBe("/review ");
    } finally { view.unmount(); }
  });

  it.each(["ASSISTANT", "LEARNING"] as const)("%s 隐藏方法，真实显示未接入与需会话状态", async (mode) => {
    stubCatalog(); const view = await mountReact(<Composer mode={mode} hasSession={false} />);
    try {
      await focus(view); await view.wrapper.get('[data-testid="input"]').setValue("/"); await flush();
      expect(view.wrapper.find('[data-testid="chat-command-review"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="chat-command-clear"]').text()).toContain("需已有会话");
      expect(view.wrapper.get('[data-testid="chat-command-model"]').text()).toContain("需已有会话");
      expect(view.wrapper.get('[data-testid="chat-command-compact"]').text()).toContain("待接入");
    } finally { view.unmount(); }
  });

  it("读取失败保留输入，可重试；关闭菜单不猜清单也不发命令", async () => {
    const fetcher = stubCatalog(); fetcher.mockRejectedValueOnce(new TypeError("offline"));
    const submit = vi.fn(); const view = await mountReact(<Composer onSubmit={submit} />);
    try {
      await focus(view); const input = view.wrapper.get('[data-testid="input"]');
      await input.setValue("/r"); await flush();
      expect(view.wrapper.get('[role="alert"]').text()).toContain("草稿已保留");
      await key(input.element!, "Enter"); expect(submit).not.toHaveBeenCalled();
      expect((input.element as HTMLTextAreaElement).value).toBe("/r");
      await view.wrapper.get('[role="alert"] button').trigger("click"); await flush();
      expect(view.wrapper.get('[data-testid="chat-command-review"]').exists()).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { view.unmount(); }
  });

  it("普通正文、路径、参数不弹菜单，禁用或焦点移出时关闭", async () => {
    const fetcher = stubCatalog(); const view = await mountReact(<Composer />);
    try {
      await focus(view); const input = view.wrapper.get('[data-testid="input"]');
      for (const text of ["正文 /review", "/usr/bin/env", "/review 目标", "```\n/review\n```"])
        await input.setValue(text);
      expect(fetcher).not.toHaveBeenCalled();
      await input.setValue("/"); await flush();
      await act(async () => (view.wrapper.get('[data-testid="outside"]').element as HTMLButtonElement).focus());
      expect(view.wrapper.find('[data-testid="chat-command-menu"]').exists()).toBe(false);
      await focus(view);
      await view.rerender(<Composer disabled />);
      expect(view.wrapper.find('[data-testid="chat-command-menu"]').exists()).toBe(false);
      expect((input.element as HTMLTextAreaElement).value).toBe("/");
    } finally { view.unmount(); }
  });
});
