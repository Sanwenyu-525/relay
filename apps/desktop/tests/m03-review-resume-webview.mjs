// Packaged Windows WebView2 -> real API/PG -> independent Mock Worker -> Review/RESUME.
// Run only against a frozen package. Test SQL observes facts; all business writes use HTTP/UI.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = resolve(desktopRoot, '..', '..');
const releaseRoot = join(desktopRoot, 'release');
const exe = join(releaseRoot, 'relay-desktop.exe');
const node = join(releaseRoot, 'node.exe');
const psql = join(workspaceRoot, '.research', 'runtime-cache', 'postgresql-18.6-2', 'pgsql', 'bin', 'psql.exe');
const scripts = join(desktopRoot, 'scripts');
const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium, expect } = requireWorkbench('@playwright/test');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sessionName = /^relay-m02-acceptance-[0-9a-f]{32}$/iu;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const expectedExeSha = process.argv[2];
const expectedMigrationSha = process.argv[3];
const migration = join(releaseRoot, 'api', 'migrations', '0013_m03_run_command_order.sql');
const manifestPath = join(releaseRoot, 'desktop-build-manifest.json');
const packageInputs = [exe, node, manifestPath, migration,
  join(releaseRoot, 'api', 'dist', 'src', 'main.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'worker', 'supervisor-main.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'worker', 'main.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'cli', 'install-graph.js')];

assert.equal(process.version, 'v24.21.0', 'use the pinned portable Node 24.21.0');
assert.match(expectedExeSha ?? '', /^[0-9a-f]{64}$/u,
  'usage: node m03-review-resume-webview.mjs <frozen-EXE-SHA256> <frozen-0013-SHA256>');
assert.match(expectedMigrationSha ?? '', /^[0-9a-f]{64}$/u);
for (const path of [psql, ...packageInputs]) {
  assert.ok(existsSync(path), `missing packaged test input: ${path}`);
}
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const frozenPackage = new Map(packageInputs.map((path) => [path, sha(path)]));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(sha(exe), expectedExeSha, 'release executable changed after freeze');
assert.equal(manifest.artifact_sha256, expectedExeSha, 'package manifest does not describe this executable');
assert.equal(sha(migration), expectedMigrationSha, 'release 0013 migration changed after freeze');

const powerShellEnv = { ...process.env };
for (const key of Object.keys(powerShellEnv)) {
  if (key.toLowerCase() === 'psmodulepath') delete powerShellEnv[key];
}
const preexisting = new Set(readdirSync(tmpdir()).filter((name) => sessionName.test(name)));
const state = { root: null, marker: null, host: null, browser: null, page: null,
  identities: [], hostLogs: [], latch: null, latchBackendPid: null, cleaned: false };

async function powerShell(command) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command],
    { cwd: desktopRoot, env: powerShellEnv, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

async function powerShellFile(name, args = []) {
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, name), ...args],
    { cwd: desktopRoot, env: powerShellEnv, windowsHide: true, timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

async function sql(query, role = 'relay_app') {
  assert.ok(state.marker, 'disposable PostgreSQL session is unavailable');
  const url = `postgresql://${role}@127.0.0.1:${state.marker.postgres_port}/relay_m02_acceptance`;
  try {
    const { stdout } = await execFileAsync(psql,
      [url, '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', query],
      { cwd: desktopRoot, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    return stdout.trim();
  } catch { throw new Error('disposable PostgreSQL observation failed'); }
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function startSession() {
  // PostgreSQL can inherit the PowerShell stdout pipe. The explicit marker ends startup.
  const launcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', join(scripts, 'start-acceptance-session.ps1'), '-SkipDesktop', '-InstallGraph'],
  { cwd: desktopRoot, env: powerShellEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const root = await new Promise((done, fail) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('disposable PostgreSQL startup timed out')), 120_000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      launcher.stdout.destroy();
      launcher.stderr.destroy();
      if (error) fail(error); else done(value);
    }
    launcher.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 2 * 1024 * 1024) finish(new Error('disposable startup output exceeded limit'));
      const marker = /(?:^|\r?\n)session_root=([^\r\n]+)/u.exec(output)?.[1];
      if (marker && output.includes('cleanup: powershell')) {
        if (!output.includes('graph_install_exit=0') ||
            !output.includes('runtime_migrator_url_cleared=true')) {
          finish(new Error('graph installation or migrator credential removal was not confirmed'));
        }
        else finish(null, marker);
      }
    });
    launcher.once('error', () => finish(new Error('disposable startup helper could not run')));
    launcher.once('exit', (code) => {
      if (!settled) finish(new Error(`disposable startup exited ${code} before its marker`));
    });
  });
  assert.ok(root && sessionName.test(basename(root)) &&
    resolve(root).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase() + '\\'),
  'disposable session root is invalid');
  assert.ok(!preexisting.has(basename(root)), 'refusing a preexisting session root');
  state.root = root;
  state.marker = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/u, ''));
  assert.equal(state.marker.desktop_pid, 0);
  assert.equal(resolve(state.marker.release_exe).toLowerCase(), resolve(exe).toLowerCase());
  assert.equal(state.marker.release_sha256, expectedExeSha);
  assert.equal(resolve(state.marker.data_root).toLowerCase(), resolve(root, 'data').toLowerCase());
  assert.match(state.marker.workspace_id, uuid);
  assert.equal(await sql("select to_regnamespace('relay_graph_v1') is not null", 'relay_api_admin'), 't',
    'the trusted graph installer did not initialize its fixed schema');
  console.log(`session_id=${state.marker.session_id} pg_port=${state.marker.postgres_port}`);
  console.log('graph_install_exit=0 runtime_migrator_url_cleared=true graph_schema=relay_graph_v1');
  console.log(`exe_sha256=${expectedExeSha} packaged_0013_sha256=${expectedMigrationSha}`);
  console.log(`packaged_worker_sha256=${frozenPackage.get(join(releaseRoot, 'api', 'dist', 'src', 'worker', 'main.js'))}`);
  console.log(`packaged_graph_installer_sha256=${frozenPackage.get(join(releaseRoot, 'api', 'dist', 'src', 'cli', 'install-graph.js'))}`);
}

