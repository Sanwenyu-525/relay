import { afterEach, describe, expect, it } from "vitest";
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import ChatCommandInput from "../src/components/ChatCommandInput";
import PluginIcon from "../src/components/PluginIcon";
import { UserMessageContent, insertPluginMention } from "../src/views/AssistView";
import { findPluginMentions } from "../src/lib/pluginMentions";
import type { RelayConversationMode } from "../src/api/relayClient";

/**
 * 内置插件图标（2026-10-25）的聚焦契约测试：
 * - PluginIcon：六个稳定 key → 六枚静态资源，装饰性图标不进可访问树；
 * - mention 识别：只认明确的三个 `@标签`，邮箱/路径/未知 mention/更长词不误判；
 * - 输入内联芯片：镜像层把 mention 原文占位、芯片叠层，textarea 仍是唯一文本 Owner；
 * - 消息展示层：原文、复制文本不被改写，图标只是显示增强。
 *
 * 直接挂载组件，不走整条 /agent 路由；jsdom 不量几何（getBoundingClientRect 全零），
 * 芯片位置由真实 Chromium 量测断言守着；真实 Windows/WebView2、DPI 与主题截图
 * 由浏览器用例与统一验收表覆盖。
 */

async function mountReact(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    rerender: async (next: ReactElement) => { await act(async () => { root.render(next); }); },
    unmount: () => { act(() => root.unmount()); container.remove(); }
  };
}

const iconOf = (root: ParentNode, key: string) =>
  root.querySelector<HTMLImageElement>(`img[data-plugin-icon="${key}"]`);

function draftInput(value: string, patch: { pluginChips?: boolean } = {}) {
  return <ChatCommandInput client={null} mode={"AGENT" as RelayConversationMode} hasSession={false}
    data-testid="draft" value={value} pluginChips={patch.pluginChips}
    onValueChange={() => {}} />;
}

/** 受控草稿：模拟真实输入（value 由父级状态回写），@ 菜单的插入才会真的改变文本。 */
function MentionHarness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <ChatCommandInput client={null} mode={"AGENT" as RelayConversationMode} hasSession={false}
    data-testid="draft" value={value} pluginChips onValueChange={setValue} />;
}

/** 在 textarea 上模拟「输入了一段文本 + 光标停在末尾」，并报一次选区变化。 */
async function typeInto(container: HTMLElement, next: string): Promise<HTMLTextAreaElement> {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, next);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.setSelectionRange(next.length, next.length);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
  });
  return textarea;
}

/** 把光标（或选区）移到指定偏移并报一次选区变化：芯片删除的开合与光标位置有关。 */
async function moveCaret(container: HTMLElement, caret: number, caretEnd?: number): Promise<HTMLTextAreaElement> {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(caret, caretEnd ?? caret);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
  });
  return textarea;
}

async function pressKey(textarea: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { textarea.dispatchEvent(event); });
  return event;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("PluginIcon 组件", () => {
  it("六个稳定 key 各渲染对应静态资源，且按装饰处理（alt 空 + aria-hidden）", async () => {
    const view = await mountReact(<>
      {(["computer", "browser", "github", "files", "knowledge", "automation"] as const).map((key) =>
        <PluginIcon key={key} plugin={key} />)}
    </>);
    try {
      for (const key of ["computer", "browser", "github", "files", "knowledge", "automation"]) {
        const img = iconOf(view.container, key);
        expect(img, key).not.toBeNull();
        expect(img!.getAttribute("src")).toMatch(new RegExp(`${key}\\.png$`));
        expect(img!.getAttribute("alt")).toBe("");
        expect(img!.getAttribute("aria-hidden")).toBe("true");
        // 不引入图标库：渲染的是 <img>，不是内联 svg。
        expect(img!.tagName).toBe("IMG");
      }
    } finally { view.unmount(); }
  });

  it("className 合并进默认类，尺寸仍由 CSS 变量决定", async () => {
    const view = await mountReact(<PluginIcon plugin="github" className="chat-command-chip-icon" />);
    try {
      const img = iconOf(view.container, "github")!;
      expect(img.className).toBe("plugin-icon chat-command-chip-icon");
    } finally { view.unmount(); }
  });
});

