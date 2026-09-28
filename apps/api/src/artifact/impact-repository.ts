import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

export interface ArtifactImpactCheckRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly source_before_version_id: string;
  readonly source_after_version_id: string;
  readonly artifact_revision: bigint;
  readonly assist_session_id: string;
  readonly assist_message_id: string;
  readonly direct_targets: readonly JsonObject[];
  readonly has_more: boolean;
  readonly input_truncated: boolean;
  readonly created_at: Date;
}

export interface ArtifactImpactCandidateRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly impact_check_id: string;
  readonly source_artifact_revision: bigint;
  readonly target_artifact_id: string;
  readonly target_artifact_revision: bigint;
  readonly target_version_id: string;
  readonly assist_session_id: string;
  readonly assist_message_id: string;
  readonly confirmed_possible: boolean;
  readonly applied_version_id: string | null;
  readonly created_at: Date;
  readonly applied_at: Date | null;
}

export class ImpactRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: { id: string; workspaceId: string; artifactId: string;
    beforeVersionId: string; afterVersionId: string; artifactRevision: bigint;
    sessionId: string; messageId: string; directTargets: readonly JsonObject[];
    hasMore: boolean; inputTruncated: boolean }): Promise<ArtifactImpactCheckRow> {
    const result = await sql<ArtifactImpactCheckRow>`insert into artifact_impact_checks
      (id, workspace_id, artifact_id, source_before_version_id, source_after_version_id,
        artifact_revision, assist_session_id, assist_message_id, direct_targets,
        has_more, input_truncated)
      values (${input.id}, ${input.workspaceId}, ${input.artifactId}, ${input.beforeVersionId},
        ${input.afterVersionId}, ${input.artifactRevision}, ${input.sessionId},
        ${input.messageId}, ${JSON.stringify(input.directTargets)}::jsonb,
        ${input.hasMore}, ${input.inputTruncated}) returning *`.execute(this.db);
    return requireRow(result.rows, 'insert into artifact_impact_checks');
  }

  async read(id: string): Promise<ArtifactImpactCheckRow | undefined> {
    const result = await sql<ArtifactImpactCheckRow>`select * from artifact_impact_checks
      where id = ${id}`.execute(this.db);
    return result.rows[0];
  }

  async insertCandidate(input: { id: string; workspaceId: string; checkId: string;
    sourceArtifactRevision: bigint; targetArtifactId: string;
    targetArtifactRevision: bigint; targetVersionId: string;
    sessionId: string; messageId: string; confirmedPossible: boolean }):
    Promise<ArtifactImpactCandidateRow> {
    const result = await sql<ArtifactImpactCandidateRow>`insert into artifact_impact_candidates
      (id, workspace_id, impact_check_id, source_artifact_revision,
        target_artifact_id, target_artifact_revision, target_version_id,
        assist_session_id, assist_message_id, confirmed_possible)
      values (${input.id}, ${input.workspaceId}, ${input.checkId},
        ${input.sourceArtifactRevision}, ${input.targetArtifactId},
        ${input.targetArtifactRevision}, ${input.targetVersionId},
        ${input.sessionId}, ${input.messageId}, ${input.confirmedPossible}) returning *`
      .execute(this.db);
    return requireRow(result.rows, 'insert into artifact_impact_candidates');
  }

  async readCandidate(id: string, lock = false): Promise<ArtifactImpactCandidateRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    const result = await sql<ArtifactImpactCandidateRow>`select * from artifact_impact_candidates
      where id = ${id} ${suffix}`.execute(this.db);
    return result.rows[0];
  }

  async markApplied(id: string, versionId: string): Promise<boolean> {
    const result = await sql`update artifact_impact_candidates set
      applied_version_id = ${versionId}, applied_at = now()
      where id = ${id} and applied_version_id is null`.execute(this.db);
    return (result.numAffectedRows ?? 0n) === 1n;
  }
}
