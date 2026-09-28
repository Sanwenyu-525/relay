import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, parse, relative, resolve, sep } from 'node:path';
import type { JsonObject } from '../infrastructure/json.js';

export interface FileChange {
  readonly path: string; // relative to root
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly baselineSha256?: string | null | undefined;
  readonly content?: string | undefined;
  readonly targetSha256?: string | undefined;
}

export interface FileChangeOutcome {
  readonly path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly status: 'APPLIED' | 'CONFLICT' | 'FAILED';
  readonly baselineSha256?: string | null | undefined;
  readonly actualBaselineSha256?: string | null | undefined;
  readonly targetSha256?: string | null | undefined;
  readonly error?: string | undefined;
}

export interface ChangesetResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly changes: readonly FileChangeOutcome[];
  readonly reason?: string | undefined;
}

const PROTECTED_PATH_PATTERNS = [
  /^\.git(\/|\\|$)/i,
  /^\.env(\..+)?$/i,
  /^node_modules(\/|\\|$)/i,
  /^\.relay(\/|\\|$)/i,
  /^data(\/|\\|$)/i,
];

export function isProtectedPath(relativePath: string): boolean {
  // 归一到 POSIX 风格的根内相对形态再做匹配：统一反斜杠、剥离根锚点前缀
  // ('./' 或 '/'/'\')，并大小写不敏感（Windows 文件系统对大小写不敏感），
  // 使 './.env'、'.\\ENV'、'foo/../.env' 等等价形式都能命中同一保护规则。
  const normalized = relativePath
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .replace(/^\/+/, '');
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized.toLowerCase()));
}

