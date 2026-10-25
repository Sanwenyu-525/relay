import { useState } from "react";
import { type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ComposerAttach, insertMention, insertPluginMention } from "../src/views/AssistView";
import type { RelayApiClient, RelayArtifact, RelayAssistSourceRef, RelayDirectoryEntry, RelayKnowledge, RelaySkillDefinition } from "../src/api/relayClient";

/**
 * 本文件直接挂载 `ComposerAttach`，因此不经过 `tests/mountApp` 的整条路由器：
 * 一个组件测试不应把 `/agent` 之外的所有页面（及其并行改动）拖进模块图。
 * 两个辅助函数与 `mountApp` 的同名实现保持同一行为。
 */
async function flush(milliseconds = 40): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
}

async function mountReact(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { unmount: () => { act(() => root.unmount()); container.remove(); } };
}

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

/** 「文件」二级的真实读取回执：与 HTTP §10.112 的成功投影同形。 */
function listingResponse(entries: readonly RelayDirectoryEntry[],
  patch: { readonly truncated?: boolean; readonly skipped?: number } = {}) {
  return { commandId: "listing", committedAt: "2026-10-24T00:00:00Z",
    outcome: { state: "SUCCEEDED", actionType: "LIST_DIRECTORY", operationId: "op-1", invocationId: "inv-1",
      result: { kind: "LISTING", entries, count: entries.length, limit: 200,
        truncated: patch.truncated ?? false, skipped: patch.skipped ?? 0 } } } as const;
}

const artifactFixture: readonly RelayArtifact[] = [{
  id: "artifact-1", taskId: "task-1", title: "需求说明", revision: "2", latestVersionId: "version-3",
  versionCount: 1, versions: [{ artifactVersionId: "version-3", versionNumber: "3",
    mediaType: "text/markdown", sha256: "abc", size: "12", sourceKind: "HUMAN", createdAt: "2026-10-24T00:00:00Z" }]
}];

function stubClient(getChatCommands: () => Promise<unknown> = vi.fn(async () => catalog),
  getKnowledge: () => Promise<unknown> = vi.fn(async () => knowledge),
  getGatewayConnections: () => Promise<unknown> = vi.fn(async () => connections),
  readManagedFileState: (input: { relativePath?: string }) => Promise<unknown> =
    vi.fn(async () => listingResponse([])),
  getTaskArtifacts: () => Promise<unknown> =
    vi.fn(async () => ({ items: artifactFixture, currentAcceptedVersionIds: [] }))) {
  return { getChatCommands, getKnowledge, getGatewayConnections, readManagedFileState,
    getTaskArtifacts } as unknown as RelayApiClient;
}

const fileConnections = [
  { id: "conn-files", status: "ACTIVE", capabilities: ["FILE_QUERY", "FILE_READ"],
    allowedHost: null, allowedExecutables: null }
] as const;

const workspaceFixture = { projectId: "p-1", resourceId: "r-1", displayName: "Relay-Agent" } as const;
const fileEntries: readonly RelayDirectoryEntry[] = [
  { path: "src", kind: "directory", size: null },
  { path: "README.md", kind: "file", size: 1234 },
  { path: "socket", kind: "other", size: null }
];

type HarnessProps = {
  readonly initialRefs?: readonly RelayAssistSourceRef[];
  readonly onToggleSourceRef?: (ref: RelayAssistSourceRef) => void;
  readonly onSources?: () => void;
  /** 首条消息没有会话级资料浮层：只给勾选入口，不给「检索项目资料」动作。 */
  readonly noSourcesPanel?: boolean;
  readonly onSkill?: () => void;
  readonly mode?: "AGENT" | "ASSISTANT" | "LEARNING";
  readonly conversation?: readonly RelayAssistSourceRef[];
  readonly recent?: readonly RelayAssistSourceRef[];
  readonly skillSelected?: boolean;
  readonly notes?: { text: string; keys: string[] }[];
  readonly projectId?: string | null;
  readonly skills?: readonly RelaySkillDefinition[];
  readonly selectedSkillKey?: string | null;
  readonly onPickSkill?: (key: string) => void;
  readonly skillContext?: { readonly projectId: string | null; readonly taskId: string | null;
    readonly resolveInPlace: boolean } | null;
  /** 额外端点需要替换默认夹具客户端。 */
  readonly client?: RelayApiClient;
  /** 菜单所在的站内位置：「管理连接与权限」要带着它作为返回路径。 */
  readonly path?: string;
  /** 新入口的调用方事实：工作目录、当前任务与上传回调。 */
  readonly workspace?: { readonly projectId: string; readonly resourceId: string; readonly displayName: string } | null;
  readonly artifactTaskId?: string | null;
  readonly onUploadAttachments?: (files: readonly File[]) => void;
  readonly uploadDisabled?: boolean;
};

