import type { AcceptanceCriterionRow, TaskRow } from '../infrastructure/database-schema.js';
import type { Repositories } from './unit-of-work.js';

/**
 * Task 前置条件的只读判定：目标是否具备可判断的验收条件、BLOCKS 前置是否完成、是否存在未解除 blocker。
 *
 * 依据 contracts/01-facts-and-ownership.md 第 3 节（blockers 阻止特定工作）与
 * docs/architecture/information-planning.md 第 4 节（Today 先做资格过滤）。
 * 这些判定同时服务于 ready/start 命令与查询投影的 allowed_actions，避免两处规则漂移。
 */

export interface TaskReadinessFacts {
  readonly requiredCriterionCount: number;
  readonly blockingTaskIds: readonly string[];
  readonly unresolvedBlockerIds: readonly string[];
}

/** 原因码；P02 没有 WAITING/BLOCKED 状态，这些码只用于允许动作与解释性字段。 */
export type TaskReadinessReason =
  | 'REQUIRED_CRITERION_MISSING'
  | 'DEPENDENCY_UNSATISFIED'
  | 'TASK_BLOCKED';

export function readinessReasons(facts: TaskReadinessFacts): readonly TaskReadinessReason[] {
  const reasons: TaskReadinessReason[] = [];

  if (facts.requiredCriterionCount < 1) {
    reasons.push('REQUIRED_CRITERION_MISSING');
  }

  if (facts.blockingTaskIds.length > 0) {
    reasons.push('DEPENDENCY_UNSATISFIED');
  }

  if (facts.unresolvedBlockerIds.length > 0) {
    reasons.push('TASK_BLOCKED');
  }

  return reasons;
}

/** 查询投影的 allowed_actions：当前事实下的 UI 提示，不是授权凭证（契约第 6 节）。 */
export function taskAllowedActions(facts: {
  readonly status: TaskRow['status'];
  readonly satisfiable: boolean;
}): readonly string[] {
  switch (facts.status) {
    case 'INBOX':
      return facts.satisfiable
        ? ['EDIT_PRESENTATION', 'MARK_READY', 'CANCEL']
        : ['EDIT_PRESENTATION', 'CANCEL'];
    case 'READY':
      return facts.satisfiable
        ? ['EDIT_PRESENTATION', 'START', 'CANCEL']
        : ['EDIT_PRESENTATION', 'CANCEL'];
    case 'IN_PROGRESS':
      // P03 起人工任务在 IN_PROGRESS 上可以保存受管产物版本并完成本轮工作。
      return ['EDIT_PRESENTATION', 'SAVE_ARTIFACT_VERSION', 'COMPLETE', 'CANCEL'];
    case 'WAITING':
    case 'BLOCKED':
      return ['CANCEL'];
    case 'DONE':
      // 已完成只能通过重开进入新周期；重开不等于把历史凭据当作新周期的完成依据。
      return ['REOPEN'];
    case 'CANCELLED':
      return [];
    default:
      return [];
  }
}

export async function loadTaskReadiness(
  repositories: Repositories,
  task: TaskRow,
  criteria: readonly AcceptanceCriterionRow[],
): Promise<TaskReadinessFacts> {
  const blocking = await repositories.tasks.listUnfinishedBlockingDependencies([task.id]);
  const blockers =
    task.project_id === null
      ? []
      : await repositories.projects.listUnresolvedBlockersForTask(task.project_id, task.id);

  return {
    requiredCriterionCount: criteria.filter((criterion) => criterion.required).length,
    blockingTaskIds: blocking.map((row) => row.depends_on_task_id).sort(),
    unresolvedBlockerIds: blockers.map((blocker) => blocker.id),
  };
}

/** 列表投影的批量版本：一次取回多个 Task 的前置事实，避免 N+1 查询。 */
export async function loadReadinessForTasks(
  repositories: Repositories,
  tasks: readonly TaskRow[],
  projectId: string | null,
): Promise<ReadonlyMap<string, TaskReadinessFacts>> {
  const taskIds = tasks.map((task) => task.id);
  const criteriaCounts = await repositories.tasks.countRequiredCriteriaForTasks(taskIds);
  const blocking = await repositories.tasks.listUnfinishedBlockingDependencies(taskIds);
  const blockers =
    projectId === null
      ? []
      : await repositories.projects.listUnresolvedBlockersForTasks(projectId, taskIds);
  const readiness = new Map<string, TaskReadinessFacts>();
  // 作用在 Project 上的未解除 blocker 阻止该项目内所有 Task 开始。
  const projectBlockerIds = blockers
    .filter((blocker) => blocker.target_kind === 'PROJECT' && blocker.target_id === projectId)
    .map((blocker) => blocker.id);

  for (const task of tasks) {
    readiness.set(task.id, {
      requiredCriterionCount: criteriaCounts.get(task.id) ?? 0,
      blockingTaskIds: blocking
        .filter((row) => row.task_id === task.id)
        .map((row) => row.depends_on_task_id),
      unresolvedBlockerIds: [
        ...blockers
          .filter((blocker) => blocker.target_kind === 'TASK' && blocker.target_id === task.id)
          .map((blocker) => blocker.id),
        ...projectBlockerIds,
      ],
    });
  }

  return readiness;
}
