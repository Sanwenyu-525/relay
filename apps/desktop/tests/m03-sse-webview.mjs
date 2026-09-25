// Real packaged WebView2 + disposable PostgreSQL + bundled API/Mock Worker SSE path.
// Credentials stay in process memory; only non-secret statuses, cursors and PIDs are printed.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
const expectedSseSha = process.argv[2];
const expectedMigrationSha = process.argv[3];

assert.equal(process.version, 'v24.21.0', 'run with the portable Node 24.21.0');
assert.match(expectedSseSha ?? '', /^[0-9a-f]{64}$/u,
  'usage: node m03-sse-webview.mjs <accepted-package-SSE-SHA256> <accepted-migration-SHA256>');
assert.match(expectedMigrationSha ?? '', /^[0-9a-f]{64}$/u);
for (const path of [exe, node, psql, join(releaseRoot, 'desktop-build-manifest.json'),
  join(releaseRoot, 'api', 'dist', 'src', 'api', 'run-events-api.js'),
  join(releaseRoot, 'api', 'migrations', '0012_m03_run_events.sql')]) {
  assert.ok(existsSync(path), `missing packaged SSE input: ${path}`);
}
const manifest = JSON.parse(readFileSync(join(releaseRoot, 'desktop-build-manifest.json'), 'utf8').replace(/^\uFEFF/u, ''));
const exeSha = createHash('sha256').update(readFileSync(exe)).digest('hex');
assert.equal(exeSha, manifest.artifact_sha256, 'release EXE differs from its package manifest');
const packagedSseSha = createHash('sha256').update(readFileSync(join(releaseRoot, 'api', 'dist', 'src', 'api', 'run-events-api.js'))).digest('hex');
const packagedMigrationSha = createHash('sha256').update(readFileSync(join(releaseRoot, 'api', 'migrations', '0012_m03_run_events.sql'))).digest('hex');
assert.equal(packagedSseSha, expectedSseSha, 'release SSE entry differs from the accepted backend');
assert.equal(packagedMigrationSha, expectedMigrationSha, 'release SSE migration differs from the accepted backend');
const powerShellEnv = { ...process.env };
for (const key of Object.keys(powerShellEnv)) {
  if (key.toLowerCase() === 'psmodulepath') delete powerShellEnv[key];
}
const preexisting = new Set(readdirSync(tmpdir()).filter((name) => sessionName.test(name)));
const state = { root: null, marker: null, host: null, browser: null, page: null,
  locks: [], identities: [], hostLogs: [], cleaned: false };

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
  } catch {
    throw new Error('disposable PostgreSQL probe failed');
  }
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
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
  // PostgreSQL may retain the launcher stdout pipe after PowerShell exits.
  // Treat the explicit session marker as completion, then detach the pipe.
  const launcher = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(scripts, 'start-acceptance-session.ps1'), '-SkipDesktop'],
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
      if (error) fail(error);
      else done(value);
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
  assert.equal(state.marker.release_sha256, exeSha);
  assert.equal(resolve(state.marker.data_root).toLowerCase(), resolve(root, 'data').toLowerCase());
  assert.match(state.marker.workspace_id, uuid);
  console.log(`session_id=${state.marker.session_id} pg_port=${state.marker.postgres_port} release_sha256=${exeSha}`);
  console.log(`packaged_sse_sha256=${packagedSseSha} packaged_migration_sha256=${packagedMigrationSha}`);
}

