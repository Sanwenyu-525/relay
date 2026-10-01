import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { Client, Pool } from 'pg';

import { changeAdmission, readAdmissionStatus } from '../application/runtime-maintenance.js';
import type { RelayDatabaseSchema } from '../infrastructure/database-schema.js';
import '../infrastructure/pg-types.js';
import { recoverStoppedDesktopLaunch, type StoppedClaimResults } from '../worker/supervisor.js';
import { copyBackupData } from './backup-files.js';
import { verifyBackupPackage } from './backup-package.js';
import { assertBackupWindowsPaths } from './backup-paths.js';
import { createPostgresBackupArchive, postgresBackupEnvironment } from './backup-postgres.js';
import { assertBackupContentReferences, assertBackupWritersStopped, backupStateSha256,
  readBackupDatabaseState } from './backup-state.js';
import { openContentFreezeSession, type ContentFreezeSession } from './content-freeze-session.js';
import { decodeDatabaseFenceJournal, holdDatabaseConnectFence } from './database-connect-fence.js';
import { openDesktopMaintenanceSession, type DesktopMaintenanceSession } from './desktop-maintenance-session.js';
import { maintenanceConnectionOptions } from './maintenance-connection.js';

export class BackupError extends Error {
  override readonly name = 'BackupError';
  constructor(readonly code = 'BACKUP_UNAVAILABLE') { super(code); }
}
export interface BackupInput {
  readonly appUrl: string; readonly migrationUrl: string;
  readonly packageRoot: string; readonly dataRoot: string; readonly backupRoot: string;
  readonly postgresBin: string; readonly signal: AbortSignal;
}

function canonicalRoot(value: string): string {
  if (!isAbsolute(value) || !/^[a-z]:[\\/]/iu.test(value)) throw new BackupError('BACKUP_INVALID_PATH');
  const tail = value.slice(parse(value).root.length).replace(/[\\/]$/u, '');
  if (tail === '' || tail.split(/[\\/]/u).some(part => !part || part === '.' || part === '..' ||
    /[\x00-\x1f<>:"|?*]/u.test(part) || /[. ]$/u.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/iu.test(part))) {
    throw new BackupError('BACKUP_INVALID_PATH');
  }
  return resolve(value);
}
function overlaps(a: string, b: string): boolean {
  const first = a.toLowerCase(), second = b.toLowerCase();
  return first === second || second.startsWith(`${first}${sep}`);
}
async function plainDirectory(path: string): Promise<void> {
  const paths: string[] = [];
  for (let current = path;; current = dirname(current)) {
    paths.unshift(current); if (dirname(current) === current) break;
  }
  await assertBackupWindowsPaths(paths);
  for (const current of paths) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new BackupError('BACKUP_INVALID_PATH');
  }
}

/** Validate both real roles and the physical target before changing admission. */
async function attestTarget(appUrl: string, migrationUrl: string): Promise<Record<string, string>> {
  postgresBackupEnvironment(migrationUrl);
  const app = new URL(appUrl);
  if (decodeURIComponent(app.username) !== 'relay_app') throw new BackupError('BACKUP_TARGET_INVALID');
  const checked = new URL(app); checked.username = 'relay_migrator';
  postgresBackupEnvironment(checked.toString());
  let target: Record<string, string> | undefined;
  for (const [url, role] of [[appUrl, 'relay_app'], [migrationUrl, 'relay_migrator']] as const) {
    const client = new Client({ ...maintenanceConnectionOptions(url), application_name: 'relay-backup-attest',
      connectionTimeoutMillis: 5000, query_timeout: 6000, statement_timeout: 5000 });
    client.on('error', () => {});
    try {
      await client.connect();
      const row = (await client.query<Record<string, string>>(`select current_database() as database,
        d.oid::text as database_oid,d.datdba::text as owner_oid,inet_server_addr()::text as server_address,
        inet_server_port()::text as server_port,current_setting('server_version_num') as server_version_num,
        session_user as role from pg_database d where datname=current_database()`)).rows[0];
      if (row === undefined || row.role !== role || row.server_address === null || !/^18\d{4}$/u.test(row.server_version_num ?? '')) {
        throw new BackupError('BACKUP_TARGET_INVALID');
      }
      const { role: _role, ...identity } = row;
      if (target !== undefined && backupStateSha256(target) !== backupStateSha256(identity)) throw new BackupError('BACKUP_TARGET_MISMATCH');
      target = identity;
    } finally { await client.end().catch(() => {}); }
  }
  return target!;
}
function applicationDatabase(url: string) {
  const pool = new Pool({ ...maintenanceConnectionOptions(url), max: 1, application_name: 'relay-backup-maintenance',
    connectionTimeoutMillis: 5000, query_timeout: 12000, statement_timeout: 10000, lock_timeout: 5000 });
  let lost = false;
  pool.on('error', () => { lost = true; });
  const db = new Kysely<RelayDatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  return { db, assertAlive() { if (lost) throw new BackupError('BACKUP_CONNECTION_LOST'); }, close: () => db.destroy() };
}
async function immutable(file: string, value: unknown): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 24 * 1024 * 1024) throw new BackupError('BACKUP_METADATA_LIMIT');
  const writer = await open(file, 'wx', 0o600);
  try { await writer.writeFile(bytes); await writer.sync(); } finally { await writer.close(); }
  return backupStateSha256(value);
}