describe("插件 mention 识别", () => {
  it("识别明确的三个 mention，带起止偏移", () => {
    const matches = findPluginMentions("@电脑操控 和 @浏览器操控，还有 @GitHub");
    expect(matches.map((m) => [m.key, m.label, m.start, m.end])).toEqual([
      ["computer", "电脑操控", 0, 5],
      ["browser", "浏览器操控", 8, 14],
      ["github", "GitHub", 18, 25]
    ]);
  });

  it("不误识别邮箱、路径、未知 mention 与更长词的一部分", () => {
    expect(findPluginMentions("联系 user@GitHub.com 问问")).toEqual([]);
    expect(findPluginMentions("看 src/@GitHub/readme 这个路径")).toEqual([]);
    expect(findPluginMentions("@未知插件 不存在")).toEqual([]);
    expect(findPluginMentions("@GitHubX 不是 mention")).toEqual([]);
    expect(findPluginMentions("@电脑操控一下 粘连")).toEqual([]);
    // 紧跟中文标点与行尾都是明确边界。
    expect(findPluginMentions("@电脑操控，请截图").length).toBe(1);
    expect(findPluginMentions("先用 @GitHub").length).toBe(1);
  });

  it("相邻 mention（手动连着输入）两个都识别，且不放松防误判", () => {
    // 用户手动输入 @GitHub@浏览器操控（无空格）：第二个 @ 前的字母属于上一个 mention。
    expect(findPluginMentions("@GitHub@浏览器操控").map((m) => [m.key, m.start, m.end]))
      .toEqual([["github", 0, 7], ["browser", 7, 13]]);
    expect(findPluginMentions("@电脑操控@GitHub").map((m) => [m.key, m.start, m.end]))
      .toEqual([["computer", 0, 5], ["github", 5, 12]]);
    // 中文前置无空格也认（中文没有词间空格）；但标签后紧跟汉字不认——
    // 「@电脑操控截图」与「@电脑操控一下」同形，后者是更长词的一部分，
    // 按任务要求不误识别（插入路径始终带尾随空格，不受影响）。
    expect(findPluginMentions("先用@电脑操控截图")).toEqual([]);
    expect(findPluginMentions("先用@电脑操控，截图").length).toBe(1);
    // 防误判不放松：前一个是「更长词」时，后一个仍然不认。
    expect(findPluginMentions("@GitHubX@浏览器操控")).toEqual([]);
    expect(findPluginMentions("user@GitHub@浏览器操控")).toEqual([]);
  });
});

