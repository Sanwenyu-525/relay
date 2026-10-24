import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { createWorkbenchRouter } from "../src/router";

/** Keep the archived assertions intact while replacing the Vue Test Utils mount surface with DOM events. */
export class DomWrapper {
  constructor(readonly element: Element | null) {}
  exists(): boolean { return this.element !== null; }
  text(): string { return this.element?.textContent?.replace(/\s+/g, " ").trim() ?? ""; }
  attributes(name: string): string | undefined { return this.element?.getAttribute(name) ?? undefined; }
  find(selector: string): DomWrapper { return new DomWrapper(this.element?.querySelector(selector) ?? null); }
  get(selector: string): DomWrapper {
    const found = this.find(selector);
    if (!found.exists()) throw new Error(`DOM test selector not found: ${selector}\n${this.element?.outerHTML.slice(0, 1200) ?? ""}`);
    return found;
  }
  findAll(selector: string): DomWrapper[] { return Array.from(this.element?.querySelectorAll(selector) ?? []).map((element) => new DomWrapper(element)); }
  async trigger(eventName: string, init?: { key?: string }): Promise<void> {
    if (!this.element) throw new Error("Cannot trigger missing DOM element");
    const target = this.element;
    await act(async () => {
      if (eventName === "click") target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      else if (eventName === "submit") target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // 键盘事件必须是 KeyboardEvent：普通 Event 没有 key，键盘处理器读到的会是 undefined。
      else if (eventName.startsWith("key"))
        target.dispatchEvent(new KeyboardEvent(eventName, { bubbles: true, cancelable: true, key: init?.key ?? "" }));
      else target.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
    });
  }
  async setValue(value?: string | number | boolean): Promise<void> {
    if (!this.element) throw new Error("Cannot set value on missing DOM element");
    const target = this.element;
    await act(async () => {
      if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
        const checked = value === undefined ? true : Boolean(value);
        if (target.checked !== checked) target.click();
      } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, String(value ?? ""));
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      } else throw new Error(`Cannot set value on ${target.tagName}`);
    });
  }
}

export async function flush(milliseconds = 40): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)); });
  // React commits effects after an act boundary; route remounts can begin one more async fixture read there.
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
}

export async function mountWorkbench(path: string) {
  const router = createWorkbenchRouter([path]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<RouterProvider router={router} />); });
  await flush();
  return {
    wrapper: new DomWrapper(container),
    router: {
      push: async (target: string) => { await act(async () => { await router.navigate(target); }); },
      back: async () => { await act(async () => { await router.navigate(-1); }); },
      currentRoute: { get value() { const location = router.state.location; return { path: location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)) }; } }
    },
    unmount: () => { act(() => root.unmount()); container.remove(); }
  };
}

export async function mountReact(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { wrapper: new DomWrapper(container), rerender: async (next: ReactElement) => { await act(async () => { root.render(next); }); }, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

export function dialogText(): string { return Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => dialog.textContent ?? "").join("\n"); }
export function dialogLabels(): string[] { return Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => dialog.getAttribute("aria-label") ?? ""); }
export function pressEscape(): void { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }

/**
 * 浮层反馈（Toast／Snackbar／Notice）的文本。
 *
 * 这条栈由 FeedbackHost portal 到 document.body，`mountWorkbench` 返回的容器查不到它，
 * 与 dialogText／clickPortal 同一原因。缺条时如实报错，不把「没渲染」读成别的结论。
 */
export function feedbackText(testId: string): string {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`feedback not found (portal): [data-testid="${testId}"]`);
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * 「页面上说过的话」＝容器文本＋浮层反馈栈文本。
 *
 * 回执与失败说明从正文搬进 body 上的那条栈之后（设计系统 §6.4），只看容器的 text() 会漏读。
 * 这些断言要核对的是「用户看得见这句话」，不是它落在哪个子树里，所以两处一起取。
 */
export function pageText(wrapper: DomWrapper): string {
  const overlay = document.querySelector(".feedback-stack")?.textContent ?? "";
  return `${wrapper.text()} ${overlay.replace(/\s+/g, " ").trim()}`;
}

