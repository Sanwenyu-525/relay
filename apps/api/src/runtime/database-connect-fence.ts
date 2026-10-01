import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

import { GRAPH_INSTALL_LOCK } from '../infrastructure/graph-checkpoints.js';
import { MIGRATION_LOCK_NAMESPACE } from '../infrastructure/migration-runner.js';
import { maintenanceConnectionOptions } from './maintenance-connection.js';

const LOCKS = [MIGRATION_LOCK_NAMESPACE, GRAPH_INSTALL_LOCK] as const;
const JOURNAL_VERSION = 'relay-database-connect-fence-v1';
const MAX_JOURNAL_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class DatabaseConnectFenceError extends Error {
  override readonly name = 'DatabaseConnectFenceError';
  constructor(readonly code: string = 'DATABASE_FENCE_UNAVAILABLE') { super(code); }
}

interface Grant {
  readonly grantee: string; readonly grantor: string;
  readonly privilege: 'CREATE' | 'CONNECT' | 'TEMPORARY'; readonly grantable: boolean;
}
interface Target {
  readonly database: string; readonly database_oid: string; readonly owner_oid: string;
  readonly app_oid: string; readonly server_address: string; readonly server_port: string;
}
interface Journal {
  readonly version: typeof JOURNAL_VERSION; readonly operation_id: string;
  readonly target: Target; readonly original_acl: readonly Grant[]; readonly fenced_acl: readonly Grant[];
}
const error = (code: string) => new DatabaseConnectFenceError(code);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalized(grants: readonly Grant[]): Grant[] {
  return grants.map(({ grantee, grantor, privilege, grantable }) => ({ grantee, grantor, privilege, grantable }))
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
}
const sameAcl = (a: readonly Grant[], b: readonly Grant[]) => digest(normalized(a)) === digest(normalized(b));
function fenced(grants: readonly Grant[], appOid: string): Grant[] {
  return normalized(grants.filter(g => g.privilege !== 'CONNECT' || (g.grantee !== '0' && g.grantee !== appOid)));
}

function validateAcl(grants: readonly Grant[], target: Target): void {
  if (grants.length > 128 || !grants.some(g => g.grantee === target.owner_oid && g.privilege === 'CONNECT')) {
    throw error('DATABASE_FENCE_UNSUPPORTED_ACL');
  }
  const seen = new Set<string>();
  for (const g of grants) {
    const key = `${g.grantee}:${g.grantor}:${g.privilege}`;
    if (seen.has(key)) throw error('DATABASE_FENCE_UNSUPPORTED_ACL');
    seen.add(key);
    if (g.privilege === 'CONNECT' && (g.grantor !== target.owner_oid ||
      !['0', target.owner_oid, target.app_oid].includes(g.grantee) || (g.grantee === '0' && g.grantable))) {
      throw error('DATABASE_FENCE_UNSUPPORTED_ACL');
    }
  }
}

/** This immutable record contains effective ACL evidence, never connection URLs or credentials. */
export function decodeDatabaseFenceJournal(bytes: Buffer): Journal {
  const invalid = () => error('DATABASE_FENCE_JOURNAL_INVALID');
  const object = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === keys.length &&
    keys.every(k => Object.hasOwn(v, k));
  try {
    if (bytes.length > MAX_JOURNAL_BYTES) throw invalid();
    const envelope: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(envelope, ['record', 'sha256']) || typeof envelope.sha256 !== 'string' ||
        !object(envelope.record, ['version', 'operation_id', 'target', 'original_acl', 'fenced_acl'])) throw invalid();
    const j = envelope.record;
    if (j.version !== JOURNAL_VERSION || typeof j.operation_id !== 'string' || !UUID.test(j.operation_id) ||
      !object(j.target, ['database', 'database_oid', 'owner_oid', 'app_oid', 'server_address', 'server_port'])) throw invalid();
    const t = j.target;
    if (typeof t.database !== 'string' || t.database.length === 0 || t.database.length > 63 ||
      typeof t.server_address !== 'string' || t.server_address.length === 0 || t.server_address.length > 64 ||
      !['database_oid', 'owner_oid', 'app_oid', 'server_port'].every(k => typeof t[k] === 'string' && /^[1-9][0-9]*$/u.test(t[k]))) {
      throw invalid();
    }
    for (const list of [j.original_acl, j.fenced_acl]) {
      if (!Array.isArray(list) || list.length > 128 || list.some((g: unknown) =>
        !object(g, ['grantee', 'grantor', 'privilege', 'grantable']) || typeof g.grantee !== 'string' ||
        !/^(0|[1-9][0-9]*)$/u.test(g.grantee) || typeof g.grantor !== 'string' || !/^[1-9][0-9]*$/u.test(g.grantor) ||
        !['CREATE', 'CONNECT', 'TEMPORARY'].includes(String(g.privilege)) || typeof g.grantable !== 'boolean')) throw invalid();
    }
    if (digest(j) !== envelope.sha256) throw invalid();
    const journal = j as unknown as Journal;
    validateAcl(journal.original_acl, journal.target);
    if (!sameAcl(journal.fenced_acl, fenced(journal.original_acl, journal.target.app_oid))) throw invalid();
    return journal;
  } catch { throw invalid(); }
}

