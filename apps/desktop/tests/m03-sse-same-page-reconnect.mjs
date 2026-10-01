// Terminate one PostgreSQL SSE poll while the packaged WebView stays on a Run page.
// Only disposable PostgreSQL processes are targeted; no product fault switch is used.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const expectedSseSha = process.argv[3];
const expectedMigrationSha = process.argv[4];

assert.equal(process.version, 'v24.21.0', 'run with the portable Node 24.21.0');
for (const [label, hash] of [['EXE', expectedExeSha], ['SSE', expectedSseSha], ['migration', expectedMigrationSha]]) {
  assert.match(hash ?? '', /^[0-9a-f]{64}$/u, `missing accepted ${label} SHA-256`);
}
for (const path of [exe, node, psql, join(releaseRoot, 'desktop-build-manifest.json'),
  join(releaseRoot, 'api', 'dist', 'src', 'api', 'run-events-api.js'),
  join(releaseRoot, 'api', 'migrations', '0012_m03_run_events.sql')]) {
  assert.ok(existsSync(path), `missing frozen input: ${path}`);
}
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = JSON.parse(readFileSync(join(releaseRoot, 'desktop-build-manifest.json'), 'utf8').replace(/^\uFEFF/u, ''));
assert.equal(hashFile(exe), expectedExeSha);
assert.equal(manifest.artifact_sha256, expectedExeSha);
assert.equal(hashFile(join(releaseRoot, 'api', 'dist', 'src', 'api', 'run-events-api.js')), expectedSseSha);
assert.equal(hashFile(join(releaseRoot, 'api', 'migrations', '0012_m03_run_events.sql')), expectedMigrationSha);
const powerShellEnv = { ...process.env };
for (const key of Object.keys(powerShellEnv)) {
  if (key.toLowerCase() === 'psmodulepath') delete powerShellEnv[key];
}
const preexisting = new Set(readdirSync(tmpdir()).filter((name) => sessionName.test(name)));
const state = { root: null, marker: null, host: null, browser: null, page: null,
  holds: [], identities: [], cleaned: false, releaseReconnect: null };

async function runPowerShellFile(name, args = [], timeout = 120_000) {
  const { stdout } = await execFileAsync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, name), ...args],
    { cwd: desktopRoot, env: powerShellEnv, windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

async function runPowerShell(command) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command],
    { cwd: desktopRoot, env: powerShellEnv, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

async function sql(query, role = 'relay_app') {
  assert.ok(state.marker, 'disposable session is not ready');
  const url = `postgresql://${role}@127.0.0.1:${state.marker.postgres_port}/relay_m02_acceptance`;
  try {
    const { stdout } = await execFileAsync(psql, [url, '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', query],
      { cwd: desktopRoot, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    return stdout.trim();
  } catch { throw new Error('disposable PostgreSQL probe failed'); }
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
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

async function startDisposableSession() {
  // The disposable PostgreSQL child may keep the launcher pipe open after its marker.
  const launcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(scripts, 'start-acceptance-session.ps1'), '-SkipDesktop', '-InstallGraph'],
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
      if (marker && output.includes('cleanup: powershell')) finish(null, marker);
    });
    launcher.once('error', () => finish(new Error('disposable startup helper could not run')));
    launcher.once('exit', (code) => {
      if (!settled) finish(new Error(`disposable startup exited ${code} before its session marker`));
    });
  });
  assert.ok(root && sessionName.test(basename(root)) &&
    resolve(root).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase() + '\\'),
  'disposable session path is invalid');
  assert.ok(!preexisting.has(basename(root)), 'refusing a preexisting session');
  state.root = root;
  state.marker = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8').replace(/^\uFEFF/u, ''));
  assert.equal(state.marker.desktop_pid, 0);
  assert.equal(resolve(state.marker.release_exe).toLowerCase(), resolve(exe).toLowerCase());
  assert.equal(state.marker.release_sha256, expectedExeSha);
  assert.equal(resolve(state.marker.data_root).toLowerCase(), resolve(root, 'data').toLowerCase());
  assert.match(state.marker.workspace_id, uuid);
  console.log(`session_id=${state.marker.session_id} pg_port=${state.marker.postgres_port} release_sha256=${expectedExeSha}`);
}

