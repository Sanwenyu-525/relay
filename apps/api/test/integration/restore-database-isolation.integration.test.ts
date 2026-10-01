import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

import { GRAPH_INSTALL_LOCK } from '../../src/infrastructure/graph-checkpoints.js';
import { MIGRATION_LOCK_NAMESPACE } from '../../src/infrastructure/migration-runner.js';
import { postgresErrorCode } from '../../src/infrastructure/postgres-error.js';
import { recoverDatabaseConnectFence, DatabaseConnectFenceError } from '../../src/runtime/database-connect-fence.js';
import { decodeRestoreDatabaseIsolationJournal, holdRestoreDatabaseIsolation,
  RestoreDatabaseIsolationError, type RestoreDatabaseIsolation } from '../../src/runtime/restore-database-isolation.js';
import { ADMIN_DATABASE_URL, MIGRATION_DATABASE_URL, createTemporaryDatabase,
  type TemporaryDatabase } from './integration-support.js';

let database: TemporaryDatabase;
let files: string;
let sourceTarget: Record<string, string>;
let operationId: string;
let clients: Client[];
let sessions: RestoreDatabaseIsolation[];
const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreDatabaseIsolationError &&
  cause.code === code && cause.message === code;
async function connect(url: string, name = 'relay-restore-isolation-test'): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: name, connectionTimeoutMillis: 5000, query_timeout: 6000 });
  clients.push(client); client.on('error', () => {}); await client.connect(); return client;
}
async function identity(url: string): Promise<Record<string, string>> {
  const client = await connect(url);
  try { return (await client.query<Record<string, string>>(`select current_database() as database,
    d.oid::text as database_oid,d.datdba::text as owner_oid,inet_server_addr()::text as server_address,
    inet_server_port()::text as server_port,current_setting('server_version_num') as server_version_num
    from pg_database d where datname=current_database()`)).rows[0]!; }
  finally { await client.end(); }
}
async function query(text: string): Promise<import('pg').QueryResult> {
  const client = await connect(database.migrationUrl);
  try { return await client.query(text); } finally { await client.end(); }
}
async function fullAcl(): Promise<unknown[]> {
  return (await query(`select a.grantee::text,a.grantor::text,a.privilege_type,a.is_grantable
    from pg_database d,lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    where d.datname=current_database() order by a.grantee,a.grantor,a.privilege_type`)).rows;
}
async function appAllowed(): Promise<boolean> {
  return (await query("select has_database_privilege('relay_app',current_database(),'CONNECT') as allowed")).rows[0]!.allowed === true;
}
async function deniedApp(): Promise<void> {
  const client = new Client({ connectionString: database.appUrl, connectionTimeoutMillis: 5000 });
  try { await assert.rejects(() => client.connect(), cause => postgresErrorCode(cause) === '42501'); }
  finally { await client.end(); }
}
function input(name = 'target.json', signal?: AbortSignal) {
  return { migrationUrl: database.migrationUrl, journalFile: join(files, name), sourceTarget, operationId,
    ...(signal === undefined ? {} : { signal }) };
}
async function hold(name = 'target.json', signal?: AbortSignal): Promise<RestoreDatabaseIsolation> {
  const session = await holdRestoreDatabaseIsolation(input(name, signal)); sessions.push(session); return session;
}
async function waitFor(work: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await work()) { assert.ok(Date.now() < deadline, 'actual PG state did not arrive'); await delay(20); }
}
async function closed(session: RestoreDatabaseIsolation): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([session.closed, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('isolation connection did not close')), 10000);
  })]); } finally { clearTimeout(timer); }
}
beforeEach(async () => {
  clients = []; sessions = []; operationId = randomUUID();
  database = await createTemporaryDatabase('restore_isolation');
  files = await mkdtemp(join(tmpdir(), 'relay-restore-database-isolation-'));
  sourceTarget = await identity(MIGRATION_DATABASE_URL); // Wrapper's actual source database; never a user PG URL.
});
afterEach(async () => {
  mock.restoreAll();
  await Promise.allSettled(sessions.map(session => session.close()));
  await Promise.allSettled(clients.map(client => client.end()));
  if (database !== undefined) await database.drop();
  if (files !== undefined) await rm(files, { recursive: true, force: true });
});

