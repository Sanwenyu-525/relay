import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { JsonObject } from '../infrastructure/json.js';

const execFileAsync = promisify(execFile);

export interface GitExecOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface GitExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Base safe git invocation. Disables external diffs and unquoted paths. */
export async function runSafeGit(
  args: readonly string[],
  options: GitExecOptions,
): Promise<GitExecResult> {
  const safeBaseArgs = [
    '-c', 'core.quotePath=false',
    '-c', 'diff.external=false',
  ];
  const fullArgs = [...safeBaseArgs, ...args];
  try {
    const { stdout, stderr } = await execFileAsync('git', fullArgs, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? '',
        WINDIR: process.env.WINDIR ?? '',
        PATH: process.env.PATH ?? '',
        PATHEXT: process.env.PATHEXT ?? '',
        TEMP: process.env.TEMP ?? '',
        TMP: process.env.TMP ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '',
        HOME: process.env.USERPROFILE ?? process.env.HOME ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: (error.stdout ?? '').toString().trim(),
      stderr: (error.stderr ?? (error.message || '')).toString().trim(),
    };
  }
}

export interface GitStatusResult {
  readonly branch: string;
  readonly headCommit: string | null;
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export async function gitGetStatus(options: GitExecOptions): Promise<GitStatusResult> {
  const branchRes = await runSafeGit(['rev-parse', '--abbrev-ref', 'HEAD'], options);
  const branch = branchRes.exitCode === 0 ? branchRes.stdout : 'HEAD';

  const headRes = await runSafeGit(['rev-parse', 'HEAD'], options);
  const headCommit = headRes.exitCode === 0 ? headRes.stdout : null;

  const statusRes = await runSafeGit(['status', '--porcelain=v1'], options);
  if (statusRes.exitCode !== 0) {
    throw new Error(`Git status failed: ${statusRes.stderr}`);
  }

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const lines = statusRes.stdout.split('\n').filter((l) => l.trim() !== '');
  for (const line of lines) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const path = line.slice(3).trim();

    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push(path);
    } else {
      if (indexStatus !== ' ' && indexStatus !== '?') staged.push(path);
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') unstaged.push(path);
    }
  }

  return { branch, headCommit, staged, unstaged, untracked };
}

export async function gitGetDiff(
  options: GitExecOptions,
  params?: { cached?: boolean; path?: string },
): Promise<string> {
  const args = ['diff', '--no-ext-diff'];
  if (params?.cached) args.push('--cached');
  if (params?.path) args.push('--', params.path);
  const res = await runSafeGit(args, options);
  if (res.exitCode !== 0) throw new Error(`Git diff failed: ${res.stderr}`);
  return res.stdout;
}

export async function gitGetLog(
  options: GitExecOptions,
  maxCount = 10,
): Promise<Array<{ commit: string; author: string; date: string; message: string }>> {
  const res = await runSafeGit(
    ['log', `-n${maxCount}`, '--format=%H%x1f%an%x1f%ad%x1f%s'],
    options,
  );
  if (res.exitCode !== 0) throw new Error(`Git log failed: ${res.stderr}`);
  if (!res.stdout) return [];

  return res.stdout.split('\n').filter((l) => l.trim() !== '').map((line) => {
    const parts = line.split('\x1f');
    return {
      commit: parts[0] ?? '',
      author: parts[1] ?? '',
      date: parts[2] ?? '',
      message: parts[3] ?? '',
    };
  });
}

export async function gitStageFile(
  filePath: string,
  options: GitExecOptions,
): Promise<{ success: boolean; stderr?: string | undefined }> {
  if (filePath === '.' || filePath === '*' || filePath.includes('..')) {
    throw new Error('git stage requires a specific non-escaped relative file path; bulk staging is prohibited');
  }
  const res = await runSafeGit(['add', '--', filePath], options);
  return { success: res.exitCode === 0, stderr: res.exitCode === 0 ? undefined : res.stderr };
}

