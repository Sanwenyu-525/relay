import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  AcceptanceCriterionRow,
  TaskDependencyKind,
  TaskGoalAlignmentMode,
  TaskRow,
  TaskStatus,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { FieldError } from '../shared/field-error.js';
import { toDecimalString } from '../shared/decimal.js';
import { checkRequiredText, normalizeText } from '../shared/text.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { enqueueControlLocked } from './control-requests.js';
import {
  dependencyCycle,
  goalAlignmentInvalid,
  invalidTransition,
  requiredInputMissing,
  resourceNotFound,
  revisionConflict,
  validationFailed,
  type DomainError,
} from './domain-error.js';
import {
  lockProjectInWorkspace,
  lockTaskInWorkspace,
  readTaskInWorkspace,
} from './guards.js';
import { normalizeIdSet, requireRevision, requireUuid } from './revisions.js';
import { requireLocalDate, requireTimezone } from './local-calendar.js';
import {
  loadTaskReadiness,
  readinessReasons,
  type TaskReadinessReason,
} from './task-readiness.js';
import type { Repositories } from './unit-of-work.js';

/** 只允许通过显式命令迁移的状态与状态机（契约 02 第 4 节的人工事件）。 */
const NON_TERMINAL_STATUSES: readonly TaskStatus[] = ['INBOX', 'READY', 'IN_PROGRESS'];

export type TaskCommandResult = {
  readonly task_id: string;
  readonly status: string;
  readonly revision: string;
};

export type CancelTaskResult = TaskCommandResult | (TaskCommandResult & {
  readonly control_request_id: string;
  readonly run_id: string;
  readonly type: 'CANCEL_TASK';
  readonly run_revision: string;
});

export interface EditTaskPresentationInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly title: string;
}

/**
 * EditTaskPresentation：只允许改 title。
 * status / mode / 执行权 / 验收版本都不经过本命令（契约第 3 节：不能改 status、owner、验收）。
 */
export async function editTaskPresentation(
  db: DbExecutor,
  input: EditTaskPresentationInput,
): Promise<CommandOutcome<TaskCommandResult>> {
  const titleProblem = checkRequiredText(input.title, 'title', 'title');

  if (titleProblem !== undefined) {
    throw validationFailed([titleProblem]);
  }

  const title = normalizeText(input.title);
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<TaskCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'EditTaskPresentation',
    target: { task_id: input.taskId },
    body: { expected_revision: toDecimalString(expectedRevision), title },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

      const updated = await repositories.tasks.updateTaskTitle(
        task.id,
        expectedRevision,
        title,
      );

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_PRESENTATION_UPDATED',
        factRefs: { title: updated.title },
      });

      return summarize(updated);
    },
  });
}

/** Scheduling is a user fact on Task, independent of its acceptance version. */
export async function setTaskPlanningMetadata(db: DbExecutor, input: {
  readonly workspaceId: string; readonly taskId: string; readonly commandId: string;
  readonly expectedRevision: string;
  readonly priority: 'LOW' | 'NORMAL' | 'HIGH' | null;
  readonly dueLocalDate: string | null; readonly timezone: string | null;
}): Promise<CommandOutcome<TaskCommandResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  if (input.priority !== null && !['LOW', 'NORMAL', 'HIGH'].includes(input.priority)) {
    throw validationFailed([{ field: 'priority', message: 'must be LOW, NORMAL or HIGH' }]);
  }
  if ((input.dueLocalDate === null) !== (input.timezone === null)) {
    throw validationFailed([{ field: 'due_local_date', message: 'date and timezone must be set or cleared together' }]);
  }
  const dueLocalDate = input.dueLocalDate === null ? null : requireLocalDate(input.dueLocalDate, 'due_local_date');
  const timezone = input.timezone === null ? null : requireTimezone(input.timezone, 'timezone');
  return runIdempotentCommand<TaskCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetTaskPlanningMetadata', target: { task_id: input.taskId },
    body: { expected_revision: toDecimalString(expectedRevision), priority: input.priority,
      due_local_date: dueLocalDate, timezone },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);
      requireRevisionMatch(task, expectedRevision);
      const updated = await repositories.tasks.updatePlanningMetadata({
        taskId: task.id, expectedRevision, priority: input.priority,
        dueLocalDate, dueTimezone: timezone,
      });
      if (updated === undefined) throw revisionConflict({ entityType: 'TASK',
        expectedRevision: toDecimalString(expectedRevision),
        actualRevision: toDecimalString(task.revision) });
      await recordActivity(repositories, { commandId: input.commandId,
        projectId: updated.project_id, taskId: updated.id,
        eventType: 'TASK_PLANNING_UPDATED',
        factRefs: { priority: input.priority, due_local_date: dueLocalDate, timezone } });
      return summarize(updated);
    },
  });
}

