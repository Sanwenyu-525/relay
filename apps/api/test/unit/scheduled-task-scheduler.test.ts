import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { registerScheduledTaskScheduler } from '../../src/runtime/scheduled-task-scheduler.js';

test('定时扫描失败时日志带异常名、消息与错误码，同一失败只记一次', async () => {
  const hooks = new Map<string, (() => Promise<void> | void)[]>();
  const warnings: Record<string, unknown>[] = [];
  const app = {
    addHook: (name: string, listener: () => Promise<void> | void): void => {
      const list = hooks.get(name) ?? [];
      list.push(listener);
      hooks.set(name, list);
    },
    log: { warn: (bindings: Record<string, unknown>): void => { warnings.push(bindings); } },
  } as unknown as FastifyInstance;
  const database = {
    checkReadiness: async (): Promise<never> => {
      const error = new Error('database is down') as Error & { code?: string };
      error.code = 'ECONNREFUSED';
      throw error;
    },
    executor: {} as never,
  };
  registerScheduledTaskScheduler(app, { database: database as never, schemaReadiness: {} as never });
  try {
    await hooks.get('onReady')?.[0]?.();
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], {
      code: 'SCHEDULED_TASK_SCAN_FAILED',
      error_name: 'Error',
      error_message: 'database is down',
      error_code: 'ECONNREFUSED',
    });
  } finally {
    await hooks.get('onClose')?.[0]?.();
  }
});
