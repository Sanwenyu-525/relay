import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BigIntStats } from 'node:fs';

import { inspectBackupRegistryArchive } from './backup-package.js';
import { backupStateSha256 } from './backup-state.js';
import { decodeStoredRestoreManifest, decodeStoredRestoreState } from './restore-backup.js';
import { decodeRestoreDatabaseIsolationJournal } from './restore-database-isolation.js';
import type { DatabaseMaintenanceTarget } from './database-connect-fence.js';
import { plainRestoreDirectory, readRestoreMetadata, safeRestoreRef } from './restore-files.js';

export class RestoreCheckError extends Error {
  override readonly name = 'RestoreCheckError';
  constructor(readonly code = 'RESTORE_CHECK_UNAVAILABLE') { super(code); }
}
export const RESTORE_MATERIAL_REFS = ['restore-isolation.json', 'restore/verified.json', 'restore/manifest.json',
  'restore/source-state.json', 'restore/registry.json', 'restore/target-acl.json'] as const;
type MaterialRef = typeof RESTORE_MATERIAL_REFS[number];
type MaterialBytes = Readonly<Record<MaterialRef, Buffer>>;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TARGET_KEYS = ['database', 'database_oid', 'owner_oid', 'app_oid', 'server_address', 'server_port'];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function invalid(): never { throw new RestoreCheckError('RESTORE_CHECK_MATERIALS_INVALID'); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function packageRecord(value: unknown): boolean {
  return exact(value, ['manifest_sha256', 'artifact_sha256', 'node_version', 'resource_sha256']) &&
    typeof value.manifest_sha256 === 'string' && HASH.test(value.manifest_sha256) &&
    typeof value.artifact_sha256 === 'string' && HASH.test(value.artifact_sha256) &&
    typeof value.node_version === 'string' && /^v24\.\d+\.\d+$/u.test(value.node_version) &&
    value.resource_sha256 !== null && typeof value.resource_sha256 === 'object' && !Array.isArray(value.resource_sha256) &&
    Object.keys(value.resource_sha256).length <= 100_000 && Object.entries(value.resource_sha256).every(([ref, hash]) =>
      safeRestoreRef(ref) && typeof hash === 'string' && HASH.test(hash));
}

/** Validates only local persisted evidence. It neither authenticates a publisher nor grants activation. */
export function decodeRestoreMaterials(bytes: MaterialBytes) {
  try {
    const values = new Map<MaterialRef, unknown>();
    for (const ref of RESTORE_MATERIAL_REFS) {
      const raw = bytes[ref];
      if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 24 * 1024 * 1024) invalid();
      values.set(ref, JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)));
    }
    const receipt = values.get('restore/verified.json');
    if (!exact(receipt, ['version', 'restore_id', 'backup_id', 'backup_manifest_canonical_sha256', 'source_package',
      'runtime_package', 'source_target', 'target', 'restored_state_canonical_sha256', 'files', 'admission', 'execution',
      'external_resource_policy', 'armed_policy']) || receipt.version !== 'relay-isolated-restore-v1' ||
      typeof receipt.restore_id !== 'string' || !UUID.test(receipt.restore_id) ||
      typeof receipt.backup_id !== 'string' || !UUID.test(receipt.backup_id) ||
      typeof receipt.backup_manifest_canonical_sha256 !== 'string' || !HASH.test(receipt.backup_manifest_canonical_sha256) ||
      typeof receipt.restored_state_canonical_sha256 !== 'string' || !HASH.test(receipt.restored_state_canonical_sha256) ||
      receipt.admission !== 'DRAINING' || receipt.execution !== 'ISOLATED' ||
      receipt.external_resource_policy !== 'HISTORICAL_IDENTITY_NO_REPLAY' ||
      receipt.armed_policy !== 'EVIDENCE_ONLY_NO_JOB_RECOVERY' || !packageRecord(receipt.source_package) ||
      !packageRecord(receipt.runtime_package)) invalid();
    const manifest = decodeStoredRestoreManifest(values.get('restore/manifest.json'), receipt.backup_id,
      receipt.backup_manifest_canonical_sha256);
    const registry = inspectBackupRegistryArchive(values.get('restore/registry.json'));
    const sourceState = decodeStoredRestoreState(values.get('restore/source-state.json'), manifest, registry);
    if (backupStateSha256(receipt.source_package) !== backupStateSha256(manifest.source_package) ||
        backupStateSha256(receipt.source_target) !== backupStateSha256(sourceState.target)) invalid();
    const marker = values.get('restore-isolation.json');
    if (!exact(marker, ['version', 'purpose', 'restore_id', 'backup_id', 'manifest_canonical_sha256']) ||
        marker.version !== 'relay-restore-isolation-v1' || marker.purpose !== 'RESTORE_TARGET_KEEP_ISOLATED' ||
        marker.restore_id !== receipt.restore_id || marker.backup_id !== receipt.backup_id ||
        marker.manifest_canonical_sha256 !== receipt.backup_manifest_canonical_sha256) invalid();
    const journal = decodeRestoreDatabaseIsolationJournal(bytes['restore/target-acl.json']);
    if (!exact(receipt.target, TARGET_KEYS) || Object.values(receipt.target).some(value => typeof value !== 'string') ||
        journal.operation_id !== receipt.restore_id ||
        backupStateSha256(journal.target) !== backupStateSha256(receipt.target) ||
        Object.entries(journal.source_target).some(([key, value]) => sourceState.target[key] !== value)) invalid();
    const files = manifest.files.map(file => ({ ref: file.kind === 'CONTENT' ? file.source_ref : `evidence/${file.source_ref}`,
      size: file.size, sha256: file.sha256 }));
    if (backupStateSha256(receipt.files) !== backupStateSha256(files)) invalid();
    return { restoreId: receipt.restore_id, backupId: receipt.backup_id, manifest, sourceState, registry, files,
      target: journal.target as DatabaseMaintenanceTarget, journal, runtimePackage: receipt.runtime_package,
      stateSha256: receipt.restored_state_canonical_sha256, verifiedSha256: backupStateSha256(receipt),
      metadataSha256: Object.fromEntries(RESTORE_MATERIAL_REFS.map(ref => [ref, sha(bytes[ref])])) };
  } catch { invalid(); }
}