function hostEnvironment(cdpPort) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('NODE_') ||
        key.toUpperCase().startsWith('RELAY_')) delete env[key];
  }
  env.RELAY_DESKTOP_CONFIG_PATH = state.marker.config_path;
  env.RELAY_DESKTOP_DATA_ROOT = state.marker.data_root;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`;
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'RELAY_MIGRATION_DB_URL'), false,
    'desktop host environment still contains the migrator URL');
  return env;
}

async function startHost(label) {
  const port = await freePort();
  const logPath = join(state.root, `host-${label}.log`);
  const log = openSync(logPath, 'a');
  let host;
  try {
    host = spawn(exe, [], { cwd: releaseRoot, env: hostEnvironment(port),
      windowsHide: false, stdio: ['ignore', log, log] });
  } finally { closeSync(log); }
  state.host = host;
  state.hostLogs.push(logPath);
  state.marker.desktop_pid = host.pid;
  writeFileSync(join(state.root, 'session.json'), JSON.stringify(state.marker), 'utf8');
  const browser = await waitFor(async () => {
    if (host.exitCode !== null) throw new Error(`packaged desktop exited ${host.exitCode}`);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
    catch { return null; }
  }, 180_000, 'visible packaged WebView2 CDP endpoint');
  state.browser = browser;
  const page = await waitFor(() => browser.contexts().flatMap((context) => context.pages())
    .find((item) => /^http:\/\/tauri\.localhost(?:\/|$)/u.test(item.url())),
  20_000, 'packaged main WebView');
  state.page = page;
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  const bootstrap = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'));
  assert.match(bootstrap.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(bootstrap.workspaceId, state.marker.workspace_id);
  assert.match(bootstrap.bearerToken, /^[0-9a-f]{64}$/u);
  console.log(`${label}_host_pid=${host.pid} cdp_port=${port} bootstrap=ready`);
  return { page, bootstrap };
}

function watchWebView(page, bootstrap) {
  const base = `${bootstrap.baseUrl}/api/v1/workspaces/${bootstrap.workspaceId}`;
  const ledger = { delegate: null, decision: null, events: [], runGets: 0,
    controlPosts: 0, tokenInUrl: false, unauthorizedRequest: false };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes(bootstrap.bearerToken)) ledger.tokenInUrl = true;
    if (!url.startsWith(base)) return;
    const parsed = new URL(url);
    if (request.method() !== 'OPTIONS' &&
        request.headers().authorization !== `Bearer ${bootstrap.bearerToken}`) {
      ledger.unauthorizedRequest = true;
    }
    if (request.method() === 'POST' && /\/tasks\/[0-9a-f-]{36}\/delegations$/iu.test(parsed.pathname)) {
      ledger.delegate = { path: parsed.pathname.slice(`/api/v1/workspaces/${bootstrap.workspaceId}`.length),
        body: JSON.parse(request.postData()) };
    }
    if (request.method() === 'POST' && /\/reviews\/[0-9a-f-]{36}\/decisions$/iu.test(parsed.pathname)) {
      ledger.decision = { path: parsed.pathname.slice(`/api/v1/workspaces/${bootstrap.workspaceId}`.length),
        body: JSON.parse(request.postData()) };
    }
    if (request.method() === 'GET' && /\/runs\/[0-9a-f-]{36}$/iu.test(parsed.pathname)) ledger.runGets++;
    if (request.method() === 'POST' && /\/runs\/[0-9a-f-]{36}\/(?:control-requests|resume)$/iu.test(parsed.pathname)) {
      ledger.controlPosts++;
    }
    if (request.method() === 'GET' && /\/runs\/[0-9a-f-]{36}\/events$/iu.test(parsed.pathname)) {
      ledger.events.push({ after: parsed.searchParams.get('after'), bearer: true, status: null });
    }
  });
  page.on('response', (response) => {
    const parsed = new URL(response.url());
    if (!parsed.pathname.startsWith(`/api/v1/workspaces/${bootstrap.workspaceId}/runs/`) ||
        !/\/events$/u.test(parsed.pathname)) return;
    const event = [...ledger.events].reverse().find((item) => item.after === parsed.searchParams.get('after') && item.status === null);
    if (event) event.status = response.status();
  });
  return ledger;
}

async function post(bootstrap, path, body, expectedStatus) {
  const response = await fetch(`${bootstrap.baseUrl}/api/v1/workspaces/${bootstrap.workspaceId}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, expectedStatus, `POST ${path} returned ${response.status}`);
  return response.json();
}

