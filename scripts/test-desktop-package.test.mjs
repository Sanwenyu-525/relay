import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const verifier = fileURLToPath(new URL('./verify-desktop-package.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
test('package verification rejects changed resources and paths outside the package', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'relay-package-check-'));
  const root = path.join(base, 'package');
  mkdirSync(root);
  const manifest = {
    schema_version: 1,
    artifact_sha256: hash('desktop'),
    resource_file_sha256: { 'node.exe': hash('node'),
      'relay-file-io-helper.exe': hash('helper'), 'resource.txt': hash('original') },
  };
  const save = () => writeFileSync(path.join(root, 'desktop-build-manifest.json'), '\uFEFF' + JSON.stringify(manifest));
  const run = () => spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' });
  try {
    writeFileSync(path.join(root, 'relay-desktop.exe'), 'desktop');
    writeFileSync(path.join(root, 'node.exe'), 'node');
    writeFileSync(path.join(root, 'relay-file-io-helper.exe'), 'helper');
    writeFileSync(path.join(root, 'resource.txt'), 'original');
    save();
    assert.equal(run().status, 0);
    writeFileSync(path.join(root, 'resource.txt'), 'modified');
    assert.match(run().stderr, /hash mismatch/);
    writeFileSync(path.join(root, 'resource.txt'), 'original');
    writeFileSync(path.join(base, 'outside.txt'), 'outside');
    manifest.resource_file_sha256['../outside.txt'] = hash('outside');
    save();
    assert.match(run().stderr, /escaped its root/);
    delete manifest.resource_file_sha256['../outside.txt'];
    delete manifest.resource_file_sha256['node.exe'];
    save();
    assert.match(run().stderr, /Incomplete desktop manifest/);
  } finally {
    if (path.dirname(base) !== tmpdir() || !path.basename(base).startsWith('relay-package-check-')) {
      throw new Error('Unexpected test cleanup path');
    }
    rmSync(base, { recursive: true });
  }
});
