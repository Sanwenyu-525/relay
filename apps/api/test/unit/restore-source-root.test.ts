import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { assertRestoreSourceRootSeparate, RestoreFilesError } from '../../src/runtime/restore-files.js';

const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreFilesError &&
  cause.code === code && cause.message === code;
let repository = resolve(process.cwd());
while (!existsSync(join(repository, 'apps/file-io-helper'))) {
  if (repository === dirname(repository)) throw new Error('file helper repository is unavailable');
  repository = dirname(repository);
}
const helper = join(repository, 'apps/file-io-helper/target/x86_64-pc-windows-msvc/debug/relay-file-io-helper.exe');
const execFileAsync = promisify(execFile);

async function nativeRootId(path: string, packagedHelper: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = execFileAsync(packagedHelper, [], { env, windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  child.child.stdin!.end(JSON.stringify({ version: 'relay-file-io-v1', op: 'inspect-root', root_path: path }) + '\n');
  const result = JSON.parse((await child).stdout) as { ok: boolean; root_id: string };
  assert.equal(result.ok, true); assert.match(result.root_id, /^[0-9a-f]{16}:[0-9a-f]{32}$/u);
  return result.root_id;
}
async function fixture(work: (root: string, source: string, sourceId: string, packagedHelper: string) => Promise<void>) {
  assert.equal(process.platform, 'win32');
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-source-root-'));
  const source = join(root, 'source'); await mkdir(source);
  try {
    const packagedHelper = join(root, 'relay-file-io-helper.exe'), bytes = await readFile(helper);
    await copyFile(helper, packagedHelper);
    const copied = await readFile(packagedHelper), stat = await lstat(packagedHelper);
    assert.deepEqual(copied, bytes);
    const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    assert.equal(sha(copied), sha(bytes)); assert.equal(stat.nlink, 1);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    await work(root, source, await nativeRootId(source, packagedHelper), packagedHelper);
  }
  finally {
    assert.ok(root.startsWith(join(tmpdir(), 'relay-restore-source-root-')));
    await rm(root, { recursive: true, force: true });
  }
}

test('native source ancestor refusal preserves original ARMED bytes and never publishes the target', async () => {
  await fixture(async (_root, source, sourceId, packagedHelper) => {
    const evidence = Buffer.from(' {"state":"ARMED","original":true}\r\n');
    await mkdir(join(source, 'runtime-launches'));
    const armed = join(source, 'runtime-launches/8fbc1698-e06b-43ec-99fa-f28c156d6d18.json');
    await writeFile(armed, evidence); await mkdir(join(source, 'existing-parent'));
    const original = await readdir(source);
    for (const target of [join(source, 'new-root'), join(source, 'existing-parent/new-root'),
      join(source.toUpperCase(), 'new-root')]) {
      await assert.rejects(assertRestoreSourceRootSeparate(target, sourceId, packagedHelper,
        new AbortController().signal), refusal('RESTORE_SOURCE_ROOT_OVERLAP'));
      await assert.rejects(lstat(target), { code: 'ENOENT' });
    }
    assert.deepEqual(await readFile(armed), evidence); assert.deepEqual(await readdir(source), original);
  });
});

test('same-volume source rename keeps native File ID and is still refused as a target ancestor', async () => {
  await fixture(async (root, source, sourceId, packagedHelper) => {
    const moved = join(root, 'moved-source'); await rename(source, moved);
    assert.equal(await nativeRootId(moved, packagedHelper), sourceId);
    const target = join(moved, 'new-root');
    await assert.rejects(assertRestoreSourceRootSeparate(target, sourceId, packagedHelper,
      new AbortController().signal), refusal('RESTORE_SOURCE_ROOT_OVERLAP'));
    assert.deepEqual(await readdir(moved), []); await assert.rejects(lstat(target), { code: 'ENOENT' });
  });
});

test('a genuinely separate root passes with the explicit native helper and creates no filesystem entries', async () => {
  await fixture(async (root, source, sourceId, packagedHelper) => {
    const target = join(root, 'separate-root'), before = await readdir(root);
    const original = process.env.RELAY_FILE_IO_HELPER;
    process.env.RELAY_FILE_IO_HELPER = join(root, 'environment-helper-must-not-be-used.exe');
    try { await assertRestoreSourceRootSeparate(target, sourceId, packagedHelper, new AbortController().signal); }
    finally {
      if (original === undefined) delete process.env.RELAY_FILE_IO_HELPER;
      else process.env.RELAY_FILE_IO_HELPER = original;
    }
    assert.deepEqual(await readdir(root), before); assert.deepEqual(await readdir(source), []);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  });
});

test('invalid complete File IDs fail before any helper execution', async () => {
  await fixture(async (root, _source, sourceId) => {
    for (const invalid of ['', sourceId.slice(17), sourceId.replace(':', ''), `${sourceId}:extra`, 'g'.repeat(16) + ':' + '0'.repeat(32)]) {
      await assert.rejects(assertRestoreSourceRootSeparate(join(root, 'new-root'), invalid,
        join(root, 'missing-helper.exe'), new AbortController().signal), refusal('RESTORE_SOURCE_ROOT_INVALID'));
    }
  });
});

test('a real junction ancestor and an unavailable parent fail closed without following or modifying them', async () => {
  await fixture(async (root, source, sourceId, packagedHelper) => {
    const alias = join(root, 'source-alias'); await symlink(source, alias, 'junction');
    try {
      await assert.rejects(assertRestoreSourceRootSeparate(join(alias, 'new-root'), sourceId, packagedHelper,
        new AbortController().signal), refusal('RESTORE_SOURCE_ROOT_UNAVAILABLE'));
      assert.deepEqual(await readdir(source), []);
    } finally { await rm(alias); }
    await assert.rejects(assertRestoreSourceRootSeparate(join(root, 'missing-parent/new-root'), sourceId, packagedHelper,
      new AbortController().signal), refusal('RESTORE_SOURCE_ROOT_UNAVAILABLE'));
  });
});

test('owned wrong and missing helpers are refused without inheriting Node injection or disclosing raw errors', async () => {
  await fixture(async (root, _source, sourceId) => {
    const target = join(root, 'new-root'), wrong = join(root, 'wrong-helper.exe');
    await copyFile(process.execPath, wrong);
    const loaded = join(root, 'inherited-options.txt'), injection = join(root, 'injection.cjs');
    await writeFile(injection, `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, 'unexpected inheritance');\n`);
    const original = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require="${injection}"`;
    try {
      for (const executable of [wrong, join(root, 'missing-helper.exe')]) {
        await assert.rejects(assertRestoreSourceRootSeparate(target, sourceId, executable,
          new AbortController().signal), refusal('RESTORE_SOURCE_ROOT_UNAVAILABLE'));
      }
    } finally {
      if (original === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = original;
    }
    await assert.rejects(lstat(loaded), { code: 'ENOENT' }); await assert.rejects(lstat(target), { code: 'ENOENT' });
  });
});

test('cancellation is a safe refusal before tools or target are touched', async () => {
  await fixture(async (root, source, sourceId) => {
    const control = new AbortController(); control.abort(new Error('private abort reason'));
    await assert.rejects(assertRestoreSourceRootSeparate(join(root, 'new-root'), sourceId,
      join(root, 'missing-helper.exe'), control.signal), refusal('RESTORE_SOURCE_ROOT_ABORTED'));
    assert.deepEqual(await readdir(source), []);
  });
});
