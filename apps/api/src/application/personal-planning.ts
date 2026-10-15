import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { PeriodPlanRow, TimeEstimateRow } from '../planning/personal-planning-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { applyTaskCreation, prepareTaskCreation } from './create-task.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace, readTaskInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

type Scope = { workspaceId: string; commandId: string };
export interface PlanningTask {
  task_id: string; title: string; revision: string; acceptance_revision: string; status: string;
  priority: 'HIGH' | 'NORMAL' | 'LOW' | null; due_local_date: string | null;
  estimate_revision: string; elapsed_ms: number | null; human_ms: number | null;
  critical: boolean; dependencies: string[]; blockers: string[];
}
export interface PlanningItem extends JsonObject {
  id: string; task_id: string; title: string; kind: 'TASK' | 'DIAGNOSTIC' | 'DEFERRED';
  reason: string; budget_ms: number | null; human_ms: number | null; depends_on_task_ids: string[];
  status: 'CANDIDATE' | 'ACCEPTED' | 'REJECTED'; created_task_id: string | null; resolution_reason: string | null;
  output: string | null;
}
const planResult = (p: PeriodPlanRow) => ({ plan_id: p.id, project_id: p.project_id, revision: p.revision.toString() });
const note = (value: string, field: string, max = 4000) => {
  if (!value.trim() || value.length > max) throw validationFailed([{ field, message: `需要 1–${max} 字。` }]);
  return value.trim();
};
function duration(value: number | null, field: string) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw validationFailed([{ field, message: '需要非负整数毫秒或 null。' }]);
  return value === null ? null : BigInt(value);
}
async function authority(r: Repositories, workspaceId: string, projectId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
  await lockWritableProjectInWorkspace(r, workspaceId, projectId);
}
async function audit(r: Repositories, input: Scope, projectId: string, type: string, refs: JsonObject) {
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
    commandId: input.commandId, projectId, taskId: null, eventType: type, factRefs: refs });
}
export function estimateView(e: TimeEstimateRow) {
  const ms = (v: bigint | null) => v?.toString() ?? null;
  return { id: e.id, task_id: e.task_id, revision: e.revision.toString(), acceptance_revision: e.acceptance_revision.toString(),
    elapsed_ms: ms(e.elapsed_ms), execution_ms: ms(e.execution_ms), waiting_ms: ms(e.waiting_ms), review_ms: ms(e.review_ms),
    human_ms: ms(e.human_ms), source_note: e.source_note, source_kind: 'USER_DECLARED', created_at: e.created_at.toISOString() };
}
export async function recordTaskTimeEstimate(db: DbExecutor, input: Scope & { taskId: string; expectedTaskRevision: string;
  expectedEstimateRevision: string; confirmed: true; elapsedMs: number | null; executionMs: number | null; waitingMs: number | null;
  reviewMs: number | null; humanMs: number | null; sourceNote: string }) {
  const sourceNote = note(input.sourceNote, 'source_note');
  const values = { elapsed_ms: duration(input.elapsedMs, 'elapsed_ms'), execution_ms: duration(input.executionMs, 'execution_ms'),
    waiting_ms: duration(input.waitingMs, 'waiting_ms'), review_ms: duration(input.reviewMs, 'review_ms'), human_ms: duration(input.humanMs, 'human_ms') };
  if (input.confirmed !== true || !/^[0-9]+$/u.test(input.expectedEstimateRevision)) throw validationFailed([{ field: 'confirmed', message: '需要确认估时与当前估时修订。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'RecordTaskTimeEstimate',
    target: { task_id: input.taskId }, body: { expected_task_revision: input.expectedTaskRevision, expected_estimate_revision: input.expectedEstimateRevision,
      confirmed: input.confirmed, source_note: sourceNote, elapsed_ms: input.elapsedMs, execution_ms: input.executionMs, waiting_ms: input.waitingMs,
      review_ms: input.reviewMs, human_ms: input.humanMs }, execute: async (r) => {
      const located = await readTaskInWorkspace(r, input.workspaceId, input.taskId);
      if (located.project_id === null) throw invalidTransition('基础计划估时需要项目内任务。');
      await authority(r, input.workspaceId, located.project_id);
      const task = (await r.tasks.readTaskForShare(located.id))!;
      if (task.revision !== requireRevision(input.expectedTaskRevision, 'expected_task_revision')) throw revisionConflict({
        entityType: 'TASK', expectedRevision: input.expectedTaskRevision, actualRevision: task.revision.toString() });
      const current = (await r.personalPlanning.estimates(task.id))[0];
      const revision = current?.revision ?? 0n;
      if (revision !== BigInt(input.expectedEstimateRevision)) throw revisionConflict({ entityType: 'TIME_ESTIMATE', expectedRevision: input.expectedEstimateRevision, actualRevision: revision.toString() });
      const row = await r.personalPlanning.insertEstimate({ id: randomUUID(), workspace_id: input.workspaceId, task_id: task.id,
        revision: revision + 1n, acceptance_revision: task.acceptance_revision, source_note: sourceNote, ...values });
      await audit(r, input, located.project_id, 'TASK_TIME_ESTIMATE_RECORDED', { task_id: task.id, estimate_id: row.id });
      return { task_id: task.id, estimate_id: row.id, revision: row.revision.toString() };
    } });
}
export async function readTaskTimeEstimates(db: DbExecutor, workspaceId: string, taskId: string) {
  return withTransaction(db, async (r) => {
    const task = await readTaskInWorkspace(r, workspaceId, taskId);
    const rows = await r.personalPlanning.estimates(task.id);
    return { task_id: task.id, current: rows[0] === undefined ? null : { ...estimateView(rows[0]), applicable: rows[0].acceptance_revision === task.acceptance_revision },
      items: rows.map(estimateView) };
  });
}
/** 采用串行保守预算；elapsed 已含等待/审阅及任务内部重叠，不能再把分项或人工投入加进去。 */
export function buildPlanningItems(tasks: readonly PlanningTask[], availableMs: number, diagnosticMs: number): PlanningItem[] {
  const critical = new Set(tasks.filter((t) => t.critical).map((t) => t.task_id));
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const mark = (id: string) => { for (const dep of byId.get(id)?.dependencies ?? []) if (!critical.has(dep)) { critical.add(dep); mark(dep); } };
  [...critical].forEach(mark);
  const rank = (p: PlanningTask['priority']) => p === 'HIGH' ? 0 : p === 'NORMAL' ? 1 : p === 'LOW' ? 2 : 3;
  const pending = [...tasks].sort((a, b) => Number(critical.has(b.task_id)) - Number(critical.has(a.task_id)) ||
    rank(a.priority) - rank(b.priority) || (a.due_local_date ?? '9999').localeCompare(b.due_local_date ?? '9999') || a.task_id.localeCompare(b.task_id));
  const result: PlanningItem[] = [];
  let remaining = availableMs;
  while (pending.length) {
    const index = pending.findIndex((t) => t.dependencies.every((id) => !pending.some((p) => p.task_id === id)));
    const task = pending.splice(index < 0 ? 0 : index, 1)[0]!;
    const dependencyReady = task.dependencies.every((id) => result.some((i) => i.task_id === id && i.kind === 'TASK'));
    let kind: PlanningItem['kind'] = 'DEFERRED';
    let reason = 'CAPACITY_EXCEEDED';
    const budget = task.elapsed_ms ?? (critical.has(task.task_id) ? diagnosticMs : null);
    if (index < 0 || !dependencyReady) reason = 'DEPENDENCY_NOT_PLANNED';
    else if (task.blockers.length) reason = 'OPEN_BLOCKER';
    else if (!['INBOX', 'READY'].includes(task.status)) reason = 'TASK_NOT_IDLE';
    else if (budget === null) reason = 'ESTIMATE_UNKNOWN';
    else if (budget <= remaining) {
      kind = task.elapsed_ms === null ? 'DIAGNOSTIC' : 'TASK';
      reason = kind === 'DIAGNOSTIC' ? 'BOUNDED_DIAGNOSIS_REQUIRED' : critical.has(task.task_id) ? 'MAINLINE_OR_PREREQUISITE' : 'REMAINING_CAPACITY';
      remaining -= budget;
    }
    result.push({ id: randomUUID(), task_id: task.task_id, title: task.title, kind, reason, budget_ms: budget, human_ms: kind === 'DIAGNOSTIC' ? null : task.human_ms,
      depends_on_task_ids: task.dependencies, status: 'CANDIDATE', created_task_id: null, resolution_reason: null,
      output: kind === 'DIAGNOSTIC' ? `在 ${diagnosticMs} 毫秒预算内诊断「${task.title}」，交付已查证据、排除项、未知问题与下一步候选；未定位也交付记录，不宣称原任务完成。` : null });
  }
  return result;
}
async function projectGoals(r: Repositories, projectId: string) {
  return (await r.projects.listProjectGoalLinks(projectId)).map((g) => ({ goal_id: g.goal_id, title: g.goal_title, status: g.goal_status, revision: g.goal_revision.toString() }));
}
/** 原计划与范围方案选择共用的事务内 Owner；不授予 Task 执行权。 */
export async function applyPeriodPlanCandidate(r: Repositories, input: Scope & { projectId: string; title: string; availableMs: bigint;
  startedAt: Date; endsAt: Date; baseline: JsonObject; items: JsonObject[] }) {
  const row = await r.personalPlanning.insert({ id: randomUUID(), workspace_id: input.workspaceId, project_id: input.projectId,
    title: input.title, available_ms: input.availableMs, started_at: input.startedAt, ends_at: input.endsAt, baseline: input.baseline, items: input.items });
  await audit(r, input, input.projectId, 'PERIOD_PLAN_PROPOSED', { plan_id: row.id });
  return row;
}
export async function proposePeriodPlan(db: DbExecutor, input: Scope & { projectId: string; title: string; availableMs: number;
  diagnosticMs: number; taskIds: readonly string[]; mainlineTaskIds: readonly string[]; goalIds: readonly string[] }) {
  const title = note(input.title, 'title', 200);
  if (input.availableMs <= 0 || input.diagnosticMs <= 0 || input.diagnosticMs > input.availableMs || input.availableMs > 604800000 ||
      duration(input.availableMs, 'available_ms') === null || duration(input.diagnosticMs, 'diagnostic_ms') === null ||
      input.taskIds.length < 1 || input.taskIds.length > 64 || new Set(input.taskIds).size !== input.taskIds.length ||
      input.mainlineTaskIds.some((id) => !input.taskIds.includes(id))) throw validationFailed([{ field: 'capacity', message: '需要 1–64 个任务、本段 1–604800000 毫秒容量和不超过容量的诊断预算；主线需来自所选任务。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'ProposePeriodPlan',
    target: { project_id: input.projectId }, body: { title, available_ms: input.availableMs, diagnostic_ms: input.diagnosticMs,
      task_ids: [...input.taskIds], mainline_task_ids: [...input.mainlineTaskIds], goal_ids: [...input.goalIds] }, execute: async (r) => {
      await authority(r, input.workspaceId, input.projectId);
      const goals = await projectGoals(r, input.projectId);
      if (input.goalIds.some((id) => !goals.some((g) => g.goal_id === id && g.status === 'ACTIVE'))) throw invalidTransition('所选目标需要是当前项目已关联的活动目标。');
      const tasks: PlanningTask[] = [];
      const visiting = new Set<string>();
      const blockers = (await r.projects.listProjectBlockers(input.projectId)).filter((b) => b.resolved_at === null);
      const load = async (id: string): Promise<void> => {
        if (visiting.has(id)) return;
        visiting.add(id);
        if (visiting.size > 64) throw invalidTransition('基础计划最多读取 64 项任务及必要前置。');
        const task = await r.tasks.readTaskForShare(id);
        if (task?.workspace_id !== input.workspaceId || task.project_id !== input.projectId) throw invalidTransition('任务和必要前置需要属于当前项目；跨项目依赖须人工安排。');
        if (task.status === 'DONE') return;
        const deps = (await r.tasks.listDependencies(id)).filter((d) => d.dependency_kind === 'BLOCKS' && d.depends_on_status !== 'DONE').map((d) => d.depends_on_task_id);
        const estimate = (await r.personalPlanning.estimates(id))[0];
        const valid = estimate?.acceptance_revision === task.acceptance_revision;
        const explicitGoals = (await r.tasks.listExplicitGoals(id)).map((g) => g.goal_id);
        const critical = input.mainlineTaskIds.includes(id) || input.goalIds.some((g) => task.goal_alignment_mode === 'INHERIT' || explicitGoals.includes(g));
        tasks.push({ task_id: id, title: task.title, revision: task.revision.toString(), acceptance_revision: task.acceptance_revision.toString(), status: task.status,
          priority: task.priority, due_local_date: task.due_local_date, estimate_revision: estimate?.revision.toString() ?? '0',
          elapsed_ms: valid && estimate?.elapsed_ms !== null ? Number(estimate?.elapsed_ms) : null,
          human_ms: valid && estimate?.human_ms !== null ? Number(estimate?.human_ms) : null, critical, dependencies: deps,
          blockers: blockers.filter((b) => b.target_kind === 'PROJECT' || b.target_kind === 'TASK' && b.target_id === id).map((b) => b.reason) });
        for (const dep of deps) await load(dep);
      };
      for (const id of input.taskIds) await load(id);
      const started = await r.personalPlanning.now();
      const row = await applyPeriodPlanCandidate(r, { ...input, title,
        availableMs: BigInt(input.availableMs), startedAt: started, endsAt: new Date(started.getTime() + input.availableMs),
        baseline: { tasks: tasks as unknown as JsonObject[], project_goals: goals, selected_goal_ids: [...input.goalIds], selected_mainline_task_ids: [...input.mainlineTaskIds],
          capacity_policy: 'SERIAL_ELAPSED_INCLUDING_WAIT_AND_REVIEW', diagnostic_ms: input.diagnosticMs }, items: buildPlanningItems(tasks, input.availableMs, input.diagnosticMs) });
      return planResult(row);
    } });
}
export async function periodPlanStaleReasons(r: Repositories, plan: PeriodPlanRow) {
  const reasons: string[] = [];
  for (const baseline of plan.baseline.tasks as unknown as PlanningTask[]) {
    const task = await r.tasks.readTaskForShare(baseline.task_id);
    const estimate = (await r.personalPlanning.estimates(baseline.task_id))[0];
    if (task?.revision.toString() !== baseline.revision || task.acceptance_revision.toString() !== baseline.acceptance_revision ||
        (estimate?.revision.toString() ?? '0') !== baseline.estimate_revision) reasons.push(`TASK_OR_ESTIMATE_CHANGED:${baseline.task_id}`);
  }
  if (!isDeepStrictEqual(await projectGoals(r, plan.project_id), plan.baseline.project_goals)) reasons.push('PROJECT_GOALS_CHANGED');
  const blockers = (await r.projects.listProjectBlockers(plan.project_id)).filter((b) => b.resolved_at === null);
  for (const t of plan.baseline.tasks as unknown as PlanningTask[]) if (JSON.stringify(blockers.filter((b) => b.target_kind === 'PROJECT' || b.target_kind === 'TASK' && b.target_id === t.task_id).map((b) => b.reason)) !== JSON.stringify(t.blockers)) reasons.push(`BLOCKERS_CHANGED:${t.task_id}`);
  return reasons;
}
async function planView(r: Repositories, plan: PeriodPlanRow) {
  const now = await r.personalPlanning.now();
  const remaining = Math.max(0, plan.ends_at.getTime() - now.getTime());
  const planned = (plan.items as PlanningItem[]).filter((i) => i.kind !== 'DEFERRED' && i.status !== 'REJECTED').reduce((sum, i) => sum + (i.budget_ms ?? 0), 0);
  return { ...planResult(plan), title: plan.title, available_ms: plan.available_ms.toString(), started_at: plan.started_at.toISOString(), ends_at: plan.ends_at.toISOString(),
    remaining_ms: remaining.toString(), expired: remaining === 0, time_warning: planned > remaining ? 'ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW' : null,
    stale_reasons: await periodPlanStaleReasons(r, plan), baseline: plan.baseline, items: plan.items,
    execution_admission: 'NOT_GRANTED', permission_gaps: 'CHECK_AT_EXECUTION', human_intervention: 'SEE_BLOCKERS_AND_TASK_ACCEPTANCE' };
}
export async function readPeriodPlan(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.personalPlanning.read(id);
    if (row?.workspace_id !== workspaceId) throw resourceNotFound('PeriodPlan');
    await readProjectInWorkspace(r, workspaceId, row.project_id);
    return planView(r, row);
  });
}
export async function listPeriodPlans(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await readProjectInWorkspace(r, workspaceId, projectId);
    const items = [];
    for (const row of await r.personalPlanning.list(workspaceId, projectId)) items.push(await planView(r, row));
    return { project_id: projectId, items };
  });
}
export async function resolvePeriodPlanItem(db: DbExecutor, input: Scope & { planId: string; itemId: string; expectedRevision: string; action: 'ACCEPT' | 'REJECT'; reason: string }) {
  const reason = note(input.reason, 'reason');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'ResolvePeriodPlanItem',
    target: { plan_id: input.planId, item_id: input.itemId }, body: { expected_revision: input.expectedRevision, action: input.action, reason }, execute: async (r) => {
      const located = await r.personalPlanning.read(input.planId);
      if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('PeriodPlan');
      await authority(r, input.workspaceId, located.project_id);
      const plan = (await r.personalPlanning.read(located.id, true))!;
      if (plan.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({ entityType: 'PERIOD_PLAN', expectedRevision: input.expectedRevision, actualRevision: plan.revision.toString() });
      const items = plan.items as PlanningItem[];
      const item = items.find((i) => i.id === input.itemId);
      if (item === undefined) throw resourceNotFound('PeriodPlanItem');
      if (item.status !== 'CANDIDATE') throw invalidTransition('该项已经处理；读回原结果或重新发起计划。');
      if (input.action === 'ACCEPT') {
        if (item.kind === 'DEFERRED') throw invalidTransition('延后项不能直接接受，需要更新依据并重新生成计划。');
        if ((await periodPlanStaleReasons(r, plan)).length) throw invalidTransition('计划依据已变化，需要重新生成。');
        const remaining = plan.ends_at.getTime() - (await r.personalPlanning.now()).getTime();
        // 估时是建议；审阅已耗时间在读投影提示，不把恰好排满容量的正常候选变成永远无法接受。
        if (remaining <= 0) throw invalidTransition('本段窗口已经结束，请重新发起下一段计划。');
        if (item.depends_on_task_ids.some((id) => !items.some((i) => i.task_id === id && i.kind === 'TASK' && i.status === 'ACCEPTED'))) throw invalidTransition('先逐项接受必要前置。');
        if (item.kind === 'DIAGNOSTIC') {
          const created = await applyTaskCreation(r, prepareTaskCreation({ workspaceId: input.workspaceId, commandId: input.commandId, projectId: plan.project_id,
            title: `诊断：${item.title}`.slice(0, 200), objective: item.output!, mode: 'ME', expectedOutputs: { diagnostic_report: item.output!, time_budget_ms: item.budget_ms!, source_task_id: item.task_id },
            criteria: [{ criterionId: 'diagnosis', statement: '交付已查证据、排除项、未知问题和下一步候选；明确是否定位，不把诊断当原任务完成。', method: 'HUMAN', required: true }] }));
          item.created_task_id = created.task_id;
        }
      }
      item.status = input.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      item.resolution_reason = reason;
      const updated = await r.personalPlanning.resolve(plan.id, items);
      await audit(r, input, plan.project_id, 'PERIOD_PLAN_ITEM_RESOLVED', { plan_id: plan.id, item_id: item.id, action: input.action, created_task_id: item.created_task_id });
      return { ...planResult(updated), item_id: item.id, item_status: item.status, created_task_id: item.created_task_id };
    } });
}
