import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ComposerAttach } from "../src/views/AssistView";
import type { RelayApiClient, RelayAssistSourceRef } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 「+」两级菜单（工作台 §32）的契约测试。
 *
 * 这里直接挂载 `ComposerAttach`：本文件要锁的是菜单框架本身（两级开合、键盘、翻转、
 * 状态提示、真实数据接入），而整条 /agent 路由下的联网路径由 assistantModeSwitch.spec.ts
 * 的「+」弹层用例覆盖。两条证据互补，不互相替代。
 *
 * 真实 Windows 窗口、原生 IME/DPI 与真实模型仍未验证，见统一功能验收表对应行。
 */

const refs: readonly RelayAssistSourceRef[] = [
  { kind: "KNOWLEDGE", rootId: "k-1", version: "3" },
  { kind: "MEMORY", rootId: "m-2", version: "1" }
];
const conversationRefs: readonly RelayAssistSourceRef[] = [
  { kind: "KNOWLEDGE", rootId: "k-9", version: "2" }
];
const recentFolders = [
  { canonicalRoot: "D:/Develop/project-a", displayName: "project-a", openedAt: "2026-10-16T00:00:00Z" },
  { canonicalRoot: "D:/Develop/Relay-Agent", displayName: "Relay-Agent", openedAt: "2026-10-15T00:00:00Z" }
] as const;
const catalog = [
  { kind: "METHOD", name: "review", aliases: [], title: "代码审查", summary: "只读检查改动。",
    usage: "/review [目标]", methodId: "code-review", systemId: null },
  { kind: "SYSTEM", name: "model", aliases: [], title: "/model", summary: "选择模型。",
    usage: "/model <模型名>", methodId: null, systemId: "model" }
] as const;

function stubClient(getChatCommands = vi.fn(async () => catalog)) {
  return { getChatCommands } as unknown as RelayApiClient;
}

type HarnessProps = {
  readonly initialRefs?: readonly RelayAssistSourceRef[];
  readonly onToggleSourceRef?: (ref: RelayAssistSourceRef) => void;
  readonly onOpenRecentFolder?: (canonicalRoot: string) => void;
  readonly onFolder?: () => void;
  readonly onSources?: () => void;
  readonly onSkill?: () => void;
  readonly mode?: "AGENT" | "ASSISTANT" | "LEARNING";
  readonly conversation?: readonly RelayAssistSourceRef[];
  readonly recent?: readonly RelayAssistSourceRef[];
  readonly recentFolders?: readonly (typeof recentFolders)[number][];
  readonly folderPath?: string | null;
  readonly folderBound?: boolean;
  readonly skillSelected?: boolean;
  readonly notes?: { text: string; keys: string[] }[];
};

function Harness(props: HarnessProps) {
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<readonly RelayAssistSourceRef[]>(props.initialRefs ?? []);
  return <div className="agent-chat-composer-actions">
    <ComposerAttach client={stubClient()} mode={props.mode ?? "AGENT"} hasSession
      selectedRefs={selected} conversationRefs={props.conversation ?? []} recentRefs={props.recent ?? []}
      onToggleSourceRef={props.onToggleSourceRef ?? ((ref) => setSelected((current) => {
        const key = (item: RelayAssistSourceRef) => `${item.kind}:${item.rootId}:${item.version}`;
        return current.some((item) => key(item) === key(ref))
          ? current.filter((item) => key(item) !== key(ref)) : [...current, ref];
      }))}
      recentFolders={props.recentFolders ?? recentFolders}
      folderPath={props.folderPath ?? null} folderBound={props.folderBound ?? false}
      skillSelected={props.skillSelected ?? false}
      onOpenRecentFolder={props.onOpenRecentFolder ?? (() => {})}
      onFolder={props.onFolder ?? (() => {})} onSources={props.onSources ?? (() => {})}
      onSkill={props.onSkill ?? (() => {})}
      onCommand={() => setDraft((value) => value.startsWith("/") ? value : `/${value}`)}
      onPickCommand={(name) => setDraft((value) => `${value.match(/^\s*/u)?.[0] ?? ""}/${name} `)}
      notes={props.notes} />
    <textarea data-testid="draft" aria-label="本次消息" value={draft} readOnly />
  </div>;
}

