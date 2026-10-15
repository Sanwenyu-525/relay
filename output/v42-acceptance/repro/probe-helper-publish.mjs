// 本轮探针：验证本机 relay-file-io-helper 的受管内容发布路径是否可用。
// 仅在传入的临时根目录内操作；不触碰任何真实受管根。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedContentStore } from '../../../apps/api/dist/src/storage/managed-content-store.js';

const explicitRoot = process.argv[2];
const root = explicitRoot ?? await mkdtemp(join(tmpdir(), 'relay-helper-probe-'));
console.log(`probe root: ${root}`);
const store = new ManagedContentStore(root);
try {
  const published = await store.publish({
    artifactId: '00000000-0000-4000-8000-000000000001',
    versionId: '00000000-0000-4000-8000-000000000002',
    content: Buffer.from('# helper probe\n', 'utf8'),
  });
  console.log(`publish: OK ref=${published.storageRef} size=${published.size}`);
  const read = await store.readWithHashCheck(published.storageRef, {
    contentHash: published.contentHash, size: published.size,
  });
  console.log(`readback: ${read.status}`);
} catch (error) {
  console.log(`publish result: FAILED ${error?.name ?? ''} ${error?.code ?? ''} ${error?.message ?? String(error)}`);
  if (error?.cause) console.log(`cause: ${error.cause?.name ?? ''} ${error.cause?.code ?? ''} ${error.cause?.message ?? String(error.cause)}`);
}