/** Check raw segments before Windows path APIs can normalize an unsafe alias. */
export function assertSafeWindowsPathSegments(path: string): void {
  if (process.platform === 'win32') {
    const segments = isAbsolute(path) ? path.slice(parse(path).root.length) : path;
    for (const segment of segments.split(/[\\/]/)) {
      if (segment === '' || segment === '.' || segment === '..') continue;
      const base = segment.split('.')[0]?.trimEnd();
      if (/[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(base ?? '')) {
        throw new Error(`Windows path segment '${segment}' is unsafe`);
      }
    }
  }
}

export function validateSafeRelativePath(rootPath: string, relativePath: string): string {
  if (relativePath.includes('\u0000')) {
    throw new Error('Path contains null bytes');
  }
  if (isAbsolute(relativePath)) {
    throw new Error('Path must be relative');
  }
  assertSafeWindowsPathSegments(relativePath);
  // 先归一再判定：resolve 会消解 './' 与根内 '..'，得到唯一的规范绝对路径，
  // 之后据此计算根内相对路径（统一反斜杠），避免 '.\./.env'、'foo/../.env'
  // 等等价别名绕过保护规则。逃逸检查仍在保护检查之前，不放宽禁止目录范围。
  const resolved = resolve(rootPath, relativePath);
  const rel = relative(rootPath, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path '${relativePath}' escapes the resource root`);
  }
  if (isProtectedPath(rel)) {
    throw new Error(`Path '${rel}' is protected and cannot be modified`);
  }
  return resolved;
}

/** 与落盘目标一致的根内路径，也是 change_set_files 的相对路径表示。 */
export function canonicalRelativePath(rootPath: string, relativePath: string): string {
  return relative(rootPath, validateSafeRelativePath(rootPath, relativePath)).replaceAll('\\', '/');
}

export function computeSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Maximum persisted UTF-8 baseline text for one frozen FILE_WRITE path. */
export const MAX_FILE_WRITE_DIFF_TEXT_BYTES = 64 * 1024;

export interface FrozenFileWriteBaseline {
  readonly baselineSha256: string;
  readonly baselineText: string | null;
  readonly unavailableReason: string | null;
}

/** Best-effort evidence read. Failure only makes the planned diff unavailable; execution still uses its frozen hash. */
export async function readFrozenFileWriteBaseline(root: string, relativePath: string,
  baselineSha256: string): Promise<FrozenFileWriteBaseline> {
  const expected = baselineSha256.toLowerCase();
  const unavailable = (reason: string): FrozenFileWriteBaseline => ({
    baselineSha256: expected, baselineText: null, unavailableReason: reason,
  });
  let path: string;
  let initialIdentity: { dev: number; ino: number };
  try {
    path = validateSafeRelativePath(root, relativePath);
    if (!sameFrozenPath(root, await realpath(root))) return unavailable('ROOT_CHANGED');
    // Reject changed or linked parents. This read creates no directory.
    let parent = dirname(path);
    while (parent !== root) {
      if (!sameFrozenPath(parent, await realpath(parent))) return unavailable('PARENT_CHANGED');
      parent = dirname(parent);
    }
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return unavailable('TARGET_NOT_REGULAR');
    if (!sameFrozenPath(path, await realpath(path))) return unavailable('TARGET_NOT_REGULAR');
    initialIdentity = { dev: entry.dev, ino: entry.ino };
  } catch {
    return unavailable('UNSAFE_OR_UNREADABLE');
  }
  try {
    // Windows lacks O_NOFOLLOW; compare the opened file with pre/post path identities.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const entry = await handle.stat();
      if (!entry.isFile()) return unavailable('TARGET_NOT_REGULAR');
      if (entry.dev !== initialIdentity.dev || entry.ino !== initialIdentity.ino) {
        return unavailable('UNSAFE_OR_UNREADABLE');
      }
      if (entry.size > MAX_FILE_WRITE_DIFF_TEXT_BYTES) return unavailable('TEXT_TOO_LARGE');
      const chunks: Buffer[] = [];
      let size = 0;
      const chunk = Buffer.allocUnsafe(Math.min(8192, MAX_FILE_WRITE_DIFF_TEXT_BYTES + 1));
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > MAX_FILE_WRITE_DIFF_TEXT_BYTES) return unavailable('TEXT_TOO_LARGE');
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      const bytes = Buffer.concat(chunks, size);
      const finalEntry = await lstat(path);
      if (!finalEntry.isFile() || finalEntry.isSymbolicLink() ||
          finalEntry.dev !== entry.dev || finalEntry.ino !== entry.ino ||
          !sameFrozenPath(path, await realpath(path))) return unavailable('UNSAFE_OR_UNREADABLE');
      if (computeSha256(bytes) !== expected) return unavailable('BASELINE_SHA_MISMATCH');
      if (bytes.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
        return unavailable('BINARY_OR_INVALID_UTF8');
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return unavailable('BINARY_OR_INVALID_UTF8'); }
      if (computeSha256(text) !== expected) return unavailable('BINARY_OR_INVALID_UTF8');
      return { baselineSha256: expected, baselineText: text, unavailableReason: null };
    } finally {
      await handle.close();
    }
  } catch {
    return unavailable('UNSAFE_OR_UNREADABLE');
  }
}

/** 冻结基线摘要必须是格式有效的 64 位十六进制 SHA-256；大小写不敏感但不容忍缺位/多余字符。 */
export function isFrozenBaseline(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * 修改/删除一个既有文件必须先冻结其基线摘要，才可能在落盘前比对当前内容检测外部编辑。
 * CREATE 面向尚不存在的路径，无基线可冻结，因此放行。人工批准不能替代本检查。
 */
export function requireFrozenBaseline(change: Pick<FileChange, 'action' | 'baselineSha256'>): void {
  if ((change.action === 'MODIFY' || change.action === 'DELETE') && !isFrozenBaseline(change.baselineSha256)) {
    throw new Error(`${change.action} requires a valid frozen baseline SHA-256`);
  }
}

/** 声明目标摘要只能描述本次真正要写的 UTF-8 内容。 */
export function requireMatchingTarget(change: Pick<FileChange, 'action' | 'content' | 'targetSha256'>): void {
  if (change.action === 'DELETE') return;
  if (typeof change.content !== 'string') throw new Error(`${change.action} requires explicit string content`);
  if (change.targetSha256 === undefined) return;
  if (!isFrozenBaseline(change.targetSha256) ||
      change.targetSha256.toLowerCase() !== computeSha256(change.content)) {
    throw new Error('targetSha256 must match SHA-256 of content');
  }
}

function sameFrozenPath(expected: string, actual: string): boolean {
  return process.platform === 'win32'
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
}

/** 逐级确认父目录；仅 CREATE 可创建缺失目录，且不能穿过根外链接。 */
async function prepareParentInsideRoot(root: string, parent: string, createMissing: boolean): Promise<boolean> {
  const rel = relative(root, parent);
  let current = root;
  if (rel === '') {
    if (!sameFrozenPath(root, await realpath(root))) throw new Error('Frozen root changed');
    return true;
  }
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    let actual: string;
    try {
      actual = await realpath(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!createMissing) return false;
      const actualParent = await realpath(dirname(current));
      if (!sameFrozenPath(dirname(current), actualParent)) throw new Error('Parent directory changed');
      await mkdir(current);
      actual = await realpath(current);
    }
    if (!sameFrozenPath(current, actual)) throw new Error('Parent directory changed');
  }
  return true;
}

function rejectedRoot(changes: readonly FileChange[], reason: string): ChangesetResult {
  return { outcome: 'FAILED', reason, changes: changes.map((change) => ({
    path: change.path, action: change.action, status: 'FAILED', error: reason,
  })) };
}

export async function executeFileChangeset(
  rootPath: string,
  changes: readonly FileChange[],
  signal?: AbortSignal,
): Promise<ChangesetResult> {
  let currentRoot: string;
  try {
    currentRoot = await realpath(rootPath);
  } catch {
    return rejectedRoot(changes, 'CANONICAL_ROOT_UNAVAILABLE');
  }
  if (!sameFrozenPath(rootPath, currentRoot)) return rejectedRoot(changes, 'CANONICAL_ROOT_CHANGED');
  const canonicalRoot = rootPath;
  const outcomes: FileChangeOutcome[] = [];
  let anyFailure = false;

  for (const change of changes) {
    if (signal?.aborted) {
      outcomes.push({
        path: change.path,
        action: change.action,
        status: 'FAILED',
        error: 'Execution cancelled via AbortSignal',
      });
      anyFailure = true;
      continue;
    }

    // 修改/删除的冻结基线及写入内容/目标摘要都须在解析路径、创建父目录等
    // 副作用之前验证，非法声明绝不触碰磁盘。
    try {
      requireFrozenBaseline(change);
      requireMatchingTarget(change);
    } catch (err) {
      outcomes.push({
        path: change.path,
        action: change.action,
        status: 'FAILED',
        baselineSha256: change.baselineSha256,
        error: (err as Error).message,
      });
      anyFailure = true;
      continue;
    }

    let resolvedPath: string;
    try {
      resolvedPath = validateSafeRelativePath(canonicalRoot, change.path);
    } catch (err) {
      outcomes.push({
        path: change.path,
        action: change.action,
        status: 'FAILED',
        error: (err as Error).message,
      });
      anyFailure = true;
      continue;
    }

    // Check each parent before touching the file; only CREATE may create directories.
    try {
      const parentExists = await prepareParentInsideRoot(canonicalRoot, dirname(resolvedPath),
        change.action === 'CREATE');
      if (!parentExists) {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'CONFLICT',
          actualBaselineSha256: null,
          baselineSha256: change.baselineSha256,
          error: 'File does not exist; cannot MODIFY/DELETE',
        });
        anyFailure = true;
        continue;
      }
    } catch (err) {
      outcomes.push({
        path: change.path,
        action: change.action,
        status: 'FAILED',
        error: `Failed to prepare parent directory: ${(err as Error).message}`,
      });
      anyFailure = true;
      continue;
    }

    // Inspect current file status
    let currentBytes: Buffer | null = null;
    let currentSha: string | null = null;
    let fileExists = false;
    try {
      const st = await lstat(resolvedPath);
      if (st.isSymbolicLink()) {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'FAILED',
          error: 'Target file is a symbolic link; direct link mutation is denied',
        });
        anyFailure = true;
        continue;
      }
      if (!st.isFile()) {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'FAILED',
          error: 'Target exists but is not a regular file',
        });
        anyFailure = true;
        continue;
      }
      fileExists = true;
      currentBytes = await readFile(resolvedPath);
      currentSha = computeSha256(currentBytes);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'FAILED',
          error: (err as Error).message,
        });
        anyFailure = true;
        continue;
      }
      fileExists = false;
    }

    // Verify baseline
    if (change.action === 'CREATE') {
      if (fileExists) {
        outcomes.push({
          path: change.path,
          action: 'CREATE',
          status: 'CONFLICT',
          actualBaselineSha256: currentSha,
          error: 'File already exists; cannot CREATE',
        });
        anyFailure = true;
        continue;
      }
    } else if (change.action === 'MODIFY' || change.action === 'DELETE') {
      if (!fileExists) {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'CONFLICT',
          actualBaselineSha256: null,
          baselineSha256: change.baselineSha256,
          error: 'File does not exist; cannot MODIFY/DELETE',
        });
        anyFailure = true;
        continue;
      }
      if (currentSha !== change.baselineSha256?.toLowerCase()) {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'CONFLICT',
          actualBaselineSha256: currentSha,
          baselineSha256: change.baselineSha256,
          error: 'Baseline SHA-256 conflict; file was modified externally',
        });
        anyFailure = true;
        continue;
      }
    }

    // Apply change
    try {
      if (change.action === 'DELETE') {
        await rm(resolvedPath);
        outcomes.push({
          path: change.path,
          action: 'DELETE',
          status: 'APPLIED',
          baselineSha256: change.baselineSha256,
          actualBaselineSha256: currentSha,
        });
      } else {
        const bytes = Buffer.from(change.content!, 'utf8');
        const targetSha = computeSha256(bytes);
        await writeFile(resolvedPath, bytes);
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'APPLIED',
          baselineSha256: change.baselineSha256,
          actualBaselineSha256: currentSha,
          targetSha256: targetSha,
        });
      }
    } catch (err) {
      outcomes.push({
        path: change.path,
        action: change.action,
        status: 'FAILED',
        error: (err as Error).message,
      });
      anyFailure = true;
    }
  }

  return {
    outcome: anyFailure ? 'FAILED' : 'SUCCEEDED',
    changes: outcomes,
    reason: anyFailure ? 'SOME_CHANGES_FAILED_OR_CONFLICTED' : undefined,
  };
}

/** 逐文件只读核对观测：期望摘要与实际回读摘要，以及二者是否一致。 */
export interface FileReconciliationCheck {
  readonly path: string;
  readonly expectedSha: string | null;
  readonly actualSha: string | null;
  readonly matches: boolean;
  readonly readError?: string;
}

async function boundedFileHash(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    const part = Buffer.from(chunk);
    bytes += part.byteLength;
    if (bytes > maxBytes) throw new Error('FILE_TOO_LARGE');
    hash.update(part);
  }
  return hash.digest('hex');
}

function unconfirmedRoot(changes: readonly FileChange[], reason: string): {
  outcome: 'FAILED'; checks: readonly FileReconciliationCheck[]; details: JsonObject;
} {
  const checks = changes.map((change) => ({ path: change.path,
    expectedSha: change.action === 'DELETE' ? null :
      (change.targetSha256?.toLowerCase() ??
        (change.content !== undefined ? computeSha256(change.content) : null)),
    actualSha: null, matches: false, readError: reason }));
  return { outcome: 'FAILED', checks, details: { reconciliation: 'MISMATCH_OR_PARTIAL', reason,
    checks: checks as unknown as JsonObject[] } };
}

export async function reconcileFileChangeset(
  rootPath: string,
  changes: readonly FileChange[],
  options?: { readonly maxFileBytes: number; readonly signal?: AbortSignal },
): Promise<{
  outcome: 'SUCCEEDED' | 'FAILED';
  checks: readonly FileReconciliationCheck[];
  details: JsonObject;
}> {
  let currentRoot: string;
  try {
    currentRoot = await realpath(rootPath);
  } catch {
    return unconfirmedRoot(changes, 'CANONICAL_ROOT_UNAVAILABLE');
  }
  if (!sameFrozenPath(rootPath, currentRoot)) {
    return unconfirmedRoot(changes, 'CANONICAL_ROOT_CHANGED');
  }
  const canonicalRoot = rootPath;

  const fileChecks: FileReconciliationCheck[] = [];
  let allMatch = true;

  for (const change of changes) {
    let resolvedPath: string;
    try {
      resolvedPath = validateSafeRelativePath(canonicalRoot, change.path);
    } catch {
      allMatch = false;
      fileChecks.push({ path: change.path, expectedSha: null, actualSha: null, matches: false });
      continue;
    }

    const expectedSha = change.action === 'DELETE' ? null :
      (change.targetSha256?.toLowerCase() ?? (change.content !== undefined ? computeSha256(change.content) : null));
    try {
      const actualParent = await realpath(dirname(resolvedPath));
      if (!sameFrozenPath(dirname(resolvedPath), actualParent)) throw new Error('PARENT_CHANGED');
    } catch (err) {
      allMatch = false;
      fileChecks.push({ path: change.path, expectedSha, actualSha: null, matches: false,
        readError: (err as Error).message });
      continue;
    }

    let actualSha: string | null = null;
    let readError: string | undefined;
    try {
      const st = await lstat(resolvedPath);
      if (!st.isFile()) {
        readError = 'TARGET_NOT_REGULAR';
      } else {
        try {
          actualSha = options === undefined
            ? computeSha256(await readFile(resolvedPath))
            : await boundedFileHash(resolvedPath, options.maxFileBytes, options.signal);
        } catch (err) {
          readError = `READ_FAILED:${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        readError = `LSTAT_FAILED:${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`;
      }
    }

    const matches = readError === undefined &&
      (change.action === 'DELETE' || typeof change.content === 'string') && actualSha === expectedSha;
    if (!matches) {
      allMatch = false;
    }
    fileChecks.push({ path: change.path, expectedSha, actualSha, matches, ...(readError === undefined ? {} : { readError }) });
  }

  return {
    outcome: allMatch ? 'SUCCEEDED' : 'FAILED',
    checks: fileChecks,
    details: {
      reconciliation: allMatch ? 'ALL_MATCH' : 'MISMATCH_OR_PARTIAL',
      checks: fileChecks as unknown as JsonObject[],
    },
  };
}
