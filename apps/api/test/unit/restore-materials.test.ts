import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { parseRestoreCheckArguments } from '../../src/cli/restore-check.js';
import { exportFirstPartyRegistryArchive } from '../../src/skills/first-party-registry.js';
import { backupStateSha256, type BackupDatabaseState } from '../../src/runtime/backup-state.js';
import { decodeRestoreManifest, decodeStoredRestoreManifest } from '../../src/runtime/restore-backup.js';
import { checkIsolatedRestore } from '../../src/runtime/restore-check.js';
import { decodeRestoreMaterials, readRestoreMaterials, RestoreCheckError } from '../../src/runtime/restore-materials.js';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreCheckError &&
  cause.code === code && cause.message === code;
function fixture() {
  const sourceTarget = { database: 'source', database_oid: '101', owner_oid: '10',
    server_address: '127.0.0.1', server_port: '5432', server_version_num: '180006' };
  const target = { database: 'target', database_oid: '102', owner_oid: '10', app_oid: '11',
    server_address: '127.0.0.1', server_port: '5432' };
  const registry = exportFirstPartyRegistryArchive();
  const state: BackupDatabaseState = { target: sourceTarget, admission: { mode: 'DRAINING', revision: '1' },
    migrations: [{ name: '0001_core', sha256: 'a'.repeat(64) }], graph_versions: [0, 1, 2, 3, 4], artifacts: [],
    workers: [], unresolved_effects: [], unresolved_operations: [], unresolved_invocations: [],
    unresolved_model_calls: [], external_resources: [], stored_skills: [], stored_packs: [] };
  const pkg = { manifest_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64), node_version: 'v24.21.0',
    resource_sha256: { 'api/migrations/0001_core.sql': 'a'.repeat(64) } };
  const manifest = { version: 'relay-backup-v1', backup_id: randomUUID(), captured_at: new Date().toISOString(),
    scope: 'LOCAL_DATABASE_AND_MANAGED_CONTENT', admission: { target: 'DATABASE', ...state.admission }, source_package: pkg,
    database: { ref: 'database.dump', size: '5', sha256: 'd'.repeat(64), toolVersion: '18.6', dumpToolSha256: 'e'.repeat(64),
      restoreToolSha256: 'f'.repeat(64), catalogSha256: '0'.repeat(64), target: sourceTarget },
    files: [{ source_ref: `runtime-launches/${randomUUID()}.json`, backup_ref: '', kind: 'ARMED', size: '4', sha256: '1'.repeat(64) }],
    registry: { ref: 'registry.json', canonical_sha256: backupStateSha256(registry) },
    state: { ref: 'state.json', canonical_sha256: backupStateSha256(state) },
    maintenance: { desktop_nonce: randomUUID(), stopped_launches: [], content_nonce: randomUUID(),
      content_root_id: `${'0'.repeat(16)}:${'1'.repeat(32)}`, content_sentinel_id: 'archived-only',
      database_operation_id: randomUUID(), acl_journal_ref: 'maintenance/original-acl.json', recovery: [] },
    exclusions: ['LOCAL_CONFIGURATION_AND_CREDENTIALS', 'EXTERNAL_RESOURCE_CONTENT', 'LOGS'],
    restore_policy: 'NEW_DATABASE_AND_DATA_ROOT_DRAINING_NO_EXTERNAL_REPLAY' };
  manifest.files[0]!.backup_ref = `evidence/${manifest.files[0]!.source_ref}`;
  const restoreId = randomUUID(), manifestSha = backupStateSha256(manifest);
  const record = { version: 'relay-restore-database-isolation-v1', purpose: 'RESTORE_TARGET_KEEP_ISOLATED',
    operation_id: restoreId, source_target: { database: sourceTarget.database, database_oid: sourceTarget.database_oid,
      owner_oid: sourceTarget.owner_oid, server_address: sourceTarget.server_address, server_port: sourceTarget.server_port }, target,
    original_acl: [{ grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false },
      { grantee: '0', grantor: '10', privilege: 'CONNECT', grantable: false }],
    fenced_acl: [{ grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false }] };
  const receipt = { version: 'relay-isolated-restore-v1', restore_id: restoreId, backup_id: manifest.backup_id,
    backup_manifest_canonical_sha256: manifestSha, source_package: pkg, runtime_package: pkg, source_target: sourceTarget,
    target, restored_state_canonical_sha256: backupStateSha256({ ...state, target: { ...sourceTarget, ...target } }),
    files: manifest.files.map(file => ({ ref: `evidence/${file.source_ref}`, size: file.size, sha256: file.sha256 })),
    admission: 'DRAINING', execution: 'ISOLATED', external_resource_policy: 'HISTORICAL_IDENTITY_NO_REPLAY',
    armed_policy: 'EVIDENCE_ONLY_NO_JOB_RECOVERY' };
  const marker = { version: 'relay-restore-isolation-v1', purpose: 'RESTORE_TARGET_KEEP_ISOLATED',
    restore_id: restoreId, backup_id: manifest.backup_id, manifest_canonical_sha256: manifestSha };
  const bytes = { 'restore-isolation.json': Buffer.from(JSON.stringify(marker)),
    'restore/verified.json': Buffer.from(JSON.stringify(receipt)), 'restore/manifest.json': Buffer.from(JSON.stringify(manifest)),
    'restore/source-state.json': Buffer.from(JSON.stringify(state)), 'restore/registry.json': Buffer.from(JSON.stringify(registry)),
    'restore/target-acl.json': Buffer.from(JSON.stringify({ record, sha256: sha(JSON.stringify(record)) })) };
  return { bytes, manifest, receipt, marker, record, state };
}

