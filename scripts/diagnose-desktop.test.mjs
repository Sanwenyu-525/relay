import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseDesktop, readDesktopConfig } from './diagnose-desktop.mjs';

const valid = 'RELAY_DB_URL="postgresql://user:secret@127.0.0.1/db"\nRELAY_DB_POOL_MAX=4\nRELAY_DB_CONNECT_TIMEOUT_MS=3000\nRELAY_DESKTOP_WORKSPACE_ID=00000000-0000-4000-8000-000000000000\n';

test('configuration accepts documented quoted values and rejects ambiguous or injected settings', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-diagnostic-'));
  const file = path.join(root, 'desktop.env');
  try {
    writeFileSync(file, valid);
    assert.equal(readDesktopConfig(file).RELAY_DB_POOL_MAX, '4');
    for (const text of [valid + 'NODE_OPTIONS=--import=evil\n', valid + 'RELAY_DB_POOL_MAX=2\n',
      valid.replace('MAX=4', 'MAX=0'), valid.replace('MS=3000', 'MS=60001'),
      valid.replace('RELAY_DB_URL=', 'UNKNOWN='), valid + 'malformed', ' '.repeat(65537)]) {
      writeFileSync(file, text);
      assert.throws(() => readDesktopConfig(file), /CONFIG_INVALID/);
    }
    assert.throws(() => readDesktopConfig('relative.env'), /CONFIG_INVALID/);
  } finally { rmSync(root, { recursive: true }); }
});

test('missing or invalid package stops before config or database probes without leaking input', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-diagnostic-'));
  try {
    writeFileSync(path.join(root, 'desktop-build-manifest.json'), 'secret-not-json');
    const report = await diagnoseDesktop(root, path.join(root, 'secret-config.env'));
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map(check => check.name), ['package']);
    assert.doesNotMatch(JSON.stringify(report), /secret-not-json|secret-config|relay-diagnostic-/);
  } finally { rmSync(root, { recursive: true }); }
});
