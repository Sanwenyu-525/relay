import type { DbExecutor } from '../infrastructure/database.js';
import type { TaskRow } from '../infrastructure/database-schema.js';
import { toDecimalString } from '../shared/decimal.js';
import { loadReadinessForTasks, readinessReasons, taskAllowedActions,
  type TaskReadinessFacts } from './task-readiness.js';
import { requireWorkspace } from './guards.js';
import { requireLocalDate, requireTimezone } from './local-calendar.js';
import { createRepositories } from './unit-of-work.js';
import type { FocusSelectionRow, TaskSelectionRow } from '../today/today-repository.js';

export interface TodayItemDto {
  readonly task_id: string;
  readonly task_revision: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly status: TaskRow['status'];
  readonly priority: TaskRow['priority'];
  readonly due_local_date: string | null;
  readonly timezone: string | null;
  readonly pin: boolean;
  readonly later_local_date: string | null;
  readonly later_timezone: string | null;
  readonly reason_codes: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly allowed_actions: readonly string[];
}

export interface TodayDto {
  readonly date: string;
  readonly timezone: string;
  readonly selection_revision: string;
  readonly focus: { readonly date: string; readonly timezone: string;
    readonly target_kind: 'GOAL' | 'PROJECT' | 'TASK'; readonly target_id: string;
    readonly selection_revision: string; readonly active_in_query: boolean } | null;
  readonly focus_has_eligible_candidate: boolean;
  readonly eligible_items: readonly TodayItemDto[];
  readonly waiting_items: readonly TodayItemDto[];
  /** Subset of waiting_items; Pin never overrides a failed eligibility check. */
  readonly blocked_pinned_items: readonly TodayItemDto[];
}

type RankedItem = { readonly dto: TodayItemDto; readonly task: TaskRow;
  readonly focusAligned: boolean; readonly pin: boolean;
  readonly dueRank: number; readonly dueDate: string;
  readonly priorityRank: number; readonly nextAction: boolean;
  readonly humanInProgress: boolean };