test('stored materials bind independent receipt, marker, source projection and target journal without granting activation', () => {
  const f = fixture(), result = decodeRestoreMaterials(f.bytes);
  assert.equal(result.restoreId, f.receipt.restore_id); assert.deepEqual(result.target, f.record.target);
  assert.deepEqual(result.files, f.receipt.files); assert.equal(result.verifiedSha256, backupStateSha256(f.receipt));
  assert.equal(result.metadataSha256['restore/verified.json'], sha(f.bytes['restore/verified.json']));
  assert.equal(Object.hasOwn(result, 'activation'), false);
});
test('stored manifest binding never makes a source backup complete', () => {
  const f = fixture();
  assert.equal(decodeStoredRestoreManifest(f.manifest, f.manifest.backup_id,
    f.receipt.backup_manifest_canonical_sha256).backup_id, f.manifest.backup_id);
  for (const completion of [undefined, {}, { version: 'relay-backup-v1', backup_id: f.manifest.backup_id,
    manifest_canonical_sha256: f.receipt.backup_manifest_canonical_sha256, admission: 'NORMAL' }]) {
    assert.throws(() => decodeRestoreManifest(f.manifest, completion));
  }
  assert.throws(() => decodeStoredRestoreManifest(f.manifest, randomUUID(), f.receipt.backup_manifest_canonical_sha256));
  assert.throws(() => decodeStoredRestoreManifest(f.manifest, f.manifest.backup_id, '0'.repeat(64)));
});
test('marker, receipt and journal mismatches and credential fields refuse with a fixed safe error', () => {
  for (const replace of [
    (f: ReturnType<typeof fixture>) => ['restore-isolation.json', { ...f.marker, purpose: 'RESUME' }] as const,
    (f: ReturnType<typeof fixture>) => ['restore/verified.json', { ...f.receipt, activation: 'GRANTED' }] as const,
    (f: ReturnType<typeof fixture>) => ['restore/verified.json', { ...f.receipt, execution: 'NORMAL' }] as const,
    (f: ReturnType<typeof fixture>) => ['restore/verified.json', { ...f.receipt, migration_url: 'private-secret' }] as const,
  ]) {
    const f = fixture(), [ref, value] = replace(f); f.bytes[ref] = Buffer.from(JSON.stringify(value));
    assert.throws(() => decodeRestoreMaterials(f.bytes), refusal('RESTORE_CHECK_MATERIALS_INVALID'));
  }
  const f = fixture(); f.record.operation_id = randomUUID();
  f.bytes['restore/target-acl.json'] = Buffer.from(JSON.stringify({ record: f.record, sha256: sha(JSON.stringify(f.record)) }));
  assert.throws(() => decodeRestoreMaterials(f.bytes), refusal('RESTORE_CHECK_MATERIALS_INVALID'));
});
test('a rehashed manifest and receipt cannot route archived ARMED into active launches', () => {
  const f = fixture(); f.manifest.files[0]!.backup_ref = `data/${f.manifest.files[0]!.source_ref}`;
  f.receipt.backup_manifest_canonical_sha256 = backupStateSha256(f.manifest);
  f.marker.manifest_canonical_sha256 = f.receipt.backup_manifest_canonical_sha256;
  f.receipt.files[0]!.ref = f.manifest.files[0]!.source_ref;
  f.bytes['restore/manifest.json'] = Buffer.from(JSON.stringify(f.manifest));
  f.bytes['restore/verified.json'] = Buffer.from(JSON.stringify(f.receipt));
  f.bytes['restore-isolation.json'] = Buffer.from(JSON.stringify(f.marker));
  assert.throws(() => decodeRestoreMaterials(f.bytes), refusal('RESTORE_CHECK_MATERIALS_INVALID'));
});
test('invalid UTF8, oversized metadata and state/registry drift are rejected before live work', () => {
  for (const [ref, value] of [
    ['restore/verified.json', Buffer.from([0xff])], ['restore-isolation.json', Buffer.alloc(24 * 1024 * 1024 + 1)],
    ['restore/source-state.json', Buffer.from('{}')], ['restore/registry.json', Buffer.from('{}')],
  ] as const) {
    const f = fixture(); f.bytes[ref] = value;
    assert.throws(() => decodeRestoreMaterials(f.bytes), refusal('RESTORE_CHECK_MATERIALS_INVALID'));
  }
});
test('CLI has two local path inputs, rejects credential or bypass flags and aborts before IO', async () => {
  const args = ['restore-check-isolated', '--data-root', 'D:/restored', '--runtime-package-root', 'D:/release'];
  assert.equal(parseRestoreCheckArguments(args).dataRoot, 'D:/restored');
  for (const bad of [args.slice(0, -2), [...args, '--url', 'private'], args.map(v => v === '--data-root' ? '--runtime-package-root' : v),
    args.map(v => v === 'D:/restored' ? './relative' : v)]) assert.throws(() => parseRestoreCheckArguments(bad));
  const controller = new AbortController(); controller.abort(new Error('private-secret'));
  await assert.rejects(checkIsolatedRestore({ dataRoot: 'must not open', runtimePackageRoot: 'must not open',
    migrationUrl: 'must not parse', signal: controller.signal }), refusal('RESTORE_CHECK_ABORTED'));
});
test('metadata revalidation refuses same-byte leaf replacement without changing the marker or source evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-materials-unit-')), f = fixture();
  try {
    await mkdir(join(root, 'restore'));
    for (const [ref, bytes] of Object.entries(f.bytes)) await writeFile(join(root, ref), bytes);
    const materials = await readRestoreMaterials(root, new AbortController().signal); await materials.assertUnchanged();
    const ref = 'restore/verified.json', path = join(root, ref), bytes = await readFile(path);
    await rename(path, `${path}.old`); await writeFile(path, bytes);
    await assert.rejects(materials.assertUnchanged(), refusal('RESTORE_CHECK_MATERIALS_CHANGED'));
    assert.deepEqual(await readFile(join(root, 'restore-isolation.json')), f.bytes['restore-isolation.json']);
    assert.deepEqual(await readFile(path), bytes);
  } finally { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); }
});
