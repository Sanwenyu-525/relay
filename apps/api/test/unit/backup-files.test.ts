import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { BackupFilesError, copyBackupData } from '../../src/runtime/backup-files.js';

const held = async () => {};
const hasCode = (code: string) => (error: unknown) => error instanceof BackupFilesError &&
  error.code === code && error.message === code;

async function fixture(work: (roots: { source: string; backup: string; temporary: string }) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-backup-files-'));
  const source = join(temporary, 'source');
  const backup = join(temporary, 'backup');
  await mkdir(source);
  await mkdir(backup);
  try { await work({ source, backup, temporary }); }
  finally {
    // Only this exact fresh fixture directory is deleted; junctions are removed as entries first.
    assert.ok(temporary.startsWith(join(tmpdir(), 'relay-backup-files-')));
    await rm(temporary, { recursive: true, force: true });
  }
}

async function file(root: string, ref: string, bytes: string | Buffer): Promise<void> {
  const path = join(root, ...ref.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

test('copies referenced and orphan content, staging and original ARMED bytes to isolated evidence', async () => {
  await fixture(async ({ source, backup }) => {
    const referenced = `artifacts/${randomUUID()}/${randomUUID()}/content.md`;
    const orphan = `artifacts/${randomUUID()}/${randomUUID()}/content.md`;
    const staging = `staging/${randomUUID()}.part`;
    const armed = `runtime-launches/${randomUUID()}.json`;
    const originals = new Map([
      [referenced, Buffer.from('# 已引用\n')], [orphan, Buffer.from('# 候选\n')],
      [staging, Buffer.from([0, 255, 42, 13, 10])],
      [armed, Buffer.from(' { "state" : "ARMED", "raw": 1 }\r\n')],
    ]);
    for (const [ref, bytes] of originals) await file(source, ref, bytes);
    await mkdir(join(source, 'knowledge'));
    await mkdir(join(source, 'runtime-workspaces'));
    await file(source, 'logs/ignored.log', 'operational only');
    await file(source, '.relay-content-admission.lock', '');
    let assertions = 0;
    const result = await copyBackupData({ dataRoot: source, backupRoot: backup,
      assertHeld: async () => { assertions++; } });
    assert.equal(result.length, 4);
    assert.ok(assertions >= 6);
    for (const entry of result) {
      const bytes = originals.get(entry.source_ref)!;
      assert.equal(entry.size, String(bytes.length));
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(entry.backup_ref, `${entry.kind === 'CONTENT' ? 'data' : 'evidence'}/${entry.source_ref}`);
      assert.deepEqual(await readFile(join(backup, entry.backup_ref)), bytes);
      assert.deepEqual(await readFile(join(source, entry.source_ref)), bytes);
    }
    assert.equal(result.find((entry) => entry.source_ref === staging)?.kind, 'STAGING');
    assert.equal(result.find((entry) => entry.source_ref === armed)?.kind, 'ARMED');
    assert.deepEqual(await readdir(join(backup, 'data')), ['artifacts']);
  });
});

test('permits absent managed directories and refuses an occupied target without overwrite', async () => {
  await fixture(async ({ source, backup }) => {
    assert.deepEqual(await copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), []);
    await file(backup, 'data/existing', 'keep');
    await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_TARGET_EXISTS'));
    assert.equal(await readFile(join(backup, 'data/existing'), 'utf8'), 'keep');
  });
});

test('rejects relative, traversal, stream, noncanonical and overlapping root paths', async () => {
  await fixture(async ({ source, backup, temporary }) => {
    for (const invalid of ['relative', `${source}/child/..`, `${source}:stream`, `${source}/bad.`, `${source}/bad `]) {
      await assert.rejects(copyBackupData({ dataRoot: invalid, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_INVALID_PATH'));
    }
    for (const overlapping of [source, join(source, 'backup'), temporary]) {
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: overlapping, assertHeld: held }), hasCode('BACKUP_ROOT_OVERLAP'));
    }
  });
});

test('rejects unknown root entries and nonempty cache directories without reading contents', async () => {
  for (const ref of ['unknown/secret', 'knowledge/secret', 'runtime-workspaces/secret']) {
    await fixture(async ({ source, backup }) => {
      await file(source, ref, 'must not disappear');
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_UNMANAGED_DATA'));
      assert.deepEqual(await readdir(backup), []);
    });
  }
});

test('rejects runtime-launches subdirectories and non-UUID JSON names', async () => {
  for (const ref of ['runtime-launches/unknown.json', 'runtime-launches/sub/file.json', 'runtime-launches/unknown.txt']) {
    await fixture(async ({ source, backup }) => {
      await file(source, ref, '{}');
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_UNMANAGED_DATA'));
    });
  }
});

test('rejects actual directory junctions in source, source ancestors and destination ancestors', async () => {
  await fixture(async ({ source, backup, temporary }) => {
    const actual = join(temporary, 'actual');
    await mkdir(actual);
    const junction = join(source, 'artifacts');
    await symlink(actual, junction, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_UNSAFE_ENTRY'));
    } finally { await rm(junction); }
    const ancestor = join(temporary, 'alias');
    await symlink(temporary, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(copyBackupData({ dataRoot: join(ancestor, 'source'), backupRoot: backup, assertHeld: held }), hasCode('BACKUP_UNSAFE_ENTRY'));
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: join(ancestor, 'backup'), assertHeld: held }), hasCode('BACKUP_UNSAFE_ENTRY'));
    } finally { await rm(ancestor); }
  });
});