/** Recheck payload bytes after the dump and package inspection, while all three holds are live. */
async function verifyPayloadFiles(root: string, files: readonly { backup_ref: string; size: string; sha256: string }[],
  assertHeld: () => Promise<void>): Promise<void> {
  const paths = files.map(file => join(root, ...file.backup_ref.split('/')));
  const checked = new Set<string>([root]);
  for (const path of paths) {
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) checked.add(parent);
  }
  await assertBackupWindowsPaths([...checked].sort((a, b) => a.length - b.length));
  await assertBackupWindowsPaths(paths);
  for (const [index, file] of files.entries()) {
    await assertHeld();
    const path = paths[index]!, before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || String(before.size) !== file.size ||
        (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new BackupError('BACKUP_TARGET_CHANGED');
    const reader = await open(path, 'r');
    try {
      const opened = await reader.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
          opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) throw new BackupError('BACKUP_TARGET_CHANGED');
      const digest = createHash('sha256'); let read = 0n;
      for await (const chunk of reader.createReadStream({ autoClose: false })) {
        read += BigInt(chunk.length); if (read > before.size) throw new BackupError('BACKUP_TARGET_CHANGED');
        digest.update(chunk); await assertHeld();
      }
      const after = await lstat(path, { bigint: true });
      if (read !== before.size || digest.digest('hex') !== file.sha256 || after.dev !== before.dev ||
          after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
          after.nlink !== 1n || after.size !== before.size) throw new BackupError('BACKUP_TARGET_CHANGED');
    } finally { await reader.close(); }
  }
}

