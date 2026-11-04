import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunEffectActionRow, RunInvocationRow } from '../infrastructure/database-schema.js';
import { ManagedContentStore, contentHashOf } from '../storage/managed-content-store.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { applySafeControl } from './control-requests.js';
import { releaseComputerDesktopLeaseAtSafeBoundary } from './computer-desktop-lease.js';
import { reconcileGatewayInvocation } from './gateway-actions.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound, validationFailed } from './domain-error.js';

/** 扫描器报告租约到期或已持久 fence 的未决动作；候选本身不能证明旧进程停止。 */
export async function scanRecoveryCandidates(db: DbExecutor, limit = 100): Promise<readonly {
  readonly run_id: string; readonly worker_id: string;
}[]> {
  const rows = await createRepositories(db).recovery.listExpiredWorkerRuns(limit);
  return rows.map((row) => ({ run_id: row.id, worker_id: row.worker_id }));
}

/**
 * 把「Run 仍被旧 Worker 占用」落成一条人可见的系统事实：只写审计，不授予执行权、
 * 不改编 Run / Task 状态，也不代替任何恢复判定。同一 Run 与 Worker 只留一条；
 * 并发重复插入不改变结论，因此不为此引入第二套唯一索引。
 */
export async function noteStrandedWorker(db: DbExecutor, input: {
  readonly runId: string; readonly workerId: string;
}): Promise<boolean> {
  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(input.runId);
  if (run === undefined) return false;
  // Run 已被另一个 Worker 正常领取时，旧候选不再成立，不能写出过期事实。
  if (run.worker_id !== null && run.worker_id !== input.workerId) return false;
  if (await repositories.activities.hasRunRecoveryRequiredNotice(run.id, input.workerId)) return false;
  const task = await repositories.tasks.readTask(run.task_id);
  await repositories.activities.insertActivityRecord({
    id: randomUUID(), workspaceId: run.workspace_id, actorKind: 'SYSTEM',
    actorRef: 'recovery-scanner', commandId: null,
    projectId: task?.project_id ?? null, taskId: run.task_id, runId: run.id,
    eventType: 'RUN_RECOVERY_REQUIRED',
    factRefs: { run_id: run.id, worker_id: input.workerId,
      worker_epoch: run.worker_epoch.toString() },
  });
  return true;
}

/**
 * 进程管理器确认旧 Worker 已停止后的恢复入口。先 fence epoch，再在锁外核对受管 Fake 发布效果；
 * 已成功步骤不重跑，DISPATCHING 只使用同一 operation_id 核对，不凭租约盲重发。
 */