/** 路由落点探针：只读当前位置，不渲染可见内容。 */
function PathProbe() {
  const location = useLocation();
  return <span data-testid="harness-path">{`${location.pathname}${location.search}`}</span>;
}

function Harness(props: HarnessProps) {
  const [draft, setDraft] = useState("");
  const [uploaded, setUploaded] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<readonly RelayAssistSourceRef[]>(props.initialRefs ?? []);
  return <MemoryRouter initialEntries={[props.path ?? "/agent"]}>
    <div className="agent-chat-composer-actions">
      <ComposerAttach client={props.client ?? stubClient()} mode={props.mode ?? "AGENT"} hasSession
        selectedRefs={selected} conversationRefs={props.conversation ?? []} recentRefs={props.recent ?? []}
        onToggleSourceRef={props.onToggleSourceRef ?? ((ref) => setSelected((current) => {
          const key = (item: RelayAssistSourceRef) => `${item.kind}:${item.rootId}:${item.version}`;
          return current.some((item) => key(item) === key(ref))
            ? current.filter((item) => key(item) !== key(ref)) : [...current, ref];
        }))}
        skillSelected={props.skillSelected ?? false}
        onSources={props.noSourcesPanel ? undefined : props.onSources ?? (() => {})}
        onSkill={props.onSkill ?? (() => {})}
        projectId={props.projectId ?? null}
        skills={props.skills} selectedSkillKey={props.selectedSkillKey ?? null}
        onPickSkill={props.onPickSkill} skillContext={props.skillContext ?? null}
        workspace={props.workspace ?? null} artifactTaskId={props.artifactTaskId ?? null}
        uploadDisabled={props.uploadDisabled ?? false}
        onUploadAttachments={(files) => { setUploaded(files.map((file) => file.name));
          props.onUploadAttachments?.(files); }}
        onCommand={() => setDraft((value) => value.startsWith("/") ? value : `/${value}`)}
        onPickCommand={(name) => setDraft((value) => `${value.match(/^\s*/u)?.[0] ?? ""}/${name} `)}
        onPickPlugin={(label) => setDraft((value) => insertPluginMention(value, label, null))}
        onInsertMention={(label) => setDraft((value) => insertMention(value, label, null))}
        notes={props.notes} />
      <textarea data-testid="draft" aria-label="本次消息" value={draft} readOnly />
      <span data-testid="harness-uploaded">{uploaded.join(",")}</span>
    </div>
    <PathProbe />
  </MemoryRouter>;
}

