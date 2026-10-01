import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';

import { changeAdmission } from '../../src/application/runtime-maintenance.js';
import { GRAPH_INSTALL_LOCK, installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { MIGRATION_LOCK_NAMESPACE, runMigrations } from '../../src/infrastructure/migration-runner.js';
import { postgresErrorCode } from '../../src/infrastructure/postgres-error.js';
import { DatabaseConnectFenceError, holdDatabaseConnectFence, recoverDatabaseConnectFence,
  type DatabaseConnectFence } from '../../src/runtime/database-connect-fence.js';
import { ADMIN_DATABASE_URL, createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase } from './integration-support.js';

const workspace = resolve(MIGRATIONS_DIRECTORY, '../../..');
const cli = resolve(MIGRATIONS_DIRECTORY, '../dist/src/cli/database-connect-fence.js');
const runFile = promisify(execFile);
let database: TemporaryDatabase;
let files: string;
let clients: Client[];
let sessions: DatabaseConnectFence[];
let children: ChildProcess[];
const refusal = (code: string) => (cause: unknown) => cause instanceof DatabaseConnectFenceError && cause.code === code;

async function connect(url: string, name = 'relay-fence-test'): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: name, connectionTimeoutMillis: 5000, query_timeout: 6000 });
  clients.push(client); client.on('error', () => {});
  await client.connect(); return client;
}
async function query<T extends import('pg').QueryResultRow>(text: string): Promise<T[]> {
  const client = await connect(database.migrationUrl);
  try { return (await client.query<T>(text)).rows; } finally { await client.end(); }
}
async function fullAcl(): Promise<unknown[]> {
  return query(`select a.grantee::text, a.grantor::text, a.privilege_type, a.is_grantable
    from pg_database d, lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    where d.datname=current_database() order by a.grantee,a.grantor,a.privilege_type`);
}
async function effectiveAppConnect(): Promise<boolean> {
  return (await query<{ allowed: boolean }>("select has_database_privilege('relay_app',current_database(),'CONNECT') as allowed"))[0]!.allowed;
}
async function deniedApp(): Promise<void> {
  const client = new Client({ connectionString: database.appUrl, connectionTimeoutMillis: 5000 });
  try { await assert.rejects(() => client.connect(), e => postgresErrorCode(e) === '42501'); }
  finally { await client.end(); }
}
async function hold(name = 'original.json'): Promise<DatabaseConnectFence> {
  const session = await holdDatabaseConnectFence(database.migrationUrl, join(files, name));
  sessions.push(session); return session;
}
async function waitFor(work: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await work()) { assert.ok(Date.now() < deadline, 'observed state did not arrive'); await delay(20); }
}
beforeEach(async () => {
  clients = []; sessions = []; children = [];
  database = await createTemporaryDatabase('fence'); files = await mkdtemp(join(tmpdir(), 'relay-connect-fence-'));
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(database.migrationUrl);
  const app = openDatabase(database.appUrl, 'relay-fence-drain');
  try { await changeAdmission(app.db, { action: 'begin-drain', commandId: randomUUID(), expectedRevision: '0' }); }
  finally { await app.close(); }
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(r => child.once('close', () => r())); child.kill();
    await Promise.race([closed, delay(10000).then(() => { throw new Error('owned CLI failed to close'); })]);
  }
  await Promise.allSettled(sessions.filter(s => s.isHeld()).map(s => s.release()));
  await Promise.allSettled(clients.map(c => c.end()));
  if (database !== undefined) await database.drop();
  if (files !== undefined) await rm(files, { recursive: true, force: true });
});

