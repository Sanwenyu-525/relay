import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { Client, type ClientConfig } from 'pg';

import { databaseMaintenanceInternals as maintenance, decodeDatabaseFenceJournal,
  DatabaseConnectFenceError, type DatabaseMaintenanceGrant,
  type DatabaseMaintenanceTarget } from './database-connect-fence.js';
import { postgresBackupEnvironment } from './backup-postgres.js';
import { maintenanceConnectionOptions } from './maintenance-connection.js';
import { assertBackupWindowsPaths } from './backup-paths.js';

const VERSION = 'relay-restore-database-isolation-v1';
const PURPOSE = 'RESTORE_TARGET_KEEP_ISOLATED';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_JOURNAL_BYTES = 64 * 1024;
const CODES = ['RESTORE_DATABASE_INVALID_INPUT', 'RESTORE_DATABASE_UNAVAILABLE',
  'RESTORE_DATABASE_UNSAFE_ROLE', 'RESTORE_DATABASE_UNSUPPORTED_SERVER', 'RESTORE_DATABASE_NOT_EMPTY',
  'RESTORE_DATABASE_SOURCE_TARGET', 'RESTORE_DATABASE_TARGET_MISMATCH', 'RESTORE_DATABASE_UNSUPPORTED_ACL',
  'RESTORE_DATABASE_ACL_DRIFT', 'RESTORE_DATABASE_LOCK_BUSY', 'RESTORE_DATABASE_LOCK_LOST',
  'RESTORE_DATABASE_OTHER_CONNECTION', 'RESTORE_DATABASE_PREPARED_TRANSACTION',
  'RESTORE_DATABASE_JOURNAL_INVALID', 'RESTORE_DATABASE_JOURNAL_CHANGED',
  'RESTORE_DATABASE_CONNECTION_LOST', 'RESTORE_DATABASE_ADMISSION_CHANGED', 'RESTORE_DATABASE_ABORTED'] as const;
type Code = typeof CODES[number];

