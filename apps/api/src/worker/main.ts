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
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { runAssistGenerationTick } from '../application/assist-runner.js';
import { runWebImportTick } from '../application/web-import-runner.js';
import { runOneCommand } from './run-command.js';

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
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  const configFailure = error instanceof Error &&
    (error.message.includes('configuration') || error.message.includes('schema unavailable') ||
      error.message.endsWith(' invalid'));
  process.stderr.write(`${configFailure ? 'worker_configuration_failed' : 'worker_failed'}\n`);
  if (error instanceof Error) {
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
