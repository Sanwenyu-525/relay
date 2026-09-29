import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { validateDatabaseUrl } from '../config/config.js';
import { RelayDatabase } from '../infrastructure/database.js';
import { graphCheckpointsReady } from '../infrastructure/graph-checkpoints.js';
import { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { createRepositories } from '../application/unit-of-work.js';
import { applySafeControl } from '../application/control-requests.js';
import { recoverStoppedDesktopLaunch, runSupervisedWorkerOnce,
  type DesktopStopEvidence } from './supervisor.js';
import { desktopDispatchReadyLine, desktopLaunchRecoveryAckLine } from './desktop-supervisor-protocol.js';

const DESKTOP_SUPERVISOR_PROTOCOL = 'relay-desktop-supervisor-v1';
const MIGRATIONS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');
const DESKTOP_FRAME_LIMIT_BYTES = 1_048_576;
const MAX_STOPPED_LAUNCHES = 4096;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const desktopMode = process.env.RELAY_SUPERVISOR_DESKTOP_MODE === 'true';
const once = process.argv.includes('--once');
const controller = new AbortController();
let child: ChildProcessWithoutNullStreams | undefined;
const stop = (): void => {
  controller.abort();
  child?.kill('SIGTERM');
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(signal, stop);
}
if (desktopMode || process.env.RELAY_SUPERVISOR_STOP_ON_STDIN_EOF === 'true') {
  process.stdin.on('end', stop);
  process.stdin.resume();
}

interface DesktopStartupFrame {
  readonly nonce: string;
  readonly launchId: string;
  readonly stoppedLaunches: readonly { readonly launchId: string;
    readonly stopEvidence: DesktopStopEvidence }[];
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseDesktopFrame(bytes: Buffer): DesktopStartupFrame {
  let parsed: unknown;
  let encoded: string;
  try {
    encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`${DESKTOP_SUPERVISOR_PROTOCOL} configuration frame invalid`);
  }
  if (!exactObject(parsed, ['nonce', 'launchId', 'stoppedLaunches']) ||
      typeof parsed.nonce !== 'string' || !UUID_V4.test(parsed.nonce) ||
      typeof parsed.launchId !== 'string' || !UUID_V4.test(parsed.launchId) ||
      !Array.isArray(parsed.stoppedLaunches) ||
      parsed.stoppedLaunches.length > MAX_STOPPED_LAUNCHES) {
    throw new Error(`${DESKTOP_SUPERVISOR_PROTOCOL} configuration frame invalid`);
  }
  const keyCount = (name: string): number =>
    [...encoded.matchAll(new RegExp(`"${name}"\\s*:`, 'gu'))].length;
  if (keyCount('nonce') !== 1 || keyCount('stoppedLaunches') !== 1 ||
      keyCount('launchId') !== parsed.stoppedLaunches.length + 1 ||
      keyCount('stopEvidence') !== parsed.stoppedLaunches.length) {
    throw new Error(`${DESKTOP_SUPERVISOR_PROTOCOL} configuration frame invalid`);
  }
  const stoppedLaunches: DesktopStartupFrame['stoppedLaunches'][number][] = [];
  const seen = new Set<string>();
  for (const stopped of parsed.stoppedLaunches) {
    if (!exactObject(stopped, ['launchId', 'stopEvidence']) ||
        typeof stopped.launchId !== 'string' || !UUID_V4.test(stopped.launchId) ||
        stopped.launchId === parsed.launchId || seen.has(stopped.launchId) ||
        (stopped.stopEvidence !== 'armed_job_terminated_and_active_count_zero' &&
          stopped.stopEvidence !== 'armed_job_absent_after_last_handle_closed')) {
      throw new Error(`${DESKTOP_SUPERVISOR_PROTOCOL} configuration frame invalid`);
    }
    seen.add(stopped.launchId);
    stoppedLaunches.push({ launchId: stopped.launchId, stopEvidence: stopped.stopEvidence });
  }
  return { nonce: parsed.nonce, launchId: parsed.launchId, stoppedLaunches };
}

function readDesktopFrame(): Promise<DesktopStartupFrame> {
  return new Promise((done, fail) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    const reject = (): void => {
      cleanup();
      fail(new Error(`${DESKTOP_SUPERVISOR_PROTOCOL} configuration frame invalid`));
    };
    const onData = (chunk: Buffer): void => {
      if (buffered.byteLength + chunk.byteLength > DESKTOP_FRAME_LIMIT_BYTES) {
        reject();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffered.byteLength - 1) {
        reject();
        return;
      }
      try {
        const frame = parseDesktopFrame(buffered.subarray(0, newline));
        cleanup();
        process.stdin.on('data', stop);
        done(frame);
      } catch {
        reject();
      }
    };
    const onEnd = (): void => reject();
    const onError = (): void => reject();
    const timer = setTimeout(reject, 30_000);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
  });
}

