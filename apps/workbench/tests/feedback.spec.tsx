import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { FeedbackHost, Notice, Snackbar, Toast, closeUndoFeedback, escalateFeedback, openUndoFeedback } from "../src/components/Feedback";
import { feedbackEntries, removeFeedback } from "../src/lib/feedback";
import { feedbackText, flush, mountReact } from "./mountApp";

/**
 * 浮层反馈三档的行为闸（工作台 §13.1、设计系统 §6.4）。
 *
 * jsdom 没有布局，所以这里只断言与几何有关的两类事实：条目落在 body 上的那条栈里、
 * 不在业务组件自己的容器里（＝不进文档流），以及栈的位置锚点（读源码 CSS）。
 * 真实窗口里「出现与消失都不推动输入卡」由 tests/browser 的几何用例负责，不在本文件承诺。
 */

const roots: { unmount: () => void }[] = [];

async function mount(slot: ReactElement) {
  const host = await mountReact(<FeedbackHost />);
  const owner = await mountReact(slot);
  roots.push(host, owner);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return owner;
}

/** 命令式条目的归属方是业务动作而不是某个组件，所以这里只挂宿主。 */
async function mountHost() {
  const host = await mountReact(<FeedbackHost />);
  roots.push(host);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function card(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function hover(testId: string, leaving = false): Promise<void> {
  const target = card(testId);
  if (target === null) throw new Error(`feedback card not found: ${testId}`);
  await act(async () => { target.dispatchEvent(new Event(leaving ? "pointerout" : "pointerover", { bubbles: true })); });
}

afterEach(() => {
  while (roots.length > 0) roots.pop()?.unmount();
  // 命令式条目不随组件卸载收走（这正是它存在的理由），不逐条清空会把上一条测试的浮层带进下一条。
  act(() => { feedbackEntries().forEach((entry) => { removeFeedback(entry.id); }); });
  vi.useRealTimers();
});

it("Toast 到时长自动收走，条目在 body 的栈里而不是组件容器里", async () => {
  vi.useFakeTimers();
  const owner = await mount(<Toast>设置已保存</Toast>);
  expect(owner.wrapper.find('[data-testid="feedback-toast"]').exists()).toBe(false);
  expect(card("feedback-toast")?.closest(".feedback-stack")).not.toBeNull();
  expect(document.querySelector(".feedback-stack")?.parentElement).toBe(document.body);
  expect(card("feedback-toast")?.getAttribute("role")).toBe("status");
  expect(feedbackText("feedback-toast")).toBe("设置已保存");
  await advance(3_000);
  expect(card("feedback-toast")).not.toBeNull();
  await advance(1_000);
  expect(card("feedback-toast")).toBeNull();
  // 栈空了整条一起收走，不留一个空的定位容器。
  expect(card("feedback-stack")).toBeNull();
});

it("Snackbar 悬停期间暂停计时，指针离开后才走完停留时长", async () => {
  vi.useFakeTimers();
  await mount(<Snackbar action={{ label: "重新读取", onSelect: () => undefined }}>模型调用状态读取失败</Snackbar>);
  expect(card("feedback-snackbar")?.getAttribute("role")).toBe("status");
  await hover("feedback-snackbar");
  await advance(30_000);
  expect(feedbackText("feedback-snackbar")).toContain("模型调用状态读取失败");
  await hover("feedback-snackbar", true);
  await advance(8_000);
  expect(card("feedback-snackbar")).toBeNull();
});

it("Snackbar 的动作按钮跑调用方回调并收走条目，不额外发请求", async () => {
  let reads = 0;
  const retry = () => { reads += 1; };
  await mount(<Snackbar action={{ label: "重新读取", onSelect: retry }}>读取失败</Snackbar>);
  const button = card("feedback-snackbar")?.querySelector("button");
  expect(button?.textContent).toBe("重新读取");
  await act(async () => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(reads).toBe(1);
  expect(card("feedback-snackbar")).toBeNull();
});

it("Notice 不被计时器收走，只有用户显式关闭才消失", async () => {
  vi.useFakeTimers();
  await mount(<Notice>上下文压缩暂未接通。</Notice>);
  const target = card("feedback-notice");
  expect(target?.getAttribute("role")).toBe("alert");
  await advance(120_000);
  expect(card("feedback-notice")).not.toBeNull();
  const close = card("feedback-notice")?.querySelector<HTMLButtonElement>(".feedback-close");
  await act(async () => { close?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(card("feedback-notice")).toBeNull();
});

it("多条反馈按出现顺序叠放，来源组件卸载后不留孤儿条目", async () => {
  await mount(<><Toast>第一条</Toast><Notice>第二条</Notice></>);
  await flush();
  const cards = Array.from(document.querySelectorAll(".feedback-card"));
  expect(cards.map((element) => element.textContent)).toEqual(["第一条", "第二条"]);
  expect(cards[0]?.parentElement).toBe(cards[1]?.parentElement);
  await act(async () => { roots.pop()?.unmount(); });
  expect(card("feedback-stack")).toBeNull();
});

it("命令式撤销条不随触发它的插槽一起卸载，关闭后才消失", async () => {
  await mountHost();
  const owner = await mountReact(<Toast>插槽条目</Toast>);
  roots.push(owner);
  act(() => { openUndoFeedback("k-stay", { text: "已归档这段讨论", actionLabel: "撤销", onUndo: () => undefined, testId: "undo-stay" }); });
  expect(card("undo-stay")).not.toBeNull();
  // 归属组件卸载：插槽那条被自己的清理收走，撤销条必须留下。
  owner.unmount();
  roots.pop();
  expect(card("feedback-toast")).toBeNull();
  expect(feedbackText("undo-stay")).toContain("已归档这段讨论");
  act(() => { closeUndoFeedback("k-stay"); });
  expect(card("undo-stay")).toBeNull();
});

it("同一个键重复打开只保留一条，内容是后一次那份", async () => {
  await mountHost();
  act(() => { openUndoFeedback("k-dup", { text: "第一次归档", actionLabel: "撤销", onUndo: () => undefined, testId: "undo-dup" }); });
  act(() => { openUndoFeedback("k-dup", { text: "第二次归档", actionLabel: "撤销", onUndo: () => undefined, testId: "undo-dup" }); });
  const cards = Array.from(document.querySelectorAll('[data-testid="undo-dup"]'));
  expect(cards).toHaveLength(1);
  expect(cards[0]?.textContent).toContain("第二次归档");
  expect(cards[0]?.getAttribute("data-variant")).toBe("snackbar");
});

it("点撤销跑恰一次反向命令并把条目同步收走", async () => {
  let undos = 0;
  await mountHost();
  act(() => { openUndoFeedback("k-undo", { text: "已归档这段讨论", actionLabel: "撤销", onUndo: () => { undos += 1; }, testId: "undo-click" }); });
  const button = card("undo-click")?.querySelector("button");
  expect(button?.textContent).toBe("撤销");
  await act(async () => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(undos).toBe(1);
  expect(card("undo-click")).toBeNull();
});

it("撤销条还在栈里时升级成 Notice：换内容不换条目，计时器不再收走", async () => {
  vi.useFakeTimers();
  await mountHost();
  act(() => { openUndoFeedback("k-live", { text: "已归档这段讨论", actionLabel: "撤销", onUndo: () => undefined, testId: "undo-live" }); });
  act(() => { escalateFeedback("k-live", { text: "撤销没成功：这段讨论刚被改过", testId: "undo-live" }); });
  expect(Array.from(document.querySelectorAll('[data-testid="undo-live"]'))).toHaveLength(1);
  const target = card("undo-live");
  expect(target?.getAttribute("data-variant")).toBe("notice");
  expect(target?.getAttribute("role")).toBe("alert");
  // 原来的 8 秒停留计时必须被清掉，否则这条会在用户还没读完时自己消失。
  await advance(60_000);
  expect(card("undo-live")).not.toBeNull();
  const close = card("undo-live")?.querySelector(".feedback-close");
  await act(async () => { close?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(card("undo-live")).toBeNull();
});

it("撤销条已超时消失后再升级，仍作为 Notice 重新出现而不是静默丢弃", async () => {
  vi.useFakeTimers();
  await mountHost();
  act(() => { openUndoFeedback("k-gone", { text: "已归档这段讨论", actionLabel: "撤销", onUndo: () => undefined, testId: "undo-gone" }); });
  await advance(8_000);
  expect(card("undo-gone")).toBeNull();
  act(() => { escalateFeedback("k-gone", { text: "撤销没成功：这段讨论刚被改过", testId: "undo-gone" }); });
  expect(card("undo-gone")?.getAttribute("data-variant")).toBe("notice");
  await advance(120_000);
  expect(card("undo-gone")).not.toBeNull();
});

it("栈锚在屏幕正上方且落在桌面标题带之下，不退回底部", () => {
  // jsdom 不加载样式表，位置这条只能读源码 CSS 守：用户 2026-10-17 指定「提示要在屏幕的正上方」，
  // 而顶边一旦小于标题带高度就会吃掉窗口拖动区与右缘窗口按钮，这两件事都只在这里锁得住。
  const css = readFileSync(join(__dirname, "..", "src", "styles.css"), "utf8");
  const stack = css.match(/\.feedback-stack\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(stack).toContain("position: fixed");
  expect(stack).toContain("top: calc(var(--relay-control-nav-height) + var(--relay-space-2))");
  expect(stack).not.toMatch(/(^|\s)bottom:/);
  expect(stack).toMatch(/left: 50%;\s*transform: translateX\(-50%\)/);
  // 进入动画跟着栈一起翻向：自上方落，而不是从下方升起。
  expect(css).toContain("translateY(calc(-1 * var(--relay-space-2)))");
  expect(css).not.toContain("feedback-rise");
});