/**
 * MarkTaskReady：INBOX → READY。
 *
 * 校验任务目标（当前验收版本至少有一条必需 criterion）与前置依赖（BLOCKS 未完成、未解除 blocker），
 * 不自动启动；未满足前置时返回明确原因，仍停留在 INBOX 供继续编辑。
 */
export async function markTaskReady(
  db: DbExecutor,
  input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: string;
  },
): Promise<CommandOutcome<TaskCommandResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<TaskCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'MarkTaskReady',
    target: { task_id: input.taskId },
    body: { expected_revision: toDecimalString(expectedRevision) },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

      if (task.status !== 'INBOX') {
        throw invalidTransition(`只有 INBOX 的 Task 可以进入 READY（当前为 ${task.status}）。`, {
          taskId: task.id,
        });
      }

      const criteria = await repositories.tasks.listCriteria(task.id, task.acceptance_revision);
      const movability = await checkMovable(repositories, task, criteria, expectedRevision);

      if (movability !== undefined) {
        throw movability;
      }

      const updated = await repositories.tasks.applyTaskStatus({
        taskId: task.id,
        expectedRevision,
        fromStatus: 'INBOX',
        toStatus: 'READY',
      });

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_READIED',
        factRefs: { status: updated.status },
      });

      return summarize(updated);
    },
  });
}

/**
 * StartHumanTask：READY → IN_PROGRESS，仅限当前执行权为 HUMAN 且没有 AI 占有者。
 *
 * 与 ready 一样重新核对前置：READY 之后可能新增依赖或 blocker，
 * “依赖不满足时不得开始”（docs/frontend/page-development-prompts.md 的任务页约束）。
 */
export async function startHumanTask(
  db: DbExecutor,
  input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: string;
  },
): Promise<CommandOutcome<TaskCommandResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');

  return runIdempotentCommand<TaskCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'StartHumanTask',
    target: { task_id: input.taskId },
    body: { expected_revision: toDecimalString(expectedRevision) },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

      if (task.status !== 'READY') {
        throw invalidTransition(`只有 READY 的 Task 可以开始（当前为 ${task.status}）。`, {
          taskId: task.id,
        });
      }

      if (task.executor_kind !== 'HUMAN') {
        throw invalidTransition('当前 Task 的执行权不在本机人工用户手上。', { taskId: task.id });
      }

      const criteria = await repositories.tasks.listCriteria(task.id, task.acceptance_revision);
      const movability = await checkMovable(repositories, task, criteria, expectedRevision);

      if (movability !== undefined) {
        throw movability;
      }

      const updated = await repositories.tasks.applyTaskStatus({
        taskId: task.id,
        expectedRevision,
        fromStatus: 'READY',
        toStatus: 'IN_PROGRESS',
      });

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_STARTED',
        factRefs: { status: updated.status, executor_kind: updated.executor_kind },
      });

      return summarize(updated);
    },
  });
}

/**
 * CancelTask：人工直接取消；AI 占有时仅持久登记 CANCEL_TASK 意图。
 * 已完成（DONE）的 Task 不能直接取消：必须先重开，取消命令不能抹去完成凭据（契约第 3 节）。
 */
