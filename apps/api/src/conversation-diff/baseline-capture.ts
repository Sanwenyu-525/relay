/**
 * 会话基线的真实内容快照（工作台 §34.3）。
 *
 * 基线不是 `git diff HEAD` 的改写：它是「本轮对话开始以来」受管根的真实文件内容清单。
 * 因此这里直接读受管根下的实际文件，而不是比较 Git HEAD。规则：
 *   * 只在 Git 仓库内工作（根为仓库子目录时只覆盖该子目录，不读兄弟目录）；
 *   * 覆盖范围内的已跟踪文件与未被忽略的未跟踪文件；
 *   * 跳过 `.git` 内部、越界路径与受保护路径（复用 file-changeset 的保护规则）；
 *   * 小文件存真实文本（供净 diff 逐行算），大文件/二进制只存摘要与不可统计原因，
 *     不编造行数，也不把部分数据冒充完整（CD-07/08/16/17）。
 *   * 不创建 commit / stash / 分支 / worktree，不改用户的 index。
 *
 * 本模块只做只读采集；持久化由 repository 负责。无 Git 仓库时抛 NotAGitRepository，
 * 由上层按「非 Git 根（首版不可用）」处理。
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { runReadOnlyGit, type GitExecOptions } from '../git/git-adapter.js';
import { isProtectedPath } from '../files/file-changeset.js';
import type { BaselineFile, CurrentFile } from './diff-engine.js';

/** 存文本的上限；超过只保留摘要（行数仍可算）。 */
export const MAX_BASELINE_TEXT_BYTES = 64 * 1024;
/** 仍读取并计 hash 的单个文件上限；超过直接标 TEXT_TOO_LARGE 不读。 */
export const MAX_BASELINE_FILE_BYTES = 1 * 1024 * 1024;
/** 采集文件数上限；超过则 incomplete=true 并停止，保留已采集部分。 */
export const MAX_BASELINE_FILES = 2000;
/** 采集累计字节上限；超过则 incomplete=true 并停止。 */
export const MAX_BASELINE_TOTAL_BYTES = 32 * 1024 * 1024;

export class NotAGitRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAGitRepositoryError';
  }
}

/** `listScopedFiles` 里某一侧扫描停下来的位置。 */
export type ScanStopReason = 'FILE_COUNT_LIMIT' | 'TOTAL_BYTES_LIMIT' | 'SCAN_ABORTED';

export interface BaselineSnapshot {
  readonly rootPath: string;
  readonly files: readonly BaselineFile[];
  readonly incomplete: boolean;
  readonly captureReason: string;
}

/**
 * 「当前」一次扫描的完整结果。
 *
 * `unswept` 是本轮列到但没有逐条核对的路径（达到文件数／总量上限即停）：它们既不能算
 * 「已删除」也不能算「没变化」，所以必须单独带出去（§34.3 / CD-08 / CD-17）。
 * `tracked` 是 Git 索引里已跟踪的路径，用来区分「本会话新建」与「起点没扫到」。
 */
export interface CurrentScan {
  readonly files: Map<string, CurrentFile>;
  readonly unswept: ReadonlySet<string>;
  readonly tracked: ReadonlySet<string>;
  readonly incomplete: boolean;
  readonly reason: ScanStopReason | null;
  /** 本次列到的文件总数（不含受保护路径）；`files.size` 是已核对数。 */
  readonly listedTotal: number;
}

export interface BaselineCaptureOptions {
  /** 覆盖默认上限，便于测试与受控场景。 */
  readonly maxFiles?: number | undefined;
  readonly maxTotalBytes?: number | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly maxTextBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface CaptureLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxTextBytes: number;
}

/** 在 rootPath 内找到 Git 仓库顶层（仓库子目录也能正确定位）。 */
export async function findGitTopLevel(rootPath: string, options?: GitExecOptions): Promise<string> {
  const res = await runReadOnlyGit(['rev-parse', '--show-toplevel'], { cwd: rootPath, ...options });
  if (res.exitCode !== 0 || res.stdout.trim() === '') {
    throw new NotAGitRepositoryError(`路径不是 Git 仓库的一部分：${rootPath}`);
  }
  return res.stdout.trim();
}

