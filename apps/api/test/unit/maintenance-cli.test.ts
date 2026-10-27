import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseMaintenanceArguments } from '../../src/cli/maintenance.js';
import { sealDesktopBuildManifest } from '../../src/runtime/desktop-maintenance-session.js';

test('maintenance CLI requires exact action, original UUID and explicit CAS', () => {
  const commandId = randomUUID();
  assert.deepEqual(parseMaintenanceArguments(['status']), { action: 'status' });
  assert.deepEqual(parseMaintenanceArguments(['begin-drain', '--command-id', commandId,
    '--expected-revision', '0']), { action: 'begin-drain', commandId, expectedRevision: '0' });
  assert.deepEqual(parseMaintenanceArguments(['resume-admission', '--expected-revision', '1',
    '--command-id', commandId]), { action: 'resume-admission', commandId, expectedRevision: '1' });
  for (const argv of [[], ['status', '--command-id', commandId], ['freeze'],
    ['begin-drain'], ['begin-drain', '--command-id', commandId],
    ['begin-drain', '--command-id', commandId, '--expected-revision', '-1'],
    ['begin-drain', '--command-id', commandId, '--expected-revision', '0', '--bypass', 'true'],
    ['begin-drain', '--command-id', commandId, '--command-id', commandId,
      '--expected-revision', '0']]) assert.throws(() => parseMaintenanceArguments(argv));
});

test('desktop stop CLI requires explicit package/data roots and has no freeze or bypass flag', () => {
  const packageRoot = join(tmpdir(), 'relay-package');
  const dataRoot = join(tmpdir(), 'relay-data');
  assert.deepEqual(parseMaintenanceArguments(['hold-desktop-stop', '--package-root', packageRoot,
    '--data-root', dataRoot]), { action: 'hold-desktop-stop', packageRoot, dataRoot });
  for (const argv of [
    ['hold-desktop-stop'], ['hold-desktop-stop', '--package-root', packageRoot],
    ['hold-desktop-stop', '--package-root', 'relative', '--data-root', dataRoot],
    ['hold-desktop-stop', '--package-root', packageRoot, '--data-root', dataRoot, '--freeze', 'true'],
    ['hold-desktop-stop', '--package-root', packageRoot, '--package-root', packageRoot, '--data-root', dataRoot],
  ]) assert.throws(() => parseMaintenanceArguments(argv));
});

test('install sealing accepts only an absolute package root', () => {
  const packageRoot = join(tmpdir(), 'relay-package');
  assert.deepEqual(parseMaintenanceArguments(['seal-install', '--package-root', packageRoot]),
    { action: 'seal-install', packageRoot });
  for (const argv of [[], ['seal-install'], ['seal-install', '--package-root', 'relative'],
    ['seal-install', '--package-root', packageRoot, '--data-root', packageRoot]]) {
    assert.throws(() => parseMaintenanceArguments(argv));
  }
});

test('install sealing binds the manifest to the installed EXE bytes, not the build copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-install-seal-'));
  try {
    const executable = join(root, 'relay-desktop.exe');
    await writeFile(executable, 'patched-installed-bytes');
    await writeFile(join(root, 'desktop-build-manifest.json'), JSON.stringify({
      schema_version: 1,
      maintenance_session_protocol: 'relay-desktop-maintenance-v1',
      artifact_sha256: '0'.repeat(64),
      built_at_utc: '2026-10-27T00:00:00.0000000Z',
    }));
    const artifact = await sealDesktopBuildManifest(root);
    const expected = createHash('sha256').update('patched-installed-bytes').digest('hex');
    assert.equal(artifact, expected);
    const sealed = JSON.parse(await readFile(join(root, 'desktop-build-manifest.json'), 'utf8'));
    assert.equal(sealed.artifact_sha256, expected);
    assert.equal(sealed.built_at_utc, '2026-10-27T00:00:00.0000000Z');
    await assert.rejects(sealDesktopBuildManifest(join(root, 'missing')));
    await writeFile(join(root, 'desktop-build-manifest.json'), JSON.stringify({
      schema_version: 1, maintenance_session_protocol: 'other-protocol', artifact_sha256: '0'.repeat(64),
    }));
    await assert.rejects(sealDesktopBuildManifest(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
