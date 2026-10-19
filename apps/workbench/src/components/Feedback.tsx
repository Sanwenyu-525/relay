import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  type FeedbackEntry, type FeedbackTone, type FeedbackVariant,
  feedbackEntries, nextFeedbackId, putFeedback, removeFeedback, subscribeFeedback,
} from "../lib/feedback";
import { resolvedTokenValue } from "../lib/tokens";

/** token 存的是 CSS 时长写法（`4s`、`180ms`），JS 定时器要的是毫秒数。 */
function tokenMs(name: string): number {
  const raw = resolvedTokenValue(name).trim();
  const value = Number.parseFloat(raw);
  return raw.endsWith("ms") ? value : Math.round(value * 1000);
}

const TOAST_MS = tokenMs("motion.duration.toast");
const SNACKBAR_MS = tokenMs("motion.duration.snackbar");

/**
 * 把这一处渲染出来的内容挂进共享栈，并在本组件卸载时收走它。
 *
 * 动作回调走 ref 而不是依赖项：调用方每次渲染都新建一个闭包，把它写进依赖会让整条栈
 * 跟着重绘并重置停留计时；ref 保证点击时跑到的仍是最新闭包，视觉上这条反馈却不受重绘影响。
 */
function useFeedbackSlot(spec: {
  readonly variant: FeedbackVariant; readonly tone: FeedbackTone; readonly text: string;
  readonly actionLabel: string | null; readonly onAction: (() => void) | null; readonly dwellMs: number | null;
  readonly testId: string | null;
}): void {
  const [id] = useState(nextFeedbackId);
  const action = useRef(spec.onAction);
  action.current = spec.onAction;
  const { variant, tone, text, actionLabel, dwellMs, testId } = spec;
  useEffect(() => {
    putFeedback({ id, variant, tone, text, actionLabel, dwellMs, testId, onAction: () => action.current?.() });
    return () => { removeFeedback(id); };
  }, [id, variant, tone, text, actionLabel, dwellMs, testId]);
}

export function Toast({ children, testId = null }: { readonly children: string; readonly testId?: string | null }) {
  useFeedbackSlot({ variant: "toast", tone: "success", text: children, actionLabel: null, onAction: null, dwellMs: TOAST_MS, testId });
  return null;
}

export function Snackbar({ children, action, tone = "neutral", testId = null }: {
  readonly children: string; readonly tone?: FeedbackTone; readonly testId?: string | null;
  readonly action: { readonly label: string; readonly onSelect: () => void };
}) {
  useFeedbackSlot({ variant: "snackbar", tone, text: children, actionLabel: action.label, onAction: action.onSelect, dwellMs: SNACKBAR_MS, testId });
  return null;
}

/** 与「人工待处理通知」不同：这条只活在当前窗口里，不落库、不跨页，只保证不被计时器收走。 */
export function Notice({ children, action, tone = "danger", testId = null }: {
  readonly children: string; readonly tone?: FeedbackTone; readonly testId?: string | null;
  readonly action?: { readonly label: string; readonly onSelect: () => void };
}) {
  useFeedbackSlot({ variant: "notice", tone, text: children, actionLabel: action?.label ?? null, onAction: action?.onSelect ?? null, dwellMs: null, testId });
  return null;
}

/**
 * 命令式撤销条：入口必须活得比触发它的组件久。
 *
 * 上面三个插槽走 `useFeedbackSlot`，归属组件卸载就把自己收走。而危险操作成功后的第一件事
 * 就是关掉那个面板（例如会话行菜单收起），撤销条要是跟着一起卸载，就等于没有撤销。
 * 倒计时本来就归宿主侧的 `FeedbackCard` 管，`FeedbackHost` 挂在页壳里不随行卸载，
 * 所以命令式条目天然不需要自己看定时器。
 *
 * 条目按业务键登记：同键再次打开复用同一个 id，`putFeedback` 于是走原位替换而不是压出第二条。
 */
const imperativeIds = new Map<string, number>();

function imperativeId(key: string): number {
  const known = imperativeIds.get(key);
  const id = known ?? nextFeedbackId();
  imperativeIds.set(key, id);
  return id;
}

export function openUndoFeedback(key: string, spec: {
  readonly text: string; readonly actionLabel: string; readonly onUndo: () => void; readonly testId?: string | null;
}): void {
  putFeedback({
    id: imperativeId(key), variant: "snackbar", tone: "neutral", text: spec.text,
    actionLabel: spec.actionLabel, dwellMs: SNACKBAR_MS, testId: spec.testId ?? null,
    // 点击时 FeedbackCard 已按 id 收走条目；这里先清键登记，再跑调用方的反向命令。
    onAction: () => { closeUndoFeedback(key); spec.onUndo(); },
  });
}

/**
 * 把同一键那条撤销条就地升级成停留到用户处理的 Notice。
 *
 * 反向命令失败时不能只把错误留在就地：那一刻用户手上的入口正是这条浮层，条目还活着，
 * 改写成 Notice 后 `dwellMs` 从 8s 变 null，`FeedbackCard` 的计时 effect 依赖 `dwellMs`，
 * 会自动清掉旧定时器并长出关闭按钮，不需要新增变体或新 token。
 */
export function escalateFeedback(key: string, spec: {
  readonly text: string; readonly testId?: string | null;
}): void {
  putFeedback({
    id: imperativeId(key), variant: "notice", tone: "danger", text: spec.text,
    actionLabel: null, onAction: null, dwellMs: null, testId: spec.testId ?? null,
  });
}

export function closeUndoFeedback(key: string): void {
  const id = imperativeIds.get(key);
  if (id === undefined) return;
  imperativeIds.delete(key);
  removeFeedback(id);
}

function FeedbackCard({ entry }: { readonly entry: FeedbackEntry }) {
  /** 悬停或键盘聚焦时暂停：读屏用户与伸手点动作按钮的用户都不该被计时器抢先。 */
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (entry.dwellMs === null || paused) return;
    const timer = window.setTimeout(() => { removeFeedback(entry.id); }, entry.dwellMs);
    return () => { window.clearTimeout(timer); };
  }, [entry.id, entry.dwellMs, entry.text, paused]);
  return <div className={`feedback-card feedback-card--${entry.tone}`} data-variant={entry.variant}
    data-testid={entry.testId ?? `feedback-${entry.variant}`} role={entry.tone === "danger" ? "alert" : "status"}
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <p className="feedback-text">{entry.text}</p>
    {entry.actionLabel !== null && <button type="button" className="text-button feedback-action"
      onClick={() => { entry.onAction?.(); removeFeedback(entry.id); }}>{entry.actionLabel}</button>}
    {entry.dwellMs === null && <button type="button" className="icon-button feedback-close"
      aria-label="关闭提示" title="关闭提示" onClick={() => removeFeedback(entry.id)}><X aria-hidden="true" /></button>}
  </div>;
}

/** 页壳里挂一次即可：栈本身 portal 到 body，业务组件只负责渲染上面那几个插槽。 */
export function FeedbackHost() {
  const [entries, setEntries] = useState<readonly FeedbackEntry[]>(feedbackEntries);
  useEffect(() => {
    const sync = () => { setEntries(feedbackEntries()); };
    const unsubscribe = subscribeFeedback(sync);
    sync();
    return unsubscribe;
  }, []);
  if (entries.length === 0) return null;
  return createPortal(<div className="feedback-stack" data-testid="feedback-stack">
    {entries.map((entry) => <FeedbackCard key={entry.id} entry={entry} />)}
  </div>, document.body);
}