test('production fence commits new-connection refusal, supports migrator dump, and exactly restores grant option', async () => {
  await query(`grant connect on database "${database.name}" to relay_app with grant option`);
  const baseline = await fullAcl(); const session = await hold();
  assert.equal(session.isHeld(), true); await session.assertQuiescent();
  const evidence = await readFile(join(files, 'original.json'));
  assert.equal(await effectiveAppConnect(), false); await deniedApp();
  const url = new URL(database.migrationUrl);
  const dump = join(files, 'database.dump');
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port, PGUSER: decodeURIComponent(url.username),
    PGDATABASE: database.name, PGCONNECT_TIMEOUT: '5' };
  try { await runFile(join(workspace, '.research/runtime-cache/postgresql-18.6-2/pgsql/bin/pg_dump.exe'),
    ['--no-password', '--format=custom', '--file', dump], { env, timeout: 20000 }); }
  catch { throw new Error('isolated migrator dump failed'); }
  assert.ok((await stat(dump)).size > 0); await session.assertQuiescent();
  await session.release(); assert.equal(session.isHeld(), false);
  assert.deepEqual(await fullAcl(), baseline);
  assert.deepEqual(await readFile(join(files, 'original.json')), evidence, 'evidence is never rewritten');
  assert.equal((await query<{ mode: string; revision: string }>('select mode,revision::text from runtime_admission_gate'))[0]?.mode, 'DRAINING');
  const app = await connect(database.appUrl); await app.end();
  assert.deepEqual(await recoverDatabaseConnectFence(database.migrationUrl, join(files, 'original.json')),
    { operationId: session.operationId, changed: false });
});

test('dirty PG environment cannot redirect explicit maintenance URLs or make the fence read-only', async () => {
  const baseline = await fullAcl();
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
  const evidence = await readFile(join(files, 'original.json'));
  await product(() => session.assertQuiescent());
  await deniedApp(); assert.equal(await effectiveAppConnect(), false);
  await product(() => session.release());
  assert.deepEqual(await fullAcl(), baseline);
  assert.deepEqual(await product(() => recoverDatabaseConnectFence(database.migrationUrl, join(files, 'original.json'))),
    { operationId: session.operationId, changed: false });
  assert.deepEqual(await readFile(join(files, 'original.json')), evidence);
  const app = await connect(database.appUrl); await app.end();
});

test('explicit URL read-only options remain effective instead of being replaced by maintenance defaults', async () => {
  const baseline = await fullAcl(); const url = new URL(database.migrationUrl);
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  await assert.rejects(() => holdDatabaseConnectFence(url.toString(), join(files, 'readonly.json')),
    refusal('DATABASE_FENCE_UNAVAILABLE'));
  assert.deepEqual(await fullAcl(), baseline); assert.equal(await effectiveAppConnect(), true);
});

test('NORMAL or an existing idle application/Saver/migrator connection refuses before any journal or ACL change', async () => {
  const baseline = await fullAcl();
  const app = openDatabase(database.appUrl, 'relay-fence-resume');
  try { await changeAdmission(app.db, { action: 'resume-admission', commandId: randomUUID(), expectedRevision: '1' }); }
  finally { await app.close(); }
  await assert.rejects(() => hold(), refusal('DATABASE_FENCE_DRAIN_REQUIRED'));
  await assert.rejects(() => stat(join(files, 'original.json')), { code: 'ENOENT' });
  const drained = openDatabase(database.appUrl, 'relay-fence-redrain');
  try { await changeAdmission(drained.db, { action: 'begin-drain', commandId: randomUUID(), expectedRevision: '2' }); }
  finally { await drained.close(); }
  for (const [url, name] of [[database.appUrl, 'relay-old-api'], [database.appUrl, 'relay-old-saver'], [database.migrationUrl, 'unknown-owner']]) {
    const writer = await connect(url!, name);
    try {
      await writer.query('select 1');
      await assert.rejects(() => hold(), refusal('DATABASE_FENCE_OTHER_CONNECTION'));
      assert.equal((await writer.query('select 1 as alive')).rows[0]?.alive, 1, 'unknown writers are never killed');
      assert.deepEqual(await fullAcl(), baseline);
      await assert.rejects(() => stat(join(files, 'original.json')), { code: 'ENOENT' });
    } finally { await writer.end(); }
  }
  await (await hold()).release();
});