async function plainJournalPath(file: string): Promise<string> {
  if (!isAbsolute(file)) throw error('DATABASE_FENCE_JOURNAL_INVALID');
  const absolute = resolve(file);
  let parent = dirname(absolute);
  while (true) {
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw error('DATABASE_FENCE_JOURNAL_INVALID');
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  return absolute;
}
async function writeJournal(file: string, journal: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify({ record: journal, sha256: digest(journal) }));
  if (bytes.length > MAX_JOURNAL_BYTES) throw error('DATABASE_FENCE_JOURNAL_INVALID');
  const handle = await open(await plainJournalPath(file), 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
async function readJournal(file: string): Promise<Journal> {
  const absolute = await plainJournalPath(file);
  const entry = await lstat(absolute);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > MAX_JOURNAL_BYTES) {
    throw error('DATABASE_FENCE_JOURNAL_INVALID');
  }
  return decodeDatabaseFenceJournal(await readFile(absolute));
}

async function roleContext(client: Client): Promise<Target> {
  const result = await client.query<Target & { safe: boolean }>(`select d.datname as database,
    d.oid::text as database_oid, d.datdba::text as owner_oid, a.oid::text as app_oid,
    inet_server_addr()::text as server_address, inet_server_port()::text as server_port,
    session_user = 'relay_migrator' and current_user = 'relay_migrator' and m.oid = d.datdba
      and m.rolcanlogin and a.rolcanlogin and not (m.rolsuper or a.rolsuper or m.rolcreatedb or a.rolcreatedb
        or m.rolcreaterole or a.rolcreaterole or m.rolreplication or a.rolreplication or m.rolbypassrls or a.rolbypassrls)
      and not exists (select 1 from pg_auth_members where roleid in (a.oid,m.oid) or member in (a.oid,m.oid))
      and not has_database_privilege(a.oid,d.oid,'CREATE') as safe
    from pg_database d join pg_roles m on m.rolname = 'relay_migrator'
      join pg_roles a on a.rolname = 'relay_app' where d.datname = current_database()`);
  const row = result.rows[0];
  if (row?.safe !== true || row.server_address === null || row.server_port === null) throw error('DATABASE_FENCE_UNSAFE_ROLE');
  return { database: row.database, database_oid: row.database_oid, owner_oid: row.owner_oid,
    app_oid: row.app_oid, server_address: row.server_address, server_port: row.server_port };
}
async function context(client: Client): Promise<Target> {
  const row = await roleContext(client);
  const owners = await client.query<{ safe: boolean }>(`select
    (select count(*) = 2 from pg_namespace where nspname in ('public','relay_graph_v1'))
    and not exists (select 1 from pg_namespace where nspname in ('public','relay_graph_v1')
      and nspowner not in ($1::oid,(select oid from pg_roles where rolname = 'pg_database_owner')))
    and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','relay_graph_v1') and c.relowner <> $1::oid)
    and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','relay_graph_v1') and p.proowner <> $1::oid) as safe`, [row.owner_oid]);
  if (owners.rows[0]?.safe !== true) throw error('DATABASE_FENCE_UNSAFE_SCHEMA');
  return { database: row.database, database_oid: row.database_oid, owner_oid: row.owner_oid,
    app_oid: row.app_oid, server_address: row.server_address, server_port: row.server_port };
}
async function acl(client: Client): Promise<Grant[]> {
  return normalized((await client.query<Grant>(`select a.grantee::text as grantee, a.grantor::text as grantor,
    a.privilege_type as privilege, a.is_grantable as grantable
    from pg_database d, lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
    where d.datname = current_database()`)).rows);
}
async function requireDrain(client: Client): Promise<void> {
  const rows = (await client.query<{ mode: string }>('select mode from public.runtime_admission_gate where singleton = true')).rows;
  if (rows.length !== 1 || rows[0]?.mode !== 'DRAINING') throw error('DATABASE_FENCE_DRAIN_REQUIRED');
}
async function noOtherConnections(client: Client): Promise<void> {
  // InitPostgres holds this object lock through CONNECT authorization and startup.
  // Its datid is not published yet. Read locks BEFORE a fresh activity snapshot,
  // so the startup lock -> registered backend handoff cannot disappear between views.
  const startup = await client.query<{ present: boolean }>(`select exists (
    select 1 from pg_locks where locktype='object' and classid='pg_catalog.pg_database'::regclass
      and objid=(select oid from pg_database where datname=current_database()) and objsubid=0
      and pid is distinct from pg_backend_pid()) as present`);
  if (startup.rows[0]?.present !== false) throw error('DATABASE_FENCE_OTHER_CONNECTION');
  await client.query('select pg_stat_clear_snapshot()');
  const state = await client.query<{ connections: boolean; prepared: boolean }>(`select
    exists(select 1 from pg_stat_activity where datid = (select oid from pg_database where datname = current_database())
      and pid <> pg_backend_pid() and backend_type is distinct from 'autovacuum worker') as connections,
    exists(select 1 from pg_prepared_xacts where database = current_database()) as prepared`);
  if (state.rows[0]?.prepared !== false) throw error('DATABASE_FENCE_PREPARED_TRANSACTION');
  if (state.rows[0]?.connections !== false) throw error('DATABASE_FENCE_OTHER_CONNECTION');
}
async function locks(client: Client, signal?: AbortSignal): Promise<void> {
  for (const name of LOCKS) {
    signal?.throwIfAborted();
    const deadline = Date.now() + 5000;
    while ((await client.query<{ held: boolean }>('select pg_try_advisory_lock(hashtextextended($1,0)) as held', [name])).rows[0]?.held !== true) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw error('DATABASE_FENCE_LOCK_BUSY');
      await delay(25, undefined, signal === undefined ? undefined : { signal });
    }
  }
}
async function assertLocksHeld(client: Client): Promise<void> {
  const result = await client.query<{ held: boolean }>(`select count(*) = 2 as held
    from unnest($1::text[]) names(name) where exists (
      select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
        and database = (select oid from pg_database where datname = current_database())
        and classid = ((hashtextextended(name,0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(name,0) & 4294967295)::oid
        and objsubid = 1 and mode = 'ExclusiveLock' and granted)`, [[...LOCKS]]);
  if (result.rows[0]?.held !== true) throw error('DATABASE_FENCE_LOCK_LOST');
}
async function restoreAcl(client: Client, journal: Journal): Promise<boolean> {
  if (digest(await context(client)) !== digest(journal.target)) throw error('DATABASE_FENCE_TARGET_MISMATCH');
  await client.query('begin');
  try {
    const current = await acl(client);
    if (sameAcl(current, journal.original_acl)) { await client.query('commit'); return false; }
    if (!sameAcl(current, journal.fenced_acl)) throw error('DATABASE_FENCE_ACL_DRIFT');
    for (const g of journal.original_acl.filter(g => g.privilege === 'CONNECT' && ['0', journal.target.app_oid].includes(g.grantee))) {
      await client.query(`grant connect on database ${quote(journal.target.database)} to ${g.grantee === '0' ? 'PUBLIC' : 'relay_app'}${g.grantable ? ' with grant option' : ''}`);
    }
    if (!sameAcl(await acl(client), journal.original_acl)) throw error('DATABASE_FENCE_ACL_DRIFT');
    await client.query('commit');
    return true;
  } catch (cause) { await client.query('rollback').catch(() => {}); throw cause; }
}
function safe(cause: unknown): DatabaseConnectFenceError {
  return cause instanceof DatabaseConnectFenceError ? cause : error('DATABASE_FENCE_UNAVAILABLE');
}
function connection(url: string): Client {
  try {
    return new Client({ ...maintenanceConnectionOptions(url), application_name: 'relay-database-connect-fence',
      connectionTimeoutMillis: 5000, query_timeout: 6000, statement_timeout: 5000, lock_timeout: 5000 });
  } catch (cause) { throw safe(cause); }
}

