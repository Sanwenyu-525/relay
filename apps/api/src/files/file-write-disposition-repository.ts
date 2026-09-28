import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { FileWriteDispositionRow } from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

/** Append-only human decision; the original Invocation and file ledger are never rewritten. */
export class FileWriteDispositionRepository {
  constructor(private readonly db: DbExecutor) {}

  async readByInvocation(invocationId: string): Promise<FileWriteDispositionRow | undefined> {
    return (await sql<FileWriteDispositionRow>`select * from file_write_manual_dispositions
      where invocation_id = ${invocationId}`.execute(this.db)).rows[0];
  }

  async insert(input: Omit<FileWriteDispositionRow, 'created_at'>): Promise<FileWriteDispositionRow> {
    const result = await sql<FileWriteDispositionRow>`
      insert into file_write_manual_dispositions
        (id, invocation_id, operation_id, change_set_id, workspace_id, project_id,
         run_id, resource_id, command_id, actor_ref, decision, observation_sha256, observation)
      values (${input.id}, ${input.invocation_id}, ${input.operation_id}, ${input.change_set_id},
        ${input.workspace_id}, ${input.project_id}, ${input.run_id}, ${input.resource_id},
        ${input.command_id}, ${input.actor_ref}, ${input.decision}, ${input.observation_sha256},
        ${JSON.stringify(input.observation)}::jsonb)
      returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert file write manual disposition');
  }
}
