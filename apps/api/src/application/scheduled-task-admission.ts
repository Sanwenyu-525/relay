import type { Repositories } from './unit-of-work.js';
import { invalidTransition, resourceNotFound } from './domain-error.js';
import { requireTaskChainExecutionCurrent } from './task-chain-execution.js';

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
