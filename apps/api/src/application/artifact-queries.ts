import type { DbExecutor } from '../infrastructure/database.js';
import type { ArtifactRow, ArtifactVersionRow } from '../infrastructure/database-schema.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { toDecimalString } from '../shared/decimal.js';
import { evidenceUnavailable, validationFailed } from './domain-error.js';
import { readArtifactInWorkspace, readArtifactVersionInWorkspace, readTaskInWorkspace } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * Artifact 查询投影与受授权内容读取（docs/api/http-command-contract.md 第 3 节）。
 *
 * 只输出安全的只读模型：不暴露宿主绝对路径、storage_ref 或任何存储内部结构；
 * 内容只能通过受授权下载接口获取，并且在返回前与登记的 hash/size 核对。
 */

export interface ArtifactVersionSummaryDto {
  readonly artifact_version_id: string;
  readonly version_number: string;
  readonly media_type: string;
  readonly sha256: string;
  readonly size: string;
  readonly source_kind: string;
  readonly created_at: string;
}

export interface ArtifactDto {
  readonly id: string;
  readonly task_id: string;
  readonly project_id: string | null;
  readonly artifact_kind: string;
  readonly title: string;
  readonly revision: string;
  readonly latest_version_id: string | null;
  readonly version_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** 逻辑信息与各版本摘要；选中哪个版本作为验收对象由完成命令显式决定，不由查询隐含。 */
  readonly versions: readonly ArtifactVersionSummaryDto[];
}

export function summarizeVersion(version: ArtifactVersionRow): ArtifactVersionSummaryDto {
  return {
    artifact_version_id: version.id,
    version_number: toDecimalString(version.version_number),
    media_type: version.media_type,
    sha256: Buffer.from(version.content_hash).toString('hex'),
    size: toDecimalString(version.size),
    source_kind: version.source_kind,
    created_at: version.created_at.toISOString(),
  };
}

export async function readArtifactById(
  db: DbExecutor,
  workspaceId: string,
  artifactId: string,
): Promise<ArtifactDto> {
  const repositories = createRepositories(db);
  const artifact = await readArtifactInWorkspace(repositories, workspaceId, artifactId);

  return buildArtifactDto(repositories, artifact);
}

/** Task 范围内的受权历史与当前接受指针，共用一个快照避免完成/重开的混合视图。 */
export async function listTaskArtifacts(
  db: DbExecutor,
  workspaceId: string,
  taskId: string,
): Promise<{ readonly items: readonly ArtifactDto[]; readonly current_accepted_version_ids: readonly string[] }> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const repositories = createRepositories(snapshot);
    const task = await readTaskInWorkspace(repositories, workspaceId, taskId);
    const artifacts = await snapshot.selectFrom('artifacts')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('task_id', '=', task.id)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const items = await Promise.all(artifacts.map((artifact) => buildArtifactDto(repositories, artifact)));

    if (task.current_completion_id === null) {
      return { items, current_accepted_version_ids: [] };
    }

    const completion = await snapshot.selectFrom('completion_records')
      .select(['state_delta'])
      .where('id', '=', task.current_completion_id)
      .where('task_id', '=', task.id)
      .executeTakeFirstOrThrow();
    const accepted = completion.state_delta.artifact_version_ids;

    if (!Array.isArray(accepted) || !accepted.every((value) => typeof value === 'string')) {
      throw new Error('current completion has invalid artifact version references');
    }

    return { items, current_accepted_version_ids: accepted as string[] };
  });
}

export async function buildArtifactDto(
  repositories: Repositories,
  artifact: ArtifactRow,
): Promise<ArtifactDto> {
  const versions = await repositories.artifacts.listArtifactVersions(artifact.id);
  const latest = versions.at(-1);

  return {
    id: artifact.id,
    task_id: artifact.task_id,
    project_id: artifact.project_id,
    artifact_kind: artifact.artifact_kind,
    title: artifact.title,
    revision: toDecimalString(artifact.revision),
    latest_version_id: latest?.id ?? null,
    version_count: versions.length,
    created_at: artifact.created_at.toISOString(),
    updated_at: artifact.updated_at.toISOString(),
    versions: versions.map(summarizeVersion),
  };
}

/**
 * 受授权读取确切版本内容：跨作用域按不可见处理；内容与登记摘要不一致时返回证据不可用，
 * 不返回部分内容或经过修正的内容。
 */
export async function readArtifactContent(
  db: DbExecutor,
  storage: ManagedContentStore,
  workspaceId: string,
  versionId: string,
): Promise<{ readonly version: ArtifactVersionRow; readonly content: Buffer }> {
  const repositories = createRepositories(db);
  const { version } = await readArtifactVersionInWorkspace(repositories, workspaceId, versionId);

  return { version, content: await requireVerifiedContent(storage, version) };
}

async function requireVerifiedContent(
  storage: ManagedContentStore,
  version: ArtifactVersionRow,
): Promise<Buffer> {
  const result = await storage.readWithHashCheck(version.storage_ref, {
    contentHash: version.content_hash,
    size: version.size,
  });

  if (result.status !== 'OK') {
    throw evidenceUnavailable({ artifactVersionId: version.id, reason: result.status });
  }

  return result.content;
}

/**
 * 完成事务使用的证据核对：确切版本必须属于该 Task 的该 Workspace，
 * 并且受管内容仍然完整可用，否则拒绝依赖该证据的完成。
 */
export async function loadVerifiedArtifactVersion(
  repositories: Repositories,
  storage: ManagedContentStore,
  input: {
    readonly workspaceId: string;
    readonly taskId: string;
    readonly versionId: string;
  },
): Promise<{ readonly version: ArtifactVersionRow; readonly artifact: ArtifactRow }> {
  // 不存在的版本与跨作用域的版本一律按不可见处理（404），不泄漏存在性。
  const { version, artifact } = await readArtifactVersionInWorkspace(
    repositories,
    input.workspaceId,
    input.versionId,
  );

  if (artifact.task_id !== input.taskId) {
    throw validationFailed([
      {
        field: 'artifact_version_ids',
        message: 'must only reference versions of artifacts of this task',
      },
    ]);
  }

  await requireVerifiedContent(storage, version);

  return { version, artifact };
}
