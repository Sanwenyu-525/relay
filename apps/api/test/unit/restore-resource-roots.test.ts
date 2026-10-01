import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { backupStateSha256, type BackupDatabaseState } from '../../src/runtime/backup-state.js';
import { assertRestoreSourceRootSeparate, RestoreFilesError } from '../../src/runtime/restore-files.js';
import { probeRestoreResourceRoots, RestoreResourceRootsError } from '../../src/runtime/restore-resource-roots.js';

let repository = resolve(process.cwd());
while (!existsSync(join(repository, 'apps/file-io-helper'))) {
  if (repository === dirname(repository)) throw new Error('file helper repository is unavailable');
  repository = dirname(repository);
}
const nativeHelper = join(repository, 'apps/file-io-helper/target/x86_64-pc-windows-msvc/debug/relay-file-io-helper.exe');
const execFileAsync = promisify(childProcess.execFile);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreResourceRootsError && cause.code === code && cause.message === code;
type Fact = BackupDatabaseState['external_resources'][number];
function row(root: string, id: string | null): Fact {
  return { id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID(), canonical_root: root,
    identity_key: root.toLowerCase(), file_write_root_id: id, status: 'ACTIVE', revision: '3', resource_epoch: '7' };
}
function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
async function rootId(root: string, helper: string): Promise<string> {
  const process = execFileAsync(helper, [], { env: minimalEnvironment(), windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  process.child.stdin!.end(JSON.stringify({ version: 'relay-file-io-v1', op: 'inspect-root', root_path: root }) + '\n');
  const reply = JSON.parse((await process).stdout) as { ok: boolean; root_id: string };
  assert.equal(reply.ok, true); assert.match(reply.root_id, /^[0-9a-f]{16}:[0-9a-f]{32}$/u);
  return reply.root_id;
}
async function fixture(work: (base: string, root: string, helper: string, helperSha: string, id: string) => Promise<void>) {
  assert.equal(process.platform, 'win32');
  const base = await mkdtemp(join(tmpdir(), 'relay-resource-root-')), root = join(base, '受管根');
  await mkdir(root); await writeFile(join(root, 'original.txt'), Buffer.from('original\r\n原始字节\0'));
  try {
    const helper = join(base, 'relay-file-io-helper.exe'), bytes = await readFile(nativeHelper);
    await copyFile(nativeHelper, helper);
    assert.deepEqual(await readFile(helper), bytes); assert.equal((await lstat(helper)).nlink, 1);
    await work(base, root, helper, sha(bytes), await rootId(root, helper));
  } finally {
    assert.ok(base.startsWith(join(tmpdir(), 'relay-resource-root-')));
    await rm(base, { recursive: true, force: true }); assert.equal(existsSync(base), false);
  }
}
function input(externalResources: readonly Fact[], helperExecutable: string, helperSha256: string,
  signal = new AbortController().signal, assertHeld = async () => {}) {
  return { externalResources, helperExecutable, helperSha256, selectedStateSha256: backupStateSha256({ external_resources: externalResources }),
    signal, assertHeld };
}
/** Real Node processes are used only to inject protocol/lifecycle failures; successful IDs always come from Rust. */
async function withChild(helper: string, script: string | null,
  work: (children: ChildProcess[], closed: Set<ChildProcess>) => Promise<void>,
  observe?: (child: ChildProcess) => void): Promise<void> {
  const original = childProcess.spawn, children: ChildProcess[] = [], closed = new Set<ChildProcess>();
  childProcess.spawn = ((file: string, args?: readonly string[], options?: SpawnOptions) => {
    if (file !== helper) return original(file, args ?? [], options ?? {});
    assert.deepEqual(args, []); assert.equal(options?.windowsHide, true);
    assert.deepEqual(Object.keys(options?.env ?? {}).sort(), Object.keys(minimalEnvironment()).sort());
    const child = script === null ? original(file, args ?? [], options ?? {}) :
      original(process.execPath, ['--input-type=module', '-e', script], options ?? {});
    children.push(child); child.once('close', () => { closed.add(child); }); observe?.(child);
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try { await work(children, closed); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.equal(closed.size, children.length);
  for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null);
}

test('native MATCH and nullable/disabled observations bind rows without changing root bytes or entries', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    const resources = [row(root, id), { ...row(root, null), status: 'DISABLED' }], before = JSON.stringify(resources);
    const bytes = await readFile(join(root, 'original.txt')), entries = await readdir(root);
    let holds = 0;
    await withChild(helper, null, async (children, closed) => {
      const report = await probeRestoreResourceRoots(input(resources, helper, helperSha, undefined, async () => { holds++; }));
      assert.equal(report.version, 'relay-restore-resource-roots-v1'); assert.equal(report.scope, 'REGISTERED_MANAGED_ROOT_IDENTITIES_ONLY');
      assert.equal(report.selected_state_sha256, backupStateSha256({ external_resources: resources }));
      assert.equal(report.helper_sha256, helperSha); assert.equal(report.root_count, 2);
      assert.deepEqual(report.results.map(item => item.result), ['MATCH', 'NO_STORED_ID']);
      assert.equal(report.results[0]!.observed_root_id, id); assert.equal(report.results[1]!.observed_root_id, null);
      for (let index = 0; index < resources.length; index++) for (const key of ['id', 'workspace_id', 'project_id', 'status', 'revision', 'resource_epoch'] as const) {
        assert.equal(report.results[index]![key], resources[index]![key]);
      }
      assert.equal(children.length, 1); assert.equal(closed.size, 1); assert.ok(holds >= 6);
      assert.equal(JSON.stringify(report).includes(root), false);
    });
    assert.equal(JSON.stringify(resources), before); assert.deepEqual(await readFile(join(root, 'original.txt')), bytes);
    assert.deepEqual(await readdir(root), entries); assert.equal(existsSync(join(root, '.relay-content-admission.lock')), false);
  });
});

test('retaining the original directory proves same-path replacement returns ID_MISMATCH', async () => {
  await fixture(async (base, root, helper, helperSha, id) => {
    const retained = join(base, 'original-retained'); await rename(root, retained); await mkdir(root);
    assert.notEqual(await rootId(root, helper), id); assert.equal(await rootId(retained, helper), id);
    const report = await probeRestoreResourceRoots(input([row(root, id)], helper, helperSha));
    assert.equal(report.results[0]!.result, 'ID_MISMATCH'); assert.notEqual(report.results[0]!.observed_root_id, id);
    assert.deepEqual(await readdir(root), []); assert.deepEqual(await readdir(retained), ['original.txt']);
  });
});

test('same-volume movement matches the preserved File ID at its supplied new path and old path remains UNAVAILABLE', async () => {
  await fixture(async (base, root, helper, helperSha, id) => {
    const moved = join(base, 'moved-root'); await rename(root, moved); assert.equal(await rootId(moved, helper), id);
    const bytes = await readFile(join(moved, 'original.txt'));
    const report = await probeRestoreResourceRoots(input([row(moved, id), row(root, id)], helper, helperSha));
    assert.deepEqual(report.results.map(item => item.result), ['MATCH', 'UNAVAILABLE']);
    assert.deepEqual(await readFile(join(moved, 'original.txt')), bytes); assert.equal(existsSync(root), false);
  });
});

test('native case aliases match but real root and ancestor junctions are conservatively UNAVAILABLE', async () => {
  await fixture(async (base, root, helper, helperSha, id) => {
    const alias = join(base, 'junction'); await symlink(root, alias, 'junction');
    await mkdir(join(root, 'child')); const childId = await rootId(join(root, 'child'), helper);
    try {
      const report = await probeRestoreResourceRoots(input([row(root.toUpperCase(), id), row(alias, id), row(join(alias, 'child'), childId)], helper, helperSha));
      assert.deepEqual(report.results.map(item => item.result), ['MATCH', 'UNAVAILABLE', 'UNAVAILABLE']);
      assert.deepEqual(await readdir(root), ['child', 'original.txt']); assert.deepEqual(await readdir(join(root, 'child')), []);
    } finally { await rm(alias); }
  });
});

test('null never becomes an invented original identity, and 128 rows are accepted without native calls', async () => {
  await fixture(async (_base, root, helper, helperSha) => {
    const resources = Array.from({ length: 128 }, () => row(root, null));
    await withChild(helper, null, async children => {
      const report = await probeRestoreResourceRoots(input(resources, helper, helperSha));
      assert.equal(report.root_count, 128); assert.ok(report.results.every(item => item.result === 'NO_STORED_ID' && item.observed_root_id === null));
      assert.equal(children.length, 0);
    });
  });
});

test('invalid rows, duplicate IDs, hashes and root-count overflow are refused before a helper or hold', async () => {
  const valid = row('C:\\not-read', '0'.repeat(16) + ':' + '0'.repeat(32)); let holds = 0;
  const run = (resources: readonly Fact[], extra = {}) => probeRestoreResourceRoots({
    ...input(resources, 'C:\\missing-helper.exe', '0'.repeat(64), undefined, async () => { holds++; }), ...extra });
  for (const change of [{ extra: 'unknown' }, { revision: '-1' }, { resource_epoch: '01' }, { id: 'wrong' },
    { status: 'UNKNOWN' }, { file_write_root_id: '1:2' }, { canonical_root: 'x'.repeat(4097) }, { identity_key: null }]) {
    await assert.rejects(run([{ ...valid, ...change }]), refusal('RESTORE_RESOURCE_ROOTS_INVALID'));
  }
  await assert.rejects(run([valid, valid]), refusal('RESTORE_RESOURCE_ROOTS_INVALID'));
  await assert.rejects(run([valid], { selectedStateSha256: 'private invalid hash' }), refusal('RESTORE_RESOURCE_ROOTS_INVALID'));
  await assert.rejects(run([valid], { helperSha256: '' }), refusal('RESTORE_RESOURCE_ROOTS_INVALID'));
  await assert.rejects(run(Array.from({ length: 129 }, () => row('C:\\not-read', null))), refusal('RESTORE_RESOURCE_ROOTS_LIMIT'));
  assert.equal(holds, 0);
});

test('missing, hardlinked, junction-ancestor and wrong-hash helpers are not used', async () => {
  await fixture(async (base, root, helper, helperSha, id) => {
    const resources = [row(root, id)];
    await assert.rejects(probeRestoreResourceRoots(input(resources, join(base, 'missing.exe'), helperSha)), refusal('RESTORE_RESOURCE_ROOTS_UNAVAILABLE'));
    await withChild(helper, null, async children => {
      await assert.rejects(probeRestoreResourceRoots(input(resources, helper, '0'.repeat(64))), refusal('RESTORE_RESOURCE_ROOTS_HELPER_CHANGED'));
      assert.equal(children.length, 0);
    });
    const linked = join(base, 'hardlink.exe'); await link(helper, linked);
    try {
      await assert.rejects(probeRestoreResourceRoots(input(resources, helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_UNAVAILABLE'));
      await assert.rejects(assertRestoreSourceRootSeparate(join(root, 'new-target'), id, helper, new AbortController().signal),
        cause => cause instanceof RestoreFilesError && cause.code === 'RESTORE_SOURCE_ROOT_UNAVAILABLE');
    } finally { await rm(linked); }
    const alias = join(base, 'helper-alias'); await symlink(base, alias, 'junction');
    try { await assert.rejects(probeRestoreResourceRoots(input(resources, join(alias, 'relay-file-io-helper.exe'), helperSha)), refusal('RESTORE_RESOURCE_ROOTS_UNAVAILABLE')); }
    finally { await rm(alias); }
  });
});

test('helper mutation after a real native close is rejected by pinned identity and SHA binding', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    await withChild(helper, null, async (children, closed) => {
      await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_HELPER_CHANGED'));
      assert.equal(children.length, 1); assert.equal(closed.size, 1);
    }, child => { child.once('close', () => { appendFileSync(helper, Buffer.from('changed owned helper')); }); });
  });
});

test('pre-abort starts no helper and does not expose the private cancellation reason', async () => {
  const control = new AbortController(); control.abort(new Error('private abort reason'));
  await assert.rejects(probeRestoreResourceRoots(input([], 'C:\\missing-helper.exe', '0'.repeat(64), control.signal)), refusal('RESTORE_RESOURCE_ROOTS_ABORTED'));
});

test('live cancellation settles only after the actual owned child closes with a minimal environment', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    const control = new AbortController(), old = { NODE_OPTIONS: process.env.NODE_OPTIONS, PGPORT: process.env.PGPORT, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    process.env.NODE_OPTIONS = '--require=must-not-be-inherited'; process.env.PGPORT = 'invalid'; process.env.OPENAI_API_KEY = 'private provider value';
    try {
      await withChild(helper, "process.stdin.once('data', () => { process.stderr.write('ready'); }); process.stdin.resume(); setInterval(() => {}, 1000);",
        async (children, closed) => {
          await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha, control.signal)), refusal('RESTORE_RESOURCE_ROOTS_ABORTED'));
          assert.equal(children.length, 1); assert.equal(closed.size, 1); assert.ok(children[0]!.signalCode !== null || children[0]!.exitCode !== null);
        }, child => { child.stderr!.once('data', () => { control.abort(new Error('private live cancellation')); }); });
    } finally {
      for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.deepEqual(await readdir(root), ['original.txt']);
  });
});

