// Frozen Windows WebView2 -> isolated PostgreSQL -> independent Mock Gateway Worker.
// Run only against a frozen package. Test SQL observes facts; all business writes use HTTP/UI.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const expectedManifestSha = process.argv[4];
const gatewayUnknownScenario = process.argv[5] === '--gateway-unknown';
const migration = join(releaseRoot, 'api', 'migrations', '0013_m03_run_command_order.sql');
const manifestPath = join(releaseRoot, 'desktop-build-manifest.json');
const packageInputs = [exe, node, manifestPath, migration,
  join(releaseRoot, 'api', 'dist', 'src', 'main.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'worker', 'supervisor-main.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'worker', 'main.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'cli', 'install-graph.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'worker', 'run-graph.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'worker', 'mock-gateway-action.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'application', 'gateway-actions.js'),
  join(releaseRoot, 'api', 'dist', 'src', 'api', 'gateway-api.js')];

assert.equal(process.version, 'v24.21.0', 'use the pinned portable Node 24.21.0');
assert.match(expectedExeSha ?? '', /^[0-9a-f]{64}$/u,
  'usage: node m03-action-approval-webview.mjs <frozen-EXE-SHA256> <frozen-0013-SHA256> <frozen-manifest-SHA256> [--gateway-unknown]');
assert.match(expectedMigrationSha ?? '', /^[0-9a-f]{64}$/u);
assert.match(expectedManifestSha ?? '', /^[0-9a-f]{64}$/u);
assert.ok(process.argv[5] === undefined || gatewayUnknownScenario,
  'the only optional scenario is --gateway-unknown');
for (const path of [psql, ...packageInputs]) {
  assert.ok(existsSync(path), `missing packaged test input: ${path}`);
}
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const frozenPackage = new Map(packageInputs.map((path) => [path, sha(path)]));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(sha(exe), expectedExeSha, 'release executable changed after freeze');
assert.equal(manifest.artifact_sha256, expectedExeSha, 'package manifest does not describe this executable');
assert.equal(sha(manifestPath), expectedManifestSha, 'release manifest changed after freeze');
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
  console.log(`manifest_sha256=${expectedManifestSha}`);
  console.log(`packaged_worker_sha256=${frozenPackage.get(join(releaseRoot, 'api', 'dist', 'src', 'worker', 'main.js'))}`);
  console.log(`packaged_graph_installer_sha256=${frozenPackage.get(join(releaseRoot, 'api', 'dist', 'src', 'cli', 'install-graph.js'))}`);
  console.log(`packaged_mock_gateway_sha256=${frozenPackage.get(join(releaseRoot, 'api', 'dist', 'src', 'worker', 'mock-gateway-action.js'))}`);
}

function gatewayUnknownFaultConfig() {
  assert.ok(gatewayUnknownScenario && state.root && state.marker,
    'the Gateway fault requires a disposable acceptance session');
  assert.equal(resolve(state.marker.config_path), resolve(state.root, 'desktop.env'));
  const config = readFileSync(state.marker.config_path, 'utf8');
  assert.ok(!config.includes('NODE_ENV=') &&
    !config.includes('RELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_ADMIT='));
  const faultPath = join(state.root, 'desktop-gateway-unknown.env');
  assert.equal(existsSync(faultPath), false);
  // The Windows host strips NODE_/RELAY_ from child environments. Only this
  // isolated Node --env-file carries the test-only fault into its Worker.
  writeFileSync(faultPath,
    `${config}NODE_ENV=test\nRELAY_WORKER_TEST_EXIT_AFTER_GATEWAY_ADMIT=true\n`, 'utf8');
  return faultPath;
}

function hostEnvironment(cdpPort, configPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('NODE_') ||
        key.toUpperCase().startsWith('RELAY_')) delete env[key];
  }
  env.RELAY_DESKTOP_CONFIG_PATH = configPath;
  env.RELAY_DESKTOP_DATA_ROOT = state.marker.data_root;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`;
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'RELAY_MIGRATION_DB_URL'), false,
    'desktop host environment still contains the migrator URL');
  return env;
}

async function startHost(label, configPath = state.marker.config_path) {
  const port = await freePort();
  const logPath = join(state.root, `host-${label}.log`);
  const log = openSync(logPath, 'a');
  let host;
  try {
    host = spawn(exe, [], { cwd: releaseRoot, env: hostEnvironment(port, configPath),
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

async function gatewayState(runId) {
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select json_build_object('operation_id',o.id,` +
    `'status',o.status,'invocation_count',` +
    `(select count(*)::int from invocation_attempts i where i.operation_id=o.id),` +
    `'invocation_status',` +
    `(select i.status from invocation_attempts i where i.operation_id=o.id ` +
    `order by i.attempt_number desc limit 1))::text ` +
    `from logical_operations o where o.run_id='${runId}'`));
}