test('operator-created empty target holds both original locks, binds evidence, and close never reopens app CONNECT', async () => {
  const expected = await identity(database.migrationUrl);
  const session = await hold();
  assert.equal(session.operationId, operationId); assert.equal(session.target.database_oid, expected.database_oid);
  assert.equal(session.isHeld(), true); await session.assertHeld(); await session.assertQuiescent();
  const saved = await readFile(join(files, 'target.json'));
  const journal = decodeRestoreDatabaseIsolationJournal(saved);
  assert.equal(journal.operation_id, operationId); assert.equal(journal.purpose, 'RESTORE_TARGET_KEEP_ISOLATED');
  assert.equal(journal.source_target.database_oid, sourceTarget.database_oid);
  assert.deepEqual(journal.target, session.target); assert.equal(saved.includes(Buffer.from('postgresql://')), false);
  const observer = await connect(ADMIN_DATABASE_URL);
  const locks = await observer.query(`select count(*)::int as count from pg_locks where pid=$1
    and locktype='advisory' and objsubid=1 and mode='ExclusiveLock' and granted`, [session.backendPid]);
  assert.equal(locks.rows[0]!.count, 2);
  await session.close(); await session.close(); await closed(session);
  assert.equal(session.isHeld(), false); await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_CONNECTION_LOST'));
  await deniedApp(); assert.equal(await appAllowed(), false);
  assert.deepEqual(await readFile(join(files, 'target.json')), saved);
});

test('dirty PG environment cannot redirect the empty target or override its maintenance write options', async () => {
  const expected = await identity(database.migrationUrl);
  const dirty = { PGPORT: '1', PGPASSWORD: randomUUID(), PGSSLMODE: 'require',
    PGOPTIONS: '-c default_transaction_read_only=on' };
  async function product<T>(work: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(dirty).map(key => [key, process.env[key]]));
    Object.assign(process.env, dirty);
    try { return await work(); }
    finally { for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } }
  }
  const session = await product(() => hold());
  assert.equal(session.target.database_oid, expected.database_oid);
  assert.equal(session.target.server_port, expected.server_port);
  const saved = await readFile(join(files, 'target.json')); const fencedAcl = await fullAcl();
  await product(() => session.assertHeld()); await product(() => session.assertQuiescent());
  await deniedApp(); assert.equal(await appAllowed(), false);
  await product(() => session.close()); await closed(session);
  await deniedApp(); assert.equal(await appAllowed(), false);
  assert.deepEqual(await fullAcl(), fencedAcl);
  assert.deepEqual(await readFile(join(files, 'target.json')), saved);
});

for (const [kind, ddl] of [
  ['schema', 'create schema unexpected'], ['table', 'create table public.unexpected(id integer)'],
  ['function', "create function public.unexpected() returns integer language sql as 'select 1'"],
  ['type', "create type public.unexpected as enum ('retained')"],
  ['sequence', 'create sequence public.unexpected'],
  ['collation', 'create collation public.unexpected from pg_catalog."C"'],
  ['extension', 'create extension hstore'],
  ['large-object', 'select lo_create(0)'],
]) {
  test(`nonempty ${kind} target refuses without ACL change or a new journal`, async () => {
    await query(ddl!); const baseline = await fullAcl();
    await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_NOT_EMPTY'));
    assert.deepEqual(await fullAcl(), baseline); assert.equal(await appAllowed(), true);
    await assert.rejects(() => stat(join(files, 'target.json')), { code: 'ENOENT' });
  });
}

test('a user function inside pg_catalog is not mistaken for an empty target', async () => {
  const admin = await connect(database.adminUrl);
  try { await admin.query("create function pg_catalog.restore_fixture_user_function() returns integer language sql as 'select 1'"); }
  finally { await admin.end(); }
  const baseline = await fullAcl();
  await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_NOT_EMPTY'));
  assert.deepEqual(await fullAcl(), baseline); await assert.rejects(() => stat(join(files, 'target.json')), { code: 'ENOENT' });
});

test('same actual source OID is refused through either loopback alias before any mutation', async () => {
  const baseline = await fullAcl(); const target = await identity(database.migrationUrl);
  for (const address of ['127.0.0.1', '::1']) {
    await assert.rejects(() => holdRestoreDatabaseIsolation({ ...input(),
      sourceTarget: { ...target, server_address: address } }), refusal('RESTORE_DATABASE_SOURCE_TARGET'));
  }
  assert.deepEqual(await fullAcl(), baseline);
  await assert.rejects(() => stat(join(files, 'target.json')), { code: 'ENOENT' });
});

test('existing app, Saver and owner connections refuse; their original connections remain alive', async () => {
  const baseline = await fullAcl();
  for (const [url, name] of [[database.appUrl, 'existing-app'], [database.appUrl, 'existing-saver'],
    [database.migrationUrl, 'existing-owner']] as const) {
    const writer = await connect(url, name);
    try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_OTHER_CONNECTION'));
      assert.equal((await writer.query('select 1 as alive')).rows[0]!.alive, 1); }
    finally { await writer.end(); }
  }
  assert.deepEqual(await fullAcl(), baseline); await assert.rejects(() => stat(join(files, 'target.json')), { code: 'ENOENT' });
});