async function get(bootstrap, path) {
  const response = await fetch(`${bootstrap.baseUrl}/api/v1/workspaces/${bootstrap.workspaceId}${path}`, {
    headers: { authorization: `Bearer ${bootstrap.bearerToken}`, origin: 'http://tauri.localhost' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `GET ${path} returned ${response.status}`);
  return response.json();
}

async function eventSeq(runId) {
  assert.match(runId, uuid);
  const sequence = await sql(`select coalesce(string_agg(seq::text, ',' order by seq), '') from run_events where run_id='${runId}'`);
  const values = sequence === '' ? [] : sequence.split(',').map(Number);
  for (let index = 0; index < values.length; index++) assert.equal(values[index], index + 1);
  return values.length;
}

async function assertRuntimeRoleSeparation() {
  assert.ok(!readFileSync(state.marker.config_path, 'utf8').includes('relay_migrator'),
    'desktop runtime config contains a migrator connection string');
  assert.equal(await sql("select count(*) from pg_stat_activity where usename='relay_migrator' " +
    "and datname='relay_m02_acceptance'", 'relay_api_admin'), '0',
  'a migrator session remained active after the trusted installer exited');
}

async function commandState(runId) {
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object('kind', c.kind,` +
    `'ordinal',c.ordinal,'status',o.status,'source',c.source_command_id,` +
    `'decision',c.review_decision_id) order by c.ordinal)::text,'[]') ` +
    `from run_commands c join run_command_outbox o on o.command_id=c.id where c.run_id='${runId}'`));
}

async function graphState(runId) {
  assert.match(runId, uuid);
  return {
    checkpoints: Number(await sql(`select count(*) from relay_graph_v1.checkpoints where thread_id='${runId}'`)),
    nonRoot: Number(await sql(`select count(*) from relay_graph_v1.checkpoints ` +
      `where thread_id='${runId}' and checkpoint_ns<>''`)),
    interrupts: Number(await sql(`select count(*) from relay_graph_v1.checkpoint_writes ` +
      `where thread_id='${runId}' and channel='__interrupt__'`)),
  };
}

async function effectState(runId) {
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object(` +
    `'operation_id',operation_id,'status',status,'dispatch_count',dispatch_count) ` +
    `order by operation_id)::text,'[]') from run_effect_actions where run_id='${runId}'`));
}

async function attemptState(runId) {
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object(` +
    `'id',a.id,'step_kind',s.step_kind,'attempt_number',a.attempt_number::text,` +
    `'status',a.status) order by s.step_kind,a.attempt_number)::text,'[]') ` +
    `from step_attempts a join run_steps s on s.id=a.step_id where s.run_id='${runId}'`));
}

async function artifactState(taskId, runId) {
  assert.match(taskId, uuid);
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object(` +
    `'id',v.id,'artifact_id',v.artifact_id,'version_number',v.version_number::text,` +
    `'source_ref',v.source_ref) order by v.id)::text,'[]') from artifact_versions v ` +
    `join artifacts a on a.id=v.artifact_id where a.task_id='${taskId}' ` +
    `and v.source_ref like 'run:${runId}/%'`));
}

