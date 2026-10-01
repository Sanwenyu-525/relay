import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { parseRestoreArguments } from '../../src/cli/restore.js';
import { backupStateSha256 } from '../../src/runtime/backup-state.js';
import { decodeRestoreManifest, RestoreBackupError } from '../../src/runtime/restore-backup.js';
import { prepareRestoreRoot, copyRestoreFile, RestoreFilesError, writeRestoreMetadata } from '../../src/runtime/restore-files.js';
import { assertRestoreNotIsolated } from '../../src/runtime/restore-isolation.js';
import { createHash } from 'node:crypto';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const manifest = { version: 'relay-backup-v1', backup_id: randomUUID(), captured_at: new Date().toISOString(),
    scope: 'LOCAL_DATABASE_AND_MANAGED_CONTENT', admission: { target: 'DATABASE', mode: 'DRAINING', revision: '1' },
    source_package: { manifest_sha256: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64), node_version: 'v24.21.0',
      resource_sha256: { 'api/migrations/0001_core.sql': 'c'.repeat(64) } },
    database: { ref: 'database.dump', size: '5', sha256: 'd'.repeat(64), toolVersion: '18.6', dumpToolSha256: 'e'.repeat(64),
      restoreToolSha256: 'f'.repeat(64), catalogSha256: '0'.repeat(64), target: { database: 'source', database_oid: '42',
        owner_oid: '43', server_address: '127.0.0.1', server_port: '5432', server_version_num: '180006' } },
    files: [{ source_ref: `runtime-launches/${randomUUID()}.json`, backup_ref: '', kind: 'ARMED', size: '4', sha256: '1'.repeat(64) }],
    registry: { ref: 'registry.json', canonical_sha256: '2'.repeat(64) }, state: { ref: 'state.json', canonical_sha256: '3'.repeat(64) },
    maintenance: { desktop_nonce: randomUUID(), stopped_launches: [], content_nonce: randomUUID(), content_root_id: `${'0'.repeat(16)}:${'1'.repeat(32)}`,
      content_sentinel_id: 'sentinel', database_operation_id: randomUUID(), acl_journal_ref: 'maintenance/original-acl.json', recovery: [] },
    exclusions: ['LOCAL_CONFIGURATION_AND_CREDENTIALS', 'EXTERNAL_RESOURCE_CONTENT', 'LOGS'],
    restore_policy: 'NEW_DATABASE_AND_DATA_ROOT_DRAINING_NO_EXTERNAL_REPLAY' };
  manifest.files[0]!.backup_ref = `evidence/${manifest.files[0]!.source_ref}`;
  return manifest;
}
const completion = (manifest: ReturnType<typeof fixture>) => ({ version: 'relay-backup-v1', backup_id: manifest.backup_id,
  manifest_canonical_sha256: backupStateSha256(manifest), admission: 'DRAINING' });
