import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BackupPostgresError, createPostgresBackupArchive, inspectPostgresBackupCatalog,
  postgresBackupEnvironment } from '../../src/runtime/backup-postgres.js';

const url = 'postgresql://relay_migrator:explicit-password@127.0.0.1:5432/test_db';
const refusal = (code: string) => (cause: unknown) => cause instanceof BackupPostgresError && cause.code === code && cause.message === code;
const held = async () => {};
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'relay-backup-pg-unit-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('postgres backup URL contract excludes ambient PG and Provider settings and user password files', () => {
  const previous = process.env.PGSERVICE;
  process.env.PGSERVICE = 'must-not-inherit';
  try {
    const env = postgresBackupEnvironment(`${url}?sslmode=disable`);
    assert.equal(env.PGUSER, 'relay_migrator'); assert.equal(env.PGPASSWORD, 'explicit-password');
    assert.equal(env.PGHOST, '127.0.0.1'); assert.equal(env.PGPORT, '5432');
    assert.equal(env.PGCONNECT_TIMEOUT, '5'); assert.equal(env.PGPASSFILE, 'NUL');
    assert.equal(env.PGSERVICE, undefined); assert.equal(env.APPDATA, undefined);
    assert.deepEqual(Object.keys(env).filter(name => !['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP'].includes(name)).sort(),
      ['PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGDATABASE', 'PGHOST', 'PGPASSFILE', 'PGPASSWORD', 'PGPORT', 'PGSSLMODE', 'PGUSER']);
  } finally { if (previous === undefined) delete process.env.PGSERVICE; else process.env.PGSERVICE = previous; }
  for (const invalid of [url.replace('relay_migrator', 'relay_app'), url.replace('127.0.0.1', 'remote.example'),
    `${url}?sslmode=require`, `${url}?sslmode=disable&sslmode=disable`, `${url}?options=-csearch_path%3Dpublic`,
    `${url}?service=secret-service`, `${url}?application_name=other`, `${url}/other`, `${url}#fragment`]) {
    assert.throws(() => postgresBackupEnvironment(invalid), refusal('BACKUP_PG_INVALID_CONNECTION'));
  }
});

test('postgres backup catalog requires every business and Graph table and data entry with the migrator owner', () => {
  const lines: string[] = [];
  for (const [schema, table] of [['public', 'relay_schema_migrations'], ['public', 'runtime_admission_gate'],
    ['public', 'artifact_versions'], ['relay_graph_v1', 'checkpoint_migrations'], ['relay_graph_v1', 'checkpoints'],
    ['relay_graph_v1', 'checkpoint_blobs'], ['relay_graph_v1', 'checkpoint_writes']]) {
    lines.push(`1; 0 1 TABLE ${schema} ${table} relay_migrator`, `2; 0 1 TABLE DATA ${schema} ${table} relay_migrator`);
  }
  const bytes = Buffer.from(lines.join('\r\n'));
  assert.equal(inspectPostgresBackupCatalog(bytes), createHash('sha256').update(bytes).digest('hex'));
  for (const invalid of [Buffer.from(lines.slice(1).join('\n')), Buffer.from(lines.join('\n').replace('TABLE DATA public artifact_versions', 'TABLE public artifact_versions')),
    Buffer.from(lines.join('\n').replaceAll('relay_migrator', 'relay_app')), Buffer.from([255]), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    assert.throws(() => inspectPostgresBackupCatalog(invalid), refusal('BACKUP_PG_CATALOG_INVALID'));
  }
});

test('postgres backup abort and lost hold reject before any tool or database work', async () => {
  const control = new AbortController(); control.abort(new Error('private detail'));
  await assert.rejects(createPostgresBackupArchive({ migrationUrl: url, postgresBin: 'unused', dumpFile: 'unused', signal: control.signal, assertHeld: held }), refusal('BACKUP_PG_ABORTED'));
  await fixture(async root => {
    await assert.rejects(createPostgresBackupArchive({ migrationUrl: url, postgresBin: root, dumpFile: join(root, 'dump'),
      signal: new AbortController().signal, assertHeld: async () => { throw new Error('secret'); } }), refusal('BACKUP_PG_LOCK_LOST'));
  });
});

test('postgres backup refuses unsafe paths and does not echo credentials', async () => {
  for (const invalid of ['relative', 'C:\\parent\\..\\bin', '\\\\server\\share', 'C:\\bin:stream', 'C:\\bin.']) {
    await assert.rejects(createPostgresBackupArchive({ migrationUrl: url, postgresBin: invalid, dumpFile: 'C:\\safe\\dump',
      signal: new AbortController().signal, assertHeld: held }), refusal('BACKUP_PG_INVALID_PATH'));
  }
});

test('postgres backup refuses actual wrong-version binaries without creating the archive', async () => {
  await fixture(async root => {
    const bin = join(root, 'bin'); await mkdir(bin);
    await copyFile(process.execPath, join(bin, 'pg_dump.exe')); await copyFile(process.execPath, join(bin, 'pg_restore.exe'));
    const dumpFile = join(root, 'backup.dump');
    await assert.rejects(createPostgresBackupArchive({ migrationUrl: url, postgresBin: bin, dumpFile,
      signal: new AbortController().signal, assertHeld: held }), refusal('BACKUP_PG_TOOL_VERSION'));
    await assert.rejects(readFile(dumpFile), { code: 'ENOENT' });
  });
});

test('postgres backup rejects real binary hardlinks, ADS and junction ancestors', async () => {
  for (const kind of ['hardlink', 'ads', 'junction'] as const) {
    await fixture(async root => {
      const bin = join(root, 'bin'); await mkdir(bin);
      await copyFile(process.execPath, join(bin, 'pg_dump.exe')); await copyFile(process.execPath, join(bin, 'pg_restore.exe'));
      let selected = bin;
      if (kind === 'hardlink') await link(join(bin, 'pg_dump.exe'), join(root, 'alias.exe'));
      if (kind === 'ads') await writeFile(`${join(bin, 'pg_dump.exe')}:hidden`, 'hidden');
      if (kind === 'junction') { selected = join(root, 'alias'); await symlink(bin, selected, 'junction'); }
      try {
        await assert.rejects(createPostgresBackupArchive({ migrationUrl: url, postgresBin: selected, dumpFile: join(root, 'backup.dump'),
          signal: new AbortController().signal, assertHeld: held }), refusal('BACKUP_PG_INVALID_PATH'));
      } finally { if (kind === 'junction') await rm(selected); }
    });
  }
});

test('postgres backup rejects binary drift after an owned version child finishes', async () => {
  await fixture(async root => {
    const bin = join(root, 'bin'); await mkdir(bin);
    await copyFile(process.execPath, join(bin, 'pg_dump.exe')); await copyFile(process.execPath, join(bin, 'pg_restore.exe'));
    let calls = 0;
    await assert.rejects(createPostgresBackupArchive({ migrationUrl: url, postgresBin: bin, dumpFile: join(root, 'backup.dump'),
      signal: new AbortController().signal, assertHeld: async () => {
        if (++calls === 2) await writeFile(join(bin, 'pg_restore.exe'), 'binary replaced');
      } }), refusal('BACKUP_PG_TOOL_CHANGED'));
  });
});
