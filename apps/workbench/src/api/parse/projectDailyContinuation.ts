import { boolean, decimal, integer, isRecord, nullableString, object, string,
  stringArray } from "../core/primitives";
import type { RelayDailyContinuation, RelayDailyContinuationBaseline,
  RelayDailyContinuationCurrent, RelayDailyContinuationDelta,
  RelayReturnReview } from "../dtos/projectDailyContinuation";

/**
 * 解析原则与 parse 层现状一致：current 与身份字段（project_id / revision / 计数）形状不对
 * 必须显式失败——把它们读成缺省会让接续卡冒充「没有变化」；baseline 与 delta 整列缺失是
 * 合法形状（还没有基线 / 服务端未给出变化），按 null 处理，但存在时形状必须完整。
 * phase_key 等枚举值开放扩展，保留原串，中文化由展示层按 phaseLabel 回退处理。
 */

export function dailyContinuationCurrentFrom(value: unknown): RelayDailyContinuationCurrent {
  const row = object(value, "daily continuation current");
  return { stateRevision: decimal(row, "state_revision", "daily continuation current"),
    phaseKey: nullableString(row, "phase_key", "daily continuation current"),
    nextActionTaskId: nullableString(row, "next_action_task_id", "daily continuation current"),
    openTaskIds: stringArray(row, "open_task_ids", "daily continuation current"),
    openTaskCount: integer(row, "open_task_count", "daily continuation current"),
    openTaskIdsTruncated: boolean(row, "open_task_ids_truncated", "daily continuation current"),
    waitingTaskCount: integer(row, "waiting_task_count", "daily continuation current"),
    blockedTaskCount: integer(row, "blocked_task_count", "daily continuation current"),
    unresolvedBlockerCount: integer(row, "unresolved_blocker_count", "daily continuation current") };
}

export function dailyContinuationBaselineFrom(value: unknown): RelayDailyContinuationBaseline {
  const row = object(value, "daily continuation baseline");
  const viewedFactRefs = row.viewed_fact_refs;
  return { presentationId: string(row, "presentation_id", "daily continuation baseline"),
    viewedStateRevision: decimal(row, "viewed_state_revision", "daily continuation baseline"),
    viewedFactRefs: isRecord(viewedFactRefs) ? viewedFactRefs
      : object(viewedFactRefs, "daily continuation baseline.viewed_fact_refs"),
    viewedPresentationSeq: decimal(row, "viewed_presentation_seq",
      "daily continuation baseline"),
    confirmedAt: string(row, "confirmed_at", "daily continuation baseline") };
}

export function dailyContinuationDeltaFrom(value: unknown): RelayDailyContinuationDelta {
  const row = object(value, "daily continuation delta");
  return { phaseChanged: boolean(row, "phase_changed", "daily continuation delta"),
    phaseBefore: nullableString(row, "phase_before", "daily continuation delta"),
    phaseAfter: nullableString(row, "phase_after", "daily continuation delta"),
    nextActionChanged: boolean(row, "next_action_changed", "daily continuation delta"),
    nextActionBefore: nullableString(row, "next_action_before", "daily continuation delta"),
    nextActionAfter: nullableString(row, "next_action_after", "daily continuation delta"),
    newOpenTaskIds: stringArray(row, "new_open_task_ids", "daily continuation delta"),
    closedTaskIds: stringArray(row, "closed_task_ids", "daily continuation delta"),
    unresolvedBlockerCountChanged: boolean(row, "unresolved_blocker_count_changed",
      "daily continuation delta"),
    openTasksUnknown: boolean(row, "open_tasks_unknown", "daily continuation delta") };
}

export function dailyContinuationPresentationFrom(value: unknown):
  RelayDailyContinuation["presentation"] {
  const row = object(value, "daily continuation presentation");
  return { presentationId: string(row, "presentation_id", "daily continuation presentation"),
    presentationSeq: decimal(row, "presentation_seq", "daily continuation presentation") };
}

export function dailyContinuationFrom(value: unknown): RelayDailyContinuation {
  const row = object(value, "daily continuation");
  return { projectId: string(row, "project_id", "daily continuation"),
    current: dailyContinuationCurrentFrom(row.current),
    baseline: row.baseline === undefined || row.baseline === null
      ? null : dailyContinuationBaselineFrom(row.baseline),
    delta: row.delta === undefined || row.delta === null
      ? null : dailyContinuationDeltaFrom(row.delta),
    presentation: dailyContinuationPresentationFrom(row.presentation),
    revision: decimal(row, "revision", "daily continuation") };
}

/** 返回轻量核对记录：status 只接受服务端词表的两个结论，其余形状显式失败。 */
export function returnReviewFrom(value: unknown): RelayReturnReview {
  const row = object(value, "return review");
  const status = string(row, "status", "return review");
  if (status !== "APPLICABLE" && status !== "CHANGED") {
    throw new Error(`return review.status 不是可识别的核对结论：${status}`);
  }
  const dimensions = Array.isArray(row.changed_dimensions)
    ? row.changed_dimensions.filter((item): item is string => typeof item === "string")
    : [];
  const evidence = Array.isArray(row.evidence) ? row.evidence.map((item) => {
    const entry = object(item, "return review.evidence");
    return { taskId: string(entry, "task_id", "return review.evidence"),
      completionId: string(entry, "completion_id", "return review.evidence"),
      applicable: boolean(entry, "applicable", "return review.evidence") };
  }) : [];
  return { reviewId: string(row, "review_id", "return review"),
    projectId: string(row, "project_id", "return review"), status,
    fingerprint: string(row, "fingerprint", "return review"),
    reused: boolean(row, "reused", "return review"),
    changedDimensions: dimensions, evidence,
    createdAt: string(row, "created_at", "return review") };
}