describe("输入内联插件芯片（ChatCommandInput pluginChips）", () => {
  it("mention 在正文原位变成芯片；原文仍完整留在 textarea 里", async () => {
    const view = await mountReact(draftInput("@电脑操控 帮我截图", { pluginChips: true }));
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      // 文本 Owner 不变：值、可编辑性、原生行为都归 textarea。
      expect(textarea.value).toBe("@电脑操控 帮我截图");
      const mirror = view.container.querySelector(".chat-command-mirror");
      expect(mirror).not.toBeNull();
      expect(mirror!.getAttribute("aria-hidden")).toBe("true");
      // 原文逐字在镜像层里（mention 段透明占位，纯文本段原样；芯片文本单算）。
      const prose = Array.from(mirror!.children)
        .filter((element) => !element.classList.contains("chat-command-chip"))
        .map((element) => element.textContent).join("");
      expect(prose).toBe("@电脑操控 帮我截图");
      const mention = mirror!.querySelector('[data-mention-start="0"]');
      expect(mention).not.toBeNull();
      expect(mention!.textContent).toBe("@电脑操控");
      // 芯片：小图标 + 短名（不带 @），叠在 mention 矩形上。
      const chip = view.container.querySelector('[data-plugin-chip="computer"]');
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toBe("电脑操控");
      expect(iconOf(chip!, "computer")).not.toBeNull();
      expect(view.container.querySelector(".chat-command-surface")?.getAttribute("data-chips")).toBe("on");
    } finally { view.unmount(); }
  });

  it("多个 mention 各有一枚芯片，按出现顺序排列；重复 mention 不合并", async () => {
    const view = await mountReact(draftInput("@GitHub 和 @电脑操控，再看 @GitHub", { pluginChips: true }));
    try {
      const chips = Array.from(view.container.querySelectorAll("[data-plugin-chip]"));
      expect(chips.map((chip) => chip.getAttribute("data-plugin-chip")))
        .toEqual(["github", "computer", "github"]);
    } finally { view.unmount(); }
  });

  it("手动连着输入的相邻 mention 也各有一枚芯片", async () => {
    const view = await mountReact(draftInput("@GitHub@浏览器操控", { pluginChips: true }));
    try {
      const chips = Array.from(view.container.querySelectorAll("[data-plugin-chip]"));
      expect(chips.map((chip) => chip.getAttribute("data-plugin-chip")))
        .toEqual(["github", "browser"]);
      // 镜像层里的两个透明占位段各自覆盖自己的原文。
      const spans = Array.from(view.container.querySelectorAll("[data-mention-start]"));
      expect(spans.map((span) => span.textContent)).toEqual(["@GitHub", "@浏览器操控"]);
    } finally { view.unmount(); }
  });

  it("没有已知 mention 时不渲染镜像层，输入器与此前一致", async () => {
    for (const value of ["普通草稿", "联系 user@GitHub.com", "路径 src/@GitHub/x", "@未知插件 在吗", "@GitHubX 走开", "@电脑操控一下"]) {
      const view = await mountReact(draftInput(value, { pluginChips: true }));
      try {
        expect(view.container.querySelector(".chat-command-mirror"), value).toBeNull();
        expect(view.container.querySelector(".chat-command-surface")?.hasAttribute("data-chips")).toBe(false);
      } finally { view.unmount(); }
    }
  });

  it("不传 pluginChips 时完全保持旧行为（无镜像层、无芯片）", async () => {
    const view = await mountReact(draftInput("@电脑操控 帮我截图"));
    try {
      expect(view.container.querySelector(".chat-command-mirror")).toBeNull();
      expect(view.container.querySelector("[data-plugin-chip]")).toBeNull();
    } finally { view.unmount(); }
  });

  it("草稿变化时芯片同步：删除或撤销 mention 后镜像层消失", async () => {
    const view = await mountReact(draftInput("@电脑操控 帮我截图", { pluginChips: true }));
    try {
      expect(view.container.querySelector(".chat-command-mirror")).not.toBeNull();
      await view.rerender(draftInput("帮我截图", { pluginChips: true }));
      expect(view.container.querySelector(".chat-command-mirror")).toBeNull();
      // 撤销回到中间态（半个标签）同样不画芯片。
      await view.rerender(draftInput("@电脑", { pluginChips: true }));
      expect(view.container.querySelector(".chat-command-mirror")).toBeNull();
      await view.rerender(draftInput("@电脑操控 帮我截图", { pluginChips: true }));
      expect(view.container.querySelector('[data-plugin-chip="computer"]')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("菜单插入与手动输入同一段文本，得到同一枚芯片", async () => {
    const inserted = insertPluginMention("", "电脑操控", null);
    expect(inserted).toBe("@电脑操控 ");
    const view = await mountReact(draftInput(inserted, { pluginChips: true }));
    try {
      expect(view.container.querySelector('[data-plugin-chip="computer"]')).not.toBeNull();
    } finally { view.unmount(); }
  });
});

describe("输入器 @ 插件菜单（ChatCommandInput pluginChips）", () => {
  const menu = (container: ParentNode) => container.querySelector('[data-testid="chat-mention-menu"]');

  it("输入 @ 弹出三个内置插件，Enter 把 @ 换成 @标签 且光标落在其后", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      const textarea = await typeInto(view.container, "@");
      expect(menu(view.container)).not.toBeNull();
      expect(menu(view.container)!.querySelectorAll('[role="option"]').length).toBe(3);
      // 高亮落在第一项（电脑操控），Enter 插入。
      expect(view.container.querySelector('[data-testid="chat-mention-computer"]')?.getAttribute("aria-selected"))
        .toBe("true");
      await pressKey(textarea, "Enter");
      expect(textarea.value).toBe("@电脑操控 ");
      // 菜单收起（尾随空格已结束 @query），光标在插入内容之后。
      expect(menu(view.container)).toBeNull();
      expect(textarea.selectionStart).toBe(6);
      expect(view.container.querySelector('[data-plugin-chip="computer"]')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("输入查询词按名称过滤；方向键换高亮，Esc 收起", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      await typeInto(view.container, "@电");
      expect(menu(view.container)!.querySelectorAll('[role="option"]').length).toBe(1);
      expect(view.container.querySelector('[data-testid="chat-mention-computer"]')).not.toBeNull();

      const back = await typeInto(view.container, "@");
      await pressKey(back, "ArrowDown");
      expect(view.container.querySelector('[data-testid="chat-mention-browser"]')?.getAttribute("aria-selected"))
        .toBe("true");
      await pressKey(back, "Escape");
      expect(menu(view.container)).toBeNull();
      // Esc 只关菜单，不改草稿。
      expect(back.value).toBe("@");
    } finally { view.unmount(); }
  });

  it("点选菜单行同样只改草稿，不发送", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      await typeInto(view.container, "@Git");
      const row = view.container.querySelector<HTMLButtonElement>('[data-testid="chat-mention-github"]')!;
      expect(row).not.toBeNull();
      await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
      expect(view.container.querySelector("textarea")!.value).toBe("@GitHub ");
      expect(menu(view.container)).toBeNull();
    } finally { view.unmount(); }
  });

  it("邮箱与路径里的 @ 不弹菜单；不传 pluginChips 时也没有菜单", async () => {
    const email = await mountReact(<MentionHarness initial="user@" />);
    try {
      await typeInto(email.container, "user@");
      expect(menu(email.container)).toBeNull();
    } finally { email.unmount(); }

    const plain = await mountReact(draftInput("@"));
    try {
      await typeInto(plain.container, "@");
      expect(menu(plain.container)).toBeNull();
    } finally { plain.unmount(); }
  });

  it("插入位置跟随光标：在句子中间输入 @ 只替换该处 query", async () => {
    const view = await mountReact(<MentionHarness initial="先看 @Gi 再看别的" />);
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        textarea.focus();
        // 光标停在 @Gi 之后（位置 6），query 生效。
        textarea.setSelectionRange(6, 6);
        textarea.dispatchEvent(new Event("select", { bubbles: true }));
      });
      expect(menu(view.container)).not.toBeNull();
      await pressKey(textarea, "Enter");
      // 只替换 @Gi，且吃掉紧跟的空格——不会留下两个空格。
      expect(textarea.value).toBe("先看 @GitHub 再看别的");
      expect(textarea.selectionStart).toBe(11);
    } finally { view.unmount(); }
  });
});

