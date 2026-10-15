import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
/** New operations freeze physical root, parent and target identities before approval. */
export class FileWritePathRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(input) {
        const result = await sql `
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
    async readByOperation(operationId) {
        return (await sql `select * from file_write_path_identity
      where operation_id = ${operationId}`.execute(this.db)).rows[0];
    }
}