test('rejects actual hard-linked files and an aliased destination directory', async () => {
  await fixture(async ({ source, backup, temporary }) => {
    await file(source, 'artifacts/content.md', 'one inode');
    await link(join(source, 'artifacts/content.md'), join(temporary, 'hardlink'));
    await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_HARD_LINK'));
  });
  await fixture(async ({ source, backup, temporary }) => {
    await file(source, 'artifacts/content.md', 'content');
    const elsewhere = join(temporary, 'elsewhere');
    await mkdir(elsewhere);
    const junction = join(backup, 'data');
    await symlink(elsewhere, junction, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_TARGET_EXISTS'));
      assert.deepEqual(await readdir(elsewhere), []);
    } finally { await rm(junction); }
  });
});

test('rejects unsafe entry names and case aliases', async () => {
  await fixture(async ({ source, backup }) => {
    await mkdir(join(source, 'ARTIFACTS'));
    await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_UNMANAGED_DATA'));
  });
  if (process.platform === 'win32') {
    await fixture(async ({ source, backup }) => {
      const path = join(source, 'artifacts');
      await mkdir(path);
      // Extended syntax can create a trailing-dot name that normal Win32 paths alias.
      await writeFile(`\\\\?\\${join(path, 'bad.')}`, 'unsafe');
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_INVALID_PATH'));
    });
  }
});

test('rejects Windows alternate streams on files and directories', { skip: process.platform !== 'win32' }, async () => {
  for (const directory of [false, true]) {
    await fixture(async ({ source, backup }) => {
      await file(source, 'artifacts/content.md', 'visible');
      const target = directory ? join(source, 'artifacts') : join(source, 'artifacts/content.md');
      await writeFile(`${target}:hidden`, 'hidden');
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_ALTERNATE_STREAM'));
    });
  }
});

test('fails if held assertion is lost initially, after a file or at completion', async () => {
  for (const failAt of [1, 3, 4]) {
    await fixture(async ({ source, backup }) => {
      await file(source, 'artifacts/content.md', 'content');
      let calls = 0;
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup,
        assertHeld: async () => { if (++calls === failAt) throw new Error('sensitive lock detail'); } }), hasCode('BACKUP_LOCK_LOST'));
      assert.equal(calls, failAt);
    });
  }
});

test('rejects source file or directory-set drift during copying', async () => {
  for (const directoryDrift of [false, true]) {
    await fixture(async ({ source, backup }) => {
      await file(source, 'artifacts/content.md', 'before');
      let calls = 0;
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup,
        assertHeld: async () => {
          if (++calls === 3) {
            if (directoryDrift) await mkdir(join(source, 'staging'));
            else await writeFile(join(source, 'artifacts/content.md'), 'after!');
          }
        } }), hasCode('BACKUP_SOURCE_CHANGED'));
    });
  }
});

test('rejects content, staging and ARMED files over their individual size bounds', async () => {
  for (const [ref, limit] of [['artifacts/content.md', 256 * 1024], ['staging/candidate.part', 256 * 1024],
    [`runtime-launches/${randomUUID()}.json`, 64 * 1024]] as const) {
    await fixture(async ({ source, backup }) => {
      await file(source, ref, Buffer.alloc(limit + 1));
      await assert.rejects(copyBackupData({ dataRoot: source, backupRoot: backup, assertHeld: held }), hasCode('BACKUP_SIZE_LIMIT'));
      assert.deepEqual(await readdir(backup), []);
    });
  }
});
