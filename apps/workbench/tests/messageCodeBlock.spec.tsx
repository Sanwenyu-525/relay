import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import MessageCodeBlock from "../src/components/MessageCodeBlock";
import { mountReact, type DomWrapper } from "./mountApp";

// 可复制文本块的界面口径（工作台 §37.1）：顶行说明这是什么、右上角一键复制、正文逐字保留。
// 复制是纯客户端动作：不新增命令、不落库；失败与成功都只以按钮可读名表达，不弹额外层。

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  vi.restoreAllMocks();
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
  return () => {
    if (original === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
    else Object.defineProperty(window.navigator, "clipboard", original);
  };
}

async function render(label: string, text: string, copyLabel?: string) {
  const mounted = await mountReact(createElement(MessageCodeBlock, { label, text, copyLabel }));
  unmount = mounted.unmount;
  return mounted.wrapper;
}

/** 正文逐字断言走 textContent：wrapper.text() 会把换行折叠成空格，量不出「逐字保留」。 */
function codeText(wrapper: DomWrapper): string {
  return (wrapper.get("pre code").element as HTMLElement).textContent ?? "";
}

describe("历史消息里的可复制文本块", () => {
  it("顶行给出来源标签，正文逐字保留空行与前导空格", async () => {
    const wrapper = await render("read_file · src/a.ts", "line one\n\n  indented");
    expect(wrapper.get(".msg-code-label").text()).toBe("read_file · src/a.ts");
    expect(codeText(wrapper)).toBe("line one\n\n  indented");
    expect(wrapper.get(".msg-code-copy").attributes("aria-label")).toBe("复制这段内容");
  });

  it("标签为空时顶行只剩复制键：键不因为没有标签而消失", async () => {
    const wrapper = await render("", "只有正文");
    expect(wrapper.find(".msg-code-label").exists()).toBe(false);
    expect(wrapper.find(".msg-code-bar").exists()).toBe(true);
    expect(codeText(wrapper)).toBe("只有正文");
    expect(wrapper.get(".msg-code-copy").exists()).toBe(true);
  });

  it("复制把正文原样写进剪贴板，并给出可见反馈", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    const restore = stubClipboard(writeText);
    try {
      const wrapper = await render("bash", "pnpm build", "复制这段代码");
      await wrapper.get(".msg-code-copy").trigger("click");
      expect(writeText).toHaveBeenCalledWith("pnpm build");
      // 反馈只以可读名与图标表达：不新增元素、不位移、不改变正文。
      expect(wrapper.get(".msg-code-copy").attributes("aria-label")).toBe("已复制");
      expect(wrapper.get(".msg-code").attributes("data-copy-state")).toBe("done");
      expect(codeText(wrapper)).toBe("pnpm build");
    } finally { restore(); }
  });

  it("写剪贴板失败时按钮说明可重试，不假装复制成功", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    const restore = stubClipboard(writeText);
    try {
      const wrapper = await render("bash", "pnpm build");
      await wrapper.get(".msg-code-copy").trigger("click");
      expect(wrapper.get(".msg-code-copy").attributes("aria-label")).toBe("复制失败，可重试");
      expect(wrapper.get(".msg-code").attributes("data-copy-state")).toBe("failed");
    } finally { restore(); }
  });

  it("没有剪贴板能力时同样按失败处理，不谎报已复制", async () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    Reflect.deleteProperty(window.navigator, "clipboard");
    try {
      const wrapper = await render("bash", "pnpm build");
      await wrapper.get(".msg-code-copy").trigger("click");
      expect(wrapper.get(".msg-code-copy").attributes("aria-label")).toBe("复制失败，可重试");
    } finally {
      if (original === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
      else Object.defineProperty(window.navigator, "clipboard", original);
    }
  });
});
