// Exercise the exact release Node/API against a disposable M02 PostgreSQL session.
// The private frame and desktop.env values never enter stdout or test logs.
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';

const sessionRoot = resolve(process.argv[2] ?? '');
if (!/^relay-m02-acceptance-[0-9a-f]{32}$/i.test(sessionRoot.split(/[\\/]/).at(-1) ?? '')) {
  throw new Error('Usage: node check-release-api.mjs <api-only-session-root>');
}
const session = JSON.parse(readFileSync(join(sessionRoot, 'session.json'), 'utf8').replace(/^\uFEFF/, ''));
if (session.desktop_pid !== 0) throw new Error('This check requires an API-only disposable session');
const releaseRoot = dirname(session.release_exe);
const releaseHash = createHash('sha256').update(readFileSync(session.release_exe)).digest('hex');
if (releaseHash !== session.release_sha256) throw new Error('Release hash differs from session marker');

const environment = { ...process.env, RELAY_DATA_ROOT: session.data_root };
for (const key of ['RELAY_DB_URL', 'RELAY_DB_POOL_MAX', 'RELAY_DB_CONNECT_TIMEOUT_MS', 'RELAY_DESKTOP_WORKSPACE_ID']) {
  delete environment[key];
}
const child = spawn(join(releaseRoot, 'node.exe'), [
  `--env-file=${session.config_path}`,
  join(releaseRoot, 'api', 'dist', 'src', 'main.js'),
  '--desktop-child',
], { cwd: releaseRoot, env: environment, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const nonce = randomBytes(16).toString('hex');
const bearerToken = randomBytes(32).toString('hex');
const exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
async function exitWithin(milliseconds) {
  let timer;
  try {
    return await Promise.race([
      exitPromise,
      new Promise((resolveExit) => { timer = setTimeout(() => resolveExit('timeout'), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
let stopped = false;
try {
  const lines = createInterface({ input: child.stdout });
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('Private readiness timed out')), 30000);
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.nonce !== nonce) return;
      if (event.type === 'desktop_error') {
        clearTimeout(timer);
        rejectReady(new Error(`API startup rejected: ${event.code}`));
      } else if (event.type === 'desktop_ready') {
        clearTimeout(timer);
        resolveReady(event);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      rejectReady(new Error('API exited before private readiness'));
    });
  });
  child.stdin.write(`${JSON.stringify({ nonce, bearerToken })}\n`);
  const ready = await readyPromise;
  if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 ||
      ready.nodeVersion !== 'v24.21.0' || ready.workspaceId !== session.workspace_id) {
    throw new Error('Private readiness identity did not match the disposable session');
  }
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const good = await fetch(`${baseUrl}/health/ready`, {
    headers: { authorization: `Bearer ${bearerToken}`, origin: 'http://tauri.localhost' },
  });
  const bad = await fetch(`${baseUrl}/health/ready`, {
    headers: { authorization: 'Bearer invalid', origin: 'http://tauri.localhost' },
  });
  if (good.status !== 200 || bad.status !== 401) throw new Error('Release API health boundary failed');
  child.stdin.end();
  const exitCode = await exitWithin(7000);
  if (exitCode !== 0) throw new Error(`Release API did not stop cleanly: ${exitCode}`);
  stopped = true;
  console.log(`release_sha256=${releaseHash}`);
  console.log('node=v24.21.0 private_readiness=pass workspace_match=pass ready_http=200 invalid_bearer=401 eof_exit=0');
} finally {
  if (!stopped) {
    child.stdin.end();
    const exitCode = await exitWithin(3000);
    if (exitCode === 'timeout') {
      child.kill();
      await exitPromise;
    }
  }
}