export async function recoverStoppedWorker(db: DbExecutor, input: {
  readonly runId: string;
  readonly stoppedWorkerId: string;
  readonly stoppedEvidence: string;
  readonly storage: ManagedContentStore;
  readonly hooks?: { readonly afterFence?: () => Promise<void> };
}): Promise<{ readonly fenced: boolean; readonly unresolved_operation_ids: readonly string[] }> {
  if (input.stoppedEvidence.trim() === '') throw invalidTransition('恢复必须提供旧 Worker 已停止的核对依据。');
  const fenced = await withTransaction(db, async (repositories) => {
    const { run, task } = await lockTaskAndRun(repositories, input.runId);
    if (run.worker_id === null) return false;
    if (run.worker_id !== input.stoppedWorkerId) throw invalidTransition('当前 Worker 已变化，不能核销另一个 Worker 的租约。');
    const stoppedWorkerEpoch = run.worker_epoch;
    const changed = await repositories.runs.fenceWorker(run.id);
    if (changed === undefined) throw new Error('worker fence failed');
    await repositories.recovery.insertWorkerFence({ runId: run.id,
      stoppedWorkerId: input.stoppedWorkerId, workerEpoch: changed.worker_epoch,
      stoppedEvidence: input.stoppedEvidence });
    await repositories.computerDesktopLease.unbindWorker({ runId: run.id,
      workerId: input.stoppedWorkerId, workerEpoch: stoppedWorkerEpoch });
    await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'SYSTEM',
      workspaceId: run.workspace_id, runId: run.id,
      actorRef: 'recovery-scanner', commandId: null, projectId: task.project_id, taskId: task.id,
      eventType: 'RUN_WORKER_FENCED', factRefs: { run_id: run.id, stopped_worker_id: input.stoppedWorkerId,
        stopped_evidence: input.stoppedEvidence, worker_epoch: changed.worker_epoch.toString() } });
    return true;
  });

  if (fenced) await input.hooks?.afterFence?.();

  const repositories = createRepositories(db);
  const effects = await repositories.recovery.listUnresolvedEffects(input.runId);
  const verifiedPublished = new Set<string>();
  for (const effect of effects) {
    if (effect.status !== 'DISPATCHING' && effect.status !== 'UNKNOWN' && effect.status !== 'SUCCEEDED') continue;
    const step = await repositories.runs.readStep(effect.step_id);
    const run = await repositories.runs.readRun(effect.run_id);
    if (step === undefined || run === undefined) throw resourceNotFound('Run effect');
    const draft = await repositories.runs.readStepByKind(run.id, 'DRAFT');
    const content = draft?.result_ref?.content;
    if (typeof content !== 'string') continue;
    const bytes = Buffer.from(content, 'utf8');
    if (!effect.params_hash.equals(contentHashOf(bytes))) continue;
    const read = await input.storage.readWithHashCheck(effect.target_ref,
      { contentHash: effect.params_hash, size: BigInt(bytes.byteLength) });
    if (read.status === 'OK') {
      if (effect.status !== 'SUCCEEDED') {
        await withTransaction(db, async (tx) => {
          await lockTaskAndRun(tx, effect.run_id);
          await tx.recovery.resolveEffect(effect.operation_id, effect.status,
            'SUCCEEDED', { reason: 'RECONCILED_PRESENT', target_ref: effect.target_ref,
              sha256: effect.params_hash.toString('hex') });
        });
      }
      await settlePublishedAttemptForPendingControl(db, effect, input.stoppedWorkerId);
      // A RUNNING attempt with a verified SUCCEEDED effect can be reclaimed by
      // the next invocation using this same attempt/operation ID. Its step is
      // not yet committed, but the external result is no longer ambiguous.
      verifiedPublished.add(effect.operation_id);
    } else if (read.status === 'MISSING') {
      if (effect.status === 'SUCCEEDED') {
        await markPublishedTargetUnknown(db, effect, read.status);
        continue;
      }
      if (effect.result_ref?.reason === 'PUBLISHED_TARGET_UNAVAILABLE') continue;
      // 进程可在 fence 提交后再次退出；持久 fence 记录允许重入，但旧 Worker 与 epoch 必须仍匹配。
      await withTransaction(db, async (tx) => {
        const { run: lockedRun } = await lockTaskAndRun(tx, effect.run_id);
        const attempt = await tx.runs.readAttempt(effect.attempt_id);
        if (lockedRun.worker_id !== null || attempt?.worker_id !== input.stoppedWorkerId ||
            !(await tx.recovery.hasWorkerFence(lockedRun.id, input.stoppedWorkerId, lockedRun.worker_epoch))) return;
        await tx.recovery.resetAbsentEffect(effect.operation_id, effect.status as 'DISPATCHING' | 'UNKNOWN');
      });
    } else {
      if (effect.status === 'SUCCEEDED') await markPublishedTargetUnknown(db, effect, read.status);
      else await withTransaction(db, async (tx) => {
        await lockTaskAndRun(tx, effect.run_id);
        await tx.recovery.resolveEffect(effect.operation_id, effect.status as 'DISPATCHING' | 'UNKNOWN',
          'UNKNOWN', { reason: `RECONCILE_${read.status}`, target_ref: effect.target_ref });
      });
    }
  }
  await settleStoppedPureAttemptsForPendingControl(db, input.runId, input.stoppedWorkerId);
  await applySafeControl(db, input.runId);
  await withTransaction(db, async (tx) => {
    await lockTaskAndRun(tx, input.runId);
    await releaseComputerDesktopLeaseAtSafeBoundary(tx, input.runId, true);
  });
  const unresolved = await repositories.recovery.listUnresolvedEffects(input.runId);
  const pendingControl = await repositories.recovery.findPendingControl(input.runId);
  return { fenced, unresolved_operation_ids: unresolved
    .filter((effect) => pendingControl !== undefined || effect.status !== 'SUCCEEDED' ||
      !verifiedPublished.has(effect.operation_id))
    .map((effect) => effect.operation_id) };
}

