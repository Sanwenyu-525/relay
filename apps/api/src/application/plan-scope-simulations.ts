import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { PeriodPlanRow, ScopeSimulationRow } from '../planning/personal-planning-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace } from './guards.js';
import { applyPeriodPlanCandidate, buildPlanningItems, estimateView, periodPlanStaleReasons, type PlanningItem, type PlanningTask } from './personal-planning.js';
import { requireRevision } from './revisions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

type Scope = { workspaceId: string; commandId: string };
export type ScopeOptionKind = 'ALL' | 'SHRINK' | 'DEFER';
export interface ScopeOption extends JsonObject {
  kind: ScopeOptionKind; task_ids: string[]; retained_prerequisite_ids: string[]; excluded_task_ids: string[];
  requested_elapsed_ms: number | null; requested_human_ms: number | null; planned_ms: number;
  capacity_gap_ms: number | null; unknown_estimate_task_ids: string[]; unreliable_task_ids: string[];
  feasibility: string; items: PlanningItem[]; consequences: JsonObject[];
}
/** 三种范围共用原计划的串行容量算法；缩小任务集不改变任何 Task 的验收条件。 */
export function buildScopeOptions(tasks: readonly PlanningTask[], availableMs: number, diagnosticMs: number,
  keepIds: readonly string[], deferIds: readonly string[], unreliableIds: readonly string[]): ScopeOption[] {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const kept = new Set(keepIds);
  const retainPrerequisites = (id: string) => { for (const dep of byId.get(id)?.dependencies ?? []) if (!kept.has(dep)) { kept.add(dep); retainPrerequisites(dep); } };
  keepIds.forEach(retainPrerequisites);
  const deferred = new Set(deferIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) if (!deferred.has(t.task_id) && t.dependencies.some((id) => deferred.has(id))) { deferred.add(t.task_id); changed = true; }
  }
  return (['ALL', 'SHRINK', 'DEFER'] as const).map((kind) => {
    const requested = tasks.filter((t) => kind === 'ALL' || (kind === 'SHRINK' ? kept.has(t.task_id) : !deferred.has(t.task_id)))
      .map((t) => unreliableIds.includes(t.task_id) ? { ...t, elapsed_ms: null, human_ms: null } : t);
    const removed = tasks.filter((t) => !requested.some((r) => r.task_id === t.task_id));
    const planned = buildPlanningItems(requested, availableMs, diagnosticMs);
    const unknown = requested.filter((t) => t.elapsed_ms === null).map((t) => t.task_id);
    const elapsed = unknown.length ? null : requested.reduce((sum, t) => sum + t.elapsed_ms!, 0);
    const human = requested.some((t) => t.human_ms === null) ? null : requested.reduce((sum, t) => sum + t.human_ms!, 0);
    const exclusions: PlanningItem[] = removed.map((t) => ({ id: randomUUID(), task_id: t.task_id, title: t.title, kind: 'DEFERRED',
      reason: kind === 'SHRINK' ? 'SCOPE_EXCLUDED' : deferIds.includes(t.task_id) ? 'DEFERRED_BY_USER' : 'DEFERRED_WITH_DEPENDENT',
      budget_ms: null, human_ms: null, depends_on_task_ids: t.dependencies, status: 'CANDIDATE', created_task_id: null, resolution_reason: null, output: null }));
    return { kind, task_ids: requested.map((t) => t.task_id), retained_prerequisite_ids: kind === 'SHRINK' ? [...kept].filter((id) => !keepIds.includes(id)) : [],
      excluded_task_ids: removed.map((t) => t.task_id), requested_elapsed_ms: elapsed, requested_human_ms: human,
      planned_ms: planned.filter((i) => i.kind !== 'DEFERRED').reduce((sum, i) => sum + (i.budget_ms ?? 0), 0),
      capacity_gap_ms: elapsed === null ? null : Math.max(0, elapsed - availableMs), unknown_estimate_task_ids: unknown,
      unreliable_task_ids: requested.filter((t) => unreliableIds.includes(t.task_id)).map((t) => t.task_id),
      feasibility: requested.length === 0 ? 'NO_WORK_SELECTED' : unknown.length ? 'UNKNOWN' : elapsed! > availableMs ? 'EXCEEDS_CAPACITY' :
        planned.some((i) => i.kind === 'DEFERRED') ? 'HAS_BLOCKERS' : 'FITS_ESTIMATE', items: [...planned, ...exclusions],
      consequences: removed.map((t) => ({ task_id: t.task_id, title: t.title, mainline: t.critical,
        impact: kind === 'SHRINK' ? 'OUT_OF_THIS_SCOPE' : 'NEXT_WINDOW_UNSCHEDULED',
        reason: exclusions.find((i) => i.task_id === t.task_id)!.reason,
        affected_dependent_task_ids: tasks.filter((r) => r.dependencies.includes(t.task_id)).map((r) => r.task_id) })) };
  });
}
const summary = (row: ScopeSimulationRow) => ({ simulation_id: row.id, source_plan_id: row.source_plan_id, project_id: row.project_id,
  revision: row.revision.toString(), status: row.status, selected_option: row.selected_option, selected_plan_id: row.selected_plan_id });
