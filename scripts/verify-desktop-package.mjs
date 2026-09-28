import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = realpathSync(process.argv[2]);
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
console.log('Package hashes verified.');
