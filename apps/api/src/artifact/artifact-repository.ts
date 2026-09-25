import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ArtifactKind,
  ArtifactRow,
  ArtifactVersionRow,
  ArtifactVersionSourceKind,
} from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

export interface NewArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly taskId: string;
  readonly artifactKind: ArtifactKind;
  readonly title: string;
}

export interface NewArtifactVersion {
  readonly id: string;
  readonly artifactId: string;
  readonly versionNumber: bigint;
  /** 受管相对路径；绝对路径、盘符、上级目录与冒号由 CHECK 拒绝。 */
  readonly storageRef: string;
  readonly contentHash: Buffer;
  readonly size: bigint;
  readonly mediaType: string;
  readonly sourceKind: ArtifactVersionSourceKind;
  readonly sourceRef: string | null;
}

/**
 * Artifact 逻辑身份与不可变版本。
 * 只有内容已完整保存后才会调用登记入口；本仓储不写文件系统。
 */
export class ArtifactRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertArtifact(artifact: NewArtifact): Promise<ArtifactRow> {
    const result = await sql<ArtifactRow>`
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

  async readArtifact(artifactId: string): Promise<ArtifactRow | undefined> {
    const result = await sql<ArtifactRow>`
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
  async lockArtifact(artifactId: string): Promise<ArtifactRow | undefined> {
    const result = await sql<ArtifactRow>`
      select id, workspace_id, project_id, task_id, artifact_kind, title, revision,
             created_at, updated_at
      from artifacts
      where id = ${artifactId}
      for update
    `.execute(this.db);

    return result.rows[0];
  }

  /** 新版本登记的 CAS 更新：只有提交者持有的 revision 匹配时才递增并返回。 */
  async bumpArtifactRevision(
    artifactId: string,
    expectedRevision: bigint,
  ): Promise<ArtifactRow | undefined> {
    const result = await sql<ArtifactRow>`
      update artifacts
      set revision = revision + 1, updated_at = now()
      where id = ${artifactId} and revision = ${expectedRevision}
      returning id, workspace_id, project_id, task_id, artifact_kind, title, revision,
                created_at, updated_at
    `.execute(this.db);

    return result.rows[0];
  }

  /** 下一个不可变版本序号；调用方必须已持有该 Artifact 的行锁。 */
  async nextVersionNumber(artifactId: string): Promise<bigint> {
    const result = await sql<{ next_number: bigint }>`
      select coalesce(max(version_number), 0) + 1 as next_number
      from artifact_versions
      where artifact_id = ${artifactId}
    `.execute(this.db);

    return result.rows[0]?.next_number ?? 1n;
  }

  async insertArtifactVersion(version: NewArtifactVersion): Promise<ArtifactVersionRow> {
    const result = await sql<ArtifactVersionRow>`
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

  async readArtifactVersion(versionId: string): Promise<ArtifactVersionRow | undefined> {
    const result = await sql<ArtifactVersionRow>`
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
  async findArtifactVersionBySourceRef(input: {
    readonly taskId: string;
    readonly sourceRef: string;
  }): Promise<ArtifactVersionRow | undefined> {
    const result = await sql<ArtifactVersionRow>`
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

  async listArtifactVersions(artifactId: string): Promise<readonly ArtifactVersionRow[]> {
    const result = await sql<ArtifactVersionRow>`
      select id, artifact_id, version_number, storage_ref, content_hash, size,
             media_type, source_kind, source_ref, created_at
      from artifact_versions
      where artifact_id = ${artifactId}
      order by version_number
    `.execute(this.db);

    return result.rows;
  }
}