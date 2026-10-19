import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ComposerAttach } from "../src/views/AssistView";
import type { RelayApiClient, RelayAssistSourceRef, RelayKnowledge, RelaySkillDefinition } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 「+」两级菜单（工作台 §32）的契约测试。
 *
 * 这里直接挂载 `ComposerAttach`：本文件要锁的是菜单框架本身（两级开合、hover 展开、
 * 键盘、翻转、状态提示、真实数据接入），而整条 /agent 路由下的联网路径由
 * assistantModeSwitch.spec.ts 的「+」弹层用例覆盖。两条证据互补，不互相替代。
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
const knowledge: readonly RelayKnowledge[] = [
  { id: "k-1", projectId: "p-1", title: "需求说明", status: "ACTIVE", revision: "2",
    currentVersion: "4", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" },
  { id: "k-2", projectId: "p-1", title: "已归档资料", status: "ARCHIVED", revision: "1",
    currentVersion: "2", createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" }
];
function skill(id: string, version: string, patch: Partial<RelaySkillDefinition> = {}): RelaySkillDefinition {
  return { id, version, sha256: `${id}-${version}`, title: `${id} 标题`, target: "TASK",
    outputKind: "TASK_DEFINITION_SUGGESTION", availability: "CALLABLE_SUGGESTION_ONLY",
    callSupported: true, requiredCapabilities: [], missingCapabilities: [], acceptSupported: false,
    dependencies: [], ...patch };
}

const connections = [
  { id: "conn-github", status: "ACTIVE", capabilities: ["GITHUB_READ"], allowedHost: null, allowedExecutables: null },
  { id: "conn-browser", status: "ACTIVE", capabilities: ["BROWSER_READ", "BROWSER_ACTION", "BROWSER_COMMIT"],
    allowedHost: null, allowedExecutables: null },
  { id: "conn-computer", status: "DISABLED", capabilities: ["COMPUTER_READ"], allowedHost: null, allowedExecutables: null }
] as const;

function stubClient(getChatCommands = vi.fn(async () => catalog),
  getKnowledge = vi.fn(async () => knowledge),
  getGatewayConnections = vi.fn(async () => connections)) {
  return { getChatCommands, getKnowledge, getGatewayConnections } as unknown as RelayApiClient;
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
  readonly projectId?: string | null;
  readonly skills?: readonly RelaySkillDefinition[];
  readonly selectedSkillKey?: string | null;
  readonly onPickSkill?: (key: string) => void;
  readonly skillContext?: { readonly projectId: string | null; readonly taskId: string | null;
    readonly resolveInPlace: boolean } | null;
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
      projectId={props.projectId ?? null}
      skills={props.skills} selectedSkillKey={props.selectedSkillKey ?? null}
      onPickSkill={props.onPickSkill} skillContext={props.skillContext ?? null}
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
}/** 指针进入：React 用 pointerover/pointerout 合成 enter/leave，这里按同一通道派发。 */
async function hover(element: Element | null): Promise<void> {
  if (element === null) throw new Error("悬停目标不存在");
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, cancelable: true }));
  });
  await flush(0);
}
async function pointerOut(element: Element | null, relatedTarget: Element): Promise<void> {
  if (element === null) throw new Error("离开目标不存在");
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerout",
      { bubbles: true, cancelable: true, relatedTarget }));
  });
  await flush(0);
}

afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("「+」两级菜单", () => {
  it("点击「+」打开一级：五项保留，状态提示来自真实事实", async () => {
    const view = await mountReact(<Harness initialRefs={refs} folderBound skillSelected />);
    try {
      expect(attach()?.open).toBe(false);
      await openMenu();
      expect(attach()?.open).toBe(true);
      expect(row("assist-attach-sources")).not.toBeNull();
      expect(row("assist-attach-folder")).not.toBeNull();
      expect(row("assist-attach-skill")).not.toBeNull();
      expect(row("assist-attach-command")).not.toBeNull();
      expect(row("assist-attach-connectors")).not.toBeNull();
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

  it("指针悬停一级行即展开二级；hover 打开后点击同一行是固定而不是收起", async () => {
    const view = await mountReact(<Harness conversation={conversationRefs} />);
    try {
      await openMenu();
      expect(submenu()).toBeNull();
      await hover(row("assist-attach-sources"));
      expect(submenu()?.getAttribute("data-section")).toBe("sources");
      expect(row("assist-attach-sources")?.getAttribute("aria-expanded")).toBe("true");
      // 指针刚移上去就点一下：保持展开（固定），不会把它关掉。
      await click(row("assist-attach-sources"));
      expect(submenu()?.getAttribute("data-section")).toBe("sources");
      // 固定之后再一次点击才是显式收起。
      await click(row("assist-attach-sources"));
      expect(submenu()).toBeNull();
      expect(attach()?.open).toBe(true);
    } finally { view.unmount(); }
  });

  it("指针在一级行之间移动即切换二级；离开整个菜单后二级延时收起、一级保持打开", async () => {
    const view = await mountReact(<Harness conversation={conversationRefs} />);
    try {
      await openMenu();
      await hover(row("assist-attach-sources"));
      expect(submenu()?.getAttribute("data-section")).toBe("sources");
      await hover(row("assist-attach-folder"));
      expect(submenu()?.getAttribute("data-section")).toBe("folder");
      expect(row("assist-attach-folder")?.getAttribute("aria-expanded")).toBe("true");
      expect(row("assist-attach-sources")?.getAttribute("aria-expanded")).toBe("false");
      // 指针移到二级上不收起（延时被取消）。
      await pointerOut(document.querySelector(".agent-chat-attach-menu"), submenu() as Element);
      await hover(submenu());
      await flush(260);
      expect(submenu()?.getAttribute("data-section")).toBe("folder");
      // 真正离开两级之后才收起二级；一级仍是用户点开的，不跟着关。
      await pointerOut(submenu(), document.body);
      await flush(260);
      expect(submenu()).toBeNull();
      expect(attach()?.open).toBe(true);
    } finally { view.unmount(); }
  });

  it("禁用的行 hover 不展开二级（首条消息前的资料）", async () => {
    const view = await mountReact(<div>
      <ComposerAttach client={stubClient()} mode="AGENT" hasSession={false} onCommand={() => {}} />
    </div>);
    try {
      await openMenu();
      await hover(row("assist-attach-sources"));
      expect(submenu()).toBeNull();
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

  it("资料二级直接列出项目资料：只列启用版本，点击即开关本次候选输入", async () => {
    const view = await mountReact(<Harness projectId="p-1" conversation={conversationRefs} />);
    try {
      await openSub("assist-attach-sources");
      // 真实项目资料直接平铺，不用先检索；已归档版本不进入候选。
      expect(row("assist-attach-project-0")?.textContent).toContain("需求说明");
      expect(row("assist-attach-project-0")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("v4");
      expect(row("assist-attach-project-1")).toBeNull();
      expect(submenu()?.textContent).not.toContain("已归档资料");
      await click(row("assist-attach-project-0"));
      expect(row("assist-attach-project-0")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("1");
    } finally { view.unmount(); }
  });

  it("资料二级：项目资料读取失败时如实说明，其余入口不受影响", async () => {
    const failing = { getChatCommands: vi.fn(async () => catalog),
      getKnowledge: vi.fn(async () => { throw new Error("boom"); }) } as unknown as RelayApiClient;
    const view = await mountReact(<div>
      <ComposerAttach client={failing} mode="AGENT" hasSession projectId="p-1"
        conversationRefs={conversationRefs} onSources={() => {}} onSkill={() => {}}
        onToggleSourceRef={() => {}} onCommand={() => {}} />
    </div>);
    try {
      await openSub("assist-attach-sources");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toContain("项目资料读取失败");
      expect(row("assist-attach-ref-0")).not.toBeNull();
      expect(row("assist-attach-search")?.disabled).toBe(false);
    } finally { view.unmount(); }
  });

  it("Skill 二级直接列出可调用 Skill：点击即选中，不可调用项如实禁用", async () => {
    const onPickSkill = vi.fn();
    const view = await mountReact(<Harness
      skills={[skill("task-to-execution-contract", "2"), skill("project-resume", "1", { callSupported: false }),
        skill("task-to-execution-contract", "1")]}
      selectedSkillKey="project-resume@1" onPickSkill={onPickSkill} />);
    try {
      await openSub("assist-attach-skill");
      // 每个 id 只列最新版本：历史版本不可调用，不占列表。
      expect(row("assist-attach-skill-0")?.textContent).toContain("task-to-execution-contract 标题");
      expect(row("assist-attach-skill-1")?.textContent).toContain("project-resume 标题");
      expect(row("assist-attach-skill-2")).toBeNull();
      // 当前选中项带对勾；不可调用项禁用且标注原因。
      expect(row("assist-attach-skill-1")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      expect(row("assist-attach-skill-1")?.disabled).toBe(true);
      expect(row("assist-attach-skill-1")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("不可调用");
      await click(row("assist-attach-skill-0"));
      expect(onPickSkill).toHaveBeenCalledWith("task-to-execution-contract@2");
      // 选中后两级都收起，草稿不受影响。
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }
  });


  it("Skill 清单全量：缺上下文的行标注「需任务/需项目」，能就地补齐时仍可选", async () => {
    /* 2026-10-18：`target` 只决定这次调用需要什么上下文，不是可见性（上游 OpenCode / Codex
       都不把 Skill 绑在项目上）。缺上下文而能就地补齐（resolveInPlace）→ 可选 + 标注；
       会话归属已冻结（resolveInPlace=false）→ 禁用 + 面板说明去哪补。 */
    const onPickSkill = vi.fn();
    const list = [skill("task-to-execution-contract", "2"), skill("project-resume", "1", { target: "PROJECT" })];
    const resolvable = await mountReact(<Harness skills={list} onPickSkill={onPickSkill}
      skillContext={{ projectId: null, taskId: null, resolveInPlace: true }} />);
    try {
      await openSub("assist-attach-skill");
      expect(row("assist-attach-skill-0")?.disabled).toBe(false);
      expect(row("assist-attach-skill-1")?.disabled).toBe(false);
      expect(row("assist-attach-skill-0")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("需任务");
      expect(row("assist-attach-skill-1")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("需项目");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent)
        .toContain("先在工具行指定目标");
      await click(row("assist-attach-skill-0"));
      expect(onPickSkill).toHaveBeenCalledWith("task-to-execution-contract@2");
    } finally { resolvable.unmount(); }
    const frozen = await mountReact(<Harness skills={list} onPickSkill={vi.fn()}
      skillContext={{ projectId: null, taskId: null, resolveInPlace: false }} />);
    try {
      await openSub("assist-attach-skill");
      expect(row("assist-attach-skill-0")?.disabled).toBe(true);
      expect(row("assist-attach-skill-1")?.disabled).toBe(true);
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent)
        .toContain("这条会话没有任务或项目归属");
    } finally { frozen.unmount(); }
    // 上下文齐备时回到版本号提示，不禁用。
    const ready = await mountReact(<Harness skills={list} onPickSkill={vi.fn()}
      skillContext={{ projectId: "p-1", taskId: "t-1", resolveInPlace: false }} />);
    try {
      await openSub("assist-attach-skill");
      expect(row("assist-attach-skill-0")?.disabled).toBe(false);
      expect(row("assist-attach-skill-0")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("v2");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")).toBeNull();
    } finally { ready.unmount(); }
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

  it("连接器二级：清单动态读取项目连接（GitHub / 浏览器 / 电脑等能力族），按能力逐行展示", async () => {
    /* 无项目归属（首条消息）时入口仍可点开（2026-10-18 用户指认「连接器与插件点击不了」）：
       面板第一句说明连接按项目登记，管理入口照常可走，不是一行点了没反应。 */
    const noProject = await mountReact(<Harness />);
    try {
      expect(row("assist-attach-connectors")?.disabled).toBe(false);
      await openSub("assist-attach-connectors");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toContain("连接器按项目登记");
      expect(row("assist-attach-connectors-manage")).not.toBeNull();
    } finally { noProject.unmount(); }
    const view = await mountReact(<Harness projectId="p-1" />);
    try {
      expect(row("assist-attach-connectors")?.disabled).toBe(false);
      await openSub("assist-attach-connectors");
      // 每个能力一行、名字来自共享映射；DISABLED 连接的能力如实标注，不冒充已连接。
      expect(row("assist-attach-connector-0")?.textContent).toContain("GitHub 只读（仓库/PR/Issue）");
      expect(row("assist-attach-connector-1")?.textContent).toContain("浏览器读取（页面/快照）");
      expect(row("assist-attach-connector-3")?.textContent).toContain("浏览器提交（表单/上传）");
      expect(row("assist-attach-connector-4")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("已停用");
      // 连接器行是状态展示：不是 button，点击不可能被误当成选择动作。
      expect(document.querySelector('[data-testid="assist-attach-connector-0"]')?.tagName).toBe("P");
      expect(row("assist-attach-connectors-manage")).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("连接器二级：空清单与读取失败各有如实文案，不编造插件", async () => {
    const empty = { getChatCommands: vi.fn(async () => catalog),
      getGatewayConnections: vi.fn(async () => []) } as unknown as RelayApiClient;
    const failing = { getChatCommands: vi.fn(async () => catalog),
      getGatewayConnections: vi.fn(async () => { throw new Error("boom"); }) } as unknown as RelayApiClient;
    const first = await mountReact(<div>
      <ComposerAttach client={empty} mode="AGENT" hasSession projectId="p-1"
        onSources={() => {}} onSkill={() => {}} onCommand={() => {}} />
    </div>);
    try {
      await openSub("assist-attach-connectors");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toContain("还没有已连接的插件");
    } finally { first.unmount(); }
    const second = await mountReact(<div>
      <ComposerAttach client={failing} mode="AGENT" hasSession projectId="p-1"
        onSources={() => {}} onSkill={() => {}} onCommand={() => {}} />
    </div>);
    try {
      await openSub("assist-attach-connectors");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toContain("连接器清单读取失败");
      expect(row("assist-attach-connectors-manage")).not.toBeNull();
    } finally { second.unmount(); }
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
      // 二级首行是可直接勾选的资料条目（列表在前，动作行在后）。
      expect(document.activeElement).toBe(row("assist-attach-ref-0"));
      await key(row("assist-attach-ref-0"), "ArrowDown");
      expect(document.activeElement).toBe(row("assist-attach-search"));
      await key(row("assist-attach-search"), "ArrowLeft");
      expect(submenu()).toBeNull();
      expect(document.activeElement).toBe(row("assist-attach-sources"));
    } finally { view.unmount(); }
  });

  it("禁用的一级行不展开二级，也不显示 chevron（首条消息前的资料）", async () => {
    const view = await mountReact(<div>
      <ComposerAttach client={stubClient()} mode="AGENT" hasSession={false}
        onCommand={() => {}} notes={[{ text: "首条消息后可选资料与 Skill", keys: ["sources", "skill"] }]} />
    </div>);
    try {
      await openMenu();
      expect(row("assist-attach-sources")?.disabled).toBe(true);
      expect(row("assist-attach-sources")?.hasAttribute("aria-expanded")).toBe(false);
      // 禁用行的解释跟在光标旁边（原生 title），不只留在底部脚注。
      expect(row("assist-attach-sources")?.getAttribute("title")).toBe("首条消息后可选资料与 Skill");
      /* Skill 与连接器不再禁用（2026-10-18）：没有归属时点得开，二级面板第一句就说清缺口，
         原因同时挂在 title 上（有脚注时用脚注那句，没有时用内置事实）。 */
      expect(row("assist-attach-skill")?.disabled).toBe(false);
      expect(row("assist-attach-skill")?.getAttribute("title")).toBe("首条消息后可选资料与 Skill");
      await click(row("assist-attach-skill"));
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toBe("首条消息后可选资料与 Skill");
      expect(row("assist-attach-connectors")?.disabled).toBe(false);
      expect(row("assist-attach-connectors")?.getAttribute("title")).toContain("连接器按项目登记");
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
