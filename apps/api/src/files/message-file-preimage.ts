/**
 * 写入前的真实字节前像（迁移 0132 / 工作台 §27.3）。
 *
 * 只在文件**真正落盘前**读取目标路径；记录的是这一条消息第一次触及该路径时的内容/存在性。
 * 不读 Git HEAD、不在事后补拍：发送前状态只能来自当时磁盘上的真实字节。
 * 读取失败或超过上限只让该路径不可恢复，不阻断原本的写动作。
 */

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalRelativePath, isProtectedPath, type FileChange } from './file-changeset.js';

/** 单文件前像上限；超过只记存在性/大小，撤回时该路径明确不可恢复。 */
export const MAX_MESSAGE_PREIMAGE_BYTES = 8 * 1024 * 1024;

export type PreimageUnavailableReason = 'CONTENT_TOO_LARGE' | 'READ_FAILED'
  | 'TARGET_NOT_REGULAR' | 'CAPACITY_FULL';

/**
 * §27.3.4 快照容量与保留的生效配置。推荐默认（5 GiB / 30 天）是**待真实 Windows
 * 项目测量校准的产品建议值**，不是承诺；环境变量只服务于受控测试与单机显式覆盖。
 */
export interface MessageSnapshotLimits {
  /** 每工作空间前像＋保护副本的累计字节预算。 */
  readonly budgetBytes: number;
  /** 保留天数；更旧且不被在途撤回/撤销引用的快照可被清理。 */
  readonly retentionDays: number;
}

export const DEFAULT_SNAPSHOT_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30;

export function readMessageSnapshotLimits(
  env: NodeJS.ProcessEnv = process.env): MessageSnapshotLimits {
  const budget = Number(env.RELAY_MESSAGE_SNAPSHOT_BUDGET_BYTES);
  const retention = Number(env.RELAY_MESSAGE_SNAPSHOT_RETENTION_DAYS);
  return {
    budgetBytes: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_SNAPSHOT_BUDGET_BYTES,
    retentionDays: Number.isFinite(retention) && retention >= 0
      ? retention : DEFAULT_SNAPSHOT_RETENTION_DAYS,
  };
}

export interface CapturedMessagePreimage {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly content: Buffer | null;
  readonly sha256: string | null;
  readonly sizeBytes: bigint | null;
  readonly unavailableReason: PreimageUnavailableReason | null;
}

/**
 * 按 changes 顺序返回前像；不可安全归因的路径返回 null（原写入仍照常执行）。
 * 前像在写入执行前采集并落库；写入失败时前像可能保留，撤回只采用 APPLIED 事件对应的前像。
 */
export async function captureMessageFilePreimages(rootPath: string,
  changes: readonly FileChange[]): Promise<readonly (CapturedMessagePreimage | null)[]> {
  const captured: (CapturedMessagePreimage | null)[] = [];
  for (const change of changes) {
    let relativePath: string;
    try {
      relativePath = canonicalRelativePath(rootPath, change.path);
    } catch {
      captured.push(null);
      continue;
    }
    if (relativePath === '' || isProtectedPath(relativePath)) {
      captured.push(null);
      continue;
    }
    captured.push(await captureOne(rootPath, relativePath));
  }
  return captured;
}

async function captureOne(rootPath: string,
  relativePath: string): Promise<CapturedMessagePreimage | null> {
  const absolute = resolve(rootPath, relativePath);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { relativePath, existed: false, content: null, sha256: null,
        sizeBytes: null, unavailableReason: null };
    }
    return { relativePath, existed: true, content: null, sha256: null,
      sizeBytes: null, unavailableReason: 'READ_FAILED' };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    // 写入执行器本身会拒绝链接/非普通文件；这里不猜内容，也不产生可恢复承诺。
    return { relativePath, existed: true, content: null, sha256: null,
      sizeBytes: null, unavailableReason: 'TARGET_NOT_REGULAR' };
  }
  const sizeBytes = BigInt(info.size);
  if (info.size > MAX_MESSAGE_PREIMAGE_BYTES) {
    return { relativePath, existed: true, content: null, sha256: null,
      sizeBytes, unavailableReason: 'CONTENT_TOO_LARGE' };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return { relativePath, existed: true, content: null, sha256: null,
      sizeBytes, unavailableReason: 'READ_FAILED' };
  }
  return { relativePath, existed: true, content: bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: BigInt(bytes.byteLength), unavailableReason: null };
}
