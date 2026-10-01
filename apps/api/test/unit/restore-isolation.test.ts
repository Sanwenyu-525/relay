import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRestoreNotIsolated, RESTORE_ISOLATION_MARKER,
  RestoreIsolationError } from '../../src/runtime/restore-isolation.js';

const isolated = (e: unknown) => e instanceof RestoreIsolationError && e.code === 'RESTORE_ISOLATED';
const unavailable = (e: unknown) => e instanceof RestoreIsolationError && e.code === 'RESTORE_ISOLATION_UNAVAILABLE';

test('isolation is based on the entry, never on a purported successful restore or valid JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-marker-'));
  const marker = join(root, RESTORE_ISOLATION_MARKER);
  try {
    await assertRestoreNotIsolated(root);
    for (const text of ['', '{invalid', JSON.stringify({ status: 'COMPLETE', allowExecution: true })]) {
      await writeFile(marker, text);
      await assert.rejects(assertRestoreNotIsolated(root), isolated);
      assert.equal(await readFile(marker, 'utf8'), text);
    }
    await rm(marker);
    await mkdir(marker);
    await assert.rejects(assertRestoreNotIsolated(root), isolated);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a dangling marker link and errors determining absence refuse ordinary startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-marker-'));
  try {
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, RESTORE_ISOLATION_MARKER), process.platform === 'win32' ? 'junction' : 'dir');
    await rmdir(target);
    await assert.rejects(assertRestoreNotIsolated(root), isolated);
    const file = join(root, 'file');
    await writeFile(file, 'not a root directory');
    await assert.rejects(assertRestoreNotIsolated(file), unavailable);
    await assert.rejects(assertRestoreNotIsolated(join(file, 'missing-root')), unavailable);
    await assert.rejects(assertRestoreNotIsolated(`${root}\0`), unavailable);
    await assert.rejects(assertRestoreNotIsolated('relative-root'), unavailable);
    await assert.rejects(assertRestoreNotIsolated(''), unavailable);
    await assertRestoreNotIsolated(join(root, 'not-yet-created', 'data'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const modes = ['api', 'desktop-api', 'worker', 'supervisor', 'desktop-supervisor'] as const;
type Mode = typeof modes[number];

async function runEntry(mode: Mode, root: string, databasePort: number, apiPort: number): Promise<{
  code: number | null; stdout: string; stderr: string; timedOut: boolean;
}> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    RELAY_DB_URL: `postgresql://relay_app:test-only@127.0.0.1:${databasePort}/private_observer`,
    RELAY_DATA_ROOT: root, RELAY_API_BIND_HOST: '127.0.0.1', RELAY_API_PORT: String(apiPort),
    RELAY_API_ALLOWED_ORIGINS: 'http://127.0.0.1:5173', RELAY_API_BEARER_TOKEN: 'a'.repeat(64),
    RELAY_DB_POOL_MAX: '4', RELAY_DB_CONNECT_TIMEOUT_MS: '200', RELAY_LOG_LEVEL: 'fatal',
    RELAY_API_STOP_ON_STDIN_EOF: 'false', RELAY_WORKER_POLL_MS: '20',
    RELAY_DESKTOP_WORKSPACE_ID: randomUUID(),
    ...(mode === 'desktop-supervisor' ? { RELAY_SUPERVISOR_DESKTOP_MODE: 'true' } : {}),
  });
  const entry = mode.includes('api') ? join(srcRoot, 'main.js') :
    join(srcRoot, 'worker', mode === 'worker' ? 'main.js' : 'supervisor-main.js');
  const args = [entry, ...(mode === 'desktop-api' ? ['--desktop-child'] : ['--once'])];
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8_000);
  const closed = new Promise<number | null>((done, fail) => { child.once('close', done); child.once('error', fail); });
  // Keep the private pipe open: EOF would abort a supervisor before the tested boundary.
  if (mode === 'desktop-api') {
    child.stdin.write(`${JSON.stringify({ nonce: 'b'.repeat(32), bearerToken: 'a'.repeat(64) })}\n`);
  } else if (mode === 'desktop-supervisor') {
    child.stdin.write(`${JSON.stringify({ nonce: randomUUID(),
      launchId: randomUUID(), stoppedLaunches: [{ launchId: randomUUID(),
        stopEvidence: 'armed_job_absent_after_last_handle_closed' }] })}\n`);
  }
  try { return { code: await closed, stdout, stderr, timedOut }; }
  finally { clearTimeout(timer); child.stdin.destroy(); }
}

for (const mode of modes) {
  test(`${mode} refuses isolation before connecting, listening, readiness or old-launch acknowledgement`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-restore-startup-'));
    let connections = 0;
    const dbObserver = createServer(socket => { connections++; socket.destroy(); });
    const listenerObserver = createServer();
    await new Promise<void>(done => dbObserver.listen(0, '127.0.0.1', done));
    await new Promise<void>(done => listenerObserver.listen(0, '127.0.0.1', done));
    const databasePort = (dbObserver.address() as AddressInfo).port;
    // Holding this private port makes an accidental API listen observable as LISTEN_FAILED.
    const apiPort = (listenerObserver.address() as AddressInfo).port;
    try {
      const record = join(root, 'runtime-launches', `${randomUUID()}.json`);
      await mkdir(dirname(record));
      await writeFile(record, 'retained source ARMED evidence - must never be consumed');
      await writeFile(join(root, RESTORE_ISOLATION_MARKER), '{incomplete restore');
      const result = await runEntry(mode, root, databasePort, apiPort);
      assert.equal(result.timedOut, false, JSON.stringify(result));
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.match(`${result.stdout}${result.stderr}`, /RESTORE_ISOLATED/u);
      assert.doesNotMatch(result.stdout, /(?:desktop_ready|supervisor_ready|worker_ready|desktop_launch_recovery_ack|desktop_dispatch_ready)/u);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /LISTEN_FAILED|test-only|incomplete restore/u);
      assert.equal(connections, 0);
      assert.equal(await readFile(record, 'utf8'), 'retained source ARMED evidence - must never be consumed');
      assert.equal(await readFile(join(root, RESTORE_ISOLATION_MARKER), 'utf8'), '{incomplete restore');
    } finally {
      await Promise.all([new Promise<void>(done => dbObserver.close(() => done())),
        new Promise<void>(done => listenerObserver.close(() => done()))]);
      await rm(root, { recursive: true, force: true });
    }
  });
}
