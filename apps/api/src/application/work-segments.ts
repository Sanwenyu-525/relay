import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCallRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { WorkSegmentEventRow, WorkSegmentRow } from '../work-segment/work-segment-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

export interface WorkSegmentTaskInput { taskId: string; expectedRevision: string; expectedAcceptanceRevision: string }
interface BaselineTask { task_id: string; title: string; status: string; revision: string; acceptance_revision: string;
  current_completion_id: string | null; acceptance: JsonObject }
type Scope = { workspaceId: string; commandId: string };
type Mutation = Scope & { segmentId: string; expectedRevision: string };
const tasksOf = (row: WorkSegmentRow) => row.baseline.tasks as unknown as BaselineTask[];
const result = (row: WorkSegmentRow) => ({ segment_id: row.id, project_id: row.project_id, status: row.status, revision: row.revision.toString() });
function text(value: string, field: string, max = 4000) {
  if (!value.trim() || value.length > max) throw validationFailed([{ field, message: `需要 1–${max} 字。` }]);
  return value.trim();
}
async function authority(r: Repositories, workspaceId: string, projectId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}
async function locked(r: Repositories, input: Mutation) {
  const located = await r.workSegments.read(input.segmentId);
  if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('WorkSegment');
  await authority(r, input.workspaceId, located.project_id);
  const row = (await r.workSegments.read(located.id, true))!;
  if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({
    entityType: 'WORK_SEGMENT', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
  return row;
}
async function audit(r: Repositories, input: Scope, row: WorkSegmentRow, type: string, extra: JsonObject = {}) {
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
    projectId: row.project_id, taskId: null, eventType: type, factRefs: { segment_id: row.id, ...extra } });
}
export async function startWorkSegment(db: DbExecutor, input: Scope & {
  projectId: string; confirmed: true; title: string; expectation: string; tasks: readonly WorkSegmentTaskInput[]; sourceMessageId?: string;
}) {
  const title = text(input.title, 'title', 200);
  const expectation = text(input.expectation, 'expectation');
  if (input.confirmed !== true || input.tasks.length < 1 || input.tasks.length > 64 ||
      new Set(input.tasks.map((t) => t.taskId)).size !== input.tasks.length) throw validationFailed([{ field: 'tasks', message: '需要确认 1–64 个不同的既有任务。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'StartWorkSegment', target: { project_id: input.projectId }, body: { title, expectation,
      confirmed: input.confirmed, tasks: input.tasks.map((t) => ({ task_id: t.taskId, expected_revision: t.expectedRevision,
        expected_acceptance_revision: t.expectedAcceptanceRevision })),
      ...(input.sourceMessageId === undefined ? {} : { source_message_id: input.sourceMessageId }) }, execute: async (r) => {
      await authority(r, input.workspaceId, input.projectId);
      if (input.sourceMessageId !== undefined) {
        const m = await r.assist.readMessage(input.sourceMessageId);
        const s = m === undefined ? undefined : await r.assist.readSession(m.session_id);
        if (m?.role !== 'USER' || m.status !== 'COMPLETED' || s?.workspace_id !== input.workspaceId ||
            s.project_id !== input.projectId || s.conversation_mode !== 'AGENT') throw invalidTransition('预期来源需要同项目普通会话的原用户消息。');
      }
      const tasks = [];
      const goals = (await r.projects.listProjectGoalLinks(input.projectId)).map((g) => ({
        goal_id: g.goal_id, title: g.goal_title, status: g.goal_status, revision: g.goal_revision.toString() }));
      for (const selected of input.tasks) {
        const task = await r.tasks.readTaskForShare(selected.taskId);
        if (task?.workspace_id !== input.workspaceId || task.project_id !== input.projectId) throw resourceNotFound('Task');
        for (const [field, expected, actual] of [['expected_revision', selected.expectedRevision, task.revision],
          ['expected_acceptance_revision', selected.expectedAcceptanceRevision, task.acceptance_revision]] as const) {
          if (requireRevision(expected, field) !== actual) throw revisionConflict({ entityType: 'WORK_SEGMENT_TASK', expectedRevision: expected, actualRevision: actual.toString() });
        }
        const acceptance = (await r.tasks.readAcceptanceVersion(task.id, task.acceptance_revision))!;
        const criteria = await r.tasks.listCriteria(task.id, task.acceptance_revision);
        tasks.push({ task_id: task.id, title: task.title, status: task.status, revision: task.revision.toString(),
          acceptance_revision: task.acceptance_revision.toString(), current_completion_id: task.current_completion_id,
          goal_alignment_mode: task.goal_alignment_mode, explicit_goal_ids: (await r.tasks.listExplicitGoals(task.id)).map((g) => g.goal_id),
          acceptance: { objective: acceptance.objective, expected_outputs: acceptance.required_output_spec,
            criteria: criteria.map((c) => ({ criterion_id: c.criterion_id, statement: c.statement, required: c.required, method: c.method, target_spec: c.target_spec })) } });
      }
      const row = await r.workSegments.insert({ id: randomUUID(), workspace_id: input.workspaceId, project_id: input.projectId,
        title, expectation, baseline: { tasks, project_goals: goals }, source_message_id: input.sourceMessageId ?? null, started_at: await r.workSegments.now() });
      await audit(r, input, row, 'WORK_SEGMENT_STARTED');
      return result(row);
    } });
}
export function recordedModelUsage(rows: readonly ModelCallRow[]) {
  const summarize = (key: 'usage_input_tokens' | 'usage_output_tokens' | 'usage_cache_read_tokens' | 'usage_cache_creation_tokens') => {
    const known = rows.filter((r) => r[key] !== null);
    const sum = known.reduce((total, row) => total + BigInt(row[key]!), 0n).toString();
    return { known_tokens: known.length === 0 ? null : sum,
      total_tokens: rows.length > 0 && known.length === rows.length ? sum : null, missing_calls: rows.length - known.length };
  };
  return { coverage: 'RECORDED_TASK_SCOPED_CALLS_ONLY', recorded_call_count: rows.length,
    input: summarize('usage_input_tokens'), output: summarize('usage_output_tokens'),
    cache_read: summarize('usage_cache_read_tokens'), cache_creation: summarize('usage_cache_creation_tokens'), monetary_cost: null,
    calls: rows.map((c) => ({ id: c.id, kind: c.kind, provider: c.provider, model: c.model, status: c.status,
      input_tokens: c.usage_input_tokens, output_tokens: c.usage_output_tokens,
      started_at: c.started_at.toISOString(), settled_at: c.settled_at?.toISOString() ?? null })) };
}
async function actualSnapshot(r: Repositories, row: WorkSegmentRow, to: Date): Promise<JsonObject> {
  const tasks = [];
  const blockers = await r.projects.listProjectBlockers(row.project_id);
  for (const baseline of tasksOf(row)) {
    const task = await r.tasks.readTaskForShare(baseline.task_id);
    if (task?.workspace_id !== row.workspace_id || task.project_id !== row.project_id) {
      tasks.push({ task_id: baseline.task_id, outcome: 'UNAVAILABLE', completion_id: null });
      continue;
    }
    const completion = task.current_completion_id === null ? undefined : await r.completions.readCompletionRecord(task.current_completion_id);
    const baselineMatches = task.acceptance_revision.toString() === baseline.acceptance_revision;
    const accepted = baselineMatches && task.status === 'DONE' && completion?.acceptance_revision === task.acceptance_revision &&
      completion.id !== baseline.current_completion_id && completion.committed_at >= row.started_at && completion.committed_at <= to;
    const outcome = !baselineMatches ? 'BASELINE_CHANGED' : accepted ? 'ACCEPTED_OUTPUT' :
      task.status !== 'DONE' ? 'NOT_ACCEPTED' : completion?.id === baseline.current_completion_id ? 'ALREADY_ACCEPTED_BEFORE_SEGMENT' :
      completion === undefined ? 'MISSING_COMPLETION_BASIS' : 'OUTSIDE_SEGMENT';
    tasks.push({ task_id: task.id, title: task.title, task_status: task.status, task_revision: task.revision.toString(),
      acceptance_revision: task.acceptance_revision.toString(), baseline_matches: baselineMatches, outcome,
      executor_kind: task.executor_kind, executor_run_id: task.executor_run_id,
      open_blockers: blockers.filter((b) => b.resolved_at === null && (b.target_kind === 'PROJECT' || b.target_kind === 'TASK' && b.target_id === task.id))
        .map((b) => ({ id: b.id, reason: b.reason })),
      completion_id: completion?.id ?? null, completion_committed_at: completion?.committed_at.toISOString() ?? null,
      artifact_version_ids: accepted && Array.isArray(completion?.state_delta.artifact_version_ids) ? completion.state_delta.artifact_version_ids : [],
      verification_scope: 'COMPLETION_RECORD_ONLY' });
  }
  const calls = await r.workSegments.modelCalls(row.workspace_id, tasksOf(row).map((t) => t.task_id), row.started_at, to);
  return { captured_at: to.toISOString(), tasks, accepted_output_count: tasks.filter((t) => t.outcome === 'ACCEPTED_OUTPUT').length,
    model_usage: recordedModelUsage(calls), elapsed_ms: Math.max(0, to.getTime() - row.started_at.getTime()).toString(), human_work_ms: null };
}
export async function finishWorkSegment(db: DbExecutor, input: Mutation) {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'FinishWorkSegment', target: { segment_id: input.segmentId }, body: { expected_revision: input.expectedRevision }, execute: async (r) => {
      const row = await locked(r, input);
      if (row.status !== 'OPEN') throw invalidTransition('工作段已经结束。');
      const now = await r.workSegments.now();
      const updated = await r.workSegments.finish(row.id, now, await actualSnapshot(r, row, now));
      await audit(r, input, updated, 'WORK_SEGMENT_FINISHED');
      return result(updated);
    } });
}
export async function proposeWorkSegmentEvent(db: DbExecutor, input: Mutation & {
  kind: WorkSegmentEventRow['kind']; description: string; taskId?: string; sourceRunId?: string; durationMs?: number;
}) {
  const description = text(input.description, 'description');
  if (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)) throw validationFailed([{ field: 'duration_ms', message: '耗时使用非负整数毫秒。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ProposeWorkSegmentEvent', target: { segment_id: input.segmentId }, body: {
      expected_revision: input.expectedRevision, kind: input.kind, description, task_id: input.taskId ?? null,
      source_run_id: input.sourceRunId ?? null, duration_ms: input.durationMs ?? null }, execute: async (r) => {
      const row = await locked(r, input);
      const ids = tasksOf(row).map((t) => t.task_id);
      if (input.taskId !== undefined && !ids.includes(input.taskId)) throw resourceNotFound('Selected Task');
      if (input.sourceRunId !== undefined) {
        const run = await r.runs.readRun(input.sourceRunId);
        if (run?.workspace_id !== input.workspaceId || !ids.includes(run.task_id) ||
            input.taskId !== undefined && run.task_id !== input.taskId) throw resourceNotFound('Selected Run');
      }
      const event = await r.workSegments.insertEvent({ id: randomUUID(), segment_id: row.id, kind: input.kind, description,
        task_id: input.taskId ?? null, source_run_id: input.sourceRunId ?? null, duration_ms: input.durationMs === undefined ? null : BigInt(input.durationMs) });
      const updated = await r.workSegments.advance(row.id);
      await audit(r, input, updated, 'WORK_SEGMENT_EVENT_PROPOSED', { event_id: event.id });
      return { ...result(updated), event_id: event.id, event_revision: event.revision.toString(), event_status: event.status };
    } });
}
export async function resolveWorkSegmentEvent(db: DbExecutor, input: Scope & {
  eventId: string; expectedRevision: string; action: 'CONFIRM' | 'WITHDRAW'; reason: string;
}) {
  const reason = text(input.reason, 'reason');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ResolveWorkSegmentEvent', target: { event_id: input.eventId }, body: { expected_revision: input.expectedRevision, action: input.action, reason }, execute: async (r) => {
      const located = await r.workSegments.readEvent(input.eventId);
      const segment = located === undefined ? undefined : await r.workSegments.read(located.segment_id);
      if (segment?.workspace_id !== input.workspaceId) throw resourceNotFound('WorkSegmentEvent');
      await authority(r, input.workspaceId, segment.project_id);
      const row = (await r.workSegments.read(segment.id, true))!;
      const event = (await r.workSegments.readEvent(input.eventId, true))!;
      if (event.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({
        entityType: 'WORK_SEGMENT_EVENT', expectedRevision: input.expectedRevision, actualRevision: event.revision.toString() });
      if (event.status === 'WITHDRAWN' || input.action === 'CONFIRM' && event.status !== 'CANDIDATE') throw invalidTransition('当前事件状态不支持该处理。');
      const now = await r.workSegments.now();
      const updated = await r.workSegments.resolveEvent(event.id, input.action === 'CONFIRM' ? 'CONFIRMED' : 'WITHDRAWN',
        { command_id: input.commandId, action: input.action, reason, at: now.toISOString() });
      const advanced = await r.workSegments.advance(row.id);
      await audit(r, input, advanced, 'WORK_SEGMENT_EVENT_RESOLVED', { event_id: event.id, status: updated.status });
      return { ...result(advanced), event_id: event.id, event_revision: updated.revision.toString(), event_status: updated.status };
    } });
}
async function projection(r: Repositories, row: WorkSegmentRow) {
  const events = await r.workSegments.events(row.id);
  const confirmed = events.filter((e) => e.status === 'CONFIRMED');
  const knownDurations = confirmed.filter((e) => e.kind === 'HUMAN_INTERVENTION' && e.duration_ms !== null);
  return { ...result(row), title: row.title, expectation: row.expectation, baseline_status: 'RECORDED', baseline: row.baseline,
    source_message_id: row.source_message_id, started_at: row.started_at.toISOString(), finished_at: row.finished_at?.toISOString() ?? null,
    snapshot_kind: row.status === 'FINISHED' ? 'FINISHED' : 'LIVE', actual: row.result_snapshot ?? await actualSnapshot(r, row, await r.workSegments.now()),
    events: events.map((e) => ({ ...e, duration_ms: e.duration_ms?.toString() ?? null, revision: e.revision.toString(), created_at: e.created_at.toISOString(), source_kind: 'USER_DECLARED' })),
    event_statistics: { coverage: 'CONFIRMED_RECORDS_ONLY', rework_count: confirmed.filter((e) => e.kind === 'REWORK').length,
      intervention_count: confirmed.filter((e) => e.kind === 'HUMAN_INTERVENTION').length,
      known_intervention_ms: knownDurations.length === 0 ? null : knownDurations.reduce((total, e) => total + e.duration_ms!, 0n).toString() } };
}
export async function readWorkSegment(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.workSegments.read(id);
    if (row?.workspace_id !== workspaceId) throw resourceNotFound('WorkSegment');
    return projection(r, row);
  });
}
export async function listWorkSegments(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await readProjectInWorkspace(r, workspaceId, projectId);
    const items = [];
    for (const row of await r.workSegments.list(workspaceId, projectId)) items.push(await projection(r, row));
    return { project_id: projectId, items };
  });
}
export async function temporaryRetrospective(db: DbExecutor, workspaceId: string, projectId: string, ids: readonly string[]) {
  return withTransaction(db, async (r) => {
    await readProjectInWorkspace(r, workspaceId, projectId);
    const tasks = [];
    const history = await r.workSegments.list(workspaceId, projectId);
    for (const id of ids) {
      const task = await r.tasks.readTaskForShare(id);
      if (task?.workspace_id !== workspaceId || task.project_id !== projectId) throw resourceNotFound('Task');
      const segment = history.find((s) => tasksOf(s).some((b) => b.task_id === task.id && b.acceptance_revision === task.acceptance_revision.toString()));
      const baseline = segment === undefined ? null : tasksOf(segment).find((b) => b.task_id === task.id)!;
      tasks.push({ task_id: task.id, title: task.title, status: task.status, acceptance_revision: task.acceptance_revision.toString(),
        current_completion_id: task.current_completion_id, baseline_status: segment === undefined ? 'UNKNOWN' : 'RECORDED',
        expectation: segment?.expectation ?? null, segment_id: segment?.id ?? null, baseline });
    }
    const known = tasks.filter((t) => t.baseline_status === 'RECORDED').length;
    return { project_id: projectId, baseline_status: known === 0 ? 'UNKNOWN' : known === tasks.length ? 'RECORDED' : 'PARTIAL',
      baseline_selection: 'LATEST_REGISTERED_SAME_ACCEPTANCE', expectation: null, work_time: null, model_usage: null, tasks };
  });
}