test('legal native refusal is UNAVAILABLE while malformed/invalid UTF8/unknown protocol is a failed check', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    const resources = [row(root, id)];
    const valid = JSON.stringify({ version: 'relay-file-io-v1', ok: false, error: { code: 'ROOT_UNAVAILABLE', message: 'private error path/credential' } });
    await withChild(helper, `process.stdin.resume(); process.stdin.once('end', () => { process.stdout.write(${JSON.stringify(valid)}); });`, async (_children, closed) => {
      const report = await probeRestoreResourceRoots(input(resources, helper, helperSha));
      assert.equal(report.results[0]!.result, 'UNAVAILABLE'); assert.equal(JSON.stringify(report).includes('private'), false); assert.equal(closed.size, 1);
    });
    for (const output of ['not JSON', JSON.stringify({ version: 'wrong', ok: true, root_id: id }),
      JSON.stringify({ version: 'relay-file-io-v1', ok: true, root_id: 'invalid' }),
      JSON.stringify({ version: 'relay-file-io-v1', ok: false, error: { code: 'UNRECOGNIZED', message: 'private' } })]) {
      await withChild(helper, `process.stdin.resume(); process.stdin.once('end', () => { process.stdout.write(${JSON.stringify(output)}); });`, async (_children, closed) => {
        await assert.rejects(probeRestoreResourceRoots(input(resources, helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_PROTOCOL')); assert.equal(closed.size, 1);
      });
    }
    await withChild(helper, "process.stdin.resume(); process.stdin.once('end', () => { process.stdout.write(Buffer.from([0xff])); });", async (_children, closed) => {
      await assert.rejects(probeRestoreResourceRoots(input(resources, helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_PROTOCOL')); assert.equal(closed.size, 1);
    });
  });
});

test('stdout/stderr budgets and nonzero child exits are safe failures after actual close', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    for (const stream of ['stdout', 'stderr']) {
      await withChild(helper, `process.stdin.once('data', () => { process.${stream}.write('x'.repeat(5000)); }); process.stdin.resume(); setInterval(() => {}, 1000);`, async (_children, closed) => {
        await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_LIMIT')); assert.equal(closed.size, 1);
      });
    }
    await withChild(helper, "process.stdin.resume(); process.stdin.once('end', () => { process.stderr.write('private credential/error'); process.exitCode = 7; });", async (_children, closed) => {
      await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_UNAVAILABLE')); assert.equal(closed.size, 1);
    });
  });
});

