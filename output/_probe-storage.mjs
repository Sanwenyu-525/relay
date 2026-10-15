import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedContentStore} from '../apps/api/dist/src/storage/managed-content-store.js';

const dataRoot = await mkdtemp(join(tmpdir(), 'relay-storage-probe-'));
const store = new ManagedContentStore(dataRoot);
try {
  const published = await store.publish({
    artifactId: randomUUID(), versionId: randomUUID(),
    content: Buffer.from('# probe\n', 'utf8'),
  });
  console.log('PUBLISH OK', published.storageRef, String(published.size));
} catch (error) {
  console.log('PUBLISH FAILED', error?.name, error?.message, error?.cause?.message ?? '');
}
await rm(dataRoot, {recursive: true, force: true});
