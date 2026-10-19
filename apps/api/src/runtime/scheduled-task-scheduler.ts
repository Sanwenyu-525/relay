import type { FastifyInstance } from 'fastify';
import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { createRepositories } from '../application/unit-of-work.js';
import { runScheduledTaskTick } from '../application/scheduled-tasks.js';

/**
 * 定时任务的扫描循环（ADR-026）。
 *
 * 与提醒扫描同一套生命周期约定：归 API/桌面子进程，`onReady` 自挂载，`setTimeout` 自续，
 * `timer.unref()`，`onClose` 清理；没有退出后常驻任务，也不借 Run Worker 执行。
 *
 * `openedAt` 在首次成功 tick 用 DB `clock_timestamp()` 固化，作为「本次进程启动时刻」：
 * 早于它的时段算错过，只落待处理，不自动执行。
 */
export function registerScheduledTaskScheduler(
  app: FastifyInstance,
  d: { database: RelayDatabase; schemaReadiness: SchemaReadinessChecker },
): void {
  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let openedAt: Date | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let failed = false;

  const tick = async () => {
    try {
      const readiness = await d.database.checkReadiness(d.schemaReadiness);
      if (readiness.database !== 'up' || readiness.schema !== 'up' || !active) return;
      openedAt ??= await createRepositories(d.database.executor).scheduledTasks.now();
      await runScheduledTaskTick(d.database.executor, openedAt);
      failed = false;
    } catch {
      if (!failed) app.log.warn({ code: 'SCHEDULED_TASK_SCAN_FAILED' }, 'scheduled_task_scan_failed');
      failed = true;
    } finally {
      if (active) { timer = setTimeout(() => { inFlight = tick(); }, 1000); timer.unref(); }
    }
  };

  app.addHook('onReady', async () => { active = true; inFlight = tick(); await inFlight; });
  app.addHook('onClose', async () => { active = false; if (timer !== undefined) clearTimeout(timer); await inFlight; });
}
