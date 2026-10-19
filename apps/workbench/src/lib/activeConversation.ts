import { useSyncExternalStore } from "react";

/**
 * 当前正在看的会话：左栏用它做「当前会话高亮」。
 *
 * 这里**不是**第二套业务状态。会话身份的唯一 Owner 仍是协作页（AssistView 把
 * 实际展示的会话回报给协作页，协作页再发布到这里），本模块只承载一个只读投影，
 * 供左栏这类兄弟组件读取——左栏与协作页在组件树上是并列的，没有父子通道。
 * 协作页卸载时发布空值，避免高亮停在一条已经离开的会话上。
 */
export interface ActiveConversation {
  readonly taskId: string | null;
  readonly sessionId: string | null;
  /**
   * 这条会话的服务端作用域事实变化计数（换目录确认成功后 +1）。
   * 同一会话换目录时身份一个字都没变，只按身份去重的发布叫不醒已经渲染过的消费者；
   * 左栏需要这个计数才知道该再向服务端重读一次这一行。它不是第二套目录状态。
   */
  readonly contextEpoch: number;
}

const empty: ActiveConversation = { taskId: null, sessionId: null, contextEpoch: 0 };
let current: ActiveConversation = empty;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishActiveConversation(next: { taskId: string | null; sessionId: string | null }): void {
  if (current.taskId === next.taskId && current.sessionId === next.sessionId) return;
  current = { ...next, contextEpoch: 0 };
  notify();
}

/** 作用域事实已由服务端确认改变：让读取这一行的消费者重读，不改会话身份。 */
export function bumpActiveConversationContext(): void {
  if (current.sessionId === null) return;
  current = { ...current, contextEpoch: current.contextEpoch + 1 };
  notify();
}

export function clearActiveConversation(): void {
  publishActiveConversation(empty);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActiveConversation(): ActiveConversation {
  return useSyncExternalStore(subscribe, () => current, () => empty);
}
