import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { FileWriteStopProofRow } from '../infrastructure/database-schema.js';

/** Writes are reserved for the trusted stopped desktop launch recovery path. */
export class FileWriteStopProofRepository {
  constructor(private readonly db: DbExecutor) {}

  async readByInvocation(invocationId: string): Promise<FileWriteStopProofRow | undefined> {
    return (await sql<FileWriteStopProofRow>`select * from file_write_stop_proofs
      where invocation_id = ${invocationId}`.execute(this.db)).rows[0];
  }

  /** First observation wins. A crash replay may only read the original row. */
  async insertOnce(input: Omit<FileWriteStopProofRow, 'recorded_at' | 'capability_key'>): Promise<FileWriteStopProofRow> {
    const inserted = await sql<FileWriteStopProofRow>`
      insert into file_write_stop_proofs
        (invocation_id, operation_id, run_id, worker_id, worker_epoch,
         dispatch_epoch, command_id, launch_id, stop_evidence, action_type)
      values (${input.invocation_id}, ${input.operation_id}, ${input.run_id},
        ${input.worker_id}, ${input.worker_epoch}, ${input.dispatch_epoch},
        ${input.command_id}, ${input.launch_id}, ${input.stop_evidence}, ${input.action_type})
      on conflict (invocation_id) do nothing returning *
    `.execute(this.db);
    const proof = inserted.rows[0] ?? await this.readByInvocation(input.invocation_id);
    if (proof === undefined || proof.operation_id !== input.operation_id ||
        proof.run_id !== input.run_id || proof.worker_id !== input.worker_id ||
        proof.worker_epoch !== input.worker_epoch || proof.dispatch_epoch !== input.dispatch_epoch ||
        proof.command_id !== input.command_id || proof.launch_id !== input.launch_id ||
        proof.action_type !== input.action_type) {
      throw new Error('FILE_WRITE stop proof identity changed');
    }
    return proof;
  }
}