async function seedRun() {
  const { stdout } = await execFileAsync(node,
    [join(desktopRoot, 'tests', 'm03-seed-run.mjs'), state.root, '1'],
    { cwd: desktopRoot, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
  const seeded = JSON.parse(stdout);
  assert.equal(seeded.seed_api_exit, 0);
  assert.equal(seeded.runs.length, 1);
  const run = seeded.runs[0];
  assert.match(run.run_id, uuid);
  assert.match(run.command_id, uuid);
  console.log(`seed_api_exit=0 run_id=${run.run_id}`);
  return run;
}

async function hold(name, role, command, relation, mode) {
  const url = `postgresql://${role}@127.0.0.1:${state.marker.postgres_port}/relay_m02_acceptance`;
  const child = spawn(psql, [url, '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c',
    `set application_name='${name}'; begin; ${command}; select pg_sleep(300); rollback;`],
  { cwd: desktopRoot, windowsHide: true, stdio: 'ignore' });
  const entry = { name, role, relation, mode, child, backendPid: 0, startedUs: null, released: false };
  state.holds.push(entry);
  const identity = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`${name} exited before lock verification`);
    const rows = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('pid',pid,'started_us',` +
      `(extract(epoch from backend_start)*1000000)::bigint))::text,'[]') ` +
      `from pg_stat_activity where application_name='${name}' and usename='${role}' ` +
      "and datname='relay_m02_acceptance' and backend_type='client backend' " +
      "and client_addr='127.0.0.1'::inet", 'relay_api_admin'));
    if (rows.length === 0) return null;
    assert.equal(rows.length, 1, `${name} session identity is not unique`);
    return rows[0];
  }, 10_000, `${name} PostgreSQL backend`);
  assert.ok(Number.isInteger(identity.pid) && identity.pid > 0);
  assert.match(String(identity.started_us), /^\d{15,17}$/u);
  entry.backendPid = identity.pid;
  entry.startedUs = String(identity.started_us);
  await waitFor(async () => (await sql(`select count(*) from pg_stat_activity a join pg_locks l on l.pid=a.pid ` +
    `where a.pid=${entry.backendPid} and (extract(epoch from a.backend_start)*1000000)::bigint=${entry.startedUs} ` +
    `and a.application_name='${name}' and a.usename='${role}' and a.datname='relay_m02_acceptance' ` +
    `and a.backend_type='client backend' and a.client_addr='127.0.0.1'::inet ` +
    `and l.relation='${relation}'::regclass and l.mode='${mode}' and l.granted`, 'relay_api_admin')) === '1',
  10_000, `${name} granted relation lock`);
  console.log(`${name}_backend_pid=${entry.backendPid} ${mode}=granted`);
  return entry;
}

async function releaseHold(entry) {
  if (entry.released) return;
  assert.ok(entry.backendPid && entry.startedUs, `${entry.name} session identity was not established`);
  const result = await sql(`select coalesce((select pg_terminate_backend(a.pid)::text ` +
    `from pg_stat_activity a where a.pid=${entry.backendPid} ` +
    `and (extract(epoch from a.backend_start)*1000000)::bigint=${entry.startedUs} ` +
    `and a.application_name='${entry.name}' and a.usename='${entry.role}' ` +
    `and a.datname='relay_m02_acceptance' and a.backend_type='client backend' ` +
    `and a.client_addr='127.0.0.1'::inet and exists(select 1 from pg_locks l ` +
    `where l.pid=a.pid and l.relation='${entry.relation}'::regclass ` +
    `and l.mode='${entry.mode}' and l.granted)), 'identity_changed')`, 'relay_api_admin');
  assert.equal(result, 'true', `controlled lock identity changed: ${entry.name}`);
  await waitFor(async () => (await sql(`select count(*) from pg_stat_activity where pid=${entry.backendPid}`,
    'relay_api_admin')) === '0', 10_000, `${entry.name} release`);
  entry.released = true;
}

async function startHost() {
  const port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_') || key.startsWith('RELAY_')) delete env[key];
  }
  env.RELAY_DESKTOP_CONFIG_PATH = state.marker.config_path;
  env.RELAY_DESKTOP_DATA_ROOT = state.marker.data_root;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  const log = openSync(join(state.root, 'host-reconnect.log'), 'a');
  try {
    state.host = spawn(exe, [], { cwd: releaseRoot, env,
      windowsHide: false, stdio: ['ignore', log, log] });
  } finally { closeSync(log); }
  state.marker.desktop_pid = state.host.pid;
  writeFileSync(join(state.root, 'session.json'), JSON.stringify(state.marker), 'utf8');
  state.browser = await waitFor(async () => {
    if (state.host.exitCode !== null) throw new Error(`packaged desktop exited ${state.host.exitCode}`);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
    catch { return null; }
  }, 180_000, 'packaged WebView2 CDP endpoint');
  state.page = await waitFor(() => state.browser.contexts().flatMap((context) => context.pages())
    .find((item) => /^http:\/\/tauri\.localhost(?:\/|$)/u.test(item.url())),
  20_000, 'packaged main WebView');
  await state.page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  const bootstrap = await state.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'));
  assert.match(bootstrap.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(bootstrap.workspaceId, state.marker.workspace_id);
  assert.match(bootstrap.bearerToken, /^[0-9a-f]{64}$/u);
  console.log(`host_pid=${state.host.pid} cdp_port=${port} bootstrap=ready`);
  return bootstrap;
}

async function processIdentity(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const result = await runPowerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
    `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
  assert.notEqual(result, 'none', `process ${pid} is missing`);
  return { pid, created: result };
}