export async function gitCommit(
  params: {
    message: string;
    expectedParentSha?: string | null | undefined;
    authorName?: string | undefined;
  },
  options: GitExecOptions,
): Promise<{ commitSha: string; parentSha: string | null }> {
  if (!params.message || params.message.trim() === '') {
    throw new Error('Commit message is required');
  }

  // Verify parent commit if expectedParentSha is specified
  const currentHeadRes = await runSafeGit(['rev-parse', 'HEAD'], options);
  const currentHead = currentHeadRes.exitCode === 0 ? currentHeadRes.stdout : null;

  if (params.expectedParentSha !== undefined && params.expectedParentSha !== null && params.expectedParentSha !== currentHead) {
    throw new Error(
      `Git commit parent mismatch: expected ${params.expectedParentSha}, actual ${currentHead}`,
    );
  }

  const commitArgs = ['commit', '-m', params.message];
  if (params.authorName) {
    commitArgs.push(`--author=${params.authorName} <relay@local>`);
  }

  const res = await runSafeGit(commitArgs, options);
  if (res.exitCode !== 0) {
    throw new Error(`Git commit failed: ${res.stderr}`);
  }

  const newHeadRes = await runSafeGit(['rev-parse', 'HEAD'], options);
  if (newHeadRes.exitCode !== 0) throw new Error('Failed to read new commit HEAD');

  return { commitSha: newHeadRes.stdout, parentSha: currentHead };
}

export async function gitPush(
  params: {
    remote: string;
    ref: string;
    expectedCommitSha?: string | undefined;
  },
  options: GitExecOptions,
): Promise<{ pushedSha: string }> {
  // Disallow flags or destructive options in remote and ref
  if (params.remote.startsWith('-') || params.ref.startsWith('-') || params.ref.startsWith('+') || params.ref.includes(':')) {
    throw new Error('Invalid or force push ref/remote is prohibited');
  }

  // Pre-check current ref commit
  const headRes = await runSafeGit(['rev-parse', 'HEAD'], options);
  const currentCommit = headRes.exitCode === 0 ? headRes.stdout : '';
  if (params.expectedCommitSha && currentCommit !== params.expectedCommitSha) {
    throw new Error(`Commit SHA ${currentCommit} does not match expected ${params.expectedCommitSha}`);
  }

  const pushRes = await runSafeGit(['push', params.remote, params.ref], options);
  if (pushRes.exitCode !== 0) {
    throw new Error(`Git push failed: ${pushRes.stderr}`);
  }

  return { pushedSha: currentCommit };
}

export async function reconcileGitCommit(
  params: { message: string; expectedParentSha?: string | null | undefined },
  options: GitExecOptions,
): Promise<{ outcome: 'SUCCEEDED' | 'NOT_EXECUTED'; details: JsonObject }> {
  const headRes = await runSafeGit(['rev-parse', 'HEAD'], options);
  if (headRes.exitCode !== 0) {
    return { outcome: 'NOT_EXECUTED', details: { reason: 'HEAD_UNAVAILABLE' } };
  }
  const currentHead = headRes.stdout;
  const logRes = await runSafeGit(['log', '-1', '--format=%P%x1f%s'], options);
  if (logRes.exitCode !== 0) {
    return { outcome: 'NOT_EXECUTED', details: { reason: 'LOG_UNAVAILABLE' } };
  }
  const [parentSha, commitMsg] = logRes.stdout.split('\x1f');
  const parentMatches = !params.expectedParentSha || parentSha?.trim() === params.expectedParentSha;
  const msgMatches = commitMsg?.trim() === params.message.trim();

  if (parentMatches && msgMatches) {
    return {
      outcome: 'SUCCEEDED',
      details: { reconciliation: 'COMMIT_MATCHED', commitSha: currentHead, parentSha: parentSha ?? null },
    };
  }
  return {
    outcome: 'NOT_EXECUTED',
    details: { reconciliation: 'COMMIT_NOT_FOUND', currentHead, actualMessage: commitMsg ?? null },
  };
}

export async function reconcileGitPush(
  params: { remote: string; ref: string; expectedCommitSha: string },
  options: GitExecOptions,
): Promise<{ outcome: 'SUCCEEDED' | 'UNKNOWN'; details: JsonObject }> {
  const lsRes = await runSafeGit(['ls-remote', params.remote, params.ref], options);
  if (lsRes.exitCode !== 0) {
    return { outcome: 'UNKNOWN', details: { reason: 'REMOTE_QUERY_FAILED', error: lsRes.stderr } };
  }
  const firstLine = lsRes.stdout.split('\n')[0] ?? '';
  const remoteSha = firstLine.split(/\s+/)[0] ?? '';
  if (remoteSha === params.expectedCommitSha) {
    return { outcome: 'SUCCEEDED', details: { reconciliation: 'REMOTE_SHA_MATCHED', remoteSha } };
  }
  return {
    outcome: 'UNKNOWN',
    details: { reconciliation: 'REMOTE_SHA_MISMATCH', remoteSha, expectedSha: params.expectedCommitSha },
  };
}
