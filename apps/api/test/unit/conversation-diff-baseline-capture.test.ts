import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  captureBaseline,
  captureCurrentState,
  NotAGitRepositoryError,
} from '../../src/conversation-diff/baseline-capture.js';

const exec = promisify(execFile);
const LF = String.fromCharCode(10);

async function withTempRepo(
  work: (root: string, base: string, git: (args: string[]) => Promise<string>) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'relay-cd-'));
  const root = join(base, 'repo');
  await mkdir(root);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', HOME: base, USERPROFILE: base };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const git = async (args: string[]) =>
    (await exec('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: root, env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    })).stdout;
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Relay Test']);
    await git(['config', 'user.email', 'fixture@local']);
    await git(['config', 'core.autocrlf', 'false']);
    await work(root, base, git);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('captureBaseline enumerates tracked and untracked non-ignored files with sha/text/lineCount', async () => {
  await withTempRepo(async (root, _base, git) => {
    await writeFile(join(root, 'a.txt'), `alpha${LF}`);
    await git(['add', '--', 'a.txt']);
    await git(['commit', '-m', 'initial']);
    // 未跟踪且未被忽略的文件也应被采集。
    await writeFile(join(root, 'b.txt'), `beta${LF}`);
    const snap = await captureBaseline(root);
    const byPath = new Map(snap.files.map((f) => [f.path, f]));
    assert.equal(byPath.has('a.txt'), true);
    assert.equal(byPath.has('b.txt'), true);
    assert.equal(byPath.get('a.txt')?.text, `alpha${LF}`);
    assert.equal(byPath.get('a.txt')?.lineCount, 1);
    assert.equal(byPath.get('a.txt')?.sha256.length, 64);
    assert.equal(snap.incomplete, false);
  });
});

test('captureBaseline normalizes CRLF for lineCount and skips trailing newline', async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, 'crlf.txt'), `x${String.fromCharCode(13, 10)}y${String.fromCharCode(13, 10)}`);
    const snap = await captureBaseline(root);
    const file = snap.files.find((f) => f.path === 'crlf.txt');
    assert.notEqual(file, undefined);
    assert.equal(file?.lineCount, 2);
  });
});

test('captureBaseline scopes to a subdirectory and never reads siblings', async () => {
  await withTempRepo(async (root, _base, git) => {
    await mkdir(join(root, 'sub'));
    await mkdir(join(root, 'sibling'));
    await writeFile(join(root, 'sub', 'inside.txt'), `inside${LF}`);
    await writeFile(join(root, 'sibling', 'outside.txt'), `outside${LF}`);
    await writeFile(join(root, 'top.txt'), `top${LF}`);
    await git(['add', '-A']);
    await git(['commit', '-m', 'all']);
    const snap = await captureBaseline(join(root, 'sub'));
    const paths = snap.files.map((f) => f.path);
    assert.deepEqual(paths, ['inside.txt']);
  });
});

