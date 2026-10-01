import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';

import { changeAdmission } from '../../src/application/runtime-maintenance.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { holdDatabaseConnectFence, type DatabaseConnectFence } from '../../src/runtime/database-connect-fence.js';
import { BackupPostgresError, createPostgresBackupArchive, postgresBackupEnvironment } from '../../src/runtime/backup-postgres.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase } from './integration-support.js';

const runFile = promisify(execFile);
const postgresBin = resolve(MIGRATIONS_DIRECTORY, '../../../.research/runtime-cache/postgresql-18.6-2/pgsql/bin');
const refusal = (code: string) => (cause: unknown) => cause instanceof BackupPostgresError && cause.code === code;
let database: TemporaryDatabase;
let files: string;
let fence: DatabaseConnectFence | undefined;
const clients = new Set<Client>();
async function connect(url: string, application = 'relay-backup-test'): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: application, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  clients.add(client); client.on('error', () => {}); await client.connect(); return client;
}
async function close(client: Client): Promise<void> { await client.end(); clients.delete(client); }
beforeEach(async () => {
  fence = undefined;
  database = await createTemporaryDatabase('backup_pg');
  files = await mkdtemp(join(tmpdir(), 'relay-backup-pg-integration-'));
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(database.migrationUrl);
  const app = openDatabase(database.appUrl, 'relay-backup-drain');
  try { await changeAdmission(app.db, { commandId: randomUUID(), action: 'begin-drain', expectedRevision: '0' }); }
  finally { await app.close(); }
});
afterEach(async () => {
  if (fence?.isHeld()) await fence.release();
  await Promise.allSettled([...clients].map(close));
  if (database !== undefined) await database.drop();
  if (files !== undefined) await rm(files, { recursive: true, force: true });
});
const tables = ['public.workspaces', 'public.artifact_versions', 'public.relay_schema_migrations',
  'public.runtime_admission_gate', 'relay_graph_v1.checkpoint_migrations', 'relay_graph_v1.checkpoints',
  'relay_graph_v1.checkpoint_blobs', 'relay_graph_v1.checkpoint_writes'] as const;
