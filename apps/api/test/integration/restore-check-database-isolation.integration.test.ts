import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

import { changeAdmission } from '../../src/application/runtime-maintenance.js';
import { GRAPH_INSTALL_LOCK, installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { MIGRATION_LOCK_NAMESPACE, runMigrations } from '../../src/infrastructure/migration-runner.js';
import { postgresErrorCode } from '../../src/infrastructure/postgres-error.js';
import { readBackupDatabaseState } from '../../src/runtime/backup-state.js';
import { type DatabaseMaintenanceTarget } from '../../src/runtime/database-connect-fence.js';
import { decodeRestoreDatabaseIsolationJournal, holdRestoredDatabaseIsolation, holdRestoreDatabaseIsolation,
  RestoreDatabaseIsolationError, type RestoreDatabaseIsolation } from '../../src/runtime/restore-database-isolation.js';
import { exportFirstPartyRegistryArchive } from '../../src/skills/first-party-registry.js';
import { ADMIN_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, createTemporaryDatabase,
  openDatabase, type TemporaryDatabase } from './integration-support.js';

let database: TemporaryDatabase, files: string, journalFile: string, operationId: string;
let expectedTarget: DatabaseMaintenanceTarget, journalBytes: Buffer, baseline: unknown;
let sessions: RestoreDatabaseIsolation[], clients: Client[];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreDatabaseIsolationError &&
  cause.code === code && cause.message === code;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
async function connect(url: string, name = 'relay-restored-isolation-test'): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: name, connectionTimeoutMillis: 5000, query_timeout: 6000 });
  clients.push(client); client.on('error', () => {}); await client.connect(); return client;
}
async function query(text: string, values?: unknown[]): Promise<import('pg').QueryResult> {
  const client = await connect(database.migrationUrl);
  try { return await client.query(text, values); } finally { await client.end(); }
}
async function snapshot(): Promise<unknown> {
  const reader = await connect(database.migrationUrl);
  try {
    return { workspaces: (await reader.query('select to_jsonb(t) as row from workspaces t order by id')).rows,
      graph: (await reader.query('select to_jsonb(t) as row from relay_graph_v1.checkpoints t order by thread_id,checkpoint_id')).rows,
      admission: (await reader.query('select mode,revision::text from runtime_admission_gate')).rows,
      receipts: (await reader.query('select to_jsonb(t) as row from command_receipts t order by scope_key,command_id')).rows,
      acl: (await reader.query(`select a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable
        from pg_database d,lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
        where d.datname=current_database() order by a.grantee,a.grantor,a.privilege_type`)).rows,
      journal: sha256(await readFile(journalFile)) };
  } finally { await reader.end(); }
}
function input(signal?: AbortSignal) {
  return { migrationUrl: database.migrationUrl, journalFile, operationId, expectedTarget,
    expectedJournalSha256: sha256(journalBytes), expectedAdmissionRevision: '1',
    ...(signal === undefined ? {} : { signal }) };
}
async function hold(signal?: AbortSignal): Promise<RestoreDatabaseIsolation> {
  const session = await holdRestoredDatabaseIsolation(input(signal)); sessions.push(session); return session;
}
async function admission(action: 'begin-drain' | 'resume-admission', revision: string): Promise<void> {
  const owner = openDatabase(database.migrationUrl, 'relay-restored-isolation-fixture-admission');
  try { await changeAdmission(owner.db, { commandId: randomUUID(), action, expectedRevision: revision }); }
  finally { await owner.close(); }
}
async function deniedApp(): Promise<void> {
  const client = new Client({ connectionString: database.appUrl, connectionTimeoutMillis: 5000 });
  try { await assert.rejects(() => client.connect(), cause => postgresErrorCode(cause) === '42501'); }
  finally { await client.end(); }
}
async function waitFor(work: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await work()) { assert.ok(Date.now() < deadline, 'actual private PG state did not arrive'); await delay(20); }
}
async function actualClosed(session: RestoreDatabaseIsolation): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([session.closed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned maintenance connection did not close')), 10000);
  })]); } finally { clearTimeout(timer); }
  await noOwnedConnection();
}
async function noOwnedConnection(): Promise<void> {
  const observer = await connect(ADMIN_DATABASE_URL);
  try {
    await waitFor(async () => (await observer.query(`select pid from pg_stat_activity
      where datname=$1 and application_name='relay-restore-check-database-isolation'`, [database.name])).rows.length === 0);
    assert.equal((await observer.query(`select count(*)::int as count from pg_locks where locktype='advisory'
      and database=(select oid from pg_database where datname=$1)`, [database.name])).rows[0]!.count, 0);
  } finally { await observer.end(); }
}
beforeEach(async () => {
  sessions = []; clients = []; baseline = undefined; operationId = randomUUID();
  database = await createTemporaryDatabase('restore_check_isolation');
  files = await mkdtemp(join(tmpdir(), 'relay-restore-check-isolation-pg-')); journalFile = join(files, 'target-acl.json');
  const source = await connect(MIGRATION_DATABASE_URL);
  let sourceTarget: Record<string, string>;
  try { sourceTarget = (await source.query<Record<string, string>>(`select current_database() as database,
    d.oid::text as database_oid,d.datdba::text as owner_oid,inet_server_addr()::text as server_address,
    inet_server_port()::text as server_port from pg_database d where datname=current_database()`)).rows[0]!; }
  finally { await source.end(); }
  const initial = await holdRestoreDatabaseIsolation({ migrationUrl: database.migrationUrl, journalFile, sourceTarget, operationId });
  sessions.push(initial); expectedTarget = initial.target; await initial.close();
  journalBytes = await readFile(journalFile);
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(database.migrationUrl);
  await query("insert into workspaces(id,name) values($1,'原非空业务行')", [randomUUID()]);
  await query(`insert into relay_graph_v1.checkpoints(thread_id,checkpoint_id,checkpoint,metadata)
    values('retained-thread','retained-checkpoint',$1,$2)`, [{ v: 4, retained: '原图事实' }, { source: 'fixture' }]);
  await admission('begin-drain', '0');
  baseline = await snapshot(); await deniedApp();
});
afterEach(async () => {
  mock.restoreAll();
  await Promise.allSettled(sessions.map(session => session.close()));
  await Promise.allSettled(clients.map(client => client.end()));
  try {
    if (baseline !== undefined) { assert.deepEqual(await snapshot(), baseline); await deniedApp(); await noOwnedConnection(); }
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    if (database !== undefined) await database.drop();
    if (files !== undefined) await rm(files, { recursive: true, force: true });
  }
});

