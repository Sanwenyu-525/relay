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
  /**
   * 这条会话刚落地消息的计数（用户消息入库、生成结算各 +1）。
   * 左栏按最后消息时间排序，服务端在 insertMessage／settleGeneration 单调推进
   * `last_message_at`：这个计数是「该再向服务端重读这一行」的信号，让列序在消息
   * 落地那一刻收敛，而不是等下一次整列重读。它不是第二份消息状态——时刻只从
   * 服务端读，本地不猜。
   */
  readonly activityEpoch: number;
}

const empty: ActiveConversation = { taskId: null, sessionId: null, contextEpoch: 0, activityEpoch: 0 };
let current: ActiveConversation = empty;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishActiveConversation(next: { taskId: string | null; sessionId: string | null }): void {
  if (current.taskId === next.taskId && current.sessionId === next.sessionId) return;
  current = { ...next, contextEpoch: 0, activityEpoch: 0 };
  notify();
}

/** 作用域事实已由服务端确认改变：让读取这一行的消费者重读，不改会话身份。 */
export function bumpActiveConversationContext(): void {
  if (current.sessionId === null) return;
  current = { ...current, contextEpoch: current.contextEpoch + 1 };
  notify();
}

/**
 * 这条会话刚落地一条消息：让读取排序键的消费者（左栏）重读这一行。
 *
 * 只认**当前正在看的自由会话**：任务聊天的会话由任务行承担，左栏不参与它的排序；
 * 已经切走的会话迟到刷新也不递计数——那时该上浮的早由它在活动期间的那几次递过了。
 * 调用方传入自己观察到的那条会话 id，由这里核对身份，不靠调用时序。
 */
export function bumpActiveConversationActivity(sessionId: string): void {
  if (current.taskId !== null || current.sessionId !== sessionId) return;
  current = { ...current, activityEpoch: current.activityEpoch + 1 };
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
