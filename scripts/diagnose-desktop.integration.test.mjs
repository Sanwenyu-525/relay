import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseDesktop, readDesktopConfig } from './diagnose-desktop.mjs';

// Explicitly point this at a disposable acceptance session, never a production config.
const session = process.env.RELAY_DIAGNOSTIC_TEST_SESSION;
test('real package and isolated PostgreSQL diagnostic success and failure paths', { skip: !session }, async () => {
  const root = path.resolve(session);
  assert.equal(path.dirname(root).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
  assert.match(path.basename(root), /^relay-m02-acceptance-[a-f0-9]{32}$/);
  const marker = JSON.parse(readFileSync(path.join(root, 'session.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(marker.cluster_path, path.join(root, 'cluster'));
  const packageRoot = path.resolve('apps/desktop/release');
  const config = readDesktopConfig(path.join(root, 'desktop.env'));
  const directory = mkdtempSync(path.join(tmpdir(), 'relay-diagnostic-cases-'));
  const file = path.join(directory, 'desktop.env');
  const probe = async (changes = {}) => {
    const values = { ...config, ...changes };
    writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'));
    const report = await diagnoseDesktop(packageRoot, file);
    assert.doesNotMatch(JSON.stringify(report), /postgres(?:ql)?:\/\//);
    return report;
  };
  try {
    const success = await probe();
    assert.equal(success.ok, true, JSON.stringify(success));
    assert.deepEqual(success.checks.map(check => check.name), ['package', 'node', 'webview2', 'config', 'database', 'schema', 'workspace']);
    const absent = await probe({ RELAY_DESKTOP_WORKSPACE_ID: '00000000-0000-4000-8000-000000000000' });
    assert.equal(absent.ok, false);
    assert.equal(absent.checks.find(check => check.name === 'workspace')?.status, 'FAIL');
    const hiddenSchemaUrl = new URL(config.RELAY_DB_URL);
    hiddenSchemaUrl.searchParams.set('options', '-c search_path=pg_catalog');
    const schema = await probe({ RELAY_DB_URL: hiddenSchemaUrl.href });
    assert.equal(schema.ok, false);
    assert.equal(schema.checks.find(check => check.name === 'schema')?.status, 'FAIL');
    assert.equal(schema.checks.some(check => check.name === 'workspace'), false);
    const down = await probe({ RELAY_DB_URL: 'postgresql://diagnostic:do-not-print@127.0.0.1:1/unavailable' });
    assert.equal(down.ok, false);
    assert.equal(down.checks.find(check => check.name === 'database')?.status, 'FAIL');
    assert.doesNotMatch(JSON.stringify(down), /do-not-print/);
  } finally {
    assert.equal(path.dirname(directory), tmpdir());
    assert.match(path.basename(directory), /^relay-diagnostic-cases-/);
    rmSync(directory, { recursive: true });
  }
});
