import { array, boolean, decimal, integer, nullableString, object, string, stringArray } from "../core/primitives";
import type { RelayStateMaintenanceApplyResult, RelayStateMaintenanceChange,
  RelayStateMaintenanceDecisionRequired, RelayStateMaintenanceRequest,
  RelayUndoPlan, RelayUndoPlanItem } from "../dtos/stateMaintenance";

/**
 * 解析原则与 parse 层现状一致：身份字段（request_id / session_id / source_message_id /
 * project_id / revision / 时间戳）形状不对必须显式失败；decision、status、change_kind、
 * change.status 等枚举开放扩展，不校验词表、保留原串；changes、decision_required、
 * questions 整列缺失是合法形状（该组还没有这份事实），按安全缺省处理。
 */

/** 逐条变更：before/after/error 载荷形状开放，缺失读成 null，不猜内容。 */
export function stateMaintenanceChangeFrom(value: unknown): RelayStateMaintenanceChange {
  const row = object(value, "state maintenance change");
  return { ordinal: integer(row, "ordinal", "state maintenance change"),
    changeKind: string(row, "change_kind", "state maintenance change"),
    commandId: string(row, "command_id", "state maintenance change"),
    status: string(row, "status", "state maintenance change"),
    beforeRef: row.before_ref === null || row.before_ref === undefined
      ? null : object(row.before_ref, "state maintenance change.before_ref"),
    afterRef: row.after_ref === null || row.after_ref === undefined
      ? null : object(row.after_ref, "state maintenance change.after_ref"),
    error: row.error === null || row.error === undefined
      ? null : object(row.error, "state maintenance change.error") };
}

/** changes 整列缺失读成 null；存在但形状不对才显式失败。 */
function stateMaintenanceChangesFrom(row: Record<string, unknown>,
  name: string): readonly RelayStateMaintenanceChange[] | null {
  if (row.changes === undefined || row.changes === null) return null;
  return array(row, "changes", name).map(stateMaintenanceChangeFrom);
}

function stateMaintenanceDecisionRequiredFrom(value: unknown): RelayStateMaintenanceDecisionRequired | null {
  if (value === undefined || value === null) return null;
  const row = object(value, "state maintenance decision_required");
  const blocked = row.blocked_changes;
  return { summary: string(row, "summary", "state maintenance decision_required"),
    question: string(row, "question", "state maintenance decision_required"),
    affected: row.affected === undefined
      ? [] : stringArray(row, "affected", "state maintenance decision_required"),
    blockedChanges: Array.isArray(blocked)
      ? blocked.filter((item): item is number => typeof item === "number") : null };
}

export function stateMaintenanceRequestFrom(value: unknown): RelayStateMaintenanceRequest {
  const row = object(value, "state maintenance request");
  return { requestId: string(row, "request_id", "state maintenance request"),
    sessionId: string(row, "session_id", "state maintenance request"),
    sourceMessageId: string(row, "source_message_id", "state maintenance request"),
    projectId: string(row, "project_id", "state maintenance request"),
    decision: string(row, "decision", "state maintenance request"),
    status: string(row, "status", "state maintenance request"),
    candidateStatus: row.candidate_status === undefined
      ? "PENDING" : string(row, "candidate_status", "state maintenance request"),
    questions: row.questions === undefined
      ? [] : stringArray(row, "questions", "state maintenance request"),
    changes: stateMaintenanceChangesFrom(row, "state maintenance request"),
    decisionRequired: stateMaintenanceDecisionRequiredFrom(row.decision_required),
    undoCommandId: string(row, "undo_command_id", "state maintenance request"),
    revision: decimal(row, "revision", "state maintenance request"),
    createdAt: string(row, "created_at", "state maintenance request"),
    updatedAt: string(row, "updated_at", "state maintenance request") };
}

export function stateMaintenanceApplyResultFrom(value: unknown): RelayStateMaintenanceApplyResult {
  const row = object(value, "state maintenance apply result");
  return { requestId: string(row, "request_id", "state maintenance apply result"),
    status: string(row, "status", "state maintenance apply result"),
    revision: decimal(row, "revision", "state maintenance apply result"),
    changes: stateMaintenanceChangesFrom(row, "state maintenance apply result"),
    undoCommandId: string(row, "undo_command_id", "state maintenance apply result") };
}

function undoPlanItemFrom(value: unknown): RelayUndoPlanItem {
  const row = object(value, "undo plan item");
  return { changeId: string(row, "change_id", "undo plan item"),
    ordinal: integer(row, "ordinal", "undo plan item"),
    changeKind: string(row, "change_kind", "undo plan item"),
    commandId: string(row, "command_id", "undo plan item"),
    withdrawable: boolean(row, "withdrawable", "undo plan item"),
    reasonCode: nullableString(row, "reason_code", "undo plan item"),
    reason: nullableString(row, "reason", "undo plan item"),
    impact: nullableString(row, "impact", "undo plan item") };
}

/** 撤回事前预检方案：plan_digest 与逐条可撤回性是确认范围的依据，缺任一都不猜。 */
export function undoPlanFrom(value: unknown): RelayUndoPlan {
  const row = object(value, "undo plan");
  return { requestId: string(row, "request_id", "undo plan"),
    undoCommandId: string(row, "undo_command_id", "undo plan"),
    planDigest: string(row, "plan_digest", "undo plan"),
    fullyWithdrawable: boolean(row, "fully_withdrawable", "undo plan"),
    blockedCount: integer(row, "blocked_count", "undo plan"),
    stateRevision: decimal(row, "state_revision", "undo plan"),
    items: array(row, "items", "undo plan").map(undoPlanItemFrom) };
}