describe("插件芯片整体删除（2026-10-25 用户指认；同日第二轮改一次删除）", () => {
  /** 受控草稿 + 把光标定位到指定偏移。 */
  async function chipDraft(view: { container: HTMLElement }, value: string, caret: number, caretEnd?: number) {
    await typeInto(view.container, value);
    return moveCaret(view.container, caret, caretEnd);
  }

  it("Backspace 一次删除整枚：选区预置到整段并放行原生（真实删除由浏览器用例守着）", async () => {
    const view = await mountReact(<MentionHarness initial="@电脑操控 帮我截图" />);
    try {
      const textarea = await chipDraft(view, "@电脑操控 帮我截图", 5);
      // 光标紧贴芯片尾部：不拦按键，只把选区预置到整段——原生退格随即删掉整枚，
      // 一次按键完成，Ctrl+Z 仍可撤销（jsdom 不执行默认行为，这里只验证预置与放行）。
      const event = await pressKey(textarea, "Backspace");
      expect(event.defaultPrevented).toBe(false);
      expect(textarea.value).toBe("@电脑操控 帮我截图");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
      expect(view.container.querySelector('[data-plugin-chip="computer"]')).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("光标点进芯片中间按 Backspace 同样预置整段，删不出「图标退回成 @」的中间态", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      const textarea = await chipDraft(view, "@电脑操控 帮我截图", 3);
      const event = await pressKey(textarea, "Backspace");
      expect(event.defaultPrevented).toBe(false);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
    } finally { view.unmount(); }
  });

  it("Delete 从芯片前缘吃起同样预置整段；从尾部外侧删不碰选区", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      let textarea = await chipDraft(view, "@电脑操控 帮我截图", 0);
      await pressKey(textarea, "Delete");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
      // 光标在 mention 结束处（紧贴空格）：Delete 吃的是 mention 之后的字符，不预置。
      textarea = await chipDraft(view, "@电脑操控 帮我截图", 5);
      await pressKey(textarea, "Delete");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 5]);
    } finally { view.unmount(); }
  });

  it("选中芯片的一部分按删除：选区扩成整段；完整覆盖时不缩小已选范围（2026-10-26 并集规则）", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      let textarea = await chipDraft(view, "@电脑操控 帮我截图", 3, 7);
      await pressKey(textarea, "Backspace");
      // 选区含 mention 后半 + 空格 + 「帮」：左界扩到整枚起点，用户已选的
      // 空格与「帮」不被悄悄丢出删除范围（旧实现缩回 [0,5) 是本次修复的缺陷）。
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 7]);
      textarea = await chipDraft(view, "@电脑操控 帮我截图", 0, 7);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 7]);
    } finally { view.unmount(); }
  });

  it("Ctrl+Backspace 删词同样不许拆碎芯片", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      const textarea = await chipDraft(view, "@电脑操控 帮我截图", 5);
      await pressKey(textarea, "Backspace", { ctrlKey: true });
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
      expect(textarea.value).toBe("@电脑操控 帮我截图");
    } finally { view.unmount(); }
  });

  it("芯片前后的普通文本删除不受影响", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      // 光标在 mention 前的空格处：Backspace 删的是空格，不触及芯片。
      let textarea = await chipDraft(view, "你好 @电脑操控", 3);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
      // 草稿没有已知 mention 时，删除完全走原生。
      textarea = await chipDraft(view, "@未知插件 草稿", 7);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 7]);
    } finally { view.unmount(); }
  });

  it("相邻 mention：Backspace 吃左边那枚，Delete 吃右边那枚", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      // 光标在两枚芯片交界（7 = @GitHub 结束 = 第二个 @ 开始），Backspace 往左吃。
      let textarea = await chipDraft(view, "@GitHub@浏览器操控", 7);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 7]);
      textarea = await chipDraft(view, "@GitHub@浏览器操控", 13);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 13]);
      // Delete 往右吃：同一交界点吃到第二枚。
      textarea = await chipDraft(view, "@GitHub@浏览器操控", 7);
      await pressKey(textarea, "Delete");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 13]);
    } finally { view.unmount(); }
  });

  it("@ 菜单展开时编辑 query 的 Backspace 不被芯片分支误拦", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      // 已接受 mention 之后，正文里另起一段 @query：菜单开着，退格删的是 query 字符。
      const textarea = await chipDraft(view, "@电脑操控 再@Gi", 10);
      expect(view.container.querySelector('[data-testid="chat-mention-menu"]')).not.toBeNull();
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([10, 10]);
      // 附带回归：相邻 mention 手动输入到第二个 @ 时菜单不弹（前字符是字母，
      // 与邮箱同形的边界规则挡住），退格删这个 @ 也不被芯片分支预置。
      const bare = await chipDraft(view, "@GitHub@", 8);
      expect(view.container.querySelector('[data-testid="chat-mention-menu"]')).toBeNull();
      await pressKey(bare, "Backspace");
      expect([bare.selectionStart, bare.selectionEnd]).toEqual([8, 8]);
    } finally { view.unmount(); }
  });

  /* 选区并集（2026-10-26 独立验收指认）：选区触及 mention 时扩展到整枚边界，
     但不得缩小用户已选的其他文字——全选整行删除应得到空串，而不是只删 mention。
     jsdom 不执行原生删除，这里守住「预置选区」这个输入端；真实删除与撤销栈由
     浏览器用例（composerPluginMention.spec.ts）覆盖。 */
  it("全选整行（mention+前后文）按 Backspace：预置保持整个原选区，不缩成单枚", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      const textarea = await chipDraft(view, "前文 @GitHub 后文", 0, 13);
      const event = await pressKey(textarea, "Backspace");
      expect(event.defaultPrevented).toBe(false);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 13]);
    } finally { view.unmount(); }
  });

  it("选区含 mention 前缀：左界扩到整枚起点，用户已选的普通文字保留", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      let textarea = await chipDraft(view, "前文 @GitHub 后文", 0, 6);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 10]);
      // 选中 mention 后半 + 后文：左界扩到整枚起点，右界不缩。
      textarea = await chipDraft(view, "前文 @GitHub 后文", 8, 13);
      await pressKey(textarea, "Delete");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 13]);
    } finally { view.unmount(); }
  });

  it("选区跨两枚 mention：并集覆盖两枚整段与中间文字", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      // @GitHub=[0,7)、@浏览器操控=[10,16)：选 [2,12) 触及两枚 → 并集 [0,16)。
      const textarea = await chipDraft(view, "@GitHub 和 @浏览器操控 尾部", 2, 12);
      const event = await pressKey(textarea, "Backspace");
      expect(event.defaultPrevented).toBe(false);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 16]);
    } finally { view.unmount(); }
  });

  it("只选普通文字：不预置、不缩小，删除仍走原生", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      const textarea = await chipDraft(view, "前文 @GitHub 后文", 10, 13);
      await pressKey(textarea, "Backspace");
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([10, 13]);
    } finally { view.unmount(); }
  });

  it("Ctrl+Backspace 选区跨 mention 同样并集扩展", async () => {
    const view = await mountReact(<MentionHarness />);
    try {
      const textarea = await chipDraft(view, "先用 @电脑操控 截图", 4, 10);
      await pressKey(textarea, "Backspace", { ctrlKey: true });
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 10]);
    } finally { view.unmount(); }
  });
});

