import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppDialog from "../src/components/AppDialog";

let root: Root | null = null;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  document.querySelectorAll("[data-dialog-test-outside]").forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

async function render(content: ReactNode) {
  await act(async () => root!.render(content));
}

async function flushFrames() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback(0);
    }
  });
}

function dialog(title = "测试面板"): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`);
  if (!element) throw new Error("dialog missing");
  return element;
}

function outsideButton() {
  const button = document.createElement("button");
  button.dataset.dialogTestOutside = "true";
  document.body.append(button);
  return button;
}

async function key(name: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  await act(async () => document.dispatchEvent(event));
  return event;
}

function testDialog(children: ReactNode, onClose = vi.fn(), open = true, title = "测试面板") {
  return createElement(AppDialog, { open, title, onClose, children });
}

describe("AppDialog 共享键盘与焦点交互", () => {
  it.each([
    { isComposing: true },
    { keyCode: 229 }
  ])("中文组合输入期间的 Esc 不关闭弹层：%j", async (options) => {
    const onClose = vi.fn();
    await render(testDialog(createElement("input"), onClose));
    const event = await key("Escape", options);
    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    await key("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { start: "panel", shiftKey: false },
    { start: "panel", shiftKey: true },
    { start: "outside", shiftKey: false },
    { start: "outside", shiftKey: true }
  ])("焦点起点在 $start 时 Tab 回到弹层合法控件（shift=$shiftKey）", async ({ start, shiftKey }) => {
    await render(testDialog(createElement("input", { "data-testid": "last" })));
    const panel = dialog();
    (start === "panel" ? panel : outsideButton()).focus();
    const event = await key("Tab", { shiftKey });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(panel.querySelector(shiftKey ? "input" : "button"));
  });

  const excludedCandidates: Array<{ name: string; candidate: ReactNode }> = [
    { name: "hidden 祖先", candidate: createElement("div", { hidden: true }, createElement("input")) },
    { name: "display:none 祖先", candidate: createElement("div", { style: { display: "none" } }, createElement("input")) },
    { name: "visibility:hidden 祖先", candidate: createElement("div", { style: { visibility: "hidden" } }, createElement("input")) },
    { name: "折叠 details 内容", candidate: createElement("details", null, createElement("summary", null, "展开"), createElement("input")) },
    { name: "hidden 输入", candidate: createElement("input", { type: "hidden" }) },
    { name: "任意负 tabIndex", candidate: createElement("button", { tabIndex: -2 }, "跳过") },
    { name: "禁用 fieldset 的输入", candidate: createElement("fieldset", { disabled: true }, createElement("input")) },
    { name: "inert 祖先", candidate: createElement("div", { inert: true }, createElement("input")) }
  ];

  it.each(excludedCandidates)("Tab 循环排除 $name", async ({ candidate }) => {
    await render(testDialog(createElement(Fragment, null,
      createElement("input", { "data-testid": "last" }), candidate)));
    const panel = dialog();
    // summary 自身应保留为合法入口；在本例中将其放到 Tab 序列之外，只验证折叠正文。
    panel.querySelector("summary")?.setAttribute("tabindex", "-1");
    panel.querySelector<HTMLElement>('[data-testid="last"]')!.focus();
    const event = await key("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(panel.querySelector("button"));
  });

  it("关闭 details 的首个 summary 与禁用 fieldset 的首个 legend 控件仍可访问", async () => {
    await render(testDialog(createElement(Fragment, null,
      createElement("details", null, createElement("summary", null, "展开"), createElement("input")),
      createElement("fieldset", { disabled: true },
        createElement("legend", null, createElement("button", { "data-testid": "legend" }, "图例入口")),
        createElement("input")))));
    const panel = dialog();
    panel.querySelector("button")!.focus();
    const event = await key("Tab", { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(panel.querySelector('[data-testid="legend"]'));
    panel.querySelector<HTMLElement>("summary")!.focus();
    expect((await key("Tab")).defaultPrevented).toBe(false);
  });

  it("无合法控件时焦点留在面板", async () => {
    await render(testDialog(createElement("input", { type: "hidden" })));
    dialog().querySelector("button")!.disabled = true;
    outsideButton().focus();
    expect((await key("Tab")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog());
  });

  it("关闭后取消延迟初始聚焦，避免旧回调干扰后续交互", async () => {
    const trigger = outsideButton();
    trigger.focus();
    await render(testDialog(createElement("input")));
    expect(frames.size).toBe(1);
    await render(testDialog(createElement("input"), vi.fn(), false));
    expect(frames.size).toBe(0);
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    await flushFrames();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("AppDialog 多层焦点所有权", () => {
  it("底层初始聚焦回调不抢走顶层焦点", async () => {
    await render(testDialog(createElement("input"), vi.fn(), true, "底层"));
    await render(createElement(Fragment, null,
      testDialog(createElement("input"), vi.fn(), true, "底层"),
      testDialog(createElement("input"), vi.fn(), true, "顶层")));
    const topInput = dialog("顶层").querySelector("input")!;
    topInput.focus();
    const bottomFrame = [...frames.entries()][0]!;
    frames.delete(bottomFrame[0]);
    await act(async () => bottomFrame[1](0));
    expect(document.activeElement).toBe(topInput);
    await flushFrames();
    expect(dialog("顶层").contains(document.activeElement)).toBe(true);
  });

  it("底层先关闭时不恢复外部焦点", async () => {
    const trigger = outsideButton();
    trigger.focus();
    const layers = (bottomOpen: boolean) => createElement(Fragment, null,
      testDialog(createElement("input"), vi.fn(), bottomOpen, "底层"),
      testDialog(createElement("input"), vi.fn(), true, "顶层"));
    await render(layers(true));
    await flushFrames();
    const topInput = dialog("顶层").querySelector("input")!;
    topInput.focus();
    await render(layers(false));
    expect(document.activeElement).toBe(topInput);
  });

  it("顶层关闭时恢复底层触发点，Esc 仅通知顶层", async () => {
    const bottomClose = vi.fn();
    const topClose = vi.fn();
    const layers = (topOpen: boolean) => createElement(Fragment, null,
      testDialog(createElement("input"), bottomClose, true, "底层"),
      testDialog(createElement("input"), topClose, topOpen, "顶层"));
    await render(layers(false));
    await flushFrames();
    const bottomInput = dialog("底层").querySelector("input")!;
    bottomInput.focus();
    await render(layers(true));
    await flushFrames();
    await key("Escape");
    expect(topClose).toHaveBeenCalledOnce();
    expect(bottomClose).not.toHaveBeenCalled();
    await render(layers(false));
    expect(document.activeElement).toBe(bottomInput);
  });

  it("底层遮罩和关闭按钮不绕过顶层关闭", async () => {
    const bottomClose = vi.fn();
    const topClose = vi.fn();
    await render(createElement(Fragment, null,
      testDialog(null, bottomClose, true, "底层"), testDialog(null, topClose, true, "顶层")));
    const bottom = dialog("底层");
    await act(async () => {
      bottom.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      bottom.querySelector("button")!.click();
    });
    expect(bottomClose).not.toHaveBeenCalled();
    await act(async () => dialog("顶层").querySelector("button")!.click());
    expect(topClose).toHaveBeenCalledOnce();
  });
});
