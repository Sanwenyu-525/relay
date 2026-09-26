import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
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
  const normalized = relativePath.replace(/^[/\\]+/, '').replaceAll('\\', '/');
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateSafeRelativePath(rootPath: string, relativePath: string): string {
  if (relativePath.includes('\u0000')) {
    throw new Error('Path contains null bytes');
  }
  if (isAbsolute(relativePath)) {
    throw new Error('Path must be relative');
  }
  if (isProtectedPath(relativePath)) {
    throw new Error(`Path '${relativePath}' is protected and cannot be modified`);
  }
  const resolved = resolve(rootPath, relativePath);
  const rel = relative(rootPath, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path '${relativePath}' escapes the resource root`);
  }
  return resolved;
}

export function computeSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function executeFileChangeset(
  rootPath: string,
  changes: readonly FileChange[],
  signal?: AbortSignal,
): Promise<ChangesetResult> {
  const canonicalRoot = await realpath(rootPath);
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

    // Check parent path for symlinks or escape
    try {
      const parentDir = dirname(resolvedPath);
      await mkdir(parentDir, { recursive: true });
      const canonicalParent = await realpath(parentDir);
      const relParent = relative(canonicalRoot, canonicalParent);
      if (relParent.startsWith('..') || isAbsolute(relParent)) {
        outcomes.push({
          path: change.path,
          action: change.action,
          status: 'FAILED',
          error: 'Parent directory escaped canonical root',
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
      if (change.baselineSha256 && currentSha !== change.baselineSha256) {
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
        const content = change.content ?? '';
        const targetSha = change.targetSha256 ?? computeSha256(content);
        await writeFile(resolvedPath, content, 'utf8');
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

export async function reconcileFileChangeset(
  rootPath: string,
  changes: readonly FileChange[],
): Promise<{ outcome: 'SUCCEEDED' | 'FAILED'; details: JsonObject }> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(rootPath);
  } catch {
    return { outcome: 'FAILED', details: { reason: 'CANONICAL_ROOT_UNAVAILABLE' } };
  }

  const fileChecks: Array<{ path: string; expectedSha: string | null; actualSha: string | null; matches: boolean }> = [];
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

    let actualSha: string | null = null;
    try {
      const bytes = await readFile(resolvedPath);
      actualSha = computeSha256(bytes);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        actualSha = null;
      }
    }

    const expectedSha = change.action === 'DELETE' ? null : (change.targetSha256 ?? (change.content ? computeSha256(change.content) : null));
    const matches = actualSha === expectedSha;
    if (!matches) {
      allMatch = false;
    }
    fileChecks.push({ path: change.path, expectedSha, actualSha, matches });
  }

  return {
    outcome: allMatch ? 'SUCCEEDED' : 'FAILED',
    details: {
      reconciliation: allMatch ? 'ALL_MATCH' : 'MISMATCH_OR_PARTIAL',
      checks: fileChecks as unknown as JsonObject[],
    },
  };
}