async function seedRuns() {
  const { stdout } = await execFileAsync(node,
    [join(desktopRoot, 'tests', 'm03-seed-run.mjs'), state.root, '3'],
    { cwd: desktopRoot, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
  const seeded = JSON.parse(stdout);
  assert.equal(seeded.seed_api_exit, 0);
  assert.equal(seeded.runs.length, 3);
  for (const run of seeded.runs) {
    assert.match(run.run_id, uuid);
    assert.match(run.task_id, uuid);
    assert.match(run.command_id, uuid);
  }
  console.log(`seed_api_exit=0 run_ids=${seeded.runs.map((run) => run.run_id).join(',')}`);
  return seeded.runs;
}

async function holdStep(runId, index) {
  assert.match(runId, uuid);
  const name = `relay_m03_sse_hold_${index}`;
  const url = `postgresql://relay_app@127.0.0.1:${state.marker.postgres_port}/relay_m02_acceptance`;
  const query = `set application_name='${name}'; begin; ` +
    `select id from run_steps where run_id='${runId}' and step_kind='BUILD_CONTEXT' for update; ` +
    'select pg_sleep(300); rollback;';
  const child = spawn(psql, [url, '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { cwd: desktopRoot, windowsHide: true, stdio: 'ignore' });
  const lock = { name, child, backendPid: 0, released: false };
  state.locks.push(lock);
  const backendPid = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`step row hold ${index} exited before verification`);
    const value = await sql(`select pid from pg_stat_activity where application_name='${name}'`, 'relay_api_admin');
    return /^[1-9]\d*$/u.test(value) ? Number(value) : null;
  }, 10_000, `step row hold ${index}`);
  const rowLocks = await sql(`select count(*) from pg_locks where pid=${backendPid} ` +
    "and relation='run_steps'::regclass and mode='RowShareLock' and granted", 'relay_api_admin');
  assert.equal(rowLocks, '1', 'controlled Worker hold did not lock the intended run_steps row');
  lock.backendPid = backendPid;
  console.log(`step_row_hold_${index}_backend_pid=${backendPid}`);
  return lock;
}

async function releaseStep(lock) {
  if (lock.released) return;
  const ended = await sql(`select pg_terminate_backend(${lock.backendPid})`, 'relay_api_admin');
  assert.equal(ended, 't', 'could not release the one controlled step row lock');
  lock.released = true;
  await waitFor(async () => (await sql(`select count(*) from pg_stat_activity where pid=${lock.backendPid}`, 'relay_api_admin')) === '0',
    10_000, 'step row lock release');
}

function hostEnvironment(cdpPort) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_') || key.startsWith('RELAY_')) delete env[key];
  }
  env.RELAY_DESKTOP_CONFIG_PATH = state.marker.config_path;
  env.RELAY_DESKTOP_DATA_ROOT = state.marker.data_root;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`;
  return env;
}

async function startHost(label) {
  const port = await freePort();
  const logPath = join(state.root, `host-${label}.log`);
  const log = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(exe, [], { cwd: releaseRoot, env: hostEnvironment(port),
      windowsHide: false, stdio: ['ignore', log, log] });
  } finally { closeSync(log); }
  state.host = child;
  state.hostLogs.push(logPath);
  state.marker.desktop_pid = child.pid;
  writeFileSync(join(state.root, 'session.json'), JSON.stringify(state.marker), 'utf8');
  const browser = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`packaged desktop exited ${child.exitCode}`);
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
    catch { return null; }
  }, 180_000, 'packaged WebView2 CDP endpoint');
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
  console.log(`${label}_host_pid=${child.pid} cdp_port=${port} bootstrap=ready`);
  return { page, bootstrap };
}

function pathFor(bootstrap, runId, workspaceId = bootstrap.workspaceId) {
  assert.match(runId, uuid);
  assert.match(workspaceId, uuid);
  return `${bootstrap.baseUrl}/api/v1/workspaces/${workspaceId}/runs/${runId}`;
}

async function getRun(bootstrap, runId) {
  const response = await fetch(pathFor(bootstrap, runId), {
    headers: { authorization: `Bearer ${bootstrap.bearerToken}`, origin: 'http://tauri.localhost' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'authoritative Run GET failed');
  return response.json();
}

async function checkBoundary(bootstrap, runId) {
  const url = `${pathFor(bootstrap, runId)}/events?after=0`;
  async function status(target, headers) {
    const response = await fetch(target, { headers, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return response.status;
  }
  const token = `Bearer ${bootstrap.bearerToken}`;
  const noBearer = await status(url, { origin: 'http://tauri.localhost' });
  const wrongOrigin = await status(url, { authorization: token, origin: 'http://untrusted.invalid' });
  // Node fetch rewrites Host from the URL. Use the raw HTTP client for this negative case.
  const wrongHost = await new Promise((done, fail) => {
    const request = httpRequest(url, {
      headers: { authorization: token, origin: 'http://tauri.localhost', host: 'untrusted.invalid' },
    }, (response) => { response.resume(); done(response.statusCode); });
    request.setTimeout(5000, () => request.destroy(new Error('wrong-Host probe timed out')));
    request.once('error', fail);
    request.end();
  });
  const otherWorkspace = await status(`${pathFor(bootstrap, runId, '11111111-1111-4111-8111-111111111111')}/events?after=0`,
    { authorization: token, origin: 'http://tauri.localhost' });
  assert.deepEqual({ noBearer, wrongOrigin, wrongHost, otherWorkspace },
    { noBearer: 401, wrongOrigin: 403, wrongHost: 400, otherWorkspace: 404 });
  console.log('sse_boundary no_bearer=401 wrong_origin=403 wrong_host=400 other_workspace=404');
}

async function firstFrame(bootstrap, runId) {
  const controller = new AbortController();
  const response = await fetch(`${pathFor(bootstrap, runId)}/events?after=0`, {
    headers: { authorization: `Bearer ${bootstrap.bearerToken}`, origin: 'http://tauri.localhost',
      accept: 'text/event-stream' }, signal: controller.signal,
  });
  try {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/iu);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frame = '';
    while (!frame.includes('\n\n') && frame.length < 16 * 1024) {
      const { done, value } = await Promise.race([
        reader.read(), sleep(5000).then(() => { throw new Error('SSE first frame timeout'); }),
      ]);
      if (done) throw new Error('SSE ended before the first durable frame');
      frame += decoder.decode(value, { stream: true });
    }
    const id = /^id: (\d+)$/mu.exec(frame)?.[1];
    const kind = /^data: (.+)$/mu.exec(frame)?.[1];
    assert.equal(id, '1');
    assert.equal(/^event: run_hint$/mu.test(frame), true);
    assert.equal(typeof JSON.parse(kind).kind, 'string');
    console.log('sse_protocol first_id=1 event=run_hint data_kind=valid');
  } finally { controller.abort(); }
}

async function probeWebViewReconnect(page, runId) {
  return page.evaluate(async (id) => {
    const connection = await window.__TAURI_INTERNALS__.invoke('desktop_bootstrap');
    const base = `${connection.baseUrl}/api/v1/workspaces/${connection.workspaceId}/runs/${id}/events`;
    async function readOne(after) {
      const controller = new AbortController();
      try {
        const response = await fetch(`${base}?after=${after}`, {
          headers: { authorization: `Bearer ${connection.bearerToken}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (response.status !== 200 || !response.body) throw new Error('WebView SSE response was unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let frame = '';
        while (!frame.includes('\n\n') && frame.length < 16 * 1024) {
          const { done, value } = await Promise.race([
            reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('WebView SSE frame timeout')), 5000)),
          ]);
          if (done) throw new Error('WebView SSE ended before a durable frame');
          frame += decoder.decode(value, { stream: true });
        }
        const seq = /^id: (\d+)$/mu.exec(frame)?.[1];
        if (!seq || !/^event: run_hint$/mu.test(frame)) throw new Error('WebView SSE frame has no durable ID');
        return seq;
      } finally { controller.abort(); }
    }
    const first = await readOne('0');
    const second = await readOne(first);
    return { first, second };
  }, runId);
}