async function readAcceptanceFileWriteHoldMs(dataRoot: string,
  desktopFrame: DesktopStartupFrame | undefined): Promise<number | undefined> {
  const raw = process.env.M06_ACCEPTANCE_FILE_WRITE_HOLD_MS;
  if (raw === undefined) return undefined;
  const holdMs = Number(raw);
  if (process.platform !== 'win32' || desktopFrame === undefined ||
      !/^[1-9][0-9]*$/u.test(raw) || holdMs > 120_000) {
    throw new Error('supervisor configuration invalid');
  }
  const physicalDataRoot = await realpath(dataRoot);
  const physicalTempRoot = await realpath(tmpdir());
  const sessionRoot = dirname(physicalDataRoot);
  if (basename(physicalDataRoot).toLowerCase() !== 'data' ||
      !/^relay-m02-acceptance-[0-9a-f]{32}$/iu.test(basename(sessionRoot)) ||
      dirname(sessionRoot).toLowerCase() !== physicalTempRoot.toLowerCase()) {
    throw new Error('supervisor configuration invalid');
  }
  return holdMs;
}

async function main(): Promise<void> {
  if (process.env.RELAY_SUPERVISOR_DESKTOP_MODE !== undefined && !desktopMode) {
    throw new Error('supervisor configuration invalid');
  }
  const desktopFrame = desktopMode ? await readDesktopFrame() : undefined;
  if (controller.signal.aborted) return;
  const databaseUrl = process.env.RELAY_DB_URL?.trim();
  const dataRoot = process.env.RELAY_DATA_ROOT?.trim();
  const validDataRoot = dataRoot !== undefined && isAbsolute(dataRoot) &&
    await stat(dataRoot).then((item) => item.isDirectory(), () => false);
  if (databaseUrl === undefined || validateDatabaseUrl(databaseUrl) !== undefined ||
      dataRoot === undefined || !validDataRoot) {
    throw new Error('supervisor configuration invalid');
  }
  const testHoldAfterGatewayEffectMs = await readAcceptanceFileWriteHoldMs(dataRoot, desktopFrame);
  const workerLeaseMs = Number(process.env.RELAY_WORKER_LEASE_MS ?? '30000');
  if (!Number.isInteger(workerLeaseMs) || workerLeaseMs < 100 || workerLeaseMs > 600_000) {
    throw new Error('supervisor configuration invalid');
  }
  const database = new RelayDatabase({
    databaseUrl, databasePoolMax: 4, databaseConnectTimeoutMs: 5_000,
  }, () => controller.abort());
  try {
    const readiness = await database.checkReadiness(new SchemaReadinessChecker(MIGRATIONS_DIRECTORY));
    if (readiness.database !== 'up' || readiness.schema !== 'up') {
      throw new Error('supervisor schema unavailable');
    }
    if (!(await graphCheckpointsReady(database.executor, databaseUrl))) {
      throw new Error('supervisor graph checkpoint schema unavailable');
    }
    if (controller.signal.aborted) return;
    process.stdout.write(`${JSON.stringify({ type: 'supervisor_ready',
      nonce: desktopFrame?.nonce ?? process.env.RELAY_SUPERVISOR_READY_NONCE ?? null,
      ...(desktopFrame === undefined ? {} : { launchId: desktopFrame.launchId }),
      nodeVersion: process.version })}\n`);
    if (desktopFrame !== undefined) {
      const requeuedRunIds: string[] = [];
      const blockedRunIds: string[] = [];
      for (const stopped of desktopFrame.stoppedLaunches) {
        if (controller.signal.aborted) return;
        const recovered = await recoverStoppedDesktopLaunch({
          db: database.executor, dataRoot, launchId: stopped.launchId,
          stopEvidence: stopped.stopEvidence,
        });
        if (controller.signal.aborted) return;
        requeuedRunIds.push(...recovered.requeuedRunIds);
        blockedRunIds.push(...recovered.blockedRunIds);
        const retainedClaims = await createRepositories(database.executor).dispatch
          .countClaimsForDesktopLaunch(stopped.launchId);
        if (controller.signal.aborted) return;
        process.stdout.write(desktopLaunchRecoveryAckLine({
          nonce: desktopFrame.nonce, launchId: stopped.launchId, retainedClaims,
        }));
      }
      if (controller.signal.aborted) return;
      process.stdout.write(desktopDispatchReadyLine({
        nonce: desktopFrame.nonce, launchId: desktopFrame.launchId,
        requeuedRunIds, blockedRunIds }));
    }
    const reported = new Set<string>();
    while (!controller.signal.aborted) {
      // A restarted supervisor cannot infer that a former child has stopped.
      // Surface the stranded claim without making it executable.
      for (const claim of await createRepositories(database.executor).dispatch.listExpiredInvocations(100)) {
        if (controller.signal.aborted) break;
        const key = `${claim.run_id}:${claim.epoch}`;
        if (!reported.has(key)) {
          reported.add(key);
          process.stdout.write(`${JSON.stringify({ type: 'worker_recovery_required',
            run_id: claim.run_id, epoch: claim.epoch.toString(), status: claim.status })}\n`);
        }
      }
      if (controller.signal.aborted) break;
      // A Worker can exit after releasing its invocation but before applying a
      // pending control. The database scan, not a child notification, closes
      // that gap after supervisor restart.
      let afterControl: { requestedAt: Date; id: string } | undefined;
      while (!controller.signal.aborted) {
        const controls = await createRepositories(database.executor).recovery
          .listIdlePendingControls(32, afterControl);
        if (controls.length === 0) break;
        for (const control of controls) {
          if (controller.signal.aborted) break;
          await applySafeControl(database.executor, control.run_id);
          afterControl = { requestedAt: control.requested_at, id: control.id };
        }
      }
      if (controller.signal.aborted) break;
      const pending = await createRepositories(database.executor).dispatch.listPending(1);
      if (controller.signal.aborted) break;
      if (pending.length > 0) {
        const result = await runSupervisedWorkerOnce({
          db: database.executor, databaseUrl, dataRoot,
          ...(desktopFrame === undefined ? {} : {
            workerId: `worker:desktop:${desktopFrame.launchId}:${randomUUID()}`,
          }),
          ...(process.env.NODE_ENV === 'test' ? {
            leaseMs: Number(process.env.RELAY_WORKER_LEASE_MS ?? '30000'),
            testHoldMs: Number(process.env.RELAY_WORKER_TEST_HOLD_MS ?? '0'),
          } : {}),
          ...(testHoldAfterGatewayEffectMs === undefined ? {} : { testHoldAfterGatewayEffectMs }),
          onSpawn: (spawned, workerId) => {
            child = spawned;
            process.stdout.write(`${JSON.stringify({ type: 'worker_started',
              pid: spawned.pid, worker_id: workerId })}\n`);
          },
        });
        child = undefined;
        process.stdout.write(`${JSON.stringify({ type: 'worker_exit', code: result.exitCode,
          requeued_run_ids: result.requeuedRunIds, blocked_run_ids: result.blockedRunIds })}\n`);
        if (result.exitCode !== 0 && !controller.signal.aborted) throw new Error('worker failed');
      }
      if (controller.signal.aborted) break;
      // One Run and one Assist delivery per pass keeps either backlog from starving the other.
      if (await createRepositories(database.executor).assist
        .hasRunnableGeneration(new Date(Date.now() - workerLeaseMs))) {
        if (controller.signal.aborted) break;
        const result = await runSupervisedWorkerOnce({
          db: database.executor, databaseUrl, dataRoot, task: 'ASSIST',
          ...(desktopFrame === undefined ? {} : {
            workerId: `worker:desktop:${desktopFrame.launchId}:${randomUUID()}`,
          }),
          ...(process.env.NODE_ENV === 'test' ? { leaseMs: workerLeaseMs } : {}),
          onSpawn: (spawned, workerId) => {
            child = spawned;
            process.stdout.write(`${JSON.stringify({ type: 'worker_started',
              pid: spawned.pid, worker_id: workerId })}\n`);
          },
        });
        child = undefined;
        process.stdout.write(`${JSON.stringify({ type: 'worker_exit', code: result.exitCode,
          requeued_run_ids: result.requeuedRunIds, blocked_run_ids: result.blockedRunIds })}\n`);
        if (result.exitCode !== 0 && !controller.signal.aborted) throw new Error('worker failed');
      }
      if (once) break;
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 250);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      });
    }
  } finally {
    child?.kill('SIGTERM');
    await database.close();
    process.stdin.pause();
  }
}

try {
  await main();
} catch (error) {
  process.stdin.pause();
  const configFailure = error instanceof Error &&
    (error.message.includes('configuration') || error.message.includes('schema unavailable'));
  process.stderr.write(`${configFailure ? 'supervisor_configuration_failed' : 'supervisor_failed'}\n`);
  process.exitCode = configFailure ? 2 : 1;
}
