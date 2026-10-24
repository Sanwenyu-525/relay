/**
 * 0132：消息发送前文件基线的采集与落库（运行架构 §8.5、工作台 §27.3.4；2026-10-24
 * 用户拍板按发送前基线口径，取代此前的首写前像实现）。
 *
 * 每条用户消息在准入事务内建立与消息身份绑定的受管根字节基线：提交后助手轮次才可能
 * 开始写文件，因此这里读到的就是「发送前」状态。字节入内容寻址库（同内容跨消息去重，
 * 未变化的文件不产生新字节），条目只存存在性与摘要。采集失败/超限/预算占满不阻塞
 * 消息——按 INCOMPLETE 基线如实记录原因，缺条目的路径在撤回时按不可恢复处理。
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isProtectedPath } from '../files/file-changeset.js';
import type { Repositories } from './unit-of-work.js';
import type { MessageRecallRepository } from '../assist/message-recall-repository.js';
import type { AssistSessionRow } from '../infrastructure/database-schema.js';

/**
 * §27.3.4 快照容量与保留的生效配置。推荐默认（5 GiB / 30 天 / 50 MiB 单文件）是
 * **待真实 Windows 项目测量校准的产品建议值**；环境变量只服务于受控测试与单机显式覆盖。
 */
export interface MessageSnapshotLimits {
  /** 每工作空间基线字节库＋保护副本的累计字节预算。 */
  readonly budgetBytes: number;
  /** 保留天数；更旧且不被在途撤回/撤销引用的快照可被清理。 */
  readonly retentionDays: number;
  /** 单文件快照上限（基线与保护副本共用；§27.3.4 推荐 50 MiB）。 */
  readonly maxFileBytes: number;
}

export const DEFAULT_SNAPSHOT_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30;
export const DEFAULT_SNAPSHOT_FILE_BYTES = 50 * 1024 * 1024;

export function readMessageSnapshotLimits(
  env: NodeJS.ProcessEnv = process.env): MessageSnapshotLimits {
  const budget = Number(env.RELAY_MESSAGE_SNAPSHOT_BUDGET_BYTES);
  const retention = Number(env.RELAY_MESSAGE_SNAPSHOT_RETENTION_DAYS);
  return {
    budgetBytes: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_SNAPSHOT_BUDGET_BYTES,
    retentionDays: Number.isFinite(retention) && retention >= 0
      ? retention : DEFAULT_SNAPSHOT_RETENTION_DAYS,
    maxFileBytes: DEFAULT_SNAPSHOT_FILE_BYTES,
  };
}

/** 单次基线采集的文件数与累计读取上限：控制采集时长，超限如实标 INCOMPLETE。 */
export const MAX_BASELINE_FILES = 2000;
export const MAX_BASELINE_WALK_BYTES = 512 * 1024 * 1024;

export interface CaptureBaselineInput {
  readonly workspaceId: string;
  readonly session: AssistSessionRow;
  readonly messageId: string;
  readonly resourceId: string;
  readonly rootPath: string;
}

export interface CaptureBaselineResult {
  readonly status: 'COMPLETE' | 'INCOMPLETE';
  readonly reason: string;
}

interface WalkedFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: bigint;
}

interface WalkOutcome {
  readonly files: readonly WalkedFile[];
  readonly unavailable: readonly { relativePath: string; reason: string }[];
  readonly stopped: string | null;
}

/**
 * 受管根的字节清单（只算摘要，不持有字节）。规则：
 *   * 不依赖 Git；递归枚举普通文件，跳过受保护路径（.git/.env/node_modules/.relay/data）
 *     与符号链接（会话写拒绝穿透链接，链接路径不会成为撤回目标）；
 *   * 单文件超限/读取失败 → 该路径记不可恢复原因，不影响其余；
 *   * 文件数/总量超限 → 停止并如实标 INCOMPLETE：剩余路径没有起点。
 */