test('a real prepared transaction remains a blocker after its client has disconnected', async () => {
  const app = await connect(database.appUrl); const gid = `relay_fence_${randomUUID().replaceAll('-', '')}`;
  try {
    await app.query('begin'); await app.query('insert into workspaces (id,name) values ($1,$2)', [randomUUID(), 'prepared writer']);
    await app.query(`prepare transaction '${gid}'`); await app.end();
    const baseline = await fullAcl();
    await assert.rejects(() => hold(), refusal('DATABASE_FENCE_PREPARED_TRANSACTION'));
    assert.deepEqual(await fullAcl(), baseline);
    await assert.rejects(() => stat(join(files, 'original.json')), { code: 'ENOENT' });
  } finally {
    const rollback = await connect(database.appUrl);
    try { await rollback.query(`rollback prepared '${gid}'`); } finally { await rollback.end(); }
  }
  await (await hold()).release();
});

test('a connection past CONNECT authorization but still in startup is also a blocker', async () => {
  const baseline = await fullAcl();
  const observer = await connect(ADMIN_DATABASE_URL, 'relay-fence-startup-observer');
  const writer = new Client({ connectionString: database.appUrl, application_name: 'relay-fence-delayed-startup',
    options: '-c post_auth_delay=3', connectionTimeoutMillis: 10000 });
  clients.push(writer); writer.on('error', () => {});
  const startup = writer.connect(); void startup.catch(() => {});
  try {
    // The startup packet's application_name is applied after CONNECT, before post_auth_delay.
    // Observe both the name and the target object lock while datid is not published.
    await waitFor(async () => (await observer.query(`select a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.application_name='relay-fence-delayed-startup' and a.datid is null and l.locktype='object'
        and l.classid='pg_database'::regclass and l.objid=(select oid from pg_database where datname=$1)`, [database.name])).rows.length === 1);
    await assert.rejects(() => hold(), refusal('DATABASE_FENCE_OTHER_CONNECTION'));
  } finally { await startup; }
  await writer.query('insert into workspaces(id,name) values ($1,$2)', [randomUUID(), 'already authorized startup writer']);
  await writer.end();
  assert.deepEqual(await fullAcl(), baseline);
  await assert.rejects(() => stat(join(files, 'original.json')), { code: 'ENOENT' });
});

test('both original DDL entrypoints wait on production session locks across CONNECT COMMIT', async () => {
  const session = await hold();
  const observer = await connect(ADMIN_DATABASE_URL, 'relay-fence-lock-observer');
  let businessDone = false; let graphDone = false;
  const business = runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY }).finally(() => { businessDone = true; });
  const graph = installGraphCheckpoints(database.migrationUrl).finally(() => { graphDone = true; });
  try {
    await waitFor(async () => (await observer.query(`select pid from pg_stat_activity where datname=$1
      and application_name in ('relay-migrator','relay-graph-installer') and wait_event='advisory'
      and $2=any(pg_blocking_pids(pid))`, [database.name, session.backendPid])).rows.length === 2);
    assert.equal(businessDone, false); assert.equal(graphDone, false);
    await assert.rejects(() => session.assertQuiescent(), refusal('DATABASE_FENCE_OTHER_CONNECTION'));
  } finally { await session.release(); await Promise.all([business, graph]); }
  assert.equal(businessDone, true); assert.equal(graphDone, true);
});