export async function cancelTask(
  db: DbExecutor,
  input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly expectedRevision: string;
    readonly expectedRunRevision?: string | undefined;
  },
): Promise<CommandOutcome<CancelTaskResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_task_revision');
  const expectedRunRevision = input.expectedRunRevision === undefined
    ? null : requireRevision(input.expectedRunRevision, 'expected_run_revision');

  return runIdempotentCommand<CancelTaskResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'CancelTask',
    target: { task_id: input.taskId },
    body: { expected_task_revision: toDecimalString(expectedRevision),
      expected_run_revision: expectedRunRevision === null ? null : toDecimalString(expectedRunRevision) },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

      if (task.status === 'DONE' || task.status === 'CANCELLED') {
        throw invalidTransition(
          task.status === 'DONE'
            ? '已完成的 Task 不能直接取消：先重开，再取消新周期。'
            : '该 Task 已是终态，不能再次取消。',
          { taskId: task.id },
        );
      }

      if (task.executor_kind === 'AI') {
        if (task.executor_run_id === null) throw invalidTransition('AI Task 缺少当前 Run。');
        const run = await repositories.runs.lockRun(task.executor_run_id);
        if (run === undefined || run.task_id !== task.id || run.ownership_epoch !== task.ownership_epoch ||
            run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
          throw invalidTransition('AI Task 的当前 Run 已失效，不能直接取消。');
        }
        if (expectedRunRevision !== null && run.revision !== expectedRunRevision) {
          throw revisionConflict({ entityType: 'RUN', expectedRevision: toDecimalString(expectedRunRevision),
            actualRevision: toDecimalString(run.revision) });
        }
        const control = await enqueueControlLocked(repositories, { task, run,
          type: 'CANCEL_TASK', commandId: input.commandId });
        const touched = await repositories.runs.touchRun(run.id, run.revision);
        if (touched === undefined) throw new Error('CancelTask control Run revision CAS failed');
        return { task_id: task.id, status: 'PENDING', revision: toDecimalString(task.revision),
          control_request_id: control.id, run_id: run.id, type: 'CANCEL_TASK',
          run_revision: toDecimalString(touched.revision) };
      }

      const updated = await repositories.tasks.applyTaskStatus({
        taskId: task.id,
        expectedRevision,
        fromStatus: task.status,
        toStatus: 'CANCELLED',
      });

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_CANCELLED',
        factRefs: { status: updated.status },
      });

      return summarize(updated);
    },
  });
}

export interface SetTaskGoalAlignmentInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly mode: TaskGoalAlignmentMode;
  /** INHERIT 时必须为空；EXPLICIT 时必填，可以是空集合（显式不对齐任何 Goal）。 */
  readonly goalIds: readonly string[] | undefined;
}

export type SetTaskGoalAlignmentResult = {
  readonly task_id: string;
  readonly revision: string;
  readonly goal_alignment_mode: string;
  readonly goal_ids: readonly string[];
};

/**
 * SetTaskGoalAlignment：显式切换 INHERIT / EXPLICIT。
 *
 * 显式集合必须是所属 Project 当前 Goal 的子集（contracts/01-facts-and-ownership.md 第 5 节）。
 * 锁序为 Project（FOR NO KEY UPDATE）→ Task（FOR UPDATE），与解除关联共用同一串行化点，
 * 因此“解除关联”和“新增显式对齐”并发时总有一个确定的先后顺序：
 * 先提交者生效，后到者看到新事实并按新事实被拒。
 */
