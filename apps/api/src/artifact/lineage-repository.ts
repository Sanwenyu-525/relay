import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ArtifactLineageEdgeRow } from '../infrastructure/database-schema.js';

export type LineageRelation = ArtifactLineageEdgeRow['relation'];
export type LineageParentKind = ArtifactLineageEdgeRow['parent_kind'];

/** Exact facts only. The database trigger validates typed scope, identity and cycles. */
export class LineageRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertExactEdge(input: { readonly workspaceId: string; readonly childVersionId: string;
    readonly relation: LineageRelation; readonly parentKind: LineageParentKind;
    readonly parentId: string }): Promise<void> {
    await sql`
      insert into artifact_lineage_edges
        (id, workspace_id, child_version_id, relation, parent_kind, parent_id)
      values (${randomUUID()}, ${input.workspaceId}, ${input.childVersionId}, ${input.relation},
        ${input.parentKind}, ${input.parentId})
      on conflict (child_version_id, relation, parent_kind, parent_id) do nothing
    `.execute(this.db);
  }

  async listByChild(versionId: string): Promise<readonly ArtifactLineageEdgeRow[]> {
    const result = await sql<ArtifactLineageEdgeRow>`
      select id, workspace_id, child_version_id, relation, parent_kind, parent_id, created_at
      from artifact_lineage_edges where child_version_id = ${versionId}
      order by created_at, id
    `.execute(this.db);
    return result.rows;
  }

  async listByParent(workspaceId: string, parentVersionId: string, limit = 101): Promise<readonly ArtifactLineageEdgeRow[]> {
    const result = await sql<ArtifactLineageEdgeRow>`
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