async function rows(client: Client): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const table of tables) result.push((await client.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`)).rows);
  return result;
}
async function hold() {
  fence = await holdDatabaseConnectFence(database.migrationUrl, join(files, 'original-acl.json'));
  return async () => { assert.equal(fence!.isHeld(), true); await fence!.assertQuiescent(); };
}

test('production archive uses a regular stdout fd and restores original business and all Graph table data into an empty temporary database', async () => {
  const client = await connect(database.migrationUrl);
  const workspace = randomUUID(); const task = randomUUID(); const artifact = randomUUID(); const version = randomUUID();
  await client.query('begin');
  try {
    await client.query('insert into workspaces(id,name) values($1,$2)', [workspace, '归档原数据']);
    await client.query("insert into tasks(id,workspace_id,title,status,mode,acceptance_revision,executor_kind) values($1,$2,'task','INBOX','ME',1,'HUMAN')", [task, workspace]);
    await client.query("insert into task_acceptances(task_id,acceptance_revision,objective,required_output_spec,source) values($1,1,'objective','{}','CREATE')", [task]);
    await client.query("insert into artifacts(id,workspace_id,task_id,artifact_kind,title) values($1,$2,$3,'MARKDOWN_DOCUMENT','original')", [artifact, workspace, task]);
    await client.query("insert into artifact_versions(id,artifact_id,version_number,storage_ref,content_hash,size,media_type,source_kind) values($1,$2,1,$3,$4,9,'text/markdown','HUMAN')",
      [version, artifact, `artifacts/${artifact}/${version}/content.md`, createHash('sha256').update('original!').digest()]);
    await client.query("insert into relay_graph_v1.checkpoints(thread_id,checkpoint_id,checkpoint,metadata) values('archive-thread','archive-checkpoint',$1,$2)",
      [{ v: 4, channel_versions: { draft: '1' }, pending: 'original' }, { source: 'backup fixture' }]);
    await client.query("insert into relay_graph_v1.checkpoint_blobs(thread_id,channel,version,type,blob) values('archive-thread','draft','1','json',$1)", [Buffer.from('原blob')]);
    await client.query("insert into relay_graph_v1.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob) values('archive-thread','archive-checkpoint','task',0,'draft','json',$1)", [Buffer.from('原write')]);
    await client.query('commit');
  } catch (cause) { await client.query('rollback'); throw cause; }
  const original = await rows(client); await close(client);
  const assertHeld = await hold(); const dumpFile = join(files, 'complete.dump');
  const secret = process.env.PGSERVICE; process.env.PGSERVICE = 'must-not-leak-into-tools';
  let archive: Awaited<ReturnType<typeof createPostgresBackupArchive>>;
  try { archive = await createPostgresBackupArchive({ migrationUrl: database.migrationUrl, postgresBin, dumpFile,
    signal: new AbortController().signal, assertHeld }); }
  finally { if (secret === undefined) delete process.env.PGSERVICE; else process.env.PGSERVICE = secret; }
  const bytes = await readFile(dumpFile);
  assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP'); assert.equal(archive.size, String(bytes.length));
  assert.equal(archive.sha256, createHash('sha256').update(bytes).digest('hex')); assert.match(archive.toolVersion, /^18\.[0-9]+$/u);
  for (const digest of [archive.dumpToolSha256, archive.restoreToolSha256, archive.catalogSha256]) assert.match(digest, /^[0-9a-f]{64}$/u);
  const target = await createTemporaryDatabase('backup_pg_target');
  try {
    await runFile(join(postgresBin, 'pg_restore.exe'), ['--no-password', '--exit-on-error', '--dbname', target.name, dumpFile],
      { env: postgresBackupEnvironment(target.migrationUrl), windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
    const reader = await connect(target.migrationUrl, 'relay-backup-restored-reader');
    assert.deepEqual(await rows(reader), original);
    assert.equal((await reader.query('select count(*)::int as count from public.artifact_versions')).rows[0]!.count, 1);
    assert.equal((await reader.query('select count(*)::int as count from relay_graph_v1.checkpoints')).rows[0]!.count, 1);
    assert.equal((await reader.query('select count(*)::int as count from relay_graph_v1.checkpoint_blobs')).rows[0]!.count, 1);
    assert.equal((await reader.query('select count(*)::int as count from relay_graph_v1.checkpoint_writes')).rows[0]!.count, 1);
    await close(reader);
  } finally { await target.drop(); }
});

test('production archive preserves an occupied target and fails on lost maintenance hold', async () => {
  const assertHeld = await hold(); const dumpFile = join(files, 'occupied.dump');
  await writeFile(dumpFile, 'keep');
  await assert.rejects(createPostgresBackupArchive({ migrationUrl: database.migrationUrl, postgresBin, dumpFile,
    signal: new AbortController().signal, assertHeld }), refusal('BACKUP_PG_TARGET_EXISTS'));
  assert.equal(await readFile(dumpFile, 'utf8'), 'keep');
  let calls = 0;
  await assert.rejects(createPostgresBackupArchive({ migrationUrl: database.migrationUrl, postgresBin,
    dumpFile: join(files, 'lost.dump'), signal: new AbortController().signal,
    assertHeld: async () => { if (++calls === 5) throw new Error('private hold detail'); await assertHeld(); } }), refusal('BACKUP_PG_LOCK_LOST'));
  assert.ok((await stat(join(files, 'lost.dump'))).isFile());
});

test('production archive aborts an owned blocked pg_dump, waits for it to exit, and preserves the partial without killing the blocker', async () => {
  // A controlled negative boundary fixture; this blocker deliberately prevents a quiescent success claim.
  const blocker = await connect(database.migrationUrl, 'relay-backup-owned-blocker');
  await blocker.query('begin'); await blocker.query('lock table workspaces in access exclusive mode');
  const control = new AbortController(); let calls = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let observed = false; let checking = false;
  const dumpFile = join(files, 'aborted.dump');
  try {
    await assert.rejects(createPostgresBackupArchive({ migrationUrl: database.migrationUrl, postgresBin, dumpFile,
      signal: control.signal, assertHeld: async () => {
        if (++calls === 4) timer = setInterval(() => {
          if (checking || observed) return;
          checking = true;
          void (async () => {
            await blocker.query('select pg_stat_clear_snapshot()');
            const active = await blocker.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and application_name='relay-backup-pg-dump'");
            if (active.rows[0]!.count > 0) { observed = true; control.abort(); }
          })().finally(() => { checking = false; });
        }, 100);
      } }), refusal('BACKUP_PG_ABORTED'));
    assert.equal(observed, true, 'abort must follow a real owned pg_dump connection');
    assert.ok((await stat(dumpFile)).isFile());
    // Client exit is not a PostgreSQL backend stop proof: a lock waiter notices its
    // lost socket after the fixed lock timeout. Observe that boundary; never kill it.
    const deadline = Date.now() + 7000;
    let remaining = 1;
    do {
      await blocker.query('select pg_stat_clear_snapshot()');
      remaining = (await blocker.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and application_name='relay-backup-pg-dump'" )).rows[0]!.count;
      if (remaining === 0) break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.equal(remaining, 0, 'original dump backend must leave after its bounded lock wait');
    assert.equal((await blocker.query('select 1 as live')).rows[0]!.live, 1);
  } finally { if (timer !== undefined) clearInterval(timer); await blocker.query('rollback'); await close(blocker); }
});
