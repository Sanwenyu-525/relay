import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
export class ImpactRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insert(input) {
        const result = await sql `insert into artifact_impact_checks
      (id, workspace_id, artifact_id, source_before_version_id, source_after_version_id,
        artifact_revision, assist_session_id, assist_message_id, direct_targets,
        has_more, input_truncated)
      values (${input.id}, ${input.workspaceId}, ${input.artifactId}, ${input.beforeVersionId},
        ${input.afterVersionId}, ${input.artifactRevision}, ${input.sessionId},
        ${input.messageId}, ${JSON.stringify(input.directTargets)}::jsonb,
        ${input.hasMore}, ${input.inputTruncated}) returning *`.execute(this.db);
        return requireRow(result.rows, 'insert into artifact_impact_checks');
    }
    async read(id) {
        const result = await sql `select * from artifact_impact_checks
      where id = ${id}`.execute(this.db);
        return result.rows[0];
    }
    async insertCandidate(input) {
        const result = await sql `insert into artifact_impact_candidates
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
    async readCandidate(id, lock = false) {
        const suffix = lock ? sql `for update` : sql ``;
        const result = await sql `select * from artifact_impact_candidates
      where id = ${id} ${suffix}`.execute(this.db);
        return result.rows[0];
    }
    async markApplied(id, versionId) {
        const result = await sql `update artifact_impact_candidates set
      applied_version_id = ${versionId}, applied_at = now()
      where id = ${id} and applied_version_id is null`.execute(this.db);
        return (result.numAffectedRows ?? 0n) === 1n;
    }
    /** N02：一个目标版本在同一检查下至多一个候选；重复申请返回既有候选而不是新行。 */
    async findCandidateByTarget(checkId, targetVersionId) {
        const result = await sql `select *
      from artifact_impact_candidates
      where impact_check_id = ${checkId} and target_version_id = ${targetVersionId}
      order by created_at desc limit 1`.execute(this.db);
        return result.rows[0];
    }
    async insertGroup(input) {
        const result = await sql `insert into artifact_impact_candidate_groups
      (id, workspace_id, impact_check_id, source_artifact_id, source_before_version_id,
        source_after_version_id, source_artifact_revision)
      values (${input.id}, ${input.workspaceId}, ${input.checkId}, ${input.sourceArtifactId},
        ${input.beforeVersionId}, ${input.afterVersionId}, ${input.sourceArtifactRevision})
      returning *`.execute(this.db);
        return requireRow(result.rows, 'insert into artifact_impact_candidate_groups');
    }
    async readGroup(id) {
        const result = await sql `select *
      from artifact_impact_candidate_groups where id = ${id}`.execute(this.db);
        return result.rows[0];
    }
    async insertGroupItems(items) {
        for (const item of items) {
            await sql `insert into artifact_impact_candidate_group_items
        (group_id, ordinal, target_artifact_id, target_version_id, relation, speculative)
        values (${item.groupId}, ${item.ordinal}, ${item.targetArtifactId},
          ${item.targetVersionId}, ${item.relation}, ${item.speculative})`.execute(this.db);
        }
    }
    async listGroupItems(groupId) {
        const result = await sql `select * from artifact_impact_candidate_group_items
      where group_id = ${groupId} order by ordinal`.execute(this.db);
        return result.rows;
    }
    async insertCombinationCheck(input) {
        const result = await sql `insert into artifact_combination_checks
      (id, workspace_id, group_id, task_id, acceptance_revision, gaps)
      values (${input.id}, ${input.workspaceId}, ${input.groupId}, ${input.taskId},
        ${input.acceptanceRevision}, ${JSON.stringify(input.gaps)}::jsonb)
      returning *`.execute(this.db);
        return requireRow(result.rows, 'insert into artifact_combination_checks');
    }
    async insertCombinationCheckItems(items) {
        for (const item of items) {
            await sql `insert into artifact_combination_check_items
        (combination_check_id, ordinal, artifact_id, artifact_version_id, content_hash,
          is_current_version, readable, verification_session_id, verification_status)
        values (${item.combinationCheckId}, ${item.ordinal}, ${item.artifactId},
          ${item.artifactVersionId}, ${item.contentHash}, ${item.isCurrentVersion},
          ${item.readable}, ${item.verificationSessionId}, ${item.verificationStatus})`
                .execute(this.db);
        }
    }
    async readCombinationCheck(id) {
        const result = await sql `select *
      from artifact_combination_checks where id = ${id}`.execute(this.db);
        return result.rows[0];
    }
    async listCombinationCheckIds(groupId) {
        const result = await sql `select id from artifact_combination_checks
      where group_id = ${groupId} order by created_at desc, id desc`.execute(this.db);
        return result.rows.map((row) => row.id);
    }
    async listCombinationCheckItems(combinationCheckId) {
        const result = await sql `select *
      from artifact_combination_check_items
      where combination_check_id = ${combinationCheckId} order by ordinal`.execute(this.db);
        return result.rows;
    }
}
