import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunInvocationRow } from '../infrastructure/database-schema.js';
import { ManagedContentStore } from '../storage/managed-content-store.js';
import { recoverStoppedWorker } from '../application/recover-run.js';
import { reconcileGatewayInvocation } from '../application/gateway-actions.js';
import { applySafeControl } from '../application/control-requests.js';
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

async function recoverStoppedClaim(db: DbExecutor, dataRoot: string, claim: RunInvocationRow,
  evidence: string, desktop?: { launchId: string; stopEvidence: DesktopStopEvidence },
): Promise<'REQUEUED' | 'BLOCKED' | 'SKIPPED'> {
  if (claim.worker_id === null || claim.command_id === null) return 'BLOCKED';
  const workerId = claim.worker_id;
  const commandId = claim.command_id;
  // Session lock spans the external content check without holding a business
  // transaction open. A second supervisor rechecks the claim after this lock.
  const key = createHash('sha256').update(`relay:stopped-run:${claim.run_id}`).digest().readBigInt64BE(0);
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(${key})`.execute(connection);
    try {
      const current = await createRepositories(db).dispatch.readInvocation(claim.run_id);
      if (current?.worker_id !== workerId || current.epoch !== claim.epoch ||
          current.command_id !== commandId ||
          (current.status !== 'ACTIVE' && current.status !== 'STOP_REQUIRED')) return 'SKIPPED';
      if (desktop !== undefined) {
        // The host confirmed the old launch's whole Job is stopped. Persist the
        // exact FILE_WRITE identity while the outer claim still has its session
        // lock and before recoverStoppedWorker fences the inner Run worker.
        const proofReady = await withTransaction(db, async (tx) => {
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
        if (!proofReady) return 'BLOCKED';
      }
      const recovered = await recoverStoppedWorker(db, {
        runId: claim.run_id, stoppedWorkerId: workerId, stoppedEvidence: evidence,
        storage: new ManagedContentStore(dataRoot),
      });
      let gatewayBlocked = false;
      const gateway = createRepositories(db).gateway;
      for (const operation of await gateway.listUnresolvedRunOperations(claim.run_id)) {
        if (!['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(operation.status)) continue;
        const invocation = await gateway.lastInvocation(operation.id);
        if (invocation === undefined || invocation.worker_id !== workerId ||
            invocation.worker_epoch === null ||
            !['PREPARED', 'DISPATCHING', 'UNKNOWN'].includes(invocation.status)) {
          gatewayBlocked = true;
          continue;
        }
        const result = await reconcileGatewayInvocation(db, {
          workspaceId: operation.workspace_id, operationId: operation.id,
          invocationId: invocation.id, stoppedWorkerId: workerId,
          stoppedWorkerEpoch: invocation.worker_epoch, oldProcessStopped: true,
        });
        if (result.status === 'UNKNOWN') gatewayBlocked = true;
      }
      if (gatewayBlocked || recovered.unresolved_operation_ids.length > 0) return 'BLOCKED';
      await applySafeControl(db, claim.run_id);
      const requeued = await withTransaction(db, async (repositories) => {
        await repositories.runs.lockRun(claim.run_id);
        const locked = await repositories.dispatch.lockInvocation(claim.run_id);
        if (locked?.worker_id !== workerId || locked.epoch !== claim.epoch ||
            locked.command_id !== commandId) return false;
        await repositories.dispatch.lockOutbox(commandId);
        await repositories.dispatch.requeueStoppedClaim(
          claim.run_id, workerId, claim.epoch, commandId, evidence);
        return true;
      });
      if (requeued) await applySafeControl(db, claim.run_id);
      return requeued ? 'REQUEUED' : 'SKIPPED';
    } finally {
      const unlocked = await sql<{ unlocked: boolean }>`
        select pg_advisory_unlock(${key}) as unlocked
      `.execute(connection);
      if (!unlocked.rows[0]?.unlocked) throw new Error('stopped Run recovery lock was lost');
    }
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
