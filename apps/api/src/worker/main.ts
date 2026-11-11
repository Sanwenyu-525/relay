import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';

import { validateDatabaseUrl, DEFAULT_MAX_CONCURRENT_EXECUTIONS } from '../config/config.js';
import { applyCredentialEnvFromStore, CredentialEnvError } from '../credentials/credential-env.js';
import { validateModelPortConfig } from '../workflow/model-port-config.js';
import { FakeModelPort, isFakeModelPort } from '../workflow/fake-model-port.js';
import { createModelPort } from '../workflow/model-port-factory.js';
import { readModelPortConfig } from '../workflow/model-port-config.js';
import { RelayDatabase } from '../infrastructure/database.js';
import { graphCheckpointsReady } from '../infrastructure/graph-checkpoints.js';
import { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { assertRestoreNotIsolated, RestoreIsolationError } from '../runtime/restore-isolation.js';
import type { RuntimeLogLevel } from '../infrastructure/runtime-log.js';
import { configureRuntimeLog, getRuntimeLogger } from '../infrastructure/runtime-log.js';
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { runAssistGenerationTick } from '../application/assist-runner.js';
import { runConversationExecutionAutoStartTick }
  from '../application/conversation-execution-autostart.js';
import { runAssistGoalTick } from '../application/goal-advance.js';
import { runMemberWakeupTick } from '../application/member-wakeup.js';
import { planExecutionAdmission, executionConcurrencyGateEnabled }
  from '../application/execution-concurrency.js';
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
  // P2：Worker 与 API 各自是独立进程，必须各自物化凭据引用；否则会出现「API 认得这个连接、
  // Worker 认为未配置」的分裂身份，而 Worker 才是真正发起模型调用的那一侧。
  // 必须在 validateModelPortConfig 之前完成：否则只有引用没有明文时会被判成配置残缺。
  await applyCredentialEnvFromStore(process.env);
  const databaseUrl = process.env.RELAY_DB_URL?.trim();
  const dataRoot = process.env.RELAY_DATA_ROOT?.trim();
  const validDataRoot = dataRoot !== undefined && isAbsolute(dataRoot) &&
    await stat(dataRoot).then((item) => item.isDirectory(), () => false);
  if (databaseUrl === undefined || validateDatabaseUrl(databaseUrl) !== undefined ||
      dataRoot === undefined || !validDataRoot) {
    throw new Error('worker configuration invalid');
  }
  await assertRestoreNotIsolated(dataRoot);
  // Worker is a separate process: its log must land in its own file, because desktop
  // mode disables the Fastify logger entirely.
  configureRuntimeLog({
    directory: resolve(dataRoot, 'logs'),
    fileName: 'relay-worker.log',
    level: (process.env.RELAY_LOG_LEVEL?.trim() ?? 'info') as RuntimeLogLevel,
    echoToStderr: true,
  });
  // A partially configured real model must fail the Worker before any delivery.
  validateModelPortConfig(process.env);
  const workerId = process.env.RELAY_WORKER_ID?.trim() || `worker:${randomUUID()}`;
  const pollMs = readInteger('RELAY_WORKER_POLL_MS', 250, 20, 60_000);
  const leaseMs = readInteger('RELAY_WORKER_LEASE_MS', 30_000, 100, 600_000);
  // 系统级执行并发上界（runtime-context §2.12「并发上限」）：与常驻 API 同一 env，
  // 非法值按配置错误拒绝（与其余 RELAY_WORKER_* 整数一致）。
  const maxConcurrentExecutions = readInteger('RELAY_MAX_CONCURRENT_EXECUTIONS',
    DEFAULT_MAX_CONCURRENT_EXECUTIONS, 1, 64);
  getRuntimeLogger('worker').info('worker_started', {
    worker_id: workerId, poll_ms: pollMs, lease_ms: leaseMs,
    max_concurrent_executions: maxConcurrentExecutions,
  });
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
    // B1（OVERALL-FIX-20261104-B HANDOFF §1.2）：无真实模型配置不再构造离线 Fake——
    // 聊天回复与成员回信都不能是 Mock 文本落成真实消息。无配置时两个模型 tick 跳过
    // （消息留在 PENDING 的诚实排队态，配置后下一拍自然继续），启动时留一条一次性事实。
    // 集成测试经 RELAY_TEST_ALLOW_FAKE_MODEL=1（run-integration.ps1 显式设置，生产绝不
    // 设置）显式放行离线 Fixture，与 Run 侧 legacyAdmission 的测试放行同一口径。
    const allowTestFakeModelPort = process.env.RELAY_TEST_ALLOW_FAKE_MODEL === '1';
    const assistModelPort = modelConfig === undefined
      ? (allowTestFakeModelPort ? new FakeModelPort(fakeModelDelayMs) : undefined)
      : createModelPort(modelConfig);
    if (assistModelPort === undefined) {
      process.stderr.write(`${JSON.stringify({ type: 'worker_model_unavailable',
        code: 'BACKGROUND_MODEL_UNAVAILABLE' })}\n`);
    }
    // test 环境默认不启用并发闸（既有崩溃用例遗留在途行会把闸变成抖动源）；
    // 显式设置 RELAY_MAX_CONCURRENT_EXECUTIONS 即为显式开启。
    const concurrencyGateActive = executionConcurrencyGateEnabled();
    let throttled = false;
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
        // 系统级并发闸（runtime-context §2.12「并发上限」）：只约束**新领取的执行**
        // （会话生成、成员唤醒这两类模型调用）；控制意图收口（goal tick）与候选推进
        // 不被闸住——用户取消不能排在容量后面。读不到在途数按不可执行处理，宁可
        // 少一拍；被闸住的候选下一拍自然再试，这里只留一条可观测事实（状态变化时）。
        const admission = concurrencyGateActive
          ? await planExecutionAdmission(database.executor, maxConcurrentExecutions)
          : { admitted: true as const, active: 0, cap: maxConcurrentExecutions };
        if (!admission.admitted) {
          if (!throttled) {
            throttled = true;
            process.stderr.write(`${JSON.stringify({ type: 'worker_execution_throttled',
              active_executions: admission.active, concurrency_cap: admission.cap })}\n`);
          }
        } else {
          throttled = false;
          if (assistModelPort !== undefined) {
            const assist = await runAssistGenerationTick(database.executor, {
              workerId, storage, modelPort: assistModelPort, leaseMs, signal: controller.signal,
            });
            if (assist !== undefined) {
              process.stdout.write(`${JSON.stringify({ type: 'worker_assist_settled',
                message_id: assist.messageId, session_id: assist.sessionId, status: assist.status,
                ...(assist.errorCode === null ? {} : { error_code: assist.errorCode }) })}\n`);
            }
            if (!assistOnce) {
              // 0141 / ADR-034 包 C：成员消息唤醒。同一 tick 里有界推进——归档/停用/
              // 外部成员不唤醒，租约清扫先于领取，回信只是协作记录不产生执行权。
              // 测试显式放行的 Fake 端口需配套放行（B1：生产调用方不设置该选项）。
              const memberWakeup = await runMemberWakeupTick(database.executor, {
                workerId, modelPort: assistModelPort, leaseMs, signal: controller.signal,
                ...(isFakeModelPort(assistModelPort)
                  ? { testOnlyAllowFakeModelPort: true } : {}) });
              if (memberWakeup.processed.length > 0 || memberWakeup.requeued > 0 ||
                  memberWakeup.expiredFailed > 0) {
                process.stdout.write(`${JSON.stringify({ type: 'worker_member_wakeup',
                  ...memberWakeup })}\n`);
              }
            }
          }
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
    await closeWorkerRuntime(database, stopCatalogRefresh);
  }
  /*
   * 一次性入口（桌面 Supervisor 按需派发的 `--once` / `--assist-once`）必须真的结束进程
   * （2026-11-10）。
   *
   * 此前只依赖事件循环自然清空：一次真实调用之后如果还有 keep-alive 连接或第三方句柄挂着，
   * 进程就会在「消息已经 COMPLETED、数据库连接已经空闲」的状态下一直存活。桌面 Supervisor
   * 按子进程退出推进派发，于是它不再派发下一条消息——聊天一直停在「等待处理」，过程区、
   * 流式草稿全部看不到（2026-11-10 实机复现：worker_started 后没有 worker_exit）。
   * 结算已经提交，这里显式退出只结束进程，不改写任何业务事实。
   */
  if (once || assistOnce) {
    getRuntimeLogger('worker').info('worker_one_shot_exit', {
      mode: assistOnce ? 'ASSIST' : 'RUN', worker_id: workerId,
    });
    process.exit(0);
  }
}

