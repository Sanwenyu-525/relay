import type { DbExecutor } from '../infrastructure/database.js';
import { applySafeControl } from './control-requests.js';
import { createRepositories, withTransaction } from './unit-of-work.js';

export interface ClaimedRunCommand {
  readonly commandId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly kind: 'START' | 'RESUME' | 'RECOVER';
  readonly reviewDecisionId: string | null;
  readonly workerId: string;
  readonly epoch: bigint;
}

const DEFAULT_LEASE_MS = 30_000;

/** Polling is the recovery path when all process notifications are lost. */
export async function claimNextRunCommand(db: DbExecutor, workerId: string,
  leaseMs = DEFAULT_LEASE_MS): Promise<ClaimedRunCommand | undefined> {
  if (workerId.trim() === '' || leaseMs < 100) throw new Error('invalid worker claim');
  const candidates = await createRepositories(db).dispatch.listPending(32);
  for (const candidate of candidates) {
    const claimed = await withTransaction(db, async (repositories) => {
      // Run first, then outbox and invocation. A competing Worker skips a locked
      // Run instead of waiting and accidentally starting a second invocation.
      if (!(await repositories.dispatch.tryLockRun(candidate.run_id))) return undefined;
      const run = await repositories.runs.readRun(candidate.run_id);
      const command = await repositories.dispatch.readCommand(candidate.command_id);
      const outbox = await repositories.dispatch.lockOutbox(candidate.command_id);
      const invocation = await repositories.dispatch.lockInvocation(candidate.run_id);
      if (run === undefined || command === undefined || outbox?.status !== 'PENDING' ||
        invocation === undefined) return undefined;

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        await repositories.dispatch.settlePending(command.id);
        return undefined;
      }

      if (await repositories.dispatch.hasUnsettledPredecessor(run.id, command.ordinal)) {
        return undefined;
      }

      const actionResume = command.review_decision_id === null ? false :
        await repositories.dispatch.isRunnableActionApprovalResume(command.review_decision_id, run.id);
      if (await repositories.dispatch.isActionApprovalResume(command.review_decision_id) &&
          !actionResume) return undefined;

      // Expiration fences database writes, but it does not prove the old process
      // has stopped. The old claim stays occupied until a supervisor witnesses exit.
      if (invocation.status !== 'IDLE' || run.worker_id !== null) return undefined;
      if (run.status === 'PAUSED' || (run.status === 'WAITING_APPROVAL' && !actionResume &&
          !(command.review_decision_id === null &&
            (command.kind === 'START' || command.kind === 'RECOVER')))) return undefined;

      const next = await repositories.dispatch.claimInvocation(run.id, command.id, workerId, leaseMs);
      await repositories.dispatch.claimOutbox(command.id, workerId, next.epoch);
      return {
        commandId: command.id, runId: run.id, workspaceId: run.workspace_id,
        kind: command.kind, reviewDecisionId: command.review_decision_id,
        workerId, epoch: next.epoch,
      } satisfies ClaimedRunCommand;
    });
    if (claimed !== undefined) return claimed;
  }
  return undefined;
}

export async function renewRunInvocation(db: DbExecutor, claim: ClaimedRunCommand,
  leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  return createRepositories(db).dispatch.renewInvocation(
    claim.runId, claim.workerId, claim.epoch, leaseMs);
}

/** Only the current, unexpired invocation can acknowledge delivery. */
export async function settleRunCommand(db: DbExecutor, claim: ClaimedRunCommand,
  status: 'DONE' | 'BLOCKED', holdForRecovery = false): Promise<boolean> {
  const settled = await withTransaction(db, async (repositories) => {
    if (!(await repositories.dispatch.tryLockRun(claim.runId))) return false;
    const invocation = await repositories.dispatch.lockInvocation(claim.runId);
    const outbox = await repositories.dispatch.lockOutbox(claim.commandId);
    if (invocation?.status !== 'ACTIVE' || invocation.worker_id !== claim.workerId ||
      invocation.epoch !== claim.epoch || invocation.command_id !== claim.commandId ||
      !(await repositories.dispatch.hasCurrentInvocation(claim.runId, claim.workerId, claim.epoch)) ||
      outbox?.status !== 'CLAIMED' || outbox.claim_epoch !== claim.epoch ||
      outbox.worker_id !== claim.workerId) return false;
    await repositories.dispatch.settleOutbox(claim.commandId, status, claim.workerId, claim.epoch);
    if (holdForRecovery) {
      await repositories.dispatch.requireStop(claim.runId, claim.workerId, claim.epoch);
    } else {
      await repositories.dispatch.releaseInvocation(claim.runId, claim.workerId, claim.epoch);
    }
    return true;
  });
  if (settled && !holdForRecovery) await applySafeControl(db, claim.runId);
  return settled;
}
