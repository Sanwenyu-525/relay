import type { RunRow, TaskRow } from '../infrastructure/database-schema.js';
import { resourceNotFound } from './domain-error.js';
import type { Repositories } from './unit-of-work.js';

/** 先无锁读取稳定的 run.task_id 定位，再统一按 Task → Run 加行锁。 */
export async function lockTaskAndRun(
  repositories: Repositories,
  runId: string,
  workspaceId?: string,
): Promise<{ readonly task: TaskRow; readonly run: RunRow }> {
  const located = await repositories.runs.readRun(runId);
  if (located === undefined || (workspaceId !== undefined && located.workspace_id !== workspaceId)) {
    throw resourceNotFound('Run');
  }
  const task = await repositories.tasks.lockTask(located.task_id);
  if (task === undefined || (workspaceId !== undefined && task.workspace_id !== workspaceId)) {
    throw resourceNotFound('Task');
  }
  const run = await repositories.runs.lockRun(runId);
  if (run === undefined || run.task_id !== task.id || run.workspace_id !== task.workspace_id) {
    throw resourceNotFound('Run');
  }
  return { task, run };
}
