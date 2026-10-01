import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { promisify } from 'node:util';
import { Client } from 'pg';

import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { MIGRATION_LOCK_NAMESPACE, runMigrations } from '../../src/infrastructure/migration-runner.js';
import { postgresErrorCode } from '../../src/infrastructure/postgres-error.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, type TemporaryDatabase } from './integration-support.js';
import { delay } from './api-harness.js';

/** Mechanism probes only: no production freeze coordinator, durable recovery Owner or backup protocol exists here. */
const GRAPH_INSTALL_LOCK = 'relay:graph-checkpoints:v1'; // Exact private constant, read from the existing installer.
const workspaceRoot = resolve(MIGRATIONS_DIRECTORY, '../../..');
const postgresBin = join(workspaceRoot, '.research/runtime-cache/postgresql-18.6-2/pgsql/bin');
const runFile = promisify(execFile);
let database: TemporaryDatabase;
let files: string;
let clients: Client[];

class ProbeRefusal extends Error { override readonly name = 'ProbeRefusal'; }
function identifier(value: string): string {
  if (!/^relay_api_test_[a-z0-9_]+$/u.test(value)) throw new ProbeRefusal('not an isolated runner database');
  return `"${value}"`;
}
async function connect(url: string, name: string): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: name,
    connectionTimeoutMillis: 5000, query_timeout: 5000 });
  clients.push(client);
  client.on('error', () => {}); // Expected termination is asserted via SQLSTATE/verified observer, never its raw message.
  await client.connect(); return client;
}
beforeEach(async () => {
  clients = [];
  database = await createTemporaryDatabase('maintenance_boundary');
  files = await mkdtemp(join(tmpdir(), 'relay-db-boundary-probe-'));
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(database.migrationUrl);
});
afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.end()));
  if (database !== undefined) await database.drop();
  if (files !== undefined) await rm(files, { recursive: true, force: true });
});

async function requireStandardRoles(owner: Client): Promise<void> {
  const identity = await owner.query<{ current_user: string; owner: string; database: string }>(`
    select current_user, pg_get_userbyid(datdba) as owner, datname as database
    from pg_database where datname = current_database()`);
  const roles = await owner.query<{ rolname: string; safe: boolean }>(`
    select rolname, rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolreplication and not rolbypassrls as safe
    from pg_roles where rolname in ('relay_app', 'relay_migrator') order by rolname`);
  const membership = await owner.query<{ drifted: boolean }>(`select exists (
    select 1 from pg_roles where rolname <> 'relay_app' and pg_has_role('relay_app', oid, 'MEMBER')) as drifted`);
  if (identity.rows[0]?.current_user !== 'relay_migrator' || identity.rows[0]?.owner !== 'relay_migrator' ||
      identity.rows[0]?.database !== database.name || roles.rows.length !== 2 ||
      roles.rows.some((role) => !role.safe) || membership.rows[0]?.drifted !== false) {
    throw new ProbeRefusal('maintenance role/ownership/membership is not standard');
  }
}
interface ConnectGrant { readonly grantee: string; readonly grantor: string; readonly grantable: boolean }
async function connectAcl(client: Client): Promise<ConnectGrant[]> {
  const result = await client.query<ConnectGrant>(`select
    case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
    pg_get_userbyid(a.grantor) as grantor, a.is_grantable as grantable
    from pg_database d, lateral aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
    where d.datname = current_database() and a.privilege_type = 'CONNECT' order by grantee, grantor`);
  return result.rows;
}
async function blocked(client: Client): Promise<boolean> {
  return (await client.query<{ blocked: boolean }>(
    `select not has_database_privilege('relay_app', current_database(), 'CONNECT') as blocked`)).rows[0]?.blocked === true;
}
async function revoke(owner: Client): Promise<void> {
  await requireStandardRoles(owner);
  await owner.query('begin');
  try {
    await owner.query(`revoke connect on database ${identifier(database.name)} from PUBLIC, relay_app`);
    if (!(await blocked(owner))) throw new ProbeRefusal('CONNECT still inherited or independently granted');
    await owner.query('commit');
  } catch (error) { await owner.query('rollback'); throw error; }
}
async function restore(owner: Client, grants: readonly ConnectGrant[]): Promise<void> {
  await requireStandardRoles(owner);
  if (grants.some((grant) => grant.grantor !== 'relay_migrator' ||
      !['PUBLIC', 'relay_app', 'relay_migrator'].includes(grant.grantee))) {
    throw new ProbeRefusal('unsupported original CONNECT ACL grantor/grantee');
  }
  await owner.query('begin');
  try {
    await owner.query(`revoke connect on database ${identifier(database.name)} from PUBLIC, relay_app`);
    for (const grant of grants.filter((grant) => grant.grantee !== 'relay_migrator')) {
      const grantee = grant.grantee === 'PUBLIC' ? 'PUBLIC' : 'relay_app';
      await owner.query(`grant connect on database ${identifier(database.name)} to ${grantee}${grant.grantable ? ' with grant option' : ''}`);
    }
    assert.deepEqual(await connectAcl(owner), grants);
    await owner.query('commit');
  } catch (error) { await owner.query('rollback'); throw error; }
}
async function deniedNewApp(): Promise<void> {
  const denied = new Client({ connectionString: database.appUrl, connectionTimeoutMillis: 5000 });
  try { await assert.rejects(() => denied.connect(), (error: unknown) => postgresErrorCode(error) === '42501'); }
  finally { await denied.end(); }
}
async function postgresTool(tool: 'pg_dump' | 'pg_restore', url: string, args: readonly string[]): Promise<string> {
  const connection = new URL(url);
  const env = { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port,
    PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)), PGCONNECT_TIMEOUT: '5' };
  try {
    return (await runFile(join(postgresBin, `${tool}${process.platform === 'win32' ? '.exe' : ''}`),
      ['--no-password', ...args], { env, timeout: 20_000, maxBuffer: 512 * 1024 })).stdout;
  } catch { throw new Error(`${tool} mechanism probe failed`); } // Never expose exec/driver errors containing connection configuration.
}

