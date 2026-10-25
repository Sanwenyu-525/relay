import type { Repositories } from './unit-of-work.js';
import { invalidTransition, resourceNotFound } from './domain-error.js';
import { requireTaskChainExecutionCurrent } from './task-chain-execution.js';
import type { ScheduledTaskOccurrenceRow } from '../planning/scheduled-task-repository.js';

/**
 * 定时任务在 Delegate 事务内的专用准入（ADR-026）。
 *
 * 这是「提前授权不绕过执行权」的落点：`delegateTask` 在授予执行权之前，用原事务核对
 * 触发发生身份、计划状态、代次、授权有效期、预算、上一轮 Task 终态与冻结执行依据。
 * 任何一条不成立都拒绝，且效果不落库。
 *
 * 与 N06 的差别只有两点，都写在 ADR-026：有效期上限放宽到 90 天、不引入 runtime 串行隔离
 * （每次触发是独立 Task/Run，不存在同一队列跨重启续跑）。
 */
export interface ScheduledTaskBinding {
  readonly occurrenceId: string;
  readonly scheduledTaskId: string;
  readonly scheduleGeneration: string;
}

/** 快照准入失败的原因码：分发前准入与补跑（RETRY）前准入共用同一套词表。 */
export interface ScheduledTaskDispatchFailure {
  readonly reason:
    | 'SCHEDULE_GENERATION_STALE'
    | 'PLAN_NOT_ENABLED'
    | 'AUTHORIZATION_EXPIRED'
    | 'BUDGET_EXHAUSTED'
    | 'PROJECT_ARCHIVED'
    | 'PREVIOUS_TASK_NOT_ACCEPTED'
    | 'EXECUTION_SCOPE_DRIFT';
  readonly message: string;
}

/**
 * 触发发生「此刻是否还值得执行」的快照准入（P0-A）。
 *
 * 用于两个入口：人工补跑（RETRY）命令事务内——必然不可执行时直接拒绝，不重开发生；
 * 分发流程在 CreateTask **尚未提交**前——必然不可执行时不建 Task，直接落 BLOCKED 说明原因。
 * 它不是执行权的最终裁决：并发窗口内的状态变化仍由 `requireScheduledTaskAdmission`
 * 在 Delegate 原事务内核对（契约 10.94 的已知中间态只保留给那个窗口）。
 */
export async function scheduledTaskDispatchFailure(
  repositories: Repositories,
  workspaceId: string,
  occurrence: ScheduledTaskOccurrenceRow,
): Promise<ScheduledTaskDispatchFailure | undefined> {
  const schedule = await repositories.scheduledTasks.read(occurrence.scheduled_task_id, true);
  if (schedule?.workspace_id !== workspaceId) throw resourceNotFound('ScheduledTask');
  if (schedule.schedule_generation.toString() !== occurrence.schedule_generation.toString()) {
    return { reason: 'SCHEDULE_GENERATION_STALE', message: '定时任务规则已变更，这次触发属于旧代次。' };
  }
  if (schedule.status !== 'ENABLED') {
    return { reason: 'PLAN_NOT_ENABLED', message: '定时任务已暂停、停用或到期，不再执行这次触发。' };
  }

  const now = await repositories.scheduledTasks.now();
  if (schedule.authorization_expires_at <= now) {
    return { reason: 'AUTHORIZATION_EXPIRED', message: '定时任务授权已到期。' };
  }
  if (schedule.runs_started >= schedule.max_runs) {
    return { reason: 'BUDGET_EXHAUSTED', message: '定时任务执行次数已用尽。' };
  }

  const project = await repositories.projects.lockProjectArchiveGate(occurrence.project_id);
  if (project === undefined || project.archived_at !== null) {
    return { reason: 'PROJECT_ARCHIVED', message: '所属项目已归档，不能补跑或继续执行。' };
  }

  const unfinished = await repositories.scheduledTasks.unfinishedBoundTaskIds(
    occurrence.scheduled_task_id, occurrence.task_id ?? undefined);
  if (unfinished.length > 0) {
    return { reason: 'PREVIOUS_TASK_NOT_ACCEPTED', message: '上一轮定时任务尚未验收完成（未到 DONE/CANCELLED），不能启动新一轮。' };
  }

  // 已冻结的执行范围必须仍然 CURRENT：漂移就让这次触发作废，不重算覆盖（#151 同口径）。
  if (Object.keys(occurrence.frozen_execution).length > 0 && occurrence.task_id !== null) {
    try {
      await requireTaskChainExecutionCurrent(
        repositories, workspaceId, occurrence.project_id, occurrence.frozen_execution, occurrence.task_id);
    } catch {
      return { reason: 'EXECUTION_SCOPE_DRIFT', message: '触发时冻结的执行范围已失效（连接、资料或资源发生了变化）。' };
    }
  }
  return undefined;
}

export async function requireScheduledTaskAdmission(
  repositories: Repositories,
  binding: ScheduledTaskBinding,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  const occurrence = await repositories.scheduledTasks.readOccurrence(binding.occurrenceId, true);
  if (occurrence?.workspace_id !== workspaceId) throw resourceNotFound('ScheduledTaskOccurrence');
  if (occurrence.status !== 'DISPATCHING') {
    throw invalidTransition('这次触发已经结束或已作废，不能重新授予执行权。');
  }
  if (occurrence.schedule_generation.toString() !== binding.scheduleGeneration) {
    throw invalidTransition('定时任务规则已变更，本次触发属于旧代次。');
  }
  if (occurrence.task_id !== taskId) {
    throw invalidTransition('触发发生绑定的任务与本次委托不一致。');
  }

  const schedule = await repositories.scheduledTasks.read(binding.scheduledTaskId, true);
  if (schedule?.workspace_id !== workspaceId) throw resourceNotFound('ScheduledTask');
  if (schedule.schedule_generation.toString() !== binding.scheduleGeneration) {
    throw invalidTransition('定时任务规则已变更，本次触发属于旧代次。');
  }
  if (schedule.status !== 'ENABLED') {
    throw invalidTransition('定时任务已暂停、停用或到期，不再授予执行权。');
  }

  const now = await repositories.scheduledTasks.now();
  if (schedule.authorization_expires_at <= now) {
    throw invalidTransition('定时任务授权已到期。');
  }
  if (schedule.runs_started >= schedule.max_runs) {
    throw invalidTransition('定时任务执行次数已用尽。');
  }

  // ADR-026：上一轮 Task 终态必须在 Delegate 原事务内再次复核（#147），不能只靠触发前的扫描——
  // 扫描与授予执行权之间 Task 状态可能变化。本计划还有其他未终态（DONE/CANCELLED）Task 时拒绝授权。
  const unfinished = await repositories.scheduledTasks.unfinishedBoundTaskIds(binding.scheduledTaskId, taskId);
  if (unfinished.length > 0) {
    throw invalidTransition('上一轮定时任务尚未验收完成（未到 DONE/CANCELLED），不能授予新一轮执行权。');
  }

  // 冻结的执行范围依据在授予执行权前再次核对（#151，与任务链 requireTaskChainAdmission 同型）：
  // 冻结与 Delegate 之间资料/资源/连接可能漂移，旧快照不再 CURRENT 就拒绝本次授权，不静默降级。
  if (Object.keys(occurrence.frozen_execution).length > 0) {
    await requireTaskChainExecutionCurrent(repositories, workspaceId, occurrence.project_id, occurrence.frozen_execution, taskId);
  }
}