/**
 * 关闭运行时（2026-11-10）：目录刷新的收尾与连接池关闭都必须有界。
 * 目录刷新是附带收益，它不是 Worker 退出的前置条件；池关闭也最多等 5 秒。
 * 超时如实记一条日志再继续——卡住的收尾不能反过来阻断 Supervisor 的下一拍派发。
 */
async function closeWorkerRuntime(
  database: RelayDatabase, stopCatalogRefresh: (() => Promise<void>) | undefined,
): Promise<void> {
  const CLOSE_TIMEOUT_MS = 5_000;
  let timedOut = false;
  const close = (async (): Promise<void> => {
    await stopCatalogRefresh?.();
    await database.close();
  })();
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => { timedOut = true; resolve(); }, CLOSE_TIMEOUT_MS);
    timer.unref();
  });
  await Promise.race([close, timeout]);
  if (timedOut) {
    getRuntimeLogger('worker').error('worker_close_timed_out', { timeout_ms: CLOSE_TIMEOUT_MS });
  }
}

try {
  await main();
} catch (error) {
  const configFailure = error instanceof RestoreIsolationError || error instanceof CredentialEnvError ||
    error instanceof Error &&
    (error.message.includes('configuration') || error.message.includes('schema unavailable') ||
      error.message.endsWith(' invalid'));
  process.stderr.write(`${configFailure ? 'worker_configuration_failed' : 'worker_failed'}\n`);
  getRuntimeLogger('worker').error(configFailure ? 'worker_configuration_failed' : 'worker_failed', {
    error_name: error instanceof Error ? error.name : 'NON_ERROR',
    error_message: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof RestoreIsolationError) {
    process.stderr.write(`${error.code}\n`);
  } else if (error instanceof CredentialEnvError) {
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