test('mechanism probe: committed CONNECT revoke preserves existing app writes and permits full migrator dump/restore', async () => {
  const owner = await connect(database.migrationUrl, 'relay-boundary-owner');
  const oldApp = await connect(database.appUrl, 'relay-boundary-old-app');
  await requireStandardRoles(owner);
  const original = await connectAcl(owner);
  const id = randomUUID();
  await oldApp.query('insert into workspaces (id, name) values ($1, $2)', [id, 'before revoke']);
  try {
    await revoke(owner);
    assert.equal(await blocked(owner), true);
    await oldApp.query('update workspaces set name = $2 where id = $1', [id, 'old connection still writes']);
    await deniedNewApp();
    const newOwner = await connect(database.migrationUrl, 'relay-boundary-new-migrator');
    assert.equal(await blocked(newOwner), true);
    const dump = join(files, 'complete.dump');
    await postgresTool('pg_dump', database.migrationUrl, ['--format=custom', '--file', dump]);
    const catalog = await postgresTool('pg_restore', database.migrationUrl, ['--list', dump]);
    assert.match(catalog, /TABLE DATA public workspaces/u);
    assert.match(catalog, /TABLE DATA public relay_schema_migrations/u);
    assert.match(catalog, /TABLE DATA relay_graph_v1 checkpoints/u);
    const restored = await createTemporaryDatabase('boundary_restore');
    try {
      await postgresTool('pg_restore', restored.migrationUrl, ['--exit-on-error', '--dbname', restored.name, dump]);
      const reader = await connect(restored.migrationUrl, 'relay-boundary-restored-reader');
      assert.equal((await reader.query<{ name: string }>('select name from workspaces where id = $1', [id])).rows[0]?.name,
        'old connection still writes');
      assert.equal((await reader.query<{ count: string }>('select count(*)::text from relay_graph_v1.checkpoint_migrations')).rows[0]?.count, '5');
      assert.equal((await reader.query<{ count: string }>('select count(*)::text from relay_schema_migrations')).rows[0]?.count, '48');
      await reader.end();
    } finally { await restored.drop(); }
  } finally { await restore(owner, original); }
  assert.equal(await blocked(owner), false);
  await connect(database.appUrl, 'relay-boundary-restored-app');
});