/** 列出受管根范围内、未被忽略的已跟踪与未跟踪文件（相对根路径，保持 Git 的输出顺序）。 */
async function listScopedFiles(rootPath: string,
  topLevel: string): Promise<{ paths: string[]; tracked: Set<string> }> {
  const rootRel = relative(topLevel, rootPath).replace(/\\/g, '/').replace(/\/+$/, '');
  const pathspec = rootRel === '' ? '.' : rootRel;
  // -z 让 git 以 NUL 分隔输出，避免路径含空格/换行时错位（下方按 \0 切分）。
  const trackedRes = await runReadOnlyGit(['ls-files', '-z', '--', pathspec], { cwd: topLevel });
  const untrackedRes = await runReadOnlyGit(['ls-files', '-z', '--others', '--exclude-standard', '--', pathspec],
    { cwd: topLevel });
  const tracked = new Set<string>();
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (raw: string, isTracked: boolean): void => {
    if (raw === '') return;
    const rel = rootRel === '' ? raw : raw.startsWith(rootRel + '/') ? raw.slice(rootRel.length + 1) : null;
    if (rel === null) return;
    const normalized = rel.replace(/\\/g, '/');
    if (seen.has(normalized)) {
      if (isTracked) tracked.add(normalized);
      return;
    }
    seen.add(normalized);
    if (isTracked) tracked.add(normalized);
    paths.push(normalized);
  };
  for (const entry of trackedRes.stdout.split('\0')) add(entry.trim(), true);
  for (const entry of untrackedRes.stdout.split('\0')) add(entry.trim(), false);
  return { paths, tracked };
}

/** 从 `from` 起还没逐条核对的非受保护路径：这些文件本轮既不能说改了，也不能说没变。 */
function collectUnswept(paths: readonly string[], from: number): Set<string> {
  const out = new Set<string>();
  for (let cursor = from; cursor < paths.length; cursor++) {
    const rel = paths[cursor]!;
    if (!isProtectedPath(rel)) out.add(rel);
  }
  return out;
}

/**
 * 采集受管根的真实内容快照。
 *
 * 失败语义（§34.3）：采集超时/失权/失败不应破坏调用方原流程——调用方负责 try/catch。
 * 这里只在「不是 Git 仓库」时显式抛出，其余读失败按单文件 unavailable 处理。
 */
export async function captureBaseline(rootPath: string,
  options?: BaselineCaptureOptions): Promise<BaselineSnapshot> {
  const limits: CaptureLimits = {
    maxFiles: options?.maxFiles ?? MAX_BASELINE_FILES,
    maxTotalBytes: options?.maxTotalBytes ?? MAX_BASELINE_TOTAL_BYTES,
    maxFileBytes: options?.maxFileBytes ?? MAX_BASELINE_FILE_BYTES,
    maxTextBytes: options?.maxTextBytes ?? MAX_BASELINE_TEXT_BYTES,
  };

  let topLevel: string;
  try {
    topLevel = await findGitTopLevel(rootPath);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) throw error;
    throw error;
  }

  const { paths: relPaths } = await listScopedFiles(rootPath, topLevel);

  const files: BaselineFile[] = [];
  let totalBytes = 0;
  let incomplete = false;
  let captureReason = '';

  for (let index = 0; index < relPaths.length; index++) {
    const rel = relPaths[index]!;
    if (files.length >= limits.maxFiles) {
      incomplete = true;
      captureReason = 'FILE_COUNT_LIMIT';
      break;
    }
    if (isProtectedPath(rel)) continue;
    if (signalAborted(options?.signal)) {
      // 采到一半被中止同样是覆盖不完整：剩下的文件没有起点，不能事后当作「没变化」。
      incomplete = true;
      captureReason = 'SCAN_ABORTED';
      break;
    }

    const absolute = resolve(rootPath, rel);
    let entryStat;
    try {
      entryStat = await stat(absolute);
    } catch {
      continue; // 采集瞬间消失的文件跳过，不报错（不影响其余）。
    }
    if (!entryStat.isFile()) continue;

    const sizeBytes = Number(entryStat.size);
    if (sizeBytes > limits.maxFileBytes) {
      // 空串是「没读到内容」的标记，**不是**「文件不存在」：存在性由清单决定，
      // 分类侧（diff-engine 的 classifyAction）会把空串与 null 一并当「无摘要」。
      files.push({ path: rel, sha256: '', text: null, lineCount: null, sizeBytes,
        unavailableReason: 'TEXT_TOO_LARGE' });
      continue;
    }
    if (totalBytes + sizeBytes > limits.maxTotalBytes) {
      incomplete = true;
      captureReason = 'TOTAL_BYTES_LIMIT';
      break;
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      files.push({ path: rel, sha256: '', text: null, lineCount: null, sizeBytes,
        unavailableReason: 'UNREADABLE' });
      continue;
    }
    if (bytes.includes(0)) {
      files.push({ path: rel, sha256: computeSha256(bytes), text: null, lineCount: null,
        sizeBytes, unavailableReason: 'BINARY' });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      files.push({ path: rel, sha256: computeSha256(bytes), text: null, lineCount: null,
        sizeBytes, unavailableReason: 'BINARY' });
      continue;
    }
    const sha256 = computeSha256(bytes);
    let lineCount: number;
    if (text === '') lineCount = 0;
    else {
      const trimmed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/u, '');
      lineCount = trimmed === '' ? 0 : trimmed.split('\n').length;
    }
    files.push({
      path: rel,
      sha256,
      text: bytes.length <= limits.maxTextBytes ? text : null,
      lineCount,
      sizeBytes,
      unavailableReason: null,
    });
    totalBytes += sizeBytes;
  }

  return { rootPath, files, incomplete, captureReason };
}