test('restore codec requires exact completion and preserves evidence routing without startup authority', () => {
  const manifest = fixture(); assert.equal(decodeRestoreManifest(manifest, completion(manifest)).files[0]?.kind, 'ARMED');
  for (const mutate of [
    (m: typeof manifest) => { m.files[0]!.backup_ref = `data/${m.files[0]!.source_ref}`; },
    (m: typeof manifest) => { m.files[0]!.source_ref = '../runtime-launches/private'; },
    (m: typeof manifest) => { m.files.push({ ...m.files[0]! }); },
    (m: typeof manifest) => { m.database.ref = '../other.dump'; },
    (m: typeof manifest) => { m.database.size = String(33n * 1024n ** 3n); },
    (m: typeof manifest) => { m.restore_policy = 'AUTO_START'; },
    (m: typeof manifest) => { m.maintenance.content_root_id = 'not-a-windows-file-id'; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => decodeRestoreManifest(changed, completion(changed)), RestoreBackupError);
  }
  assert.throws(() => decodeRestoreManifest(manifest, { ...completion(manifest), backup_id: randomUUID() }), RestoreBackupError);
  assert.throws(() => decodeRestoreManifest(manifest, { ...completion(manifest), admission: 'NORMAL' }), RestoreBackupError);
  const missingTarget = structuredClone(manifest);
  delete (missingTarget.admission as Partial<typeof missingTarget.admission>).target;
  assert.throws(() => decodeRestoreManifest(missingTarget, completion(missingTarget)), RestoreBackupError);
});

test('restore metadata refuses a late restore-directory junction without writing into the original root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-metadata-'));
  try {
    const target = join(root, 'target'), original = join(root, 'original');
    await mkdir(original); const held = await prepareRestoreRoot(target, randomUUID(), { purpose: 'ISOLATED' });
    await mkdir(join(target, 'restore')); await rename(join(target, 'restore'), join(target, 'restore-old'));
    await symlink(original, join(target, 'restore'), 'junction'); await held();
    await assert.rejects(writeRestoreMetadata(join(target, 'restore/verified.json'), { verified: true }));
    await assert.rejects(stat(join(original, 'verified.json')), { code: 'ENOENT' });
    await rm(join(target, 'restore')); // Remove only this owned junction before recursive fixture cleanup.
  } finally { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); }
});
test('restore CLI only accepts five distinct absolute paths and gets target credentials from the environment', () => {
  const argv = ['restore-isolated', '--backup-root', 'D:/backup', '--source-package-root', 'D:/old-package',
    '--runtime-package-root', 'D:/runtime', '--data-root', 'D:/new-data', '--postgres-bin', 'D:/postgres/bin'];
  assert.equal(parseRestoreArguments(argv).dataRoot, 'D:/new-data');
  for (const bad of [argv.slice(0, -2), [...argv, '--url', 'private'], argv.map(v => v === '--data-root' ? '--backup-root' : v),
    argv.map(v => v === 'D:/new-data' ? './relative' : v)]) assert.throws(() => parseRestoreArguments(bad));
});
test('fresh root is published already isolated, keeps marker identity and refuses occupied targets', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-restore-files-')), root = join(base, 'data');
  try {
    const held = await prepareRestoreRoot(root, randomUUID(), { restore_id: 'original', state: 'ISOLATED' });
    await assert.rejects(assertRestoreNotIsolated(root), { code: 'RESTORE_ISOLATED' });
    await held();
    await assert.rejects(() => prepareRestoreRoot(root, randomUUID(), {}), (e: unknown) =>
      e instanceof RestoreFilesError && e.code === 'RESTORE_TARGET_EXISTS');
    await writeFile(join(root, 'restore-isolation.json'), 'changed');
    await assert.rejects(held(), (e: unknown) => e instanceof RestoreFilesError && e.code === 'RESTORE_FILES_CHANGED');
    await assert.rejects(stat(join(root, 'runtime-launches')), { code: 'ENOENT' });
  } finally { assert.equal(dirname(base), tmpdir()); await rm(base, { recursive: true, force: true }); }
});
test('restore copies exact bytes to evidence, never overwrites and preserves a partial file on mismatch', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-restore-files-'));
  try {
    const source = join(base, 'backup'), target = join(base, 'data'); await mkdir(source); await mkdir(target);
    const ref = `${randomUUID()}.json`, bytes = Buffer.from('opaque source ARMED'); await writeFile(join(source, ref), bytes);
    const file = { ref, size: String(bytes.length), sha256: hash(bytes) };
    await copyRestoreFile(source, file, target, `evidence/runtime-launches/${ref}`, new AbortController().signal, async () => {});
    assert.deepEqual(await readFile(join(target, 'evidence/runtime-launches', ref)), bytes);
    await assert.rejects(() => copyRestoreFile(source, file, target, `evidence/runtime-launches/${ref}`,
      new AbortController().signal, async () => {}), { code: 'EEXIST' });
    await assert.rejects(() => copyRestoreFile(source, { ...file, sha256: 'a'.repeat(64) }, target, 'evidence/partial.json',
      new AbortController().signal, async () => {}), RestoreFilesError);
    assert.deepEqual(await readFile(join(target, 'evidence/partial.json')), bytes);
    await assert.rejects(stat(join(target, 'runtime-launches')), { code: 'ENOENT' });
  } finally { assert.equal(dirname(base), tmpdir()); await rm(base, { recursive: true, force: true }); }
});