/** Local operational snapshot; release never resumes admission or replays unresolved actions. */
export async function createBackup(input: BackupInput): Promise<{
  readonly backupId: string; readonly manifestSha256: string; readonly admission: 'DRAINING';
}> {
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(15 * 60_000)]);
  let desktop: DesktopMaintenanceSession | undefined, content: ContentFreezeSession | undefined;
  let fence: Awaited<ReturnType<typeof holdDatabaseConnectFence>> | undefined;
  let releasing = false, releaseFailure = false;
  async function live(): Promise<void> {
    signal.throwIfAborted();
    if (desktop?.isHeld() !== true || (content !== undefined && !content.isHeld()) ||
        (fence !== undefined && !fence.isHeld())) throw new BackupError('BACKUP_LOCK_LOST');
  }
  async function quiescent(): Promise<void> { await live(); await fence!.assertQuiescent(); await live(); }
  async function release(): Promise<void> {
    releasing = true;
    // Keep the native guard and content lock until the original database ACL is restored.
    for (const session of [fence, content, desktop]) {
      if (session === undefined) continue;
      try { await session.release(); } catch { releaseFailure = true; }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([session.closed, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new BackupError('BACKUP_RELEASE_FAILED')), 10000);
        })]);
      } catch { releaseFailure = true; }
      finally { clearTimeout(timeout); }
    }
    fence = undefined; content = undefined; desktop = undefined;
  }
  try {
    signal.throwIfAborted();
    const packageRoot = canonicalRoot(input.packageRoot), dataRoot = canonicalRoot(input.dataRoot), backupRoot = canonicalRoot(input.backupRoot);
    for (const [a, b] of [[packageRoot, dataRoot], [packageRoot, backupRoot], [dataRoot, backupRoot]] as const) {
      if (overlaps(a!, b!) || overlaps(b!, a!)) throw new BackupError('BACKUP_ROOT_OVERLAP');
    }
    await plainDirectory(dirname(backupRoot)); await plainDirectory(dataRoot);
    const sourcePackage = await verifyBackupPackage(packageRoot);
    const target = await attestTarget(input.appUrl, input.migrationUrl);
    signal.throwIfAborted();
    try { await mkdir(backupRoot); } catch { throw new BackupError('BACKUP_TARGET_EXISTS'); }
    await plainDirectory(backupRoot);
    const rootIdentity = await lstat(backupRoot, { bigint: true });
    async function outputHeld(): Promise<void> {
      await plainDirectory(backupRoot);
      const stat = await lstat(backupRoot, { bigint: true });
      if (stat.dev !== rootIdentity.dev || stat.ino !== rootIdentity.ino || stat.birthtimeNs !== rootIdentity.birthtimeNs) {
        throw new BackupError('BACKUP_TARGET_CHANGED');
      }
    }
    const backupId = randomUUID();
    await immutable(join(backupRoot, 'incomplete.json'), { version: 'relay-backup-v1', backup_id: backupId });
    await mkdir(join(backupRoot, 'maintenance'));
    const application = applicationDatabase(input.appUrl);
    let drain;
    try {
      drain = await readAdmissionStatus(application.db);
      if (drain.mode === 'NORMAL') drain = (await changeAdmission(application.db,
        { commandId: backupId, action: 'begin-drain', expectedRevision: drain.revision })).result;
      application.assertAlive();
    } finally { await application.close(); }
    desktop = await openDesktopMaintenanceSession({ packageRoot, dataRoot });
    void desktop.closed.then(() => { if (!releasing) abort.abort(new BackupError('BACKUP_LOCK_LOST')); });
    const readState = () => readBackupDatabaseState({ migrationUrl: input.migrationUrl,
      registry: sourcePackage.registry, resourceHashes: sourcePackage.resourceHashes, signal, assertHeld: live });
    const initial = await readState();
    if (backupStateSha256(initial.target) !== backupStateSha256(target)) throw new BackupError('BACKUP_TARGET_MISMATCH');
    if (initial.admission.revision !== drain.revision) throw new BackupError('BACKUP_STATE_CHANGED');
    assertBackupWritersStopped(initial, desktop.stoppedLaunches);
    // These application owners reconcile only original identities with the actual native stop proof.
    const recovery: { launch_id: string; result: StoppedClaimResults }[] = [];
    const recoveryDb = applicationDatabase(input.appUrl);
    try {
      for (const launch of desktop.stoppedLaunches) {
        await live();
        recovery.push({ launch_id: launch.launchId, result: await recoverStoppedDesktopLaunch({
          db: recoveryDb.db, dataRoot, ...launch }) });
        recoveryDb.assertAlive(); await live();
      }
    } finally { await recoveryDb.close(); }
    content = await openContentFreezeSession(dataRoot, join(packageRoot, 'relay-file-io-helper.exe'));
    void content.closed.then(() => { if (!releasing) abort.abort(new BackupError('BACKUP_LOCK_LOST')); });
    const journalFile = join(backupRoot, 'maintenance', 'original-acl.json');
    fence = await holdDatabaseConnectFence(input.migrationUrl, journalFile);
    void fence.closed.then(() => { if (!releasing) abort.abort(new BackupError('BACKUP_LOCK_LOST')); });
    await quiescent();
    const before = await readState();
    await quiescent();
    if (backupStateSha256(before.target) !== backupStateSha256(target) || before.admission.revision !== drain.revision) {
      throw new BackupError('BACKUP_STATE_CHANGED');
    }
    assertBackupWritersStopped(before, desktop.stoppedLaunches);
    const files = await copyBackupData({ dataRoot, backupRoot, assertHeld: async () => { await quiescent(); await outputHeld(); } });
    assertBackupContentReferences(before, files);
    const postgres = await createPostgresBackupArchive({ migrationUrl: input.migrationUrl,
      postgresBin: input.postgresBin, dumpFile: join(backupRoot, 'database.dump'), signal,
      assertHeld: async () => { await quiescent(); await outputHeld(); } });
    await quiescent();
    const after = await readState();
    await quiescent();
    if (backupStateSha256(before) !== backupStateSha256(after)) throw new BackupError('BACKUP_STATE_CHANGED');
    assertBackupContentReferences(after, files);
    const currentPackage = await verifyBackupPackage(packageRoot);
    if (backupStateSha256(sourcePackage) !== backupStateSha256(currentPackage)) throw new BackupError('BACKUP_PACKAGE_CHANGED');
    await quiescent(); await outputHeld();
    await verifyPayloadFiles(backupRoot, [...files, { backup_ref: 'database.dump', size: postgres.size, sha256: postgres.sha256 }],
      live);
    await quiescent(); await outputHeld();
    const registrySha256 = await immutable(join(backupRoot, 'registry.json'), sourcePackage.registry);
    const stateSha256 = await immutable(join(backupRoot, 'state.json'), after);
    const journal = decodeDatabaseFenceJournal(await readFile(journalFile));
    const manifest = { version: 'relay-backup-v1', backup_id: backupId, captured_at: new Date().toISOString(),
      scope: 'LOCAL_DATABASE_AND_MANAGED_CONTENT', admission: drain,
      source_package: { manifest_sha256: sourcePackage.manifestHash, artifact_sha256: sourcePackage.artifactHash,
        node_version: sourcePackage.nodeVersion, resource_sha256: sourcePackage.resourceHashes },
      database: { ref: 'database.dump', ...postgres, target }, files,
      registry: { ref: 'registry.json', canonical_sha256: registrySha256 },
      state: { ref: 'state.json', canonical_sha256: stateSha256 },
      maintenance: { desktop_nonce: desktop.nonce, stopped_launches: desktop.stoppedLaunches,
        content_nonce: content.nonce, content_root_id: content.rootId, content_sentinel_id: content.sentinelId,
        database_operation_id: journal.operation_id, acl_journal_ref: 'maintenance/original-acl.json', recovery },
      exclusions: ['LOCAL_CONFIGURATION_AND_CREDENTIALS', 'EXTERNAL_RESOURCE_CONTENT', 'LOGS'],
      restore_policy: 'NEW_DATABASE_AND_DATA_ROOT_DRAINING_NO_EXTERNAL_REPLAY' };
    const manifestSha256 = await immutable(join(backupRoot, 'manifest.json'), manifest);
    await quiescent(); await outputHeld();
    await release();
    if (releaseFailure) throw new BackupError('BACKUP_RELEASE_FAILED');
    // This marker confirms completion of our maintenance sessions, not permission to start workers.
    signal.throwIfAborted(); await outputHeld();
    await immutable(join(backupRoot, 'complete.json'), { version: 'relay-backup-v1', backup_id: backupId,
      manifest_canonical_sha256: manifestSha256, admission: 'DRAINING' });
    return { backupId, manifestSha256, admission: 'DRAINING' };
  } catch (cause) {
    await release();
    if (releaseFailure) throw new BackupError('BACKUP_RELEASE_FAILED');
    if (cause instanceof BackupError) throw cause;
    // Only known internal errors may supply fixed codes; never print a PG URL, query, or native stderr.
    const known = cause instanceof Error && ['BackupStateError', 'BackupFilesError', 'BackupPackageError',
      'BackupPostgresError', 'DatabaseConnectFenceError', 'DesktopMaintenanceSessionError', 'WindowsContentError',
      'BackupWindowsPathsError'].includes(cause.name) ? (cause as Error & { code?: string }).code : undefined;
    throw new BackupError(typeof known === 'string' && /^[A-Z][A-Z_]+$/u.test(known) ? known : 'BACKUP_UNAVAILABLE');
  }
}