export async function setTaskGoalAlignment(
  db: DbExecutor,
  input: SetTaskGoalAlignmentInput,
): Promise<CommandOutcome<SetTaskGoalAlignmentResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const problems: FieldError[] = [];

  if (input.mode === 'INHERIT') {
    if (input.goalIds !== undefined && input.goalIds.length > 0) {
      problems.push({ field: 'goal_ids', message: 'must be empty when mode is INHERIT' });
    }
  } else if (input.goalIds === undefined) {
    throw requiredInputMissing([
      { field: 'goal_ids', message: 'is required when mode is EXPLICIT' },
    ]);
  }

  if (problems.length > 0) {
    throw validationFailed(problems);
  }

  const goalIds = input.goalIds === undefined ? [] : normalizeIdSet(input.goalIds, 'goal_ids');

  return runIdempotentCommand<SetTaskGoalAlignmentResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetTaskGoalAlignment',
    target: { task_id: input.taskId },
    body: {
      expected_revision: toDecimalString(expectedRevision),
      mode: input.mode,
      goal_ids: goalIds,
    },
    execute: async (repositories) => {
      const observed = await readTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      if (observed.project_id !== null) {
        await lockProjectInWorkspace(repositories, input.workspaceId, observed.project_id);
      }

      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);

      if (!NON_TERMINAL_STATUSES.includes(task.status)) {
        throw invalidTransition('终态 Task 的 Goal 对齐不可修改；需要先重开。', {
          taskId: task.id,
        });
      }

      if (input.mode === 'EXPLICIT') {
        if (task.project_id === null) {
          throw goalAlignmentInvalid({
            detail: '未绑定 Project 的 Me Inbox 事项没有可显式对齐的 Goal 集合。',
            conflict: { taskId: task.id, goalIds },
          });
        }

        const links = await repositories.projects.listProjectGoalLinks(task.project_id);
        const linked = new Set(links.map((link) => link.goal_id));
        const outside = goalIds.filter((goalId) => !linked.has(goalId));

        if (outside.length > 0) {
          throw goalAlignmentInvalid({
            detail: '显式 Goal 必须是所属 Project 当前 Goal 的子集。',
            conflict: { taskId: task.id, goalIds: outside },
            fieldErrors: [
              { field: 'goal_ids', message: 'contains goals that are not linked to the project' },
            ],
          });
        }
      }

      const updated = await repositories.tasks.applyGoalAlignmentMode({
        taskId: task.id,
        expectedRevision,
        mode: input.mode,
      });

      if (updated === undefined) {
        throw revisionConflict({
          entityType: 'TASK',
          expectedRevision: toDecimalString(expectedRevision),
          actualRevision: toDecimalString(task.revision),
        });
      }

      await repositories.tasks.deleteExplicitGoals(task.id);

      if (input.mode === 'EXPLICIT' && task.project_id !== null) {
        for (const goalId of goalIds) {
          await repositories.tasks.insertExplicitGoal({
            taskId: task.id,
            projectId: task.project_id,
            goalId,
          });
        }
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_GOAL_ALIGNMENT_CHANGED',
        factRefs: { goal_alignment_mode: updated.goal_alignment_mode, goal_ids: goalIds },
      });

      return {
        task_id: updated.id,
        revision: toDecimalString(updated.revision),
        goal_alignment_mode: updated.goal_alignment_mode,
        goal_ids: goalIds,
      };
    },
  });
}

export interface ChangeDependencyInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly dependsOnTaskId: string;
  readonly dependencyKind: TaskDependencyKind;
}

/**
 * AddTaskDependency：新增一条依赖。
 *
 * 规则：禁止自依赖与环（自依赖是一条长度为 1 的环）；两端必须属于同一 Workspace 与同一 Project
 * （跨 Workspace 由复合外键拒绝，跨 Project 由本用例在写入前拒绝，不依赖数据库约束兜底）。
 */
export async function addTaskDependency(
  db: DbExecutor,
  input: ChangeDependencyInput,
): Promise<CommandOutcome<TaskCommandResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const dependsOnTaskId = requireUuid(input.dependsOnTaskId, 'depends_on_task_id');

  return runIdempotentCommand<TaskCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'AddTaskDependency',
    target: { task_id: input.taskId },
    body: {
      expected_revision: toDecimalString(expectedRevision),
      depends_on_task_id: dependsOnTaskId,
      dependency_kind: input.dependencyKind,
    },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);
      requireNonTerminal(task);

      if (dependsOnTaskId === task.id) {
        throw dependencyCycle({ taskId: task.id, dependsOnTaskId: task.id });
      }

      const upstream = await readTaskInWorkspace(
        repositories,
        input.workspaceId,
        dependsOnTaskId,
      );

      if (upstream.project_id !== task.project_id) {
        throw validationFailed([
          {
            field: 'depends_on_task_id',
            message: 'must reference a task in the same project',
          },
        ]);
      }

      const closure = await repositories.tasks.listDependencyClosure(
        input.workspaceId,
        dependsOnTaskId,
      );

      if (closure.includes(task.id)) {
        throw dependencyCycle({
          taskId: task.id,
          dependsOnTaskId: upstream.id,
          cycleTaskIds: [upstream.id, ...closure],
        });
      }

      const existing = await repositories.tasks.listDependencies(task.id);

      if (existing.some((row) => row.depends_on_task_id === upstream.id)) {
        throw invalidTransition('该依赖关系已存在，不重复建立。', {
          taskId: task.id,
          dependsOnTaskId: upstream.id,
        });
      }

      await repositories.tasks.insertDependency({
        workspaceId: input.workspaceId,
        taskId: task.id,
        dependsOnTaskId: upstream.id,
        dependencyKind: input.dependencyKind,
      });

      const updated = await repositories.tasks.bumpTaskRevision(task.id);

      if (updated === undefined) {
        throw resourceNotFound('Task');
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_DEPENDENCY_ADDED',
        factRefs: {
          depends_on_task_id: upstream.id,
          dependency_kind: input.dependencyKind,
        },
      });

      return summarize(updated);
    },
  });
}