test('busy business/Graph locks fail within a bound and do not leak a partial lock or change ACL', async () => {
  const baseline = await fullAcl();
  for (const name of [MIGRATION_LOCK_NAMESPACE, GRAPH_INSTALL_LOCK]) {
    const blocker = await connect(database.migrationUrl);
    await blocker.query('select pg_advisory_lock(hashtextextended($1,0))', [name]);
    try { await assert.rejects(() => hold(), refusal('DATABASE_FENCE_LOCK_BUSY')); }
    finally { await blocker.end(); }
    assert.deepEqual(await fullAcl(), baseline);
    await assert.rejects(() => stat(join(files, 'original.json')), { code: 'ENOENT' });
  }
  await (await hold()).release();
});

test('role membership, elevated role flags and unsupported CONNECT grant refuse without changing ACL', async () => {
  const admin = await connect(ADMIN_DATABASE_URL, 'relay-fence-controlled-role-drift');
  const baseline = await fullAcl();
  try {
    await admin.query('grant relay_migrator to relay_app with inherit true, set false');
    await assert.rejects(() => hold(), refusal('DATABASE_FENCE_UNSAFE_ROLE'));
    await admin.query('revoke relay_migrator from relay_app');
    await admin.query('alter role relay_app createdb');
    await assert.rejects(() => hold(), refusal('DATABASE_FENCE_UNSAFE_ROLE'));
  } finally { await admin.query('revoke relay_migrator from relay_app'); await admin.query('alter role relay_app nocreatedb'); }
  assert.deepEqual(await fullAcl(), baseline);
  await query(`grant connect on database "${database.name}" to relay_api_admin`);
  await assert.rejects(() => hold(), refusal('DATABASE_FENCE_UNSUPPORTED_ACL'));
  await query(`revoke connect on database "${database.name}" from relay_api_admin`);
  assert.deepEqual(await fullAcl(), baseline);
  await assert.rejects(() => stat(join(files, 'original.json')), { code: 'ENOENT' });
});

test('an existing journal or linked parent refuses before ACL mutation; linked/corrupt/wrong-target recovery refuses', async () => {
  const path = join(files, 'original.json'); const baseline = await fullAcl();
  await writeFile(path, 'preserve existing evidence');
  await assert.rejects(() => hold()); assert.equal(await readFile(path, 'utf8'), 'preserve existing evidence');
  assert.deepEqual(await fullAcl(), baseline); await rm(path);
  const directory = join(files, 'redirect');
  await symlink(files, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => holdDatabaseConnectFence(database.migrationUrl, join(directory, 'unexpected.json')),
    refusal('DATABASE_FENCE_JOURNAL_INVALID'));
  assert.deepEqual(await fullAcl(), baseline);
  await rm(directory);
  const session = await hold(); await session.release();
  const hardlink = join(files, 'link.json'); await link(path, hardlink);
  await assert.rejects(() => recoverDatabaseConnectFence(database.migrationUrl, path), refusal('DATABASE_FENCE_JOURNAL_INVALID'));
  await rm(hardlink);
  const bytes = await readFile(path); await writeFile(join(files, 'corrupt.json'), bytes.toString().replace('relay-database', 'wrong-database'));
  await assert.rejects(() => recoverDatabaseConnectFence(database.migrationUrl, join(files, 'corrupt.json')), refusal('DATABASE_FENCE_JOURNAL_INVALID'));
  const other = await createTemporaryDatabase('fence_other');
  try {
    await runMigrations({ connectionString: other.migrationUrl, directory: MIGRATIONS_DIRECTORY }); await installGraphCheckpoints(other.migrationUrl);
    await assert.rejects(() => recoverDatabaseConnectFence(other.migrationUrl, path), refusal('DATABASE_FENCE_TARGET_MISMATCH'));
  } finally { await other.drop(); }
  assert.deepEqual(await fullAcl(), baseline);
});

