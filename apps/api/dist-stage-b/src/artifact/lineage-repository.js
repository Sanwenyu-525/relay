import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
/** Exact facts only. The database trigger validates typed scope, identity and cycles. */
export class LineageRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertExactEdge(input) {
        await sql `
      insert into artifact_lineage_edges
        (id, workspace_id, child_version_id, relation, parent_kind, parent_id)
      values (${randomUUID()}, ${input.workspaceId}, ${input.childVersionId}, ${input.relation},
        ${input.parentKind}, ${input.parentId})
      on conflict (child_version_id, relation, parent_kind, parent_id) do nothing
    `.execute(this.db);
    }
    async listByChild(versionId) {
        const result = await sql `
      select id, workspace_id, child_version_id, relation, parent_kind, parent_id, created_at
      from artifact_lineage_edges where child_version_id = ${versionId}
      order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async listByParent(workspaceId, parentVersionId, limit = 101) {
        const result = await sql `
      select id, workspace_id, child_version_id, relation, parent_kind, parent_id, created_at
      from artifact_lineage_edges
      where workspace_id = ${workspaceId} and parent_kind = 'ARTIFACT_VERSION'
        and parent_id = ${parentVersionId} and relation in ('DERIVED_FROM', 'REVISED_FROM')
      order by created_at, id
      limit ${limit}
    `.execute(this.db);
        return result.rows;
    }
}