async function completionState(taskId) {
  assert.match(taskId, uuid);
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object(` +
    `'id',id,'run_id',run_id,'basis_kind',basis_kind) order by id)::text,'[]') ` +
    `from completion_records where task_id='${taskId}'`));
}

async function processSnapshot(hostPid) {
  assert.ok(Number.isInteger(hostPid) && hostPid > 0);
  const command = `function I($p) { if ($null -eq $p) { return $null }; ` +
    `return @{ pid=[int]$p.ProcessId; created=([datetime]$p.CreationDate).ToUniversalTime().ToString('o'); ` +
    `executable=[string]$p.ExecutablePath } }; ` +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${hostPid}"; ` +
    `if ($null -eq $p) { throw 'host missing' }; ` +
    `$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid}"); ` +
    `$api=@($children | Where-Object { $_.CommandLine -like '*dist\\src\\main.js*' }); ` +
    `$supervisor=@($children | Where-Object { $_.CommandLine -like '*dist\\src\\worker\\supervisor-main.js*' }); ` +
    `if ($api.Count -ne 1 -or $supervisor.Count -ne 1) { throw 'sidecar topology invalid' }; ` +
    `$worker=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor[0].ProcessId)" | ` +
    `Where-Object { $_.CommandLine -like '*dist\\src\\worker\\main.js*' }); ` +
    `if ($worker.Count -gt 1) { throw 'multiple independent Workers found' }; ` +
    `$workerIdentity=$null; if ($worker.Count -eq 1) { $workerIdentity=I $worker[0] }; ` +
    `@{ host=(I $p); api=(I $api[0]); supervisor=(I $supervisor[0]); worker=$workerIdentity } ` +
    `| ConvertTo-Json -Compress -Depth 4`;
  const snapshot = JSON.parse(await powerShell(command));
  state.identities.push(...Object.values(snapshot).filter(Boolean));
  console.log(`processes host=${snapshot.host.pid} api=${snapshot.api.pid} supervisor=${snapshot.supervisor.pid} worker=${snapshot.worker?.pid ?? 'already_exited'}`);
  return snapshot;
}

async function startWorkerLatch() {
  const url = `postgresql://relay_api_admin@127.0.0.1:${state.marker.postgres_port}/relay_m02_acceptance` +
    '?application_name=relay-m03-webview-latch';
  const latch = spawn(psql, [url, '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-c', 'begin; lock table step_attempts in access exclusive mode; select pg_sleep(120); commit'],
  { cwd: desktopRoot, windowsHide: true, stdio: 'ignore' });
  state.latch = latch;
  const observed = await waitFor(async () => {
    const row = await sql(`select json_build_object('pid',a.pid,'role',a.usename,` +
      `'database',a.datname)::text from pg_locks l join pg_stat_activity a on a.pid=l.pid ` +
      `where l.relation='step_attempts'::regclass and l.mode='AccessExclusiveLock' ` +
      `and l.granted and a.application_name='relay-m03-webview-latch'`, 'relay_api_admin');
    return row ? JSON.parse(row) : null;
  }, 10_000, 'isolated PostgreSQL Worker latch');
  assert.equal(observed.role, 'relay_api_admin');
  assert.equal(observed.database, 'relay_m02_acceptance');
  assert.ok(Number.isInteger(observed.pid) && observed.pid > 0);
  state.latchBackendPid = observed.pid;
  console.log(`isolated_pg_latch_backend_pid=${observed.pid} cluster_port=${state.marker.postgres_port}`);
}

async function stopWorkerLatch() {
  const latch = state.latch;
  if (!latch) return;
  if (state.latchBackendPid !== null) {
    await sql(`select pg_terminate_backend(pid) from pg_stat_activity ` +
      `where pid=${state.latchBackendPid} and usename='relay_api_admin' ` +
      `and datname='relay_m02_acceptance' and application_name='relay-m03-webview-latch'`,
    'relay_api_admin');
  }
  if (latch.exitCode === null && latch.signalCode === null) latch.kill();
  await waitFor(() => latch.exitCode !== null || latch.signalCode !== null,
    10_000, 'owned PostgreSQL latch process to exit');
  await waitFor(async () =>
    (await sql(`select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid ` +
      `where l.relation='step_attempts'::regclass and l.mode='AccessExclusiveLock' ` +
      `and l.granted and a.application_name='relay-m03-webview-latch'`, 'relay_api_admin')) === '0',
  10_000, 'isolated PostgreSQL Worker latch release');
  state.latch = null;
  state.latchBackendPid = null;
}

