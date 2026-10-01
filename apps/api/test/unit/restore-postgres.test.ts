import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BackupPostgresError, restorePostgresBackupArchive } from '../../src/runtime/backup-postgres.js';

const migrationUrl = 'postgresql://relay_migrator:private-password@127.0.0.1:5432/test_db';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const refusal = (code: string) => (cause: unknown) => cause instanceof BackupPostgresError &&
  cause.code === code && cause.message === code;
const held = async () => {};
async function fixture(work: (input: Parameters<typeof restorePostgresBackupArchive>[0], root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-pg-unit-'));
  try {
    const postgresBin = join(root, 'bin'); await mkdir(postgresBin);
    const executable = join(postgresBin, 'pg_restore.exe'); await copyFile(process.execPath, executable);
    const dumpFile = join(root, 'original.dump'); const bytes = Buffer.from('PGDMP-original'); await writeFile(dumpFile, bytes);
    await work({ migrationUrl, postgresBin, dumpFile, signal: new AbortController().signal, assertHeld: held,
      expectedArchive: { size: String(bytes.length), sha256: sha256(bytes), toolVersion: '18.6',
        restoreToolSha256: sha256(await readFile(executable)), catalogSha256: '0'.repeat(64) } }, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('postgres restore rejects cancellation and lost isolation before touching archive or tools', async () => {
  await fixture(async input => {
    const control = new AbortController(); control.abort(new Error('private cancellation reason'));
    await assert.rejects(restorePostgresBackupArchive({ ...input, dumpFile: 'unused', signal: control.signal }), refusal('BACKUP_PG_ABORTED'));
    await assert.rejects(restorePostgresBackupArchive({ ...input, assertHeld: async () => { throw new Error('private hold detail'); } }), refusal('BACKUP_PG_LOCK_LOST'));
    assert.equal((await readFile(input.dumpFile)).toString(), 'PGDMP-original');
  });
});

test('postgres restore requires bounded canonical archive metadata and a PG18 version', async () => {
  await fixture(async input => {
    for (const invalid of [{ size: '00' }, { size: '34359738369' }, { sha256: 'f'.repeat(63) },
      { restoreToolSha256: 'A'.repeat(64) }, { catalogSha256: 'private-not-a-hash' }]) {
      await assert.rejects(restorePostgresBackupArchive({ ...input, expectedArchive: { ...input.expectedArchive, ...invalid } }), refusal('BACKUP_PG_ARCHIVE_INVALID'));
    }
    await assert.rejects(restorePostgresBackupArchive({ ...input, expectedArchive: { ...input.expectedArchive, toolVersion: '17.9' } }), refusal('BACKUP_PG_TOOL_VERSION'));
  });
});

test('postgres restore rejects unsupported URL settings and dbname conninfo without echoing secrets', async () => {
  await fixture(async input => {
    for (const invalid of [`${migrationUrl}?options=-clock_timeout%3D0`, `${migrationUrl}?service=private`,
      migrationUrl.replace('/test_db', '/host%3Dremote'), migrationUrl.replace('relay_migrator', 'relay_app')]) {
      await assert.rejects(restorePostgresBackupArchive({ ...input, migrationUrl: invalid }), refusal('BACKUP_PG_INVALID_CONNECTION'));
    }
  });
});

test('postgres restore rejects unsafe archive paths and preserves the original source', async () => {
  await fixture(async input => {
    for (const dumpFile of ['relative', 'C:\\parent\\..\\archive.dump', '\\\\server\\share\\archive.dump', 'C:\\archive.dump:hidden', 'C:\\archive.dump.']) {
      await assert.rejects(restorePostgresBackupArchive({ ...input, dumpFile }), refusal('BACKUP_PG_INVALID_PATH'));
    }
    assert.equal((await readFile(input.dumpFile)).toString(), 'PGDMP-original');
  });
});

test('postgres restore verifies size, stream hash and PGDMP header before any restore child', async () => {
  await fixture(async input => {
    for (const invalid of [{ size: '5' }, { sha256: '0'.repeat(64) }]) {
      await assert.rejects(restorePostgresBackupArchive({ ...input, expectedArchive: { ...input.expectedArchive, ...invalid } }), refusal('BACKUP_PG_ARCHIVE_INVALID'));
    }
    const bytes = Buffer.from('WRONG-original'); await writeFile(input.dumpFile, bytes);
    await assert.rejects(restorePostgresBackupArchive({ ...input, expectedArchive: { ...input.expectedArchive,
      size: String(bytes.length), sha256: sha256(bytes) } }), refusal('BACKUP_PG_ARCHIVE_INVALID'));
    assert.deepEqual(await readFile(input.dumpFile), bytes);
  });
});

test('postgres restore binds the exact restore binary and rejects an actual wrong-version executable', async () => {
  await fixture(async input => {
    await assert.rejects(restorePostgresBackupArchive({ ...input, expectedArchive: { ...input.expectedArchive,
      restoreToolSha256: '0'.repeat(64) } }), refusal('BACKUP_PG_TOOL_CHANGED'));
    await assert.rejects(restorePostgresBackupArchive(input), refusal('BACKUP_PG_TOOL_VERSION'));
    assert.equal((await readFile(input.dumpFile)).toString(), 'PGDMP-original');
  });
});

test('postgres restore rejects actual source hardlinks, ADS and junction ancestors', async () => {
  for (const kind of ['hardlink', 'ads', 'junction'] as const) {
    await fixture(async (input, root) => {
      let dumpFile = input.dumpFile; const alias = join(root, 'alias');
      if (kind === 'hardlink') await link(dumpFile, join(root, 'archive-alias.dump'));
      if (kind === 'ads') await writeFile(`${dumpFile}:hidden`, 'private ADS');
      if (kind === 'junction') {
        const source = join(root, 'source'); await mkdir(source); await copyFile(dumpFile, join(source, 'original.dump'));
        await symlink(source, alias, 'junction'); dumpFile = join(alias, 'original.dump');
      }
      try { await assert.rejects(restorePostgresBackupArchive({ ...input, dumpFile }), refusal('BACKUP_PG_INVALID_PATH')); }
      finally { if (kind === 'junction') await rm(alias); }
    });
  }
});

test('postgres restore catches source and tool replacement at the held pre-child boundary', async () => {
  for (const kind of ['source', 'tool'] as const) {
    await fixture(async input => {
      let calls = 0;
      await assert.rejects(restorePostgresBackupArchive({ ...input, assertHeld: async () => {
        if (++calls === 2) await writeFile(kind === 'source' ? input.dumpFile : join(input.postgresBin, 'pg_restore.exe'), 'changed');
      } }), refusal(kind === 'source' ? 'BACKUP_PG_TARGET_CHANGED' : 'BACKUP_PG_TOOL_CHANGED'));
    });
  }
});
