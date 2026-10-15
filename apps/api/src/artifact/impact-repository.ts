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

/** N02：组只保存「哪几个确切目标被放在一起看」，不保存正文或另一份成果状态。 */
export interface ImpactCandidateGroupRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly impact_check_id: string;
  readonly source_artifact_id: string;
  readonly source_before_version_id: string;
  readonly source_after_version_id: string;
  readonly source_artifact_revision: bigint;
  readonly dependencies: readonly JsonObject[];
  readonly created_at: Date;
}

export interface ImpactGroupSelectionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly group_id: string;
  readonly items: readonly JsonObject[];
  readonly created_at: Date;
}

export interface ImpactGroupItemRow {
  readonly group_id: string;
  readonly ordinal: number;
  readonly target_artifact_id: string;
  readonly target_version_id: string;
  readonly relation: string;
  readonly speculative: boolean;
}

export interface CombinationCheckRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly group_id: string;
  readonly task_id: string;
  readonly acceptance_revision: bigint;
  readonly gaps: readonly JsonObject[];
  readonly created_at: Date;
}

export interface CombinationCheckItemRow {
  readonly combination_check_id: string;
  readonly ordinal: number;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly content_hash: Buffer;
  readonly is_current_version: boolean;
  readonly readable: boolean;
  readonly verification_session_id: string | null;
  readonly verification_status: string | null;
}

export interface NewImpactGroupItem {
  readonly groupId: string;
  readonly ordinal: number;
  readonly targetArtifactId: string;
  readonly targetVersionId: string;
  readonly relation: string;
  readonly speculative: boolean;
}

export interface NewCombinationCheckItem {
  readonly combinationCheckId: string;
  readonly ordinal: number;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentHash: Buffer;
  readonly isCurrentVersion: boolean;
  readonly readable: boolean;
  readonly verificationSessionId: string | null;
  readonly verificationStatus: string | null;
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

  /** N02：一个目标版本在同一检查下至多一个候选；重复申请返回既有候选而不是新行。 */
  async findCandidateByTarget(checkId: string, targetVersionId: string):
    Promise<ArtifactImpactCandidateRow | undefined> {
    const result = await sql<ArtifactImpactCandidateRow>`select *
      from artifact_impact_candidates
      where impact_check_id = ${checkId} and target_version_id = ${targetVersionId}
      order by created_at desc limit 1`.execute(this.db);
    return result.rows[0];
  }

  async insertGroup(input: { id: string; workspaceId: string; checkId: string;
    sourceArtifactId: string; beforeVersionId: string; afterVersionId: string;
    sourceArtifactRevision: bigint; dependencies?: readonly JsonObject[] }): Promise<ImpactCandidateGroupRow> {
    const result = await sql<ImpactCandidateGroupRow>`insert into artifact_impact_candidate_groups
      (id, workspace_id, impact_check_id, source_artifact_id, source_before_version_id,
        source_after_version_id, source_artifact_revision, dependencies)
      values (${input.id}, ${input.workspaceId}, ${input.checkId}, ${input.sourceArtifactId},
        ${input.beforeVersionId}, ${input.afterVersionId}, ${input.sourceArtifactRevision},
        ${JSON.stringify(input.dependencies ?? [])}::jsonb)
      returning *`.execute(this.db);
    return requireRow(result.rows, 'insert into artifact_impact_candidate_groups');
  }

  async readGroup(id: string): Promise<ImpactCandidateGroupRow | undefined> {
    const result = await sql<ImpactCandidateGroupRow>`select *
      from artifact_impact_candidate_groups where id = ${id}`.execute(this.db);
    return result.rows[0];
  }

  async dependencyGroups(checkId: string, targetVersionId: string): Promise<readonly string[]> {
    return (await sql<{ id: string }>`select id from artifact_impact_candidate_groups g
      where impact_check_id = ${checkId} and exists (select 1
        from jsonb_array_elements(g.dependencies) d
        where d->>'target_version_id' = ${targetVersionId})`.execute(this.db)).rows.map(r => r.id);
  }

  async insertSelection(id: string, workspaceId: string, groupId: string,
    items: readonly JsonObject[]): Promise<void> {
    await sql`insert into artifact_impact_group_selections(id, workspace_id, group_id, items)
      values(${id}, ${workspaceId}, ${groupId}, ${JSON.stringify(items)}::jsonb)`.execute(this.db);
  }

  async readSelection(id: string): Promise<ImpactGroupSelectionRow | undefined> {
    return (await sql<ImpactGroupSelectionRow>`select * from artifact_impact_group_selections
      where id = ${id}`.execute(this.db)).rows[0];
  }

  async insertGroupItems(items: readonly NewImpactGroupItem[]): Promise<void> {
    for (const item of items) {
      await sql`insert into artifact_impact_candidate_group_items
        (group_id, ordinal, target_artifact_id, target_version_id, relation, speculative)
        values (${item.groupId}, ${item.ordinal}, ${item.targetArtifactId},
          ${item.targetVersionId}, ${item.relation}, ${item.speculative})`.execute(this.db);
    }
  }

  async listGroupItems(groupId: string): Promise<readonly ImpactGroupItemRow[]> {
    const result = await sql<ImpactGroupItemRow>`select * from artifact_impact_candidate_group_items
      where group_id = ${groupId} order by ordinal`.execute(this.db);
    return result.rows;
  }

  async insertCombinationCheck(input: { id: string; workspaceId: string; groupId: string;
    taskId: string; acceptanceRevision: bigint; gaps: readonly JsonObject[] }):
    Promise<CombinationCheckRow> {
    const result = await sql<CombinationCheckRow>`insert into artifact_combination_checks
      (id, workspace_id, group_id, task_id, acceptance_revision, gaps)
      values (${input.id}, ${input.workspaceId}, ${input.groupId}, ${input.taskId},
        ${input.acceptanceRevision}, ${JSON.stringify(input.gaps)}::jsonb)
      returning *`.execute(this.db);
    return requireRow(result.rows, 'insert into artifact_combination_checks');
  }

  async insertCombinationCheckItems(items: readonly NewCombinationCheckItem[]): Promise<void> {
    for (const item of items) {
      await sql`insert into artifact_combination_check_items
        (combination_check_id, ordinal, artifact_id, artifact_version_id, content_hash,
          is_current_version, readable, verification_session_id, verification_status)
        values (${item.combinationCheckId}, ${item.ordinal}, ${item.artifactId},
          ${item.artifactVersionId}, ${item.contentHash}, ${item.isCurrentVersion},
          ${item.readable}, ${item.verificationSessionId}, ${item.verificationStatus})`
        .execute(this.db);
    }
  }

  async readCombinationCheck(id: string): Promise<CombinationCheckRow | undefined> {
    const result = await sql<CombinationCheckRow>`select *
      from artifact_combination_checks where id = ${id}`.execute(this.db);
    return result.rows[0];
  }

  async listCombinationCheckIds(groupId: string): Promise<readonly string[]> {
    const result = await sql<{ id: string }>`select id from artifact_combination_checks
      where group_id = ${groupId} order by created_at desc, id desc`.execute(this.db);
    return result.rows.map((row) => row.id);
  }

  async listCombinationCheckItems(combinationCheckId: string):
    Promise<readonly CombinationCheckItemRow[]> {
    const result = await sql<CombinationCheckItemRow>`select *
      from artifact_combination_check_items
      where combination_check_id = ${combinationCheckId} order by ordinal`.execute(this.db);
    return result.rows;
  }
}