export async function removeTaskDependency(
  db: DbExecutor,
  input: ChangeDependencyInput,
): Promise<CommandOutcome<TaskCommandResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const dependsOnTaskId = requireUuid(input.dependsOnTaskId, 'depends_on_task_id');

  return runIdempotentCommand<TaskCommandResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RemoveTaskDependency',
    target: { task_id: input.taskId },
    body: {
      expected_revision: toDecimalString(expectedRevision),
      depends_on_task_id: dependsOnTaskId,
    },
    execute: async (repositories) => {
      const task = await lockTaskInWorkspace(repositories, input.workspaceId, input.taskId);

      requireRevisionMatch(task, expectedRevision);
      requireNonTerminal(task);

      const deleted = await repositories.tasks.deleteDependency(task.id, dependsOnTaskId);

      if (!deleted) {
        throw resourceNotFound('Task dependency');
      }

      const updated = await repositories.tasks.bumpTaskRevision(task.id);

      if (updated === undefined) {
        throw resourceNotFound('Task');
      }

      await recordActivity(repositories, {
        commandId: input.commandId,
        projectId: updated.project_id,
        taskId: updated.id,
        eventType: 'TASK_DEPENDENCY_REMOVED',
        factRefs: { depends_on_task_id: dependsOnTaskId },
      });

      return summarize(updated);
    },
  });
}

function requireRevisionMatch(task: TaskRow, expectedRevision: bigint): void {
  if (task.revision !== expectedRevision) {
    throw revisionConflict({
      entityType: 'TASK',
      expectedRevision: toDecimalString(expectedRevision),
      actualRevision: toDecimalString(task.revision),
    });
  }
}

function requireNonTerminal(task: TaskRow): void {
  if (!NON_TERMINAL_STATUSES.includes(task.status)) {
    throw invalidTransition('终态 Task 的依赖关系不可修改；需要先重开。', {
      taskId: task.id,
    });
  }
}

/** 前置条件判定：未满足时返回要抛出的领域错误，满足时返回 undefined。 */
async function checkMovable(
  repositories: Repositories,
  task: TaskRow,
  criteria: readonly AcceptanceCriterionRow[],
  expectedRevision: bigint,
): Promise<DomainError | undefined> {
  const facts = await loadTaskReadiness(repositories, task, criteria);
  const reasons = readinessReasons(facts);

  if (reasons.length === 0) {
    return undefined;
  }

  return invalidTransition(describeReadiness(reasons), {
    taskId: task.id,
    ...(facts.blockingTaskIds.length === 0
      ? {}
      : { blockingTaskIds: facts.blockingTaskIds }),
    ...(facts.unresolvedBlockerIds.length === 0
      ? {}
      : { blockerIds: facts.unresolvedBlockerIds }),
    expectedRevision: toDecimalString(expectedRevision),
    actualRevision: toDecimalString(task.revision),
  });
}

function describeReadiness(reasons: readonly TaskReadinessReason[]): string {
  const parts: string[] = [];

  if (reasons.includes('REQUIRED_CRITERION_MISSING')) {
    parts.push('当前验收版本没有必需 criterion');
  }

  if (reasons.includes('DEPENDENCY_UNSATISFIED')) {
    parts.push('BLOCKS 前置任务尚未完成');
  }

  if (reasons.includes('TASK_BLOCKED')) {
    parts.push('存在未解除的 blocker');
  }

  return `任务前置条件未满足：${parts.join('；')}。`;
}

function summarize(task: TaskRow): TaskCommandResult {
  return {
    task_id: task.id,
    status: task.status,
    revision: toDecimalString(task.revision),
  };
}

async function recordActivity(
  repositories: Repositories,
  input: {
    readonly commandId: string;
    readonly projectId: string | null;
    readonly taskId: string;
    readonly eventType: string;
    readonly factRefs: JsonObject;
  },
): Promise<void> {
  const task = await repositories.tasks.readTask(input.taskId);
  if (task === undefined) throw new Error('activity Task missing in command transaction');
  await repositories.activities.insertActivityRecord({
    id: randomUUID(),
    workspaceId: task.workspace_id,
    actorKind: 'HUMAN',
    actorRef: LOCAL_ACTOR_REF,
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    eventType: input.eventType,
    factRefs: input.factRefs,
  });
}
