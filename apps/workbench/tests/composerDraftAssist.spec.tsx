import { useState } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerDraftBar, ComposerPolishButton, useComposerDraftAssist }
  from "../src/components/ComposerDraftAssist";
import { RelayApiClient } from "../src/api/relayClient";
import { mountReact } from "./mountApp";

/**
 * 输入框自动分点与手动润色（工作台 §30，测试计划 §31 CO-01/04/05/06/07/08/09）。
 *
 * 这里跑的是**真实组件 + 真实 client + 伪造 HTTP**：只有 fetch 被替换，
 * 定时、版本、来源校验、撤销与暂停逻辑全部是真代码。因此「迟到回包被丢弃」
 * 「撤销精确恢复润色前原文」这类断言测的是产品行为，不是夹具。
 */

const client = new RelayApiClient({ baseUrl: "http://relay.test",
  workspaceId: "11111111-1111-4111-8111-111111111111", bearerToken: "test-token" });

/** 停笔延时的测试值：产品默认是 2 秒，见 COMPOSER_OUTLINE_DELAY_MS。 */
const DELAY = 20;

const DRAFT = "给登录页加个记住密码，密码输错了要提示原因，先不要做短信登录";
const OUTLINE_TEXT = [
  "1. 给登录页加个记住密码，",
  "2. 密码输错了要提示原因，",
  "3. 先不要做短信登录",
].join("\n");
const POLISHED = "给登录页加记住密码；密码错误时提示原因；先不做短信登录。";

type AssistCall = { readonly operation: string; readonly text: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { "content-type": "application/json" } });
}

function outlineOk(text: string, itemCount = 3): Response {
  return json({ operation: "OUTLINE", status: "OUTLINE", item_count: itemCount, text });
}
function polishOk(text: string): Response {
  return json({ operation: "POLISH", status: "POLISH", item_count: null, text });
}

/** 记录每次草稿辅助请求，并按操作返回响应。 */
function stubAssist(handlers: {
  outline?: () => Response | Promise<Response>;
  polish?: () => Response | Promise<Response>;
}): AssistCall[] {
  const calls: AssistCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as AssistCall;
    calls.push({ operation: body.operation, text: body.text });
    const handler = body.operation === "OUTLINE" ? handlers.outline : handlers.polish;
    if (handler === undefined) throw new Error(`未预期的操作：${body.operation}`);
    return handler();
  }));
  return calls;
}

function Harness({ disabled = false, inflight = false, composing = false, sourceKey = "s" }: {
  disabled?: boolean; inflight?: boolean; composing?: boolean; sourceKey?: string;
}) {
  const [draft, setDraft] = useState("");
  // 与 AssistView 两处接入同形：hook 持状态，提示行在输入卡上方、润色键在工具行内。
  const assist = useComposerDraftAssist({
    client, sourceKey, value: draft, onChange: setDraft,
    disabled, inflight, composing, outlineDelayMs: DELAY,
  });
  return <section>
    <ComposerDraftBar assist={assist} value={draft} />
    <textarea data-testid="draft" value={draft} aria-label="草稿"
      onChange={(event) => setDraft(event.target.value)} />
    <div className="agent-chat-composer-tools"><ComposerPolishButton assist={assist} /></div>
  </section>;
}

async function settle(milliseconds = DELAY + 40): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)); });
}

function draftOf(view: Awaited<ReturnType<typeof mountReact>>): string {
  return (view.wrapper.get('[data-testid="draft"]').element as HTMLTextAreaElement).value;
}

/** 逐字取文本：DomWrapper.text() 会折叠空白，不能用来核对保留换行的建议。 */
function rawTextOf(view: Awaited<ReturnType<typeof mountReact>>, selector: string): string {
  return view.wrapper.get(selector).element?.textContent ?? "";
}

async function type(view: Awaited<ReturnType<typeof mountReact>>, text: string): Promise<void> {
  await view.wrapper.get('[data-testid="draft"]').setValue(text);
}

afterEach(() => vi.unstubAllGlobals());

