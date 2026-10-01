import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { DESKTOP_MAINTENANCE_PROTOCOL, DesktopMaintenanceSessionError,
  parseDesktopMaintenanceEvent, verifiedDesktopMaintenanceExecutable } from
  '../../src/runtime/desktop-maintenance-session.js';
import { observeDesktopMaintenanceSession } from '../../src/runtime/desktop-maintenance-session.js';

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));

test('desktop stop proofs are bound to the native session nonce and exact launch identities', () => {
  const nonce = randomUUID();
  const stoppedLaunches = [
    { launchId: randomUUID(), stopEvidence: 'armed_job_terminated_and_active_count_zero' },
    { launchId: randomUUID(), stopEvidence: 'armed_job_absent_after_last_handle_closed' },
  ];
  const ready = { type: 'maintenance_ready', version: 1, nonce, stoppedLaunches };
  assert.deepEqual(parseDesktopMaintenanceEvent(encoded(ready), nonce), ready);
  assert.throws(() => parseDesktopMaintenanceEvent(encoded(ready), randomUUID()));
  const released = { type: 'maintenance_released', version: 1, nonce };
  assert.deepEqual(parseDesktopMaintenanceEvent(encoded(released), nonce), released);
  assert.throws(() => parseDesktopMaintenanceEvent(encoded(released), randomUUID()));
});

test('invalid, duplicate or unbounded stop evidence never becomes a ready result', () => {
  const nonce = randomUUID();
  const launch = { launchId: randomUUID(), stopEvidence: 'armed_job_terminated_and_active_count_zero' };
  const ready = { type: 'maintenance_ready', version: 1, nonce, stoppedLaunches: [launch] };
  for (const value of [
    { ...ready, version: 2 }, { ...ready, frozen: true },
    { ...ready, stoppedLaunches: [{ ...launch, stopEvidence: 'lease_expired' }] },
    { ...ready, stoppedLaunches: [{ ...launch, launchId: '../old' }] },
    { ...ready, stoppedLaunches: [launch, launch] },
    { ...ready, stoppedLaunches: Array.from({ length: 65 }, () => ({ ...launch, launchId: randomUUID() })) },
    { ...ready, stoppedLaunches: [{ ...launch, processId: 1234 }] },
    { type: 'maintenance_released', version: 1, nonce, stoppedLaunches: [] },
  ]) assert.throws(() => parseDesktopMaintenanceEvent(encoded(value), nonce), DesktopMaintenanceSessionError);
  assert.throws(() => parseDesktopMaintenanceEvent(Buffer.from([0xff]), nonce));
  assert.throws(() => parseDesktopMaintenanceEvent(Buffer.alloc(64 * 1024 + 1), nonce));
});

test('native errors expose only the fixed code and preserve pre-handshake rejection', () => {
  const nonce = randomUUID();
  const busy = { type: 'maintenance_error', version: 1, nonce: null, code: 'MAINTENANCE_SESSION_BUSY' };
  assert.deepEqual(parseDesktopMaintenanceEvent(encoded(busy), nonce), busy);
  assert.throws(() => parseDesktopMaintenanceEvent(encoded({ ...busy, code: 'synthetic-private-driver-message' }), nonce));
  assert.throws(() => parseDesktopMaintenanceEvent(encoded({ ...busy, detail: 'synthetic-private-config' }), nonce));
});

test('an old package is rejected before execution and a changed EXE invalidates declared support', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'relay-maintenance-package-unit-'));
  const executable = join(packageRoot, 'relay-desktop.exe');
  const manifestFile = join(packageRoot, 'desktop-build-manifest.json');
  const bytes = Buffer.from('synthetic fixture; never executable');
  const manifest = { schema_version: 1, artifact_sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    await writeFile(executable, bytes);
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(() => verifiedDesktopMaintenanceExecutable(packageRoot),
      { code: 'MAINTENANCE_PACKAGE_UNSUPPORTED', message: 'MAINTENANCE_PACKAGE_UNSUPPORTED' });
    await writeFile(manifestFile, JSON.stringify({ ...manifest,
      maintenance_session_protocol: DESKTOP_MAINTENANCE_PROTOCOL }));
    assert.equal(await verifiedDesktopMaintenanceExecutable(packageRoot), executable);
    await writeFile(executable, 'changed fixture');
    await assert.rejects(() => verifiedDesktopMaintenanceExecutable(packageRoot),
      { code: 'MAINTENANCE_PACKAGE_UNSUPPORTED' });
    await assert.rejects(() => verifiedDesktopMaintenanceExecutable('relative/package'),
      { code: 'MAINTENANCE_PACKAGE_UNSUPPORTED' });
  } finally { await rm(packageRoot, { recursive: true, force: true }); }
});

