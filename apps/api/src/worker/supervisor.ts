import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunInvocationRow } from '../infrastructure/database-schema.js';
import { recoverStoppedClaim as recoverStoppedClaimCore } from '../application/recover-run.js';
import { createRepositories, withTransaction } from '../application/unit-of-work.js';

const WORKER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), 'main.js');

export interface SupervisedWorkerResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly requeuedRunIds: readonly string[];
  readonly blockedRunIds: readonly string[];
}

export interface StoppedClaimResults {
  readonly requeuedRunIds: readonly string[];
  readonly blockedRunIds: readonly string[];
}

export type DesktopStopEvidence = 'armed_job_terminated_and_active_count_zero' |
  'armed_job_absent_after_last_handle_closed';

/** The host has already checked and stopped the old launch's whole Windows Job. */
export async function recoverStoppedDesktopLaunch(input: {
  db: DbExecutor; dataRoot: string; launchId: string; stopEvidence: DesktopStopEvidence;
}): Promise<StoppedClaimResults> {
  const claims = await createRepositories(input.db).dispatch.findClaimsForDesktopLaunch(input.launchId);
  const workerPattern = new RegExp(`^worker:desktop:${input.launchId}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'u');
  const requeuedRunIds: string[] = [];
  const blockedRunIds: string[] = [];
  for (const claim of claims) {
    if (claim.worker_id === null || !workerPattern.test(claim.worker_id)) {
      blockedRunIds.push(claim.run_id);
      continue;
    }
    const outcome = await recoverStoppedClaim(input.db, input.dataRoot, claim,
      `desktop-launch:${input.launchId}:${input.stopEvidence}`,
      { launchId: input.launchId, stopEvidence: input.stopEvidence });
    if (outcome === 'REQUEUED') requeuedRunIds.push(claim.run_id);
    if (outcome === 'BLOCKED') blockedRunIds.push(claim.run_id);
  }
  return { requeuedRunIds, blockedRunIds };
}

/**
 * 常驻 Supervisor 看到过期领取时的唯一重入入口：只有 `run_worker_fences` 中的持久事实
 * 才能证明旧 Worker 已停止（例如上一次恢复已提交 fence、但在重投之前退出）。
 * 租约到期或 Supervisor 自身重启都不是停机证明，这两者只能产生人可见的滞留通知。
 */
export async function recoverStrandedFencedClaim(input: {
  db: DbExecutor; dataRoot: string; runId: string; workerId: string | null;
}): Promise<'REQUEUED' | 'BLOCKED' | 'SKIPPED' | 'NO_STOP_EVIDENCE'> {
  if (input.workerId === null) return 'NO_STOP_EVIDENCE';
  const repositories = createRepositories(input.db);
  const run = await repositories.runs.readRun(input.runId);
  // worker_id 非空说明当前 Run 仍归某个 Worker（可能就是旧进程本人），不能按租约抢占。
  if (run === undefined || run.worker_id !== null) return 'NO_STOP_EVIDENCE';
  const evidence = await repositories.recovery
    .readWorkerFenceEvidence(run.id, input.workerId, run.worker_epoch);
  if (evidence === undefined) return 'NO_STOP_EVIDENCE';
  const invocation = await repositories.dispatch.readInvocation(run.id);
  if (invocation === undefined) return 'NO_STOP_EVIDENCE';
  return recoverStoppedClaim(input.db, input.dataRoot, invocation, evidence);
}

async function recoverStoppedClaim(db: DbExecutor, dataRoot: string, claim: RunInvocationRow,
  evidence: string, desktop?: { launchId: string; stopEvidence: DesktopStopEvidence },
): Promise<'REQUEUED' | 'BLOCKED' | 'SKIPPED'> {
  // 恢复 Owner（锁复核 → fence → 效果核对 → 重投）在 application/recover-run.ts，
  // 与受控 API 的人工停机核对共用同一实现；这里只补充桌面宿主特有的 FILE_WRITE
  // 停机证明：宿主已确认旧 launch 的整个 Job 停止，在 fence 之前把确切写入身份落库。
  return recoverStoppedClaimCore(db, {
    dataRoot, claim, evidence,
    ...(desktop === undefined ? {} : {
      beforeFence: async () => {
        const workerId = claim.worker_id;
        const commandId = claim.command_id;
        if (workerId === null || commandId === null) return false;
        return withTransaction(db, async (tx) => {
          const run = await tx.runs.lockRun(claim.run_id);
          const lockedClaim = await tx.dispatch.lockInvocation(claim.run_id);
          if (run === undefined || lockedClaim?.worker_id !== workerId ||
              lockedClaim.epoch !== claim.epoch || lockedClaim.command_id !== commandId ||
              (lockedClaim.status !== 'ACTIVE' && lockedClaim.status !== 'STOP_REQUIRED')) return false;
          const candidates: { operationId: string; invocationId: string;
            workerEpoch: bigint; actionType: 'WRITE_FILE' | 'APPLY_CHANGESET' }[] = [];
          for (const operation of await tx.gateway.listUnresolvedRunOperations(claim.run_id)) {
            if (operation.capability_key !== 'FILE_WRITE' ||
                !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(operation.status)) continue;
            const lockedOperation = await tx.gateway.lockOperation(operation.id);
            const last = await tx.gateway.lastInvocation(operation.id);
            const invocation = last === undefined ? undefined : await tx.gateway.lockInvocation(last.id);
            if (lockedOperation?.run_id !== claim.run_id || invocation?.run_id !== claim.run_id ||
                invocation.operation_id !== operation.id || invocation.worker_id !== workerId ||
                invocation.worker_epoch === null ||
                !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(invocation.status) ||
                (run.worker_id !== null &&
                  (run.worker_id !== workerId || run.worker_epoch !== invocation.worker_epoch))) return false;
            const existing = await tx.fileWriteStopProofs.readByInvocation(invocation.id);
            if (existing === undefined &&
                (run.worker_id !== workerId || run.worker_epoch !== invocation.worker_epoch)) return false;
            candidates.push({ operationId: operation.id, invocationId: invocation.id,
              workerEpoch: invocation.worker_epoch,
              actionType: operation.action_type as 'WRITE_FILE' | 'APPLY_CHANGESET' });
          }
          for (const candidate of candidates) {
            await tx.fileWriteStopProofs.insertOnce({
              invocation_id: candidate.invocationId, operation_id: candidate.operationId,
              run_id: claim.run_id, worker_id: workerId, worker_epoch: candidate.workerEpoch,
              dispatch_epoch: claim.epoch, command_id: commandId, launch_id: desktop.launchId,
              stop_evidence: desktop.stopEvidence, action_type: candidate.actionType,
            });
          }
          return true;
        });
      },
    }),
  });
}

/**
 * A child close event is the stop evidence for the Mock Worker process. If the
 * supervisor itself dies, it cannot assert this evidence and the old claim stays
 * occupied. Future external-tool children need process-tree supervision too.
 */
export async function runSupervisedWorkerOnce(input: {
  db: DbExecutor;
  databaseUrl: string;
  dataRoot: string;
  task?: 'RUN' | 'ASSIST';
  workerId?: string;
  leaseMs?: number;
  testHoldMs?: number;
  testHoldAfterGatewayEffectMs?: number;
  testModelDelayMs?: number;
  testExitAfterApprovalWait?: boolean;
  testExitAfterStepKind?: string;
  testExitAfterGraph?: boolean;
  testExitAfterResumeClaim?: boolean;
  testExitAfterGatewayPrepare?: boolean;
  testExitAfterGatewayAdmit?: boolean;
  testExitAfterGatewayEffect?: boolean;
  onSpawn?: (child: ChildProcessWithoutNullStreams, workerId: string) => void;
  onOutput?: (line: string, child: ChildProcessWithoutNullStreams) => void;
}): Promise<SupervisedWorkerResult> {
  const workerId = input.workerId ?? `worker:${randomUUID()}`;
  const child = spawn(process.execPath, [WORKER_ENTRY,
    input.task === 'ASSIST' ? '--assist-once' : '--once'], {
    env: {
      ...process.env,
      RELAY_DB_URL: input.databaseUrl,
      RELAY_DATA_ROOT: input.dataRoot,
      RELAY_WORKER_ID: workerId,
      ...(input.leaseMs === undefined ? {} : { RELAY_WORKER_LEASE_MS: String(input.leaseMs) }),
      ...(input.testHoldMs === undefined ? {} : {
        NODE_ENV: 'test', RELAY_WORKER_TEST_HOLD_MS: String(input.testHoldMs),
      }),
      ...(input.testHoldAfterGatewayEffectMs === undefined ? {} : {
        NODE_ENV: 'test',
        RELAY_WORKER_TEST_HOLD_AFTER_GATEWAY_EFFECT_MS: String(input.testHoldAfterGatewayEffectMs),
      }),
      ...(input.testModelDelayMs === undefined ? {} : {
        NODE_ENV: 'test', RELAY_WORKER_TEST_MODEL_DELAY_MS: String(input.testModelDelayMs),
      }),
      ...(input.testExitAfterApprovalWait === true ? {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_APPROVAL_WAIT: 'true',
      } : {}),
      ...(input.testExitAfterStepKind === undefined ? {} : {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_STEP_KIND: input.testExitAfterStepKind,
      }),
      ...(input.testExitAfterGraph === true ? {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_GRAPH: 'true',
      } : {}),
      ...(input.testExitAfterResumeClaim === true ? {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_RESUME_CLAIM: 'true',
      } : {}),
      ...(input.testExitAfterGatewayPrepare === true ? {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_PREPARE: 'true',
      } : {}),
      ...(input.testExitAfterGatewayEffect === true ? {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_EFFECT: 'true',
      } : {}),
      ...(input.testExitAfterGatewayAdmit === true ? {
        NODE_ENV: 'test', RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_ADMIT: 'true',
      } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      input.onOutput?.(pending.slice(0, newline), child);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  input.onSpawn?.(child, workerId);
  const closed = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    child.once('error', fail);
    child.once('close', (exitCode, signal) => done({ exitCode, signal }));
  });
  const evidence = `mock-worker-child-close:pid=${child.pid ?? 'unknown'};code=${closed.exitCode ?? 'null'};signal=${closed.signal ?? 'null'};observed=${new Date().toISOString()}`;
  const claims = await createRepositories(input.db).dispatch.findClaimsForWorker(workerId);
  const requeuedRunIds: string[] = [];
  const blockedRunIds: string[] = [];
  for (const claim of claims) {
    const outcome = await recoverStoppedClaim(input.db, input.dataRoot, claim, evidence);
    if (outcome === 'REQUEUED') requeuedRunIds.push(claim.run_id);
    if (outcome === 'BLOCKED') blockedRunIds.push(claim.run_id);
  }
  return { ...closed, output, requeuedRunIds, blockedRunIds };
}