/**
 * 采集受管根「当前」磁盘状态（用于与基线比较）。
 *
 * 与 `captureBaseline` 同样的枚举与边界规则，但只产出给 `computeSnapshotDiff` 用的
 * `CurrentFile`：存在文件给摘要/文本/行数，**确认不存在**（被删）的文件不出现（→ DELETE）。
 * 同样跳过 `.git`、越界与受保护路径；超限/二进制标不可统计，不编造行数。
 *
 * 达到文件数／总量上限或被中止而停下来时，剩下的路径进 `unswept`：它们只是「本轮没核对到」，
 * 不是「磁盘上没有」，绝不能被算成删除（§34.3 / CD-08 / CD-17）。
 */
export async function captureCurrentState(rootPath: string,
  options?: BaselineCaptureOptions): Promise<CurrentScan> {
  const limits: CaptureLimits = {
    maxFiles: options?.maxFiles ?? MAX_BASELINE_FILES,
    maxTotalBytes: options?.maxTotalBytes ?? MAX_BASELINE_TOTAL_BYTES,
    maxFileBytes: options?.maxFileBytes ?? MAX_BASELINE_FILE_BYTES,
    maxTextBytes: options?.maxTextBytes ?? MAX_BASELINE_TEXT_BYTES,
  };
  let topLevel: string;
  try {
    topLevel = await findGitTopLevel(rootPath);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) throw error;
    throw error;
  }
  const { paths: relPaths, tracked } = await listScopedFiles(rootPath, topLevel);
  const result = new Map<string, CurrentFile>();
  const unswept = new Set<string>();
  let totalBytes = 0;
  let incomplete = false;
  let reason: ScanStopReason | null = null;
  const stop = (index: number, why: ScanStopReason): void => {
    incomplete = true;
    reason = why;
    for (const path of collectUnswept(relPaths, index)) unswept.add(path);
  };
  for (let index = 0; index < relPaths.length; index++) {
    const rel = relPaths[index]!;
    if (result.size >= limits.maxFiles) { stop(index, 'FILE_COUNT_LIMIT'); break; }
    if (isProtectedPath(rel)) continue;
    if (signalAborted(options?.signal)) { stop(index, 'SCAN_ABORTED'); break; }
    const absolute = resolve(rootPath, rel);
    let entryStat;
    try {
      entryStat = await stat(absolute);
    } catch {
      continue; // 列到了却读不到 = 被删，不进入当前集合，也不进 unswept。
    }
    if (!entryStat.isFile()) continue;
    const sizeBytes = Number(entryStat.size);
    if (sizeBytes > limits.maxFileBytes) {
      result.set(rel, { path: rel, sha256: null, text: null, lineCount: null, sizeBytes,
        unavailableReason: 'TEXT_TOO_LARGE' });
      continue;
    }
    if (totalBytes + sizeBytes > limits.maxTotalBytes) { stop(index, 'TOTAL_BYTES_LIMIT'); break; }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      result.set(rel, { path: rel, sha256: null, text: null, lineCount: null, sizeBytes,
        unavailableReason: 'UNREADABLE' });
      continue;
    }
    if (bytes.includes(0)) {
      result.set(rel, { path: rel, sha256: computeSha256(bytes), text: null, lineCount: null,
        sizeBytes, unavailableReason: 'BINARY' });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      result.set(rel, { path: rel, sha256: computeSha256(bytes), text: null, lineCount: null,
        sizeBytes, unavailableReason: 'BINARY' });
      continue;
    }
    const sha256 = computeSha256(bytes);
    let lineCount: number;
    if (text === '') lineCount = 0;
    else {
      const trimmed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/u, '');
      lineCount = trimmed === '' ? 0 : trimmed.split('\n').length;
    }
    result.set(rel, {
      path: rel,
      sha256,
      text: bytes.length <= limits.maxTextBytes ? text : null,
      lineCount,
      sizeBytes,
      unavailableReason: null,
    });
    totalBytes += sizeBytes;
  }
  return { files: result, unswept, tracked, incomplete, reason,
    listedTotal: relPaths.filter((path) => !isProtectedPath(path)).length };
}

function computeSha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