async function processTree() {
  const host = await processIdentity(state.host.pid);
  const query = `$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${host.pid}"); ` +
    `$api=@($children | Where-Object { $_.CommandLine -like '*dist\\src\\main.js*' }); ` +
    `$supervisor=@($children | Where-Object { $_.CommandLine -like '*dist\\src\\worker\\supervisor-main.js*' }); ` +
    `if ($api.Count -ne 1 -or $supervisor.Count -ne 1) { throw 'sidecar topology invalid' }; ` +
    `@{api=[int]$api[0].ProcessId;supervisor=[int]$supervisor[0].ProcessId} | ConvertTo-Json -Compress`;
  const sidecars = JSON.parse(await runPowerShell(query));
  const api = await processIdentity(sidecars.api);
  const supervisor = await processIdentity(sidecars.supervisor);
  state.identities.push(host, api, supervisor);
  console.log(`processes host=${host.pid} api=${api.pid} supervisor=${supervisor.pid}`);
  return { host, api, supervisor };
}

async function assertSameProcess(identity) {
  assert.deepEqual(await processIdentity(identity.pid), identity, `process ${identity.pid} changed`);
}

async function eventSeq(runId) {
  assert.match(runId, uuid);
  const value = await sql(`select coalesce(max(seq),0)::text from run_events where run_id='${runId}'`);
  return Number(value);
}

async function waitCommandSettled(run) {
  await waitFor(async () => (await sql(`select i.status || '|' || o.status from run_invocations i ` +
    `join run_commands c on c.run_id=i.run_id join run_command_outbox o on o.command_id=c.id ` +
    `where i.run_id='${run.run_id}' and c.source_command_id='${run.command_id}'`)) === 'IDLE|DONE',
  45_000, 'real Mock Worker settlement');
}

async function findBlockedSseBackend(tableLockPid) {
  const queryShape = "query ~* '^[[:space:]]*select[[:space:]]+run_id,[[:space:]]*seq,[[:space:]]*kind,[[:space:]]*created_at'";
  const rows = await sql(`select coalesce(json_agg(json_build_object('pid',pid,'started_us',` +
    `(extract(epoch from backend_start)*1000000)::bigint,'address',client_addr::text))::text,'[]') ` +
    `from pg_stat_activity where usename='relay_app' and datname='relay_m02_acceptance' ` +
    `and backend_type='client backend' and client_addr='127.0.0.1'::inet ` +
    `and state='active' and wait_event_type='Lock' and ${tableLockPid}=any(pg_blocking_pids(pid)) ` +
    `and ${queryShape} and position('from run_events' in lower(query))>0`, 'relay_api_admin');
  const candidates = JSON.parse(rows);
  if (candidates.length === 0) return null;
  assert.equal(candidates.length, 1, 'SSE poll backend identity is not unique');
  const target = candidates[0];
  assert.ok(Number.isInteger(target.pid) && target.pid > 0);
  assert.match(String(target.started_us), /^\d{15,17}$/u);
  assert.equal(target.address, '127.0.0.1/32');
  return target;
}

