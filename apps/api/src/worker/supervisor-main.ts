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
import { assertRestoreNotIsolated, RestoreIsolationError } from '../runtime/restore-isolation.js';
import { createRepositories } from '../application/unit-of-work.js';
import { applySafeControl } from '../application/control-requests.js';
import { runAssistGoalTick } from '../application/goal-advance.js';
import { noteStrandedWorker } from '../application/recover-run.js';
import { recoverStoppedDesktopLaunch, recoverStrandedFencedClaim, runSupervisedWorkerOnce,
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
/** 一轮内 Run 与 Assist 可同时运行，退出清理必须覆盖所有在跑子进程。 */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
const stop = (): void => {
  controller.abort();
  for (const running of liveChildren) running.kill('SIGTERM');
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
  await assertRestoreNotIsolated(dataRoot);
  const testHoldAfterGatewayEffectMs = await readAcceptanceFileWriteHoldMs(dataRoot, desktopFrame);
  const workerLeaseMs = Number(process.env.RELAY_WORKER_LEASE_MS ?? '30000');
  if (!Number.isInteger(workerLeaseMs) || workerLeaseMs < 100 || workerLeaseMs > 600_000) {
    throw new Error('supervisor configuration invalid');
  }
  // 2026-10-24 实机验收抓到的缺口（修复）：桌面 supervisor 按 `--once` / `--assist-once`
  // 按需拉起一次性 worker，而 goal tick 原本只在持续 Worker 的循环里运行——桌面拓扑下
  // worker 干完即退，PAUSING/CANCELLING 控制意图、轮次归一与下一轮投递在两次派发之间
  // 无人收口（实机一条 CANCELLING 停留 3 天；验收目标 PAUSING 停留至进程退出）。
  // supervisor 常驻，这里按时间闸调用**同一个** runAssistGoalTick：函数级唯一推进 Owner
  // 不变，租约与锁定行短事务保证与 worker tick 并发安全。0 表示每个 pass 都跑（测试用）。
  const goalTickIntervalMs = Number(process.env.RELAY_SUPERVISOR_GOAL_TICK_MS ?? '2000');
  if (!Number.isInteger(goalTickIntervalMs) || goalTickIntervalMs < 0 ||
      goalTickIntervalMs > 60_000) {
    throw new Error('supervisor configuration invalid');
  }
  let lastGoalTickAt = 0;
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
    const attempted = new Map<string, number>();
    const notified = new Set<string>();
    // 有 fence 证据时可以重试既有恢复 Owner；无证据时只保留事实。周期重试让
    // 「上次恢复已 fence 但随后被 UNKNOWN 外部效果挡住、之后被人工核对」的领取收口，
    // 且不会把租约到期当停机证明。
    const recoveryRetryMs = 30_000;
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
        if (Date.now() - (attempted.get(key) ?? 0) >= recoveryRetryMs) {
          attempted.set(key, Date.now());
          try {
            const outcome = await recoverStrandedFencedClaim({ db: database.executor, dataRoot,
              runId: claim.run_id, workerId: claim.worker_id });
            // 已释放领取：下一轮由正常派发接续，不再写滞留事实。
            if (outcome === 'REQUEUED') { attempted.delete(key); continue; }
          } catch {
            // 恢复竞争（领取/epoch 已变化）不应让常驻 Supervisor 退出；只留诊断，
            // 下一次重试按原证据与同一 operation_id 收口，不换身份或放宽判定。
            process.stderr.write(`${JSON.stringify({ type: 'worker_recovery_failed',
              run_id: claim.run_id })}\n`);
          }
        }
        if (!notified.has(key) && claim.worker_id !== null) {
          notified.add(key);
          await noteStrandedWorker(database.executor,
            { runId: claim.run_id, workerId: claim.worker_id });
        }
      }
      if (controller.signal.aborted) break;
      // 注意：不按 Run 级 worker 租约过期告警。Run 租约只在每步领取时刷新，
      // 单步（如长模型调用）可以超过 30s 而进程仍健康；`scanRecoveryCandidates`
      // 里的 Run 级候选因此不能当滞留事实，只有领取心跳（run_invocations）才可靠。
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
      const assistRunnable = await createRepositories(database.executor).assist
        .hasRunnableGeneration(new Date(Date.now() - workerLeaseMs));
      if (controller.signal.aborted) break;
      const dispatchLane = async (lane?: 'ASSIST'): Promise<void> => {
        let running: ChildProcessWithoutNullStreams | undefined;
        const result = await runSupervisedWorkerOnce({
          db: database.executor, databaseUrl, dataRoot,
          ...(lane === undefined ? {} : { task: lane }),
          ...(desktopFrame === undefined ? {} : {
            workerId: `worker:desktop:${desktopFrame.launchId}:${randomUUID()}`,
          }),
          ...(process.env.NODE_ENV === 'test' ? (lane === undefined ? {
            leaseMs: Number(process.env.RELAY_WORKER_LEASE_MS ?? '30000'),
            testHoldMs: Number(process.env.RELAY_WORKER_TEST_HOLD_MS ?? '0'),
          } : { leaseMs: workerLeaseMs }) : {}),
          ...(lane === undefined || testHoldAfterGatewayEffectMs === undefined
            ? {} : { testHoldAfterGatewayEffectMs }),
          onSpawn: (spawned, workerId) => {
            running = spawned;
            child = spawned;
            liveChildren.add(spawned);
            process.stdout.write(`${JSON.stringify({ type: 'worker_started',
              pid: spawned.pid, worker_id: workerId })}\n`);
          },
        });
        if (running !== undefined) liveChildren.delete(running);
        child = undefined;
        process.stdout.write(`${JSON.stringify({ type: 'worker_exit', code: result.exitCode,
          requeued_run_ids: result.requeuedRunIds, blocked_run_ids: result.blockedRunIds })}\n`);
        if (result.exitCode !== 0 && !controller.signal.aborted) throw new Error('worker failed');
      };
      // Run 与 Assist 在同一轮内各自判定后**并发**派发（不是交换顺序）：长 Run
      // 在跑时聊天仍能被派发，不再把 Run 的整个生命周期变成聊天的排队时间。
      // 每条车道每轮仍只派发一份工作，不引入第二套调度状态。
      const dispatched: Promise<void>[] = [];
      if (pending.length > 0) dispatched.push(dispatchLane());
      if (assistRunnable) dispatched.push(dispatchLane('ASSIST'));
      if (dispatched.length > 0) await Promise.all(dispatched);
      if (controller.signal.aborted) break;
      // 控制意图收口（见上方 goalTickIntervalMs 注释）：放在 assist 派发之后，
      // 刚结算完的在途轮次能在同一个 pass 里把 PAUSING/CANCELLING 归一。
      if (!controller.signal.aborted &&
          Date.now() - lastGoalTickAt >= goalTickIntervalMs) {
        lastGoalTickAt = Date.now();
        const goalTick = await runAssistGoalTick(database.executor, {
          workerId: `supervisor:${desktopFrame?.launchId ?? process.pid}`,
          leaseMs: workerLeaseMs });
        if (goalTick.advanced.length > 0 || goalTick.settled.length > 0 ||
            goalTick.controls.length > 0) {
          process.stdout.write(`${JSON.stringify({ type: 'supervisor_goal_tick',
            advanced: goalTick.advanced.length, settled: goalTick.settled.length,
            controls: goalTick.controls })}\n`);
        }
      }
      if (once) break;
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 250);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
      });
    }
  } finally {
    for (const running of liveChildren) running.kill('SIGTERM');
    await database.close();
    process.stdin.pause();
  }
}

try {
  await main();
} catch (error) {
  process.stdin.pause();
  const configFailure = error instanceof RestoreIsolationError || error instanceof Error &&
    (error.message.includes('configuration') || error.message.includes('schema unavailable'));
  process.stderr.write(`${configFailure ? 'supervisor_configuration_failed' : 'supervisor_failed'}\n`);
  if (error instanceof RestoreIsolationError) process.stderr.write(`${error.code}\n`);
  process.exitCode = configFailure ? 2 : 1;
}