function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return same(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Pins local identities as well as bytes. Content-lock creation may change root mtime, but never root identity. */
export async function readRestoreMaterials(root: string, signal: AbortSignal) {
  try {
    signal.throwIfAborted(); await plainRestoreDirectory(root); await plainRestoreDirectory(join(root, 'restore'));
    const rootId = await lstat(root, { bigint: true }), directoryId = await lstat(join(root, 'restore'), { bigint: true });
    const raw: Partial<Record<MaterialRef, Buffer>> = {}, identities = new Map<MaterialRef, BigIntStats>();
    for (const ref of RESTORE_MATERIAL_REFS) {
      const before = await lstat(join(root, ref), { bigint: true });
      raw[ref] = await readRestoreMetadata(root, ref, signal);
      if (!unchanged(before, await lstat(join(root, ref), { bigint: true }))) invalid();
      identities.set(ref, before);
    }
    const materials = decodeRestoreMaterials(raw as MaterialBytes);
    const assertUnchanged = async (): Promise<void> => {
      try {
        signal.throwIfAborted(); await plainRestoreDirectory(root); await plainRestoreDirectory(join(root, 'restore'));
        if (!same(rootId, await lstat(root, { bigint: true })) ||
            !same(directoryId, await lstat(join(root, 'restore'), { bigint: true }))) invalid();
        for (const ref of RESTORE_MATERIAL_REFS) {
          if (!unchanged(identities.get(ref)!, await lstat(join(root, ref), { bigint: true })) ||
              !(await readRestoreMetadata(root, ref, signal)).equals(raw[ref]!)) invalid();
        }
      } catch { throw new RestoreCheckError(signal.aborted ? 'RESTORE_CHECK_ABORTED' : 'RESTORE_CHECK_MATERIALS_CHANGED'); }
    };
    await assertUnchanged();
    return { ...materials, assertUnchanged };
  } catch (cause) {
    if (cause instanceof RestoreCheckError) throw cause;
    throw new RestoreCheckError(signal.aborted ? 'RESTORE_CHECK_ABORTED' : 'RESTORE_CHECK_MATERIALS_INVALID');
  }
}
