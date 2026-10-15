import { RelayHttp } from '../core/http';
import { array, decimal, integer, nullableString, object, string } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import { periodPlanItemFrom } from './personalPlanning';
import type { RelayScopeOption, RelayScopeOptionKind, RelayScopeSelection, RelayScopeSimulation, RelayScopeSimulationInput, RelayScopeSimulationResult } from '../dtos/scopeSimulations';

function optionKind(value: unknown): RelayScopeOptionKind {
  if (value !== 'ALL' && value !== 'SHRINK' && value !== 'DEFER') throw new Error('推演方案类型无法识别。');
  return value;
}
function strings(r: Record<string, unknown>, key: string) {
  return array(r, key, 'scope simulation').map((v) => { if (typeof v !== 'string') throw new Error('推演 ID 或原因无效。'); return v; });
}
function resultFrom(value: unknown): RelayScopeSimulationResult {
  const r = object(value, 'simulation result'); const status = string(r, 'status', 'simulation result');
  if (status !== 'PROPOSED' && status !== 'SELECTED') throw new Error('推演状态无法识别。');
  return { simulationId: string(r, 'simulation_id', 'simulation result'), sourcePlanId: string(r, 'source_plan_id', 'simulation result'),
    projectId: string(r, 'project_id', 'simulation result'), revision: decimal(r, 'revision', 'simulation result'), status,
    selectedOption: r.selected_option === null ? null : optionKind(r.selected_option), selectedPlanId: nullableString(r, 'selected_plan_id', 'simulation result') };
}
function optionFrom(value: unknown): RelayScopeOption {
  const r = object(value, 'scope option'); const ms = (key: string) => r[key] === null ? null : integer(r, key, 'scope option');
  return { kind: optionKind(r.kind), taskIds: strings(r, 'task_ids'), retainedPrerequisiteIds: strings(r, 'retained_prerequisite_ids'), excludedTaskIds: strings(r, 'excluded_task_ids'),
    requestedElapsedMs: ms('requested_elapsed_ms'), requestedHumanMs: ms('requested_human_ms'), plannedMs: integer(r, 'planned_ms', 'scope option'), capacityGapMs: ms('capacity_gap_ms'),
    unknownEstimateTaskIds: strings(r, 'unknown_estimate_task_ids'), unreliableTaskIds: strings(r, 'unreliable_task_ids'), feasibility: string(r, 'feasibility', 'scope option'),
    items: array(r, 'items', 'scope option').map(periodPlanItemFrom), consequences: array(r, 'consequences', 'scope option').map((v) => object(v, 'scope consequence')) };
}
function simulationFrom(value: unknown): RelayScopeSimulation {
  const r = object(value, 'scope simulation');
  if (r.execution_admission !== 'NOT_GRANTED' || r.permission_gaps !== 'CHECK_AT_EXECUTION' || r.material_gaps !== 'CHECK_AT_EXECUTION' || r.completion_date !== null) throw new Error('推演不能冒充执行授权或完成日期承诺。');
  const selected = r.selected_plan === null ? null : object(r.selected_plan, 'selected plan');
  return { ...resultFrom(r), baseline: object(r.baseline, 'simulation baseline'), options: array(r, 'options', 'scope simulation').map(optionFrom),
    createdAt: string(r, 'created_at', 'scope simulation'), selectionReason: nullableString(r, 'selection_reason', 'scope simulation'), staleReasons: strings(r, 'stale_reasons'),
    selectedPlan: selected === null ? null : { planId: string(selected, 'plan_id', 'selected plan'), revision: decimal(selected, 'revision', 'selected plan'),
      items: array(selected, 'items', 'selected plan').map(periodPlanItemFrom) }, executionAdmission: 'NOT_GRANTED', permissionGaps: 'CHECK_AT_EXECUTION', materialGaps: 'CHECK_AT_EXECUTION', completionDate: null };
}
export async function proposeScopeSimulation(http: RelayHttp, input: RelayScopeSimulationInput) {
  const e = commandEnvelopeFrom(await http.request(http.workspacePath(`/period-plans/${encodeURIComponent(input.planId)}/scope-simulations`), { method: 'POST', body: JSON.stringify({
    command_id: input.commandId, expected_revision: input.expectedRevision, keep_task_ids: input.keepTaskIds, defer_task_ids: input.deferTaskIds, unreliable_task_ids: input.unreliableTaskIds }) }, 200));
  const r = resultFrom(e.result);
  if (e.commandId !== input.commandId || r.sourcePlanId !== input.planId) throw new Error('推演回执与原命令/计划不匹配。');
  return r;
}
export async function selectScopeSimulation(http: RelayHttp, input: RelayScopeSelection) {
  const e = commandEnvelopeFrom(await http.request(http.workspacePath(`/scope-simulations/${encodeURIComponent(input.simulationId)}/selections`), { method: 'POST', body: JSON.stringify({
    command_id: input.commandId, expected_revision: input.expectedRevision, option: input.option, confirmed: input.confirmed, reason: input.reason }) }, 200));
  const r = resultFrom(e.result);
  if (e.commandId !== input.commandId || r.simulationId !== input.simulationId) throw new Error('方案选择回执与原命令/推演不匹配。');
  return r;
}
export async function getScopeSimulation(http: RelayHttp, id: string) {
  const r = simulationFrom(await http.request(http.workspacePath(`/scope-simulations/${encodeURIComponent(id)}`)));
  if (r.simulationId !== id) throw new Error('推演读回身份不匹配。');
  return r;
}
export async function getPlanScopeSimulations(http: RelayHttp, planId: string) {
  const r = object(await http.request(http.workspacePath(`/period-plans/${encodeURIComponent(planId)}/scope-simulations`)), 'simulation list');
  const items = array(r, 'items', 'simulation list').map(simulationFrom);
  if (r.source_plan_id !== planId || items.some((i) => i.sourcePlanId !== planId)) throw new Error('推演列表与原计划不匹配。');
  return { sourcePlanId: planId, items };
}