test('a CONNECT-authorized startup whose datid is not published refuses the target', async () => {
  const baseline = await fullAcl(); const observer = await connect(ADMIN_DATABASE_URL);
  const writer = new Client({ connectionString: database.appUrl, application_name: 'restore-delayed-startup',
    options: '-c post_auth_delay=3', connectionTimeoutMillis: 10000 });
  clients.push(writer); writer.on('error', () => {});
  const startup = writer.connect(); void startup.catch(() => {});
  try {
    await waitFor(async () => (await observer.query(`select a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name='restore-delayed-startup' and a.datid is null and l.locktype='object'
        and l.classid='pg_database'::regclass and l.objid=(select oid from pg_database where datname=$1)`, [database.name])).rows.length === 1);
    await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_OTHER_CONNECTION'));
  } finally { await startup; await writer.end(); }
  assert.deepEqual(await fullAcl(), baseline);
});

test('a real prepared transaction with no user schema remains a blocker after disconnect', async () => {
  const gid = `restore_${randomUUID().replaceAll('-', '')}`;
  const writer = await connect(database.migrationUrl);
  await writer.query('begin'); await writer.query('select pg_current_xact_id()');
  await writer.query(`prepare transaction '${gid}'`); await writer.end();
  try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_PREPARED_TRANSACTION')); }
  finally { await query(`rollback prepared '${gid}'`); }
  assert.equal(await appAllowed(), true);
});

test('busy original DDL locks refuse within a bound without leaking an earlier lock', async () => {
  for (const namespace of [MIGRATION_LOCK_NAMESPACE, GRAPH_INSTALL_LOCK]) {
    const blocker = await connect(database.migrationUrl);
    await blocker.query('select pg_advisory_lock(hashtextextended($1,0))', [namespace]);
    const started = Date.now();
    try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_LOCK_BUSY'));
      assert.ok(Date.now() - started < 10000); }
    finally { await blocker.end(); }
    const observer = await connect(ADMIN_DATABASE_URL);
    assert.equal((await observer.query(`select count(*)::int as count from pg_locks where locktype='advisory'
      and database=(select oid from pg_database where datname=$1)`, [database.name])).rows[0]!.count, 0);
  }
  assert.equal(await appAllowed(), true); await assert.rejects(() => stat(join(files, 'target.json')), { code: 'ENOENT' });
});

test('a real original session lock lost after CONNECT COMMIT is not silently reacquired', async () => {
  const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
  let injected = false;
  const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
    const result = await originalQuery.call(this, text, values);
    if (!injected && text === 'select pg_backend_pid() as pid') {
      injected = true;
      const unlocked = await originalQuery.call(this, 'select pg_advisory_unlock(hashtextextended($1,0)) as unlocked', [MIGRATION_LOCK_NAMESPACE]);
      assert.equal(unlocked.rows[0]!.unlocked, true);
    }
    return result;
  });
  try { await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_LOCK_LOST')); }
  finally { hook.mock.restore(); }
  assert.equal(injected, true); await deniedApp();
  decodeRestoreDatabaseIsolationJournal(await readFile(join(files, 'target.json')));
});

test('unsafe role flags, membership and unsupported ACL grants refuse without normalization', async () => {
  const admin = await connect(ADMIN_DATABASE_URL);
  for (const [change, undo, code] of [
    ['alter role relay_app createdb', 'alter role relay_app nocreatedb', 'RESTORE_DATABASE_UNSAFE_ROLE'],
    ['grant relay_migrator to relay_app', 'revoke relay_migrator from relay_app', 'RESTORE_DATABASE_UNSAFE_ROLE'],
    [`grant connect on database "${database.name}" to pg_monitor`, `revoke connect on database "${database.name}" from pg_monitor`, 'RESTORE_DATABASE_UNSUPPORTED_ACL'],
  ] as const) {
    await admin.query(change);
    try { const baseline = await fullAcl(); await assert.rejects(() => hold(), refusal(code));
      assert.deepEqual(await fullAcl(), baseline); }
    finally { await admin.query(undo); }
  }
});

test('in-flight trusted restore may add objects; full ACL and role drift still invalidate the holder', async () => {
  const session = await hold(); const writer = await connect(database.migrationUrl, 'controlled-restore-writer');
  await writer.query('create table public.restored(id integer)');
  await session.assertHeld(); // No empty-schema or quiescent rule during the actual restore.
  await assert.rejects(session.assertQuiescent, refusal('RESTORE_DATABASE_OTHER_CONNECTION'));
  await writer.end(); await session.assertQuiescent();
  await query(`revoke temporary on database "${database.name}" from PUBLIC`);
  await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_ACL_DRIFT'));
  assert.equal(session.isHeld(), false); await session.close(); await deniedApp();
});

