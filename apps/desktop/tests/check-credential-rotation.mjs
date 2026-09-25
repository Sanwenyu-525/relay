// Two sequential, real release WebView2/API/PostgreSQL sessions.
// Bootstrap credentials stay only in this test process memory; output is non-secret.
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const scripts = join(desktopRoot, 'scripts');
const release = join(desktopRoot, 'release');
const manifest = JSON.parse(readFileSync(join(release, 'desktop-build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const exeHash = createHash('sha256').update(readFileSync(join(release, 'relay-desktop.exe'))).digest('hex');
if (exeHash !== manifest.artifact_sha256 || process.version !== 'v24.21.0') {
  throw new Error('Release hash or portable Node version differs from the manifest');
}
const requireWorkbench = createRequire(new URL('../../workbench/package.json', import.meta.url));
const { chromium } = requireWorkbench('@playwright/test');
const ps = 'powershell.exe';
const psFlags = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];
const powerShellEnv = { ...process.env };
// The parent may be pwsh with a bundled compatibility module before Windows
// PowerShell's own modules; let powershell.exe reconstruct its normal search path.
for (const key of Object.keys(powerShellEnv)) {
  if (key.toLowerCase() === 'psmodulepath') delete powerShellEnv[key];
}
const sessions = [];
const tempSessionName = /^relay-m02-acceptance-[0-9a-f]{32}$/i;
const preexistingSessionNames = new Set(readdirSync(tmpdir()).filter((name) => tempSessionName.test(name)));

async function runScript(name, args) {
  const { stdout } = await execFileAsync(ps, [...psFlags, join(scripts, name), ...args], {
    cwd: desktopRoot, windowsHide: true, env: powerShellEnv, timeout: 60000, maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function startSession() {
  const cdpPort = await freePort();
  const launcher = spawn(ps, [...psFlags, join(scripts, 'start-acceptance-session.ps1')], {
    cwd: desktopRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...powerShellEnv, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1` },
  });
  const session = { launcher, cdpPort, root: null, browser: null, page: null, closed: false };
  sessions.push(session);
  let output = '';
  let errorOutput = '';
  await new Promise((done, fail) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) fail(error);
      else done();
    };
    const diagnostic = () => {
      const candidates = `${output}\n${errorOutput}`.split(/\r?\n/).map((line) => line.trim())
        .filter((line) => /error|failed|cannot|exit|exception|not found|denied|missing/i.test(line));
      return candidates.slice(-3).map((line) =>
        /Bearer|RELAY_|token|password|:\/\//i.test(line) ? 'details redacted' : line.slice(0, 180)
      ).join(' | ') || 'no non-secret error line';
    };
    const timer = setTimeout(() => finish(new Error(`Disposable desktop startup timed out; ${diagnostic()}`)), 60000);
    const read = (chunk) => {
      output += chunk.toString();
      const root = /(?:^|\r?\n)session_root=([^\r\n]+)/.exec(output)?.[1];
      const pid = /(?:^|\r?\n)desktop_pid=(\d+)/.exec(output)?.[1];
      const hash = /(?:^|\r?\n)release_sha256=([0-9a-f]{64})/.exec(output)?.[1];
      if (root) session.root = root;
      if (root && pid && hash && output.includes('cleanup: powershell')) {
        session.hostPid = Number(pid);
        session.releaseHash = hash;
        finish();
      }
    };
    launcher.stdout.on('data', read);
    launcher.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    launcher.once('error', () => finish(new Error('Disposable desktop helper could not start')));
    launcher.once('exit', (code) => {
      if (!settled) finish(new Error(`Disposable desktop startup exited ${code}; ${diagnostic()}`));
    });
  });
  launcher.stdout.destroy();
  launcher.stderr.destroy();
  if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(basename(session.root)) ||
      !resolve(session.root).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase() + '\\') ||
      session.releaseHash !== exeHash) {
    throw new Error('Disposable session marker does not match the release');
  }
  const state = JSON.parse(readFileSync(join(session.root, 'session.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (state.desktop_pid !== session.hostPid || state.release_sha256 !== exeHash ||
      resolve(state.release_exe).toLowerCase() !== join(release, 'relay-desktop.exe').toLowerCase()) {
    throw new Error('Disposable session state differs from the launch output');
  }
  const snapshot = JSON.parse(await runScript('check-acceptance-processes.ps1',
    ['-SessionRoot', session.root, '-Mode', 'Snapshot']));
  if (snapshot.host.process_id !== session.hostPid || snapshot.nodes.length !== 1) {
    throw new Error('Release host does not own exactly one bundled Node');
  }
  session.snapshotDone = true;
  session.node = snapshot.nodes[0];
  session.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 15000 });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    session.page = session.browser.contexts().flatMap((context) => context.pages())
      .find((page) => /^http:\/\/tauri\.localhost(?:\/|$)/.test(page.url()));
    if (session.page) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!session.page) throw new Error('Packaged main WebView did not appear');
  await session.page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  const bootstrap = await session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('desktop_bootstrap'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(bootstrap?.baseUrl ?? '') ||
      typeof bootstrap?.bearerToken !== 'string' || bootstrap.bearerToken.length !== 64 ||
      typeof bootstrap?.workspaceId !== 'string') {
    throw new Error('Real packaged bootstrap did not return a valid in-memory connection');
  }
  session.apiUrl = bootstrap.baseUrl;
  return { session, bootstrap };
}

async function health(baseUrl, token) {
  const response = await fetch(`${baseUrl}/health/ready`, {
    headers: { Authorization: `Bearer ${token}`, Origin: 'http://tauri.localhost' },
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ready: response.status === 200 && body?.status === 'ready' };
}

async function closeSession(session) {
  if (session.closed || !session.root) return;
  if (!existsSync(session.root)) { session.closed = true; return; }
  if (!session.snapshotDone) throw new Error(`Cleanup unverified for session ${session.root}: process baseline was not captured`);
  if (session.page && !session.page.isClosed()) {
    try {
      await session.page.evaluate(() => { void window.__TAURI_INTERNALS__.invoke('plugin:window|destroy', { label: 'main' }); });
    } catch { /* A closing WebView can end CDP before the reply. */ }
  }
  await session.browser?.close().catch(() => undefined);
  try {
    await runScript('check-acceptance-processes.ps1', ['-SessionRoot', session.root, '-Mode', 'AssertStopped']);
  } catch {
    await runScript('check-acceptance-processes.ps1', ['-SessionRoot', session.root, '-Mode', 'KillHostAndAssertJob']);
  }
  const cleanup = await runScript('stop-acceptance-session.ps1', ['-SessionRoot', session.root]);
  if (!cleanup.includes('postgres_stop_exit=0 temporary_root_removed=True')) {
    throw new Error('Disposable PostgreSQL cleanup did not complete');
  }
  session.closed = true;
}

let oldPortReservation;
let testFailure;
try {
  const first = await startSession();
  const firstReady = await health(first.bootstrap.baseUrl, first.bootstrap.bearerToken);
  if (firstReady.status !== 200 || !firstReady.ready) throw new Error('First real API was not ready');
  await closeSession(first.session);

  // Keep the released first port occupied so the second API must advertise its own address.
  const oldPort = Number(new URL(first.bootstrap.baseUrl).port);
  oldPortReservation = createServer();
  await new Promise((done, fail) => oldPortReservation.once('error', fail)
    .listen(oldPort, '127.0.0.1', done));

  const second = await startSession();
  const oldAgainstNew = await health(second.bootstrap.baseUrl, first.bootstrap.bearerToken);
  const newAgainstNew = await health(second.bootstrap.baseUrl, second.bootstrap.bearerToken);
  const changed = first.bootstrap.bearerToken !== second.bootstrap.bearerToken &&
    first.bootstrap.baseUrl !== second.bootstrap.baseUrl &&
    first.session.node.creation_utc !== second.session.node.creation_utc;
  if (!changed || oldAgainstNew.status !== 401 || newAgainstNew.status !== 200 || !newAgainstNew.ready) {
    throw new Error('Real release credential rotation or second-instance authentication failed');
  }
  console.log(`release_sha256=${exeHash} first_host_pid=${first.session.hostPid} first_node_pid=${first.session.node.process_id}`);
  console.log(`second_host_pid=${second.session.hostPid} second_node_pid=${second.session.node.process_id}`);
  console.log(`first_api=${first.bootstrap.baseUrl} second_api=${second.bootstrap.baseUrl}`);
  console.log('tokens_differ=true first_ready=200 old_token_to_second=401 new_token_to_second=200');
} catch (error) {
  testFailure = error;
} finally {
  if (oldPortReservation?.listening) await new Promise((done) => oldPortReservation.close(done));
  const cleanupFailures = [];
  for (const session of sessions.reverse()) {
    try { await closeSession(session); }
    catch { cleanupFailures.push(session.root ?? 'unidentified session'); }
  }
  const newSessionRoots = readdirSync(tmpdir()).filter((name) => tempSessionName.test(name) && !preexistingSessionNames.has(name));
  if (cleanupFailures.length || newSessionRoots.length || sessions.some((session) => !session.root || (!session.closed && session.launcher.exitCode === null))) {
    console.log(`cleanup_unverified=true known_sessions=${[...new Set([...cleanupFailures, ...newSessionRoots])].join(',') || 'none'}`);
    if (!testFailure) testFailure = new Error('Disposable session cleanup could not be verified');
  } else {
    console.log('disposable_sessions_cleaned=true');
  }
}
if (testFailure) throw testFailure;
