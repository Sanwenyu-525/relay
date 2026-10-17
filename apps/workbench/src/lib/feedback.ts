/**
 * 浮层反馈的共享栈。
 *
 * 与 `lib/dialogStack.ts` 同一套模块级 store 写法：本项目没有 React Context，
 * 而这条栈必须同时被「页壳里的宿主」和「各个业务组件里的插槽」看到，
 * 用 provider 会把宿主塞进每一处只挂单个组件的测试里。
 *
 * 三类通道的差别只在 `dwellMs` 与有没有动作，因此共用一个 entry 形状，不再分子类型：
 *   toast    —— 短回执，无动作，自动消失；
 *   snackbar —— 带一个动作（撤销／重新读取／查看），自动消失，悬停与聚焦时暂停；
 *   notice   —— 停留到用户处理（`dwellMs` 为 null），带关闭按钮。
 * 三者都不进文档流，所以任何一条出现或消失都不改变页面几何。
 */
export type FeedbackVariant = "toast" | "snackbar" | "notice";
export type FeedbackTone = "neutral" | "success" | "warning" | "danger";

export interface FeedbackEntry {
  readonly id: number;
  readonly variant: FeedbackVariant;
  readonly tone: FeedbackTone;
  /** 只收纯文本：`visible()` 靠它判断「这条有没有换内容」，ReactNode 无法比较，
   *  要么漏更新要么每次渲染都重绘。需要富文本的通道走对话框，不走这里。 */
  readonly text: string;
  readonly actionLabel: string | null;
  /** 动作回调不进比较：调用方每次渲染都换一个新闭包，比较它会让栈无谓重绘。 */
  readonly onAction: (() => void) | null;
  /** null = 停留到用户处理。 */
  readonly dwellMs: number | null;
  /** 调用方原有的语义 testid：条目本身有 `feedback-<variant>` 可查，但页面级断言不该跟着换名字。 */
  readonly testId: string | null;
}

let lastId = 0;
let entries: readonly FeedbackEntry[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function nextFeedbackId(): number {
  lastId += 1;
  return lastId;
}

export function subscribeFeedback(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function feedbackEntries(): readonly FeedbackEntry[] {
  return entries;
}

function visible(entry: FeedbackEntry): string {
  return `${entry.variant}|${entry.tone}|${entry.actionLabel ?? ""}|${entry.dwellMs ?? "sticky"}|${entry.testId ?? ""}|${entry.text}`;
}

/** 原位插入或替换：栈的顺序由 id 决定，内容变化不应把这条挪到栈末。 */
export function putFeedback(entry: FeedbackEntry): void {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) {
    entries = [...entries, entry];
    notify();
    return;
  }
  const previous = entries[index]!;
  entries = entries.map((candidate) => (candidate.id === entry.id ? entry : candidate));
  if (visible(previous) !== visible(entry)) notify();
}

export function removeFeedback(id: number): void {
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return;
  entries = next;
  notify();
}
