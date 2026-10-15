import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
/**
 * Artifact 逻辑身份与不可变版本。
 * 只有内容已完整保存后才会调用登记入口；本仓储不写文件系统。
 */
export class ArtifactRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async recordTextLockConflict(input) {
        await sql `insert into artifact_lock_conflicts
      (id, workspace_id, run_id, task_id, artifact_id, base_version_id, reason)
      values (${input.id}, ${input.workspaceId}, ${input.runId}, ${input.taskId},
        ${input.artifactId}, ${input.baseVersionId}, ${input.reason})
      on conflict (id) do nothing`.execute(this.db);
    }
    async listTextLocks(artifactId) {
        const result = await sql `
      select * from artifact_text_locks where artifact_id = ${artifactId}
      order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async insertTextLock(input) {
        const result = await sql `
      insert into artifact_text_locks
        (id, artifact_id, base_version_id, block_kind, block_index, locked_text, status)
      values (${input.id}, ${input.artifactId}, ${input.versionId}, ${input.kind},
        ${input.index}, ${input.text}, 'MAPPED') returning *
    `.execute(this.db);
        return requireRow(result.rows, 'insert into artifact_text_locks');
    }
    async rebindTextLock(input) {
        await sql `update artifact_text_locks set base_version_id = ${input.versionId},
      block_index = ${input.index}, locked_text = ${input.text}, status = ${input.status},
      updated_at = now() where id = ${input.id}`.execute(this.db);
    }
    async deleteTextLock(id, artifactId) {
        const result = await sql `delete from artifact_text_locks where id = ${id}
      and artifact_id = ${artifactId}`.execute(this.db);
        return (result.numAffectedRows ?? 0n) > 0n;
    }
    async insertArtifact(artifact) {
        const result = await sql `
      insert into artifacts (id, workspace_id, project_id, task_id, artifact_kind, title)
      values (
        ${artifact.id}, ${artifact.workspaceId}, ${artifact.projectId},
        ${artifact.taskId}, ${artifact.artifactKind}, ${artifact.title}
      )
      returning id, workspace_id, project_id, task_id, artifact_kind, title, revision,
                created_at, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into artifacts');
    }
    async readArtifact(artifactId) {
        const result = await sql `
      select id, workspace_id, project_id, task_id, artifact_kind, title, revision,
             created_at, updated_at
      from artifacts
      where id = ${artifactId}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * Artifact 行锁：新版本序号与 revision 都在这把锁下分配，
     * 因此并发提交同一 Artifact 不会被 unique(artifact_id, version_number) 兜底拒绝。
     * 锁序为 Task → Artifact（不反向先取 Artifact 再取 Task）。
     */
    async lockArtifact(artifactId) {
        const result = await sql `
      select id, workspace_id, project_id, task_id, artifact_kind, title, revision,
             created_at, updated_at
      from artifacts
      where id = ${artifactId}
      for update
    `.execute(this.db);
        return result.rows[0];
    }
    /** 新版本登记的 CAS 更新：只有提交者持有的 revision 匹配时才递增并返回。 */
    async bumpArtifactRevision(artifactId, expectedRevision) {
        const result = await sql `
      update artifacts
      set revision = revision + 1, updated_at = now()
      where id = ${artifactId} and revision = ${expectedRevision}
      returning id, workspace_id, project_id, task_id, artifact_kind, title, revision,
                created_at, updated_at
    `.execute(this.db);
        return result.rows[0];
    }
    /** 下一个不可变版本序号；调用方必须已持有该 Artifact 的行锁。 */
    async nextVersionNumber(artifactId) {
        const result = await sql `
      select coalesce(max(version_number), 0) + 1 as next_number
      from artifact_versions
      where artifact_id = ${artifactId}
    `.execute(this.db);
        return result.rows[0]?.next_number ?? 1n;
    }
    async insertArtifactVersion(version) {
        const result = await sql `
      insert into artifact_versions (
        id, artifact_id, version_number, storage_ref, content_hash, size,
        media_type, source_kind, source_ref
      )
      values (
        ${version.id}, ${version.artifactId}, ${version.versionNumber}, ${version.storageRef},
        ${version.contentHash}, ${version.size}, ${version.mediaType},
        ${version.sourceKind}, ${version.sourceRef}
      )
      returning id, artifact_id, version_number, storage_ref, content_hash, size,
                media_type, source_kind, source_ref, created_at
    `.execute(this.db);
        return requireRow(result.rows, 'insert into artifact_versions');
    }
    async readArtifactVersion(versionId) {
        const result = await sql `
      select id, artifact_id, version_number, storage_ref, content_hash, size,
             media_type, source_kind, source_ref, created_at
      from artifact_versions
      where id = ${versionId}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * 按稳定来源尝试 ID 查已登记的版本（P05 的 PERSIST_CANDIDATE 去重）。
     *
     * source_ref 形如 `run:<runId>/step:PERSIST_CANDIDATE`：同一个 Run 只建一个 Artifact，
     * 重复执行同一步骤时命中既有版本，不重复发布内容、也不新建第二条版本。
     */
    async findArtifactVersionBySourceRef(input) {
        const result = await sql `
      select v.id, v.artifact_id, v.version_number, v.storage_ref, v.content_hash, v.size,
             v.media_type, v.source_kind, v.source_ref, v.created_at
      from artifact_versions v
      join artifacts a on a.id = v.artifact_id
      where a.task_id = ${input.taskId} and v.source_ref = ${input.sourceRef}
      order by v.version_number
      limit 1
    `.execute(this.db);
        return result.rows[0];
    }
    async listArtifactVersions(artifactId) {
        const result = await sql `
      select id, artifact_id, version_number, storage_ref, content_hash, size,
             media_type, source_kind, source_ref, created_at
      from artifact_versions
      where artifact_id = ${artifactId}
      order by version_number
    `.execute(this.db);
        return result.rows;
    }
}
