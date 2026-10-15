import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ManagedContentStore} from '../apps/api/dist/src/storage/managed-content-store.js';

const dataRoot = await mkdtemp(join(tmpdir(), 'relay-storage-probe-'));
const store = new ManagedContentStore(dataRoot);
try {
  await store.publish({artifactId: randomUUID(), versionId: randomUUID(),
    content: Buffer.from('# probe\n', 'utf8')});
  console.log('PUBLISH OK');
} catch (error) {
  console.log('name=', error?.name);
  console.log('message=', error?.message);
  console.log('cause=', error?.cause?.name, error?.cause?.message);
  console.log('causeDetail=', JSON.stringify(error?.cause ?? {}, Object.getOwnPropertyNames(error?.cause ?? {})).slice(0, 600));
  console.log('stack=', String(error?.stack).split('\n').slice(0, 6).join(' | '));
}
console.log('dataRoot=', dataRoot);
await rm(dataRoot, {recursive: true, force: true});