test('ACL drift invalidates the holder and explicit recovery refuses to overwrite it', async () => {
  const baseline = await fullAcl(); const session = await hold();
  await query(`grant temporary on database "${database.name}" to relay_app`);
  await assert.rejects(() => session.assertQuiescent(), refusal('DATABASE_FENCE_ACL_DRIFT'));
  await assert.rejects(() => session.release(), refusal('DATABASE_FENCE_ACL_DRIFT'));
  assert.equal(session.isHeld(), false); assert.equal(await effectiveAppConnect(), false);
  const drifted = await fullAcl();
  await assert.rejects(() => recoverDatabaseConnectFence(database.migrationUrl, join(files, 'original.json')), refusal('DATABASE_FENCE_ACL_DRIFT'));
  assert.deepEqual(await fullAcl(), drifted);
  await query(`revoke temporary on database "${database.name}" from relay_app`);
  assert.equal((await recoverDatabaseConnectFence(database.migrationUrl, join(files, 'original.json'))).changed, true);
  assert.deepEqual(await fullAcl(), baseline);
});

test('pre-mutation ACL drift or journal write failure never restores a revoke owned by another session', async () => {
  for (const stage of ['journal-failure', 'pre-revoke-drift']) {
    const baseline = await fullAcl();
    const path = join(files, `${stage}.json`);
    if (stage === 'journal-failure') await writeFile(path, 'old evidence');
    const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
    let injected = false;
    // Timing control only: every SQL statement still runs on this real private PG cluster.
    const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
      const result = await originalQuery.call(this, text, values);
      if (!injected && (stage === 'journal-failure' ? text.includes('aclexplode') : text === 'begin')) {
        injected = true;
        const external = await connect(database.migrationUrl, 'relay-fence-controlled-acl-race');
        try { await originalQuery.call(external, `revoke connect on database "${database.name}" from PUBLIC, relay_app`); }
        finally { await external.end(); }
      }
      return result;
    });
    try {
      await assert.rejects(() => holdDatabaseConnectFence(database.migrationUrl, path),
        refusal(stage === 'journal-failure' ? 'DATABASE_FENCE_UNAVAILABLE' : 'DATABASE_FENCE_ACL_DRIFT'));
    } finally { hook.mock.restore(); }
    assert.equal(injected, true);
    assert.equal(await effectiveAppConnect(), false, 'another session owns this revoke');
    // Fixture cleanup uses the exact baseline evidence, after the production refusal was verified.
    for (const grant of baseline as { grantee: string; privilege_type: string; is_grantable: boolean }[]) {
      if (grant.grantee === '0' && grant.privilege_type === 'CONNECT') await query(`grant connect on database "${database.name}" to PUBLIC`);
    }
    assert.deepEqual(await fullAcl(), baseline);
  }
});

test('verified maintenance backend loss preserves committed fence and journal for idempotent recovery', async () => {
  const baseline = await fullAcl(); const session = await hold(); const bytes = await readFile(join(files, 'original.json'));
  const admin = await connect(ADMIN_DATABASE_URL, 'relay-fence-controlled-disconnect');
  const terminated = await admin.query(`select pg_terminate_backend(pid,5000) as terminated from pg_stat_activity
    where datname=$1 and pid=$2 and usename='relay_migrator' and application_name='relay-database-connect-fence'`,
    [database.name, session.backendPid]);
  assert.equal(terminated.rows[0]?.terminated, true);
  await Promise.race([session.closed, delay(10000).then(() => { throw new Error('holder missed connection loss'); })]);
  assert.equal(session.isHeld(), false);
  await assert.rejects(() => session.assertQuiescent(), refusal('DATABASE_FENCE_CONNECTION_LOST'));
  await assert.rejects(() => session.release(), refusal('DATABASE_FENCE_CONNECTION_LOST'));
  assert.equal(await effectiveAppConnect(), false); await deniedApp();
  assert.deepEqual(await readFile(join(files, 'original.json')), bytes);
  assert.equal((await recoverDatabaseConnectFence(database.migrationUrl, join(files, 'original.json'))).changed, true);
  assert.equal((await recoverDatabaseConnectFence(database.migrationUrl, join(files, 'original.json'))).changed, false);
  assert.deepEqual(await fullAcl(), baseline);
});