test('captureBaseline throws NotAGitRepositoryError outside a git repo', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-cd-nogit-'));
  try {
    await assert.rejects(captureBaseline(base), (err: unknown) => err instanceof NotAGitRepositoryError);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('captureBaseline flags binary files as BINARY without text', async () => {
  await withTempRepo(async (root) => {
    const bytes = Buffer.from([104, 101, 108, 108, 111, 0, 119, 111, 114, 108, 100]);
    await writeFile(join(root, 'blob.bin'), bytes);
    const snap = await captureBaseline(root);
    const file = snap.files.find((f) => f.path === 'blob.bin');
    assert.notEqual(file, undefined);
    assert.equal(file?.unavailableReason, 'BINARY');
    assert.equal(file?.text, null);
    assert.equal(file?.sha256.length, 64);
  });
});

test('captureBaseline flags over-limit files as TEXT_TOO_LARGE and skips protected paths', async () => {
  await withTempRepo(async (root) => {
    // 受保护路径（.env）应被跳过，不出现在快照中。
    await writeFile(join(root, '.env'), `SECRET=1${LF}`);
    // 超过 maxFileBytes 的文件标 TEXT_TOO_LARGE，仍记录 sizeBytes。
    const big = 'x'.repeat(50);
    await writeFile(join(root, 'big.txt'), big);
    const snap = await captureBaseline(root, { maxFileBytes: 10 });
    const paths = snap.files.map((f) => f.path);
    assert.equal(paths.includes('.env'), false);
    const bigFile = snap.files.find((f) => f.path === 'big.txt');
    assert.notEqual(bigFile, undefined);
    assert.equal(bigFile?.unavailableReason, 'TEXT_TOO_LARGE');
    assert.equal(bigFile?.text, null);
    assert.equal(bigFile?.sizeBytes, 50);
  });
});

test('captureCurrentState reflects disk changes and omits deleted files', async () => {
  await withTempRepo(async (root, _base, git) => {
    await writeFile(join(root, 'a.txt'), `v1${LF}`);
    await git(['add', '--', 'a.txt']);
    await git(['commit', '-m', 'initial']);
    const before = await captureCurrentState(root);
    assert.equal(before.files.get('a.txt')?.text, `v1${LF}`);

    await writeFile(join(root, 'a.txt'), `v2${LF}extra${LF}`);
    await writeFile(join(root, 'b.txt'), `new${LF}`);
    const after = await captureCurrentState(root);
    assert.equal(after.files.get('a.txt')?.text, `v2${LF}extra${LF}`);
    assert.equal(after.files.get('b.txt')?.text, `new${LF}`);

    await rm(join(root, 'b.txt'));
    const afterDelete = await captureCurrentState(root);
    assert.equal(afterDelete.files.has('b.txt'), false);
  });
});

test('captureCurrentState keeps the unscanned tail as unswept on the file-count limit', async () => {
  await withTempRepo(async (root) => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      await writeFile(join(root, name), `${name}${LF}`);
    }
    const scan = await captureCurrentState(root, { maxFiles: 2 });
    assert.equal(scan.incomplete, true);
    assert.equal(scan.reason, 'FILE_COUNT_LIMIT');
    assert.equal(scan.files.size, 2);
    assert.equal(scan.listedTotal, 4);
    // 尾部两条只是没核对到：带出去给上层，绝不能被算成「已删除」。
    assert.equal(scan.unswept.has('c.txt'), true);
    assert.equal(scan.unswept.has('d.txt'), true);
    assert.equal(scan.unswept.has('a.txt'), false);
  });
});

test('captureCurrentState keeps the unscanned tail as unswept on the total-bytes limit', async () => {
  await withTempRepo(async (root) => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(root, name), `${'x'.repeat(9)}${LF}`); // 每条 10 字节
    }
    const scan = await captureCurrentState(root, { maxTotalBytes: 15 });
    assert.equal(scan.reason, 'TOTAL_BYTES_LIMIT');
    assert.equal(scan.files.size, 1);
    assert.deepEqual([...scan.unswept], ['b.txt', 'c.txt']);
  });
});

test('captureCurrentState separates Git-tracked paths from newly created ones', async () => {
  await withTempRepo(async (root, _base, git) => {
    await writeFile(join(root, 'a.txt'), `a${LF}`);
    await git(['add', '--', 'a.txt']);
    await git(['commit', '-m', 'initial']);
    await writeFile(join(root, 'fresh.txt'), `fresh${LF}`);
    const scan = await captureCurrentState(root);
    assert.equal(scan.tracked.has('a.txt'), true);
    // 未跟踪的新文件不在索引里：基线不完整时它仍可被认定为「本会话新建」。
    assert.equal(scan.tracked.has('fresh.txt'), false);
    assert.equal(scan.incomplete, false);
    assert.equal(scan.reason, null);
    assert.equal(scan.unswept.size, 0);
  });
});

test('captureCurrentState lists protected paths but never sweeps them', async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, '.env'), `SECRET=1${LF}`);
    await writeFile(join(root, 'a.txt'), `a${LF}`);
    await writeFile(join(root, 'b.txt'), `b${LF}`);
    const scan = await captureCurrentState(root, { maxFiles: 1 });
    assert.equal(scan.listedTotal, 2);
    assert.equal(scan.unswept.has('.env'), false);
  });
});

test('captureBaseline marks an aborted scan as incomplete coverage', async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, 'a.txt'), `a${LF}`);
    const controller = new AbortController();
    controller.abort();
    const snap = await captureBaseline(root, { signal: controller.signal });
    // 采到一半被中止 = 起点覆盖不完整：剩下的文件之后不能被当成「没变化」。
    assert.equal(snap.incomplete, true);
    assert.equal(snap.captureReason, 'SCAN_ABORTED');
    assert.deepEqual(snap.files, []);
  });
});
