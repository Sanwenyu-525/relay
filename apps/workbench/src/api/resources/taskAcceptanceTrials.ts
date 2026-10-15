import { RelayHttp } from '../core/http';
import { array, boolean, decimal, nullableString, object, string, stringArray } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayAcceptanceObservation, RelayAcceptanceObservationInput, RelayAcceptanceTrial,
  RelayAcceptanceTrialResult, RelayAcceptanceTrials, RelayAcceptanceTrialStart,
  RelayAcceptanceTrialTransition } from '../dtos/taskAcceptanceTrials';

function resultFrom(value: unknown): RelayAcceptanceTrialResult {
  const row = object(value, 'acceptance trial');
  const status = string(row, 'status', 'acceptance trial');
  if (status !== 'RUNNING' && status !== 'PAUSED' && status !== 'FINISHED') throw new Error('无法识别验收试用状态。');
  return { trialId: string(row, 'trial_id', 'acceptance trial'), taskId: string(row, 'task_id', 'acceptance trial'),
    status, revision: decimal(row, 'revision', 'acceptance trial') };
}
function observationFrom(value: unknown): RelayAcceptanceObservation {
  const row = object(value, 'acceptance observation');
  if (row.source_kind !== 'USER_REPORTED') throw new Error('无法识别耗时补录来源。');
  const correctness = row.correctness_outcome ?? 'UNKNOWN';
  if (correctness !== 'UNKNOWN' && correctness !== 'NO_ISSUE_REPORTED' && correctness !== 'ISSUE_REPORTED') {
    throw new Error('无法识别试用正确性自述。');
  }
  return { observationId: string(row, 'observation_id', 'acceptance observation'),
    trialRevision: decimal(row, 'trial_revision', 'acceptance observation'),
    preparationMs: row.preparation_ms === null ? null : decimal(row, 'preparation_ms', 'acceptance observation'),
    totalAcceptanceMs: row.total_acceptance_ms === null ? null : decimal(row, 'total_acceptance_ms', 'acceptance observation'),
    sourceNote: string(row, 'source_note', 'acceptance observation'), sourceKind: 'USER_REPORTED',
    createdAt: string(row, 'created_at', 'acceptance observation'), correctnessOutcome: correctness,
    sourceMessageId: row.source_message_id === undefined ? null : nullableString(row, 'source_message_id', 'acceptance observation') };
}
function trialFrom(value: unknown): RelayAcceptanceTrial {
  const row = object(value, 'acceptance trial');
  const mode = string(row, 'mode', 'acceptance trial');
  if (mode !== 'ORIGINAL' && mode !== 'EVIDENCE_VIEW') throw new Error('无法识别验收试用流程。');
  if (row.total_includes_preparation !== true) throw new Error('验收总耗时口径不明确。');
  return { ...resultFrom(row), mode, sampleLabel: string(row, 'sample_label', 'acceptance trial'),
    materialIds: stringArray(row, 'material_ids', 'acceptance trial'),
    acceptanceRevision: decimal(row, 'acceptance_revision', 'acceptance trial'),
    acceptanceMatches: boolean(row, 'acceptance_matches', 'acceptance trial'),
    startedAt: string(row, 'started_at', 'acceptance trial'), finishedAt: nullableString(row, 'finished_at', 'acceptance trial'),
    activeMs: decimal(row, 'active_ms', 'acceptance trial'), pausedMs: decimal(row, 'paused_ms', 'acceptance trial'),
    elapsedMs: decimal(row, 'elapsed_ms', 'acceptance trial'), totalIncludesPreparation: true,
    latestObservation: row.latest_observation === null ? null : observationFrom(row.latest_observation),
    observations: array(row, 'observations', 'acceptance trial').map(observationFrom),
    comparisonId: row.comparison_id === undefined ? null : nullableString(row, 'comparison_id', 'acceptance trial') };
}
const root = (http: RelayHttp, taskId: string) => http.workspacePath(`/tasks/${encodeURIComponent(taskId)}/acceptance-trials`);
async function submit(http: RelayHttp, url: string, commandId: string, taskId: string,
  body: Record<string, unknown>, trialId?: string) {
  const envelope = commandEnvelopeFrom(await http.request(url, {
    method: 'POST', body: JSON.stringify({ command_id: commandId, ...body }) }, 200));
  const result = resultFrom(envelope.result);
  if (envelope.commandId !== commandId || result.taskId !== taskId || (trialId !== undefined && result.trialId !== trialId)) {
    throw new Error('验收试用回执与原命令、对象不匹配。');
  }
  return result;
}
export function startTaskAcceptanceTrial(http: RelayHttp, input: RelayAcceptanceTrialStart) {
  return submit(http, root(http, input.taskId), input.commandId, input.taskId, {
    expected_acceptance_revision: input.expectedAcceptanceRevision, mode: input.mode,
    sample_label: input.sampleLabel, material_ids: input.materialIds ?? [],
    ...(input.comparisonId === undefined ? {} : { comparison_id: input.comparisonId }) });
}
export function transitionTaskAcceptanceTrial(http: RelayHttp, input: RelayAcceptanceTrialTransition) {
  return submit(http, `${root(http, input.taskId)}/${encodeURIComponent(input.trialId)}/transitions`,
    input.commandId, input.taskId, { expected_revision: input.expectedRevision, action: input.action }, input.trialId);
}
export function recordTaskAcceptanceObservation(http: RelayHttp, input: RelayAcceptanceObservationInput) {
  return submit(http, `${root(http, input.taskId)}/${encodeURIComponent(input.trialId)}/observations`,
    input.commandId, input.taskId, { expected_revision: input.expectedRevision,
      preparation_ms: input.preparationMs, total_acceptance_ms: input.totalAcceptanceMs,
      source_note: input.sourceNote,
      ...(input.correctnessOutcome === undefined ? {} : { correctness_outcome: input.correctnessOutcome }) }, input.trialId);
}
export async function getTaskAcceptanceTrials(http: RelayHttp, taskId: string): Promise<RelayAcceptanceTrials> {
  const row = object(await http.request(root(http, taskId)), 'acceptance trials');
  const result = { taskId: string(row, 'task_id', 'acceptance trials'),
    serverTime: string(row, 'server_time', 'acceptance trials'), items: array(row, 'items', 'acceptance trials').map(trialFrom) };
  if (result.taskId !== taskId || result.items.some((item) => item.taskId !== taskId)) throw new Error('验收试用读取结果与原任务不匹配。');
  return result;
}
