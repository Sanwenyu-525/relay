import { readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Only fixed messages are returned: driver errors may contain connection secrets.
export function readDesktopConfig(file) {
  if (!path.isAbsolute(file) || statSync(file).size > 65536) throw new Error('CONFIG_INVALID');
  const text = readFileSync(file, 'utf8');
  const keys = ['RELAY_DB_URL', 'RELAY_DB_POOL_MAX', 'RELAY_DB_CONNECT_TIMEOUT_MS', 'RELAY_DESKTOP_WORKSPACE_ID'];
  const seen = new Set();
  for (const line of text.split(/\r?\n/).map(value => value.trim())) {
    if (!line || line.startsWith('#')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!line.includes('=') || !keys.includes(key) || seen.has(key)) throw new Error('CONFIG_INVALID');
    seen.add(key);
  }
  const config = parseEnv(text);
  if (keys.some(key => !config[key]?.trim())) throw new Error('CONFIG_INVALID');
  for (const [key, min, max] of [['RELAY_DB_POOL_MAX', 1, 64], ['RELAY_DB_CONNECT_TIMEOUT_MS', 100, 60000]]) {
    if (!/^\d+$/.test(config[key]) || Number(config[key]) < min || Number(config[key]) > max) {
      throw new Error('CONFIG_INVALID');
    }
  }
  return config;
}

export async function diagnoseDesktop(root, configFile) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const result = () => ({ schema_version: 1, ok: checks.every(check => check.status === 'PASS'), checks });
  const verifier = fileURLToPath(new URL('./verify-desktop-package.mjs', import.meta.url));
  const verified = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8', timeout: 300000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  if (verified.status !== 0) {
    add('package', 'FAIL', verified.error?.code === 'ETIMEDOUT'
      ? 'Package verification timed out; integrity is unknown. Retry when the disk is available.'
      : 'Package inventory/hash verification failed. Rebuild or replace the package.');
    return result();
  }
  add('package', 'PASS', 'Manifest-listed resources match their hashes; this is not a publisher signature.');
  const manifest = JSON.parse(readFileSync(path.join(root, 'desktop-build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const node = spawnSync(path.join(root, 'node.exe'), ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  add('node', node.status === 0 && /^v24\.\d+\.\d+$/.test(node.stdout.trim()) && node.stdout.trim() === manifest.node_version ? 'PASS' : 'FAIL',
    'Bundled Node must run and match the manifest and Node 24 requirement.');
  if (process.platform !== 'win32') {
    add('webview2', 'FAIL', 'Run this diagnostic on the target Windows computer.');
  } else {
    // Microsoft documents these Evergreen Runtime registration locations.
    const probe = "$paths = @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'); foreach ($p in $paths) { $v = (Get-ItemProperty -LiteralPath $p -Name pv -ErrorAction SilentlyContinue).pv; if ($v -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' -and [version]$v -gt [version]'0.0.0.0') { exit 0 } }; exit 1";
    const webview = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', probe], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
    add('webview2', webview.status === 0 ? 'PASS' : 'FAIL', webview.status === 0
      ? 'Evergreen Runtime registration found; actual window startup still requires verification.'
      : 'Evergreen Runtime not detected. Install or repair Microsoft WebView2 Runtime.');
  }
  let config;
  let schemaChecker;
  let db;
  try {
    config = readDesktopConfig(configFile);
    const load = relative => import(pathToFileURL(path.join(root, 'api/dist/src', relative)).href);
    const [{ validateDatabaseUrl }, { desktopWorkspaceId }, { SchemaReadinessChecker }] = await Promise.all([
      load('config/config.js'), load('desktop/child.js'), load('infrastructure/schema-readiness.js'),
    ]);
    if (validateDatabaseUrl(config.RELAY_DB_URL)) throw new Error('CONFIG_INVALID');
    desktopWorkspaceId(config.RELAY_DESKTOP_WORKSPACE_ID);
    schemaChecker = new SchemaReadinessChecker(path.join(root, 'api/migrations'));
  } catch {
    add('config', 'FAIL', 'Cannot validate desktop.env. Check the documented four keys, numeric bounds and workspace UUID; duplicate keys are rejected.');
    return result();
  }
  add('config', 'PASS', 'Configuration syntax validated; values are omitted. Environment overrides are not applied.');
  try {
    const require = createRequire(path.join(root, 'api/package.json'));
    const { Pool } = require('pg');
    const { Kysely, PostgresDialect, sql } = require('kysely');
    const pool = new Pool({ connectionString: config.RELAY_DB_URL, max: 1,
      connectionTimeoutMillis: Math.min(Number(config.RELAY_DB_CONNECT_TIMEOUT_MS), 5000),
      statement_timeout: 5000, query_timeout: 6000,
      options: '-c default_transaction_read_only=on', application_name: 'relay-desktop-diagnostic' });
    pool.on('error', () => {});
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const client = await pool.connect();
    try { await client.query('select 1'); } finally { client.release(); }
    add('database', 'PASS', 'PostgreSQL connection succeeded with a read-only session.');
    await db.transaction().setAccessMode('read only').execute(async transaction => {
      await sql`set local statement_timeout = '5s'`.execute(transaction);
      if (!(await schemaChecker.check(transaction)).compatible) {
        add('schema', 'FAIL', 'Schema does not match this package, or compatibility view is inaccessible. Use the documented migration process.');
        return;
      }
      add('schema', 'PASS', 'Business migration hashes match this package. Graph checkpoint compatibility is not tested.');
      const workspace = await transaction.selectFrom('workspaces').select('id').where('id', '=', config.RELAY_DESKTOP_WORKSPACE_ID).executeTakeFirst();
      add('workspace', workspace ? 'PASS' : 'FAIL', workspace ? 'Configured workspace exists.' : 'Workspace is missing. Initialize the intended workspace explicitly.');
    });
  } catch {
    add('database', 'FAIL', 'Database probe failed. Check PostgreSQL availability, credentials and application-role read permissions.');
  } finally {
    if (db) await db.destroy().catch(() => {});
  }
  return result();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(process.argv[2] || 'apps/desktop/release');
    const config = process.argv[3] || process.env.RELAY_DESKTOP_CONFIG_PATH
      || path.join(process.env.APPDATA || '', 'dev.relay.agent/desktop.env');
    const report = await diagnoseDesktop(root, config);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ schema_version: 1, ok: false, checks: [{ name: 'diagnostic', status: 'FAIL', message: 'Diagnostic could not finish. Check package and absolute configuration paths.' }] }));
    process.exitCode = 1;
  }
}
