import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { RunEffectActionRow } from '../infrastructure/database-schema.js';
import { contentHashOf, type ManagedContentStore } from '../storage/managed-content-store.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
import { lockTaskAndRun } from './lock-task-run.js';
import { applySafeControl } from './control-requests.js';
import { invalidTransition, resourceNotFound } from './domain-error.js';

/** 扫描器报告租约到期或已持久 fence 的未决动作；候选本身不能证明旧进程停止。 */
export async function scanRecoveryCandidates(db: DbExecutor, limit = 100): Promise<readonly {
  readonly run_id: string; readonly worker_id: string;
}[]> {
  const rows = await createRepositories(db).recovery.listExpiredWorkerRuns(limit);
  return rows.map((row) => ({ run_id: row.id, worker_id: row.worker_id }));
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
    const changed = await repositories.runs.fenceWorker(run.id);
    if (changed === undefined) throw new Error('worker fence failed');
    await repositories.activities.insertActivityRecord({ id: randomUUID(), actorKind: 'SYSTEM',
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