export interface DatabaseConnectFence {
  readonly operationId: string; readonly backendPid: number;
  readonly closed: Promise<void>;
  isHeld(): boolean;
  assertQuiescent(): Promise<void>;
  release(): Promise<void>;
}

/** Stops new app connections only. Trusted owner/admin operations and external writers remain separate boundaries. */
export async function holdDatabaseConnectFence(url: string, journalFile: string): Promise<DatabaseConnectFence> {
  const client = connection(url);
  let held = false; let lost = false; let closing = false; let commitAttempted = false; let journal: Journal | undefined;
  let wake!: () => void;
  const closed = new Promise<void>(r => { wake = r; });
  client.on('error', () => { lost = true; held = false; wake(); });
  client.on('end', () => { if (!closing) lost = true; held = false; wake(); });
  try {
    await client.connect();
    await locks(client);
    const target = await context(client);
    await requireDrain(client); await noOtherConnections(client);
    const original = await acl(client); validateAcl(original, target);
    journal = { version: JOURNAL_VERSION, operation_id: randomUUID(), target,
      original_acl: original, fenced_acl: fenced(original, target.app_oid) };
    await writeJournal(journalFile, journal); // Immutable and synced BEFORE any ACL mutation.
    await client.query('begin');
    try {
      if (!sameAcl(await acl(client), original)) throw error('DATABASE_FENCE_ACL_DRIFT');
      await client.query(`revoke connect on database ${quote(target.database)} from PUBLIC, relay_app`);
      const rights = await client.query<{ safe: boolean }>(`select
        not has_database_privilege('relay_app',current_database(),'CONNECT')
        and has_database_privilege('relay_migrator',current_database(),'CONNECT') as safe`);
      if (rights.rows[0]?.safe !== true || !sameAcl(await acl(client), journal.fenced_acl)) throw error('DATABASE_FENCE_ACL_DRIFT');
      commitAttempted = true;
      await client.query('commit');
    } catch (cause) { await client.query('rollback').catch(() => {}); throw cause; }
    await requireDrain(client); await noOtherConnections(client);
    const backendPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    if (lost) throw error('DATABASE_FENCE_CONNECTION_LOST');
    held = true;
    const record = journal;
    return { operationId: record.operation_id, backendPid, closed, isHeld: () => held && !lost,
      assertQuiescent: async () => {
        if (!held || lost) throw error('DATABASE_FENCE_CONNECTION_LOST');
        try {
          if (digest(await context(client)) !== digest(record.target) || !sameAcl(await acl(client), record.fenced_acl)) {
            throw error('DATABASE_FENCE_ACL_DRIFT');
          }
          await requireDrain(client); await noOtherConnections(client);
        } catch (cause) { throw safe(cause); }
      },
      release: async () => {
        if (!held || lost) throw error('DATABASE_FENCE_CONNECTION_LOST');
        held = false;
        try { await restoreAcl(client, record); }
        catch (cause) { throw safe(cause); }
        finally { closing = true; await client.end().catch(() => {}); }
      } };
  } catch (cause) {
    // On uncertain COMMIT/connection loss, retain the immutable journal for explicit recovery.
    if (commitAttempted && journal !== undefined && !lost) {
      try { await restoreAcl(client, journal); }
      catch { cause = error('DATABASE_FENCE_RECOVERY_REQUIRED'); }
    }
    closing = true;
    await client.end().catch(() => {});
    throw safe(cause);
  }
}

/** Explicit, idempotent ACL recovery; does not change admission mode or resume any Run. */
export async function recoverDatabaseConnectFence(url: string, journalFile: string): Promise<{
  readonly operationId: string; readonly changed: boolean;
}> {
  const client = connection(url);
  client.on('error', () => {});
  try {
    const journal = await readJournal(journalFile);
    await client.connect(); await locks(client);
    return { operationId: journal.operation_id, changed: await restoreAcl(client, journal) };
  } catch (cause) { throw safe(cause); }
  finally { await client.end().catch(() => {}); }
}

/** Internal mechanics shared with restore isolation; source-fence lifecycle stays above. */
export const databaseMaintenanceInternals = {
  roleContext, acl, validateAcl, sameAcl, fenced, locks, assertLocksHeld,
  noOtherConnections, plainJournalPath, writeJournal, quote,
};
export type { Target as DatabaseMaintenanceTarget, Grant as DatabaseMaintenanceGrant };