/** 不走 Harness 的那些用例：单独挂菜单时也要有路由上下文（「管理连接与权限」用站内导航）。 */
async function mountAttach(element: ReactElement, path = "/agent") {
  return mountReact(<MemoryRouter initialEntries={[path]}>{element}<PathProbe /></MemoryRouter>);
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
  it("点击「+」打开一级：参考图的七个入口都在，状态提示来自真实事实", async () => {
    const view = await mountReact(<Harness initialRefs={refs} skillSelected />);
    try {
      expect(attach()?.open).toBe(false);
      await openMenu();
      expect(attach()?.open).toBe(true);
      expect(row("assist-attach-upload")).not.toBeNull();
      expect(row("assist-attach-files")).not.toBeNull();
      expect(row("assist-attach-artifacts")).not.toBeNull();
      expect(row("assist-attach-sources")).not.toBeNull();
      expect(row("assist-attach-skill")).not.toBeNull();
      expect(row("assist-attach-command")).not.toBeNull();
      expect(row("assist-attach-connectors")).not.toBeNull();
      // 上传附件是直接动作（没有二级），文件与产物各自可展开。
      expect(row("assist-attach-upload")?.hasAttribute("aria-expanded")).toBe(false);
      expect(row("assist-attach-upload")?.querySelector(".agent-chat-attach-item-chevron")).toBeNull();
      expect(row("assist-attach-files")?.getAttribute("aria-expanded")).toBe("false");
      expect(row("assist-attach-artifacts")?.getAttribute("aria-expanded")).toBe("false");
      // 目录入口已从「+」撤出（2026-10-19）：它有常驻 Owner（协作页目录细条），
      // 在这里既重复、又读成「用之前必须先选目录」。
      expect(row("assist-attach-folder")).toBeNull();
      // 已选资料数、已选 Skill 都是真实事实的轻量提示，不是装饰。
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("2");
      expect(row("assist-attach-skill")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      // 允许展开的行才有 chevron 与 aria-expanded。
      expect(row("assist-attach-command")?.getAttribute("aria-expanded")).toBe("false");
      // 再点「+」收起一级。
      await click(document.querySelector('[data-testid="assist-attach"]'));
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("上传附件：直接打开本机图片选择器，选中后交给调用方的暂存链路", async () => {
    const onUpload = vi.fn();
    const view = await mountReact(<Harness onUploadAttachments={onUpload} />);
    try {
      const input = document.querySelector<HTMLInputElement>('[data-testid="assist-attach-upload-input"]');
      expect(input).not.toBeNull();
      const clickSpy = vi.spyOn(input!, "click");
      await openMenu();
      await click(row("assist-attach-upload"));
      expect(clickSpy).toHaveBeenCalledTimes(1);
      const file = new File(["png"], "截图.png", { type: "image/png" });
      await act(async () => {
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        input!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush(0);
      expect(onUpload).toHaveBeenCalledTimes(1);
      expect((onUpload.mock.calls[0]?.[0] as readonly File[]).map((item) => item.name)).toEqual(["截图.png"]);
      expect(document.querySelector('[data-testid="harness-uploaded"]')?.textContent).toBe("截图.png");
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }

    /* 输入器在途/发送中时如实禁用，不打开一个选完也用不上的对话框。 */
    const busy = await mountReact(<Harness uploadDisabled />);
    try {
      await openMenu();
      expect(row("assist-attach-upload")?.disabled).toBe(true);
      expect(row("assist-attach-upload")?.getAttribute("title")).toContain("稍后再上传附件");
    } finally { busy.unmount(); }
  });

  it("文件二级：读取受管目录一层条目，目录内导航，点文件把相对路径插入草稿", async () => {
    const readManagedFileState = vi.fn(async (input: { relativePath?: string }) =>
      input.relativePath === "src"
        ? listingResponse([{ path: "index.ts", kind: "file", size: 42 }])
        : listingResponse(fileEntries, { skipped: 2 }));
    const client = stubClient(undefined, undefined,
      vi.fn(async () => fileConnections), readManagedFileState);
    const view = await mountReact(<Harness client={client} workspace={workspaceFixture} />);
    try {
      await openSub("assist-attach-files");
      await flush();
      expect(submenu()?.getAttribute("data-section")).toBe("files");
      expect(submenu()?.textContent).toContain("Relay-Agent 根目录");
      expect(row("assist-attach-file-0")?.textContent).toContain("src");
      expect(row("assist-attach-file-0")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("目录");
      expect(row("assist-attach-file-1")?.textContent).toContain("README.md");
      // 非文件非目录的条目（socket 等）如实禁用，不冒充可插入文件。
      expect(row("assist-attach-file-2")?.disabled).toBe(true);
      expect(submenu()?.textContent).toContain("已跳过 2 个受保护或构建目录");

      await click(row("assist-attach-file-0"));
      await flush();
      expect(readManagedFileState.mock.calls.at(-1)?.[0]).toMatchObject(
        { actionType: "LIST_DIRECTORY", relativePath: "src" });
      expect(row("assist-attach-file-0")?.textContent).toContain("index.ts");
      expect(row("assist-attach-files-up")).not.toBeNull();

      await click(row("assist-attach-file-0"));
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value)
        .toBe("@src/index.ts ");
      expect(attach()?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("文件二级：无目录 / 无连接 / 失败 / 截断各有如实说法，不显示成空目录", async () => {
    const noWorkspace = await mountReact(<Harness />);
    try {
      await openSub("assist-attach-files");
      await flush();
      expect(submenu()?.textContent).toContain("当前对话还没有绑定工作目录");
      expect(row("assist-attach-file-0")).toBeNull();
    } finally { noWorkspace.unmount(); }

    const noConnection = await mountReact(<Harness workspace={workspaceFixture}
      client={stubClient(undefined, undefined, vi.fn(async () => []))} />);
    try {
      await openSub("assist-attach-files");
      await flush();
      expect(submenu()?.textContent).toContain("没有可用的文件浏览连接");
      expect(row("assist-attach-file-0")).toBeNull();
    } finally { noConnection.unmount(); }

    const failed = await mountReact(<Harness workspace={workspaceFixture} client={stubClient(undefined,
      undefined, vi.fn(async () => fileConnections), vi.fn(async () => ({
        commandId: "listing", committedAt: "2026-10-24T00:00:00Z",
        outcome: { state: "FAILED", actionType: "LIST_DIRECTORY", operationId: "op-1", invocationId: null,
          result: { kind: "FAILURE", reason: "GATEWAY_TARGET_DENIED", detail: "不是目录" } } }))) } />);
    try {
      await openSub("assist-attach-files");
      await flush();
      expect(submenu()?.textContent).toContain("GATEWAY_TARGET_DENIED");
      expect(submenu()?.textContent).not.toContain("没有可列出的文件");
    } finally { failed.unmount(); }

    const truncated = await mountReact(<Harness workspace={workspaceFixture} client={stubClient(undefined,
      undefined, vi.fn(async () => fileConnections),
      vi.fn(async () => listingResponse([fileEntries[1]!], { truncated: true }))) } />);
    try {
      await openSub("assist-attach-files");
      await flush();
      expect(submenu()?.textContent).toContain("已截断：只列出前 1 项");
    } finally { truncated.unmount(); }
  });

  it("文件二级渐进展示：首批 30 行，滚到近底或点「显示更多」追加下一批", async () => {
    /* 2026-10-25 用户指认「上传工作区文件的菜单无限滚动」：一层最多 200 条（HTTP §10.112），
       一次全画既拖长滚动也白画视口外的行。这里锁三件事：首批只画 30 行、滚动到行区近底
       自动追加（远离底部不追加）、尾部「显示更多」行兜底并把最后一批补齐。 */
    const many = Array.from({ length: 65 }, (_, index) =>
      ({ path: `file-${index}.ts`, kind: "file" as const, size: index }));
    const client = stubClient(undefined, undefined,
      vi.fn(async () => fileConnections), vi.fn(async () => listingResponse(many)));
    const view = await mountReact(<Harness client={client} workspace={workspaceFixture} />);
    try {
      await openSub("assist-attach-files");
      await flush();
      expect(row("assist-attach-file-0")).not.toBeNull();
      expect(row("assist-attach-file-29")).not.toBeNull();
      expect(row("assist-attach-file-30")).toBeNull();
      expect(row("assist-attach-files-more")?.textContent).toContain("剩余 35 项");
      // jsdom 不量几何：滚动位置用属性覆盖模拟，近底的阈值行为与真实滚动一致。
      const body = submenu()?.querySelector<HTMLElement>(".agent-chat-attach-subbody");
      const scrollBody = (top: number, height: number, full: number) => {
        if (body === null || body === undefined) throw new Error("行区不存在");
        Object.defineProperty(body, "scrollTop", { configurable: true, value: top });
        Object.defineProperty(body, "clientHeight", { configurable: true, value: height });
        Object.defineProperty(body, "scrollHeight", { configurable: true, value: full });
        body.dispatchEvent(new Event("scroll", { bubbles: true }));
      };
      await act(async () => { scrollBody(100, 300, 1300); });
      await flush(0);
      expect(row("assist-attach-file-30")).toBeNull();
      await act(async () => { scrollBody(1000, 300, 1300); });
      await flush(0);
      expect(row("assist-attach-file-30")).not.toBeNull();
      expect(row("assist-attach-file-59")).not.toBeNull();
      expect(row("assist-attach-file-60")).toBeNull();
      await click(row("assist-attach-files-more"));
      expect(row("assist-attach-file-64")).not.toBeNull();
      expect(row("assist-attach-files-more")).toBeNull();
    } finally { view.unmount(); }
  });

  it("我的产物：列当前任务产物，点一项把标题与版本插入草稿；无任务时说明去向", async () => {
    const noTask = await mountReact(<Harness />);
    try {
      await openSub("assist-attach-artifacts");
      await flush();
      expect(submenu()?.textContent).toContain("当前会话没有关联任务");
      expect(row("assist-attach-artifact-0")).toBeNull();
    } finally { noTask.unmount(); }

    const view = await mountReact(<Harness artifactTaskId="task-1" />);
    try {
      await openSub("assist-attach-artifacts");
      await flush();
      expect(row("assist-attach-artifact-0")?.textContent).toContain("需求说明");
      expect(row("assist-attach-artifact-0")?.querySelector(".agent-chat-attach-item-hint")?.textContent)
        .toBe("v3");
      await click(row("assist-attach-artifact-0"));
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value)
        .toBe("@需求说明 v3 ");
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
      await hover(row("assist-attach-skill"));
      expect(submenu()?.getAttribute("data-section")).toBe("skill");
      expect(row("assist-attach-skill")?.getAttribute("aria-expanded")).toBe("true");
      expect(row("assist-attach-sources")?.getAttribute("aria-expanded")).toBe("false");
      // 指针移到二级上不收起（延时被取消）。
      await pointerOut(document.querySelector(".agent-chat-attach-menu"), submenu() as Element);
      await hover(submenu());
      await flush(260);
      expect(submenu()?.getAttribute("data-section")).toBe("skill");
      // 真正离开两级之后才收起二级；一级仍是用户点开的，不跟着关。
      await pointerOut(submenu(), document.body);
      await flush(260);
      expect(submenu()).toBeNull();
      expect(attach()?.open).toBe(true);
    } finally { view.unmount(); }
  });

  it("禁用的行 hover 不展开二级（没有资料入口的档位）", async () => {
    const view = await mountAttach(<div>
      <ComposerAttach client={stubClient()} mode="AGENT" hasSession={false} onCommand={() => {}} />
    </div>);
    try {
      await openMenu();
      await hover(row("assist-attach-sources"));
      expect(submenu()).toBeNull();
    } finally { view.unmount(); }
  });


  it("首条消息只有勾选入口：资料一级可展开并直接勾选，检索动作不冒充可用", async () => {
    const view = await mountReact(<Harness projectId="p-1" noSourcesPanel />);
    try {
      await openSub("assist-attach-sources");
      // 没有会话级浮层也仍然能选：一级行可展开，二级直接平铺可勾选的项目资料。
      expect(row("assist-attach-sources")?.disabled).toBe(false);
      expect(row("assist-attach-sources")?.getAttribute("aria-expanded")).toBe("true");
      expect(row("assist-attach-search")).toBeNull();
      await click(row("assist-attach-project-0"));
      expect(row("assist-attach-project-0")?.querySelector(".agent-chat-attach-item-check")).not.toBeNull();
      expect(row("assist-attach-sources")?.querySelector(".agent-chat-attach-item-hint")?.textContent).toBe("1");
    } finally { view.unmount(); }
  });

  it("资料二级：检索入口、对话真实引用与最近引用可见，未接入的本地文件不再占一行", async () => {
    const onSources = vi.fn();
    const view = await mountReact(<Harness onSources={onSources} conversation={conversationRefs}
      recent={[{ kind: "MEMORY", rootId: "m-9", version: "4" }]} />);
    try {
      await openSub("assist-attach-sources");
      // 2026-10-20（P2）：「选择本地文件」没有真实去向，已从日常动作面移除；
      // 需要本机文件时走目录与检索，待实现的附件能力记录在文档里而不是靠禁用行承载。
      expect(row("assist-attach-local-file")).toBeNull();
      expect(submenu()?.querySelector(".agent-chat-attach-subnote")).toBeNull();
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
    const view = await mountAttach(<div>
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
        .toContain("先在工具行指定任务或项目");
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

  it("目录入口不在「+」里：一级没有文件夹行，也没有可展开的目录二级", async () => {
    /* 2026-10-19 用户指认「好像很多东西都需要授权或者什么选择目录之类的，这些都是过度设计」。
       目录的常驻 Owner 是协作页目录细条（`folder-scope-strip`）：「+」里再放一个「选择工作
       文件夹」既重复，又把目录读成「用之前必须先选」。近期目录与手动输入都在细条的弹层里。 */
    const view = await mountReact(<Harness />);
    try {
      await openMenu();
      expect(row("assist-attach-folder")).toBeNull();
      await click(row("assist-attach-skill"));
      expect(submenu()?.getAttribute("data-section")).toBe("skill");
      expect(row("assist-attach-folder-pick")).toBeNull();
      expect(row("assist-attach-recent-folder-0")).toBeNull();
      expect(row("assist-attach-workspace-manage")).toBeNull();
    } finally { view.unmount(); }
  });

  it("Skill 二级：生成类未接入如实禁用并写明接入点，选择已有 Skill 走既有发送选项", async () => {
    const onSkill = vi.fn();
    const view = await mountReact(<Harness onSkill={onSkill} />);
    try {
      await openSub("assist-attach-skill");
      expect(row("assist-attach-skill-describe")?.disabled).toBe(true);
      expect(row("assist-attach-skill-file")?.disabled).toBe(true);
      expect(row("assist-attach-skill-describe")?.getAttribute("title")).toContain("Skill 生成尚未接入");
      await click(row("assist-attach-skill-existing"));
      expect(onSkill).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });

  it("连接器二级：清单动态读取项目连接（GitHub / 浏览器 / 电脑等能力族），按能力逐行展示", async () => {
    /* 无项目归属（首条消息）时入口仍可点开（2026-10-18 用户指认「连接器与插件点击不了」）：
       面板顶部说明连接随项目配置，且不再列一个必然为空的「已连接能力」分组。 */
    const noProject = await mountReact(<Harness />);
    try {
      expect(row("assist-attach-connectors")?.disabled).toBe(false);
      await openSub("assist-attach-connectors");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent)
        .toBe("连接器随项目配置");
      expect(row("assist-attach-connector-0")).toBeNull();
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

  it("连接器二级：三个内置插件恒可见，状态只取自连接登记", async () => {
    /* 2026-10-19 用户指认「加号的菜单看不到这三个插件」：没有项目归属、或项目还没登记连接时，
       旧实现整块是空的。现在插件行恒在，只有状态随连接登记变化。 */
    const hintOf = (testId: string) => row(testId)
      ?.querySelector(".agent-chat-attach-item-hint")?.textContent;
    const noProject = await mountReact(<Harness />);
    try {
      await openSub("assist-attach-connectors");
      expect(row("assist-attach-plugin-computer")?.textContent).toContain("电脑操控");
      expect(row("assist-attach-plugin-browser")?.textContent).toContain("浏览器操控");
      expect(row("assist-attach-plugin-github")?.textContent).toContain("GitHub");
      /* 没有项目时**不写状态**：读不到登记就是无从判断，不是「未授权」；原因只说一次
         （2026-10-19 用户指认「为什么这里需要项目中授权」——三行各写一遍是同一句话的复读）。 */
      expect(hintOf("assist-attach-plugin-computer")).toBeUndefined();
      expect(hintOf("assist-attach-plugin-github")).toBeUndefined();
      expect(submenu()?.querySelectorAll(".agent-chat-attach-empty")).toHaveLength(1);
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent)
        .toBe("连接器随项目配置");
      // 去向仍在行的 title 里，不靠状态位表达。
      expect(row("assist-attach-plugin-github")?.getAttribute("title")).toContain("按项目登记");
    } finally { noProject.unmount(); }

    const view = await mountReact(<Harness projectId="p-1" />);
    try {
      await openSub("assist-attach-connectors");
      /* 夹具里 GitHub 只有 GITHUB_READ 且 ACTIVE；浏览器三个能力全 ACTIVE；
         电脑只有 COMPUTER_READ 且 DISABLED——状态逐项来自登记，不按「有这个插件」推断。 */
      expect(hintOf("assist-attach-plugin-github")).toBe("已连接");
      expect(hintOf("assist-attach-plugin-browser")).toBe("已连接");
      expect(hintOf("assist-attach-plugin-computer")).toBe("已停用");
    } finally { view.unmount(); }
  });

  it("连接器二级：三个内置插件各显示对应插件图标，不串图、不破图", async () => {
    /* 2026-10-25：Monitor/Globe/GitBranch 换成用户提供的薄荷绿插件图
       （assets/plugin-icons）。行结构不变：图标在左、名称居中、状态在右。 */
    const view = await mountReact(<Harness projectId="p-1" />);
    try {
      await openSub("assist-attach-connectors");
      for (const [testId, key, label] of [
        ["assist-attach-plugin-computer", "computer", "电脑操控"],
        ["assist-attach-plugin-browser", "browser", "浏览器操控"],
        ["assist-attach-plugin-github", "github", "GitHub"]
      ] as const) {
        const icon = row(testId)?.querySelector<HTMLImageElement>(`img[data-plugin-icon="${key}"]`);
        expect(icon, `${testId} 的 ${key} 图标`).not.toBeNull();
        expect(icon!.getAttribute("src")).toMatch(new RegExp(`${key}\\.png$`));
        // 装饰性图标：可访问名称仍由整行按钮承担，图标自身不进可访问树。
        expect(icon!.getAttribute("aria-hidden")).toBe("true");
        // 图标不挤占名称与状态位：三者同时在场。
        expect(row(testId)?.querySelector(".agent-chat-attach-item-label")?.textContent).toBe(label);
        expect(row(testId)?.querySelector(".agent-chat-attach-item-icon")?.contains(icon!)).toBe(true);
      }
      // 其他通用操作仍用 Lucide，不换图。
      await openMenu();
      expect(row("assist-attach-files")?.querySelector("svg")).not.toBeNull();
    } finally { view.unmount(); }
  });

  it("插件行：点击把 @插件标签 插进草稿，不弹详情、不发送（DEV-0099）", async () => {
    /* 2026-10-21（DEV-0099）：插件行是插入入口。运行时诊断与授权归「管理连接与权限」页，
       行上只保留连接状态；点击只编辑草稿，既不发消息也不授予任何能力。 */
    const view = await mountReact(<Harness projectId="p-1" />);
    try {
      await openSub("assist-attach-connectors");
      expect(row("assist-attach-plugin-github")?.getAttribute("title"))
        .toContain("点击把 @GitHub 插入输入框");
      await click(row("assist-attach-plugin-github"));
      expect(attach()?.open).toBe(false);
      expect(document.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')?.value).toBe("@GitHub ");
      expect(document.querySelector('[data-testid="assist-plugin-runtime"]')).toBeNull();
    } finally { view.unmount(); }

    /* 没有插入回调时（菜单只用于查看与导航）插件行保持禁用，不显示一个点了没反应的行。 */
    const bare = await mountAttach(<div>
      <ComposerAttach client={stubClient()} mode="AGENT" hasSession projectId="p-1"
        onSources={() => {}} onSkill={() => {}} onCommand={() => {}} />
    </div>);
    try {
      await openSub("assist-attach-connectors");
      expect(row("assist-attach-plugin-computer")?.disabled).toBe(true);
    } finally { bare.unmount(); }
  });

  it("连接器二级：空清单与读取失败各有如实文案，不编造插件", async () => {
    const empty = { getChatCommands: vi.fn(async () => catalog),
      getGatewayConnections: vi.fn(async () => []) } as unknown as RelayApiClient;
    const failing = { getChatCommands: vi.fn(async () => catalog),
      getGatewayConnections: vi.fn(async () => { throw new Error("boom"); }) } as unknown as RelayApiClient;
    const first = await mountAttach(<div>
      <ComposerAttach client={empty} mode="AGENT" hasSession projectId="p-1"
        onSources={() => {}} onSkill={() => {}} onCommand={() => {}} />
    </div>);
    try {
      await openSub("assist-attach-connectors");
      expect(submenu()?.querySelector(".agent-chat-attach-empty")?.textContent).toContain("还没有已连接的插件");
    } finally { first.unmount(); }
    const second = await mountAttach(<div>
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
      // /model 已接入；菜单仍只编辑草稿，执行须由发送触发。可用的命令不再挂「可用」标签。
      const model = row("assist-attach-command-model");
      expect(model?.querySelector(".agent-chat-attach-item-hint")).toBeNull();
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
    const view = await mountAttach(<div>
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
    const view = await mountReact(<Harness initialRefs={refs} skillSelected />);
    try {
      await openMenu();
      const sources = row("assist-attach-sources");
      const tail = sources?.querySelector(".agent-chat-attach-item-tail");
      expect(tail).not.toBeNull();
      expect(sources?.lastElementChild?.className).toBe("agent-chat-attach-item-tail");
      // 计数与 chevron 同组；对勾也进尾组。
      expect(tail?.querySelector(".agent-chat-attach-item-hint")).not.toBeNull();
      expect(tail?.querySelector(".agent-chat-attach-item-chevron")).not.toBeNull();
      expect(row("assist-attach-skill")?.querySelector(".agent-chat-attach-item-tail .agent-chat-attach-item-check"))
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
      expect(document.activeElement).toBe(row("assist-attach-skill"));
      await key(row("assist-attach-skill"), "ArrowUp");
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
    const view = await mountAttach(<div>
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
      expect(row("assist-attach-connectors")?.getAttribute("title")).toContain("连接器随项目配置");
      expect(row("assist-attach-command")?.getAttribute("aria-describedby")).toBeNull();
      // 原因只在悬停 title 里：菜单底部不再有整段脚注（2026-10-19 用户指认「很影响体验」）。
      expect(document.querySelector(".agent-chat-attach-note")).toBeNull();
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
      await openSub("assist-attach-sources");
      expect(submenu()?.getAttribute("data-flip")).toBe("left");
    } finally {
      Element.prototype.getBoundingClientRect = original;
      view.unmount();
    }
  });
});

/**
 * R3-01（2026-10-21 走查）：连接器面板底部的「管理连接与权限」要落到**当前项目**的
 * 连接与权限区，而不是要求重选项目的全局页；跳转本身是站内导航，不整页重载，
 * 并留下回到原会话的位置。这里锁的是跳转语义：导航与看状态不授予任何权限，
 * 授权仍只在连接页上由用户显式提交连接与策略命令产生。
 * 插件行改为插入 mention（DEV-0099），不再逐插件带 `tool` 参数跳转。
 */
describe("「管理连接与权限」保留当前范围", () => {
  /** 落点按站内路由读回：路径 + 查询参数，不依赖序列化时的编码细节。 */
  function landed() {
    const url = new URL(document.querySelector('[data-testid="harness-path"]')?.textContent ?? "", "http://workbench.local");
    return { pathname: url.pathname, params: url.searchParams };
  }

  it("项目会话里点「管理连接与权限」：站内直达本项目的连接页并留下返回路径", async () => {
    const view = await mountReact(<Harness path="/agent?session=abc" projectId="p-1" />);
    try {
      await openSub("assist-attach-connectors");
      await click(row("assist-attach-connectors-manage"));
      expect(landed().pathname).toBe("/projects/p-1/connections");
      // 不再按插件猜一个键：插件行自己只负责插入 mention。
      expect(landed().params.get("tool")).toBeNull();
      // 返回路径是点击时所在位置：往返后仍回得到同一条会话。
      expect(landed().params.get("from")).toBe("/agent?session=abc");
    } finally { view.unmount(); }
  });

  it("没有项目归属时到真实的项目选择页，不替用户猜一个项目", async () => {
    const view = await mountReact(<Harness projectId={null} />);
    try {
      await openSub("assist-attach-connectors");
      await click(row("assist-attach-connectors-manage"));
      expect(landed().pathname).toBe("/settings/connections");
      expect(landed().params.get("from")).toBe("/agent");
    } finally { view.unmount(); }
  });
});

/** 插入规则单独锁：光标处插入、选区替换、前后不叠空格。 */
describe("insertPluginMention", () => {
  const at = (start: number, end = start) => ({ selectionStart: start, selectionEnd: end });

  it("在光标处插入并保留光标后的文本", () => {
    expect(insertPluginMention("AB", "GitHub", at(1))).toBe("A @GitHub B");
  });

  it("选区被整段替换；句首不补前导空格，已空白处不叠空格", () => {
    expect(insertPluginMention("AB", "GitHub", at(0, 2))).toBe("@GitHub ");
    expect(insertPluginMention("看 ", "GitHub", at(2))).toBe("看 @GitHub ");
    expect(insertPluginMention("", "GitHub", null)).toBe("@GitHub ");
  });
});