test('single-child timeout and an elapsed overall deadline cannot return a report', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    await withChild(helper, 'process.stdin.resume(); setInterval(() => {}, 1000);', async (_children, closed) => {
      const started = performance.now();
      await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_TIMEOUT'));
      assert.ok(performance.now() - started >= 9500); assert.equal(closed.size, 1);
    });
    const original = Date.now; let offset = 0; Date.now = () => original() + offset;
    try {
      await withChild(helper, null, async (_children, closed) => {
        await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha)), refusal('RESTORE_RESOURCE_ROOTS_TIMEOUT'));
        assert.equal(closed.size, 1);
      }, child => { child.once('close', () => { offset = 31_000; }); });
    } finally { Date.now = original; }
  });
});

test('lost holds before or after native observation never produce a successful report', async () => {
  await fixture(async (_base, root, helper, helperSha, id) => {
    await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha, undefined,
      async () => { throw new Error('private hold error'); })), refusal('RESTORE_RESOURCE_ROOTS_HOLD_LOST'));
    let completed = false;
    await withChild(helper, null, async (_children, closed) => {
      await assert.rejects(probeRestoreResourceRoots(input([row(root, id)], helper, helperSha, undefined,
        async () => { if (completed) throw new Error('private lost hold'); })), refusal('RESTORE_RESOURCE_ROOTS_HOLD_LOST'));
      assert.equal(closed.size, 1);
    }, child => { child.once('close', () => { completed = true; }); });
  });
});

test('shared single-request extraction preserves strict source-ancestor refusal and original ARMED bytes', async () => {
  await fixture(async (_base, root, helper, _helperSha, id) => {
    await mkdir(join(root, 'runtime-launches'));
    const path = join(root, 'runtime-launches', `${randomUUID()}.json`), bytes = Buffer.from(' {"state":"ARMED","original":true}\r\n');
    await writeFile(path, bytes); const entries = await readdir(root);
    await assert.rejects(assertRestoreSourceRootSeparate(join(root, 'absent-target'), id, helper, new AbortController().signal),
      cause => cause instanceof RestoreFilesError && cause.code === 'RESTORE_SOURCE_ROOT_OVERLAP');
    assert.deepEqual(await readFile(path), bytes); assert.deepEqual(await readdir(root), entries); assert.equal(existsSync(join(root, 'absent-target')), false);
  });
});
