import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { requireRow } from '../shared/sql-rows.js';

export type ComputerDesktopLeaseState = 'FREE' | 'HELD' | 'QUARANTINED';

export interface ComputerDesktopLeaseRow {
  readonly id: number;
  readonly state: ComputerDesktopLeaseState;
  readonly workspace_id: string | null;
  readonly run_id: string | null;
  readonly worker_id: string | null;
  readonly worker_epoch: bigint | null;
  readonly updated_at: Date;
}

export class ComputerDesktopLeaseRepository {
  constructor(private readonly db: DbExecutor) {}

  /** Claim the global foreground desktop after all normal Gateway authorization checks. */
  async acquireForInput(input: {
    readonly workspaceId: string; readonly runId: string;
    readonly workerId: string; readonly workerEpoch: bigint;
  }): Promise<boolean> {
    const lease = requireRow((await sql<ComputerDesktopLeaseRow>`
      select id, state, workspace_id, run_id, worker_id, worker_epoch, updated_at
      from computer_desktop_lease where id = 1 for update
    `.execute(this.db)).rows, 'computer desktop lease');
    if (lease.state === 'FREE') {
      await sql`
        update computer_desktop_lease set state = 'HELD', workspace_id = ${input.workspaceId},
          run_id = ${input.runId}, worker_id = ${input.workerId}, worker_epoch = ${input.workerEpoch},
          updated_at = now()
        where id = 1 and state = 'FREE'
      `.execute(this.db);
      return true;
    }
    return lease.state === 'HELD' && lease.workspace_id === input.workspaceId &&
      lease.run_id === input.runId && lease.worker_id === input.workerId &&
      lease.worker_epoch === input.workerEpoch;
  }

  /** A safely claimed new epoch may bind an existing Run-level lease after a prior Worker was released. */
  async bindClaimedWorker(input: {
    readonly workspaceId: string; readonly runId: string; readonly workerId: string;
    readonly workerEpoch: bigint;
  }): Promise<void> {
    await sql`
      update computer_desktop_lease set worker_id = ${input.workerId},
        worker_epoch = ${input.workerEpoch}, updated_at = now()
      where id = 1 and state = 'HELD' and workspace_id = ${input.workspaceId}
        and run_id = ${input.runId} and worker_id is null and worker_epoch is null
    `.execute(this.db);
  }

  /** Release only the exact Worker binding; UNKNOWN leases remain isolated. */
  async unbindWorker(input: {
    readonly runId: string; readonly workerId: string; readonly workerEpoch: bigint;
  }): Promise<boolean> {
    const result = await sql`
      update computer_desktop_lease set worker_id = null, worker_epoch = null, updated_at = now()
      where id = 1 and state in ('HELD', 'QUARANTINED') and run_id = ${input.runId}
        and worker_id = ${input.workerId} and worker_epoch = ${input.workerEpoch}
      returning id
    `.execute(this.db);
    return result.rows.length > 0;
  }

  async quarantine(input: {
    readonly runId: string; readonly workerId: string; readonly workerEpoch: bigint;
  }): Promise<boolean> {
    const result = await sql`
      update computer_desktop_lease set state = 'QUARANTINED', updated_at = now()
      where id = 1 and state = 'HELD' and run_id = ${input.runId}
        and worker_id = ${input.workerId} and worker_epoch = ${input.workerEpoch}
      returning id
    `.execute(this.db);
    return result.rows.length > 0;
  }

  /** Only stopped-process reconciliation can turn UNKNOWN back into a usable Run lease. */
  async resolveQuarantine(input: {
    readonly runId: string; readonly stoppedWorkerId: string; readonly stoppedWorkerEpoch: bigint;
  }): Promise<boolean> {
    const result = await sql`
      update computer_desktop_lease set state = 'HELD', updated_at = now()
      where id = 1 and state = 'QUARANTINED' and run_id = ${input.runId}
        and (worker_id is null or (worker_id = ${input.stoppedWorkerId}
          and worker_epoch = ${input.stoppedWorkerEpoch}))
      returning id
    `.execute(this.db);
    return result.rows.length > 0;
  }

  /** Called only after Application has verified a safe stop/terminal boundary. */
  async releaseRun(runId: string): Promise<void> {
    await sql`
      update computer_desktop_lease set state = 'FREE', workspace_id = null, run_id = null,
        worker_id = null, worker_epoch = null, updated_at = now()
      where id = 1 and run_id = ${runId}
    `.execute(this.db);
  }

  async read(): Promise<ComputerDesktopLeaseRow> {
    return requireRow((await sql<ComputerDesktopLeaseRow>`
      select id, state, workspace_id, run_id, worker_id, worker_epoch, updated_at
      from computer_desktop_lease where id = 1
    `.execute(this.db)).rows, 'computer desktop lease');
  }
}
