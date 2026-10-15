import { RelayHttp } from '../core/http';
import { array, decimal, integer, nullableString, object, string } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayWorkSegment, RelayWorkSegmentEvent, RelayWorkSegmentEventInput, RelayWorkSegmentEventResolution,
  RelayWorkSegmentMutation, RelayWorkSegmentResult, RelayWorkSegmentStart } from '../dtos/workSegments';

const nullable = (row: Record<string, unknown>, key: string) => row[key] === undefined ? null : nullableString(row, key, 'work segment');
function resultFrom(value: unknown): RelayWorkSegmentResult {
  const row = object(value, 'work segment result');
  const status = string(row, 'status', 'work segment result');
  if (status !== 'OPEN' && status !== 'FINISHED') throw new Error('无法识别工作段状态。');
  return { segmentId: string(row, 'segment_id', 'work segment result'), projectId: string(row, 'project_id', 'work segment result'),
    status, revision: decimal(row, 'revision', 'work segment result'), eventId: nullable(row, 'event_id'),
    eventRevision: row.event_revision === undefined ? null : decimal(row, 'event_revision', 'work segment result'), eventStatus: nullable(row, 'event_status') };
}
function eventFrom(value: unknown): RelayWorkSegmentEvent {
  const row = object(value, 'work segment event');
  const kind = string(row, 'kind', 'work segment event');
  const status = string(row, 'status', 'work segment event');
  if (kind !== 'REWORK' && kind !== 'HUMAN_INTERVENTION') throw new Error('无法识别工作段事件。');
  if (status !== 'CANDIDATE' && status !== 'CONFIRMED' && status !== 'WITHDRAWN') throw new Error('无法识别工作段事件确认状态。');
  if (row.source_kind !== 'USER_DECLARED') throw new Error('工作段事件缺少来源性质。');
  return { id: string(row, 'id', 'work segment event'), kind, status, taskId: nullable(row, 'task_id'), sourceRunId: nullable(row, 'source_run_id'),
    description: string(row, 'description', 'work segment event'), durationMs: row.duration_ms === null ? null : decimal(row, 'duration_ms', 'work segment event'),
    revision: decimal(row, 'revision', 'work segment event'), history: array(row, 'history', 'work segment event').map((v) => object(v, 'event history')),
    sourceKind: 'USER_DECLARED', createdAt: string(row, 'created_at', 'work segment event') };
}
function segmentFrom(value: unknown): RelayWorkSegment {
  const row = object(value, 'work segment');
  const kind = string(row, 'snapshot_kind', 'work segment');
  const stats = object(row.event_statistics, 'segment statistics');
  if (row.baseline_status !== 'RECORDED' || kind !== 'LIVE' && kind !== 'FINISHED' || stats.coverage !== 'CONFIRMED_RECORDS_ONLY') throw new Error('工作段预期或统计口径不明确。');
  return { ...resultFrom(row), title: string(row, 'title', 'work segment'), expectation: string(row, 'expectation', 'work segment'),
    baselineStatus: 'RECORDED', baseline: object(row.baseline, 'work segment baseline'), sourceMessageId: nullable(row, 'source_message_id'),
    startedAt: string(row, 'started_at', 'work segment'), finishedAt: nullable(row, 'finished_at'), snapshotKind: kind,
    actual: object(row.actual, 'work segment actual'), events: array(row, 'events', 'work segment').map(eventFrom),
    eventStatistics: { coverage: 'CONFIRMED_RECORDS_ONLY', reworkCount: integer(stats, 'rework_count', 'segment statistics'),
      interventionCount: integer(stats, 'intervention_count', 'segment statistics'), knownInterventionMs: nullable(stats, 'known_intervention_ms') } };
}
const path = (http: RelayHttp, id: string) => http.workspacePath(`/work-segments/${encodeURIComponent(id)}`);
async function submit(http: RelayHttp, url: string, commandId: string, body: Record<string, unknown>, segmentId?: string) {
  const envelope = commandEnvelopeFrom(await http.request(url, { method: 'POST', body: JSON.stringify({ command_id: commandId, ...body }) }, 200));
  const result = resultFrom(envelope.result);
  if (envelope.commandId !== commandId || segmentId !== undefined && result.segmentId !== segmentId) throw new Error('工作段回执与原命令/对象不匹配。');
  return result;
}
export async function startWorkSegment(http: RelayHttp, input: RelayWorkSegmentStart) {
  const result = await submit(http, http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/work-segments`), input.commandId,
    { title: input.title, expectation: input.expectation, confirmed: input.confirmed, tasks: input.tasks.map((t) => ({
      task_id: t.taskId, expected_revision: t.expectedRevision, expected_acceptance_revision: t.expectedAcceptanceRevision })) });
  if (result.projectId !== input.projectId) throw new Error('工作段建档回执与原项目不匹配。');
  return result;
}
export function finishWorkSegment(http: RelayHttp, input: RelayWorkSegmentMutation) {
  return submit(http, `${path(http, input.segmentId)}/finishes`, input.commandId, { expected_revision: input.expectedRevision }, input.segmentId);
}
export function proposeWorkSegmentEvent(http: RelayHttp, input: RelayWorkSegmentEventInput) {
  return submit(http, `${path(http, input.segmentId)}/events`, input.commandId, { expected_revision: input.expectedRevision,
    kind: input.kind, description: input.description, ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
    ...(input.sourceRunId === undefined ? {} : { source_run_id: input.sourceRunId }), ...(input.durationMs === undefined ? {} : { duration_ms: input.durationMs }) }, input.segmentId);
}
export function resolveWorkSegmentEvent(http: RelayHttp, input: RelayWorkSegmentEventResolution) {
  return submit(http, http.workspacePath(`/work-segment-events/${encodeURIComponent(input.eventId)}/resolutions`), input.commandId,
    { expected_revision: input.expectedRevision, action: input.action, reason: input.reason });
}
export async function getWorkSegment(http: RelayHttp, id: string) {
  const result = segmentFrom(await http.request(path(http, id)));
  if (result.segmentId !== id) throw new Error('工作段读回对象不匹配。');
  return result;
}
export async function getProjectWorkSegments(http: RelayHttp, projectId: string) {
  const row = object(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/work-segments`)), 'project work segments');
  const items = array(row, 'items', 'project work segments').map(segmentFrom);
  if (row.project_id !== projectId || items.some((s) => s.projectId !== projectId)) throw new Error('工作段列表项目不匹配。');
  return { projectId, items };
}
export async function getTemporaryRetrospective(http: RelayHttp, projectId: string, taskIds: readonly string[]) {
  const row = object(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/retrospectives`), {
    method: 'POST', body: JSON.stringify({ task_ids: taskIds }) }, 200), 'temporary retrospective');
  const status = string(row, 'baseline_status', 'temporary retrospective');
  if (row.project_id !== projectId || status !== 'UNKNOWN' && status !== 'RECORDED' && status !== 'PARTIAL' ||
      row.expectation !== null || row.model_usage !== null || row.work_time !== null) throw new Error('临时复盘不能补造历史预期或耗时。');
  return { projectId, baselineStatus: status, expectation: null, workTime: null, modelUsage: null,
    tasks: array(row, 'tasks', 'temporary retrospective').map((v) => object(v, 'retrospective task')) };
}
