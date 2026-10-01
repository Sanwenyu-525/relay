import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Native/Node pipe acceptance only: no PG, Provider, window, or complete backup claim.
const [desktopExe, rustTestExe, apiDist] = process.argv.slice(2);
if (![desktopExe, rustTestExe, apiDist].every(value => value && path.isAbsolute(value))) {
  throw new Error('require absolute desktop EXE, matching Rust test EXE, and compiled API root');
}
// Do not attach a capability to an old EXE that would ignore the private flag
// and enter ordinary desktop startup. This mirrors the release builder's gate.
const desktopBytes = await readFile(desktopExe);
if (!['maintenance_session_start', 'maintenance_session_release'].every(marker =>
  desktopBytes.includes(Buffer.from(marker)))) {
  throw new Error('desktop EXE lacks the maintenance protocol; refused before native execution');
}
const rustTestBytes = await readFile(rustTestExe);
if (!['job_sidecar::tests::host_crash_probe', 'RELAY_JOB_PROBE_MODE'].every(marker =>
  rustTestBytes.includes(Buffer.from(marker)))) {
  throw new Error('Rust test EXE lacks the isolated Job probe; refused before native execution');
}
const { openDesktopMaintenanceSession, DESKTOP_MAINTENANCE_PROTOCOL } = await import(
  pathToFileURL(path.join(apiDist, 'src/runtime/desktop-maintenance-session.js')).href);
const root = await mkdtemp(path.join(tmpdir(), 'relay-m07-maintenance-pipe-'));
const packageRoot = path.join(root, 'native-test-package');
const dataRoot = path.join(root, 'data');
await mkdir(packageRoot); await mkdir(dataRoot);
const executableHash = createHash('sha256').update(desktopBytes).digest('hex');
const testExecutableHash = createHash('sha256').update(rustTestBytes).digest('hex');
await copyFile(desktopExe, path.join(packageRoot, 'relay-desktop.exe'));
const manifestFile = path.join(packageRoot, 'desktop-build-manifest.json');
const manifest = { schema_version: 1, artifact_sha256: executableHash,
  maintenance_session_protocol: DESKTOP_MAINTENANCE_PROTOCOL };
await writeFile(manifestFile, JSON.stringify(manifest));
const checks = [];
const owned = new Set();
let session;
let clean = false;

function launch(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  owned.add(child);
  let stdout = '', stderr = '';
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { owned.delete(child); resolve({ code, signal }); });
  });
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  return { child, closed, output: () => ({ stdout, stderr }) };
}

async function waitFor(read, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('specific native observation did not arrive before deadline');
}

async function waitClosed(run) {
  let timeout;
  try {
    return await Promise.race([run.closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('owned native process failed to exit before deadline')), 15000);
    })]);
  } finally { clearTimeout(timeout); }
}

async function cliRelease(input, expectedCode) {
  const run = launch(process.execPath, [path.join(apiDist, 'src/cli/maintenance.js'), 'hold-desktop-stop',
    '--package-root', packageRoot, '--data-root', dataRoot], {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    // Synthetic credentials must neither be used nor reach the native helper/output.
    RELAY_DB_URL: 'postgresql://synthetic:synthetic-secret@127.0.0.1:1/never-used',
    RELAY_MODEL_API_KEY: 'synthetic-never-forwarded-model-key',
  });
  const stdout = await waitFor(() => run.output().stdout, value => value.includes('desktop_stop_held'));
  const held = stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line))[0];
  assert.equal(held.frozen, false);
  assert.equal(held.scope, 'CURRENT_WINDOWS_SESSION_DESKTOP_ONLY');
  run.child.stdin.end(input);
  const result = await waitClosed(run);
  assert.equal(result.code, expectedCode); assert.equal(result.signal, null);
  const output = run.output();
  assert.equal(output.stdout.includes('desktop_stop_released'), expectedCode === 0);
  assert.ok(!JSON.stringify(output).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(output).includes('synthetic-never-forwarded-model-key'));
  if (expectedCode === 0) {
    const released = output.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line)).at(-1);
    assert.equal(released.nonce, held.nonce);
  } else assert.equal(JSON.parse(output.stderr.trim()).code, 'CONFIGURATION_ERROR');
}

try {
  await writeFile(manifestFile, JSON.stringify({ ...manifest, maintenance_session_protocol: undefined }));
  await assert.rejects(() => openDesktopMaintenanceSession({ packageRoot, dataRoot }),
    { code: 'MAINTENANCE_PACKAGE_UNSUPPORTED' });
  assert.deepEqual(await readdir(dataRoot), []);
  checks.push('legacy package refused before native execution');
  await writeFile(manifestFile, JSON.stringify(manifest));

  // Existing Rust probe creates an isolated ARMED record and a live Node Job tree;
  // it does not create a desktop window or acquire the production desktop guard.
  const probe = launch(rustTestExe, ['--exact', 'job_sidecar::tests::host_crash_probe', '--nocapture'], {
    ...process.env, RELAY_JOB_PROBE_MODE: 'hold', RELAY_JOB_PROBE_ROOT: dataRoot,
    RELAY_TEST_NODE: process.execPath,
  });
  await waitFor(() => readFile(path.join(dataRoot, 'probe-ready'), 'utf8').catch(() => ''), Boolean);
  const records = await readdir(path.join(dataRoot, 'runtime-launches'));
  assert.equal(records.length, 1);
  const armedBefore = await readFile(path.join(dataRoot, 'runtime-launches', records[0]));
  const launchId = records[0].replace(/\.json$/u, '');
  session = await openDesktopMaintenanceSession({ packageRoot, dataRoot });
  assert.equal(session.isHeld(), true);
  assert.deepEqual(session.stoppedLaunches, [{ launchId,
    stopEvidence: 'armed_job_terminated_and_active_count_zero' }]);
  assert.deepEqual(await readFile(path.join(dataRoot, 'runtime-launches', records[0])), armedBefore);
  await assert.rejects(() => openDesktopMaintenanceSession({ packageRoot, dataRoot }),
    { code: 'MAINTENANCE_SESSION_BUSY' });
  await session.release();
  assert.equal(session.isHeld(), false);
  assert.equal((await session.closed).failure, null);
  session = undefined;
  probe.child.kill(); await waitClosed(probe);
  checks.push('real native pipe stops recorded Job tree, retains ARMED, holds and releases original guard');

  await cliRelease('release\r\n', 0);
  checks.push('CLI matching release confirms original nonce with no database/model use');
  await cliRelease('release\n' + 'x'.repeat(300), 2);
  checks.push('CLI oversized trailing input refuses success and still releases owned guard');
  await cliRelease('', 0);
  checks.push('CLI clean stdin EOF releases owned guard');
} finally {
  if (session?.isHeld()) await session.release();
  for (const child of [...owned]) { child.kill(); }
  await waitFor(() => owned.size, count => count === 0);
  const resolvedRoot = path.resolve(root);
  assert.equal(path.dirname(resolvedRoot), path.resolve(tmpdir()));
  await rm(resolvedRoot, { recursive: true, force: true });
  clean = true;
  console.log(JSON.stringify({ scope: 'WINDOWS_NATIVE_NODE_PIPE_ONLY', executable_sha256: executableHash,
    rust_test_executable_sha256: testExecutableHash,
    checks, temporary_root_removed: clean, owned_processes_remaining: owned.size }, null, 2));
}
assert.equal(checks.length, 5);