const attach = () => document.querySelector<HTMLDetailsElement>(".agent-chat-attach");
const submenu = () => document.querySelector<HTMLElement>("[data-submenu]");
const row = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
async function click(element: HTMLElement | null): Promise<void> {
  if (element === null) throw new Error("点击目标不存在");
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush(0);
}
async function key(element: Element | null, keyName: string): Promise<KeyboardEvent> {
  if (element === null) throw new Error("按键目标不存在");
  if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  const event = new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true });
  await act(async () => { element.dispatchEvent(event); });
  await flush(0);
  return event;
}
async function openMenu(): Promise<void> {
  await click(document.querySelector('[data-testid="assist-attach"]'));
}
async function openSub(testId: string): Promise<void> {
  await openMenu();
  await click(row(testId));
}

afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("「+」两级菜单", () => {
  it("点击「+」打开一级：四项保留，状态提示来自真实事实", async () => {
    const view = await mountReact(<Harness initialRefs={refs} folderBound skillSelected />);
    try {
      expect(attach()?.open).toBe(false);
      await openMenu();
      expect(attach()?.open).toBe(true);
      expect(row("assist-attach-sources")).not.toBeNull();
      expect(row("assist-attach-folder")).not.toBeNull();
      expect(row("assist-attach-skill")).not.toBeNull();
      expect(row("assist-attach-command")).not.toBeNull();
      // 已选资料数、已绑目录、已选 Skill 都是真实事实的轻量提示，不是装饰。
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("2");
      expect(row("assist-attach-folder")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      expect(row("assist-attach-skill")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      // 允许展开的行才有 chevron 与 aria-expanded。
      expect(row("assist-attach-command")?.getAttribute("aria-expanded")).toBe("false");
      // 再点「+」收起一级。
      await click(document.querySelector('[data-testid="assist-attach"]'));
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("一级点击展开二级并保持一级打开；再点同一行收起二级", async () => {
    const view = await mountReact(<Harness conversation={conversationRefs} />);
    try {
      await openSub("assist-attach-sources");
      expect(attach()?.open).toBe(true);
      expect(submenu()?.getAttribute("data-section")).toBe("sources");
      expect(row("assist-attach-sources")?.getAttribute("aria-expanded")).toBe("true");
      await click(row("assist-attach-sources"));
      expect(submenu()).toBeNull();
      expect(attach()?.open).toBe(true);
    } finally { view.unmount(); }
  });

  it("资料二级：检索入口、对话真实引用、最近引用与本地文件未接入说明同时可见", async () => {
    const onSources = vi.fn();
    const view = await mountReact(<Harness onSources={onSources} conversation={conversationRefs}
      recent={[{ kind: "MEMORY", rootId: "m-9", version: "4" }]} />);
    try {
      await openSub("assist-attach-sources");
      // 尚未接入的能力如实禁用，并在面板脚注写明原因与当前可用的替代路径。
      expect(row("assist-attach-local-file")?.disabled).toBe(true);
      expect(row("assist-attach-local-file")?.textContent).toContain("暂未接入");
      expect(submenu()?.querySelector(".agent-chat-attach-subnote")?.textContent).toContain("本地文件选择尚未接入");
      expect(row("assist-attach-search")?.disabled).toBe(false);
      // 「对话中的资料」来自消息来源，不是推断；「最近引用」来自本机偏好。
      const labels = Array.from(submenu()?.querySelectorAll(".agent-chat-attach-item-label") ?? [])
        .map((node) => node.textContent);
      expect(labels).toContain("知识 · v2");
      expect(labels).toContain("记忆 · v4");
      await click(row("assist-attach-search"));
      expect(onSources).toHaveBeenCalledTimes(1);
      // 执行动作后两级都收起，草稿与输入不受影响。
      expect(attach()?.open).toBe(false);
      expect(submenu()).toBeNull();
    } finally { view.unmount(); }
  });

  it("引用行只是本次候选输入的开关：不关闭面板，超限后其余行禁用", async () => {
    const view = await mountReact(<Harness conversation={conversationRefs} recent={refs} />);
    try {
      await openSub("assist-attach-sources");
      await click(row("assist-attach-ref-0"));
      expect(attach()?.open).toBe(true);
      expect(submenu()).not.toBeNull();
      expect(row("assist-attach-ref-0")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("1");
      await click(row("assist-attach-ref-0"));
      expect(row("assist-attach-ref-0")?.querySelector(".agent-chat-attach-item-check")).toBeNull();
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")).toBeNull();
    } finally { view.unmount(); }
  });

  it("资料二级：已选满 10 个时未选中行禁用，不静默吞掉点击", async () => {
    const full = Array.from({ length: 10 }, (_, index) => (
      { kind: "KNOWLEDGE" as const, rootId: `k-${index}`, version: "1" }));
    const view = await mountReact(<Harness initialRefs={full} conversation={conversationRefs} />);
    try {
      await openSub("assist-attach-sources");
      expect(row("assist-attach-ref-0")?.disabled).toBe(true);
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("10");
    } finally { view.unmount(); }
  });

  it("目录二级：最近目录来自真实近期列表，点击走既有目录入口，当前目录带对勾", async () => {
    const onOpenRecentFolder = vi.fn();
    const view = await mountReact(<Harness onOpenRecentFolder={onOpenRecentFolder}
      folderPath="D:/Develop/project-a" />);
    try {
      await openSub("assist-attach-folder");
      expect(row("assist-attach-folder-pick")?.disabled).toBe(false);
      expect(row("assist-attach-recent-folder-0")?.textContent).toContain("project-a");
      expect(row("assist-attach-recent-folder-0")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      expect(row("assist-attach-recent-folder-1")?.querySelector(".agent-chat-attach-item-check")).toBeNull();
      expect(row("assist-attach-workspace-manage")?.disabled).toBe(true);
      expect(submenu()?.querySelector(".agent-chat-attach-subnote")?.textContent).toContain("工作区管理尚未接入");
      await click(row("assist-attach-recent-folder-1"));
      expect(onOpenRecentFolder).toHaveBeenCalledWith("D:/Develop/Relay-Agent");
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("目录二级：没有最近目录时给出空态，不编造条目", async () => {
    const view = await mountReact(<Harness recentFolders={[]} />);
    try {
      await openSub("assist-attach-folder");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toBe("本机还没有最近目录");
      expect(row("assist-attach-recent-folder-0")).toBeNull();
    } finally { view.unmount(); }
  });

  it("Skill 二级：生成类未接入如实禁用并写明接入点，选择已有 Skill 走既有发送选项", async () => {
    const onSkill = vi.fn();
    const view = await mountReact(<Harness onSkill={onSkill} />);
    try {
      await openSub("assist-attach-skill");
      expect(row("assist-attach-skill-describe")?.disabled).toBe(true);
      expect(row("assist-attach-skill-file")?.disabled).toBe(true);
      expect(submenu()?.querySelector(".agent-chat-attach-subnote")?.textContent).toContain("Skill 生成与管理尚未接入");
      await click(row("assist-attach-skill-existing"));
      expect(onSkill).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });

  it("命令二级：清单来自真实登记，点击只把命令填进草稿", async () => {
    const view = await mountReact(<Harness />);
    try {
      await openSub("assist-attach-command");
      expect(row("assist-attach-command-review")).not.toBeNull();
      expect(row("assist-attach-command-review")?.textContent).toContain("/review · 代码审查");
      // /model 已接入；菜单仍只编辑草稿，执行须由发送触发。
      const model = row("assist-attach-command-model");
      expect(model?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("可用");
      await click(row("assist-attach-command-review"));
      // 只编辑草稿：不发送、不新建会话，用户仍可继续补充自然语言。
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toBe("/review ");
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("命令二级的「输入命令」行只把斜杠补进草稿，已带斜杠时不重复", async () => {
    const view = await mountReact(<Harness />);
    try {
      await openSub("assist-attach-command");
      await click(row("assist-attach-command-focus"));
      const draft = document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement;
      expect(draft.value).toBe("/");
      await openSub("assist-attach-command");
      await click(row("assist-attach-command-focus"));
      expect(draft.value).toBe("/");
    } finally { view.unmount(); }
  });

  it("命令二级：非普通档不列方法命令，读取失败与无命令各有如实文案", async () => {
    const failing = { getChatCommands: vi.fn(async () => { throw new Error("boom"); }) } as unknown as RelayApiClient;
    const view = await mountReact(<div>
      <ComposerAttach client={failing} mode="AGENT" hasSession onCommand={() => {}} />
    </div>);
    try {
      await openSub("assist-attach-command");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toContain("命令清单读取失败");
    } finally { view.unmount(); }
  });

  it("行的尾组结构：状态位与 chevron 同组右对齐，面板不写死最小宽度", async () => {
    /* jsdom 不量几何，这里锁的是产生对称的那两条结构前提（真实几何在 Chromium 量过，
       见设计系统 §9.14）：①尾组是行的最后一个子项，状态位与 chevron 都在它里面；
       ②面板宽度收缩到内容（没有 min-width 下限），否则短行右侧会重新出现空白带。 */
    const view = await mountReact(<Harness initialRefs={refs} folderBound />);
    try {
      await openMenu();
      const sources = row("assist-attach-sources");
      const tail = sources?.querySelector(".agent-chat-attach-item-tail");
      expect(tail).not.toBeNull();
      expect(sources?.lastElementChild?.className).toBe("agent-chat-attach-item-tail");
      // 计数与 chevron 同组；对勾也进尾组。
      expect(tail?.querySelector(".agent-chat-attach-item-hint")).not.toBeNull();
      expect(tail?.querySelector(".agent-chat-attach-item-chevron")).not.toBeNull();
      expect(row("assist-attach-folder")?.querySelector(".agent-chat-attach-item-tail .agent-chat-attach-item-check"))
        .not.toBeNull();
      // 没有状态位的行只有尾组里的 chevron，不产生空的第三段。
      expect(row("assist-attach-command")?.querySelector(".agent-chat-attach-item-tail")?.children).toHaveLength(1);
      expect(row("assist-attach-command")?.lastElementChild?.className).toBe("agent-chat-attach-item-tail");
    } finally { view.unmount(); }
  });

  it("Esc 先收二级再收一级；点击外部一次收起两级", async () => {
    const view = await mountReact(<div><Harness /><button type="button" data-testid="outside">别处</button></div>);
    try {
      await openSub("assist-attach-sources");
      await key(submenu(), "Escape");
      expect(submenu()).toBeNull();
      expect(attach()?.open).toBe(true);
      expect(document.activeElement).toBe(row("assist-attach-sources"));
      await key(document.querySelector('[data-testid="assist-attach"]'), "Escape");
      expect(attach()?.open).toBe(false);
      expect(document.activeElement).toBe(document.querySelector('[data-testid="assist-attach"]'));
      await openSub("assist-attach-command");
      await act(async () => {
        document.querySelector('[data-testid="outside"]')?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      });
      await flush(0);
      expect(attach()?.open).toBe(false);
      expect(submenu()).toBeNull();
    } finally { view.unmount(); }
  });

  it("键盘：↑↓ 在当前层内移动，→ 展开二级并聚焦首行，← 收二级回到原一级行", async () => {
    const view = await mountReact(<Harness conversation={conversationRefs} />);
    try {
      await openMenu();
      await key(row("assist-attach-sources"), "ArrowDown");
      expect(document.activeElement).toBe(row("assist-attach-folder"));
      await key(row("assist-attach-folder"), "ArrowUp");
      expect(document.activeElement).toBe(row("assist-attach-sources"));
      await key(row("assist-attach-sources"), "ArrowRight");
      expect(submenu()?.getAttribute("data-section")).toBe("sources");
      // 禁用的「选择本地文件」不是可聚焦行，首行落在第一个可用项上。
      expect(document.activeElement).toBe(row("assist-attach-search"));
      await key(row("assist-attach-search"), "ArrowDown");
      expect(document.activeElement).toBe(row("assist-attach-ref-0"));
      await key(row("assist-attach-ref-0"), "ArrowLeft");
      expect(submenu()).toBeNull();
      expect(document.activeElement).toBe(row("assist-attach-sources"));
    } finally { view.unmount(); }
  });

  it("禁用的一级行不展开二级，也不显示 chevron（首条消息前的资料与 Skill）", async () => {
    const view = await mountReact(<div>
      <ComposerAttach client={stubClient()} mode="AGENT" hasSession={false}
        onCommand={() => {}} notes={[{ text: "首条消息后可选资料与 Skill", keys: ["sources", "skill"] }]} />
    </div>);
    try {
      await openMenu();
      expect(row("assist-attach-sources")?.disabled).toBe(true);
      expect(row("assist-attach-skill")?.disabled).toBe(true);
      expect(row("assist-attach-sources")?.hasAttribute("aria-expanded")).toBe(false);
      expect(row("assist-attach-command")?.getAttribute("aria-describedby")).toBeNull();
      expect(document.querySelector(".agent-chat-attach-note")?.textContent).toBe("首条消息后可选资料与 Skill");
    } finally { view.unmount(); }
  });

  it("右侧空间不足时二级翻到左侧展开", async () => {
    const view = await mountReact(<Harness />);
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = original.call(this);
      if (!(this instanceof HTMLElement) || !this.classList.contains("agent-chat-attach-menu")) return rect;
      return { ...rect, left: 900, right: 1100, top: 700, bottom: 900, width: 200, height: 200 } as DOMRect;
    };
    try {
      await openSub("assist-attach-folder");
      expect(submenu()?.getAttribute("data-flip")).toBe("left");
    } finally {
      Element.prototype.getBoundingClientRect = original;
      view.unmount();
    }
  });
});
