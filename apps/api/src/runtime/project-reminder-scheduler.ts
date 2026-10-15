import type { FastifyInstance } from 'fastify';
import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { createRepositories } from '../application/unit-of-work.js';
import { scanProjectReminders } from '../application/project-reminders.js';

/** 生命周期归 API/桌面子进程；没有退出后常驻任务，也不借 Run Worker 执行提醒。 */
export function registerProjectReminderScheduler(app: FastifyInstance, d: { database: RelayDatabase; schemaReadiness: SchemaReadinessChecker }) {
  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let openedAt: Date | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let failed = false;
  const tick = async () => {
    try {
      const readiness = await d.database.checkReadiness(d.schemaReadiness);
      if (readiness.database !== 'up' || readiness.schema !== 'up' || !active) return;
      openedAt ??= await createRepositories(d.database.executor).projectReminders.now();
      await scanProjectReminders(d.database.executor, openedAt);
      failed = false;
    } catch {
      if (!failed) app.log.warn({ code: 'REMINDER_SCAN_FAILED' }, 'project_reminder_scan_failed');
      failed = true;
    } finally {
      if (active) { timer = setTimeout(() => { inFlight = tick(); }, 1000); timer.unref(); }
    }
  };
  app.addHook('onReady', async () => { active = true; inFlight = tick(); await inFlight; });
  app.addHook('onClose', async () => { active = false; if (timer !== undefined) clearTimeout(timer); await inFlight; });
}