function watchRequests(page, bootstrap, runIds) {
  const ledger = { events: [], responses: [], runGets: new Map(runIds.map((id) => [id, 0])),
    controlPosts: 0, urlsSafe: true };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes(bootstrap.bearerToken)) ledger.urlsSafe = false;
    if (!url.startsWith(`${bootstrap.baseUrl}/api/v1/workspaces/`)) return;
    const parsed = new URL(url);
    const eventRun = /\/runs\/([0-9a-f-]{36})\/events$/iu.exec(parsed.pathname)?.[1];
    if (eventRun) {
      ledger.events.push({ runId: eventRun, after: parsed.searchParams.get('after'),
        auth: request.headers().authorization === `Bearer ${bootstrap.bearerToken}` });
    } else {
      const runGet = /\/runs\/([0-9a-f-]{36})$/iu.exec(parsed.pathname)?.[1];
      if (runGet && request.method() === 'GET') ledger.runGets.set(runGet, (ledger.runGets.get(runGet) ?? 0) + 1);
      if (request.method() === 'POST' && /\/control-requests$|\/resume$/u.test(parsed.pathname)) ledger.controlPosts++;
    }
  });
  page.on('response', (response) => {
    const parsed = new URL(response.url());
    const runId = /\/runs\/([0-9a-f-]{36})\/events$/iu.exec(parsed.pathname)?.[1];
    if (runId) ledger.responses.push({ runId, after: parsed.searchParams.get('after'), status: response.status() });
  });
  return ledger;
}