async function attemptState(runId) {
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select coalesce(json_agg(json_build_object(` +
    `'id',a.id,'step_kind',s.step_kind,'attempt_number',a.attempt_number::text,` +
    `'status',a.status) order by s.step_kind,a.attempt_number)::text,'[]') ` +
    `from step_attempts a join run_steps s on s.id=a.step_id where s.run_id='${runId}'`));
}

async function attemptDiagnostics(runId) {
  assert.match(runId, uuid);
  const rows = JSON.parse(await sql(`select coalesce(json_agg(json_build_object(` +
    `'id',a.id,'step_kind',s.step_kind,'attempt_number',a.attempt_number::text,` +
    `'attempt_key',a.attempt_key,'status',a.status,'claim_epoch',a.claim_epoch::text,` +
    `'worker_id',a.worker_id,'started_at',a.started_at,'finished_at',a.finished_at,` +
    `'result_ref',a.result_ref,'step_status',s.status,'step_revision',s.revision::text,` +
    `'step_result_ref',s.result_ref) order by s.step_index,a.attempt_number)::text,'[]') ` +
    `from step_attempts a join run_steps s on s.id=a.step_id where s.run_id='${runId}'`));
  return rows.map(({ result_ref: resultRef, step_result_ref: stepResultRef, ...item }) => ({
    ...item,
    result_sha256: resultRef === null ? null : createHash('sha256').update(JSON.stringify(resultRef)).digest('hex'),
    step_result_sha256: stepResultRef === null ? null :
      createHash('sha256').update(JSON.stringify(stepResultRef)).digest('hex'),
  }));
}

async function contextDiagnostics(runId) {
  assert.match(runId, uuid);
  return JSON.parse(await sql(`select json_build_object(` +
    `'task_status',t.status,'task_revision',t.revision::text,'run_status',r.status,` +
    `'manifests',(select coalesce(json_agg(json_build_object(` +
    `'hash',encode(m.manifest_hash,'hex'),` +
    `'task_revision',m.payload #>> '{dependencies,task_revision}',` +
    `'project_revision',m.payload #>> '{dependencies,project_revision}',` +
    `'context_revision',m.payload #>> '{dependencies,context_revision}',` +
    `'authority_revision',m.payload #>> '{dependencies,authority_revision}') ` +
    `order by m.created_at,m.id),'[]'::json) from context_manifests m ` +
    `where m.run_id=r.id))::text from runs r join tasks t on t.id=r.task_id ` +
    `where r.id='${runId}'`));
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
    '?application_name=relay-m03-action-webview-latch';
  const latch = spawn(psql, [url, '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-c', 'begin; lock table step_attempts in access exclusive mode; select pg_sleep(120); commit'],
  { cwd: desktopRoot, windowsHide: true, stdio: 'ignore' });
  state.latch = latch;
  const observed = await waitFor(async () => {
    const row = await sql(`select json_build_object('pid',a.pid,'role',a.usename,` +
      `'database',a.datname)::text from pg_locks l join pg_stat_activity a on a.pid=l.pid ` +
      `where l.relation='step_attempts'::regclass and l.mode='AccessExclusiveLock' ` +
      `and l.granted and a.application_name='relay-m03-action-webview-latch'`, 'relay_api_admin');
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
      `and datname='relay_m02_acceptance' and application_name='relay-m03-action-webview-latch'`,
    'relay_api_admin');
  }
  if (latch.exitCode === null && latch.signalCode === null) latch.kill();
  await waitFor(() => latch.exitCode !== null || latch.signalCode !== null,
    10_000, 'owned PostgreSQL latch process to exit');
  await waitFor(async () =>
    (await sql(`select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid ` +
      `where l.relation='step_attempts'::regclass and l.mode='AccessExclusiveLock' ` +
      `and l.granted and a.application_name='relay-m03-action-webview-latch'`, 'relay_api_admin')) === '0',
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

async function configureAskGateway(bootstrap, projectId) {
  assert.match(projectId, uuid);
  const root = join(state.marker.data_root, `action-approval-${randomUUID()}`);
  mkdirSync(root);
  assert.ok(resolve(root).toLowerCase().startsWith(resolve(state.marker.data_root).toLowerCase() + '\\'));
  const base = `/projects/${projectId}`;
  const resourceCommandId = randomUUID();
  const resource = (await post(bootstrap, `${base}/managed-resources`,
    { command_id: resourceCommandId, root_path: root }, 201)).result;
  assert.match(resource.resource_id, uuid);
  assert.equal((await get(bootstrap, `/commands/${resourceCommandId}`)).command_type,
    'CreateManagedResource');
  const resourceRead = await get(bootstrap, `${base}/managed-resources/${resource.resource_id}`);
  assert.equal(resourceRead.status, 'ACTIVE');
  assert.equal(resolve(resourceRead.canonical_root).toLowerCase(), resolve(root).toLowerCase());
  assert.equal((await fetch(`${bootstrap.baseUrl}/api/v1/workspaces/${randomUUID()}` +
    `${base}/managed-resources/${resource.resource_id}`, {
    headers: { authorization: `Bearer ${bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 404, 'Managed Resource was visible through another Workspace');
  const connectionCommandId = randomUUID();
  const connection = (await post(bootstrap, `${base}/connections`,
    { command_id: connectionCommandId, capabilities: ['FAKE_WRITE'] }, 201)).result;
  assert.match(connection.connection_id, uuid);
  assert.equal((await get(bootstrap, `/commands/${connectionCommandId}`)).command_type,
    'CreateGatewayConnection');
  const connectionRead = await get(bootstrap, `${base}/connections/${connection.connection_id}`);
  assert.equal(connectionRead.status, 'ACTIVE');
  assert.deepEqual(connectionRead.capabilities, ['FAKE_WRITE']);
  const policyCommandId = randomUUID();
  const policy = (await post(bootstrap, `${base}/permission-policies`, {
    command_id: policyCommandId, capability: 'FAKE_WRITE', resource_id: resource.resource_id,
    decision: 'ASK', max_payload_bytes: 1024,
  }, 201)).result;
  assert.match(policy.policy_id, uuid);
  assert.equal((await get(bootstrap, `/commands/${policyCommandId}`)).command_type,
    'CreateGatewayPolicy');
  const policies = await get(bootstrap, `${base}/permission-policies`);
  assert.equal(policies.find((item) => item.id === policy.policy_id)?.status, 'ACTIVE');
  const versions = await get(bootstrap, `${base}/permission-policies/${policy.policy_id}/versions`);
  assert.deepEqual(versions.map((item) => [item.capability, item.decision, item.target_prefix]),
    [['FAKE_WRITE', 'ASK', resourceRead.canonical_root]]);
  const target = join(resourceRead.canonical_root, 'approved-marker.json');
  assert.equal(existsSync(target), false, 'the isolated Fake marker already exists');
  console.log(`authorized_gateway_config project_id=${projectId} connection_id=${connection.connection_id} policy_id=${policy.policy_id} resource_id=${resource.resource_id} policy=ASK`);
  return { root, target, connectionId: connection.connection_id,
    policyId: policy.policy_id, resourceId: resource.resource_id };
}

async function runChain() {
  await startSession();
  const first = await startHost('initial');
  await assertRuntimeRoleSeparation();
  const ledger = watchWebView(first.page, first.bootstrap);
  await first.page.goto('http://tauri.localhost/projects');
  await expect(first.page.getByTestId('relay-connection-open')).toContainText('已连接本机 API');
  await first.page.getByTestId('project-create-open').click();
  await first.page.locator('input[name="project-title"]').fill(`M03 Action Approval ${state.marker.session_id.slice(0, 8)}`);
  await first.page.locator('input[name="project-type"][value="GENERAL"]').check({ force: true });
  await first.page.getByTestId('project-create-submit').click();
  await expect(first.page).toHaveURL(/\/projects\/[0-9a-f-]{36}\/tasks$/u);
  const projectId = /\/projects\/([0-9a-f-]{36})\/tasks$/u.exec(new URL(first.page.url()).pathname)?.[1];
  assert.match(projectId ?? '', uuid);
  await first.page.getByRole('link', { name: '新建任务' }).click();
  await first.page.locator('input[name="task-title"]').fill('M03 approved Mock marker');
  await first.page.locator('input[name="task-expected-result"]').fill('A traceable Mock candidate after approved marker');
  await first.page.locator('textarea[name="task-acceptance"]').fill('Human confirms the candidate after the approved action');
  await first.page.getByTestId('task-create-save').click();
  await expect(first.page.getByTestId('task-created-open-detail')).toBeVisible();
  await expect(first.page.getByTestId('task-created-result')).toContainText('可开始');
  const taskId = await first.page.getByTestId('task-created-open-detail').innerText();
  assert.match(taskId, uuid);
  const task = await get(first.bootstrap, `/tasks/${taskId}`);
  assert.equal(task.project_id, projectId);
  assert.equal(task.status, 'READY');
  const gateway = await configureAskGateway(first.bootstrap, projectId);
  const content = 'M03 approved Fake marker';
  // The WebView creates the Project/Task; the fixed Mock action is configured only by
  // this authorized same-Workspace HTTP Delegate. Workbench has no action form.
  const delegateBody = { command_id: randomUUID(), expected_task_revision: task.revision,
    mock_gateway_action: { connection_id: gateway.connectionId,
      resource_id: gateway.resourceId, target: gateway.target, content } };
  let runId;
  let activeWorker;
  await startWorkerLatch();
  try {
    const delegated = await post(first.bootstrap, `/tasks/${taskId}/delegations`, delegateBody, 202);
    runId = delegated.result.run_id;
    assert.match(runId ?? '', uuid);
    assert.equal(delegated.result.task_id, taskId);
    const replay = await post(first.bootstrap, `/tasks/${taskId}/delegations`, delegateBody, 202);
    assert.deepEqual(replay, delegated, 'Delegate same-command replay changed the Run');
    activeWorker = await waitFor(async () => {
      const snapshot = await processSnapshot(state.host.pid);
      if (!snapshot.worker) return null;
      const claim = JSON.parse(await sql(`select json_build_object('status',status,` +
        `'worker_id',worker_id,'epoch',epoch)::text from run_invocations where run_id='${runId}'`));
      return claim.status === 'ACTIVE' && claim.worker_id ? { snapshot, claim } : null;
    }, 20_000, 'independent Worker with an active claim');
  } finally { await stopWorkerLatch(); }
  assert.ok(activeWorker);
  const workerExe = activeWorker.snapshot.worker.executable;
  assert.equal(resolve(workerExe.startsWith('\\\\?\\') ? workerExe.slice(4) : workerExe).toLowerCase(),
    resolve(node).toLowerCase());
  assert.ok(Date.parse(activeWorker.snapshot.worker.created) >=
    Date.parse(activeWorker.snapshot.supervisor.created));
  assert.match(activeWorker.claim.worker_id, /^worker:desktop:[0-9a-f-]{36}:[0-9a-f-]{36}$/iu);
  assert.equal(activeWorker.claim.epoch, 1);
  console.log(`independent_worker_active pid=${activeWorker.snapshot.worker.pid} parent_supervisor_pid=${activeWorker.snapshot.supervisor.pid} worker_id=${activeWorker.claim.worker_id} epoch=1`);
  const delegateReceipt = await get(first.bootstrap, `/commands/${delegateBody.command_id}`);
  assert.equal(delegateReceipt.command_type, 'DelegateTask');
  assert.equal(delegateReceipt.result.run_id, runId);
  const contract = JSON.parse(await sql(`select (frozen_snapshot->'mock_gateway_action')::text ` +
    `from execution_contracts where run_id='${runId}'`));
  assert.match(contract.operation_id, uuid);
  assert.equal(contract.intent_key, 'mock-write-marker-v1');
  assert.equal(contract.connection_id, gateway.connectionId);
  assert.equal(contract.resource_id, gateway.resourceId);
  assert.equal(resolve(contract.target).toLowerCase(), resolve(gateway.target).toLowerCase());
  assert.equal(contract.content, content);
  const operationId = contract.operation_id;
  const runPath = `/api/v1/workspaces/${first.bootstrap.workspaceId}/runs/${runId}`;
  assert.equal((await fetch(`${first.bootstrap.baseUrl}${runPath}`, {
    headers: { origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 401, 'Run read without bearer was accepted');
  assert.equal((await fetch(`${first.bootstrap.baseUrl}/api/v1/workspaces/${randomUUID()}/runs/${runId}`, {
    headers: { authorization: `Bearer ${first.bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 404, 'Run was visible through another Workspace');
  console.log(`webview_created project_id=${projectId} task_id=${taskId} api_delegate_run_id=${runId} frozen_operation_id=${operationId}`);

  await first.page.goto(`http://tauri.localhost/runs/${runId}`);
  await expect(first.page.getByTestId('run-detail')).toBeVisible();
  const actionReview = await waitFor(async () => {
    const reviews = await get(first.bootstrap, `/runs/${runId}/reviews`);
    return reviews.items.find((item) => item.kind === 'ACTION_APPROVAL' && item.status === 'OPEN') ?? null;
  }, 45_000, 'Mock Gateway ACTION_APPROVAL Review');
  assert.match(actionReview.id, uuid);
  assert.equal(actionReview.target.operation_id, operationId);
  assert.ok(actionReview.allowed_decisions.includes('APPROVE'));
  await waitFor(async () => {
    const commands = await commandState(runId);
    return commands.length === 1 && commands[0].kind === 'START' &&
      commands[0].status === 'DONE' &&
      (await sql(`select status from run_invocations where run_id='${runId}'`)) === 'IDLE';
  }, 20_000, 'START to settle before ACTION approval');
  assert.equal((await get(first.bootstrap, `/runs/${runId}`)).status, 'WAITING_APPROVAL');
  assert.equal((await get(first.bootstrap, `/tasks/${taskId}`)).status, 'WAITING');
  const beforeAction = await get(first.bootstrap, `/operations/${operationId}`);
  assert.equal(beforeAction.status, 'WAITING_APPROVAL');
  assert.equal(beforeAction.run_id, runId);
  assert.equal(beforeAction.connection_id, gateway.connectionId);
  assert.deepEqual(beforeAction.invocations, [], 'approval wait already dispatched a Fake invocation');
  assert.equal((await fetch(`${first.bootstrap.baseUrl}/api/v1/workspaces/${randomUUID()}/operations/${operationId}`, {
    headers: { authorization: `Bearer ${first.bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 404, 'prepared operation was visible through another Workspace');
  assert.equal(existsSync(gateway.target), false, 'ASK had a Fake file effect before approval');
  assert.deepEqual(await effectState(runId), []);
  assert.deepEqual(await artifactState(taskId, runId), []);
  assert.deepEqual(await completionState(taskId), []);
  const beforeAttempts = await attemptState(runId);
  console.log(`before_action_context=${JSON.stringify(await contextDiagnostics(runId))}`);
  assert.deepEqual(beforeAttempts.map((item) => item.step_kind).sort(), ['BUILD_CONTEXT', 'DRAFT']);
  assert.ok(beforeAttempts.every((item) => item.status === 'SUCCEEDED' && item.attempt_number === '1'));
  const beforeGraph = await graphState(runId);
  assert.ok(beforeGraph.checkpoints > 1 && beforeGraph.interrupts > 0 && beforeGraph.nonRoot === 0);
  const beforeSeq = await eventSeq(runId);
  assert.ok(beforeSeq >= 2);
  await expect(first.page.getByTestId('run-reviews')).toContainText('查看请求与判断依据');
  assert.ok(ledger.events.some((item) => item.after === '0' && item.status === 200),
    'WebView did not subscribe to Run history while ACTION_APPROVAL was open');
  const initialSnapshot = await processSnapshot(state.host.pid);
  await stopHost(initialSnapshot);
  assert.equal(existsSync(gateway.target), false, 'host stop executed an unapproved effect');
  assert.deepEqual(await graphState(runId), beforeGraph);
  assert.equal(await eventSeq(runId), beforeSeq);
  const reopened = await startHost('reopened', gatewayUnknownScenario
    ? gatewayUnknownFaultConfig() : state.marker.config_path);
  await assertRuntimeRoleSeparation();
  assert.notEqual(reopened.bootstrap.bearerToken, first.bootstrap.bearerToken);
  assert.equal((await fetch(`${reopened.bootstrap.baseUrl}${runPath}`, {
    headers: { authorization: `Bearer ${first.bootstrap.bearerToken}`,
      origin: 'http://tauri.localhost' }, signal: AbortSignal.timeout(5000),
  })).status, 401, 'old host bearer remained valid');
  const reopenedLedger = watchWebView(reopened.page, reopened.bootstrap);
  await reopened.page.goto(`http://tauri.localhost/runs/${runId}`);
  await expect(reopened.page.getByTestId('run-detail')).toBeVisible();
  await expect(reopened.page.getByTestId('run-reviews')).toContainText('查看请求与判断依据');
  await waitFor(() => reopenedLedger.events.some((item) => item.after === '0' && item.status === 200),
    15_000, 'reopened WebView to replay durable Run events');
  const faultHostSnapshot = gatewayUnknownScenario ? await processSnapshot(state.host.pid) : null;
  assert.equal((await get(reopened.bootstrap, `/operations/${operationId}`)).status, 'WAITING_APPROVAL');
  assert.equal(existsSync(gateway.target), false, 'restart executed an unapproved effect');
  await reopened.page.getByTestId('run-reviews').getByRole('link', { name: '查看请求与判断依据' }).click();
  await expect(reopened.page).toHaveURL(new RegExp(`/reviews\\?id=${actionReview.id}$`, 'u'));
  await expect(reopened.page.getByTestId('review-inbox')).toContainText('动作批准');
  await expect(reopened.page.getByTestId('review-inbox')).toContainText(operationId);
  await expect(reopened.page.getByTestId('review-decision-APPROVE')).toBeEnabled();
  await reopened.page.getByTestId('review-decision-APPROVE').click();
  await waitFor(() => reopenedLedger.decision !== null, 10_000, 'WebView ACTION_APPROVAL decision POST');
  const approval = reopenedLedger.decision;
  assert.equal(approval.path, `/reviews/${actionReview.id}/decisions`);
  assert.equal(approval.body.decision, 'APPROVE');
  assert.equal(approval.body.target_hash, actionReview.target_hash);
  assert.equal(approval.body.expected_revision, actionReview.revision);
  await waitFor(async () =>
    (await sql(`select count(*) from review_decisions where review_id='${actionReview.id}'`)) === '1',
  10_000, 'ACTION_APPROVAL decision commit');
  const approvalReplay = await post(reopened.bootstrap, approval.path, approval.body, 200);
  const approvalReceipt = await get(reopened.bootstrap, `/commands/${approval.body.command_id}`);
  assert.equal(approvalReceipt.command_type, 'ResolveReview');
  assert.equal(approvalReplay.command_id, approval.body.command_id);
  assert.deepEqual(approvalReplay.result, approvalReceipt.result);
  assert.equal(approvalReplay.result.review_id, actionReview.id);
  assert.equal(approvalReplay.result.decision, 'APPROVE');
  assert.equal(approvalReplay.result.effect.external_effect_executed, false,
    'APPROVE response must not claim the Fake effect was executed');
  const approvalDecisionId = approvalReplay.result.decision_id;
  assert.match(approvalDecisionId, uuid);
  console.log(`after_action_decision_context=${JSON.stringify(await contextDiagnostics(runId))}`);
  if (gatewayUnknownScenario) {
    const unknown = await waitFor(async () => {
      const facts = await gatewayState(runId);
      return facts?.status === 'UNKNOWN' ? facts : null;
    }, 30_000, 'stopped Gateway Worker to reconcile the original operation as UNKNOWN');
    assert.deepEqual(unknown, { operation_id: operationId, status: 'UNKNOWN',
      invocation_count: 1, invocation_status: 'UNKNOWN' });
    assert.equal(existsSync(gateway.target), false, 'Admit-only crash wrote the Fake target');
    assert.deepEqual(await effectState(runId), [], 'a second Run effect was dispatched');
    assert.deepEqual(await artifactState(taskId, runId), []);
    assert.deepEqual(await completionState(taskId), []);
    assert.ok(faultHostSnapshot);
    await stopHost(faultHostSnapshot);

    const observer = await startHost('unknown-observer');
    await assertRuntimeRoleSeparation();
    assert.notEqual(observer.bootstrap.bearerToken, reopened.bootstrap.bearerToken);
    const observerLedger = watchWebView(observer.page, observer.bootstrap);
    const run = await get(observer.bootstrap, `/runs/${runId}`);
    assert.deepEqual(run.unresolved_operation_ids, [operationId]);
    await observer.page.goto(`http://tauri.localhost/runs/${runId}`);
    const warning = observer.page.getByTestId('run-unknown');
    await expect(warning).toContainText(operationId);
    await expect(warning).toContainText('不得盲重试');
    await observer.page.getByTestId('run-refresh').click();
    await expect(warning).toContainText(operationId);
    assert.deepEqual((await get(observer.bootstrap, `/runs/${runId}`)).unresolved_operation_ids,
      [operationId]);
    const operation = await get(observer.bootstrap, `/operations/${operationId}`);
    assert.equal(operation.status, 'UNKNOWN');
    assert.equal(operation.invocations.length, 1);
    assert.equal(operation.invocations[0].status, 'UNKNOWN');
    assert.deepEqual(await gatewayState(runId), unknown,
      'the restarted supervisor retried or replaced the original Gateway invocation');
    assert.equal(existsSync(gateway.target), false, 'restart wrote a Fake target for UNKNOWN');
    assert.deepEqual(await artifactState(taskId, runId), []);
    assert.deepEqual(await completionState(taskId), []);
    assert.equal((await processSnapshot(state.host.pid)).worker, null,
      'UNKNOWN started another Worker after host recovery');
    for (const item of [ledger, reopenedLedger, observerLedger]) {
      assert.equal(item.controlPosts, 0);
      assert.equal(item.tokenInUrl, false);
      assert.equal(item.unauthorizedRequest, false);
    }
    assert.equal(await observer.page.evaluate((token) =>
      [...Object.entries(localStorage), ...Object.entries(sessionStorage)]
        .every(([key, value]) => !key.includes(token) && !value.includes(token)),
    observer.bootstrap.bearerToken), true, 'WebView storage retained its bearer');
    for (const logPath of state.hostLogs) {
      const log = readFileSync(logPath, 'utf8');
      assert.ok(![first.bootstrap.bearerToken, reopened.bootstrap.bearerToken,
        observer.bootstrap.bearerToken].some((token) => log.includes(token)),
      'host log retained a bearer');
    }
    console.log(`gateway_unknown_webview operation_id=${operationId} invocations=1 target_absent=true original_run_visible=true`);
    return;
  }
  const criterionReview = await waitFor(async () => {
    const reviews = await get(reopened.bootstrap, `/runs/${runId}/reviews`);
    return reviews.items.find((item) => item.kind === 'CRITERION' && item.status === 'OPEN') ?? null;
  }, 60_000, 'approved RESUME to execute original action and open CRITERION Review');
  assert.match(criterionReview.id, uuid);
  assert.notEqual(criterionReview.id, actionReview.id);
  const marker = JSON.parse(readFileSync(gateway.target, 'utf8'));
  assert.equal(marker.operation_id, operationId);
  assert.equal(marker.content, content);
  const markerSha = sha(gateway.target);
  assert.equal(await sql(`select count(*) from logical_operations where run_id='${runId}'`), '1',
    'the approved Run minted another Gateway operation');
  const gatewayOperation = await get(reopened.bootstrap, `/operations/${operationId}`);
  assert.equal(gatewayOperation.status, 'SUCCEEDED');
  assert.equal(gatewayOperation.normalized_target.toLowerCase(), resolve(gateway.target).toLowerCase());
  assert.equal(gatewayOperation.invocations.length, 1, 'original operation did not have exactly one invocation');
  assert.equal(gatewayOperation.invocations[0].attempt_number, '1');
  assert.equal(gatewayOperation.invocations[0].status, 'SUCCEEDED');
  assert.equal(await sql(`select count(*) from approval_reservations where review_id='${actionReview.id}' and operation_id='${operationId}'`), '1');
  await waitFor(async () => {
    const current = await commandState(runId);
    return current.length === 2 && current[1].kind === 'RESUME' &&
      current[1].status === 'DONE' &&
      (await sql(`select status from run_invocations where run_id='${runId}'`)) === 'IDLE';
  }, 20_000, 'ACTION RESUME to settle before CRITERION decision');
  const midCommands = await commandState(runId);
  assert.deepEqual(midCommands.map((item) => [item.kind, item.ordinal, item.status]),
    [['START', 1, 'DONE'], ['RESUME', 2, 'DONE']]);
  assert.equal(midCommands[0].source, delegateBody.command_id);
  assert.equal(midCommands[1].source, approval.body.command_id);
  assert.equal(midCommands[1].decision, approvalDecisionId);
  const midGraph = await graphState(runId);
  assert.ok(midGraph.checkpoints > beforeGraph.checkpoints && midGraph.interrupts > beforeGraph.interrupts);
  assert.equal(midGraph.nonRoot, 0);
  const midEffects = await effectState(runId);
  assert.equal(midEffects.length, 1);
  assert.equal(midEffects[0].status, 'SUCCEEDED');
  assert.equal(midEffects[0].dispatch_count, 1);
  const midAttempts = await attemptState(runId);
  console.log(`mid_action_context=${JSON.stringify(await contextDiagnostics(runId))}`);
  console.log(`mid_attempt_diagnostics=${JSON.stringify(await attemptDiagnostics(runId))}`);
  assert.deepEqual(midAttempts.map((item) => item.step_kind).sort(),
    ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY']);
  assert.ok(midAttempts.every((item) => item.status === 'SUCCEEDED' && item.attempt_number === '1'));
  const candidate = await artifactState(taskId, runId);
  assert.equal(candidate.length, 1);
  assert.deepEqual(await completionState(taskId), []);
  assert.equal((await get(reopened.bootstrap, `/runs/${runId}`)).status, 'WAITING_APPROVAL');
  assert.equal(await sql(`select count(*) from review_decisions where review_id='${actionReview.id}'`), '1');
  const midSeq = await eventSeq(runId);
  assert.ok(midSeq > beforeSeq);
  console.log(`action_approved review_id=${actionReview.id} decision_id=${approvalDecisionId} operation_id=${operationId} invocation_count=1 fake_marker_sha256=${markerSha} criterion_review_id=${criterionReview.id}`);

  await reopened.page.goto(`http://tauri.localhost/reviews?id=${criterionReview.id}`);
  await expect(reopened.page.getByTestId('review-inbox')).toContainText('人工验收');
  await expect(reopened.page.getByTestId('review-decision-ACCEPT')).toBeEnabled();
  await reopened.page.getByTestId('review-decision-ACCEPT').click();
  await waitFor(() => reopenedLedger.decision?.path === `/reviews/${criterionReview.id}/decisions`,
    10_000, 'WebView CRITERION decision POST');
  const acceptance = reopenedLedger.decision;
  assert.equal(acceptance.body.decision, 'ACCEPT');
  assert.equal(acceptance.body.target_hash, criterionReview.target_hash);
  assert.equal(acceptance.body.expected_revision, criterionReview.revision);
  await waitFor(async () =>
    (await sql(`select count(*) from review_decisions where review_id='${criterionReview.id}'`)) === '1',
  10_000, 'CRITERION decision commit');
  const acceptanceReplay = await post(reopened.bootstrap, acceptance.path, acceptance.body, 200);
  const acceptanceReceipt = await get(reopened.bootstrap, `/commands/${acceptance.body.command_id}`);
  assert.equal(acceptanceReceipt.command_type, 'ResolveReview');
  assert.deepEqual(acceptanceReplay.result, acceptanceReceipt.result);
  assert.equal(acceptanceReplay.result.review_id, criterionReview.id);
  assert.equal(acceptanceReplay.result.decision, 'ACCEPT');
  await waitFor(async () => (await get(reopened.bootstrap, `/runs/${runId}`)).status === 'COMPLETED',
    60_000, 'CRITERION RESUME to complete the same Run');
  await waitFor(async () => {
    const current = await commandState(runId);
    return current.length === 3 && current[2].kind === 'RESUME' &&
      current[2].status === 'DONE' &&
      (await sql(`select status from run_invocations where run_id='${runId}'`)) === 'IDLE';
  }, 20_000, 'CRITERION RESUME delivery to settle');
  assert.equal((await get(reopened.bootstrap, `/tasks/${taskId}`)).status, 'DONE');
  const commands = await commandState(runId);
  assert.deepEqual(commands.map((item) => [item.kind, item.ordinal, item.status]),
    [['START', 1, 'DONE'], ['RESUME', 2, 'DONE'], ['RESUME', 3, 'DONE']]);
  assert.equal(commands[2].source, acceptance.body.command_id);
  assert.equal(commands[2].decision, acceptanceReplay.result.decision_id);
  assert.notEqual(commands[2].source, commands[1].source);
  assert.notEqual(commands[2].decision, commands[1].decision);
  assert.equal(await sql(`select status from run_invocations where run_id='${runId}'`), 'IDLE');
  assert.equal(await sql(`select count(*) from review_decisions d ` +
    `join review_requests r on r.id=d.review_id where r.run_id='${runId}'`), '2');
  const finalGraph = await graphState(runId);
  assert.ok(finalGraph.checkpoints > midGraph.checkpoints && finalGraph.interrupts >= midGraph.interrupts);
  assert.equal(finalGraph.nonRoot, 0);
  assert.deepEqual(await effectState(runId), midEffects, 'CRITERION RESUME changed Mock publish identity');
  const finalOperation = await get(reopened.bootstrap, `/operations/${operationId}`);
  assert.deepEqual(finalOperation.invocations, gatewayOperation.invocations,
    'CRITERION RESUME repeated the Fake Gateway invocation');
  assert.equal(sha(gateway.target), markerSha, 'CRITERION RESUME changed the approved Fake marker');
  const finalAttempts = await attemptState(runId);
  assert.deepEqual(finalAttempts.map((item) => item.step_kind).sort(),
    ['BUILD_CONTEXT', 'COMPLETE', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY']);
  assert.equal(new Set(finalAttempts.map((item) => item.id)).size, finalAttempts.length);
  assert.ok(finalAttempts.every((item) => item.status === 'SUCCEEDED' && item.attempt_number === '1'));
  assert.deepEqual(finalAttempts.filter((item) => item.step_kind !== 'COMPLETE'), midAttempts);
  assert.deepEqual(await artifactState(taskId, runId), candidate, 'completion published another candidate');
  const completions = await completionState(taskId);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].run_id, runId);
  const finalSeq = await eventSeq(runId);
  assert.ok(finalSeq > midSeq);
  await reopened.page.goto(`http://tauri.localhost/runs/${runId}`);
  await expect(reopened.page.getByTestId('run-detail')).toContainText('已完成');
  assert.ok(reopenedLedger.runGets >= 2);
  for (const item of [ledger, reopenedLedger]) {
    assert.equal(item.controlPosts, 0, 'UI navigation submitted an unexpected Run control');
    assert.equal(item.tokenInUrl, false, 'WebView URL exposed its bearer');
    assert.equal(item.unauthorizedRequest, false, 'WebView API request omitted bearer');
  }
  assert.equal(await reopened.page.evaluate((token) =>
    [...Object.entries(localStorage), ...Object.entries(sessionStorage)]
      .every(([key, value]) => !key.includes(token) && !value.includes(token)),
  reopened.bootstrap.bearerToken), true, 'WebView storage retained its bearer');
  for (const logPath of state.hostLogs) {
    const log = readFileSync(logPath, 'utf8');
    assert.ok(!log.includes(first.bootstrap.bearerToken) &&
      !log.includes(reopened.bootstrap.bearerToken), 'host log retained a bearer');
  }
  console.log(`action_review_resume commands=START:1:DONE,RESUME:2:DONE,RESUME:3:DONE before_seq=${beforeSeq} mid_seq=${midSeq} final_seq=${finalSeq} completion_records=1 artifact_versions=1 gateway_invocations=1`);
  console.log(`graph_thread=${runId} checkpoints=${beforeGraph.checkpoints}->${midGraph.checkpoints}->${finalGraph.checkpoints} interrupts=${beforeGraph.interrupts}->${midGraph.interrupts}->${finalGraph.interrupts} independent_worker_id=${activeWorker.claim.worker_id}`);
  console.log('webview_created_project_task=true api_config_and_delegate=true webview_approved_and_accepted=true bearer_isolated=true runtime_migrator_sessions=0');
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
console.log(gatewayUnknownScenario
  ? 'M03_GATEWAY_UNKNOWN_WEBVIEW_REAL_PG=PASS'
  : 'M03_ACTION_APPROVAL_WEBVIEW_REAL_PG=PASS');