async function authority(r: Repositories, workspaceId: string, projectId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}
async function audit(r: Repositories, input: Scope, row: ScopeSimulationRow, eventType: string) {
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
    commandId: input.commandId, projectId: row.project_id, taskId: null, eventType, factRefs: summary(row) });
}
async function sourceProblems(r: Repositories, source: PeriodPlanRow, expectedRevision: bigint) {
  const problems = await periodPlanStaleReasons(r, source);
  if (source.revision !== expectedRevision) problems.push('SOURCE_PLAN_CHANGED');
  if (source.items.some((i) => i.status !== 'CANDIDATE')) problems.push('SOURCE_PLAN_PARTIALLY_APPLIED');
  if (source.ends_at <= await r.personalPlanning.now()) problems.push('WINDOW_ENDED');
  return problems;
}
export async function proposeScopeSimulation(db: DbExecutor, input: Scope & { planId: string; expectedRevision: string;
  keepTaskIds: readonly string[]; deferTaskIds: readonly string[]; unreliableTaskIds: readonly string[] }) {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'ProposeScopeSimulation',
    target: { plan_id: input.planId }, body: { expected_revision: input.expectedRevision, keep_task_ids: [...input.keepTaskIds], defer_task_ids: [...input.deferTaskIds],
      unreliable_task_ids: [...input.unreliableTaskIds] }, execute: async (r) => {
      const located = await r.personalPlanning.read(input.planId);
      if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('PeriodPlan');
      await authority(r, input.workspaceId, located.project_id);
      const plan = (await r.personalPlanning.read(located.id, true))!;
      if (plan.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({ entityType: 'PERIOD_PLAN', expectedRevision: input.expectedRevision, actualRevision: plan.revision.toString() });
      if ((await sourceProblems(r, plan, plan.revision)).length) throw invalidTransition('推演需要未应用且依据仍有效的本段计划；请重新发起计划。');
      const tasks = plan.baseline.tasks as unknown as PlanningTask[];
      const allIds = new Set(tasks.map((t) => t.task_id));
      for (const [field, ids] of [['keep_task_ids', input.keepTaskIds], ['defer_task_ids', input.deferTaskIds], ['unreliable_task_ids', input.unreliableTaskIds]] as const) {
        if (ids.length > 64 || new Set(ids).size !== ids.length || ids.some((id) => !allIds.has(id))) throw validationFailed([{ field, message: '只能选择原计划范围内的不同任务。' }]);
      }
      if (!input.keepTaskIds.length || !input.deferTaskIds.length) throw validationFailed([{ field: 'scope', message: '需要明确缩小范围保留项和推迟项。' }]);
      const sources = [];
      for (const task of tasks) {
        const estimate = (await r.personalPlanning.estimates(task.task_id)).find((e) => e.revision.toString() === task.estimate_revision);
        sources.push({ task_id: task.task_id, estimate: estimate === undefined ? null : estimateView(estimate),
          reliability: input.unreliableTaskIds.includes(task.task_id) ? 'USER_MARKED_UNRELIABLE' : 'USER_DECLARED_UNVERIFIED' });
      }
      const row = await r.personalPlanning.insertSimulation({ id: randomUUID(), workspace_id: input.workspaceId, project_id: plan.project_id,
        source_plan_id: plan.id, source_plan_revision: plan.revision,
        baseline: { available_ms: plan.available_ms.toString(), started_at: plan.started_at.toISOString(), ends_at: plan.ends_at.toISOString(),
          source_plan_baseline: plan.baseline, estimate_sources: sources, keep_task_ids: [...input.keepTaskIds], defer_task_ids: [...input.deferTaskIds], unreliable_task_ids: [...input.unreliableTaskIds] },
        options: buildScopeOptions(tasks, Number(plan.available_ms), Number(plan.baseline.diagnostic_ms), input.keepTaskIds, input.deferTaskIds, input.unreliableTaskIds) });
      await audit(r, input, row, 'SCOPE_SIMULATION_PROPOSED');
      return summary(row);
    } });
}
async function view(r: Repositories, row: ScopeSimulationRow) {
  const source = await r.personalPlanning.read(row.source_plan_id);
  const selected = row.selected_plan_id === null ? undefined : await r.personalPlanning.read(row.selected_plan_id);
  return { ...summary(row), baseline: row.baseline, options: row.options, created_at: row.created_at.toISOString(), selection_reason: row.selection_reason,
    stale_reasons: source === undefined ? ['SOURCE_UNAVAILABLE'] : await sourceProblems(r, source, row.source_plan_revision),
    selected_plan: selected === undefined ? null : { plan_id: selected.id, revision: selected.revision.toString(), items: selected.items },
    execution_admission: 'NOT_GRANTED', permission_gaps: 'CHECK_AT_EXECUTION', material_gaps: 'CHECK_AT_EXECUTION', completion_date: null };
}
export async function readScopeSimulation(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.personalPlanning.readSimulation(id);
    if (row?.workspace_id !== workspaceId) throw resourceNotFound('ScopeSimulation');
    await readProjectInWorkspace(r, workspaceId, row.project_id);
    return view(r, row);
  });
}
export async function listScopeSimulations(db: DbExecutor, workspaceId: string, planId: string) {
  return withTransaction(db, async (r) => {
    const plan = await r.personalPlanning.read(planId);
    if (plan?.workspace_id !== workspaceId) throw resourceNotFound('PeriodPlan');
    const items = [];
    for (const row of await r.personalPlanning.listSimulations(workspaceId, planId)) items.push(await view(r, row));
    return { source_plan_id: planId, items };
  });
}
export async function selectScopeSimulation(db: DbExecutor, input: Scope & { simulationId: string; expectedRevision: string; option: ScopeOptionKind; confirmed: true; reason: string }) {
  const reason = input.reason.trim();
  if (input.confirmed !== true || !reason || reason.length > 4000) throw validationFailed([{ field: 'reason', message: '需要明确确认与 1–4000 字理由。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'SelectScopeSimulation',
    target: { simulation_id: input.simulationId }, body: { expected_revision: input.expectedRevision, option: input.option, confirmed: input.confirmed, reason }, execute: async (r) => {
      const located = await r.personalPlanning.readSimulation(input.simulationId);
      if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('ScopeSimulation');
      await authority(r, input.workspaceId, located.project_id);
      const row = (await r.personalPlanning.readSimulation(located.id, true))!;
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({ entityType: 'SCOPE_SIMULATION', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      if (row.status !== 'PROPOSED') throw invalidTransition('此推演已选定方案，请读回原计划或重新发起。');
      const source = (await r.personalPlanning.read(row.source_plan_id, true))!;
      if ((await sourceProblems(r, source, row.source_plan_revision)).length) throw invalidTransition('原计划、估时或窗口已变化，需要重新发起推演。');
      const option = (row.options as ScopeOption[]).find((o) => o.kind === input.option);
      if (option === undefined) throw validationFailed([{ field: 'option', message: '请选择 ALL、SHRINK 或 DEFER。' }]);
      const plan = await applyPeriodPlanCandidate(r, { ...input, projectId: row.project_id, title: `${source.title} · ${input.option}`.slice(0, 200),
        availableMs: source.available_ms, startedAt: source.started_at, endsAt: source.ends_at,
        baseline: { ...source.baseline, scope_simulation_id: row.id, scope_option: input.option, scope_task_ids: option.task_ids,
          unreliable_task_ids: row.baseline.unreliable_task_ids! }, items: option.items });
      const selected = await r.personalPlanning.selectSimulation(row.id, input.option, plan.id, reason);
      await audit(r, input, selected, 'SCOPE_SIMULATION_SELECTED');
      return summary(selected);
    } });
}
