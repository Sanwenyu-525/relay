import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { FileWritePathIdentityRow } from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

/** New operations freeze physical root, parent and target identities before approval. */
export class FileWritePathRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: Omit<FileWritePathIdentityRow, 'created_at'>): Promise<FileWritePathIdentityRow> {
    const result = await sql<FileWritePathIdentityRow>`
      insert into file_write_path_identity
        (operation_id, workspace_id, project_id, run_id, resource_id, capability_key,
         action_type, root_path, root_id, captures)
      values (${input.operation_id}, ${input.workspace_id}, ${input.project_id},
        ${input.run_id}, ${input.resource_id}, ${input.capability_key},
        ${input.action_type}, ${input.root_path}, ${input.root_id}, ${JSON.stringify(input.captures)}::jsonb)
      returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert file write path identity');
  }

  async readByOperation(operationId: string): Promise<FileWritePathIdentityRow | undefined> {
    return (await sql<FileWritePathIdentityRow>`select * from file_write_path_identity
      where operation_id = ${operationId}`.execute(this.db)).rows[0];
  }
}
