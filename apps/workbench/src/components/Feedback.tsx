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
