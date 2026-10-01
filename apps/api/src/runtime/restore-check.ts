import { lstat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { verifyRestoreRuntimePackage } from './backup-package.js';
import { backupStateSha256, readBackupDatabaseState } from './backup-state.js';
import { openContentFreezeSession, type ContentFreezeSession } from './content-freeze-session.js';
import { holdRestoredDatabaseIsolation, type RestoreDatabaseIsolation } from './restore-database-isolation.js';
import { assertRestoreInventory, assertRestoreSourceRootSeparate, restoreRoot, verifyRestoreFiles } from './restore-files.js';
import { readRestoreMaterials, RestoreCheckError, RESTORE_MATERIAL_REFS } from './restore-materials.js';
import { probeRestoreRuntime } from './restore-runtime-probe.js';
import { probeRestoreResourceRoots } from './restore-resource-roots.js';

export interface RestoreCheckInput {
  readonly migrationUrl: string; readonly dataRoot: string; readonly runtimePackageRoot: string;
  readonly signal: AbortSignal;
}
const SENTINEL = '.relay-content-admission.lock';
async function sentinelExists(root: string): Promise<boolean> {
  try { await lstat(join(root, SENTINEL)); return true; }
  catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

/** A business-read-only maintenance observation. Native content exclusion may create its lock file. */
export async function checkIsolatedRestore(input: RestoreCheckInput) {
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(15 * 60_000)]);
  let content: ContentFreezeSession | undefined, database: RestoreDatabaseIsolation | undefined;
  let closing = false, finishPromise: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    if (finishPromise !== undefined) return finishPromise;
    closing = true;
    finishPromise = (async () => {
      const results = await Promise.allSettled([content?.release(), database?.close()]);
      const ends = await Promise.allSettled([content?.closed, database?.closed]);
      if (results.some(result => result.status === 'rejected') || ends.some(result => result.status === 'rejected')) {
        throw new RestoreCheckError('RESTORE_CHECK_CLOSE_FAILED');
      }
      const contentEnd = ends[0];
      if (contentEnd?.status === 'fulfilled' && contentEnd.value !== undefined &&
          (contentEnd.value.code !== 0 || contentEnd.value.signal !== null || contentEnd.value.failure !== null)) {
        throw new RestoreCheckError('RESTORE_CHECK_CLOSE_FAILED');
      }
    })();
    return finishPromise;
  };
  try {
    signal.throwIfAborted();
    if (process.platform !== 'win32') throw new RestoreCheckError('RESTORE_CHECK_UNSUPPORTED_PLATFORM');
    const root = restoreRoot(input.dataRoot), runtimeRoot = restoreRoot(input.runtimePackageRoot);
    const a = root.toLowerCase(), b = runtimeRoot.toLowerCase();
    if (a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)) {
      throw new RestoreCheckError('RESTORE_CHECK_ROOT_OVERLAP');
    }
    const materials = await readRestoreMaterials(root, signal);
    const pkg = await verifyRestoreRuntimePackage(runtimeRoot);
    const packageRecord = { manifest_sha256: pkg.manifestHash, artifact_sha256: pkg.artifactHash,
      node_version: pkg.nodeVersion, resource_sha256: pkg.resourceHashes };
    if (backupStateSha256(packageRecord) !== backupStateSha256(materials.runtimePackage)) {
      throw new RestoreCheckError('RESTORE_CHECK_RUNTIME_PACKAGE_MISMATCH');
    }
    const migrations = (hashes: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(hashes)
      .filter(([ref]) => ref.startsWith('api/migrations/')));
    if (backupStateSha256(migrations(pkg.resourceHashes)) !==
        backupStateSha256(migrations(materials.manifest.source_package.resource_sha256))) {
      throw new RestoreCheckError('RESTORE_CHECK_RUNTIME_SCHEMA_MISMATCH');
    }
    const runtimeProbe = await probeRestoreRuntime({ packageRoot: runtimeRoot,
      resourceHashes: pkg.resourceHashes, nodeVersion: pkg.nodeVersion, signal });
    const hadSentinel = await sentinelExists(root);
    const inventory = async () => assertRestoreInventory(root, [...RESTORE_MATERIAL_REFS,
      ...materials.files.map(file => file.ref), ...(await sentinelExists(root) ? [SENTINEL] : [])]);
    await inventory(); await materials.assertUnchanged();
    // This leaf is never created: its parent/ancestor probe includes the existing root itself.
    const helper = join(runtimeRoot, 'relay-file-io-helper.exe');
    await assertRestoreSourceRootSeparate(join(root, '.relay-restore-check-probe'),
      materials.manifest.maintenance.content_root_id, helper, signal);
    signal.throwIfAborted();
    content = await openContentFreezeSession(root, helper);
    void content.closed.then(() => { if (!closing) abort.abort(); });
    if (content.rootId === materials.manifest.maintenance.content_root_id) {
      throw new RestoreCheckError('RESTORE_CHECK_SOURCE_ROOT_OVERLAP');
    }
    await inventory(); await materials.assertUnchanged();
    database = await holdRestoredDatabaseIsolation({ migrationUrl: input.migrationUrl,
      journalFile: join(root, 'restore/target-acl.json'), operationId: materials.restoreId,
      expectedTarget: materials.target, expectedJournalSha256: materials.metadataSha256['restore/target-acl.json']!,
      expectedAdmissionRevision: materials.sourceState.admission.revision, signal });
    void database.closed.then(() => { if (!closing) abort.abort(); });
    const held = async () => {
      signal.throwIfAborted();
      if (!content!.isHeld() || !database!.isHeld()) throw new RestoreCheckError('RESTORE_CHECK_HOLD_LOST');
      await database!.assertHeld();
    };
    const quiet = async () => { await held(); await database!.assertQuiescent(); await held(); };
    await quiet();
    const state = await readBackupDatabaseState({ migrationUrl: input.migrationUrl, registry: materials.registry,
      resourceHashes: materials.manifest.source_package.resource_sha256, signal, assertHeld: held });
    await quiet();
    if (Object.entries(database.target).filter(([key]) => key !== 'app_oid').some(([key, value]) => state.target[key] !== value) ||
        backupStateSha256(state) !== materials.stateSha256 ||
        backupStateSha256({ ...state, target: materials.sourceState.target }) !== backupStateSha256(materials.sourceState)) {
      throw new RestoreCheckError('RESTORE_CHECK_STATE_MISMATCH');
    }
    const resourceRoots = await probeRestoreResourceRoots({ externalResources: state.external_resources,
      selectedStateSha256: backupStateSha256(state), helperExecutable: helper,
      helperSha256: pkg.resourceHashes['relay-file-io-helper.exe']!, signal, assertHeld: held });
    await materials.assertUnchanged(); await inventory();
    await verifyRestoreFiles(root, materials.files, signal, held);
    if (backupStateSha256(await verifyRestoreRuntimePackage(runtimeRoot)) !== backupStateSha256(pkg)) {
      throw new RestoreCheckError('RESTORE_CHECK_RUNTIME_PACKAGE_CHANGED');
    }
    await materials.assertUnchanged(); await inventory(); await quiet();
    const report = { version: 'relay-restore-maintenance-check-v1', restore_id: materials.restoreId,
      backup_id: materials.backupId, target: database.target, server_version_num: state.target.server_version_num,
      admission: state.admission, execution: 'ISOLATED', activation: 'NOT_GRANTED',
      scope: 'SELECTED_DATABASE_PROJECTION_AND_LISTED_FILES',
      verified_receipt_canonical_sha256: materials.verifiedSha256, material_file_sha256: materials.metadataSha256,
      selected_state_canonical_sha256: backupStateSha256(state), listed_files_canonical_sha256: backupStateSha256(materials.files),
      listed_file_count: materials.files.length,
      runtime_package: { manifest_sha256: pkg.manifestHash, artifact_sha256: pkg.artifactHash,
        node_version: pkg.nodeVersion, resource_inventory_canonical_sha256: backupStateSha256(pkg.resourceHashes) },
      runtime_dependency_probe: runtimeProbe,
      resource_root_identity_probe: resourceRoots,
      content_exclusion: { root_id: content.rootId, sentinel_id: content.sentinelId,
        sentinel_initially_absent: !hadSentinel, observed_while_held: true, session_closed_before_report: true },
      source_backup_attestation: 'STORED_MANIFEST_BINDING_ONLY', source_package_attestation: 'STORED_BINDING_ONLY',
      pending: ['FULL_HISTORICAL_EXECUTION_COMPATIBILITY', 'TARGET_DEPENDENCY_CALLABILITY', 'EXTERNAL_RESOURCE_LIVE_IDENTITY',
        'CONFIGURATION_AND_SINGLE_LOGICAL_OWNER', 'EXPLICIT_ACTIVATION'] };
    await finish(); signal.throwIfAborted(); await materials.assertUnchanged();
    return report;
  } catch (cause) {
    if (cause instanceof RestoreCheckError) throw cause;
    const known = cause instanceof Error && ['RestoreFilesError', 'RestoreDatabaseIsolationError', 'RestoreRuntimeProbeError', 'RestoreResourceRootsError', 'BackupPackageError',
      'BackupStateError', 'BackupWindowsPathsError', 'WindowsContentError'].includes(cause.name)
      ? (cause as Error & { code?: string }).code : undefined;
    throw new RestoreCheckError(signal.aborted ? 'RESTORE_CHECK_ABORTED' :
      typeof known === 'string' && /^[A-Z][A-Z_]+$/u.test(known) ? known : 'RESTORE_CHECK_UNAVAILABLE');
  } finally { await finish(); }
}