async function terminateExactSseBackend(target, tableLockPid) {
  const result = await sql(`select coalesce((select pg_terminate_backend(pid)::text from pg_stat_activity ` +
    `where pid=${target.pid} and (extract(epoch from backend_start)*1000000)::bigint=${target.started_us} ` +
    `and usename='relay_app' and datname='relay_m02_acceptance' and backend_type='client backend' ` +
    `and client_addr='127.0.0.1'::inet and state='active' and wait_event_type='Lock' ` +
    `and ${tableLockPid}=any(pg_blocking_pids(pid)) ` +
    `and query ~* '^[[:space:]]*select[[:space:]]+run_id,[[:space:]]*seq,[[:space:]]*kind,[[:space:]]*created_at' ` +
    `and position('from run_events' in lower(query))>0), 'identity_changed')`, 'relay_api_admin');
  assert.equal(result, 'true', 'the exact blocked SSE backend changed before termination');
  await waitFor(async () => (await sql(`select count(*) from pg_stat_activity where pid=${target.pid} ` +
    `and (extract(epoch from backend_start)*1000000)::bigint=${target.started_us}`, 'relay_api_admin')) === '0',
  10_000, 'exact SSE backend termination');
  console.log(`sse_pg_terminated pid=${target.pid} backend_start_us=${target.started_us} ` +
    `database=relay_m02_acceptance role=relay_app query=listAfter blocked_by=${tableLockPid}`);
}

async function runScenario(run) {
  assert.equal(await eventSeq(run.run_id), 1, 'Delegate did not create the first durable Run event');
  const stepHold = await hold('relay_m03_sse_reconnect_step', 'relay_app',
    `select id from run_steps where run_id='${run.run_id}' and step_kind='BUILD_CONTEXT' for update`,
    'run_steps', 'RowShareLock');
  const bootstrap = await startHost();
  const tree = await processTree();
  const page = state.page;
  const path = `${bootstrap.baseUrl}/api/v1/workspaces/${bootstrap.workspaceId}/runs/${run.run_id}`;
  const requests = [];
  const responses = [];
  const closed = new Set();
  let runGets = 0;
  page.on('request', (request) => {
    const url = request.url();
    assert.ok(!url.includes(bootstrap.bearerToken), 'bearer leaked into request URL');
    if (url.startsWith(`${path}/events?`)) requests.push({ request, after: new URL(url).searchParams.get('after') });
    if (url === path && request.method() === 'GET') runGets++;
  });
  page.on('response', (response) => {
    if (response.url().startsWith(`${path}/events?`)) responses.push({ request: response.request(),
      after: new URL(response.url()).searchParams.get('after'), status: response.status() });
  });
  page.on('requestfailed', (request) => closed.add(request));
  page.on('requestfinished', (request) => closed.add(request));
  await page.goto(`http://tauri.localhost/runs/${run.run_id}`);
  await expect(page.getByTestId('run-detail')).toBeVisible({ timeout: 15_000 });
  const original = await waitFor(() => requests.find((item) => item.after === '0' &&
    responses.some((response) => response.request === item.request && response.status === 200)),
  10_000, 'first established WebView SSE request');
  await waitFor(() => runGets >= 2, 10_000, 'first durable event consumed by RunView');
  assert.equal(requests.length, 1, 'another WebView SSE request was open before fault injection');
  const active = await waitFor(async () => {
    const value = await sql(`select status || '|' || epoch::text from run_invocations where run_id='${run.run_id}'`);
    return value === 'ACTIVE|1' ? value : null;
  }, 20_000, 'real Worker claim before controlled disconnect');
  const workerBlocked = await sql(`select count(*) from pg_stat_activity where ${stepHold.backendPid}=any(pg_blocking_pids(pid))`,
    'relay_api_admin');
  assert.ok(Number(workerBlocked) >= 1, 'Worker step was not blocked by its row lock');
  console.log(`webview_initial request_after=0 response=200 seq=1 run_gets=${runGets} invocation=${active}`);

  let resumeReconnect;
  let interceptedResolve;
  const intercepted = new Promise((resolve) => { interceptedResolve = resolve; });
  const gate = new Promise((resolve) => { resumeReconnect = resolve; });
  state.releaseReconnect = resumeReconnect;
  let interceptedCount = 0;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(`${path}/events?`) && new URL(url).searchParams.get('after') === '1') {
      interceptedCount++;
      interceptedResolve(route.request());
      await gate;
    }
    await route.continue();
  });
  const tableHold = await hold('relay_m03_sse_reconnect_table', 'relay_api_admin',
    'lock table run_events in access exclusive mode', 'run_events', 'AccessExclusiveLock');
  const target = await waitFor(() => findBlockedSseBackend(tableHold.backendPid),
    10_000, 'one blocked SSE poll on the accepted package');
  await terminateExactSseBackend(target, tableHold.backendPid);
  await waitFor(() => closed.has(original.request), 10_000, 'original WebView SSE socket close');
  await Promise.race([intercepted, sleep(10_000).then(() => { throw new Error('RunView did not reconnect on the same page'); })]);
  assert.equal(interceptedCount, 1, 'RunView opened duplicate reconnect subscriptions');
  assert.equal(page.url(), `http://tauri.localhost/runs/${run.run_id}`);
  await expect(page.getByTestId('run-detail')).toBeVisible();
  for (const identity of Object.values(tree)) await assertSameProcess(identity);
  console.log(`webview_same_page_reconnect original_socket_closed=true new_after=1 host_api_supervisor_alive=true`);

  await releaseHold(tableHold);
  await releaseHold(stepHold);
  const newSeq = await waitFor(async () => (await eventSeq(run.run_id)) > 1 ? await eventSeq(run.run_id) : null,
    30_000, 'Mock Worker commits while reconnect HTTP request is held');
  await waitCommandSettled(run);
  const latest = await eventSeq(run.run_id);
  assert.ok(latest >= newSeq && latest > 1);
  const beforeCatchupGets = runGets;
  resumeReconnect();
  state.releaseReconnect = null;
  await waitFor(() => responses.some((response) => response.after === '1' && response.status === 200),
    10_000, 'SSE replay response after original cursor');
  await waitFor(() => runGets > beforeCatchupGets,
    10_000, 'history hint triggered a new authoritative Run GET');
  const runResponse = await fetch(path, { headers: {
    authorization: `Bearer ${bootstrap.bearerToken}`, origin: 'http://tauri.localhost',
  }, signal: AbortSignal.timeout(5000) });
  assert.equal(runResponse.status, 200, 'the original API process is no longer serving Run snapshots');
  const current = await runResponse.json();
  await expect(page.getByTestId('run-detail')).toContainText(`Run 修订 v${current.revision}`, { timeout: 10_000 });
  assert.equal(await sql(`select count(*) from run_control_requests where run_id='${run.run_id}'`), '0');
  assert.equal(await sql(`select count(*) from run_commands where run_id='${run.run_id}'`), '1');
  for (const identity of Object.values(tree)) await assertSameProcess(identity);
  console.log(`webview_history_catchup request_after=1 from_seq=1 to_seq=${latest} ` +
    `authoritative_revision=${current.revision} run_gets_after_replay=${runGets - beforeCatchupGets} ` +
    `same_host_api=true control_requests=0`);
  const hostLog = readFileSync(join(state.root, 'host-reconnect.log'), 'utf8');
  assert.ok(!hostLog.includes(bootstrap.bearerToken), 'host log retained the desktop bearer');
  console.log('bearer_in_url_host_log=false');
}

