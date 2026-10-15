import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishWindowsContent, WindowsContentError}
  from '../apps/api/dist/src/storage/windows-content-publisher.js';

const dataRoot = await mkdtemp(join(tmpdir(), 'relay-helper-probe-'));
const artifactId = randomUUID(); const versionId = randomUUID();
const storageRef = `artifacts/${artifactId}/${versionId}/content.md`;
try {
  await publishWindowsContent({dataRoot, artifactId, versionId,
    content: Buffer.from('# probe\n', 'utf8'), storageRef});
  console.log('HELPER OK');
} catch (error) {
  console.log('isWindowsContentError=', error instanceof WindowsContentError);
  console.log('code=', error?.code);
  console.log('message=', error?.message);
  console.log('detail=', JSON.stringify(error?.detail ?? error?.cause ?? null).slice(0, 400));
}
await rm(dataRoot, {recursive: true, force: true});