function startCli(journalFile: string): { child: ChildProcess; closed: Promise<number | null>; lines: unknown[]; stderr: () => string } {
  const child = spawn(process.execPath, [cli, 'hold-database-connect-fence', '--journal-file', journalFile],
    { env: { ...process.env, RELAY_MIGRATION_DB_URL: database.migrationUrl }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(child); let stdout = ''; let stderr = ''; const lines: unknown[] = [];
  child.stdout!.on('data', chunk => { stdout += String(chunk); let newline;
    while ((newline = stdout.indexOf('\n')) !== -1) { lines.push(JSON.parse(stdout.slice(0,newline))); stdout = stdout.slice(newline+1); }
  });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<number | null>((r,j) => { child.once('close', r); child.once('error', j); });
  return { child, closed, lines, stderr: () => stderr };
}
async function cliHeld(cli: ReturnType<typeof startCli>): Promise<void> {
  await waitFor(async () => cli.lines.length > 0);
  const ready = cli.lines[0] as { type: string; scope: string; frozen: boolean };
  assert.equal(ready.type, 'database_connect_fence_held'); assert.equal(ready.scope, 'DATABASE_CONNECTION_ADMISSION_ONLY'); assert.equal(ready.frozen, false);
}
async function cliExit(cli: ReturnType<typeof startCli>): Promise<number | null> {
  return Promise.race([cli.closed, delay(10000).then(() => { throw new Error('owned CLI did not exit'); })]);
}
test('actual CLI exact release and EOF restore ACL; bad or oversized release never reports successful release', async () => {
  const baseline = await fullAcl();
  for (const [index, input] of ['release\n', '', 'release\nextra', 'release\n' + 'x'.repeat(256)].entries()) {
    const cli = startCli(join(files, `cli-${index}.json`)); await cliHeld(cli);
    cli.child.stdin!.end(input); const exit = await cliExit(cli);
    assert.equal(exit, index < 2 ? 0 : 2);
    assert.deepEqual(await fullAcl(), baseline);
    const types = cli.lines.map(line => (line as { type: string }).type);
    assert.equal(types.includes('database_connect_fence_released'), index < 2);
    assert.equal(cli.stderr(), index < 2 ? '' : '{"code":"CONFIGURATION_ERROR"}\n');
  }
});

test('hard-killed actual CLI leaves durable evidence and requires explicit ACL recovery', async () => {
  const baseline = await fullAcl(); const path = join(files, 'crash.json'); const cli = startCli(path);
  await cliHeld(cli); const bytes = await readFile(path);
  cli.child.kill('SIGKILL'); assert.notEqual(await cliExit(cli), 0);
  const observer = await connect(ADMIN_DATABASE_URL, 'relay-fence-child-exit-observer');
  await waitFor(async () => (await observer.query(`select pid from pg_stat_activity where datname=$1
    and application_name='relay-database-connect-fence'`, [database.name])).rows.length === 0);
  assert.equal(await effectiveAppConnect(), false); await deniedApp();
  assert.equal(cli.lines.length, 1); assert.deepEqual(await readFile(path), bytes);
  assert.equal((await recoverDatabaseConnectFence(database.migrationUrl, path)).changed, true);
  assert.deepEqual(await fullAcl(), baseline);
});

test('invalid input sent before READY is handled and still restores the committed ACL', async () => {
  const baseline = await fullAcl(); const cli = startCli(join(files, 'early-invalid.json'));
  cli.child.stdin!.end('bad\n');
  assert.equal(await cliExit(cli), 2);
  assert.deepEqual(await fullAcl(), baseline);
  assert.equal(cli.stderr(), '{"code":"CONFIGURATION_ERROR"}\n');
  assert.equal(cli.lines.some(line => (line as { type: string }).type === 'database_connect_fence_released'), false);
});
