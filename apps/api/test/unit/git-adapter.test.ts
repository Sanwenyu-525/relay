import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { gitGetDiff, gitGetStatus } from '../../src/git/git-adapter.js';

const exec = promisify(execFile);
async function fixture(work: (root: string, base: string,
  git: (args: string[]) => Promise<string>) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'relay-git-read-')), root = join(base, 'repo');
  await mkdir(root);
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', HOME: base, USERPROFILE: base };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const git = async (args: string[]) => (await exec('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd: root, env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  })).stdout;
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Relay Test']); await git(['config', 'user.email', 'fixture@local']);
    await git(['config', 'core.autocrlf', 'false']);
    await writeFile(join(root, 'tracked.txt'), 'before\n');
    await git(['add', '--', 'tracked.txt']); await git(['commit', '-m', 'initial']);
    await work(root, base, git);
  } finally {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()));
    assert.ok(basename(base).startsWith('relay-git-read-'));
    await rm(base, { recursive: true, force: true });
    await assert.rejects(stat(base), { code: 'ENOENT' });
  }
}
async function configuredHelper(base: string, marker: string, body: string): Promise<string> {
  const file = join(base, `${marker}.cjs`);
  await writeFile(file, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(base, marker))},'executed'); ${body}`);
  return `"${process.execPath.replaceAll('\\', '/')}" "${file.replaceAll('\\', '/')}"`;
}

test('Git status preserves leading status columns and exact whitespace paths across index/worktree changes', async () => {
  await fixture(async (root, _base, git) => {
    await writeFile(join(root, 'tracked.txt'), 'after\n');
    const status = await gitGetStatus({ cwd: root });
    assert.equal(status.branch, 'main'); assert.match(status.headCommit!, /^[0-9a-f]{40}$/u);
    assert.deepEqual(status.staged, []); assert.deepEqual(status.unstaged, ['tracked.txt']);
    await git(['add', '--', 'tracked.txt']); await writeFile(join(root, 'tracked.txt'), 'second\n');
    await writeFile(join(root, ' leading name.txt'), 'new\n');
    const mixed = await gitGetStatus({ cwd: root });
    assert.deepEqual(mixed.staged, ['tracked.txt']); assert.deepEqual(mixed.unstaged, ['tracked.txt']);
    assert.deepEqual(mixed.untracked, [' leading name.txt']);
    await git(['add', '--', 'tracked.txt']); await git(['commit', '-m', 'rename baseline']);
    await git(['mv', '--', 'tracked.txt', 'renamed name.txt']);
    assert.deepEqual((await gitGetStatus({ cwd: root })).staged, ['renamed name.txt']);
  });
});

test('Git diff preserves patch bytes and separates staged from working-tree changes', async () => {
  await fixture(async (root, _base, git) => {
    await writeFile(join(root, 'tracked.txt'), 'staged\n'); await git(['add', '--', 'tracked.txt']);
    await writeFile(join(root, 'tracked.txt'), 'working\n');
    assert.equal(await gitGetDiff({ cwd: root }, { cached: true, path: 'tracked.txt' }),
      await git(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--', 'tracked.txt']));
    assert.equal(await gitGetDiff({ cwd: root }, { path: 'tracked.txt' }),
      await git(['diff', '--no-ext-diff', '--no-textconv', '--', 'tracked.txt']));
  });
});

test('Git read diff never executes configured external diff or textconv programs', async () => {
  await fixture(async (root, base, git) => {
    await writeFile(join(root, '.gitattributes'), '*.txt diff=probe\n');
    await git(['add', '--', '.gitattributes']); await git(['commit', '-m', 'attributes']);
    const helper = await configuredHelper(base, 'textconv-effect', 'process.stdout.write(fs.readFileSync(process.argv[2]));');
    await git(['config', 'diff.probe.textconv', helper]);
    await writeFile(join(root, 'tracked.txt'), 'after\n');
    const result = await gitGetDiff({ cwd: root }); assert.ok(result.includes('+after'));
    await assert.rejects(stat(join(base, 'textconv-effect')), { code: 'ENOENT' });
    const external = await configuredHelper(base, 'external-effect', "process.stdout.write('external diff');");
    await git(['config', 'diff.probe.command', external]);
    assert.ok((await gitGetDiff({ cwd: root })).includes('+after'));
    await assert.rejects(stat(join(base, 'external-effect')), { code: 'ENOENT' });
  });
});

test('Git status disables fsmonitor programs and optional index writes', async () => {
  await fixture(async (root, base, git) => {
    const helper = await configuredHelper(base, 'fsmonitor-effect', "process.stdout.write('fixture-token\\0/\\0');");
    await git(['config', 'core.fsmonitor', helper]);
    const index = await readFile(join(root, '.git/index'));
    const future = new Date(Date.now() + 10_000); await utimes(join(root, 'tracked.txt'), future, future);
    const status = await gitGetStatus({ cwd: root });
    assert.deepEqual(status.staged, []); assert.deepEqual(status.unstaged, []);
    await assert.rejects(stat(join(base, 'fsmonitor-effect')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(root, '.git/index')), index);
  });
});

test('Git reads refuse external clean/process filters before any configured program runs', async () => {
  await fixture(async (root, base, git) => {
    await writeFile(join(root, '.gitattributes'), '*.txt filter=probe\n');
    await git(['add', '--', '.gitattributes']); await git(['commit', '-m', 'filter attribute']);
    const helper = await configuredHelper(base, 'clean-effect', 'process.stdin.pipe(process.stdout);');
    await git(['config', 'filter.probe.clean', helper]);
    const future = new Date(Date.now() + 10_000); await utimes(join(root, 'tracked.txt'), future, future);
    await assert.rejects(gitGetStatus({ cwd: root }), { message: 'GIT_READ_EXTERNAL_FILTER_UNSUPPORTED' });
    await assert.rejects(gitGetDiff({ cwd: root }), { message: 'GIT_READ_EXTERNAL_FILTER_UNSUPPORTED' });
    await assert.rejects(stat(join(base, 'clean-effect')), { code: 'ENOENT' });
    await git(['config', '--unset', 'filter.probe.clean']);
    const processHelper = await configuredHelper(base, 'process-effect', 'process.stdin.resume();');
    await git(['config', 'filter.probe.process', processHelper]);
    await assert.rejects(gitGetStatus({ cwd: root }), { message: 'GIT_READ_EXTERNAL_FILTER_UNSUPPORTED' });
    await assert.rejects(gitGetDiff({ cwd: root }), { message: 'GIT_READ_EXTERNAL_FILTER_UNSUPPORTED' });
    await assert.rejects(stat(join(base, 'process-effect')), { code: 'ENOENT' });
  });
});

test('Git status reports unborn branches and detached HEAD without confusing their commit identities', async () => {
  await fixture(async (root, base, git) => {
    const head = (await git(['rev-parse', 'HEAD'])).trim(); await git(['checkout', '--detach', head]);
    const detached = await gitGetStatus({ cwd: root });
    assert.equal(detached.branch, 'HEAD'); assert.equal(detached.headCommit, head);
    const empty = join(base, 'empty'); await mkdir(empty); await git(['-C', empty, 'init', '-b', 'new-branch']);
    await writeFile(join(empty, '中文 文件.txt'), 'untracked\n');
    const unborn = await gitGetStatus({ cwd: empty });
    assert.equal(unborn.branch, 'new-branch'); assert.equal(unborn.headCommit, null);
    assert.deepEqual(unborn.untracked, ['中文 文件.txt']);
  });
});

test('Git read configuration failures never become an empty filter list or expose raw errors', async () => {
  await fixture(async (root) => {
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = process.env.SystemRoot;
      await assert.rejects(gitGetStatus({ cwd: root }), { message: 'GIT_READ_CONFIG_UNAVAILABLE' });
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
    const controller = new AbortController(); controller.abort(new Error('private cancellation reason'));
    await assert.rejects(gitGetDiff({ cwd: root, signal: controller.signal }), { message: 'GIT_READ_CONFIG_UNAVAILABLE' });
    await writeFile(join(root, '.git/config'), '[malformed private fixture config\n');
    await assert.rejects(gitGetStatus({ cwd: root }), { message: 'GIT_READ_CONFIG_UNAVAILABLE' });
  });
});

test('root Git reads omit nested worktree inspection but retain submodule commit changes', async () => {
  await fixture(async (root, base, git) => {
    const upstream = join(base, 'upstream'); await mkdir(upstream);
    await git(['-C', upstream, 'init', '-b', 'sub']);
    await git(['-C', upstream, 'config', 'user.name', 'Relay Test']);
    await git(['-C', upstream, 'config', 'user.email', 'fixture@local']);
    await writeFile(join(upstream, 'nested.txt'), 'original\n');
    await writeFile(join(upstream, '.gitattributes'), '*.txt filter=probe\n');
    await git(['-C', upstream, 'add', '--', 'nested.txt', '.gitattributes']);
    await git(['-C', upstream, 'commit', '-m', 'submodule initial']);
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '--', upstream, 'nested']);
    await git(['commit', '-m', 'submodule']);
    const helper = await configuredHelper(base, 'nested-clean-effect', 'process.stdin.pipe(process.stdout);');
    await git(['-C', join(root, 'nested'), 'config', 'filter.probe.clean', helper]);
    await writeFile(join(root, 'nested/nested.txt'), 'changed nested worktree\n');
    const index = await readFile(join(root, '.git/index'));
    assert.deepEqual((await gitGetStatus({ cwd: root })).unstaged, []);
    assert.equal(await gitGetDiff({ cwd: root }), '');
    await assert.rejects(stat(join(base, 'nested-clean-effect')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(root, '.git/index')), index);
    await git(['-C', join(root, 'nested'), 'config', '--unset', 'filter.probe.clean']);
    await git(['-C', join(root, 'nested'), 'config', 'user.name', 'Relay Test']);
    await git(['-C', join(root, 'nested'), 'config', 'user.email', 'fixture@local']);
    await git(['-C', join(root, 'nested'), 'add', '--', 'nested.txt']);
    await git(['-C', join(root, 'nested'), 'commit', '-m', 'new submodule commit']);
    assert.deepEqual((await gitGetStatus({ cwd: root })).unstaged, ['nested']);
    assert.ok((await gitGetDiff({ cwd: root })).includes('Subproject commit'));
  });
});
