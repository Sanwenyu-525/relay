import type { RelayAssistSessionListState } from "../api/dtos/assist";

/**
 * 会话行状态图标的文案（2026-10-30）。
 *
 * 一份表同时喂两处：行按钮的 `aria-label`（读屏与键盘用户听到的那一句）和图标里的
 * 原生 `title`（鼠标悬停）。两处各写一套，迟早会出现「读屏说排队、悬停说未开始」。
 *
 * 措辞只描述服务端已经确认的事实，不替它加时间或原因：
 * - 在途说「正在生成 / 排队中」，不说「约需多久」；
 * - 终态说「上一轮」完成、失败或取消——这条会话本身仍在，不能读成整个对象完成；
 * - 待确认说「有一条提案等你确认」：`assist_proposals` 里那条 PENDING 行是这个产品里
 *   唯一会话级的「等人决定」事实，界面不把它升格成「审批通过/驳回」之外的判断；
 * - 未开始与归档是会话自身的状态，不掺执行结果。
 */
interface SessionStateCopy {
  /** 进 `aria-label` 的短句，前面带分隔点。 */
  readonly note: string;
  /** 图标的悬停提示，一句完整的话。 */
  readonly title: string;
}

const COPY: Readonly<Record<RelayAssistSessionListState, SessionStateCopy>> = {
  RUNNING: { note: " · 正在生成", title: "正在生成回复" },
  PENDING: { note: " · 排队中", title: "排队中，等待生成" },
  WAITING_APPROVAL: { note: " · 等待确认提案", title: "有一条提案等你确认" },
  COMPLETED: { note: " · 已完成", title: "上一轮回复已完成" },
  FAILED: { note: " · 生成失败", title: "上一轮生成失败" },
  CANCELLED: { note: " · 已取消", title: "上一轮已取消" },
  NOT_STARTED: { note: " · 未开始", title: "这条讨论还没有消息" },
  ARCHIVED: { note: " · 已归档", title: "这条讨论已归档" }
};

/** 没有可判定状态时返回空串：行标签里什么也不加，不编一个状态。 */
export function sessionStateNote(state: RelayAssistSessionListState | null): string {
  return state === null ? "" : COPY[state].note;
}

/** 没有可判定状态时返回 null：图标不该有悬停提示，因为它没有在陈述任何状态。 */
export function sessionStateTitle(state: RelayAssistSessionListState | null): string | null {
  return state === null ? null : COPY[state].title;
}
