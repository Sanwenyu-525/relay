import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { FileWriteFrozenDiffRow } from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

/** Append-only frozen baseline evidence. Target text stays in the operation's frozen params. */
export class FileWriteDiffRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: Omit<FileWriteFrozenDiffRow, 'created_at'>): Promise<FileWriteFrozenDiffRow> {
    const result = await sql<FileWriteFrozenDiffRow>`
      insert into file_write_frozen_diffs
        (operation_id, workspace_id, project_id, run_id, resource_id, capability_key,
         action_type, relative_path, file_action, baseline_sha256, baseline_text, unavailable_reason)
      values (${input.operation_id}, ${input.workspace_id}, ${input.project_id}, ${input.run_id},
        ${input.resource_id}, ${input.capability_key}, ${input.action_type}, ${input.relative_path}, ${input.file_action},
        ${input.baseline_sha256}, ${input.baseline_text}, ${input.unavailable_reason})
      returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert frozen file write diff');
  }

  async listByOperation(operationId: string): Promise<readonly Pick<FileWriteFrozenDiffRow,
    'relative_path' | 'baseline_sha256' | 'baseline_text' | 'unavailable_reason'>[]> {
    return (await sql<Pick<FileWriteFrozenDiffRow,
      'relative_path' | 'baseline_sha256' | 'baseline_text' | 'unavailable_reason'>>`
      select relative_path, baseline_sha256, baseline_text, unavailable_reason
      from file_write_frozen_diffs where operation_id = ${operationId} order by relative_path
    `.execute(this.db)).rows;
  }
}