export async function readToday(db: DbExecutor, input: {
  readonly workspaceId: string; readonly date: string; readonly timezone: string;
}): Promise<TodayDto> {
  const date = requireLocalDate(input.date, 'date');
  const timezone = requireTimezone(input.timezone, 'timezone');
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const repositories = createRepositories(snapshot);
    await requireWorkspace(repositories, input.workspaceId);
    const observation = await repositories.today.observationAt(date, timezone);
    const tasks = await repositories.tasks.listTodayTasks(input.workspaceId);
    const choices = new Map((await repositories.today.listTaskSelections(input.workspaceId))
      .map((choice) => [choice.task_id, choice]));
    const focus = await repositories.today.readFocus(input.workspaceId, date);
    const selectionRevision = await repositories.today.readSelectionRevision(input.workspaceId);
    const nextActions = new Map((await repositories.today.listNextActions(input.workspaceId))
      .map((row) => [row.task_id, row]));
    const goalIds = new Map<string, Set<string>>();
    for (const row of await repositories.today.listEffectiveGoals(input.workspaceId)) {
      const ids = goalIds.get(row.task_id) ?? new Set<string>();
      ids.add(row.goal_id);
      goalIds.set(row.task_id, ids);
    }
    const readiness = new Map<string, TaskReadinessFacts>();
    const groups = new Map<string | null, TaskRow[]>();
    for (const task of tasks) {
      const group = groups.get(task.project_id) ?? [];
      group.push(task);
      groups.set(task.project_id, group);
    }
    for (const [projectId, group] of groups) {
      for (const [taskId, facts] of await loadReadinessForTasks(repositories, group, projectId)) {
        readiness.set(taskId, facts);
      }
    }
    const eligible: RankedItem[] = [];
    const waiting: RankedItem[] = [];
    for (const task of tasks) {
      const facts = readiness.get(task.id) ?? { requiredCriterionCount: 0,
        blockingTaskIds: [], unresolvedBlockerIds: [] };
      const choice = choices.get(task.id);
      const next = nextActions.get(task.id);
      const aligned = focusAligned(focus, timezone, task, goalIds.get(task.id));
      const laterActive = choice?.later_until !== null && choice?.later_until !== undefined &&
        choice.later_until.getTime() > observation.getTime();
      const ready = (task.status === 'READY' || task.status === 'IN_PROGRESS') &&
        task.executor_kind === 'HUMAN' && readinessReasons(facts).length === 0 && !laterActive;
      const dueLocalToday = task.due_timezone === null ? null :
        localDateAt(observation, task.due_timezone);
      const dueRank = task.due_local_date === null || dueLocalToday === null ? 3 :
        task.due_local_date < dueLocalToday ? 0 : task.due_local_date === dueLocalToday ? 1 : 2;
      const reasonCodes: string[] = [];
      const evidenceRefs = new Set<string>([`task:${task.id}/revision:${task.revision}`]);
      if (aligned) {
        reasonCodes.push('FOCUS_ALIGNED');
        evidenceRefs.add(`focus:${date}/revision:${focus!.revision}`);
      }
      if (choice?.pin === true) {
        reasonCodes.push('PINNED');
        evidenceRefs.add(`task_selection:${task.id}/revision:${choice.revision}`);
      }
      if (dueRank === 0) reasonCodes.push('OVERDUE');
      else if (dueRank === 1) reasonCodes.push('DUE_TODAY');
      if (task.priority === 'HIGH') reasonCodes.push('PRIORITY_HIGH');
      else if (task.priority === 'LOW') reasonCodes.push('PRIORITY_LOW');
      if (next !== undefined) {
        reasonCodes.push('PROJECT_NEXT_ACTION');
        evidenceRefs.add(`project_state:${next.project_id}/revision:${next.revision}`);
      }
      if (task.status === 'IN_PROGRESS' && task.executor_kind === 'HUMAN') {
        reasonCodes.push('HUMAN_IN_PROGRESS');
      }
      if (task.executor_kind === 'AI') {
        reasonCodes.push('AI_OCCUPIED');
        if (task.executor_run_id !== null) evidenceRefs.add(`run:${task.executor_run_id}`);
      }
      for (const reason of readinessReasons(facts)) reasonCodes.push(reason);
      for (const blockedId of facts.blockingTaskIds) evidenceRefs.add(`task:${blockedId}`);
      for (const blockerId of facts.unresolvedBlockerIds) evidenceRefs.add(`project_blocker:${blockerId}`);
      if (laterActive) {
        reasonCodes.push('LATER_ACTIVE');
        evidenceRefs.add(`task_selection:${task.id}/revision:${choice!.revision}`);
      }
      if (!['READY', 'IN_PROGRESS'].includes(task.status)) reasonCodes.push('TASK_NOT_READY');
      if (ready && reasonCodes.length === 0) reasonCodes.push('READY_TO_START');
      const selectionActions = [choice?.pin === true ? 'UNPIN' : 'PIN', 'SET_LATER',
        ...(choice?.later_local_date === null || choice?.later_local_date === undefined ? [] : ['CLEAR_LATER']),
        'SET_FOCUS'];
      const taskActions = task.executor_kind === 'HUMAN'
        ? taskAllowedActions({ status: task.status,
          satisfiable: ready || (facts.requiredCriterionCount > 0 &&
            facts.blockingTaskIds.length === 0 && facts.unresolvedBlockerIds.length === 0) })
        : [];
      const dto: TodayItemDto = { task_id: task.id, task_revision: toDecimalString(task.revision),
        project_id: task.project_id, title: task.title, status: task.status,
        priority: task.priority, due_local_date: task.due_local_date, timezone: task.due_timezone,
        pin: choice?.pin === true, later_local_date: choice?.later_local_date ?? null,
        later_timezone: choice?.later_timezone ?? null, reason_codes: reasonCodes,
        evidence_refs: [...evidenceRefs].sort(),
        allowed_actions: [...(laterActive || !ready ? taskActions.filter((action) => action !== 'START')
          : taskActions), ...selectionActions] };
      const ranked: RankedItem = { dto, task, focusAligned: aligned,
        pin: choice?.pin === true, dueRank, dueDate: task.due_local_date ?? '',
        priorityRank: task.priority === 'HIGH' ? 0 : task.priority === 'LOW' ? 2 : 1,
        nextAction: next !== undefined,
        humanInProgress: task.status === 'IN_PROGRESS' && task.executor_kind === 'HUMAN' };
      (ready ? eligible : waiting).push(ranked);
    }
    eligible.sort(compareRanked);
    waiting.sort(compareRanked);
    const focusDto = focus === undefined ? null : {
      date: focus.focus_local_date, timezone: focus.timezone,
      target_kind: focus.goal_id !== null ? 'GOAL' as const :
        focus.project_id !== null ? 'PROJECT' as const : 'TASK' as const,
      target_id: focus.goal_id ?? focus.project_id ?? focus.task_id!,
      selection_revision: toDecimalString(focus.revision),
      active_in_query: focus.timezone === timezone,
    };
    return { date, timezone, selection_revision: toDecimalString(selectionRevision),
      focus: focusDto,
      focus_has_eligible_candidate: eligible.some((item) => item.focusAligned),
      eligible_items: eligible.map((item) => item.dto),
      waiting_items: waiting.map((item) => item.dto),
      blocked_pinned_items: waiting.filter((item) => item.pin).map((item) => item.dto) };
  });
}

function focusAligned(focus: FocusSelectionRow | undefined, timezone: string,
  task: TaskRow, goals: ReadonlySet<string> | undefined): boolean {
  if (focus === undefined || focus.timezone !== timezone) return false;
  if (focus.task_id !== null) return focus.task_id === task.id;
  if (focus.project_id !== null) return focus.project_id === task.project_id;
  return focus.goal_id !== null && goals?.has(focus.goal_id) === true;
}

function localDateAt(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)!.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function compareRanked(a: RankedItem, b: RankedItem): number {
  if (a.focusAligned !== b.focusAligned) return a.focusAligned ? -1 : 1;
  if (a.pin !== b.pin) return a.pin ? -1 : 1;
  if (a.dueRank !== b.dueRank) return a.dueRank - b.dueRank;
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
  if (a.nextAction !== b.nextAction) return a.nextAction ? -1 : 1;
  if (a.humanInProgress !== b.humanInProgress) return a.humanInProgress ? -1 : 1;
  if (a.task.created_at.getTime() !== b.task.created_at.getTime()) {
    return a.task.created_at.getTime() - b.task.created_at.getTime();
  }
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}
