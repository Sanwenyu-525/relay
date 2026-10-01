import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyDesktopMaintenanceCapability } from './verify-desktop-maintenance-capability.mjs';

const verifier = fileURLToPath(new URL('./verify-desktop-package.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

test('maintenance capability preflight rejects legacy binaries without launching and probes only invalid arguments', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-package-check-'));
  const executable = path.join(root, 'relay-desktop.exe');
  const markers = 'maintenance_ready maintenance_released maintenance_error MAINTENANCE_SESSION_INVALID';
  const expectedFrame = { type: 'maintenance_error', version: 1, nonce: null, code: 'MAINTENANCE_SESSION_INVALID' };
  const expected = { status: 1, signal: null, stdout: `${JSON.stringify(expectedFrame)}\n`, stderr: '' };
  let runs = 0;
  const run = (file, args, options) => {
    runs++;
    assert.equal(file, executable);
    assert.deepEqual(args, ['--maintenance-session', '--invalid-maintenance-capability-probe']);
    assert.equal(options.input, '');
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 64 * 1024);
    return expected;
  };
  try {
    writeFileSync(executable, 'legacy binary maintenance_session_start maintenance_session_release');
    assert.throws(() => verifyDesktopMaintenanceCapability(executable, run), /lacks.*output protocol/);
    assert.equal(runs, 0);
    for (const marker of markers.split(' ')) {
      writeFileSync(executable, markers.replace(marker, 'missing'));
      assert.throws(() => verifyDesktopMaintenanceCapability(executable, run), /lacks.*output protocol/);
    }
    assert.equal(runs, 0);
    writeFileSync(executable, markers); // No complete input comparison strings.
    verifyDesktopMaintenanceCapability(executable, run);
    assert.equal(runs, 1);
    for (const result of [
      { ...expected, status: 0 }, { ...expected, status: null },
      { ...expected, signal: 'SIGTERM' }, { ...expected, error: new Error('ETIMEDOUT') },
      { ...expected, stderr: 'unexpected diagnostic' },
      { ...expected, stdout: expected.stdout.repeat(2) }, { ...expected, stdout: expected.stdout.trimEnd() },
      { ...expected, stdout: 'not JSON\n' },
      ...[{ version: 2 }, { nonce: 'unexpected-active-session' }, { type: 'maintenance_ready' },
        { code: 'MAINTENANCE_SESSION_UNSUPPORTED' }, { extra: true }].map(change =>
        ({ ...expected, stdout: `${JSON.stringify({ ...expectedFrame, ...change })}\n` })),
    ]) {
      assert.throws(() => verifyDesktopMaintenanceCapability(executable, () => result), /capability probe/);
    }
  } finally {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('relay-package-check-')) {
      throw new Error('Unexpected test cleanup path');
    }
    rmSync(root, { recursive: true });
  }
});

test('optimized native EXE supports maintenance without complete input comparison literals', {
  skip: process.platform !== 'win32' || !process.env.RELAY_TEST_MAINTENANCE_EXE,
}, () => {
  const executable = process.env.RELAY_TEST_MAINTENANCE_EXE;
  const before = readFileSync(executable);
  assert.equal(before.includes(Buffer.from('maintenance_session_start')), false);
  assert.equal(before.includes(Buffer.from('maintenance_session_release')), false);
  verifyDesktopMaintenanceCapability(executable);
  assert.equal(hash(readFileSync(executable)), hash(before));
});
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

test('restore runtime verification requires native and every Node entry to declare hash-bound isolation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-package-check-'));
  const refs = ['api/dist/src/main.js', 'api/dist/src/worker/main.js',
    'api/dist/src/worker/supervisor-main.js'];
  const moduleRef = 'api/dist/src/runtime/restore-isolation.js';
  const literals = 'restore-isolation.json RESTORE_ISOLATED RESTORE_ISOLATION_UNAVAILABLE';
  const files = { 'relay-desktop.exe': literals, 'node.exe': 'node',
    'relay-file-io-helper.exe': 'helper', [moduleRef]: literals };
  for (const ref of refs) files[ref] = "import '../runtime/restore-isolation.js'; await assertRestoreNotIsolated(dataRoot);";
  const manifest = { schema_version: 1, artifact_sha256: '', resource_file_sha256: {} };
  const save = () => {
    for (const [ref, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, ref)), { recursive: true });
      writeFileSync(path.join(root, ref), body);
      if (ref === 'relay-desktop.exe') manifest.artifact_sha256 = hash(body);
      else manifest.resource_file_sha256[ref] = hash(body);
    }
    writeFileSync(path.join(root, 'desktop-build-manifest.json'), JSON.stringify(manifest));
  };
  const run = (...flags) => spawnSync(process.execPath, [verifier, root, ...flags], { encoding: 'utf8' });
  try {
    save();
    assert.equal(run().status, 0); // Legacy packages can still be inspected as historical sources.
    assert.match(run('--require-restore-isolation').stderr, /capability missing or unsupported/);
    manifest.restore_isolation_protocol = 'legacy'; save();
    assert.match(run().stderr, /capability missing or unsupported/);
    manifest.restore_isolation_protocol = 'relay-restore-isolation-v1'; save();
    assert.equal(run('--require-restore-isolation').status, 0);
    for (const ref of refs) {
      const original = files[ref];
      files[ref] = 'await ordinaryStartupWithoutIsolation();'; save();
      assert.match(run().stderr, /startup wiring missing/);
      files[ref] = original;
    }
    files['relay-desktop.exe'] = 'legacy native binary'; save();
    assert.match(run().stderr, /startup wiring missing/);
    files['relay-desktop.exe'] = literals; save();
    delete manifest.resource_file_sha256[moduleRef];
    writeFileSync(path.join(root, 'desktop-build-manifest.json'), JSON.stringify(manifest));
    assert.match(run().stderr, /not hash-bound/);
    assert.match(run('--unknown').stderr, /Unknown package verification option/);
  } finally {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('relay-package-check-')) {
      throw new Error('Unexpected test cleanup path');
    }
    rmSync(root, { recursive: true });
  }
});
