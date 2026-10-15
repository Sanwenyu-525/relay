import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
const COMMAND_COLUMNS = sql.raw('id, workspace_id, run_id, source_command_id, kind, ordinal, review_decision_id, created_at');
const OUTBOX_COLUMNS = sql.raw('command_id, status, claim_epoch, worker_id, claimed_at, settled_at, updated_at');
const INVOCATION_COLUMNS = sql.raw('run_id, epoch, status, worker_id, command_id, lease_until, stop_evidence, updated_at');
export class RunDispatchRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async tryLockRun(runId) {
        const result = await sql `
      select id from runs where id = ${runId} for update skip locked
    `.execute(this.db);
        return result.rows.length === 1;
    }
    async insertInvocation(runId) {
        await sql `insert into run_invocations (run_id) values (${runId})`.execute(this.db);
    }
    async insertCommand(input) {
        const lockedRun = await sql `
      select id from runs where id = ${input.runId} for update
    `.execute(this.db);
        requireRow(lockedRun.rows, 'lock Run before command order allocation');
        const next = await sql `
      select (coalesce(max(ordinal), 0) + 1)::bigint as ordinal
      from run_commands where run_id = ${input.runId}
    `.execute(this.db);
        const result = await sql `
      insert into run_commands (id, workspace_id, run_id, source_command_id, kind, ordinal, review_decision_id)
      values (${input.id}, ${input.workspaceId}, ${input.runId}, ${input.sourceCommandId},
        ${input.kind}, ${requireRow(next.rows, 'next Run command ordinal').ordinal},
        ${input.reviewDecisionId ?? null})
      returning ${COMMAND_COLUMNS}
    `.execute(this.db);
        await sql `
      insert into run_command_outbox (command_id) values (${input.id})
    `.execute(this.db);
        return requireRow(result.rows, 'insert into run_commands');
    }
    async listPending(limit) {
        const result = await sql `
      select o.command_id, c.run_id
      from run_command_outbox o
      join run_commands c on c.id = o.command_id
      join runs r on r.id = c.run_id
      join run_invocations i on i.run_id = c.run_id
      where o.status = 'PENDING'
        and (r.status in ('COMPLETED', 'FAILED', 'CANCELLED')
          or (i.status = 'IDLE' and r.worker_id is null
            and (r.status <> 'PAUSED' and (r.status <> 'WAITING_APPROVAL'
              or (c.kind in ('START', 'RECOVER') and c.review_decision_id is null)
              or exists (
              select 1 from review_decisions decision
              join review_requests review on review.id = decision.review_id
              join logical_operations operation on operation.id = review.operation_id
              where decision.id = c.review_decision_id and c.kind = 'RESUME'
                and decision.decision = 'APPROVE' and review.kind = 'ACTION_APPROVAL'
                and review.status = 'DECIDED' and review.run_id = c.run_id
                and review.target_hash = decision.target_hash
                and operation.run_id = c.run_id and (
                  (operation.status = 'WAITING_APPROVAL' and r.status = 'WAITING_APPROVAL'
                    and (review.expires_at is null or review.expires_at > clock_timestamp()))
                  or (operation.status = 'PREPARED' and r.status = 'RUNNING')
                  or operation.status = 'SUCCEEDED'
                )
            )))
            and not exists (
              select 1 from run_commands previous
              join run_command_outbox prior on prior.command_id = previous.id
              where previous.run_id = c.run_id and previous.ordinal < c.ordinal
                and prior.status <> 'DONE'
            )
            and (not exists (
              select 1 from review_decisions decision
              join review_requests review on review.id = decision.review_id
              where decision.id = c.review_decision_id and review.kind = 'ACTION_APPROVAL'
            ) or exists (
              select 1 from review_decisions decision
              join review_requests review on review.id = decision.review_id
              join logical_operations operation on operation.id = review.operation_id
              where decision.id = c.review_decision_id and review.kind = 'ACTION_APPROVAL'
                and decision.decision = 'APPROVE' and review.status = 'DECIDED'
                and review.run_id = c.run_id and operation.run_id = c.run_id
                and ((r.status = 'WAITING_APPROVAL' and operation.status = 'WAITING_APPROVAL'
                  and (review.expires_at is null or review.expires_at > clock_timestamp()))
                  or (r.status = 'RUNNING' and operation.status = 'PREPARED')
                  or operation.status = 'SUCCEEDED')
            ))
            ))
      order by o.updated_at, o.command_id
      limit ${limit}
    `.execute(this.db);
        return result.rows;
    }
    async readCommand(commandId) {
        const result = await sql `
      select ${COMMAND_COLUMNS} from run_commands where id = ${commandId}
    `.execute(this.db);
        return result.rows[0];
    }
    async hasUnsettledPredecessor(runId, ordinal) {
        const result = await sql `
      select exists (
        select 1 from run_commands previous
        join run_command_outbox prior on prior.command_id = previous.id
        where previous.run_id = ${runId} and previous.ordinal < ${ordinal}
          and prior.status <> 'DONE'
      ) as blocked
    `.execute(this.db);
        return result.rows[0]?.blocked ?? true;
    }
    async hasLaterCommandForInvocation(runId, workerId, epoch) {
        const result = await sql `
      select exists (
        select 1 from run_invocations invocation
        join run_commands current on current.id = invocation.command_id
        join run_commands later on later.run_id = current.run_id
          and later.ordinal > current.ordinal
        join run_command_outbox delivery on delivery.command_id = later.id
        where invocation.run_id = ${runId} and invocation.worker_id = ${workerId}
          and invocation.epoch = ${epoch} and invocation.status = 'ACTIVE'
      ) as superseded
    `.execute(this.db);
        return result.rows[0]?.superseded ?? true;
    }
    async isRunnableActionApprovalResume(reviewDecisionId, runId) {
        if (reviewDecisionId === null)
            return false;
        const result = await sql `
      select exists (
        select 1 from review_decisions decision
        join review_requests review on review.id = decision.review_id
        join logical_operations operation on operation.id = review.operation_id
        join runs run_row on run_row.id = operation.run_id
        where decision.id = ${reviewDecisionId} and review.kind = 'ACTION_APPROVAL'
          and decision.decision = 'APPROVE' and review.status = 'DECIDED'
          and review.run_id = ${runId} and review.target_hash = decision.target_hash
          and operation.run_id = ${runId} and (
            (operation.status = 'WAITING_APPROVAL' and run_row.status = 'WAITING_APPROVAL'
              and (review.expires_at is null or review.expires_at > clock_timestamp()))
            or (operation.status = 'PREPARED' and run_row.status = 'RUNNING')
            or operation.status = 'SUCCEEDED'
          )
      ) as runnable
    `.execute(this.db);
        return result.rows[0]?.runnable ?? false;
    }
    async isActionApprovalResume(reviewDecisionId) {
        if (reviewDecisionId === null)
            return false;
        const result = await sql `select exists (
      select 1 from review_decisions decision
      join review_requests review on review.id = decision.review_id
      where decision.id = ${reviewDecisionId} and review.kind = 'ACTION_APPROVAL'
    ) as approval`.execute(this.db);
        return result.rows[0]?.approval ?? false;
    }
    async lockOutbox(commandId) {
        const result = await sql `
      select ${OUTBOX_COLUMNS} from run_command_outbox
      where command_id = ${commandId} for update
    `.execute(this.db);
        return result.rows[0];
    }
    async readOutbox(commandId) {
        const result = await sql `
      select ${OUTBOX_COLUMNS} from run_command_outbox where command_id = ${commandId}
    `.execute(this.db);
        return result.rows[0];
    }
    async lockInvocation(runId) {
        const result = await sql `
      select ${INVOCATION_COLUMNS} from run_invocations
      where run_id = ${runId} for update
    `.execute(this.db);
        return result.rows[0];
    }
    /** A shared row lock serializes business commits with loss of invocation ownership. */
    async hasCurrentInvocation(runId, workerId, epoch) {
        const result = await sql `
      select exists (
        select 1 from run_invocations
        where run_id = ${runId} and worker_id = ${workerId} and epoch = ${epoch}
          and status = 'ACTIVE' and lease_until > clock_timestamp()
        for share
      ) as current
    `.execute(this.db);
        return result.rows[0]?.current ?? false;
    }
    async hasCurrentCommandInvocation(runId, commandId, workerId, epoch) {
        const result = await sql `
      select exists (
        select 1 from run_invocations
        where run_id = ${runId} and command_id = ${commandId}
          and worker_id = ${workerId} and epoch = ${epoch}
          and status = 'ACTIVE' and lease_until > clock_timestamp()
        for share
      ) as current
    `.execute(this.db);
        return result.rows[0]?.current ?? false;
    }
    async claimInvocation(runId, commandId, workerId, leaseMs) {
        const result = await sql `
      update run_invocations
      set epoch = epoch + 1, status = 'ACTIVE', worker_id = ${workerId},
          command_id = ${commandId}, lease_until = clock_timestamp() + ${leaseMs} * interval '1 millisecond',
          stop_evidence = null, updated_at = now()
      where run_id = ${runId} and status = 'IDLE'
      returning ${INVOCATION_COLUMNS}
    `.execute(this.db);
        return requireRow(result.rows, 'claim run invocation');
    }
    async claimOutbox(commandId, workerId, epoch) {
        const result = await sql `
      update run_command_outbox
      set status = 'CLAIMED', claim_epoch = ${epoch}, worker_id = ${workerId},
          claimed_at = now(), updated_at = now()
      where command_id = ${commandId} and status = 'PENDING'
    `.execute(this.db);
        if (result.numAffectedRows !== 1n)
            throw new Error('outbox claim changed while locked');
    }
    async renewInvocation(runId, workerId, epoch, leaseMs) {
        const result = await sql `
      update run_invocations
      set lease_until = clock_timestamp() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where run_id = ${runId} and worker_id = ${workerId} and epoch = ${epoch}
        and status = 'ACTIVE' and lease_until > clock_timestamp()
    `.execute(this.db);
        return result.numAffectedRows === 1n;
    }
    async settleOutbox(commandId, status, workerId, epoch) {
        const result = await sql `
      update run_command_outbox
      set status = ${status}, settled_at = now(), updated_at = now()
      where command_id = ${commandId} and status = 'CLAIMED'
        and worker_id = ${workerId} and claim_epoch = ${epoch}
    `.execute(this.db);
        if (result.numAffectedRows !== 1n)
            throw new Error('outbox settlement changed while locked');
    }
    async settlePending(commandId) {
        const result = await sql `
      update run_command_outbox
      set status = 'DONE', settled_at = now(), updated_at = now()
      where command_id = ${commandId} and status = 'PENDING'
    `.execute(this.db);
        if (result.numAffectedRows !== 1n)
            throw new Error('pending outbox changed while locked');
    }
    /** A control withdraws only the delivery for the approved, unexecuted action. */
    async settleInvalidatedApprovalResume(runId, operationId) {
        const result = await sql `
      select outbox.command_id, outbox.status
      from run_commands command
      join review_decisions decision on decision.id = command.review_decision_id
      join review_requests review on review.id = decision.review_id
      join run_command_outbox outbox on outbox.command_id = command.id
      where command.run_id = ${runId} and command.kind = 'RESUME'
        and review.run_id = ${runId} and review.operation_id = ${operationId}
        and review.kind = 'ACTION_APPROVAL' and decision.decision = 'APPROVE'
      for update of outbox
    `.execute(this.db);
        const delivery = result.rows[0];
        if (delivery === undefined || delivery.status === 'DONE')
            return;
        if (delivery.status !== 'PENDING')
            throw new Error('approved action RESUME already claimed or blocked');
        await this.settlePending(delivery.command_id);
    }
    async releaseInvocation(runId, workerId, epoch) {
        const result = await sql `
      update run_invocations
      set status = 'IDLE', worker_id = null, command_id = null,
          lease_until = null, updated_at = now()
      where run_id = ${runId} and worker_id = ${workerId} and epoch = ${epoch}
        and status = 'ACTIVE' and lease_until > clock_timestamp()
    `.execute(this.db);
        if (result.numAffectedRows !== 1n)
            throw new Error('invocation release lost its claim');
    }
    async requireStop(runId, workerId, epoch) {
        await sql `
      update run_invocations set status = 'STOP_REQUIRED', updated_at = now()
      where run_id = ${runId} and worker_id = ${workerId} and epoch = ${epoch}
        and status = 'ACTIVE'
    `.execute(this.db);
    }
    async findClaimsForWorker(workerId) {
        const result = await sql `
      select ${INVOCATION_COLUMNS} from run_invocations
      where worker_id = ${workerId} and status in ('ACTIVE', 'STOP_REQUIRED')
      order by run_id
    `.execute(this.db);
        return result.rows;
    }
    async findClaimsForDesktopLaunch(launchId) {
        const prefix = `worker:desktop:${launchId}:`;
        const result = await sql `
      select ${INVOCATION_COLUMNS} from run_invocations
      where worker_id like ${`${prefix}%`} and status in ('ACTIVE', 'STOP_REQUIRED')
      order by run_id
    `.execute(this.db);
        return result.rows;
    }
    async countClaimsForDesktopLaunch(launchId) {
        const prefix = `worker:desktop:${launchId}:`;
        const result = await sql `
      select count(*)::bigint as retained_claims from run_invocations
      where worker_id like ${`${prefix}%`} and status in ('ACTIVE', 'STOP_REQUIRED')
    `.execute(this.db);
        if (result.rows[0] === undefined)
            throw new Error('desktop launch claim count missing');
        return result.rows[0].retained_claims;
    }
    async readInvocation(runId) {
        const result = await sql `
      select ${INVOCATION_COLUMNS} from run_invocations where run_id = ${runId}
    `.execute(this.db);
        return result.rows[0];
    }
    async listExpiredInvocations(limit) {
        const result = await sql `
      select run_id, epoch, status from run_invocations
      where status in ('ACTIVE', 'STOP_REQUIRED') and lease_until <= clock_timestamp()
      order by lease_until, run_id limit ${limit}
    `.execute(this.db);
        return result.rows;
    }
    async requeueStoppedClaim(runId, workerId, epoch, commandId, stopEvidence) {
        const invocation = await sql `
      update run_invocations
      set status = 'IDLE', worker_id = null, command_id = null,
          lease_until = null, stop_evidence = ${stopEvidence}, updated_at = now()
      where run_id = ${runId} and worker_id = ${workerId} and epoch = ${epoch}
        and status in ('ACTIVE', 'STOP_REQUIRED') and command_id = ${commandId}
    `.execute(this.db);
        if (invocation.numAffectedRows !== 1n)
            throw new Error('stopped invocation changed');
        const outbox = await sql `
      update run_command_outbox
      set status = 'PENDING', claim_epoch = null, worker_id = null,
          claimed_at = null, settled_at = null, updated_at = now()
      where command_id = ${commandId} and status in ('CLAIMED', 'BLOCKED')
        and worker_id = ${workerId} and claim_epoch = ${epoch}
    `.execute(this.db);
        if (outbox.numAffectedRows !== 1n)
            throw new Error('stopped outbox claim changed');
    }
    /** Terminal human disposition consumes the old delivery without requeueing its effect. */
    async settleStoppedForManualDisposition(runId, workerId, epoch, commandId) {
        const other = await sql `
      select count(*)::bigint as count from run_command_outbox outbox
      join run_commands command on command.id = outbox.command_id
      where command.run_id = ${runId} and outbox.command_id <> ${commandId}
        and outbox.status in ('CLAIMED', 'BLOCKED')
    `.execute(this.db);
        if (other.rows[0]?.count !== 0n)
            throw new Error('another Run delivery is unsettled');
        const invocation = await sql `
      update run_invocations set status = 'IDLE', worker_id = null,
        command_id = null, lease_until = null, updated_at = now()
      where run_id = ${runId} and worker_id = ${workerId} and epoch = ${epoch}
        and command_id = ${commandId} and status in ('ACTIVE', 'STOP_REQUIRED')
    `.execute(this.db);
        if (invocation.numAffectedRows !== 1n)
            throw new Error('manual disposition lost its Run claim');
        const outbox = await sql `
      update run_command_outbox set status = 'DONE', settled_at = now(), updated_at = now()
      where command_id = ${commandId} and worker_id = ${workerId} and claim_epoch = ${epoch}
        and status in ('CLAIMED', 'BLOCKED')
    `.execute(this.db);
        if (outbox.numAffectedRows !== 1n)
            throw new Error('manual disposition lost its outbox claim');
        await sql `
      update run_command_outbox outbox set status = 'DONE', settled_at = now(), updated_at = now()
      from run_commands command
      where outbox.command_id = command.id and command.run_id = ${runId}
        and outbox.status = 'PENDING'
    `.execute(this.db);
    }
}
