import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';

import { changeAdmission } from '../../src/application/runtime-maintenance.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { BackupPostgresError, createPostgresBackupArchive, postgresBackupEnvironment, restorePostgresBackupArchive } from '../../src/runtime/backup-postgres.js';
import { decodeDatabaseFenceJournal, holdDatabaseConnectFence, type DatabaseConnectFence } from '../../src/runtime/database-connect-fence.js';
import { holdRestoreDatabaseIsolation, RestoreDatabaseIsolationError, type RestoreDatabaseIsolation } from '../../src/runtime/restore-database-isolation.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase } from './integration-support.js';

const postgresBin = resolve(MIGRATIONS_DIRECTORY, '../../../.research/runtime-cache/postgresql-18.6-2/pgsql/bin');
const runFile = promisify(execFile);
const refusal = (code: string) => (cause: unknown) => cause instanceof BackupPostgresError && cause.code === code && cause.message === code;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
let source: TemporaryDatabase;
let files: string;
let sourceFence: DatabaseConnectFence | undefined;
let archive: Awaited<ReturnType<typeof createPostgresBackupArchive>>;
let dumpFile: string;
let sourceRows: unknown[];
let sourcePrivileges: unknown[];
const operationId = randomUUID(), runId = randomUUID(), stepId = randomUUID(), attemptId = randomUUID();
const clients = new Set<Client>();
async function connect(url: string, application_name = 'relay-restore-test'): Promise<Client> {
  const client = new Client({ connectionString: url, application_name, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
  clients.add(client); client.on('error', () => {}); await client.connect(); return client;
}
async function close(client: Client): Promise<void> { await client.end(); clients.delete(client); }
async function rows(client: Client): Promise<unknown[]> {
  const tables = (await client.query<{ schema: string; name: string }>(`select n.nspname as schema,c.relname as name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','relay_graph_v1') and c.relkind='r' order by n.nspname,c.relname`)).rows;
  const result: unknown[] = [];
  for (const table of tables) result.push({ ...table, rows: (await client.query(
    `select to_jsonb(t) as row from ${quote(table.schema)}.${quote(table.name)} t order by to_jsonb(t)::text`)).rows });
  return result;
}
async function privileges(client: Client): Promise<unknown[]> {
  return (await client.query(`select n.nspname,c.relname,pg_get_userbyid(c.relowner) as owner,c.relacl::text as acl
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','relay_graph_v1') and c.relkind in ('r','S') order by n.nspname,c.relname`)).rows;
}
async function seed(client: Client): Promise<void> {
  const workspace = randomUUID(), task = randomUUID(), artifact = randomUUID(), version = randomUUID();
  await client.query('begin');
  try {
    await client.query("insert into workspaces(id,name) values($1,'原数据与未知动作')", [workspace]);
    await client.query("insert into tasks(id,workspace_id,title,status,mode,acceptance_revision,executor_kind) values($1,$2,'original task','INBOX','ME',1,'HUMAN')", [task, workspace]);
    await client.query("insert into task_acceptances(task_id,acceptance_revision,objective,required_output_spec,source) values($1,1,'original objective','{}','CREATE')", [task]);
    await client.query("insert into artifacts(id,workspace_id,task_id,artifact_kind,title) values($1,$2,$3,'MARKDOWN_DOCUMENT','original')", [artifact, workspace, task]);
    await client.query("insert into artifact_versions(id,artifact_id,version_number,storage_ref,content_hash,size,media_type,source_kind) values($1,$2,1,$3,$4,9,'text/markdown','HUMAN')",
      [version, artifact, `artifacts/${artifact}/${version}/content.md`, createHash('sha256').update('original!').digest()]);
    // Persisted ledger fixture only: no Worker, Adapter or external effect is executed.
    await client.query("insert into runs(id,workspace_id,task_id,status,ownership_epoch) values($1,$2,$3,'PAUSED',0)", [runId, workspace, task]);
    await client.query("insert into execution_contracts(run_id,task_id,acceptance_revision,workflow_key,workflow_version,execution_config_version,contract_hash,frozen_snapshot) values($1,$2,1,'markdown-deliverable-v1','1','fixture',$3,'{}')", [runId, task, Buffer.alloc(32, 1)]);
    await client.query("insert into run_steps(id,run_id,step_index,step_kind,status) values($1,$2,2,'PERSIST_CANDIDATE','RUNNING')", [stepId, runId]);
    await client.query("insert into step_attempts(id,step_id,attempt_number,attempt_key,status) values($1,$2,1,'original-attempt','RUNNING')", [attemptId, stepId]);
    await client.query("insert into run_effect_actions(operation_id,run_id,step_id,attempt_id,action_type,target_ref,params_hash,status,dispatch_count,dispatched_at) values($1,$2,$3,$4,'PUBLISH_CANDIDATE','original-effect-target',$5,'UNKNOWN',1,now())", [operationId, runId, stepId, attemptId, Buffer.alloc(32, 2)]);
    await client.query("insert into relay_graph_v1.checkpoints(thread_id,checkpoint_id,checkpoint,metadata) values('restore-thread','restore-checkpoint',$1,$2)", [{ v: 4, channel_versions: { draft: '1' }, pending: '原 checkpoint' }, { source: 'restore fixture' }]);
    await client.query("insert into relay_graph_v1.checkpoint_blobs(thread_id,channel,version,type,blob) values('restore-thread','draft','1','json',$1)", [Buffer.from('原 blob')]);
    await client.query("insert into relay_graph_v1.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob) values('restore-thread','restore-checkpoint','original-task',0,'draft','json',$1)", [Buffer.from('原 write')]);
    await client.query('commit');
  } catch (cause) { await client.query('rollback'); throw cause; }
}
before(async () => {
  source = await createTemporaryDatabase('restore_pg_source');
  files = await mkdtemp(join(tmpdir(), 'relay-restore-pg-integration-'));
  await runMigrations({ connectionString: source.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(source.migrationUrl);
  const reader = await connect(source.migrationUrl);
  try { await seed(reader); } finally { await close(reader); }
  const app = openDatabase(source.appUrl, 'relay-restore-source-drain');
  try { await changeAdmission(app.db, { commandId: randomUUID(), action: 'begin-drain', expectedRevision: '0' }); }
  finally { await app.close(); }
  const original = await connect(source.migrationUrl);
  try { sourceRows = await rows(original); sourcePrivileges = await privileges(original); } finally { await close(original); }
  sourceFence = await holdDatabaseConnectFence(source.migrationUrl, join(files, 'source-acl.json'));
  await sourceFence.assertQuiescent();
  dumpFile = join(files, 'original.dump');
  archive = await createPostgresBackupArchive({ migrationUrl: source.migrationUrl, postgresBin, dumpFile,
    signal: new AbortController().signal, assertHeld: async () => { assert.equal(sourceFence!.isHeld(), true); await sourceFence!.assertQuiescent(); } });
});
after(async () => {
  await Promise.allSettled([...clients].map(close));
  if (sourceFence?.isHeld()) await sourceFence.release();
  if (source !== undefined) await source.drop();
  if (files !== undefined) await rm(files, { recursive: true, force: true });
});
async function fixture(work: (target: TemporaryDatabase, isolation: RestoreDatabaseIsolation,
  input: Parameters<typeof restorePostgresBackupArchive>[0], marker: string) => Promise<void>): Promise<void> {
  const target = await createTemporaryDatabase('restore_pg_target');
  const marker = join(files, `${target.name}-restore-isolation.json`);
  await writeFile(marker, 'fixture restore remains isolated');
  let isolation: RestoreDatabaseIsolation | undefined;
  try {
    isolation = await holdRestoreDatabaseIsolation({ migrationUrl: target.migrationUrl,
      journalFile: join(files, `${target.name}-target-acl.json`),
      sourceTarget: { ...decodeDatabaseFenceJournal(await readFile(join(files, 'source-acl.json'))).target }, operationId: randomUUID() });
    await isolation.assertQuiescent();
    await work(target, isolation, { migrationUrl: target.migrationUrl, postgresBin, dumpFile,
      expectedArchive: archive, signal: new AbortController().signal, assertHeld: () => isolation!.assertHeld() }, marker);
    await isolation.assertQuiescent();
    await isolation.close();
    const admin = await connect(target.adminUrl);
    try { assert.equal((await admin.query("select has_database_privilege('relay_app',current_database(),'CONNECT') as allowed")).rows[0]!.allowed, false); }
    finally { await close(admin); }
    assert.equal(await readFile(marker, 'utf8'), 'fixture restore remains isolated');
    const original = await connect(source.migrationUrl);
    try { assert.deepEqual(await rows(original), sourceRows); assert.deepEqual(await privileges(original), sourcePrivileges); }
    finally { await close(original); }
    await sourceFence!.assertQuiescent();
    assert.equal(sha256(await readFile(dumpFile)), archive.sha256);
  } finally { await isolation?.close(); await target.drop(); }
}
async function empty(target: TemporaryDatabase): Promise<void> {
  const reader = await connect(target.migrationUrl);
  try {
    assert.equal((await reader.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','relay_graph_v1') and c.relkind='r'")).rows[0]!.count, 0);
    assert.equal((await reader.query("select to_regnamespace('relay_graph_v1') is null as absent")).rows[0]!.absent, true);
  }
  finally { await close(reader); }
}

test('production restore retains every public/Graph table row, object privilege and original UNKNOWN identity in an isolated empty target', async () => {
  await fixture(async (target, isolation, input) => {
    const settings = ['PGSERVICE', 'PGOPTIONS', 'PGPASSFILE', 'OPENAI_API_KEY'] as const;
    const previous = settings.map(name => process.env[name]);
    process.env.PGSERVICE = 'private-nonexistent-service'; process.env.PGOPTIONS = '-c default_transaction_read_only=on';
    process.env.PGPASSFILE = 'private-nonexistent-password-file'; process.env.OPENAI_API_KEY = 'private-provider-sentinel';
    try { await restorePostgresBackupArchive(input); }
    finally { settings.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
    await isolation.assertQuiescent();
    const reader = await connect(target.migrationUrl);
    try {
      assert.deepEqual(await rows(reader), sourceRows); assert.deepEqual(await privileges(reader), sourcePrivileges);
      assert.deepEqual((await reader.query('select operation_id,run_id,step_id,attempt_id,status,dispatch_count from run_effect_actions')).rows,
        [{ operation_id: operationId, run_id: runId, step_id: stepId, attempt_id: attemptId, status: 'UNKNOWN', dispatch_count: 1 }]);
      for (const table of ['artifact_versions', 'relay_graph_v1.checkpoints', 'relay_graph_v1.checkpoint_blobs', 'relay_graph_v1.checkpoint_writes']) {
        assert.equal((await reader.query(`select count(*)::int as count from ${table}`)).rows[0]!.count, 1);
      }
    } finally { await close(reader); }
  });
});

test('the exact PG18 restore tool emits fixed SQL that resets connection timeout initial values to zero', async () => {
  const generated = await runFile(join(postgresBin, 'pg_restore.exe'), ['--file=-', dumpFile], {
    env: { ...postgresBackupEnvironment(source.migrationUrl), PGOPTIONS: '-c lock_timeout=5000 -c statement_timeout=300000' },
    windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.match(generated.stdout, /^SET statement_timeout = 0;$/mu);
  assert.match(generated.stdout, /^SET lock_timeout = 0;$/mu);
  assert.match(generated.stdout, /^SET idle_in_transaction_session_timeout = 0;$/mu);
  assert.equal(generated.stderr, '');
});

test('production restore refuses archive hash, tool identity/version and TOC drift without writing target objects', async () => {
  await fixture(async (target, _isolation, input) => {
    for (const [change, code] of [[{ sha256: '0'.repeat(64) }, 'BACKUP_PG_ARCHIVE_INVALID'],
      [{ restoreToolSha256: '0'.repeat(64) }, 'BACKUP_PG_TOOL_CHANGED'],
      [{ toolVersion: '18.999' }, 'BACKUP_PG_TOOL_VERSION'],
      [{ catalogSha256: '0'.repeat(64) }, 'BACKUP_PG_CATALOG_INVALID']] as const) {
      await assert.rejects(restorePostgresBackupArchive({ ...input, expectedArchive: { ...archive, ...change } }), refusal(code));
      await empty(target);
    }
    let calls = 0;
    await assert.rejects(restorePostgresBackupArchive({ ...input, assertHeld: async () => {
      if (++calls === 3) throw new Error('private isolation detail'); await input.assertHeld();
    } }), refusal('BACKUP_PG_LOCK_LOST'));
    await empty(target);
  });
});

test('production restore does not clean an occupied archive table and rolls back all newly imported objects', async () => {
  await fixture(async (target, _isolation, input) => {
    // The production isolation precheck already rejected arbitrary nonempty targets.
    // This controlled post-hold drift exercises pg_restore's single-transaction failure.
    const occupied = await connect(target.migrationUrl);
    try { await occupied.query("create table public.artifact_versions(original text); insert into public.artifact_versions values('keep original target')"); }
    finally { await close(occupied); }
    await assert.rejects(restorePostgresBackupArchive(input), refusal('BACKUP_PG_TOOL_FAILED'));
    const reader = await connect(target.migrationUrl);
    try {
      assert.deepEqual((await reader.query('select * from public.artifact_versions')).rows, [{ original: 'keep original target' }]);
      assert.equal((await reader.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','relay_graph_v1') and c.relkind='r'")).rows[0]!.count, 1);
      assert.equal((await reader.query("select to_regnamespace('relay_graph_v1') is null as absent")).rows[0]!.absent, true);
    } finally { await close(reader); }
  });
});

test('production restore aborts a real lock waiter, keeps isolation and observes backend exit only after its own blocker is released', async () => {
  await fixture(async (target, isolation, input, marker) => {
    const blocker = await connect(target.adminUrl, 'relay-restore-owned-blocker');
    const control = new AbortController(); let observed = false, checking = false, released = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    // A target-local catalog SHARE lock permits the isolation session's reads but
    // blocks pg_restore's CREATE SCHEMA; only this fixture's private target is touched.
    await blocker.query('begin'); await blocker.query('lock table pg_catalog.pg_namespace in share mode');
    try {
      timer = setInterval(() => {
        if (checking || observed) return; checking = true;
        void (async () => {
          await blocker.query('select pg_stat_clear_snapshot()');
          const result = await blocker.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and application_name='relay-restore-pg-archive' and wait_event_type='Lock'");
          if (result.rows[0]!.count > 0) { observed = true; control.abort(); }
        })().finally(() => { checking = false; });
      }, 50);
      await assert.rejects(restorePostgresBackupArchive({ ...input, signal: control.signal }), refusal('BACKUP_PG_ABORTED'));
      assert.equal(observed, true, 'abort must follow an actual owned pg_restore lock waiter');
      assert.equal(isolation.isHeld(), true); await isolation.assertHeld();
      assert.equal(await readFile(marker, 'utf8'), 'fixture restore remains isolated');
      await blocker.query('select pg_stat_clear_snapshot()');
      assert.equal((await blocker.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and application_name='relay-restore-pg-archive'")).rows[0]!.count, 1,
        'owned child is gone while its server backend is still present');
      await assert.rejects(isolation.assertQuiescent(), cause => cause instanceof RestoreDatabaseIsolationError &&
        cause.code === 'RESTORE_DATABASE_OTHER_CONNECTION');
      // pg_restore resets lock_timeout/statement_timeout to zero. Only trusted
      // fixture cleanup releases this blocker; child close is never the proof.
      await blocker.query('rollback'); released = true;
      const deadline = Date.now() + 7000; let remaining = 1;
      do {
        await blocker.query('select pg_stat_clear_snapshot()');
        remaining = (await blocker.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and application_name='relay-restore-pg-archive'")).rows[0]!.count;
        if (remaining === 0) break; await delay(100);
      } while (Date.now() < deadline);
      assert.equal(remaining, 0, 'backend must really leave after the fixture releases its own blocker');
      assert.equal((await blocker.query('select 1 as live')).rows[0]!.live, 1);
    } finally {
      if (timer !== undefined) clearInterval(timer);
      while (checking) await delay(10);
      if (!released) await blocker.query('rollback'); await close(blocker);
    }
    await empty(target);
  });
});