async function eventSeq(runId) {
  assert.match(runId, uuid);
  const sequence = await sql(`select coalesce(string_agg(seq::text, ',' order by seq), '') from run_events where run_id='${runId}'`);
  const values = sequence === '' ? [] : sequence.split(',').map(Number);
  for (let index = 0; index < values.length; index++) assert.equal(values[index], index + 1);
  return values.length;
}

async function waitCommandSettled(run) {
  await waitFor(async () => {
    const value = await sql(`select i.status || '|' || o.status from run_invocations i ` +
      `join run_commands c on c.run_id=i.run_id ` +
      `join run_command_outbox o on o.command_id=c.id ` +
      `where i.run_id='${run.run_id}' and c.source_command_id='${run.command_id}'`);
    return value === 'IDLE|DONE';
  }, 40_000, `Mock Worker settlement for Run ${run.run_id}`);
}

async function waitRunRevision(page, revision, timeout = 12_000) {
  await expect(page.getByTestId('run-detail')).toContainText(`Run 修订 v${revision}`, { timeout });
}

async function navigateRun(page, runId) {
  await page.goto(`http://tauri.localhost/runs/${runId}`);
  await expect(page.getByTestId('run-detail')).toBeVisible({ timeout: 15_000 });
}

async function runWebViewChecks(runs, first) {
  const { page, bootstrap } = first;
  const [live, fallback, restart] = runs;
  const ledger = watchRequests(page, bootstrap, runs.map((run) => run.run_id));
  await checkBoundary(bootstrap, live.run_id);
  await firstFrame(bootstrap, live.run_id);
  await navigateRun(page, live.run_id);
  await waitFor(() => ledger.responses.some((item) => item.runId === live.run_id && item.after === '0' && item.status === 200),
    10_000, 'historical SSE response in WebView');
  await waitFor(() => (ledger.runGets.get(live.run_id) ?? 0) >= 2, 10_000,
    'historical SSE hint to trigger authoritative Run GET');
  const before = await eventSeq(live.run_id);
  const readsBefore = ledger.runGets.get(live.run_id);
  await releaseStep(state.locks[0]);
  const after = await waitFor(async () => (await eventSeq(live.run_id)) > before ? await eventSeq(live.run_id) : null,
    20_000, 'new committed Run events from the real Mock Worker');
  await waitCommandSettled(live);
  const current = await getRun(bootstrap, live.run_id);
  await waitRunRevision(page, current.revision);
  assert.ok((ledger.runGets.get(live.run_id) ?? 0) > readsBefore, 'live event did not trigger a new authoritative snapshot');
  console.log(`webview_initial_and_live run_id=${live.run_id} historical_seq=${before} after_worker_seq=${after} snapshot_gets=${ledger.runGets.get(live.run_id)}`);

  const resumed = await probeWebViewReconnect(page, live.run_id);
  assert.equal(resumed.first, '1');
  assert.equal(resumed.second, '2');
  const latestBeforeDisconnect = await eventSeq(live.run_id);
  await page.getByRole('link', { name: '返回关联任务' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${live.task_id}$`, 'u'));
  await sleep(300);
  assert.equal(ledger.controlPosts, 0, 'leaving Run page submitted a control command');
  console.log(`webview_controlled_stream_abort_resume first=${resumed.first} resumed=${resumed.second} latest=${latestBeforeDisconnect} left_page_without_cancel=true`);

  let blockedSseRequests = 0;
  const blockedPattern = new RegExp(`/runs/${fallback.run_id}/events\\?after=`, 'u');
  await page.route('**/*', async (route) => {
    if (blockedPattern.test(route.request().url())) { blockedSseRequests++; await route.abort('failed'); }
    else await route.continue();
  });
  await navigateRun(page, fallback.run_id);
  await waitFor(() => blockedSseRequests > 0, 10_000, 'controlled SSE network failure');
  const fallbackBefore = await eventSeq(fallback.run_id);
  const fallbackReads = ledger.runGets.get(fallback.run_id) ?? 0;
  await releaseStep(state.locks[1]);
  await waitFor(async () => (await eventSeq(fallback.run_id)) > fallbackBefore,
    20_000, 'Mock Worker committed facts while SSE was unavailable');
  await waitCommandSettled(fallback);
  const fallbackRun = await getRun(bootstrap, fallback.run_id);
  await waitRunRevision(page, fallbackRun.revision, 20_000);
  assert.ok((ledger.runGets.get(fallback.run_id) ?? 0) > fallbackReads,
    'disconnected SSE did not fall back to authoritative snapshot GET');
  await page.unroute('**/*');
  await waitFor(() => ledger.responses.some((item) => item.runId === fallback.run_id && item.after === '0' && item.status === 200),
    20_000, 'historical replay after SSE network recovery');
  console.log(`webview_snapshot_correction run_id=${fallback.run_id} from_seq=${fallbackBefore} to_seq=${await eventSeq(fallback.run_id)} blocked_requests=${blockedSseRequests}`);

  await navigateRun(page, restart.run_id);
  await waitFor(() => ledger.responses.some((item) => item.runId === restart.run_id && item.after === '0' && item.status === 200),
    10_000, 'pre-kill Run SSE stream');
  const active = await waitFor(async () => {
    const row = await sql(`select status || '|' || epoch::text || '|' || worker_id from run_invocations where run_id='${restart.run_id}'`);
    return row.startsWith('ACTIVE|') && row.split('|')[2]?.startsWith('worker:desktop:') ? row : null;
  }, 20_000, 'third Run claimed by real Worker');
  const beforeKill = await eventSeq(restart.run_id);
  const blocked = await sql(`select count(*) from pg_stat_activity where ${state.locks[2].backendPid} = any(pg_blocking_pids(pid))`,
    'relay_api_admin');
  assert.ok(Number(blocked) >= 1, 'third Worker was not blocked by its row lock');
  assert.equal(ledger.controlPosts, 0);
  assert.equal(ledger.urlsSafe, true, 'a WebView request URL contained its bearer');
  const storageSafe = await page.evaluate((token) =>
    [...Object.entries(localStorage), ...Object.entries(sessionStorage)]
      .every(([key, value]) => !key.includes(token) && !value.includes(token)), bootstrap.bearerToken);
  assert.equal(storageSafe, true, 'WebView storage contains its bearer');
  console.log(`pre_kill_run=${restart.run_id} event_seq=${beforeKill} invocation=${active.split('|').slice(0, 2).join('|')} worker_blocked=true`);
  return { beforeKill, bootstrap, ledger, restart, active };
}

async function processSnapshot(hostPid, requireWorker = true) {
  assert.ok(Number.isInteger(hostPid) && hostPid > 0);
  const command = `function I($p) { if ($null -eq $p) { return $null }; return @{ pid=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; created=([datetime]$p.CreationDate).ToUniversalTime().ToString('o'); executable=[string]$p.ExecutablePath } }; ` +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${hostPid}"; ` +
    `if ($null -eq $p) { throw 'host missing' }; ` +
    `$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid}"); ` +
    `$api=@($children | Where-Object { $_.CommandLine -like '*dist\\src\\main.js*' }); ` +
    `$supervisor=@($children | Where-Object { $_.CommandLine -like '*dist\\src\\worker\\supervisor-main.js*' }); ` +
    `if ($api.Count -ne 1 -or $supervisor.Count -ne 1) { throw 'sidecar topology invalid' }; ` +
    `$worker=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor[0].ProcessId)" | ` +
    `Where-Object { $_.CommandLine -like '*dist\\src\\worker\\main.js*' }); ` +
    `if ($worker.Count -gt 1 -or (${requireWorker ? '$true' : '$false'} -and $worker.Count -ne 1)) { throw 'worker topology invalid' }; ` +
    `@{ host=(I $p); api=(I $api[0]); supervisor=(I $supervisor[0]); ` +
    `worker=$(if ($worker.Count -eq 1) { I $worker[0] } else { $null }) } | ConvertTo-Json -Compress -Depth 4`;
  const snapshot = JSON.parse(await runPowerShell(command));
  state.identities.push(...Object.values(snapshot).filter(Boolean));
  console.log(`processes_before_kill host=${snapshot.host.pid} api=${snapshot.api.pid} supervisor=${snapshot.supervisor.pid} worker=${snapshot.worker?.pid ?? 0}`);
  return snapshot;
}

async function assertStopped(identities) {
  for (const identity of Object.values(identities).filter(Boolean)) {
    const now = await runPowerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
      `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
    assert.notEqual(now, identity.created, `old ${identity.pid} is still running`);
  }
}

async function captureOwnedForCleanup(hostPid) {
  if (!Number.isInteger(hostPid) || hostPid < 1) return;
  const command = `function I($p) { return @{ pid=[int]$p.ProcessId; created=([datetime]$p.CreationDate).ToUniversalTime().ToString('o') } }; ` +
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${hostPid}"; ` +
    `$found=@(); if ($null -ne $p) { $found+=(I $p) }; ` +
    `$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid}" | ` +
    `Where-Object { $_.ExecutablePath -like '*\\apps\\desktop\\release\\node.exe' }); ` +
    `foreach ($child in $children) { $found+=(I $child); ` +
    `$found+=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($child.ProcessId)" | ` +
    `Where-Object { $_.ExecutablePath -like '*\\apps\\desktop\\release\\node.exe' } | ForEach-Object { I $_ }) }; ` +
    `ConvertTo-Json -InputObject @($found) -Compress -Depth 3`;
  const found = JSON.parse(await runPowerShell(command));
  state.identities.push(...found);
}

async function killHostAndWait(snapshot) {
  assert.ok(state.host && state.host.pid === snapshot.host.pid);
  state.host.kill(); // Only the Rust host is killed; Job Objects must stop both Node sidecars and Worker.
  await waitFor(async () => {
    try { await assertStopped(snapshot); return true; } catch { return false; }
  }, 10_000, 'host/API/supervisor/Worker process tree to stop');
  await state.browser?.close().catch(() => undefined);
  state.browser = null;
  state.page = null;
  console.log('after_host_kill host_api_supervisor_worker_alive=0');
}

async function finishRestart(earlier) {
  await releaseStep(state.locks[2]);
  const reopened = await startHost('restart');
  const ledger = watchRequests(reopened.page, reopened.bootstrap, [earlier.restart.run_id]);
  await navigateRun(reopened.page, earlier.restart.run_id);
  await waitFor(() => ledger.responses.some((item) => item.after === '0' && item.status === 200),
    10_000, 'reopened Run historical SSE stream');
  await waitFor(async () => (await eventSeq(earlier.restart.run_id)) > earlier.beforeKill,
    45_000, 'recovered Mock Worker committed Run events');
  await waitCommandSettled(earlier.restart);
  const current = await getRun(reopened.bootstrap, earlier.restart.run_id);
  await waitRunRevision(reopened.page, current.revision, 20_000);
  const commands = await sql(`select count(*) from run_commands where run_id='${earlier.restart.run_id}'`);
  const controls = await sql(`select count(*) from run_control_requests where run_id='${earlier.restart.run_id}'`);
  const recovered = await sql(`select status || '|' || epoch::text from run_invocations where run_id='${earlier.restart.run_id}'`);
  assert.equal(commands, '1', 'restart changed original command identity');
  assert.equal(controls, '0', 'page navigation or restart submitted a control request');
  assert.equal(recovered, 'IDLE|2', 'the recovered Worker did not use the next fenced epoch');
  assert.equal(ledger.urlsSafe, true);
  assert.ok(ledger.events.every((item) => item.auth), 'reopened SSE omitted the in-memory Bearer');
  await processSnapshot(state.host.pid, false);
  console.log(`after_restart run_id=${earlier.restart.run_id} seq=${await eventSeq(earlier.restart.run_id)} revision=${current.revision} invocation=${recovered} original_commands=1 control_requests=0`);
  for (const log of state.hostLogs) {
    const content = readFileSync(log, 'utf8');
    assert.ok(!content.includes(earlier.bootstrap.bearerToken) &&
      !content.includes(reopened.bootstrap.bearerToken), 'host log retained a desktop bearer');
  }
  console.log('bearer_in_url_storage_host_logs=false');
}

async function cleanup() {
  for (const lock of state.locks) {
    if (!lock.released && lock.backendPid) {
      try { await releaseStep(lock); } catch { /* Keep the cluster if a controlled lock remains. */ }
    }
  }
  await state.browser?.close().catch(() => undefined);
  state.browser = null;
  if (state.host?.pid && state.host.exitCode === null) {
    await captureOwnedForCleanup(state.host.pid);
    state.host.kill();
    await sleep(500);
  }
  if (!state.root || !existsSync(state.root)) return;
  for (const identity of state.identities) {
    const now = await runPowerShell(`$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}"; ` +
      `if ($null -eq $p) { 'none' } else { ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') }`);
    if (now === identity.created) throw new Error(`cleanup unsafe: process ${identity.pid} still uses the disposable root`);
  }
  for (const lock of state.locks) {
    if (!lock.released) throw new Error(`cleanup unsafe: row lock ${lock.name} remains`);
  }
  const output = await runPowerShellFile('stop-acceptance-session.ps1', ['-SessionRoot', state.root]);
  assert.match(output, /postgres_stop_exit=0 temporary_root_removed=True/u);
  state.cleaned = true;
  console.log('postgres_stop_exit=0 temporary_root_removed=True');
}

let failure;
try {
  await startDisposableSession();
  const runs = await seedRuns();
  for (let index = 0; index < runs.length; index++) await holdStep(runs[index].run_id, index + 1);
  const first = await startHost('initial');
  const beforeKill = await runWebViewChecks(runs, first);
  const snapshot = await processSnapshot(first.page ? state.host.pid : 0);
  await killHostAndWait(snapshot);
  const stranded = await sql(`select status || '|' || epoch::text || '|' || worker_id ` +
    `from run_invocations where run_id='${beforeKill.restart.run_id}'`);
  assert.equal(stranded, beforeKill.active, 'old claim changed before trustworthy host recovery');
  assert.equal(await eventSeq(beforeKill.restart.run_id), beforeKill.beforeKill,
    'Run history changed after host kill without a new process');
  console.log(`after_kill_persisted invocation=${stranded.split('|').slice(0, 2).join('|')} event_seq=${beforeKill.beforeKill}`);
  await finishRestart(beforeKill);
} catch (error) { failure = error; }
try { await cleanup(); }
catch (error) {
  console.log(`cleanup_unverified=true session_root=${state.root ?? 'unknown'}`);
  console.log('recovery: stop only the recorded desktop and row-lock processes, then run apps/desktop/scripts/stop-acceptance-session.ps1 -SessionRoot <printed-session-root>');
  if (!failure) failure = error;
}
const remaining = readdirSync(tmpdir()).filter((name) => sessionName.test(name) && !preexisting.has(name));
if (remaining.length || !state.cleaned) {
  console.log(`disposable_session_remaining=${remaining.join(',') || 'none'}`);
  if (!failure) failure = new Error('disposable PostgreSQL cleanup was not verified');
}
if (failure) throw failure;
console.log('M03_SSE_WEBVIEW_REAL_PG=PASS');
