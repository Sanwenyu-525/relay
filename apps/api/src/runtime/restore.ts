import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { verifyBackupPackage, verifyRestoreRuntimePackage } from './backup-package.js';
import { postgresBackupEnvironment, restorePostgresBackupArchive } from './backup-postgres.js';
import { assertBackupContentReferences, backupStateSha256, readBackupDatabaseState } from './backup-state.js';
import { readRestoreBackup } from './restore-backup.js';
import { assertRestoreSourceRootSeparate, copyRestoreFile, plainRestoreDirectory, prepareRestoreRoot, restoreRoot,
  readRestoreMetadata, verifyRestoreFiles, writeRestoreMetadata } from './restore-files.js';
import { holdRestoreDatabaseIsolation } from './restore-database-isolation.js';

export class RestoreError extends Error {
  override readonly name = 'RestoreError';
  constructor(readonly code = 'RESTORE_UNAVAILABLE') { super(code); }
}
export interface RestoreInput {
  readonly migrationUrl: string; readonly backupRoot: string;
  readonly sourcePackageRoot: string; readonly runtimePackageRoot: string;
  readonly dataRoot: string; readonly postgresBin: string; readonly signal: AbortSignal;
}
const packageRecord = (pkg: Awaited<ReturnType<typeof verifyBackupPackage>>) => ({
  manifest_sha256: pkg.manifestHash, artifact_sha256: pkg.artifactHash,
  node_version: pkg.nodeVersion, resource_sha256: pkg.resourceHashes,
});
/** Restores into a fresh isolated target. It never activates execution, mutates source configuration or reconciles old claims. */
export async function restoreIsolated(input: RestoreInput): Promise<{
  restoreId: string; backupId: string; verifiedSha256: string; admission: 'DRAINING'; execution: 'ISOLATED';
}> {
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(15 * 60_000)]);
  let isolation: Awaited<ReturnType<typeof holdRestoreDatabaseIsolation>> | undefined;
  let closing = false;
  try {
    signal.throwIfAborted();
    if (process.platform !== 'win32') throw new RestoreError('RESTORE_UNSUPPORTED_PLATFORM');
    const env = postgresBackupEnvironment(input.migrationUrl);
    if (env.PGDATABASE?.includes('=')) throw new RestoreError('RESTORE_DATABASE_INVALID_INPUT');
    const backupRoot = restoreRoot(input.backupRoot), sourceRoot = restoreRoot(input.sourcePackageRoot);
    const runtimeRoot = restoreRoot(input.runtimePackageRoot), dataRoot = restoreRoot(input.dataRoot);
    const roots = [...new Set([backupRoot.toLowerCase(), sourceRoot.toLowerCase(), runtimeRoot.toLowerCase(), dataRoot.toLowerCase()])];
    if (dataRoot.toLowerCase() === backupRoot.toLowerCase() || dataRoot.toLowerCase() === sourceRoot.toLowerCase() ||
        dataRoot.toLowerCase() === runtimeRoot.toLowerCase() || roots.some((a, i) => roots.some((b, j) => i !== j && b.startsWith(`${a}${sep}`)))) {
      throw new RestoreError('RESTORE_ROOT_OVERLAP');
    }
    for (const root of [backupRoot, sourceRoot, runtimeRoot, dirname(dataRoot)]) await plainRestoreDirectory(root);
    const backup = await readRestoreBackup(backupRoot, signal);
    const sourcePackage = await verifyBackupPackage(sourceRoot), runtimePackage = await verifyRestoreRuntimePackage(runtimeRoot);
    if (backupStateSha256(packageRecord(sourcePackage)) !== backupStateSha256(backup.manifest.source_package) ||
        backupStateSha256(sourcePackage.registry) !== backupStateSha256(backup.registry)) throw new RestoreError('RESTORE_SOURCE_PACKAGE_MISMATCH');
    const migrations = (pkg: typeof runtimePackage) => Object.fromEntries(Object.entries(pkg.resourceHashes)
      .filter(([ref]) => ref.startsWith('api/migrations/')));
    if (backupStateSha256(migrations(runtimePackage)) !== backupStateSha256(migrations(sourcePackage))) {
      throw new RestoreError('RESTORE_RUNTIME_SCHEMA_MISMATCH');
    }
    await assertRestoreSourceRootSeparate(dataRoot, backup.manifest.maintenance.content_root_id,
      join(runtimeRoot, 'relay-file-io-helper.exe'), signal);
    const restoreId = randomUUID();
    const rootHeld = await prepareRestoreRoot(dataRoot, restoreId, { version: 'relay-restore-isolation-v1',
      purpose: 'RESTORE_TARGET_KEEP_ISOLATED', restore_id: restoreId, backup_id: backup.manifest.backup_id,
      manifest_canonical_sha256: backup.manifestSha256 });
    await mkdir(join(dataRoot, 'restore')); await mkdir(join(dataRoot, 'evidence'));
    await rootHeld(); signal.throwIfAborted();
    isolation = await holdRestoreDatabaseIsolation({ migrationUrl: input.migrationUrl,
      journalFile: join(dataRoot, 'restore/target-acl.json'), sourceTarget: backup.manifest.database.target,
      operationId: restoreId, signal });
    void isolation.closed.then(() => { if (!closing) abort.abort(); });
    const held = async () => {
      signal.throwIfAborted();
      if (!isolation!.isHeld()) throw new RestoreError('RESTORE_DATABASE_CONNECTION_LOST');
      await rootHeld();
    };
    const sqlHeld = async () => { await held(); await isolation!.assertHeld(); await held(); };
    const quiet = async () => { await sqlHeld(); await isolation!.assertQuiescent(); await held(); };
    await quiet();
    const copied = [];
    for (const file of backup.manifest.files) {
      const ref = file.kind === 'CONTENT' ? file.source_ref : `evidence/${file.source_ref}`;
      await copyRestoreFile(backupRoot, { ref: file.backup_ref, size: file.size, sha256: file.sha256 }, dataRoot, ref, signal, held);
      copied.push({ ref, size: file.size, sha256: file.sha256 });
    }
    await quiet();
    await restorePostgresBackupArchive({ migrationUrl: input.migrationUrl, postgresBin: input.postgresBin,
      dumpFile: join(backupRoot, 'database.dump'), expectedArchive: backup.manifest.database, signal, assertHeld: sqlHeld });
    await quiet();
    const state = await readBackupDatabaseState({ migrationUrl: input.migrationUrl, registry: backup.registry,
      resourceHashes: sourcePackage.resourceHashes, signal, assertHeld: sqlHeld });
    await quiet();
    const target = isolation.target;
    if (Object.entries(target).filter(([key]) => key !== 'app_oid').some(([key, value]) => state.target[key] !== value) ||
        backupStateSha256({ ...state, target: backup.state.target }) !== backupStateSha256(backup.state)) {
      throw new RestoreError('RESTORE_STATE_MISMATCH');
    }
    assertBackupContentReferences(state, backup.manifest.files);
    await verifyRestoreFiles(dataRoot, copied, signal, held);
    const after = await readRestoreBackup(backupRoot, signal);
    if (backupStateSha256(after) !== backupStateSha256(backup) ||
        backupStateSha256(await verifyBackupPackage(sourceRoot)) !== backupStateSha256(sourcePackage) ||
        backupStateSha256(await verifyRestoreRuntimePackage(runtimeRoot)) !== backupStateSha256(runtimePackage)) {
      throw new RestoreError('RESTORE_INPUT_CHANGED');
    }
    await quiet();
    await writeRestoreMetadata(join(dataRoot, 'restore/source-state.json'), backup.state);
    await writeRestoreMetadata(join(dataRoot, 'restore/registry.json'), backup.registry);
    await writeRestoreMetadata(join(dataRoot, 'restore/manifest.json'), backup.manifest);
    const record = { version: 'relay-isolated-restore-v1', restore_id: restoreId, backup_id: backup.manifest.backup_id,
      backup_manifest_canonical_sha256: backup.manifestSha256, source_package: packageRecord(sourcePackage),
      runtime_package: packageRecord(runtimePackage), source_target: backup.state.target, target,
      restored_state_canonical_sha256: backupStateSha256(state), files: copied, admission: 'DRAINING', execution: 'ISOLATED',
      external_resource_policy: 'HISTORICAL_IDENTITY_NO_REPLAY', armed_policy: 'EVIDENCE_ONLY_NO_JOB_RECOVERY' };
    await quiet(); closing = true; await isolation.close(); await isolation.closed;
    // Closed connections do not restore ACLs. A verified receipt still grants no startup permission.
    signal.throwIfAborted(); await rootHeld();
    await writeRestoreMetadata(join(dataRoot, 'restore/verified.json'), record);
    if (!(await readRestoreMetadata(dataRoot, 'restore/verified.json', signal)).equals(Buffer.from(JSON.stringify(record)))) {
      throw new RestoreError('RESTORE_FILES_CHANGED');
    }
    signal.throwIfAborted(); await rootHeld();
    return { restoreId, backupId: backup.manifest.backup_id, verifiedSha256: backupStateSha256(record),
      admission: 'DRAINING', execution: 'ISOLATED' };
  } catch (cause) {
    if (cause instanceof RestoreError) throw cause;
    const known = cause instanceof Error && ['RestoreFilesError', 'RestoreBackupError', 'RestoreDatabaseIsolationError',
      'BackupPackageError', 'BackupPostgresError', 'BackupStateError', 'BackupWindowsPathsError'].includes(cause.name)
      ? (cause as Error & { code?: string }).code : undefined;
    throw new RestoreError(signal.aborted ? 'RESTORE_ABORTED' : typeof known === 'string' && /^[A-Z][A-Z_]+$/u.test(known) ? known : 'RESTORE_UNAVAILABLE');
  } finally {
    closing = true;
    try { await isolation?.close(); } catch { throw new RestoreError('RESTORE_CLOSE_FAILED'); }
  }
}