async function assertStopped(snapshot) {
  for (const identity of Object.values(snapshot).filter(Boolean)) {
    const now = await powerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
      `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
    assert.notEqual(now, identity.created, `old process ${identity.pid} is still running`);
  }
}

async function captureOwnedForCleanup(hostPid) {
  if (!Number.isInteger(hostPid) || hostPid < 1) return;
  const command = `function I($p) { return @{ pid=[int]$p.ProcessId; ` +
    `created=([datetime]$p.CreationDate).ToUniversalTime().ToString('o') } }; ` +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${hostPid}"; ` +
    `$found=@(); if ($null -ne $p) { $found+=(I $p) }; ` +
    `$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid}" | ` +
    `Where-Object { $_.ExecutablePath -like '*\\apps\\desktop\\release\\node.exe' }); ` +
    `foreach ($child in $children) { $found+=(I $child); ` +
    `$found+=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($child.ProcessId)" | ` +
    `Where-Object { $_.ExecutablePath -like '*\\apps\\desktop\\release\\node.exe' } | ForEach-Object { I $_ }) }; ` +
    `ConvertTo-Json -InputObject @($found) -Compress -Depth 3`;
  const found = JSON.parse(await powerShell(command));
  state.identities.push(...found);
}

async function stopHost(snapshot = null) {
  if (!state.host?.pid || state.host.exitCode !== null) return;
  snapshot ??= await processSnapshot(state.host.pid);
  state.host.kill(); // The host Job Object must stop its API, supervisor and Worker.
  await waitFor(async () => {
    try { await assertStopped(snapshot); return true; } catch { return false; }
  }, 10_000, 'host and private child process tree to stop');
  await state.browser?.close().catch(() => undefined);
  state.browser = null;
  state.page = null;
  console.log('host_api_supervisor_stopped=true active_worker_if_any_stopped=true');
}

async function cleanup() {
  await stopWorkerLatch();
  await state.browser?.close().catch(() => undefined);
  state.browser = null;
  if (state.host?.pid && state.host.exitCode === null) {
    await captureOwnedForCleanup(state.host.pid);
    state.host.kill();
    await waitFor(async () => {
      try {
        for (const identity of state.identities) {
          const now = await powerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
            `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
          assert.notEqual(now, identity.created);
        }
        return true;
      } catch { return false; }
    }, 10_000, 'owned desktop process tree cleanup');
  }
  if (!state.root || !existsSync(state.root)) return;
  for (const identity of state.identities) {
    const now = await powerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
      `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
    assert.notEqual(now, identity.created, `unsafe cleanup: owned process ${identity.pid} remains`);
  }
  const output = await powerShellFile('stop-acceptance-session.ps1', ['-SessionRoot', state.root]);
  assert.match(output, /postgres_stop_exit=0 temporary_root_removed=True/u);
  state.cleaned = true;
  console.log('postgres_stop_exit=0 temporary_root_removed=True');
}

async function runChain() {
  await startSession();
  const first = await startHost('initial');
  await assertRuntimeRoleSeparation();
  const ledger = watchWebView(first.page, first.bootstrap);
  await first.page.goto('http://tauri.localhost/projects');
  await expect(first.page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  await first.page.getByTestId('project-create-open').click();
  await first.page.locator('input[name="project-title"]').fill(`M03 G01 Review ${state.marker.session_id.slice(0, 8)}`);
  await first.page.locator('input[name="project-type"][value="GENERAL"]').check({ force: true });
  await first.page.getByTestId('project-create-submit').click();
  await expect(first.page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/tasks$/u);
  const projectId = /\/projects\/([0-9a-f-]{36})\/tasks$/u.exec(new URL(first.page.url()).pathname)?.[1];
  assert.match(projectId ?? '', uuid);
  await first.page.getByRole('link', { name: '新建任务' }).click();
  await first.page.locator('input[name="task-title"]').fill('M03 G01 human Review');
  await first.page.locator('input[name="task-expected-result"]').fill('A traceable Mock Markdown draft');
  await first.page.locator('textarea[name="task-acceptance"]').fill('Human confirms the Mock draft');
  await first.page.getByTestId('task-create-save').click();
  await expect(first.page.getByTestId('task-created-open-detail')).toBeVisible();
  await expect(first.page.getByTestId('task-created-result')).toContainText('可开始');
  const taskId = await first.page.getByTestId('task-created-open-detail').innerText();
  assert.match(taskId, uuid);
  await first.page.getByTestId('task-created-open-detail').click();
  await first.page.getByTestId('task-detail-tab-runs').click();
  await expect(first.page.getByTestId('task-delegate')).toBeEnabled();
  let runId;
  let activeWorker;
  await startWorkerLatch();
  try {
    await first.page.getByTestId('task-delegate').click();
    await expect(first.page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/u);
    runId = /\/runs\/([0-9a-f-]{36})$/u.exec(new URL(first.page.url()).pathname)?.[1];
    assert.match(runId ?? '', uuid);
    activeWorker = await waitFor(async () => {
      const snapshot = await processSnapshot(state.host.pid);
      if (!snapshot.worker) return null;
      const claim = JSON.parse(await sql(`select json_build_object('status',status,` +
        `'worker_id',worker_id,'epoch',epoch)::text from run_invocations where run_id='${runId}'`));
      return claim.status === 'ACTIVE' && claim.worker_id ? { snapshot, claim } : null;
    }, 20_000, 'supervisor-launched independent Worker and active PG claim');
  } finally { await stopWorkerLatch(); }
  assert.ok(activeWorker);
  const workerExe = activeWorker.snapshot.worker.executable;
  assert.equal(resolve(workerExe.startsWith('\\\\?\\') ? workerExe.slice(4) : workerExe).toLowerCase(),
    resolve(node).toLowerCase());
  assert.ok(Date.parse(activeWorker.snapshot.worker.created) >=
    Date.parse(activeWorker.snapshot.supervisor.created),
  'the Worker process predates its recorded supervisor parent');
  assert.match(activeWorker.claim.worker_id, /^worker:desktop:[0-9a-f-]{36}:[0-9a-f-]{36}$/iu);
  assert.equal(activeWorker.claim.epoch, 1);
  console.log(`independent_worker_active pid=${activeWorker.snapshot.worker.pid} parent_supervisor_pid=${activeWorker.snapshot.supervisor.pid} started=${activeWorker.snapshot.worker.created} worker_id=${activeWorker.claim.worker_id} claim_epoch=1`);
  await expect(first.page.getByTestId('run-detail')).toBeVisible();
  assert.ok(ledger.delegate, 'WebView did not submit the Delegate command');
  assert.equal(ledger.delegate.path, `/tasks/${taskId}/delegations`);
  const replay = await post(first.bootstrap, ledger.delegate.path, ledger.delegate.body, 202);
  const delegateReceipt = await get(first.bootstrap, `/commands/${ledger.delegate.body.command_id}`);
  assert.equal(delegateReceipt.command_type, 'DelegateTask');
  assert.equal(replay.command_id, ledger.delegate.body.command_id);
  assert.equal(replay.committed_at, delegateReceipt.committed_at);
  assert.deepEqual(replay.result, delegateReceipt.result);
  assert.equal(replay.result.run_id, runId, 'same command_id did not replay the original Run');
  const changed = { ...ledger.delegate.body,
    expected_task_revision: (BigInt(ledger.delegate.body.expected_task_revision) + 1n).toString() };
  assert.equal((await post(first.bootstrap, ledger.delegate.path, changed, 409)).code,
    'COMMAND_ID_REUSED');
  const runPath = `/api/v1/workspaces/${first.bootstrap.workspaceId}/runs/${runId}`;
  assert.equal((await fetch(`${first.bootstrap.baseUrl}${runPath}`, {
    headers: { origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 401, 'a Run read without the bearer was accepted');
  assert.equal((await fetch(`${first.bootstrap.baseUrl}/api/v1/workspaces/${randomUUID()}/runs/${runId}`, {
    headers: { authorization: `Bearer ${first.bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 404, 'a Run was visible through another Workspace');
  console.log(`webview_create_delegate project_id=${projectId} task_id=${taskId} run_id=${runId} same_command_replay=true changed_payload_conflict=true`);

  const review = await waitFor(async () => {
    const body = await get(first.bootstrap, `/runs/${runId}/reviews`);
    return body.items.find((item) => item.kind === 'CRITERION' && item.status === 'OPEN') ?? null;
  }, 45_000, 'real Mock Worker to create a criterion Review');
  assert.match(review.id, uuid);
  assert.equal(await sql(`select count(*) from review_requests where run_id='${runId}' and kind='ACTION_APPROVAL'`), '0',
    'this human verification path must not be confused with a deferred tool approval');
  await waitFor(async () => {
    const commands = await commandState(runId);
    const invocation = await sql(`select status from run_invocations where run_id='${runId}'`);
    return commands.length === 1 && commands[0].kind === 'START' &&
      commands[0].status === 'DONE' && invocation === 'IDLE';
  }, 20_000, 'old START delivery to settle before Review decision');
  const beforeGraph = await graphState(runId);
  assert.ok(beforeGraph.checkpoints > 1 && beforeGraph.interrupts > 0 && beforeGraph.nonRoot === 0,
    'the same Run has no durable root-graph Review interrupt');
  const beforeEffects = await effectState(runId);
  assert.equal(beforeEffects.length, 1, 'the Mock publish action was duplicated before Review');
  assert.match(beforeEffects[0].operation_id, uuid);
  assert.equal(beforeEffects[0].status, 'SUCCEEDED');
  assert.equal(beforeEffects[0].dispatch_count, 1);
  const beforeAttempts = await attemptState(runId);
  assert.deepEqual(beforeAttempts.map((item) => item.step_kind).sort(),
    ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY']);
  assert.ok(beforeAttempts.every((item) => item.attempt_number === '1' && item.status === 'SUCCEEDED'));
  assert.ok(beforeAttempts.every((item) => item.status === 'SUCCEEDED'));
  const beforeArtifacts = await artifactState(taskId, runId);
  assert.equal(beforeArtifacts.length, 1, 'the fixed Mock Run did not publish exactly one candidate version');
  assert.equal(beforeArtifacts[0].version_number, '1');
  assert.deepEqual(await completionState(taskId), [], 'the Task completed before human Review');
  const beforeRestartSeq = await eventSeq(runId);
  assert.ok(beforeRestartSeq >= 2);
  await expect(first.page.getByTestId('run-reviews')).toContainText('查看请求与判断依据', { timeout: 15_000 });
  assert.ok(ledger.events.some((item) => item.after === '0' && item.status === 200),
    'first WebView did not subscribe to durable history');
  const initialSnapshot = await processSnapshot(state.host.pid);
  await stopHost(initialSnapshot);
  assert.equal((await getRunStatusFromPg(runId)), 'WAITING_APPROVAL');
  assert.equal(await eventSeq(runId), beforeRestartSeq,
    'Run events changed while API and Worker were stopped');
  assert.deepEqual(await graphState(runId), beforeGraph);
  assert.deepEqual(await effectState(runId), beforeEffects);
  assert.deepEqual(await attemptState(runId), beforeAttempts);
  assert.deepEqual(await artifactState(taskId, runId), beforeArtifacts);
  console.log(`before_restart review_id=${review.id} run_status=WAITING_APPROVAL seq=${beforeRestartSeq} old_api_pid=${initialSnapshot.api.pid}`);

  const reopened = await startHost('reopened');
  await assertRuntimeRoleSeparation();
  const reopenedSnapshot = await waitFor(async () => {
    try { return await processSnapshot(state.host.pid); } catch { return null; }
  }, 20_000, 'reopened API, supervisor and independent Worker');
  assert.notEqual(reopenedSnapshot.api.pid, initialSnapshot.api.pid,
    'reopened desktop reused the old API process');
  const reopenedLedger = watchWebView(reopened.page, reopened.bootstrap);
  assert.notEqual(reopened.bootstrap.bearerToken, first.bootstrap.bearerToken,
    'desktop restart reused an old in-memory bearer');
  assert.equal((await fetch(`${reopened.bootstrap.baseUrl}${runPath}`, {
    headers: { authorization: `Bearer ${first.bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 401, 'the previous host bearer remained valid after restart');
  await reopened.page.goto(`http://tauri.localhost/runs/${runId}`);
  await expect(reopened.page.getByTestId('run-detail')).toBeVisible();
  await expect(reopened.page.getByTestId('run-reviews')).toContainText('查看请求与判断依据');
  await waitFor(() => reopenedLedger.events.some((item) => item.after === '0' && item.status === 200),
    15_000, 'reopened WebView to replay Run history from PG');
  await reopened.page.getByTestId('run-reviews').getByRole('link', { name: '查看请求与判断依据' }).click();
  await expect(reopened.page).toHaveURL(new RegExp(`/reviews\\?id=${review.id}$`, 'u'));
  await expect(reopened.page.getByTestId('review-decision-ACCEPT')).toBeEnabled();
  await reopened.page.getByTestId('review-decision-ACCEPT').click();
  await waitFor(() => reopenedLedger.decision !== null, 10_000, 'WebView Review decision POST');
  assert.equal(reopenedLedger.decision.path, `/reviews/${review.id}/decisions`);
  const decision = reopenedLedger.decision;
  await waitFor(async () =>
    (await sql(`select count(*) from review_decisions where review_id='${review.id}'`)) === '1',
  10_000, 'WebView Review decision commit');
  const replayDecision = await post(reopened.bootstrap, decision.path, decision.body, 200);
  const decisionReceipt = await get(reopened.bootstrap, `/commands/${decision.body.command_id}`);
  assert.equal(decisionReceipt.command_type, 'ResolveReview');
  assert.equal(replayDecision.command_id, decision.body.command_id);
  assert.equal(replayDecision.committed_at, decisionReceipt.committed_at);
  assert.deepEqual(replayDecision.result, decisionReceipt.result);
  assert.equal(replayDecision.result.review_id, review.id);
  const changedDecision = { ...decision.body, decision: 'REQUEST_CHANGES', feedback: 'different intent' };
  assert.equal((await post(reopened.bootstrap, decision.path, changedDecision, 409)).code,
    'COMMAND_ID_REUSED');

  await waitFor(async () => (await get(reopened.bootstrap, `/runs/${runId}`)).status === 'COMPLETED',
    45_000, 'RESUME delivery and completed Mock Run');
  const commands = await commandState(runId);
  assert.deepEqual(commands.map((item) => [item.kind, item.ordinal, item.status]),
    [['START', 1, 'DONE'], ['RESUME', 2, 'DONE']]);
  assert.equal(commands[0].source, ledger.delegate.body.command_id);
  assert.equal(commands[1].source, decision.body.command_id);
  const decisionId = await sql(`select id from review_decisions where review_id='${review.id}'`);
  assert.match(decisionId, uuid);
  assert.equal(commands[1].decision, decisionId);
  assert.equal(await sql(`select count(*) from review_decisions where review_id='${review.id}'`), '1');
  assert.equal(await sql(`select status from run_invocations where run_id='${runId}'`), 'IDLE');
  assert.equal((await get(reopened.bootstrap, `/tasks/${taskId}`)).status, 'DONE');
  const afterGraph = await graphState(runId);
  assert.ok(afterGraph.checkpoints > beforeGraph.checkpoints,
    'the original root-graph thread did not persist the resumed successor');
  assert.equal(afterGraph.nonRoot, 0);
  assert.ok(afterGraph.interrupts >= beforeGraph.interrupts);
  assert.deepEqual(await effectState(runId), beforeEffects,
    'RESUME changed the original publish operation identity or dispatch count');
  const afterAttempts = await attemptState(runId);
  assert.deepEqual(afterAttempts.map((item) => item.step_kind).sort(),
    ['BUILD_CONTEXT', 'COMPLETE', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY']);
  assert.equal(new Set(afterAttempts.map((item) => item.id)).size, afterAttempts.length);
  assert.ok(afterAttempts.every((item) => item.attempt_number === '1' && item.status === 'SUCCEEDED'),
    'the fixed Mock Run has a duplicate or unfinished step attempt');
  assert.deepEqual(afterAttempts.filter((item) => item.step_kind !== 'COMPLETE'), beforeAttempts,
    'the original successful step attempts changed during Review RESUME');
  assert.deepEqual(await artifactState(taskId, runId), beforeArtifacts,
    'Review RESUME published another artifact version');
  const completions = await completionState(taskId);
  assert.equal(completions.length, 1, 'the Task lacks one unique completion record');
  assert.match(completions[0].id, uuid);
  assert.equal(completions[0].run_id, runId);
  const afterResumeSeq = await eventSeq(runId);
  assert.ok(afterResumeSeq > beforeRestartSeq, 'RESUME did not append durable Run events');
  await reopened.page.goto(`http://tauri.localhost/runs/${runId}`);
  await expect(reopened.page.getByTestId('run-detail')).toContainText('已完成');
  assert.ok(reopenedLedger.runGets >= 2, 'WebView did not read authoritative Run snapshots');
  for (const item of [ledger, reopenedLedger]) {
    assert.equal(item.controlPosts, 0, 'page navigation sent an unintended control/resume request');
    assert.equal(item.tokenInUrl, false, 'a WebView request URL exposed the bearer');
    assert.equal(item.unauthorizedRequest, false, 'a WebView API request omitted its bearer');
  }
  const storageSafe = await reopened.page.evaluate((token) =>
    [...Object.entries(localStorage), ...Object.entries(sessionStorage)]
      .every(([key, value]) => !key.includes(token) && !value.includes(token)), reopened.bootstrap.bearerToken);
  assert.equal(storageSafe, true, 'WebView storage retained its bearer');
  for (const logPath of state.hostLogs) {
    const log = readFileSync(logPath, 'utf8');
    assert.ok(!log.includes(first.bootstrap.bearerToken) &&
      !log.includes(reopened.bootstrap.bearerToken), 'host log retained a bearer');
  }
  console.log(`review_resume decision_id=${decisionId} commands=START:1:DONE,RESUME:2:DONE before_seq=${beforeRestartSeq} after_seq=${afterResumeSeq} task=DONE`);
  console.log(`graph_thread=${runId} checkpoint_before=${beforeGraph.checkpoints} checkpoint_after=${afterGraph.checkpoints} interrupt_writes=${beforeGraph.interrupts} operation_id=${beforeEffects[0].operation_id} dispatch_count=1 attempts=${afterAttempts.length} artifact_versions=1 completion_records=1 independent_worker_id=${activeWorker.claim.worker_id}`);
  console.log('webview_history_replayed=true authoritative_run_reads=true bearer_in_url_storage_logs=false runtime_migrator_sessions=0');
}

async function getRunStatusFromPg(runId) {
  assert.match(runId, uuid);
  return sql(`select status from runs where id='${runId}'`);
}

let failure;
try { await runChain(); }
catch (error) { failure = error; }
try { await cleanup(); }
catch (error) {
  console.log(`cleanup_unverified=true session_root=${state.root ?? 'unknown'}`);
  console.log('recovery: stop only the recorded desktop and its children, then run stop-acceptance-session.ps1 for the printed session root');
  if (!failure) failure = error;
}
const remaining = readdirSync(tmpdir()).filter((name) => sessionName.test(name) && !preexisting.has(name));
if (remaining.length || !state.cleaned) {
  console.log(`disposable_session_remaining=${remaining.join(',') || 'none'}`);
  if (!failure) failure = new Error('disposable PostgreSQL cleanup was not verified');
}
for (const [path, before] of frozenPackage) {
  if (!existsSync(path) || sha(path) !== before) {
    if (!failure) failure = new Error(`packaged input changed during test: ${path}`);
  }
}
if (failure) throw failure;
console.log('M03_REVIEW_RESUME_WEBVIEW_REAL_PG=PASS');
