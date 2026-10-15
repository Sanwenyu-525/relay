import { RelayHttp } from '../core/http';
import { array, boolean, decimal, nullableString, object, string, stringArray } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayAcceptanceComparison, RelayAcceptanceComparisonInput, RelayAcceptanceComparisons,
  RelayAcceptanceComparisonSample, RelayComparisonObservation } from '../dtos/taskAcceptanceComparisons';

function numberFrom(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`验收比较 ${key} 响应无效。`);
  return value;
}
function observationFrom(value: unknown): RelayComparisonObservation | null {
  if (value === null) return null;
  const row = object(value, 'comparison observation');
  const correctness = string(row, 'correctness_outcome', 'comparison observation');
  if ((correctness !== 'UNKNOWN' && correctness !== 'NO_ISSUE_REPORTED' && correctness !== 'ISSUE_REPORTED') ||
      row.source_kind !== 'USER_REPORTED') throw new Error('无法识别试用观察来源或正确性自述。');
  return { observationId: string(row, 'observation_id', 'comparison observation'),
    trialRevision: decimal(row, 'trial_revision', 'comparison observation'),
    preparationMs: row.preparation_ms === null ? null : decimal(row, 'preparation_ms', 'comparison observation'),
    totalAcceptanceMs: row.total_acceptance_ms === null ? null : decimal(row, 'total_acceptance_ms', 'comparison observation'),
    correctnessOutcome: correctness, sourceKind: 'USER_REPORTED', sourceNote: string(row, 'source_note', 'comparison observation'),
    sourceMessageId: row.source_message_id === undefined ? null : nullableString(row, 'source_message_id', 'comparison observation') };
}
function sampleFrom(value: unknown): RelayAcceptanceComparisonSample {
  const row = object(value, 'comparison sample');
  const status = string(row, 'status', 'comparison sample');
  const materialStatus = string(row, 'material_status', 'comparison sample');
  const assessment = string(row, 'assessment', 'comparison sample');
  if (status !== 'RUNNING' && status !== 'PAUSED' && status !== 'FINISHED') throw new Error('无法识别比较试用状态。');
  if (materialStatus !== 'CURRENT' && materialStatus !== 'INCOMPLETE' && materialStatus !== 'STALE') throw new Error('无法识别比较材料状态。');
  if (assessment !== 'IN_PROGRESS' && assessment !== 'INSUFFICIENT_DATA' && assessment !== 'STALE' &&
      assessment !== 'CORRECTNESS_ISSUE' && assessment !== 'TARGET_MET' && assessment !== 'TARGET_NOT_MET') throw new Error('无法识别比较数据状态。');
  const difference = nullableString(row, 'preparation_difference_ms', 'comparison sample');
  if (difference !== null && !/^-?[0-9]+$/.test(difference)) throw new Error('准备耗时差值格式无效。');
  return { trialId: string(row, 'trial_id', 'comparison sample'), taskId: string(row, 'task_id', 'comparison sample'),
    trialRevision: decimal(row, 'trial_revision', 'comparison sample'), sampleLabel: string(row, 'sample_label', 'comparison sample'),
    status, materialIds: stringArray(row, 'material_ids', 'comparison sample'),
    findingMs: row.finding_ms === null ? null : decimal(row, 'finding_ms', 'comparison sample'),
    observation: observationFrom(row.observation), materialStatus, assessment,
    findingReductionPercent: row.finding_reduction_percent === null ? null : numberFrom(row, 'finding_reduction_percent'),
    totalReductionPercent: row.total_reduction_percent === null ? null : numberFrom(row, 'total_reduction_percent'),
    preparationDifferenceMs: difference,
    findingTargetMet: row.finding_target_met === null ? null : boolean(row, 'finding_target_met', 'comparison sample'),
    overallTimeSaved: row.overall_time_saved === null ? null : boolean(row, 'overall_time_saved', 'comparison sample') };
}
function comparisonFrom(value: unknown): RelayAcceptanceComparison {
  const row = object(value, 'acceptance comparison');
  if (row.total_includes_preparation !== true || row.evidence_kind !== 'USER_REPORTED_SAMPLE') throw new Error('验收比较口径或来源不明确。');
  return { comparisonId: string(row, 'comparison_id', 'acceptance comparison'), projectId: string(row, 'project_id', 'acceptance comparison'),
    baselineTrialId: string(row, 'baseline_trial_id', 'acceptance comparison'), baselineTaskId: string(row, 'baseline_task_id', 'acceptance comparison'),
    baselineRevision: decimal(row, 'baseline_revision', 'acceptance comparison'), baselineCurrent: boolean(row, 'baseline_current', 'acceptance comparison'),
    baselineFindingMs: decimal(row, 'baseline_finding_ms', 'acceptance comparison'), baselineObservation: observationFrom(row.baseline_observation),
    targetReductionPercent: numberFrom(row, 'target_reduction_percent'), sampleScope: string(row, 'sample_scope', 'acceptance comparison'),
    frozenAt: string(row, 'frozen_at', 'acceptance comparison'), totalIncludesPreparation: true, evidenceKind: 'USER_REPORTED_SAMPLE',
    samples: array(row, 'samples', 'acceptance comparison').map(sampleFrom) };
}
const path = (http: RelayHttp, projectId: string) => http.workspacePath(`/projects/${encodeURIComponent(projectId)}/acceptance-comparisons`);
export async function freezeAcceptanceComparison(http: RelayHttp, input: RelayAcceptanceComparisonInput) {
  const envelope = commandEnvelopeFrom(await http.request(path(http, input.projectId), {
    method: 'POST', body: JSON.stringify({ command_id: input.commandId, baseline_trial_id: input.baselineTrialId,
      expected_baseline_revision: input.expectedBaselineRevision,
      target_reduction_percent: input.targetReductionPercent, sample_scope: input.sampleScope }) }, 200));
  const result = { comparisonId: string(envelope.result, 'comparison_id', 'comparison result'),
    projectId: string(envelope.result, 'project_id', 'comparison result') };
  if (envelope.commandId !== input.commandId || result.projectId !== input.projectId) throw new Error('比较回执与原命令、项目不匹配。');
  return result;
}
export async function getAcceptanceComparisons(http: RelayHttp, projectId: string): Promise<RelayAcceptanceComparisons> {
  const row = object(await http.request(path(http, projectId)), 'acceptance comparisons');
  const result = { projectId: string(row, 'project_id', 'acceptance comparisons'),
    items: array(row, 'items', 'acceptance comparisons').map(comparisonFrom) };
  if (result.projectId !== projectId || result.items.some((item) => item.projectId !== projectId)) throw new Error('比较读取结果与原项目不匹配。');
  return result;
}