/** A stopped Worker cannot produce another pure-step result. An effect that reached
 * DISPATCHING or later remains owned by reconciliation, never by this cleanup. */
async function settleStoppedPureAttemptsForPendingControl(db: DbExecutor, runId: string,
  stoppedWorkerId: string): Promise<void> {
  await withTransaction(db, async (repositories) => {
    const { run } = await lockTaskAndRun(repositories, runId);
    if (run.worker_id !== null || !(await repositories.recovery.findPendingControl(run.id)) ||
        !(await repositories.recovery.hasWorkerFence(run.id, stoppedWorkerId, run.worker_epoch)) ||
        (await repositories.recovery.listUnresolvedEffects(run.id)).length > 0) return;
    for (const step of await repositories.runs.listSteps(run.id)) {
      if (step.status !== 'RUNNING') continue;
      for (const attempt of await repositories.runs.listAttempts(step.id)) {
        if (attempt.status !== 'RUNNING' || attempt.worker_id !== stoppedWorkerId) continue;
        const effect = await repositories.recovery.readEffectByAttempt(attempt.id);
        if (effect !== undefined && effect.status !== 'PREPARED' && effect.status !== 'FAILED') continue;
        if (effect?.status === 'PREPARED') {
          await repositories.recovery.resolveEffect(effect.operation_id, 'PREPARED', 'FAILED',
            { reason: 'CONTROL_PREEMPTED_BEFORE_DISPATCH' });
        }
        await repositories.runs.recordAttemptOutcome({ attemptId: attempt.id,
          expectedClaimEpoch: attempt.claim_epoch, status: 'FAILED', resultRef: null,
          evidence: { reason: 'CONTROL_PREEMPTED_AFTER_WORKER_STOP' } });
      }
    }
  });
}

async function markPublishedTargetUnknown(db: DbExecutor, effect: RunEffectActionRow,
  readStatus: 'MISSING' | 'TAMPERED' | 'UNREADABLE'): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockTaskAndRun(tx, effect.run_id);
    await tx.recovery.resolveEffect(effect.operation_id, 'SUCCEEDED', 'UNKNOWN',
      { reason: 'PUBLISHED_TARGET_UNAVAILABLE', read_status: readStatus,
        target_ref: effect.target_ref, prior_result_ref: effect.result_ref });
  });
}

/** 控制已等待且受管目标已核对时，结束未提交的尝试；发布文件作为可追溯孤儿保留。 */
async function settlePublishedAttemptForPendingControl(db: DbExecutor, effect: RunEffectActionRow,
  stoppedWorkerId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const { run } = await lockTaskAndRun(tx, effect.run_id);
    if (run.worker_id !== null || !(await tx.recovery.findPendingControl(run.id))) return;
    const attempt = await tx.runs.readAttempt(effect.attempt_id);
    if (attempt?.status !== 'RUNNING' || attempt.worker_id !== stoppedWorkerId ||
        !(await tx.recovery.hasWorkerFence(run.id, stoppedWorkerId, run.worker_epoch))) return;
    const currentEffect = await tx.recovery.readEffectByAttempt(attempt.id);
    if (currentEffect?.status !== 'SUCCEEDED') return;
    await tx.runs.recordAttemptOutcome({ attemptId: attempt.id, expectedClaimEpoch: attempt.claim_epoch,
      status: 'FAILED', resultRef: { operation_id: effect.operation_id, target_ref: effect.target_ref },
      evidence: { reason: 'CONTROL_PREEMPTED_AFTER_PUBLISH' } });
  });
}