describe("镜像层 scrollbar gutter 补偿（2026-10-26 独立验收指认的累积缺陷）", () => {
  /** jsdom 无布局：桩掉宽度属性制造 16px 纵向滚动条 gutter。 */
  function stubWidths(textarea: HTMLTextAreaElement, offsetWidth: number, clientWidth: number) {
    Object.defineProperty(textarea, "offsetWidth", { configurable: true, value: offsetWidth });
    Object.defineProperty(textarea, "clientWidth", { configurable: true, value: clientWidth });
  }
  async function scroll(textarea: HTMLTextAreaElement) {
    await act(async () => { textarea.dispatchEvent(new Event("scroll", { bubbles: true })); });
  }

  it("重复滚动触发补偿不叠加：padding 恒为基础值+当前 gutter 的绝对值", async () => {
    const view = await mountReact(draftInput("@电脑操控 帮我截图，多写一些让框内出现滚动", { pluginChips: true }));
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      const mirror = view.container.querySelector<HTMLElement>(".chat-command-mirror")!;
      stubWidths(textarea, 300, 284);
      await scroll(textarea);
      // jsdom 无样式表：基础 padding 为 0，补偿即 gutter 本身。
      expect(mirror.style.paddingRight).toBe("16px");
      // 缺陷形态：第二轮把已含补偿的计算值当基础值再叠加。修复后必须是同一绝对值。
      await scroll(textarea);
      await scroll(textarea);
      expect(mirror.style.paddingRight, "重复补偿不得累计").toBe("16px");
    } finally { view.unmount(); }
  });

  it("gutter 归零后补偿正确恢复，无残留", async () => {
    const view = await mountReact(draftInput("@电脑操控 帮我截图", { pluginChips: true }));
    try {
      const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
      const mirror = view.container.querySelector<HTMLElement>(".chat-command-mirror")!;
      stubWidths(textarea, 300, 284);
      await scroll(textarea);
      expect(mirror.style.paddingRight).toBe("16px");
      stubWidths(textarea, 300, 300);
      await scroll(textarea);
      expect(mirror.style.paddingRight).toBe("");
      // 恢复滚动条后补偿回来（不是只在首次生效）。
      stubWidths(textarea, 300, 284);
      await scroll(textarea);
      expect(mirror.style.paddingRight).toBe("16px");
    } finally { view.unmount(); }
  });
});