/**
 * 打开一个工作目录（协作页 §3.3 之后的唯一路径）。
 *
 * 目录控件从消息区顶部的折叠块搬进细条上的「更换目录」浮层（2026-10-18：原先是 40rem
 * 居中弹窗，用户指令「弹窗太大了」后改成锚在目录名上方的紧凑面板）。浮层挂在细条子树里，
 * 但这里仍按 body 查：这些控件的可达性与位置无关，用 document 查询能同时覆盖浮层与弹窗。
 * 选定后浮层自行收起（留着会挡住刚更新的细条），因此调用返回时页面已可交互。
 */
export async function openWorkingDirectory(root: string): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[data-testid="folder-scope-change"]');
  if (trigger === null) throw new Error('DOM test selector not found: [data-testid="folder-scope-change"]');
  await act(async () => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
  const input = document.querySelector<HTMLInputElement>('[data-testid="folder-manual-root"]');
  if (input === null) throw new Error('DOM test selector not found: [data-testid="folder-manual-root"]（更换目录浮层未打开，或本机可用原生目录选择器）');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, root);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const submit = document.querySelector<HTMLElement>('[data-testid="folder-open-manual"]');
  if (submit === null) throw new Error('DOM test selector not found: [data-testid="folder-open-manual"]');
  await act(async () => { submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush(80);
}

/** 目录作用域细条上的当前目录名；还没有目录时返回动作「选择工作目录」。
 *  2026-10-18 两行合并后目录名本身就是「更换目录」入口（folder-scope-change），
 *  名字仍读自这一颗键的文本。 */
export function folderStripName(): string {
  return document.querySelector('[data-testid="folder-scope-change"]')?.textContent?.trim() ?? "";
}

/**
 * 点 portal 里的控件。
 *
 * AppDialog 用 createPortal 把面板挂到 document.body，mountWorkbench 返回的容器查不到它，
 * 因此这类点击必须走 document。找不到时如实报错，不静默跳过。
 */
export async function clickPortal(testId: string): Promise<void> {
  const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`DOM test selector not found (portal): [data-testid="${testId}"]`);
  await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

/**
 * 从正文的未决状态行打开核对弹窗。
 *
 * 弹窗不自动弹出：状态行是唯一入口，关掉弹窗后它仍在原处，可以再次打开。
 * 原因、command_id 与两个恢复出口都在弹窗里，因此核对类操作前要先走这一步。
 */
export async function openUnresolvedDialog(testId: string): Promise<void> {
  const trigger = document.querySelector<HTMLElement>(`[data-testid="${testId}"] button`);
  if (trigger === null) throw new Error(`DOM test selector not found: [data-testid="${testId}"] button`);
  await act(async () => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
}

/** 打开细条上的「更换目录」浮层（非模态，挂在细条子树里）。 */
export async function openFolderDialog(): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[data-testid="folder-scope-change"]');
  if (trigger === null) throw new Error('DOM test selector not found: [data-testid="folder-scope-change"]');
  await act(async () => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
}

/** 细条上的归属文案（「已归入项目：X」/「未归入项目」）。 */
export function folderStripAssociation(): string {
  return document.querySelector('[data-testid="folder-scope-association"]')?.textContent?.trim() ?? "";
}

/**
 * 协作页顶栏上的当前会话名。
 *
 * 2026-10-17 顶栏收成一行、只显示会话名（用户指令），下拉框不再出现在协作页里，
 * 因此「现在看的是哪条讨论」在顶栏这一侧只剩这段文字可核对；完整标题留在 title 上。
 */
export function toolbarSessionTitle(): string {
  const element = document.querySelector('[data-testid="collab-session-title"]');
  if (element === null) throw new Error('DOM test selector not found: [data-testid="collab-session-title"]');
  return element.textContent?.trim() ?? "";
}

/**
 * 近期工作栏里这条会话行是否带「当前」标记。
 *
 * 顶栏不再有下拉后，会话身份在 DOM 里由这一行的 aria-current 承担；缺行时如实报错，
 * 不把「行没渲染」读成「它不是当前会话」。目标区副本带 goal 前缀，两种 testid 一起查。
 */
export function railSessionCurrent(sessionId: string): boolean {
  const row = document.querySelector(`[data-testid="recent-work-${sessionId}"], [data-testid^="recent-work-goal-"][data-testid$="-${sessionId}"]`);
  if (row === null) throw new Error(`DOM test selector not found: recent-work-${sessionId}（近期工作栏未渲染这条会话行）`);
  return row.getAttribute("aria-current") === "true";
}

/** 从近期工作栏切到另一条会话：跨作用域挑讨论的常驻入口（工作栏只列 `taskId` 为空的会话）。 */
export async function openRailSession(sessionId: string): Promise<void> {
  const row = document.querySelector<HTMLElement>(`[data-testid="recent-work-${sessionId}"], [data-testid^="recent-work-goal-"][data-testid$="-${sessionId}"]`);
  if (row === null) throw new Error(`DOM test selector not found: recent-work-${sessionId}（近期工作栏未渲染这条会话行）`);
  await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush(120);
}

/**
 * 顶栏右翼「切换讨论」浮层里列出的讨论，按浮层顺序返回可见说法。
 *
 * 这颗键只在同一作用域读出 ≥2 条讨论时才存在（AssistView.tsx 的 sessionSwitcherNode）：
 * 单条讨论的顶栏按 2026-10-17 用户指令只剩会话名，没有第二种切换控件。
 * 键不存在时先打开浮层再读，读不到键就如实报错——「没有这颗键」是要断言的事实，不是查询失败。
 */
export async function openSessionSwitcher(): Promise<string[]> {
  await ensureSwitcherOpen();
  return Array.from(document.querySelectorAll('[data-testid^="collab-session-option-"]'))
    .map((option) => option.textContent?.trim() ?? "");
}

/** 从顶栏「切换讨论」浮层切到同一作用域里的另一条讨论（与旧下拉同一个 selectSession 与离开保护）。 */
export async function switchToolbarSession(sessionId: string): Promise<void> {
  await ensureSwitcherOpen();
  const option = document.querySelector<HTMLElement>(`[data-testid="collab-session-option-${sessionId}"]`);
  if (option === null) throw new Error(`DOM test selector not found: collab-session-option-${sessionId}（浮层里没有这条讨论）`);
  await act(async () => { option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
}

/**
 * 浮层里被标为「当前」的那条讨论的 id，由 `aria-current` 读，不靠文案猜。
 *
 * 取代旧下拉的 `select.value`：那是页面上唯一能读出「界面停在哪个会话 id」的地方，
 * 现在这一事实由浮层选项的当前标记承担。调用前必须先展开浮层（openSessionSwitcher）。
 */
export function switcherCurrentSession(): string | null {
  const options = document.querySelectorAll('[data-testid^="collab-session-option-"]');
  if (options.length === 0) throw new Error("切换讨论浮层未展开：先 await openSessionSwitcher() 再读当前项");
  const current = document.querySelector('[data-testid^="collab-session-option-"][aria-current="true"]');
  return current?.getAttribute("data-testid")?.slice("collab-session-option-".length) ?? null;
}

/** 打开浮层。触发键是开／关切换，所以已展开时不再点第二次——否则会把刚打开的面板又收回去。 */
async function ensureSwitcherOpen(): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[data-testid="collab-session-switcher"]');
  if (trigger === null) throw new Error('DOM test selector not found: collab-session-switcher（当前作用域不足两条讨论，或顶栏未渲染切换键）');
  if (trigger.getAttribute("aria-expanded") === "true") return;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
}

/** 顶栏「切换讨论」这颗键当前是否存在（同作用域 ≥2 条讨论才有）。 */
export function hasSessionSwitcher(): boolean {
  return document.querySelector('[data-testid="collab-session-switcher"]') !== null;
}
