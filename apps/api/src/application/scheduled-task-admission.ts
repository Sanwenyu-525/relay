import type { Repositories } from './unit-of-work.js';
import { invalidTransition, resourceNotFound } from './domain-error.js';

/**
 * 定时任务在 Delegate 事务内的专用准入（ADR-026）。
 *
 * 这是「提前授权不绕过执行权」的落点：`delegateTask` 在授予执行权之前，用原事务核对
 * 触发发生身份、计划状态、代次、授权有效期与预算。任何一条不成立都拒绝，且效果不落库。
 *
 * 与 N06 的差别只有两点，都写在 ADR-026：有效期上限放宽到 90 天、不引入 runtime 串行隔离
 * （每次触发是独立 Task/Run，不存在同一队列跨重启续跑）。
 */
export interface ScheduledTaskBinding {
  readonly occurrenceId: string;
  readonly scheduledTaskId: string;
  readonly scheduleGeneration: string;
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
}
