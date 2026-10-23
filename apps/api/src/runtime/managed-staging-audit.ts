import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { STAGING_DIRECTORY } from '../storage/managed-content-store.js';

/**
 * 孤儿暂存核对（docs/database/physical-design-postgresql.md 第 7 节：
 * V1 默认保留孤儿并提供核对报告，不自动清理）。
 *
 * 发布顺序是「同文件系统暂存 → 完整写入 → rename 到不可变版本目录 → 数据库登记版本」，
 * 因此 rename 之前崩溃会留下 `staging/<version-id>.part` 且没有任何版本行引用它。
 * 判定只依赖既有事实：暂存文件名携带 version id，`artifact_versions.id` 是同一身份；
 * 不新增表、不新增列，也不需要发布方配合登记。
 *
 * 只报告、不删除：核对不移动、不改写、不清理任何文件，也不把孤儿当作失败——
 * 宽限期与自动清理仍未启用，是否处置由人决定。
 */

/** 暂存文件名只能是 `<version-id>.part`：两个平台（Node 与 Windows native helper）同一约定。 */
const STAGING_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.part$/iu;

/** 孤儿原因：名字对得上版本身份但版本表没有这一行；或名字本身不可能对应任何版本。 */
export type ManagedStagingOrphanReason = 'NO_ARTIFACT_VERSION' | 'UNRECOGNIZED_STAGING_NAME';

export interface ManagedStagingOrphan {
  /** 受管相对路径，形如 staging/<version-id>.part，便于直接在 data_root 内定位。 */
  readonly staging_ref: string;
  /** 文件名解析出的 version id；无法解析时为 null。 */
  readonly version_id: string | null;
  readonly size_bytes: number;
  readonly modified_at: string;
  readonly reason: ManagedStagingOrphanReason;
}

/** 版本表已登记、却仍留在暂存目录的条目：正常发布会 rename 走暂存文件，出现即异常。 */
export interface ManagedStagingReferencedEntry {
  readonly staging_ref: string;
  readonly version_id: string;
  readonly size_bytes: number;
  readonly modified_at: string;
}

export interface ManagedStagingAuditReport {
  readonly data_root: string;
  /** 暂存目录中的条目总数（含被引用条目与无法识别的条目）。 */
  readonly staging_entry_count: number;
  readonly orphan_count: number;
  readonly orphans: readonly ManagedStagingOrphan[];
  readonly referenced_staging_entries: readonly ManagedStagingReferencedEntry[];
}

/**
 * 核对 data_root 下的受管暂存目录，列出未被任何 Artifact 版本引用的暂存文件。
 *
 * 列举与查询之间不是同一快照：核对期间新的发布可能同时进行，报告如实反映核对时刻
 * 观测到的状态，不声称与任何其他时刻一致。staging 目录不存在时视为没有暂存内容，
 * 不是错误。
 */
export async function auditManagedStaging(
  db: DbExecutor,
  dataRoot: string,
): Promise<ManagedStagingAuditReport> {
  const root = resolve(dataRoot);
  const entries = await listStagingEntries(root);
  const versionIds = new Set<string>();

  for (const entry of entries) {
    const versionId = STAGING_FILE_PATTERN.exec(entry.name)?.[1];
    if (versionId !== undefined) versionIds.add(versionId.toLowerCase());
  }

  const referenced = versionIds.size === 0
    ? new Set<string>()
    : new Set(
      (await sql<{ id: string }>`
        select id from artifact_versions where id = any(${[...versionIds]}::uuid[])
      `.execute(db)).rows.map((row) => row.id.toLowerCase()),
    );

  const orphans: ManagedStagingOrphan[] = [];
  const referencedEntries: ManagedStagingReferencedEntry[] = [];

  for (const entry of entries) {
    const versionId = STAGING_FILE_PATTERN.exec(entry.name)?.[1]?.toLowerCase() ?? null;
    const summary = {
      staging_ref: `${STAGING_DIRECTORY}/${entry.name}`,
      size_bytes: entry.sizeBytes,
      modified_at: entry.modifiedAt,
    };

    if (versionId === null) {
      orphans.push({ ...summary, version_id: null, reason: 'UNRECOGNIZED_STAGING_NAME' });
    } else if (referenced.has(versionId)) {
      referencedEntries.push({ ...summary, version_id: versionId });
    } else {
      orphans.push({ ...summary, version_id: versionId, reason: 'NO_ARTIFACT_VERSION' });
    }
  }

  orphans.sort((left, right) => (left.staging_ref < right.staging_ref ? -1 : 1));
  referencedEntries.sort((left, right) => (left.staging_ref < right.staging_ref ? -1 : 1));

  return {
    data_root: root,
    staging_entry_count: entries.length,
    orphan_count: orphans.length,
    orphans,
    referenced_staging_entries: referencedEntries,
  };
}

interface StagingEntry {
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

/** 只读列举：不跟随符号链接（lstat），不读取任何文件内容。目录不存在即没有暂存内容。 */
async function listStagingEntries(root: string): Promise<readonly StagingEntry[]> {
  const directory = join(root, STAGING_DIRECTORY);
  let names: string[];

  try {
    names = await readdir(directory);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  names.sort();
  const entries: StagingEntry[] = [];

  for (const name of names) {
    const stats = await lstat(join(directory, name));
    entries.push({
      name,
      sizeBytes: Number(stats.size),
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return entries;
}