test('nonempty restored target reholds exact evidence and admits a controlled read-only state connection without ACL recovery', async () => {
  const session = await hold(); assert.deepEqual(session.target, expectedTarget); assert.equal(session.operationId, operationId);
  assert.equal(session.isHeld(), true); await session.assertQuiescent();
  const resourceHashes: Record<string, string> = {};
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
    if (name.endsWith('.sql')) resourceHashes[`api/migrations/${name}`] = sha256(await readFile(join(MIGRATIONS_DIRECTORY, name)));
  }
  const state = await readBackupDatabaseState({ migrationUrl: database.migrationUrl, registry: exportFirstPartyRegistryArchive(),
    resourceHashes, signal: new AbortController().signal, assertHeld: () => session.assertHeld() });
  assert.deepEqual(state.admission, { mode: 'DRAINING', revision: '1' });
  assert.equal(state.target.database_oid, expectedTarget.database_oid); await session.assertQuiescent();
  await session.close(); await session.close(); await actualClosed(session);
  assert.equal(session.isHeld(), false); await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_CONNECTION_LOST'));
});

test('wrong target, operation and raw journal hash refuse without touching the restored facts', async () => {
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(), expectedTarget: { ...expectedTarget, app_oid: '1' } }),
    refusal('RESTORE_DATABASE_TARGET_MISMATCH'));
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(), operationId: randomUUID() }), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(), expectedJournalSha256: '0'.repeat(64) }), refusal('RESTORE_DATABASE_JOURNAL_CHANGED'));
  // A self-consistent local journal claiming another physical target must still be checked against PG.
  const record = { ...decodeRestoreDatabaseIsolationJournal(journalBytes), target: { ...expectedTarget, database_oid: String(BigInt(expectedTarget.database_oid) + 1n) } };
  const bytes = Buffer.from(JSON.stringify({ record, sha256: sha256(Buffer.from(JSON.stringify(record))) }));
  const foreign = join(files, 'wrong-target.json'); await writeFile(foreign, bytes);
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(), journalFile: foreign,
    expectedTarget: record.target, expectedJournalSha256: sha256(bytes) }), refusal('RESTORE_DATABASE_TARGET_MISMATCH'));
});