/**
 * 一条已领取 Run 命令的停止恢复 Owner：先在会话锁内复核领取身份，再 fence、核对
 * 受管效果与 Gateway 在途操作，最后释放领取并把原命令重新排队。Supervisor 的
 * 子进程退出、桌面宿主的整次停机与受控 API 的人工停机核对走同一实现，差别只在
 * 「旧 Worker 已停止」的依据来源；桌面宿主还要在同一锁内先落 FILE_WRITE 停机证明，
 * 通过 `beforeFence` 钩子传入，返回 false 表示证明没落全（BLOCKED）。
 *
 * 返回值语义与既有 Supervisor 一致：
 *   * REQUEUED —— 恢复完成，原命令已回到 PENDING 等待重新派发；
 *   * BLOCKED  —— 有未决外部效果（UNKNOWN 等），等待人工核对后重入；
 *   * SKIPPED  —— 领取在锁内已被别人改变（另一个恢复者或 Worker 本人获胜）。
 */
export async function recoverStoppedClaim(db: DbExecutor, input: {
  readonly dataRoot: string;
  readonly claim: RunInvocationRow;
  readonly evidence: string;
  readonly beforeFence?: () => Promise<boolean>;
}): Promise<'REQUEUED' | 'BLOCKED' | 'SKIPPED'> {
  const claim = input.claim;
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
      if (input.beforeFence !== undefined && !(await input.beforeFence())) return 'BLOCKED';
      const recovered = await recoverStoppedWorker(db, {
        runId: claim.run_id, stoppedWorkerId: workerId, stoppedEvidence: input.evidence,
        storage: new ManagedContentStore(input.dataRoot),
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
          claim.run_id, workerId, claim.epoch, commandId, input.evidence);
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

/** 受控恢复回执：BLOCKED 时如实列出仍需要人工核对的外部操作。 */
export type RecoverRunResult = {
  readonly run_id: string;
  readonly outcome: 'REQUEUED' | 'BLOCKED' | 'SKIPPED';
  readonly fenced: boolean;
  readonly unresolved_operation_ids: readonly string[];
  /** BLOCKED 时的人工核对指引；REQUEUED/SKIPPED 为 null。 */
  readonly blocked_reason: string | null;
};

const STOP_EVIDENCE_MIN_CHARS = 8;
const STOP_EVIDENCE_MAX_CHARS = 2000;

/**
 * 公开恢复路由的应用 Owner（runtime-context §2.12 遗留：无 fence 的孤儿领取此前
 * 只能等 Supervisor 子进程退出证据或桌面宿主停机证明，没有受控入口）。
 *
 * 与 Supervisor 共用同一个 `recoverStoppedClaim`（命令幂等 → 会话锁复核 → fence →
 * 效果核对 → 重投），绝不绕过 Worker fence；「旧 Worker 已停止」由调用方提供的
 * 人工核对依据承载，并连同 command_id 一起写入持久 fence 事实。守卫按顺序如实拒绝：
 *   * Run 不存在或不在本 Workspace → 404；
 *   * 没有滞留领取（无 claim、已释放或已终态）→ 409 RUN_RECOVERY_NOT_REQUIRED；
 *   * 领取归属另一个 Worker → 409 RUN_RECOVERY_WORKER_MISMATCH（回执带当前归属）；
 *   * 领取租约未过期 → 409 RUN_RECOVERY_CLAIM_NOT_EXPIRED（健康 Worker 可能仍在跑，
 *     等租约过期或 Worker 心跳停止后再来；回执带 lease_until）。
 *
 * 幂等与回执由命令层保证：同一 command_id 重放返回原回执，不重复执行恢复。
 * 恢复本身在命令事务之外按既有实现提交多个短事务；命令事务只保存回执，进程在
 * 「恢复已提交、回执未写」之间崩溃时，重放同一命令只会得到一次 SKIPPED 复核。
 */
export async function recoverRunByHumanAttestation(db: DbExecutor, input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly stoppedWorkerId: string;
  readonly stopEvidence: string;
  readonly dataRoot: string;
}): Promise<CommandOutcome<RecoverRunResult>> {
  const stopEvidence = input.stopEvidence.trim();
  if (stopEvidence.length < STOP_EVIDENCE_MIN_CHARS || stopEvidence.length > STOP_EVIDENCE_MAX_CHARS) {
    throw validationFailed([{ field: 'stop_evidence',
      message: `停机依据需要 ${STOP_EVIDENCE_MIN_CHARS}–${STOP_EVIDENCE_MAX_CHARS} 字，说明核对到的具体事实（如进程已退出、OS 已确认）。` }]);
  }
  if (input.stoppedWorkerId.trim() === '') {
    throw validationFailed([{ field: 'stopped_worker_id',
      message: '需要提供被核对停止的 Worker 身份（RUN_RECOVERY_REQUIRED 事实里的 worker_id）。' }]);
  }
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'RecoverRun', target: { run_id: input.runId },
    body: { stopped_worker_id: input.stoppedWorkerId, stop_evidence: stopEvidence },
    execute: async () => {
      const repositories = createRepositories(db);
      const run = await repositories.runs.readRun(input.runId);
      if (run === undefined || run.workspace_id !== input.workspaceId) throw resourceNotFound('Run');
      const invocation = await repositories.dispatch.readInvocation(run.id);
      const strandedWorkerId = input.stoppedWorkerId.trim();
      if (invocation === undefined || invocation.worker_id === null ||
          !(invocation.status === 'ACTIVE' || invocation.status === 'STOP_REQUIRED')) {
        throw new DomainError({ code: 'RUN_RECOVERY_NOT_REQUIRED', status: 409,
          type: '/problems/run-recovery-not-required', title: '该 Run 没有滞留的 Worker 领取',
          detail: '当前没有等待恢复的 Worker 领取：领取已释放或 Run 已终态，不需要恢复。',
          retryable: false, retryAction: 'NONE' });
      }
      if (invocation.worker_id !== strandedWorkerId ||
          (run.worker_id !== null && run.worker_id !== strandedWorkerId)) {
        throw new DomainError({ code: 'RUN_RECOVERY_WORKER_MISMATCH', status: 409,
          type: '/problems/run-recovery-worker-mismatch',
          title: '领取归属另一个 Worker', detail:
            `当前领取归属 ${invocation.worker_id ?? '（未知）'}；请按最新的 RUN_RECOVERY_REQUIRED 事实重新核对后重试。`,
          retryable: true, retryAction: 'REFRESH_AND_REDECIDE' });
      }
      if (invocation.lease_until !== null && invocation.lease_until.getTime() > Date.now()) {
        throw new DomainError({ code: 'RUN_RECOVERY_CLAIM_NOT_EXPIRED', status: 409,
          type: '/problems/run-recovery-claim-not-expired',
          title: '领取租约尚未过期', detail:
            '租约仍然有效时旧 Worker 可能仍在执行；等租约过期（或确认 Worker 心跳已停止）再提交恢复。',
          retryable: true, retryAction: 'POLL_RESOURCE' });
      }
      const evidence = `human-attested:command=${input.commandId};${stopEvidence}`;
      const outcome = await recoverStoppedClaim(db, { dataRoot: input.dataRoot,
        claim: invocation, evidence });
      const freshRun = await repositories.runs.readRun(run.id);
      const unresolved = (await repositories.recovery.listUnresolvedEffects(run.id))
        .map((effect) => effect.operation_id);
      return {
        run_id: run.id,
        outcome,
        fenced: freshRun !== undefined && await repositories.recovery
          .hasWorkerFence(run.id, strandedWorkerId, freshRun.worker_epoch),
        unresolved_operation_ids: unresolved,
        blocked_reason: outcome === 'BLOCKED'
          ? '存在未能核对的外部操作（UNKNOWN）；请人工核对每个 operation 的真实结果后再重试恢复。'
          : null,
      } satisfies RecoverRunResult;
    },
  });
}
