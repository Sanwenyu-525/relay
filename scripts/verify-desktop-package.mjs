import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = realpathSync(process.argv[2]);
const requireRestoreIsolation = process.argv[3] === '--require-restore-isolation';
if (process.argv.length > 4 || (process.argv[3] !== undefined && !requireRestoreIsolation)) {
  throw new Error('Unknown package verification option.');
}
const manifest = JSON.parse(readFileSync(path.join(root, 'desktop-build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
if (manifest.schema_version !== 1 || !manifest.resource_file_sha256?.['node.exe'] ||
    !manifest.resource_file_sha256?.['relay-file-io-helper.exe']) {
  throw new Error('Incomplete desktop manifest; rebuild the package.');
}
for (const [relative, expected] of Object.entries({
  ...manifest.resource_file_sha256,
  'relay-desktop.exe': manifest.artifact_sha256,
})) {
  const file = realpathSync(path.resolve(root, relative));
  const inside = path.relative(root, file);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error('Package resource escaped its root.');
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== expected) throw new Error(`Package hash mismatch: ${relative}; rebuild.`);
}
if (requireRestoreIsolation || manifest.restore_isolation_protocol !== undefined) {
  if (manifest.restore_isolation_protocol !== 'relay-restore-isolation-v1') {
    throw new Error('Restore isolation capability missing or unsupported; rebuild.');
  }
  const moduleRef = 'api/dist/src/runtime/restore-isolation.js';
  const entries = ['api/dist/src/main.js', 'api/dist/src/worker/main.js',
    'api/dist/src/worker/supervisor-main.js'];
  if (![moduleRef, ...entries].every(ref => typeof manifest.resource_file_sha256[ref] === 'string')) {
    throw new Error('Restore isolation resources are not hash-bound; rebuild.');
  }
  const module = readFileSync(path.join(root, moduleRef), 'utf8');
  const native = readFileSync(path.join(root, 'relay-desktop.exe')).toString('latin1');
  if (!['restore-isolation.json', 'RESTORE_ISOLATED', 'RESTORE_ISOLATION_UNAVAILABLE']
      .every(literal => module.includes(literal) && native.includes(literal)) ||
      !entries.every(ref => {
        const entry = readFileSync(path.join(root, ref), 'utf8');
        return entry.includes('runtime/restore-isolation.js') && entry.includes('await assertRestoreNotIsolated(');
      })) {
    throw new Error('Restore isolation startup wiring missing; rebuild.');
  }
}
console.log('Package hashes verified.');