export async function walkBaselineFiles(rootPath: string,
  limits: MessageSnapshotLimits): Promise<WalkOutcome> {
  const files: WalkedFile[] = [];
  const unavailable: { relativePath: string; reason: string }[] = [];
  let stopped: string | null = null;
  const queue: string[] = [''];
  while (queue.length > 0 && stopped === null) {
    const dirRel = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(dirRel === '' ? rootPath : join(rootPath, dirRel),
        { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const rel = dirRel === '' ? dirent.name : `${dirRel}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!isProtectedPath(rel)) queue.push(rel);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isProtectedPath(rel)) continue;
      if (files.length + unavailable.length >= MAX_BASELINE_FILES) {
        stopped = 'FILE_COUNT_LIMIT';
        break;
      }
      const absolute = resolve(rootPath, rel);
      let sizeBytes: number;
      try {
        const entryStat = await lstat(absolute);
        if (!entryStat.isFile()) continue;
        sizeBytes = Number(entryStat.size);
      } catch {
        continue;
      }
      if (sizeBytes > limits.maxFileBytes) {
        unavailable.push({ relativePath: rel, reason: 'CONTENT_TOO_LARGE' });
        continue;
      }
      if (files.reduce((sum, file) => sum + file.sizeBytes, 0n) + BigInt(sizeBytes)
          > MAX_BASELINE_WALK_BYTES) {
        stopped = 'TOTAL_BYTES_LIMIT';
        break;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch {
        unavailable.push({ relativePath: rel, reason: 'READ_FAILED' });
        continue;
      }
      files.push({ relativePath: rel,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: BigInt(sizeBytes) });
    }
  }
  return { files, unavailable, stopped };
}

/**
 * 为一条用户消息建立发送前基线。在消息准入事务内调用；本函数不抛错——
 * 采集失败按 INCOMPLETE 基线记录原因，消息与执行流程不受影响。
 * 幂等：同一消息已有基线时直接复用（准入命令重放路径）。
 */
export async function captureMessageBaseline(repositories: Repositories,
  input: CaptureBaselineInput): Promise<CaptureBaselineResult> {
  const existingBaseline = await repositories.messageRecall.findBaselineByMessage(
    input.messageId);
  if (existingBaseline !== undefined) {
    return { status: existingBaseline.status, reason: existingBaseline.reason };
  }
  const limits = readMessageSnapshotLimits();

  let outcome: WalkOutcome;
  try {
    outcome = await walkBaselineFiles(input.rootPath, limits);
  } catch (error) {
    await insertDegradedBaseline(repositories.messageRecall, input,
      `CAPTURE_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
    return { status: 'INCOMPLETE', reason: 'CAPTURE_FAILED' };
  }

  const unavailable = [...outcome.unavailable];
  let stopped = outcome.stopped;
  // 数据库阶段整体在保存点内：任一语句失败只丢弃本次基线（此后撤回按 BASELINE_MISSING
  // 如实处理），不把外层消息准入事务置为 aborted。
  const committed = await repositories.messageRecall.inSavepoint(
    async (sp): Promise<CaptureBaselineResult> => {
    try {
    // 去重（§27.3.4）：字节库已有的内容不产生新字节；只有新增字节计入容量预算。
    const uniqueShas = [...new Set(outcome.files.map((file) => file.sha256))];
    const existingShas = await sp.filterExistingBlobShas(uniqueShas);
    let usageBytes = 0n;
    try {
      usageBytes = (await sp.snapshotUsage(input.workspaceId)).bytes;
    } catch { usageBytes = BigInt(Number.MAX_SAFE_INTEGER); }

    const budget = BigInt(limits.budgetBytes);
    let newBytes = 0n;
    const fresh: WalkedFile[] = [];
    const kept: WalkedFile[] = [];
    for (const file of outcome.files) {
      if (existingShas.has(file.sha256)) { kept.push(file); continue; }
      if (usageBytes + newBytes + file.sizeBytes > budget) {
        stopped = stopped ?? 'CAPACITY_FULL';
        continue;
      }
      newBytes += file.sizeBytes;
      fresh.push(file);
      kept.push(file);
    }

    // 只对新增字节重读内容并登记（常为空集；首条消息一次性入库）。
    const withContent: (WalkedFile & { content: Buffer })[] = [];
    for (const file of fresh) {
      try {
        const bytes = await readFile(resolve(input.rootPath, file.relativePath));
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
          unavailable.push({ relativePath: file.relativePath, reason: 'READ_FAILED' });
          continue;
        }
        withContent.push({ ...file, content: bytes });
      } catch {
        unavailable.push({ relativePath: file.relativePath, reason: 'READ_FAILED' });
      }
    }
    const keptPaths = new Set(withContent.map((file) => file.relativePath));
    const finalKept = kept.filter((file) =>
      existingShas.has(file.sha256) || keptPaths.has(file.relativePath));
    await sp.registerBaselineBlobs(withContent);

    const status: 'COMPLETE' | 'INCOMPLETE' = stopped === null ? 'COMPLETE' : 'INCOMPLETE';
    const baseline = await sp.insertBaseline({
      id: randomUUID(), workspaceId: input.workspaceId, sessionId: input.session.id,
      messageId: input.messageId, resourceId: input.resourceId, rootPath: input.rootPath,
      status, reason: stopped ?? '', fileCount: finalKept.length + unavailable.length,
      totalBytes: finalKept.reduce((sum, file) => sum + file.sizeBytes, 0n) });
    await sp.insertBaselineFiles(baseline.id,
      [...finalKept.map((file) => ({ relativePath: file.relativePath,
        blobSha256: file.sha256, sizeBytes: file.sizeBytes, unavailableReason: null })),
       ...unavailable.map((file) => ({ relativePath: file.relativePath,
        blobSha256: null, sizeBytes: null, unavailableReason: file.reason }))]);
    return { status, reason: stopped ?? '' };
  } catch (error) {
    await insertDegradedBaseline(sp, input,
      `STORE_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
    return { status: 'INCOMPLETE', reason: 'STORE_FAILED' };
  }
  });
  return committed ?? { status: 'INCOMPLETE', reason: 'CAPTURE_SAVEPOINT_FAILED' };
}

async function insertDegradedBaseline(repository: MessageRecallRepository,
  input: CaptureBaselineInput, reason: string): Promise<void> {
  await repository.insertBaseline({
    id: randomUUID(), workspaceId: input.workspaceId, sessionId: input.session.id,
    messageId: input.messageId, resourceId: input.resourceId, rootPath: input.rootPath,
    status: 'INCOMPLETE', reason, fileCount: 0, totalBytes: 0n });
}
