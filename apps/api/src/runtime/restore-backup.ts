import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { CONTENT_IDENTITY } from '../storage/windows-content-publisher.js';

import type { BackupDataFile } from './backup-files.js';
import { inspectBackupRegistryArchive } from './backup-package.js';
import type { FirstPartyRegistryArchive } from '../skills/first-party-registry.js';
import { assertBackupContentReferences, backupStateSha256, type BackupDatabaseState } from './backup-state.js';
import { decodeDatabaseFenceJournal } from './database-connect-fence.js';
import { assertRestoreInventory, readRestoreMetadata, safeRestoreRef, verifyRestoreFiles } from './restore-files.js';

export class RestoreBackupError extends Error {
  override readonly name = 'RestoreBackupError';
  constructor(readonly code = 'RESTORE_BACKUP_INVALID') { super(code); }
}
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const count = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value);
const hash = (value: unknown) => typeof value === 'string' && HASH.test(value);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function invalid(): never { throw new RestoreBackupError(); }
export interface RestoreBackupManifest {
  readonly version: 'relay-backup-v1'; readonly backup_id: string;
  readonly admission: { readonly target: 'DATABASE'; readonly mode: 'DRAINING'; readonly revision: string };
  readonly source_package: { readonly manifest_sha256: string; readonly artifact_sha256: string;
    readonly node_version: string; readonly resource_sha256: Readonly<Record<string, string>> };
  readonly database: { readonly ref: 'database.dump'; readonly size: string; readonly sha256: string;
    readonly toolVersion: string; readonly dumpToolSha256: string; readonly restoreToolSha256: string;
    readonly catalogSha256: string; readonly target: Record<string, string> };
  readonly files: readonly BackupDataFile[];
  readonly registry: { readonly ref: 'registry.json'; readonly canonical_sha256: string };
  readonly state: { readonly ref: 'state.json'; readonly canonical_sha256: string };
  readonly maintenance: { readonly content_root_id: string; readonly database_operation_id: string; readonly acl_journal_ref: string };
}
/** Shared shape/routing validation; the callers separately bind their own persisted evidence. */
function decodeManifestValue(value: unknown): RestoreBackupManifest {
  try {
    if (!exact(value, ['version', 'backup_id', 'captured_at', 'scope', 'admission', 'source_package', 'database',
      'files', 'registry', 'state', 'maintenance', 'exclusions', 'restore_policy']) || value.version !== 'relay-backup-v1' ||
      typeof value.backup_id !== 'string' || !UUID.test(value.backup_id) || typeof value.captured_at !== 'string' ||
      !Number.isFinite(Date.parse(value.captured_at)) || value.scope !== 'LOCAL_DATABASE_AND_MANAGED_CONTENT' ||
      value.restore_policy !== 'NEW_DATABASE_AND_DATA_ROOT_DRAINING_NO_EXTERNAL_REPLAY') invalid();
    const pkg = value.source_package, db = value.database;
    if (!exact(pkg, ['manifest_sha256', 'artifact_sha256', 'node_version', 'resource_sha256']) ||
      !hash(pkg.manifest_sha256) || !hash(pkg.artifact_sha256) || typeof pkg.node_version !== 'string' ||
      !/^v24\.\d+\.\d+$/u.test(pkg.node_version) || !object(pkg.resource_sha256) ||
      Object.keys(pkg.resource_sha256).length > 100_000 || Object.entries(pkg.resource_sha256).some(([ref, sha]) => !safeRestoreRef(ref) || !hash(sha))) invalid();
    if (!exact(db, ['ref', 'size', 'sha256', 'toolVersion', 'dumpToolSha256', 'restoreToolSha256', 'catalogSha256', 'target']) ||
      db.ref !== 'database.dump' || !count(db.size) || BigInt(db.size as string) < 5n || BigInt(db.size as string) > 32n * 1024n ** 3n ||
      ![db.sha256, db.dumpToolSha256, db.restoreToolSha256, db.catalogSha256].every(hash) ||
      typeof db.toolVersion !== 'string' || !/^18\.[0-9]+$/u.test(db.toolVersion) ||
      !exact(db.target, ['database', 'database_oid', 'owner_oid', 'server_address', 'server_port', 'server_version_num']) ||
      Object.values(db.target).some(v => typeof v !== 'string' || v.length === 0 || v.length > 128) ||
      !/^18\d{4}$/u.test(String(db.target.server_version_num))) invalid();
    for (const [item, ref] of [[value.registry, 'registry.json'], [value.state, 'state.json']] as const) {
      if (!exact(item, ['ref', 'canonical_sha256']) || item.ref !== ref || !hash(item.canonical_sha256)) invalid();
    }
    const seen = new Set<string>(); let totalRefBytes = 0;
    if (!Array.isArray(value.files) || value.files.length > 100_000) invalid();
    for (const file of value.files) {
      if (!exact(file, ['source_ref', 'backup_ref', 'kind', 'size', 'sha256']) || typeof file.source_ref !== 'string' ||
        !safeRestoreRef(file.source_ref) || typeof file.backup_ref !== 'string' || !safeRestoreRef(file.backup_ref) ||
        !count(file.size) || !hash(file.sha256) || !['CONTENT', 'STAGING', 'ARMED'].includes(String(file.kind)) ||
        file.backup_ref !== `${file.kind === 'CONTENT' ? 'data' : 'evidence'}/${file.source_ref}` ||
        !file.source_ref.startsWith(`${file.kind === 'CONTENT' ? 'artifacts' : file.kind === 'STAGING' ? 'staging' : 'runtime-launches'}/`) ||
        (file.kind === 'ARMED' && !/^runtime-launches\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(file.source_ref)) ||
        BigInt(file.size as string) > BigInt(file.kind === 'ARMED' ? 64 * 1024 : 256 * 1024) ||
        seen.has(file.backup_ref.toLowerCase()) || (totalRefBytes += Buffer.byteLength(file.backup_ref)) > 16 * 1024 * 1024) invalid();
      seen.add(file.backup_ref.toLowerCase());
    }
    if (!exact(value.maintenance, ['desktop_nonce', 'stopped_launches', 'content_nonce', 'content_root_id',
      'content_sentinel_id', 'database_operation_id', 'acl_journal_ref', 'recovery']) ||
      value.maintenance.acl_journal_ref !== 'maintenance/original-acl.json' ||
      typeof value.maintenance.content_root_id !== 'string' || !CONTENT_IDENTITY.test(value.maintenance.content_root_id) ||
      typeof value.maintenance.database_operation_id !== 'string' || !UUID.test(value.maintenance.database_operation_id)) invalid();
    if (!exact(value.admission, ['target', 'mode', 'revision']) || value.admission.target !== 'DATABASE' ||
      value.admission.mode !== 'DRAINING' || !count(value.admission.revision) ||
      !Array.isArray(value.exclusions) || value.exclusions.join('|') !== 'LOCAL_CONFIGURATION_AND_CREDENTIALS|EXTERNAL_RESOURCE_CONTENT|LOGS') invalid();
    return value as unknown as RestoreBackupManifest;
  } catch { invalid(); }
}
/** A source backup still requires its actual complete record. */
export function decodeRestoreManifest(value: unknown, completion: unknown): RestoreBackupManifest {
  const manifest = decodeManifestValue(value);
  if (!exact(completion, ['version', 'backup_id', 'manifest_canonical_sha256', 'admission']) ||
      completion.version !== manifest.version || completion.backup_id !== manifest.backup_id ||
      completion.admission !== 'DRAINING' || completion.manifest_canonical_sha256 !== backupStateSha256(value)) invalid();
  return manifest;
}
/** Local restore metadata is bound to a separate verified receipt, never fabricated backup completion. */
export function decodeStoredRestoreManifest(value: unknown, backupId: string, canonicalSha256: string): RestoreBackupManifest {
  const manifest = decodeManifestValue(value);
  if (manifest.backup_id !== backupId || !hash(canonicalSha256) || backupStateSha256(value) !== canonicalSha256) invalid();
  return manifest;
}
/** Validate the persisted source projection without reading its original database or fabricating facts. */
export function decodeStoredRestoreState(state: unknown, manifest: RestoreBackupManifest,
  registry: FirstPartyRegistryArchive): BackupDatabaseState {
  const fields = ['target', 'admission', 'migrations', 'graph_versions', 'artifacts', 'workers', 'unresolved_effects',
    'unresolved_operations', 'unresolved_invocations', 'unresolved_model_calls', 'external_resources', 'stored_skills', 'stored_packs'];
  if (!exact(state, fields) || backupStateSha256(state) !== manifest.state.canonical_sha256 ||
    backupStateSha256(registry) !== manifest.registry.canonical_sha256 || backupStateSha256(state.target) !== backupStateSha256(manifest.database.target) ||
    !exact(state.admission, ['mode', 'revision']) || state.admission.mode !== 'DRAINING' || !count(state.admission.revision) ||
    state.admission.mode !== manifest.admission.mode || state.admission.revision !== manifest.admission.revision ||
    fields.filter(key => !['target', 'admission'].includes(key)).some(key => !Array.isArray(state[key]) || (state[key] as unknown[]).length > 100_000)) invalid();
  const typedState = state as unknown as BackupDatabaseState;
  const packagedMigrations = Object.keys(manifest.source_package.resource_sha256)
    .filter(ref => /^api\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(ref)).sort();
  if (typedState.graph_versions.some(v => typeof v !== 'number') || typedState.graph_versions.join(',') !== '0,1,2,3,4' ||
    typedState.migrations.length === 0 || typedState.migrations.length !== packagedMigrations.length ||
    typedState.migrations.some((m, index) => !exact(m, ['name', 'sha256']) ||
    typeof m.name !== 'string' || !/^\d{4}_[a-z0-9_]+$/u.test(m.name) || !hash(m.sha256) ||
    packagedMigrations[index] !== `api/migrations/${m.name}.sql` ||
    manifest.source_package.resource_sha256[packagedMigrations[index]!] !== m.sha256)) invalid();
  assertBackupContentReferences(typedState, manifest.files);
  return typedState;
}
export async function readRestoreBackup(root: string, signal: AbortSignal): Promise<{
  manifest: RestoreBackupManifest; manifestSha256: string; state: BackupDatabaseState;
  registry: FirstPartyRegistryArchive; metadataHashes: Readonly<Record<string, string>>;
}> {
  const names = ['manifest.json', 'complete.json', 'incomplete.json', 'registry.json', 'state.json', 'maintenance/original-acl.json'];
  const bytes = new Map<string, Buffer>(), parsed = new Map<string, unknown>();
  for (const name of names) {
    const raw = await readRestoreMetadata(root, name, signal); bytes.set(name, raw);
    try { parsed.set(name, JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw))); } catch { invalid(); }
  }
  const manifest = decodeRestoreManifest(parsed.get(names[0]!), parsed.get(names[1]!));
  const incomplete = parsed.get('incomplete.json');
  if (!exact(incomplete, ['version', 'backup_id']) || incomplete.version !== manifest.version || incomplete.backup_id !== manifest.backup_id) invalid();
  const registry = inspectBackupRegistryArchive(parsed.get('registry.json'));
  const typedState = decodeStoredRestoreState(parsed.get('state.json'), manifest, registry);
  const journal = decodeDatabaseFenceJournal(bytes.get('maintenance/original-acl.json')!);
  if (journal.operation_id !== manifest.maintenance.database_operation_id ||
    Object.entries(journal.target).filter(([key]) => key !== 'app_oid').some(([key, value]) => manifest.database.target[key] !== value)) invalid();
  await assertRestoreInventory(root, [...names, 'database.dump', ...manifest.files.map(file => file.backup_ref)]);
  await verifyRestoreFiles(root, [{ ref: 'database.dump', size: manifest.database.size, sha256: manifest.database.sha256 },
    ...manifest.files.map(file => ({ ref: file.backup_ref, size: file.size, sha256: file.sha256 }))], signal, async () => signal.throwIfAborted());
  return { manifest, manifestSha256: backupStateSha256(manifest), state: typedState, registry,
    metadataHashes: Object.fromEntries([...bytes].map(([name, raw]) => [name, createHash('sha256').update(raw).digest('hex')])) };
}
