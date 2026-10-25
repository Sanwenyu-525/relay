import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';

import { validateDatabaseUrl } from '../config/config.js';
import { validateModelPortConfig } from '../workflow/model-port-config.js';
import { FakeModelPort } from '../workflow/fake-model-port.js';
import { OpenAiCompatibleModelPort } from '../workflow/openai-compatible-model-port.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { RelayDatabase } from '../infrastructure/database.js';
import { graphCheckpointsReady } from '../infrastructure/graph-checkpoints.js';
import { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { assertRestoreNotIsolated, RestoreIsolationError } from '../runtime/restore-isolation.js';
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { runAssistGenerationTick } from '../application/assist-runner.js';
import { runConversationExecutionAutoStartTick }
  from '../application/conversation-execution-autostart.js';
import { runAssistGoalTick } from '../application/goal-advance.js';
import { runMemberWakeupTick } from '../application/member-wakeup.js';
import { runWebImportTick } from '../application/web-import-runner.js';
import { runOneCommand } from './run-command.js';
import { startBackgroundModelCatalogSync } from '../application/model-catalog-background-sync.js';

const MIGRATIONS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');
// Worker has its own pool, independent of RELAY_DB_POOL_MAX (API only).
// VERIFY holds one transaction connection while model_calls commits on another.
const WORKER_DATABASE_POOL_MAX = 4;
const once = process.argv.includes('--once');
const assistOnce = process.argv.includes('--assist-once');
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(signal, () => controller.abort());
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} invalid`);
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.RELAY_DB_URL?.trim();
  const dataRoot = process.env.RELAY_DATA_ROOT?.trim();
  const validDataRoot = dataRoot !== undefined && isAbsolute(dataRoot) &&
    await stat(dataRoot).then((item) => item.isDirectory(), () => false);
  if (databaseUrl === undefined || validateDatabaseUrl(databaseUrl) !== undefined ||
      dataRoot === undefined || !validDataRoot) {
    throw new Error('worker configuration invalid');
  }
  await assertRestoreNotIsolated(dataRoot);
  // A partially configured real model must fail the Worker before any delivery.
  validateModelPortConfig(process.env);
  const workerId = process.env.RELAY_WORKER_ID?.trim() || `worker:${randomUUID()}`;
  const pollMs = readInteger('RELAY_WORKER_POLL_MS', 250, 20, 60_000);
  const leaseMs = readInteger('RELAY_WORKER_LEASE_MS', 30_000, 100, 600_000);
  const fakeModelDelayMs = process.env.NODE_ENV === 'test'
    ? readInteger('RELAY_WORKER_TEST_MODEL_DELAY_MS', 0, 0, 60_000) : 0;
  const fileWriteEffectHoldMs = process.env.NODE_ENV === 'test' &&
    process.env.RELAY_WORKER_TEST_HOLD_AFTER_GATEWAY_EFFECT_MS
    ? readInteger('RELAY_WORKER_TEST_HOLD_AFTER_GATEWAY_EFFECT_MS', 0, 1, 120_000) : 0;
  const database = new RelayDatabase({
    databaseUrl, databasePoolMax: WORKER_DATABASE_POOL_MAX, databaseConnectTimeoutMs: 5_000,
  }, () => controller.abort());
  let stopCatalogRefresh: (() => Promise<void>) | undefined;
  try {
    const readiness = await database.checkReadiness(new SchemaReadinessChecker(MIGRATIONS_DIRECTORY));
    if (readiness.database !== 'up' || readiness.schema !== 'up') {
      throw new Error('worker database schema unavailable');
    }
    if (!(await graphCheckpointsReady(database.executor, databaseUrl))) {
      throw new Error('worker graph checkpoint schema unavailable');
    }
    process.stdout.write(`${JSON.stringify({ type: 'worker_ready', worker_id: workerId })}\n`);
    const storage = new ManagedContentStore(dataRoot);
    const catalogRefresh = startBackgroundModelCatalogSync({ db: database.executor,
      env: process.env, signal: controller.signal,
      onResult: (result) => {
        if (result.status === 'FAILED' || result.status === 'REJECTED') {
          process.stderr.write(`${JSON.stringify({ type: 'worker_model_catalog_sync',
            status: result.status, reason: result.reason })}\n`);
        }
      },
      onError: () => process.stderr.write(`${JSON.stringify({ type: 'worker_model_catalog_sync',
        status: 'FAILED', reason: 'UNEXPECTED' })}\n`),
    });
    stopCatalogRefresh = catalogRefresh.stop;
    const modelConfig = readModelPortConfig(process.env);
    const assistModelPort = modelConfig === undefined
      ? new FakeModelPort(fakeModelDelayMs)
      : new OpenAiCompatibleModelPort(modelConfig);
    while (!controller.signal.aborted) {
      const result = assistOnce ? undefined : await runOneCommand(database.executor, {
        workerId, dataRoot, checkpointUrl: databaseUrl, leaseMs, signal: controller.signal,
        ...(fakeModelDelayMs === 0 ? {} : { fakeModelDelayMs }),
        onClaim: async (claim) => {
          process.stdout.write(`${JSON.stringify({ type: 'worker_claimed', command_id: claim.commandId,
            run_id: claim.runId, epoch: claim.epoch.toString() })}\n`);
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_RESUME_CLAIM === 'true' &&
              claim.kind === 'RESUME') process.exit(95);
          // Deterministic integration fault point; never enabled by production configuration.
          if (process.env.NODE_ENV === 'test' && process.env.RELAY_WORKER_TEST_HOLD_MS !== undefined) {
            await new Promise((done) => setTimeout(done,
              readInteger('RELAY_WORKER_TEST_HOLD_MS', 0, 0, 60_000)));
          }
        },
        afterStep: async (step) => {
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_STEP_KIND ===
                (step.status === 'STEP_SUCCEEDED' ? step.step_kind : '')) {
            process.exit(93);
          }
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_APPROVAL_WAIT === 'true' &&
              step.status === 'STEP_SUCCEEDED' && step.run_status === 'WAITING_APPROVAL') {
            process.exit(92);
          }
        },
        afterGraph: async () => {
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_GRAPH === 'true') process.exit(94);
        },
        afterGatewayPrepared: async (prepared) => {
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_PREPARE === 'true' &&
              (prepared.status === 'WAITING' || prepared.status === 'PREPARED')) process.exit(96);
        },
        afterGatewayFakeEffect: async (claim) => {
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_EFFECT === 'true') process.exit(97);
          if (fileWriteEffectHoldMs > 0) {
            // This callback follows the FILE_WRITE adapter's durable receipt and precedes settlement.
            const staged = await sql<{ operation_id: string; invocation_id: string }>`
              select o.id as operation_id, i.id as invocation_id
              from logical_operations o join invocation_attempts i on i.operation_id = o.id
              where o.run_id = ${claim.runId} and o.capability_key = 'FILE_WRITE'
                and o.status = 'DISPATCHING' and i.status = 'DISPATCHING'
                and i.worker_id = ${claim.workerId} and i.result_ref ? 'file_write_receipt'
              order by i.created_at desc limit 1
            `.execute(database.executor);
            const receipt = staged.rows[0];
            if (receipt !== undefined) {
              process.stdout.write(`${JSON.stringify({ type: 'worker_file_write_receipt_staged',
                command_id: claim.commandId, run_id: claim.runId,
                operation_id: receipt.operation_id, invocation_id: receipt.invocation_id })}\n`);
              await new Promise((done) => setTimeout(done, fileWriteEffectHoldMs));
            }
          }
        },
        afterGatewayAdmit: async () => {
          if (process.env.NODE_ENV === 'test' &&
              process.env.RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_ADMIT === 'true') process.exit(98);
        },
      });
      if (result !== undefined) {
        process.stdout.write(`${JSON.stringify({ type: 'worker_settled', command_id: result.commandId,
          run_id: result.runId, outcome: result.outcome })}\n`);
      }
      // 两种一次性入口各自只领取其对应的工作，持续 Worker 则处理两者。
      if (!once) {
        const assist = await runAssistGenerationTick(database.executor, {
          workerId, storage, modelPort: assistModelPort, leaseMs, signal: controller.signal,
        });
        if (assist !== undefined) {
          process.stdout.write(`${JSON.stringify({ type: 'worker_assist_settled',
            message_id: assist.messageId, session_id: assist.sessionId, status: assist.status,
            ...(assist.errorCode === null ? {} : { error_code: assist.errorCode }) })}\n`);
        }
        if (!assistOnce) {
          const webImport = await runWebImportTick(database.executor, { signal: controller.signal });
          if (webImport.prepared + webImport.dispatched > 0) {
            process.stdout.write(`${JSON.stringify({ type: 'worker_web_import_tick',
              ...webImport })}\n`);
          }
          // 2026-10-20：已就绪的会话执行候选由服务端推进，不再等前端页面来喊这一声。
          // 页面关闭、刷新错过时机或另一台设备发起的请求都能继续；重复或迟到扫描只重放
          // 原请求行上固定的阶段命令身份，不产生第二个 Task/Run。
          const autoStart = await runConversationExecutionAutoStartTick(database.executor);
          if (autoStart.applied.length > 0 || autoStart.failed.length > 0) {
            process.stdout.write(`${JSON.stringify({ type: 'worker_conversation_autostart',
              applied: autoStart.applied.map((item) => item.requestId),
              failed: autoStart.failed })}\n`);
          }
          /*
           * 0127：`/goal` 的唯一推进 Owner。
           *
           * 每个 tick 做一次有界的工作单元：落定暂停/取消意图、结算已结束的轮次、
           * 在目标可推进时投递下一轮。它不依赖任何页面请求——关掉窗口、刷新、
           * 换设备都不影响；重启后按目标行上的状态与租约继续，重复扫描只重放同一轮次。
           */
          const goalTick = await runAssistGoalTick(database.executor, {
            workerId, leaseMs });
          if (goalTick.advanced.length > 0 || goalTick.settled.length > 0 ||
              goalTick.controls.length > 0) {
            process.stdout.write(`${JSON.stringify({ type: 'worker_goal_tick',
              advanced: goalTick.advanced, settled: goalTick.settled,
              controls: goalTick.controls })}\n`);
          }
          // 0141 / ADR-034 包 C：成员消息唤醒。同一 tick 里有界推进——归档/停用/
          // 外部成员不唤醒，租约清扫先于领取，回信只是协作记录不产生执行权。
          const memberWakeup = await runMemberWakeupTick(database.executor, {
            workerId, modelPort: assistModelPort, leaseMs, signal: controller.signal });
          if (memberWakeup.processed.length > 0 || memberWakeup.requeued > 0 ||
              memberWakeup.expiredFailed > 0) {
            process.stdout.write(`${JSON.stringify({ type: 'worker_member_wakeup',
              ...memberWakeup })}\n`);
          }
        }
      }
      if (once || assistOnce) break;
      if (result === undefined) {
        await new Promise<void>((done) => {
          const timer = setTimeout(done, pollMs);
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
        });
      }
    }
  } finally {
    await stopCatalogRefresh?.();
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  const configFailure = error instanceof RestoreIsolationError || error instanceof Error &&
    (error.message.includes('configuration') || error.message.includes('schema unavailable') ||
      error.message.endsWith(' invalid'));
  process.stderr.write(`${configFailure ? 'worker_configuration_failed' : 'worker_failed'}\n`);
  if (error instanceof RestoreIsolationError) {
    process.stderr.write(`${error.code}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? `${error.name}: ${error.message}`}\n`);
  } else {
    try {
      process.stderr.write(`worker failure non-error: ${JSON.stringify(error)}\n`);
    } catch {
      process.stderr.write('worker failure non-serializable\n');
    }
  }
  process.exitCode = configFailure ? 2 : 1;
}
