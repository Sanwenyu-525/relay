import { randomUUID } from 'node:crypto';
import { publishWindowsContent, WindowsContentError }
  from '../apps/api/dist/src/storage/windows-content-publisher.js';

const roots = [
  'D:\\Develop\\Relay-Agent\\output\\_probe-data',
  'C:\\Users\\ASUS\\AppData\\Local\\Temp\\relay-helper-probe2',
];
for (const dataRoot of roots) {
  const artifactId = randomUUID();
  const versionId = randomUUID();
  const storageRef = `artifacts/${artifactId}/${versionId}/content.md`;
  try {
    await publishWindowsContent({ dataRoot, artifactId, versionId,
      content: Buffer.from('# probe\n', 'utf8'), storageRef });
    console.log('OK  ', dataRoot);
  } catch (error) {
    console.log('FAIL', dataRoot,
      error instanceof WindowsContentError ? error.code : String(error?.message));
  }
}