test('explicit parsed connection settings ignore unrelated PG environment and keep the owned session read only', async () => {
  const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
  let checked = false;
  const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
    const result = await originalQuery.call(this, text, values);
    if (!checked && text === 'select pg_backend_pid() as pid') {
      checked = true;
      assert.equal((await originalQuery.call(this, 'show default_transaction_read_only')).rows[0]!.default_transaction_read_only, 'on');
      await assert.rejects(() => originalQuery.call(this, 'update public.workspaces set name=name where false'),
        cause => postgresErrorCode(cause) === '25006');
    }
    return result;
  });
  const names = ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGOPTIONS', 'PGSSLMODE'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.PGHOST = 'private.invalid'; process.env.PGPORT = '1'; process.env.PGUSER = 'relay_app';
  process.env.PGDATABASE = 'never-connect'; process.env.PGPASSWORD = 'private-sentinel';
  process.env.PGOPTIONS = '-c unknown_private_setting=on'; process.env.PGSSLMODE = 'require';
  let session: RestoreDatabaseIsolation;
  try { session = await hold(); }
  finally {
    hook.mock.restore();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
  assert.equal(checked, true);
  const observer = await connect(ADMIN_DATABASE_URL);
  try { assert.equal((await observer.query('select application_name from pg_stat_activity where pid=$1', [session.backendPid])).rows[0]!.application_name,
    'relay-restore-check-database-isolation'); }
  finally { await observer.end(); }
  await session.assertQuiescent(); await session.close(); await actualClosed(session);
});

test('DRAINING and its exact revision are required even after a trusted Owner toggles admission back', async () => {
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(), expectedAdmissionRevision: '2' }), refusal('RESTORE_DATABASE_ADMISSION_CHANGED'));
  await admission('resume-admission', '1'); baseline = await snapshot();
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(), expectedAdmissionRevision: '2' }), refusal('RESTORE_DATABASE_ADMISSION_CHANGED'));
  await admission('begin-drain', '2'); baseline = await snapshot();
  await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_ADMISSION_CHANGED'));
});

test('admission drift after the initial check is caught after locking rather than silently adopting its new revision', async () => {
  const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
  let injected = false;
  const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
    const result = await originalQuery.call(this, text, values);
    if (!injected && text.startsWith('select pg_try_advisory_lock')) {
      injected = true; await admission('resume-admission', '1'); await admission('begin-drain', '2'); baseline = await snapshot();
    }
    return result;
  });
  try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_ADMISSION_CHANGED')); }
  finally { hook.mock.restore(); }
  assert.equal(injected, true); await noOwnedConnection();
});

test('a held session detects exact admission revision drift while keeping the new Owner state intact', async () => {
  const session = await hold(); await admission('resume-admission', '1'); await admission('begin-drain', '2'); baseline = await snapshot();
  await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_ADMISSION_CHANGED')); assert.equal(session.isHeld(), false);
  await session.close(); await actualClosed(session);
});

test('initial and in-flight complete ACL drift refuse without normalization or CONNECT compensation', async () => {
  await query(`revoke temporary on database ${quote(database.name)} from PUBLIC`); baseline = await snapshot();
  await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_ACL_DRIFT'));
  await query(`grant temporary on database ${quote(database.name)} to PUBLIC`); baseline = await snapshot();
  const session = await hold(); await query(`grant temporary on database ${quote(database.name)} to relay_app`); baseline = await snapshot();
  await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_ACL_DRIFT')); assert.equal(session.isHeld(), false);
  await session.close(); await actualClosed(session);
});

test('held journal byte edits and byte-identical pathname replacement invalidate pinned evidence', async () => {
  const session = await hold(); await writeFile(journalFile, Buffer.concat([journalBytes, Buffer.from('\n')])); baseline = await snapshot();
  await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_JOURNAL_CHANGED')); await session.close();
  await writeFile(journalFile, journalBytes); baseline = await snapshot();
  const next = await hold(); await rename(journalFile, join(files, 'retained-original.json')); await writeFile(journalFile, journalBytes);
  await assert.rejects(next.assertHeld, refusal('RESTORE_DATABASE_JOURNAL_CHANGED')); await next.close(); await actualClosed(next);
});

test('either busy original DDL lock refuses within a bound and frees its own earlier lock', async () => {
  for (const namespace of [MIGRATION_LOCK_NAMESPACE, GRAPH_INSTALL_LOCK]) {
    const blocker = await connect(database.migrationUrl); await blocker.query('select pg_advisory_lock(hashtextextended($1,0))', [namespace]);
    const started = Date.now();
    try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_LOCK_BUSY')); assert.ok(Date.now() - started < 15000); }
    finally { await blocker.end(); }
    await noOwnedConnection();
  }
});