test('mechanism probe: both original DDL entry points really wait on their existing advisory namespaces', async () => {
  const owner = await connect(database.migrationUrl, 'relay-boundary-advisory-owner');
  const observer = await connect(database.adminUrl, 'relay-boundary-advisory-observer');
  await requireStandardRoles(owner);
  const pid = (await owner.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
  await owner.query('begin');
  await owner.query('select pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAMESPACE]);
  await owner.query('select pg_advisory_lock(hashtextextended($1, 0))', [GRAPH_INSTALL_LOCK]);
  // A CONNECT fence commits before dump; its DDL session locks must survive that commit.
  await owner.query('commit');
  let businessDone = false; let graphDone = false;
  const business = runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY })
    .finally(() => { businessDone = true; });
  const graph = installGraphCheckpoints(database.migrationUrl).finally(() => { graphDone = true; });
  // Observe actual backend lock waits and blockers; elapsed sleeps never establish serialization.
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      const waiting = await observer.query<{ application_name: string }>(`select application_name
        from pg_stat_activity where datname = $1 and application_name in ('relay-migrator', 'relay-graph-installer')
          and wait_event_type = 'Lock' and wait_event = 'advisory' and $2 = any(pg_blocking_pids(pid))`, [database.name, pid]);
      if (waiting.rows.length === 2) break;
      assert.ok(Date.now() < deadline, 'both actual DDL callers must wait on the maintenance holder');
      await delay(20);
    }
    assert.equal(businessDone, false); assert.equal(graphDone, false);
  } finally {
    await owner.query('select pg_advisory_unlock(hashtextextended($1, 0))', [GRAPH_INSTALL_LOCK]);
    await owner.query('select pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAMESPACE]);
  }
  const [migration] = await Promise.all([business, graph]);
  assert.equal(migration.applied.length, 0); assert.equal(migration.ledgerRows, 48);
  assert.equal(businessDone, true); assert.equal(graphDone, true);
});

test('mechanism probe: bootstrap leaves membership/ACL drift; committed revoke survives maintenance loss and original ACL restores', async () => {
  const owner = await connect(database.migrationUrl, 'relay-boundary-crash-owner');
  const admin = await connect(database.adminUrl, 'relay-boundary-controlled-fault');
  const bootstrap = await readFile(join(workspaceRoot, 'apps/api/sql/bootstrap-roles.sql'), 'utf8');
  await requireStandardRoles(owner);
  const baseline = await connectAcl(owner);
  try {
    // Controlled drift uses the existing roles only, in this runner's private cluster.
    await admin.query('grant relay_migrator to relay_app with inherit true, set false');
    await admin.query(bootstrap);
    await assert.rejects(() => requireStandardRoles(owner), ProbeRefusal);
    await owner.query(`revoke connect on database ${identifier(database.name)} from PUBLIC, relay_app`);
    assert.equal(await blocked(owner), false, 'membership retains CONNECT despite direct/PUBLIC revoke');
    await connect(database.appUrl, 'relay-boundary-drifted-app');
  } finally {
    await admin.query('revoke relay_migrator from relay_app');
    await restore(owner, baseline);
  }
  await owner.query(`grant connect on database ${identifier(database.name)} to relay_app with grant option`);
  await admin.query(bootstrap);
  const original = await connectAcl(owner);
  assert.equal(original.find((grant) => grant.grantee === 'relay_app')?.grantable, true,
    'bootstrap does not converge an existing database ACL');
  const journal = join(files, 'original-connect-acl.json');
  const handle = await open(journal, 'wx');
  try { await handle.writeFile(JSON.stringify({ database: database.name, grants: original })); await handle.sync(); }
  finally { await handle.close(); }
  const pid = (await owner.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
  await revoke(owner);
  const verified = await admin.query<{ terminated: boolean }>(`select pg_terminate_backend(pid, 5000) as terminated
    from pg_stat_activity where pid = $1 and datname = $2 and usename = 'relay_migrator'
      and application_name = 'relay-boundary-crash-owner' and backend_type = 'client backend'`, [pid, database.name]);
  assert.equal(verified.rows[0]?.terminated, true);
  await assert.rejects(() => owner.query('select 1'));
  await admin.query(bootstrap);
  const recoveredOwner = await connect(database.migrationUrl, 'relay-boundary-recovery-owner');
  assert.equal(await blocked(recoveredOwner), true, 'committed revoke survives loss and bootstrap replay');
  await deniedNewApp();
  const saved = JSON.parse(await readFile(journal, 'utf8')) as { database: string; grants: ConnectGrant[] };
  assert.equal(saved.database, database.name);
  await restore(recoveredOwner, saved.grants);
  await connect(database.appUrl, 'relay-boundary-after-acl-restore');
  await requireStandardRoles(recoveredOwner);
  assert.equal((await recoveredOwner.query<{ allowed: boolean }>(
    `select pg_has_role('relay_app', 'pg_signal_backend', 'MEMBER') or
      pg_has_role('relay_migrator', 'pg_signal_backend', 'MEMBER') as allowed`)).rows[0]?.allowed, false);
});
