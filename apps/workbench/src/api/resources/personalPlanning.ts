import { RelayHttp } from '../core/http';
import { array, boolean, decimal, integer, nullableString, object, string } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayPeriodPlan, RelayPeriodPlanInput, RelayPeriodPlanItem, RelayPeriodPlanResolution, RelayPeriodPlanResult, RelayTimeEstimate, RelayTimeEstimateInput } from '../dtos/personalPlanning';

const optional = (r: Record<string, unknown>, k: string) => r[k] === undefined ? null : nullableString(r, k, 'planning');
function resultFrom(value: unknown): RelayPeriodPlanResult {
  const r = object(value, 'plan result');
  return { planId: string(r, 'plan_id', 'plan result'), projectId: string(r, 'project_id', 'plan result'), revision: decimal(r, 'revision', 'plan result'),
    itemId: optional(r, 'item_id'), itemStatus: optional(r, 'item_status'), createdTaskId: optional(r, 'created_task_id') };
}
function estimateFrom(value: unknown): RelayTimeEstimate {
  const r = object(value, 'time estimate');
  if (r.source_kind !== 'USER_DECLARED') throw new Error('估时缺少用户声明来源。');
  const ms = (k: string) => r[k] === null ? null : decimal(r, k, 'time estimate');
  return { id: string(r, 'id', 'time estimate'), taskId: string(r, 'task_id', 'time estimate'), revision: decimal(r, 'revision', 'time estimate'),
    acceptanceRevision: decimal(r, 'acceptance_revision', 'time estimate'), elapsedMs: ms('elapsed_ms'), executionMs: ms('execution_ms'),
    waitingMs: ms('waiting_ms'), reviewMs: ms('review_ms'), humanMs: ms('human_ms'), sourceNote: string(r, 'source_note', 'time estimate'),
    sourceKind: 'USER_DECLARED', createdAt: string(r, 'created_at', 'time estimate') };
}
export function periodPlanItemFrom(value: unknown): RelayPeriodPlanItem {
  const r = object(value, 'plan item');
  const kind = string(r, 'kind', 'plan item'); const status = string(r, 'status', 'plan item');
  if (!['TASK', 'DIAGNOSTIC', 'DEFERRED'].includes(kind) || !['CANDIDATE', 'ACCEPTED', 'REJECTED'].includes(status)) throw new Error('计划项类型或状态无法识别。');
  return { id: string(r, 'id', 'plan item'), taskId: string(r, 'task_id', 'plan item'), title: string(r, 'title', 'plan item'),
    kind: kind as RelayPeriodPlanItem['kind'], status: status as RelayPeriodPlanItem['status'], reason: string(r, 'reason', 'plan item'),
    budgetMs: r.budget_ms === null ? null : integer(r, 'budget_ms', 'plan item'), humanMs: r.human_ms === null ? null : integer(r, 'human_ms', 'plan item'),
    dependsOnTaskIds: array(r, 'depends_on_task_ids', 'plan item').map((v) => { if (typeof v !== 'string') throw new Error('前置任务 ID 无效。'); return v; }),
    createdTaskId: optional(r, 'created_task_id'), resolutionReason: optional(r, 'resolution_reason'), output: optional(r, 'output') };
}
function planFrom(value: unknown): RelayPeriodPlan {
  const r = object(value, 'period plan');
  const timeWarning = nullableString(r, 'time_warning', 'period plan');
  if (timeWarning !== null && timeWarning !== 'ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW') throw new Error('计划时间提示无法识别。');
  if (r.execution_admission !== 'NOT_GRANTED' || r.permission_gaps !== 'CHECK_AT_EXECUTION' || r.human_intervention !== 'SEE_BLOCKERS_AND_TASK_ACCEPTANCE') throw new Error('计划准入性质不明确。');
  return { ...resultFrom(r), title: string(r, 'title', 'period plan'), availableMs: decimal(r, 'available_ms', 'period plan'),
    startedAt: string(r, 'started_at', 'period plan'), endsAt: string(r, 'ends_at', 'period plan'), remainingMs: decimal(r, 'remaining_ms', 'period plan'), expired: boolean(r, 'expired', 'period plan'),
    staleReasons: array(r, 'stale_reasons', 'period plan').map((v) => { if (typeof v !== 'string') throw new Error('计划失效原因无效。'); return v; }),
    timeWarning, baseline: object(r.baseline, 'plan baseline'), items: array(r, 'items', 'period plan').map(periodPlanItemFrom),
    executionAdmission: 'NOT_GRANTED', permissionGaps: 'CHECK_AT_EXECUTION', humanIntervention: 'SEE_BLOCKERS_AND_TASK_ACCEPTANCE' };
}
export async function recordTaskTimeEstimate(http: RelayHttp, input: RelayTimeEstimateInput) {
  const e = commandEnvelopeFrom(await http.request(http.workspacePath(`/tasks/${encodeURIComponent(input.taskId)}/time-estimates`), { method: 'POST', body: JSON.stringify({
    command_id: input.commandId, confirmed: input.confirmed, expected_task_revision: input.expectedTaskRevision, expected_estimate_revision: input.expectedEstimateRevision,
    elapsed_ms: input.elapsedMs, execution_ms: input.executionMs, waiting_ms: input.waitingMs, review_ms: input.reviewMs, human_ms: input.humanMs, source_note: input.sourceNote }) }, 200));
  const r = object(e.result, 'estimate result');
  if (e.commandId !== input.commandId || r.task_id !== input.taskId) throw new Error('估时回执与原命令不匹配。');
  return { taskId: input.taskId, estimateId: string(r, 'estimate_id', 'estimate result'), revision: decimal(r, 'revision', 'estimate result') };
}
export async function getTaskTimeEstimates(http: RelayHttp, id: string) {
  const r = object(await http.request(http.workspacePath(`/tasks/${encodeURIComponent(id)}/time-estimates`)), 'estimates');
  const items = array(r, 'items', 'estimates').map(estimateFrom);
  if (r.task_id !== id || items.some((i) => i.taskId !== id)) throw new Error('估时列表任务不匹配。');
  const current = r.current === null ? null : { ...estimateFrom(r.current), applicable: boolean(object(r.current, 'current estimate'), 'applicable', 'current estimate') };
  return { taskId: id, current, items };
}
export async function proposePeriodPlan(http: RelayHttp, input: RelayPeriodPlanInput) {
  const e = commandEnvelopeFrom(await http.request(http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/period-plans`), { method: 'POST', body: JSON.stringify({
    command_id: input.commandId, title: input.title, available_ms: input.availableMs, diagnostic_ms: input.diagnosticMs,
    task_ids: input.taskIds, mainline_task_ids: input.mainlineTaskIds, goal_ids: input.goalIds }) }, 200));
  const r = resultFrom(e.result);
  if (e.commandId !== input.commandId || r.projectId !== input.projectId) throw new Error('计划回执与原项目不匹配。');
  return r;
}
export async function resolvePeriodPlanItem(http: RelayHttp, input: RelayPeriodPlanResolution) {
  const e = commandEnvelopeFrom(await http.request(http.workspacePath(`/period-plans/${encodeURIComponent(input.planId)}/items/${encodeURIComponent(input.itemId)}/resolutions`), { method: 'POST', body: JSON.stringify({
    command_id: input.commandId, expected_revision: input.expectedRevision, action: input.action, reason: input.reason }) }, 200));
  const r = resultFrom(e.result);
  if (e.commandId !== input.commandId || r.planId !== input.planId || r.itemId !== input.itemId) throw new Error('计划应用回执与原对象不匹配。');
  return r;
}
export async function getPeriodPlan(http: RelayHttp, id: string) {
  const r = planFrom(await http.request(http.workspacePath(`/period-plans/${encodeURIComponent(id)}`)));
  if (r.planId !== id) throw new Error('计划读回对象不匹配。');
  return r;
}
export async function getProjectPeriodPlans(http: RelayHttp, projectId: string) {
  const r = object(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/period-plans`)), 'plans');
  const items = array(r, 'items', 'plans').map(planFrom);
  if (r.project_id !== projectId || items.some((p) => p.projectId !== projectId)) throw new Error('计划列表项目不匹配。');
  return { projectId, items };
}