describe("输入框自动分点与手动润色", () => {
  it("停笔后才请求；短输入、组词期间、禁用与在途发送都不请求", async () => {
    const calls = stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      // 还没停笔：一次请求都不能发出去。
      expect(calls).toHaveLength(0);
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ operation: "OUTLINE", text: DRAFT });
      expect(view.wrapper.get('[data-testid="composer-draft-assist"]').text())
        .toContain("已整理为 3 个要点");
    } finally { view.unmount(); }
  });

  it("短输入不强拆：不发起请求", async () => {
    const calls = stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, "太短");
      await settle();
      expect(calls).toHaveLength(0);
      expect(view.wrapper.find('[data-testid="composer-draft-assist"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("组词期间零请求，组词结束后按停笔延时请求", async () => {
    const calls = stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness composing />);
    try {
      await type(view, DRAFT);
      await settle(DELAY * 3);
      expect(calls).toHaveLength(0);
    } finally { view.unmount(); }

    const settled = stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const active = await mountReact(<Harness />);
    try {
      await type(active, DRAFT);
      await settle();
      expect(settled).toHaveLength(1);
    } finally { active.unmount(); }
  });

  it("忽略后同一草稿版本不重复请求，原文不变", async () => {
    const calls = stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      expect(calls).toHaveLength(1);
      await view.wrapper.get('[data-testid="composer-draft-ignore"]').trigger("click");
      expect(view.wrapper.find('[data-testid="composer-draft-assist"]').exists()).toBe(false);
      expect(draftOf(view)).toBe(DRAFT);
      await settle(DELAY * 3);
      expect(calls).toHaveLength(1);
    } finally { view.unmount(); }
  });

  it("查看浮层显示原文与建议；采用后精确可撤销回采用前原文", async () => {
    const calls = stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      await view.wrapper.get('[data-testid="composer-draft-view"]').trigger("click");
      expect(rawTextOf(view, '[data-testid="composer-draft-original"]')).toBe(DRAFT);
      expect(rawTextOf(view, '[data-testid="composer-draft-suggested"]')).toBe(OUTLINE_TEXT);
      // 查看本身不改原文。
      expect(draftOf(view)).toBe(DRAFT);

      await view.wrapper.get('[data-testid="composer-draft-adopt"]').trigger("click");
      expect(draftOf(view)).toBe(OUTLINE_TEXT);
      // 采用后浮层收起、分点建议行换成「已采用分点」与撤销入口。
      expect(view.wrapper.find('[data-testid="composer-draft-panel"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="composer-draft-assist"]').text())
        .toContain("已采用分点");
      // 采用后不再自动重复请求同一内容。
      await settle(DELAY * 3);
      expect(calls).toHaveLength(1);

      await view.wrapper.get('[data-testid="composer-draft-undo-outline"]').trigger("click");
      expect(draftOf(view)).toBe(DRAFT);
      expect(view.wrapper.find('[data-testid="composer-draft-assist"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("Esc 关闭浮层并把焦点交回触发键", async () => {
    stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      const trigger = view.wrapper.get('[data-testid="composer-draft-view"]').element as HTMLButtonElement;
      await view.wrapper.get('[data-testid="composer-draft-view"]').trigger("click");
      const panel = view.wrapper.get('[data-testid="composer-draft-panel"]');
      await act(async () => {
        panel.element!.dispatchEvent(new KeyboardEvent("keydown",
          { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(view.wrapper.find('[data-testid="composer-draft-panel"]').exists()).toBe(false);
      expect(document.activeElement).toBe(trigger);
    } finally { view.unmount(); }
  });

  it("润色：不要求先采用分点，成功后同一按钮变撤销；撤销精确恢复快照并丢弃手动修改", async () => {
    const polishPending: ((response: Response) => void)[] = [];
    const calls = stubAssist({
      outline: () => outlineOk(OUTLINE_TEXT),
      polish: () => new Promise<Response>((resolve) => { polishPending.push(resolve); }),
    });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      // 先采用分点，制造「已有分点 + 分点撤销入口」。
      await view.wrapper.get('[data-testid="composer-draft-view"]').trigger("click");
      await view.wrapper.get('[data-testid="composer-draft-adopt"]').trigger("click");
      expect(draftOf(view)).toBe(OUTLINE_TEXT);

      await view.wrapper.get('[data-testid="composer-draft-polish"]').trigger("click");
      // 生成期间按钮显示「润色中…」，且分点撤销入口已结束（两个撤销不互相覆盖）。
      expect(view.wrapper.get('[data-testid="composer-draft-polish"]').text()).toBe("润色中…");
      expect(view.wrapper.find('[data-testid="composer-draft-undo-outline"]').exists()).toBe(false);
      polishPending[0]!(polishOk(POLISHED));
      await settle(20);
      expect(draftOf(view)).toBe(POLISHED);
      expect(calls.filter((call) => call.operation === "POLISH")).toHaveLength(1);

      const undo = view.wrapper.get('[data-testid="composer-draft-undo-polish"]');
      expect(undo.text()).toBe("撤销润色");
      // 后果提示可见，并且撤销键用 aria-describedby 指向一段可读屏的文字（读屏可获取）。
      const note = view.wrapper.get('[data-testid="composer-draft-polish-note"]');
      expect(note.text()).toContain("撤销将恢复润色前原话");
      const describedBy = undo.attributes("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(String(describedBy))?.textContent)
        .toContain("撤销将恢复润色前原话");

      // 润色后继续手动编辑：撤销入口与快照都保留，且不触发自动分点。
      await type(view, `${POLISHED} 再加一条日志`);
      await settle(DELAY * 4);
      expect(calls.filter((call) => call.operation === "OUTLINE")).toHaveLength(1);
      expect(view.wrapper.get('[data-testid="composer-draft-undo-polish"]').exists()).toBe(true);

      await view.wrapper.get('[data-testid="composer-draft-undo-polish"]').trigger("click");
      // 逐字恢复点击润色前的草稿（含当时已有的编号），手动修改一并丢弃。
      expect(draftOf(view)).toBe(OUTLINE_TEXT);
      expect(calls.filter((call) => call.operation === "POLISH")).toHaveLength(1);
      expect(view.wrapper.find('[data-testid="composer-draft-undo-polish"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="composer-draft-polish"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("润色失败保留原文与润色入口；空结果不清空草稿", async () => {
    const calls = stubAssist({
      outline: () => outlineOk(OUTLINE_TEXT),
      polish: () => polishOk(""),
    });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      await view.wrapper.get('[data-testid="composer-draft-polish"]').trigger("click");
      await settle(30);
      expect(draftOf(view)).toBe(DRAFT);
      expect(view.wrapper.get('[data-testid="composer-draft-assist"]').text())
        .toContain("草稿已保留");
      // 失败后仍可再次点击。
      await view.wrapper.get('[data-testid="composer-draft-polish"]').trigger("click");
      await settle(30);
      expect(calls.filter((call) => call.operation === "POLISH")).toHaveLength(2);
    } finally { view.unmount(); }
  });

  it("辅助调用失败如实显示且不阻止原发送（草稿保持可编辑）", async () => {
    stubAssist({ outline: () => json({ code: "MODEL_PORT_NOT_CONFIGURED",
      detail: "当前服务实例使用 Mock 模型端口，没有可用的真实模型配置；草稿与发送不受影响。",
      status: 409, retryable: false }, 409) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      expect(view.wrapper.get('[data-testid="composer-draft-assist"]').text())
        .toContain("没有可用的真实模型配置");
      expect(draftOf(view)).toBe(DRAFT);
      // 没有无限重试。
      await settle(DELAY * 4);
    } finally { view.unmount(); }
  });

  it("端点不存在（404）时说清是服务端没有该路由，而不是照抄通用 detail", async () => {
    // Fastify 的 not-found 处理器（api/server.ts）对未知路径一律回这句通用 detail。
    stubAssist({ outline: () => json({ code: "RESOURCE_NOT_FOUND",
      detail: "请求的路径在当前服务上不存在。", status: 404 }, 404) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      const message = view.wrapper.get('[data-testid="composer-draft-assist"]').text();
      expect(message).toContain("尚未提供该端点");
      expect(message).not.toContain("请求的路径在当前服务上不存在");
      // 草稿一字不动，发送入口仍可用。
      expect(draftOf(view)).toBe(DRAFT);
      expect(view.wrapper.get('[data-testid="composer-draft-polish"]').attributes("disabled"))
        .toBeUndefined();
    } finally { view.unmount(); }
  });

  it("迟到隔离：在途编辑后回包被丢弃；改回相同文本也不复用旧结果", async () => {
    const pending: ((response: Response) => void)[] = [];
    const calls = stubAssist({
      outline: () => new Promise<Response>((resolve) => { pending.push(resolve); }),
    });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      expect(calls).toHaveLength(1);
      // 请求在途时编辑，再改回与请求时完全相同的文本。
      await type(view, `${DRAFT}，另外按钮也大一点`);
      await type(view, DRAFT);
      expect(pending).toHaveLength(1);
      pending[0]!(outlineOk("1. 旧结果", 2));
      await settle(5);
      // 仅凭字符串相等不足以采用旧结果：这一版必须没有建议。
      expect(view.wrapper.find('[data-testid="composer-draft-assist"]').exists()).toBe(false);
      // 新版本会重新请求（不是复用旧请求），并采用新结果。
      await settle();
      expect(calls).toHaveLength(2);
      pending[1]!(outlineOk("1. 新结果", 2));
      await settle(10);
      await view.wrapper.get('[data-testid="composer-draft-view"]').trigger("click");
      expect(view.wrapper.get('[data-testid="composer-draft-suggested"]').text()).toBe("1. 新结果");
    } finally { view.unmount(); }
  });

  it("发送成功（草稿清空）后清理本次辅助状态", async () => {
    stubAssist({ outline: () => outlineOk(OUTLINE_TEXT), polish: () => polishOk(POLISHED) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      await view.wrapper.get('[data-testid="composer-draft-polish"]').trigger("click");
      await settle(30);
      expect(view.wrapper.find('[data-testid="composer-draft-undo-polish"]').exists()).toBe(true);
      await type(view, "");
      expect(view.wrapper.find('[data-testid="composer-draft-undo-polish"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="composer-draft-polish-note"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="composer-draft-assist"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("来源变化（换会话/换连接）清空全部辅助状态", async () => {
    stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness sourceKey="a" />);
    try {
      await type(view, DRAFT);
      await settle();
      expect(view.wrapper.get('[data-testid="composer-draft-assist"]').exists()).toBe(true);
      await view.rerender(<Harness sourceKey="b" />);
      expect(view.wrapper.find('[data-testid="composer-draft-assist"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("润色键在输入卡工具行内、提示行在工具行外（原型 #polishBtn 的位置）", async () => {
    stubAssist({ outline: () => outlineOk(OUTLINE_TEXT) });
    const view = await mountReact(<Harness />);
    try {
      await type(view, DRAFT);
      await settle();
      const tools = view.wrapper.get('.agent-chat-composer-tools');
      const polish = tools.get('[data-testid="composer-draft-polish"]');
      // 键位在工具行里，和「资料 / 模式」同一行；不是输入卡上方独立的一行。
      expect(polish.exists()).toBe(true);
      expect(tools.element!.contains(polish.element)).toBe(true);
      // 提示行是工具行的兄弟节点，且浮层不推动布局（绝对定位，bottom:100% 锚在提示行上方）。
      const bar = view.wrapper.get('[data-testid="composer-draft-assist"]');
      expect(bar.element!.parentElement).toBe(tools.element!.parentElement);
      await view.wrapper.get('[data-testid="composer-draft-view"]').trigger("click");
      const panel = view.wrapper.get('[data-testid="composer-draft-panel"]');
      expect(tools.element!.contains(panel.element)).toBe(false);
      // 浮层在提示行之上：向上溢出而不占用提示行之后的位置。
      const barBox = bar.element!.getBoundingClientRect();
      const panelBox = panel.element!.getBoundingClientRect();
      expect(panelBox.bottom).toBeLessThanOrEqual(barBox.top + 1);
    } finally { view.unmount(); }
  });
});
