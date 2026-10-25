import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseDesktop, readDesktopConfig, DESKTOP_CONFIG_KEYS } from './diagnose-desktop.mjs';

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

test('accepted desktop.env keys match the Rust host whitelist exactly', () => {
  // 权威契约在 Rust 宿主（lib.rs 的 validate_desktop_config_keys）：诊断工具少接受一个键，
  // 运维按文档配上也会被误判 CONFIG_INVALID；多接受一个键则放行宿主会拒绝的注入。
  const rust = readFileSync(new URL('../apps/desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const start = rust.indexOf('fn validate_desktop_config_keys');
  assert.ok(start >= 0, 'Rust config key validator not found in lib.rs');
  const end = rust.indexOf('\nfn ', start);
  const body = rust.slice(start, end === -1 ? undefined : end);
  const rustKeys = [...body.matchAll(/"([A-Z0-9_]+)"/g)].map(match => match[1]).sort();
  assert.ok(rustKeys.length >= 15, `expected the full host whitelist, extracted ${rustKeys.length} keys`);
  assert.deepEqual([...DESKTOP_CONFIG_KEYS].sort(), rustKeys,
    'diagnostic accepted-key set must equal the Rust host whitelist exactly');

  const root = mkdtempSync(path.join(tmpdir(), 'relay-diagnostic-'));
  const file = path.join(root, 'desktop.env');
  // 每个键各配一份合法值单独成文：追加式写法会对必填键造成重复键，测到的是去重而不是白名单。
  const valueFor = (key) => {
    if (key === 'RELAY_DB_URL') return '"postgresql://user:secret@127.0.0.1/db"';
    if (key === 'RELAY_DB_POOL_MAX') return '4';
    if (key === 'RELAY_DB_CONNECT_TIMEOUT_MS') return '3000';
    if (key === 'RELAY_DESKTOP_WORKSPACE_ID') return '00000000-0000-4000-8000-000000000000';
    if (key.startsWith('RELAY_MODEL_')) return 'true';
    return 'x';
  };
  const required = ['RELAY_DB_URL', 'RELAY_DB_POOL_MAX', 'RELAY_DB_CONNECT_TIMEOUT_MS', 'RELAY_DESKTOP_WORKSPACE_ID'];
  try {
    for (const key of rustKeys) {
      const entries = new Map(required.map(name => [name, valueFor(name)]));
      entries.set(key, valueFor(key));
      writeFileSync(file, [...entries].map(([name, value]) => `${name}=${value}`).join('\n') + '\n');
      assert.doesNotThrow(() => readDesktopConfig(file), `diagnostic must accept the host key ${key}`);
    }
    // 反向：白名单之外的键仍必须拒绝（含与 Rust 集合多退少补后的越界键）。
    writeFileSync(file, valid + 'RELAY_NOT_A_HOST_KEY=1\n');
    assert.throws(() => readDesktopConfig(file), /CONFIG_INVALID/);
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
