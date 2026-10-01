import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outputMarkers = ['maintenance_ready', 'maintenance_released', 'maintenance_error', 'MAINTENANCE_SESSION_INVALID'];

/** Invalid arguments reach run(false), before frame/root/guard/Job handling. Never send a start frame. */
export function verifyDesktopMaintenanceCapability(executable, run = spawnSync) {
  const file = path.resolve(executable);
  const bytes = readFileSync(file);
  // Reject legacy binaries before launching them; input-comparison literals may be optimized away.
  if (!outputMarkers.every(marker => bytes.includes(Buffer.from(marker)))) {
    throw new Error('Desktop binary lacks the maintenance session output protocol; rebuild.');
  }
  const result = run(file, ['--maintenance-session', '--invalid-maintenance-capability-probe'], {
    cwd: path.dirname(file), input: '', encoding: 'utf8', windowsHide: true,
    timeout: 5000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 1 || result.signal !== null || result.stderr !== '' ||
      typeof result.stdout !== 'string' || !/^[^\r\n]+\r?\n$/u.test(result.stdout)) {
    throw new Error('Desktop maintenance capability probe did not return the expected bounded error frame.');
  }
  let frame;
  try { frame = JSON.parse(result.stdout); }
  catch { throw new Error('Desktop maintenance capability probe returned an invalid error frame.'); }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame) ||
      Object.keys(frame).length !== 4 || frame.type !== 'maintenance_error' || frame.version !== 1 ||
      frame.nonce !== null || frame.code !== 'MAINTENANCE_SESSION_INVALID') {
    throw new Error('Desktop maintenance capability probe returned an unsupported error frame.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: verify-desktop-maintenance-capability.mjs <desktop-exe>');
    verifyDesktopMaintenanceCapability(process.argv[2]);
    console.log('Desktop maintenance capability verified (invalid-argument probe only).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
