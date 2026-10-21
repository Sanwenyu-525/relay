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
  let lastFailure = '';

  const tick = async () => {
    try {
      const readiness = await d.database.checkReadiness(d.schemaReadiness);
      if (readiness.database !== 'up' || readiness.schema !== 'up' || !active) return;
      openedAt ??= await createRepositories(d.database.executor).scheduledTasks.now();
      await runScheduledTaskTick(d.database.executor, openedAt);
      lastFailure = '';
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code) : null;
      // 同一失败只记一次，避免每秒刷屏；失败类型/消息变化时重新记录，便于定位。
      const signature = `${name}:${code ?? ''}:${message}`;
      if (signature !== lastFailure) {
        app.log.warn({ code: 'SCHEDULED_TASK_SCAN_FAILED',
          error_name: name, error_message: message,
          ...(code === null ? {} : { error_code: code }) },
        'scheduled_task_scan_failed');
      }
      lastFailure = signature;
    } finally {
      if (active) { timer = setTimeout(() => { inFlight = tick(); }, 1000); timer.unref(); }
    }
  };

  app.addHook('onReady', async () => { active = true; inFlight = tick(); await inFlight; });
  app.addHook('onClose', async () => { active = false; if (timer !== undefined) clearTimeout(timer); await inFlight; });
}