describe("用户消息展示层（UserMessageContent）", () => {
  it("已知 mention 显示成「小图标 + 短名」且不带 @（用户 2026-10-25 指认）", async () => {
    const content = "先用 @电脑操控 截图，再 @GitHub 看仓库";
    const view = await mountReact(<p><UserMessageContent content={content} /></p>);
    try {
      expect(view.container.querySelectorAll("[data-plugin-mention]").length).toBe(2);
      expect(iconOf(view.container, "computer")).not.toBeNull();
      expect(iconOf(view.container, "github")).not.toBeNull();
      // 展示层去掉 @：mention 段只剩短名，图标承担「这是插件提示」的语义。
      expect(view.container.querySelector('[data-plugin-mention="computer"]')!.textContent).toBe("电脑操控");
      expect(view.container.textContent).toBe("先用 电脑操控 截图，再 GitHub 看仓库");
    } finally { view.unmount(); }
  });

  it("邮箱、路径、未知 mention 与粘连词不画图标，原文原样", async () => {
    for (const content of ["联系 user@GitHub.com", "路径 src/@GitHub/x", "@未知插件 在吗", "@GitHubX 走开"]) {
      const view = await mountReact(<p><UserMessageContent content={content} /></p>);
      try {
        expect(view.container.querySelector("[data-plugin-mention]"), content).toBeNull();
        expect(view.container.textContent).toBe(content);
      } finally { view.unmount(); }
    }
  });

  it("纯文本消息不引入任何额外节点", async () => {
    const view = await mountReact(<p><UserMessageContent content="帮我整理这段安排" /></p>);
    try {
      expect(view.container.querySelector("span")).toBeNull();
      expect(view.container.textContent).toBe("帮我整理这段安排");
    } finally { view.unmount(); }
  });
});
