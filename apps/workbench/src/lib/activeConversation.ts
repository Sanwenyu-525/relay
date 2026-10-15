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
}

const empty: ActiveConversation = { taskId: null, sessionId: null };
let current: ActiveConversation = empty;
const listeners = new Set<() => void>();

export function publishActiveConversation(next: ActiveConversation): void {
  if (current.taskId === next.taskId && current.sessionId === next.sessionId) return;
  current = next;
  for (const listener of listeners) listener();
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