test('post-admission role drift is rejected even while the complete ACL remains unchanged', async () => {
  const session = await hold(); const admin = await connect(ADMIN_DATABASE_URL);
  await admin.query('alter role relay_app createdb');
  try { await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_UNSAFE_ROLE')); assert.equal(session.isHeld(), false); }
  finally { await admin.query('alter role relay_app nocreatedb'); }
  await session.close(); await deniedApp();
});

test('existing/linked journal paths refuse; byte-identical replacement invalidates held evidence; old recovery rejects its purpose', async () => {
  const path = join(files, 'target.json'); await writeFile(path, 'retained evidence');
  const baseline = await fullAcl();
  await assert.rejects(() => hold(), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
  assert.equal(await readFile(path, 'utf8'), 'retained evidence'); assert.deepEqual(await fullAcl(), baseline);
  const linkedParent = join(files, 'linked'); await symlink(files, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => holdRestoreDatabaseIsolation({ ...input(), journalFile: join(linkedParent, 'linked.json') }), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
  await rm(linkedParent); await rm(path);
  const session = await hold(); const saved = await readFile(path);
  await assert.rejects(() => recoverDatabaseConnectFence(database.migrationUrl, path), (cause: unknown) =>
    cause instanceof DatabaseConnectFenceError && cause.code === 'DATABASE_FENCE_JOURNAL_INVALID');
  await link(path, join(files, 'hard-linked.json'));
  await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_JOURNAL_CHANGED'));
  await session.close(); await rm(join(files, 'hard-linked.json'));
  const another = await hold('replacement.json'); const replacePath = join(files, 'replacement.json');
  const exact = await readFile(replacePath); await rename(replacePath, join(files, 'retained-original.json')); await writeFile(replacePath, exact);
  await assert.rejects(another.assertHeld, refusal('RESTORE_DATABASE_JOURNAL_CHANGED'));
  await another.close(); await deniedApp(); assert.deepEqual(await readFile(path), saved);
});

test('verified maintenance backend loss and post-admission cancellation retain committed CONNECT refusal', async () => {
  const session = await hold(); const admin = await connect(ADMIN_DATABASE_URL);
  const terminated = await admin.query(`select pg_terminate_backend(pid,5000) as stopped from pg_stat_activity
    where pid=$1 and datname=$2 and usename='relay_migrator' and application_name='relay-restore-database-isolation'`, [session.backendPid, database.name]);
  assert.equal(terminated.rows[0]!.stopped, true); await closed(session);
  assert.equal(session.isHeld(), false); await assert.rejects(session.assertHeld, refusal('RESTORE_DATABASE_CONNECTION_LOST'));
  await session.close(); await deniedApp();
  const controller = new AbortController(); const next = await hold('aborted.json', controller.signal); controller.abort();
  await closed(next); await next.close(); assert.equal(next.isHeld(), false); await deniedApp();
});

test('pre-aborted entry, abort before COMMIT, and lost COMMIT acknowledgement never compensate either target ACL', async () => {
  const aborted = new AbortController(); aborted.abort(); const baseline = await fullAcl();
  await assert.rejects(() => hold('pre-aborted.json', aborted.signal), refusal('RESTORE_DATABASE_ABORTED'));
  assert.deepEqual(await fullAcl(), baseline); await assert.rejects(() => stat(join(files, 'pre-aborted.json')), { code: 'ENOENT' });
  for (const stage of ['before-commit', 'unknown-commit', 'after-commit'] as const) {
    const controller = new AbortController(); let injected = false;
    const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
    const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
      const result = await originalQuery.call(this, text, values);
      if (!injected && (stage === 'before-commit' ? text.startsWith('revoke connect on database') : text === 'commit')) {
        injected = true;
        if (stage === 'unknown-commit') throw new Error('raw driver error must not expose a postgresql://credential');
        controller.abort();
      }
      return result;
    });
    try { await assert.rejects(() => hold(stage + '.json', controller.signal),
      refusal(stage === 'unknown-commit' ? 'RESTORE_DATABASE_UNAVAILABLE' : 'RESTORE_DATABASE_ABORTED')); }
    finally { hook.mock.restore(); }
    assert.equal(injected, true); decodeRestoreDatabaseIsolationJournal(await readFile(join(files, stage + '.json')));
    assert.equal(await appAllowed(), stage === 'before-commit');
    if (stage !== 'before-commit') await deniedApp();
  }
});