test('a linked package root cannot substitute a different native executable', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'relay-maintenance-link-unit-'));
  const linkedRoot = join(temporaryRoot, 'linked');
  try {
    await symlink(temporaryRoot, linkedRoot, 'junction');
    await assert.rejects(() => verifiedDesktopMaintenanceExecutable(linkedRoot),
      { code: 'MAINTENANCE_PACKAGE_UNSUPPORTED' });
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});

test('a protocol error after RELEASED cannot be masked by an already successful process exit', async () => {
  class ControlledNative extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    kill(): boolean { return false; } // The native process has already finished; killing cannot change exit 0.
  }
  const child = new ControlledNative();
  const nonce = randomUUID();
  child.stdin.once('data', () => child.stdout.write(encoded({ type: 'maintenance_ready', version: 1,
    nonce, stoppedLaunches: [] }).toString() + '\n'));
  const session = await observeDesktopMaintenanceSession(child, nonce, 'C:\\synthetic-test-root');
  child.stdin.once('finish', () => {
    child.exitCode = 0;
    child.stdout.write(encoded({ type: 'maintenance_released', version: 1, nonce }).toString() + '\n');
    child.stdout.write(encoded({ type: 'maintenance_error', version: 1, nonce,
      code: 'MAINTENANCE_SESSION_INVALID' }).toString() + '\n');
    child.emit('close', 0, null);
  });
  await assert.rejects(() => session.release(), { code: 'MAINTENANCE_SESSION_INVALID' });
  assert.equal(session.isHeld(), false);
});

test('unexpected native EOF after READY is a failed live session even with exit zero', async () => {
  class ControlledNative extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    kill(): boolean { return false; }
  }
  const child = new ControlledNative();
  const nonce = randomUUID();
  child.stdin.once('data', () => child.stdout.write(encoded({ type: 'maintenance_ready', version: 1,
    nonce, stoppedLaunches: [] }).toString() + '\n'));
  const session = await observeDesktopMaintenanceSession(child, nonce, 'C:\\synthetic-test-root');
  child.exitCode = 0;
  child.emit('close', 0, null);
  assert.equal(session.isHeld(), false);
  assert.equal((await session.closed).failure?.code, 'MAINTENANCE_SESSION_IO_FAILED');
  await assert.rejects(() => session.release(), { code: 'MAINTENANCE_SESSION_IO_FAILED' });
});

test('native protocol failure before or after READY waits for the owned child close', async () => {
  for (const ready of [false, true]) {
    class ControlledNative extends EventEmitter {
      readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
      exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; stopped = false;
      kill() { setTimeout(() => { this.stopped = true; this.exitCode = 1; this.emit('close', 1, null); }, 20); return true; }
    }
    const child = new ControlledNative(), nonce = randomUUID();
    child.stdin.once('data', () => child.stdout.write(ready ?
      `${JSON.stringify({ type: 'maintenance_ready', version: 1, nonce, stoppedLaunches: [] })}\n` : 'invalid\n'));
    if (!ready) await assert.rejects(observeDesktopMaintenanceSession(child, nonce, 'C:\\synthetic-test-root'));
    else {
      const session = await observeDesktopMaintenanceSession(child, nonce, 'C:\\synthetic-test-root');
      child.stdout.write('invalid\n');
      await assert.rejects(session.release());
    }
    assert.equal(child.stopped, true, 'a rejected session must not leave its killed child unobserved');
  }
});