async function cleanup() {
  state.releaseReconnect?.();
  for (const entry of state.holds) {
    if (!entry.released && entry.backendPid) {
      try { await releaseHold(entry); } catch { /* Preserve cluster if a controlled lock remains. */ }
    }
  }
  await state.browser?.close().catch(() => undefined);
  state.browser = null;
  if (state.host?.pid && state.host.exitCode === null) {
    state.host.kill();
    await sleep(500);
  }
  if (!state.root || !existsSync(state.root)) return;
  for (const identity of state.identities) {
    const current = await runPowerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
      `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
    if (current === identity.created) throw new Error(`cleanup unsafe: process ${identity.pid} still uses the root`);
  }
  for (const entry of state.holds) {
    if (!entry.released) throw new Error(`cleanup unsafe: controlled lock ${entry.name} remains`);
  }
  const output = await runPowerShellFile('stop-acceptance-session.ps1', ['-SessionRoot', state.root]);
  assert.match(output, /postgres_stop_exit=0 temporary_root_removed=True/u);
  state.cleaned = true;
  console.log('postgres_stop_exit=0 temporary_root_removed=True');
}

let failure;
try {
  await startDisposableSession();
  const run = await seedRun();
  await runScenario(run);
} catch (error) { failure = error; }
try { await cleanup(); }
catch (error) {
  console.log(`cleanup_unverified=true session_root=${state.root ?? 'unknown'}`);
  console.log('recovery: stop only recorded desktop and controlled lock processes, then use stop-acceptance-session.ps1 -SessionRoot <printed-session-root>');
  if (!failure) failure = error;
}
const remaining = readdirSync(tmpdir()).filter((name) => sessionName.test(name) && !preexisting.has(name));
if (remaining.length || !state.cleaned) {
  console.log(`disposable_session_remaining=${remaining.join(',') || 'none'}`);
  if (!failure) failure = new Error('disposable PostgreSQL cleanup was not verified');
}
if (failure) throw failure;
console.log('M03_SSE_SAME_PAGE_RECONNECT_REAL_PG=PASS');