test('a genuinely lost original lock is not reacquired or reported as held', async () => {
  const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
  let injected = false;
  const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
    const result = await originalQuery.call(this, text, values);
    if (!injected && text === 'select pg_backend_pid() as pid') {
      injected = true;
      assert.equal((await originalQuery.call(this, 'select pg_advisory_unlock(hashtextextended($1,0)) as unlocked', [MIGRATION_LOCK_NAMESPACE])).rows[0]!.unlocked, true);
    }
    return result;
  });
  try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_LOCK_LOST')); }
  finally { hook.mock.restore(); }
  assert.equal(injected, true); await noOwnedConnection();
});

test('existing owner and actual startup connections refuse without ending those connections', async () => {
  const writer = await connect(database.migrationUrl);
  try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_OTHER_CONNECTION')); assert.equal((await writer.query('select 1 as alive')).rows[0]!.alive, 1); }
  finally { await writer.end(); }
  const observer = await connect(ADMIN_DATABASE_URL);
  const startup = new Client({ connectionString: database.migrationUrl, application_name: 'restore-check-delayed-startup',
    options: '-c post_auth_delay=5', connectionTimeoutMillis: 10000 });
  clients.push(startup); startup.on('error', () => {}); const pending = startup.connect(); void pending.catch(() => {});
  try {
    await waitFor(async () => (await observer.query(`select a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name='restore-check-delayed-startup' and a.datid is null and l.locktype='object'
        and l.classid='pg_database'::regclass and l.objid=(select oid from pg_database where datname=$1)`, [database.name])).rows.length === 1);
    await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_OTHER_CONNECTION'));
  } finally { await pending; await startup.end(); await observer.end(); }
});

test('a real prepared transaction remains a blocker after its own connection has closed', async () => {
  const gid = `restore_check_${randomUUID().replaceAll('-', '')}`, writer = await connect(database.migrationUrl);
  await writer.query('begin'); await writer.query('select pg_current_xact_id()'); await writer.query(`prepare transaction '${gid}'`); await writer.end();
  try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_PREPARED_TRANSACTION')); }
  finally { await query(`rollback prepared '${gid}'`); }
});

test('controlled read connection permits assertHeld but assertQuiescent requires that connection to really end', async () => {
  const session = await hold(), reader = await connect(database.migrationUrl);
  await reader.query('begin read only'); assert.equal((await reader.query('select count(*)::int as count from workspaces')).rows[0]!.count, 1);
  await session.assertHeld(); await assert.rejects(session.assertQuiescent, refusal('RESTORE_DATABASE_OTHER_CONNECTION'));
  assert.equal(session.isHeld(), true); await reader.query('commit'); await reader.end(); await session.assertQuiescent();
  await session.close(); await actualClosed(session);
});

test('loss of the verified owned backend and post-hold Abort really close without reopening CONNECT', async () => {
  const session = await hold(), admin = await connect(ADMIN_DATABASE_URL);
  const result = await admin.query(`select pg_terminate_backend(pid,5000) as stopped from pg_stat_activity
    where pid=$1 and datname=$2 and usename='relay_migrator' and application_name='relay-restore-check-database-isolation'`, [session.backendPid, database.name]);
  assert.equal(result.rows[0]!.stopped, true); await admin.end(); await actualClosed(session);
  assert.equal(session.isHeld(), false); await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_CONNECTION_LOST')); await session.close();
  const controller = new AbortController(), next = await hold(controller.signal); controller.abort(new Error('private abort reason'));
  await actualClosed(next); await next.close(); assert.equal(next.isHeld(), false);
  await assert.rejects(next.assertHeld, refusal('RESTORE_DATABASE_ABORTED'));
});

test('pre-abort and cancellation during real DDL lock wait leave journal and fenced ACL untouched', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => hold(controller.signal), refusal('RESTORE_DATABASE_ABORTED'));
  const blocker = await connect(database.migrationUrl); await blocker.query('select pg_advisory_lock(hashtextextended($1,0))', [GRAPH_INSTALL_LOCK]);
  const waiting = new AbortController(), observer = await connect(ADMIN_DATABASE_URL);
  const pending = hold(waiting.signal); void pending.catch(() => {});
  try {
    await waitFor(async () => (await observer.query(`select l.pid from pg_locks l join pg_stat_activity a on a.pid=l.pid
      where a.datname=$1 and a.application_name='relay-restore-check-database-isolation'
        and l.locktype='advisory' and l.objsubid=1 and l.granted`, [database.name])).rows.length === 1);
    waiting.abort(); await assert.rejects(() => pending, refusal('RESTORE_DATABASE_ABORTED'));
  } finally { waiting.abort(); await pending.catch(() => {}); await blocker.end(); await observer.end(); }
  await noOwnedConnection();
});