export class RestoreDatabaseIsolationError extends Error {
  override readonly name = 'RestoreDatabaseIsolationError';
  constructor(readonly code: Code = 'RESTORE_DATABASE_UNAVAILABLE') { super(code); }
}
const error = (code: Code) => new RestoreDatabaseIsolationError(code);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SOURCE_KEYS = ['database', 'database_oid', 'owner_oid', 'server_address', 'server_port'] as const;
interface SourceTarget {
  readonly database: string; readonly database_oid: string; readonly owner_oid: string;
  readonly server_address: string; readonly server_port: string;
}
interface Journal {
  readonly version: typeof VERSION; readonly purpose: typeof PURPOSE; readonly operation_id: string;
  readonly source_target: SourceTarget; readonly target: DatabaseMaintenanceTarget;
  readonly original_acl: readonly DatabaseMaintenanceGrant[]; readonly fenced_acl: readonly DatabaseMaintenanceGrant[];
}
function object(value: unknown, keys?: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (keys === undefined || Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function localAddress(value: string): boolean {
  const [host, mask, ...extra] = value.split('/');
  return host !== undefined && extra.length === 0 &&
    (isIP(host) === 4 && host.startsWith('127.') && (mask === undefined || mask === '32') ||
      host === '::1' && (mask === undefined || mask === '128'));
}
function sourceTarget(value: unknown): SourceTarget {
  if (!object(value) || typeof value.database !== 'string' || value.database.length === 0 ||
      Buffer.byteLength(value.database) > 63 || /[\x00-\x1f]/u.test(value.database) ||
      typeof value.server_address !== 'string' || !localAddress(value.server_address) ||
      !['database_oid', 'owner_oid', 'server_port'].every(key => typeof value[key] === 'string' && /^[1-9][0-9]*$/u.test(value[key])) ||
      Number(value.server_port) > 65535) throw error('RESTORE_DATABASE_INVALID_INPUT');
  return { database: value.database, database_oid: String(value.database_oid), owner_oid: String(value.owner_oid),
    server_address: value.server_address, server_port: String(value.server_port) };
}
function sameTarget(left: DatabaseMaintenanceTarget, right: DatabaseMaintenanceTarget): boolean {
  return digest(left) === digest(right);
}
function rejectSource(target: DatabaseMaintenanceTarget, source: SourceTarget): void {
  // Loopback aliases can reach the same local cluster. OID+port collisions are conservatively refused.
  if (target.server_port === source.server_port && target.database_oid === source.database_oid) {
    throw error('RESTORE_DATABASE_SOURCE_TARGET');
  }
}
function safe(cause: unknown, signal?: AbortSignal): RestoreDatabaseIsolationError {
  if (signal?.aborted) return error('RESTORE_DATABASE_ABORTED');
  if (cause instanceof RestoreDatabaseIsolationError) return cause;
  if (cause instanceof DatabaseConnectFenceError) {
    const code = CODES.find(value => value === cause.code.replace('DATABASE_FENCE_', 'RESTORE_DATABASE_'));
    if (code !== undefined) return error(code);
  }
  return error('RESTORE_DATABASE_UNAVAILABLE');
}

/** Evidence only: this format is intentionally rejected by source-fence ACL recovery. */
export function decodeRestoreDatabaseIsolationJournal(bytes: Buffer): Journal {
  try {
    if (bytes.length > MAX_JOURNAL_BYTES) throw new Error();
    const envelope: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(envelope, ['record', 'sha256']) || typeof envelope.sha256 !== 'string' ||
        !object(envelope.record, ['version', 'purpose', 'operation_id', 'source_target', 'target', 'original_acl', 'fenced_acl'])) throw new Error();
    const record = envelope.record;
    if (record.version !== VERSION || record.purpose !== PURPOSE || digest(record) !== envelope.sha256 ||
        !object(record.source_target, SOURCE_KEYS)) throw new Error();
    const source = sourceTarget(record.source_target);
    const legacy = { version: 'relay-database-connect-fence-v1', operation_id: record.operation_id,
      target: record.target, original_acl: record.original_acl, fenced_acl: record.fenced_acl };
    const checked = decodeDatabaseFenceJournal(Buffer.from(JSON.stringify({ record: legacy, sha256: digest(legacy) })));
    rejectSource(checked.target, source);
    return { version: VERSION, purpose: PURPOSE, operation_id: checked.operation_id, source_target: source,
      target: checked.target, original_acl: checked.original_acl, fenced_acl: checked.fenced_acl };
  } catch { throw error('RESTORE_DATABASE_JOURNAL_INVALID'); }
}

async function requireEmpty(client: Client, target: DatabaseMaintenanceTarget): Promise<void> {
  // PG18's FirstNormalObjectId is 16384. User objects in a system schema are still nonempty.
  const result = await client.query<{ empty: boolean }>(`select
    exists(select 1 from pg_namespace where nspname='public' and nspowner in
      ($1::oid,(select oid from pg_roles where rolname='pg_database_owner')))
    and not exists(select 1 from pg_namespace where nspname not in ('public','pg_catalog','pg_toast','information_schema'))
    and not exists(select 1 from pg_depend where refclassid='pg_namespace'::regclass
      and refobjid=(select oid from pg_namespace where nspname='public'))
    and not exists(select 1 from pg_class where oid >= 16384)
    and not exists(select 1 from pg_proc where oid >= 16384)
    and not exists(select 1 from pg_type where oid >= 16384)
    and not exists(select 1 from pg_collation where oid >= 16384)
    and not exists(select 1 from pg_conversion where oid >= 16384)
    and not exists(select 1 from pg_operator where oid >= 16384)
    and not exists(select 1 from pg_opclass where oid >= 16384)
    and not exists(select 1 from pg_opfamily where oid >= 16384)
    and not exists(select 1 from pg_ts_config where oid >= 16384)
    and not exists(select 1 from pg_ts_dict where oid >= 16384)
    and not exists(select 1 from pg_ts_parser where oid >= 16384)
    and not exists(select 1 from pg_ts_template where oid >= 16384)
    and not exists(select 1 from pg_extension where extname <> 'plpgsql' or extnamespace <> 'pg_catalog'::regnamespace)
    and not exists(select 1 from pg_event_trigger) and not exists(select 1 from pg_foreign_data_wrapper)
    and not exists(select 1 from pg_foreign_server) and not exists(select 1 from pg_publication)
    and not exists(select 1 from pg_subscription) and not exists(select 1 from pg_largeobject_metadata)
    and not exists(select 1 from pg_default_acl)
    and not exists(select 1 from pg_db_role_setting where setdatabase=(select oid from pg_database where datname=current_database())) as empty`, [target.owner_oid]);
  if (result.rows[0]?.empty !== true) throw error('RESTORE_DATABASE_NOT_EMPTY');
}
async function targetContext(client: Client): Promise<DatabaseMaintenanceTarget> {
  const target = await maintenance.roleContext(client);
  const result = await client.query<{ version: string }>("select current_setting('server_version_num') as version");
  if (!/^18\d{4}$/u.test(result.rows[0]?.version ?? '') || !localAddress(target.server_address)) {
    throw error('RESTORE_DATABASE_UNSUPPORTED_SERVER');
  }
  return target;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.nlink === 1n && right.nlink === 1n;
}
async function assertJournal(file: string, handle: FileHandle, original: BigIntStats, record: Journal): Promise<void> {
  try {
    if (original.size < 1n || original.size > BigInt(MAX_JOURNAL_BYTES)) throw new Error();
    const path = await maintenance.plainJournalPath(file);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !sameFile(original, before) ||
        !sameFile(original, await handle.stat({ bigint: true }))) throw new Error();
    const bytes = Buffer.alloc(Number(original.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error();
      offset += bytesRead;
    }
    if (digest(decodeRestoreDatabaseIsolationJournal(bytes)) !== digest(record) ||
        !sameFile(original, await lstat(path, { bigint: true })) ||
        !sameFile(original, await handle.stat({ bigint: true }))) throw new Error();
  } catch { throw error('RESTORE_DATABASE_JOURNAL_CHANGED'); }
}

export interface RestoreDatabaseIsolation {
  readonly operationId: string; readonly target: DatabaseMaintenanceTarget; readonly backendPid: number;
  readonly closed: Promise<void>;
  isHeld(): boolean;
  assertHeld(): Promise<void>;
  assertQuiescent(): Promise<void>;
  close(): Promise<void>;
}

/** Only trusted operator-created empty targets; closing never grants CONNECT or starts execution. */
export async function holdRestoreDatabaseIsolation(input: {
  readonly migrationUrl: string; readonly journalFile: string; readonly sourceTarget: Readonly<Record<string, string>>;
  readonly operationId: string; readonly signal?: AbortSignal;
}): Promise<RestoreDatabaseIsolation> {
  if (input.signal?.aborted) throw error('RESTORE_DATABASE_ABORTED');
  if (!UUID.test(input.operationId)) throw error('RESTORE_DATABASE_INVALID_INPUT');
  const source = sourceTarget(input.sourceTarget);
  let options: ClientConfig;
  try { postgresBackupEnvironment(input.migrationUrl); options = maintenanceConnectionOptions(input.migrationUrl); }
  catch { throw error('RESTORE_DATABASE_INVALID_INPUT'); }
  const client = new Client({ ...options, application_name: 'relay-restore-database-isolation',
    connectionTimeoutMillis: 5000, query_timeout: 6000, statement_timeout: 5000, lock_timeout: 5000 });
  let held = false; let lost = false; let closing = false; let ready = false; let closePromise: Promise<void> | undefined;
  let journalHandle: FileHandle | undefined;
  let wake!: () => void;
  const closed = new Promise<void>(resolve => { wake = resolve; });
  client.on('error', () => { lost = true; held = false; });
  client.on('end', () => { if (!closing) lost = true; held = false; wake(); });
  const abort = () => { held = false; if (ready) void close().catch(() => {}); };
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true; held = false; input.signal?.removeEventListener('abort', abort);
    closePromise = (async () => {
      try { await client.end(); wake(); }
      finally { await journalHandle?.close(); }
    })().catch(cause => { throw safe(cause, input.signal); });
    return closePromise;
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  const active = () => {
    if (input.signal?.aborted) throw error('RESTORE_DATABASE_ABORTED');
    if (lost || closing) throw error('RESTORE_DATABASE_CONNECTION_LOST');
  };
  try {
    active(); await client.connect(); active();
    const target = await targetContext(client); rejectSource(target, source);
    await requireEmpty(client, target);
    await maintenance.locks(client, input.signal); active();
    if (!sameTarget(target, await targetContext(client))) throw error('RESTORE_DATABASE_TARGET_MISMATCH');
    await maintenance.assertLocksHeld(client); await requireEmpty(client, target); await maintenance.noOtherConnections(client);
    const original = await maintenance.acl(client); maintenance.validateAcl(original, target);
    const record: Journal = { version: VERSION, purpose: PURPOSE, operation_id: input.operationId,
      source_target: source, target, original_acl: original, fenced_acl: maintenance.fenced(original, target.app_oid) };
    active();
    try { await maintenance.writeJournal(input.journalFile, record); }
    catch { throw error('RESTORE_DATABASE_JOURNAL_INVALID'); }
    journalHandle = await open(await maintenance.plainJournalPath(input.journalFile), 'r');
    const journalStat = await journalHandle.stat({ bigint: true });
    await assertJournal(input.journalFile, journalHandle, journalStat, record); active();
    await client.query('begin');
    try {
      if (!sameTarget(target, await targetContext(client))) throw error('RESTORE_DATABASE_TARGET_MISMATCH');
      await maintenance.assertLocksHeld(client); await requireEmpty(client, target); await maintenance.noOtherConnections(client);
      if (!maintenance.sameAcl(await maintenance.acl(client), original)) throw error('RESTORE_DATABASE_ACL_DRIFT');
      await assertJournal(input.journalFile, journalHandle, journalStat, record); active();
      await client.query(`revoke connect on database ${maintenance.quote(target.database)} from PUBLIC, relay_app`);
      if (!maintenance.sameAcl(await maintenance.acl(client), record.fenced_acl)) throw error('RESTORE_DATABASE_ACL_DRIFT');
      const rights = await client.query<{ safe: boolean }>(`select not has_database_privilege('relay_app',current_database(),'CONNECT')
        and has_database_privilege('relay_migrator',current_database(),'CONNECT') as safe`);
      if (rights.rows[0]?.safe !== true) throw error('RESTORE_DATABASE_ACL_DRIFT');
      active(); await client.query('commit');
    } catch (cause) { await client.query('rollback').catch(() => {}); throw cause; }
    active(); await requireEmpty(client, target); await maintenance.noOtherConnections(client);
    const backendPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    held = true;
    const pinnedHandle = journalHandle;
    const assertHeld = async (): Promise<void> => {
      try {
        active(); if (!held) throw error('RESTORE_DATABASE_CONNECTION_LOST');
        await maintenance.assertLocksHeld(client);
        if (!sameTarget(target, await targetContext(client))) throw error('RESTORE_DATABASE_TARGET_MISMATCH');
        if (!maintenance.sameAcl(await maintenance.acl(client), record.fenced_acl)) throw error('RESTORE_DATABASE_ACL_DRIFT');
        await assertJournal(input.journalFile, pinnedHandle, journalStat, record); active();
      } catch (cause) { held = false; throw safe(cause, input.signal); }
    };
    await assertHeld();
    ready = true;
    return { operationId: input.operationId, target, backendPid, closed, isHeld: () => held && !lost && !closing,
      assertHeld, assertQuiescent: async () => {
        await assertHeld();
        try { await maintenance.noOtherConnections(client); active(); }
        catch (cause) { throw safe(cause, input.signal); }
      }, close };
  } catch (cause) {
    // COMMIT may already have succeeded. Keep evidence and never compensate either database's ACL.
    await close().catch(() => {});
    throw safe(cause, input.signal);
  }
}

async function restoredJournalPath(file: string): Promise<string> {
  if (!isAbsolute(file) || file.includes('\0') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(file)) ||
      file.slice(process.platform === 'win32' ? 3 : 1).split(/[\\/]/u).some(part =>
        part === '.' || part === '..' || /[:<>"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part))) {
    throw error('RESTORE_DATABASE_JOURNAL_INVALID');
  }
  const path = await maintenance.plainJournalPath(file);
  const paths = [path];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    paths.push(parent);
    if (dirname(parent) === parent) break;
  }
  await assertBackupWindowsPaths(paths);
  return resolve(path);
}
async function restoredJournalBytes(file: string, handle: FileHandle, original: BigIntStats): Promise<Buffer> {
  const path = await restoredJournalPath(file);
  const before = await lstat(path, { bigint: true });
  const unchanged = (value: BigIntStats) => value.isFile() && !value.isSymbolicLink() &&
    sameFile(original, value) && original.ctimeNs === value.ctimeNs;
  if (original.size < 1n || original.size > BigInt(MAX_JOURNAL_BYTES) ||
      !unchanged(before) || !unchanged(await handle.stat({ bigint: true }))) throw new Error();
  const bytes = Buffer.alloc(Number(original.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error();
    offset += bytesRead;
  }
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!unchanged(await lstat(path, { bigint: true })) || !unchanged(await handle.stat({ bigint: true }))) throw new Error();
  return bytes;
}
async function requireRestoredAdmission(client: Client, revision: string): Promise<void> {
  const rows = (await client.query<{ mode: string; revision: string }>(
    'select mode,revision::text as revision from public.runtime_admission_gate where singleton=true')).rows;
  if (rows.length !== 1 || rows[0]?.mode !== 'DRAINING' || rows[0].revision !== revision) {
    throw error('RESTORE_DATABASE_ADMISSION_CHANGED');
  }
}

/** Reholds existing restored evidence without changing its ACL, admission or journal. */
export async function holdRestoredDatabaseIsolation(input: {
  readonly migrationUrl: string; readonly journalFile: string; readonly operationId: string;
  readonly expectedTarget: DatabaseMaintenanceTarget; readonly expectedJournalSha256: string;
  readonly expectedAdmissionRevision: string; readonly signal?: AbortSignal;
}): Promise<RestoreDatabaseIsolation> {
  if (input.signal?.aborted) throw error('RESTORE_DATABASE_ABORTED');
  const keys = [...SOURCE_KEYS, 'app_oid'];
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId) ||
      typeof input.expectedJournalSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedJournalSha256) ||
      typeof input.expectedAdmissionRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(input.expectedAdmissionRevision) ||
      !object(input.expectedTarget, keys) || typeof input.expectedTarget.app_oid !== 'string' ||
      !/^[1-9][0-9]*$/u.test(input.expectedTarget.app_oid)) {
    throw error('RESTORE_DATABASE_INVALID_INPUT');
  }
  const expectedTarget: DatabaseMaintenanceTarget = { ...sourceTarget(input.expectedTarget), app_oid: input.expectedTarget.app_oid };
  // Property insertion order must not affect physical identity comparison with decoded evidence.
  const targetMatches = (target: DatabaseMaintenanceTarget) => keys.every(key =>
    target[key as keyof DatabaseMaintenanceTarget] === expectedTarget[key as keyof DatabaseMaintenanceTarget]);
  let environment: NodeJS.ProcessEnv;
  try { environment = postgresBackupEnvironment(input.migrationUrl); }
  catch { throw error('RESTORE_DATABASE_INVALID_INPUT'); }
  const client = new Client({ host: environment.PGHOST!, port: Number(environment.PGPORT), user: environment.PGUSER!,
    database: environment.PGDATABASE!, password: async () => environment.PGPASSWORD ?? '',
    ssl: false, options: '-c default_transaction_read_only=on', client_encoding: 'UTF8',
    application_name: 'relay-restore-check-database-isolation',
    connectionTimeoutMillis: 5000, query_timeout: 6000, statement_timeout: 5000, lock_timeout: 5000 });
  let held = false; let lost = false; let closing = false; let ready = false; let closePromise: Promise<void> | undefined;
  let journalHandle: FileHandle | undefined;
  let wake!: () => void;
  const closed = new Promise<void>(resolve => { wake = resolve; });
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true; held = false; input.signal?.removeEventListener('abort', abort);
    closePromise = (async () => {
      try { await client.end(); }
      finally { try { await journalHandle?.close(); } finally { wake(); } }
    })().catch(cause => { throw safe(cause, input.signal); });
    return closePromise;
  };
  client.on('error', () => { lost = true; held = false; if (ready) void close().catch(() => {}); });
  client.on('end', () => { if (!closing) lost = true; held = false; if (ready) void close().catch(() => {}); });
  const abort = () => { held = false; if (ready) void close().catch(() => {}); };
  input.signal?.addEventListener('abort', abort, { once: true });
  const active = () => {
    if (input.signal?.aborted) throw error('RESTORE_DATABASE_ABORTED');
    if (lost || closing) throw error('RESTORE_DATABASE_CONNECTION_LOST');
  };
  try {
    active();
    let record: Journal; let journalStat: BigIntStats;
    try {
      const path = await restoredJournalPath(input.journalFile);
      const entry = await lstat(path, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw new Error();
      journalHandle = await open(path, 'r'); journalStat = await journalHandle.stat({ bigint: true });
      if (!sameFile(entry, journalStat) || entry.ctimeNs !== journalStat.ctimeNs) throw new Error();
      const bytes = await restoredJournalBytes(path, journalHandle, journalStat);
      record = decodeRestoreDatabaseIsolationJournal(bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== input.expectedJournalSha256) throw error('RESTORE_DATABASE_JOURNAL_CHANGED');
      if (record.operation_id !== input.operationId) throw error('RESTORE_DATABASE_JOURNAL_INVALID');
    } catch (cause) { throw cause instanceof RestoreDatabaseIsolationError ? cause : error('RESTORE_DATABASE_JOURNAL_INVALID'); }
    if (!targetMatches(record.target)) throw error('RESTORE_DATABASE_TARGET_MISMATCH');
    const pinnedHandle = journalHandle;
    const checkJournal = async () => {
      try {
        const bytes = await restoredJournalBytes(input.journalFile, pinnedHandle, journalStat);
        if (createHash('sha256').update(bytes).digest('hex') !== input.expectedJournalSha256) throw new Error();
      } catch { throw error('RESTORE_DATABASE_JOURNAL_CHANGED'); }
    };
    const checkState = async () => {
      active();
      if (!targetMatches(await targetContext(client))) throw error('RESTORE_DATABASE_TARGET_MISMATCH');
      if (!maintenance.sameAcl(await maintenance.acl(client), record.fenced_acl)) throw error('RESTORE_DATABASE_ACL_DRIFT');
      await requireRestoredAdmission(client, input.expectedAdmissionRevision);
      await checkJournal(); active();
    };
    active(); await client.connect(); await checkState();
    await maintenance.locks(client, input.signal); active();
    await maintenance.assertLocksHeld(client); await checkState(); await maintenance.noOtherConnections(client); active();
    const backendPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    held = true;
    const assertHeld = async (): Promise<void> => {
      try {
        active(); if (!held) throw error('RESTORE_DATABASE_CONNECTION_LOST');
        await maintenance.assertLocksHeld(client); await checkState();
      } catch (cause) { held = false; throw safe(cause, input.signal); }
    };
    await assertHeld(); ready = true;
    return { operationId: input.operationId, target: record.target, backendPid, closed,
      isHeld: () => held && !lost && !closing, assertHeld,
      assertQuiescent: async () => {
        await assertHeld();
        try { await maintenance.noOtherConnections(client); active(); }
        catch (cause) { throw safe(cause, input.signal); }
      }, close };
  } catch (cause) { await close().catch(() => {}); throw safe(cause, input.signal); }
}
