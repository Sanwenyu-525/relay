import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';

/**
 * 知识导入的真实 HTTP 契约：预检不写库、提交重新提取、重复策略、扫描 PDF 明确拒绝、
 * HTML 去脚本、DOCX 正文提取与幂等回执。字节样本与单元测试共用，但这里走真实路由映射。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-knowledge-import');
let api: TestApi;
let workspaceId: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
});
after(async () => { await api?.stop(); await database.close(); });

const path = (suffix: string) => workspacePath(workspaceId, suffix);
const file = (name: string, mediaType: string, bytes: Buffer) => ({ name,
  media_type: mediaType, content_base64: bytes.toString('base64') });
async function preview(files: ReturnType<typeof file>[]) {
  return api.post(path('/knowledge-import/preview'), { project_id: null, files });
}
async function commit(body: Record<string, unknown>, status: 200 | 201 = 201) {
  const commandId = randomUUID();
  return expectCommandAccepted(await api.post(path('/knowledge-import'),
    { command_id: commandId, ...body }), status, commandId);
}

function pdf(stream: string): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj
3 0 obj << /Length ${Buffer.byteLength(stream, 'latin1')} >> stream
${stream}
endstream endobj
trailer << /Root 1 0 R >>
%%EOF`, 'latin1');
}

/** 最小 DOCX：一个段落，验证 transport 的 camelCase 映射与后端 zip 提取。 */
function docx(text: string): Buffer {
  const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${escape(text)}</w:t></w:r></w:p></w:body></w:document>`;
  const [contentTypes, rels, main] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`],
    ['word/document.xml', document],
  ] as const;
  const entries = [contentTypes, rels, main];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const data = Buffer.from(body, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(local, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt16LE(0, 14);
    local.writeUInt32LE(0, 16); local.writeUInt32LE(data.length, 20);
    local.writeUInt32LE(data.length, 24); local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    Buffer.from([0x50, 0x4b, 0x01, 0x02]).copy(central, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  Buffer.from([0x50, 0x4b, 0x05, 0x06]).copy(end, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test('预览只提取正文并提示重复，不写知识行；提交 Markdown 后详情与索引可用', async () => {
  const markdown = '# 知识导入规范\n\n导入正文必须可检索，且保留文件来源。';
  const previewResponse = await preview([file('规范.md', 'text/markdown', Buffer.from(markdown))]);
  assert.equal(previewResponse.status, 200, previewResponse.text);
  const previewBody = previewResponse.body as { files: { status: string; format: string;
    text: string; title_suggestion: string; duplicates: unknown[] }[] };
  assert.equal(previewBody.files[0]?.status, 'READY');
  assert.equal(previewBody.files[0]?.format, 'MARKDOWN');
  assert.match(previewBody.files[0]?.text ?? '', /导入正文必须可检索/u);
  assert.equal(previewBody.files[0]?.title_suggestion, '知识导入规范');
  assert.deepEqual(previewBody.files[0]?.duplicates, []);

  const beforeCount = (await api.get(path('/knowledge/page?q=' + encodeURIComponent('知识导入规范'))))
    .body as { items: unknown[] };
  assert.deepEqual(beforeCount.items, []);

  const created = await commit({ project_id: null, title: '知识导入规范',
    file: file('规范.md', 'text/markdown', Buffer.from(markdown)),
    tags: ['导入', 'Markdown'], duplicate_strategy: 'NEW' });
  assert.equal(created.created, 'true');
  const id = created.knowledge_id as string;
  const detail = await api.get(path(`/knowledge/${id}`));
  assert.equal(detail.status, 200, detail.text);
  const versions = await api.get(path(`/knowledge/${id}/versions`));
  assert.equal((versions.body as { source_refs: Record<string, unknown> }[])[0]
    ?.source_refs.file_name, '规范.md');
  const page = (await api.get(path('/knowledge/page?q=' + encodeURIComponent('导入正文')))).body as
    { items: { id: string; tags: string[] }[] };
  assert.equal(page.items[0]?.id, id);
  assert.deepEqual(page.items[0]?.tags.sort(), ['Markdown', '导入'].sort());
});

test('相同内容按内容哈希识别：SKIP 返回原 ID 与修订，NEW_VERSION 追加版本且旧版本仍可追溯', async () => {
  const content = '# 版本引用基线\n\n同一份正文可以作为新版本沉淀。';
  const base = await commit({ project_id: null, file: file('基线.md', 'text/markdown', Buffer.from(content)),
    duplicate_strategy: 'NEW' });
  const baseId = base.knowledge_id as string;
  const baseRevision = String(base.revision);

  const previewDuplicate = await preview([file('基线.md', 'text/markdown', Buffer.from(content))]);
  const duplicateEntry = (previewDuplicate.body as { files: { duplicates: { id: string;
    current_version: string }[] }[] }).files[0]?.duplicates[0];
  assert.equal(duplicateEntry?.id, baseId);
  assert.equal(duplicateEntry?.current_version, '1');

  const skipped = await commit({ project_id: null, file: file('基线.md', 'text/markdown', Buffer.from(content)),
    duplicate_strategy: 'SKIP' });
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.knowledge_id, baseId);
  assert.equal(skipped.revision, baseRevision);
  assert.equal(skipped.version, '1');

  const appended = await commit({ project_id: null, title: '版本引用基线',
    file: file('基线.md', 'text/markdown', Buffer.from(content)),
    duplicate_strategy: 'NEW_VERSION', target_knowledge_id: baseId,
    expected_revision: baseRevision });
  assert.equal(appended.knowledge_id, baseId);
  assert.equal(appended.version, '2');
  const versions = (await api.get(path(`/knowledge/${baseId}/versions`))).body as
    { version: string; source_refs: Record<string, unknown> }[];
  assert.equal(versions.length, 2);
  assert.equal((await api.get(path(`/knowledge/${baseId}/versions/1/content`)))
    .status, 200);
  assert.equal((await api.get(path(`/knowledge/${baseId}/versions/2/content`)))
    .status, 200);
});

test('扫描 PDF 明确 NO_TEXT 不伪装成功；HTML 去脚本与 DOCX 段落提取走真实路由', async () => {
  const scanned = await preview([file('扫描.pdf', 'application/pdf', pdf('q 200 0 0 200 0 0 cm /Im1 Do'))]);
  assert.equal(scanned.status, 200, scanned.text);
  const rejected = (scanned.body as { files: { status: string; failure: string; message: string }[] })
    .files[0];
  assert.equal(rejected?.status, 'REJECTED');
  assert.equal(rejected?.failure, 'NO_TEXT');
  assert.match(rejected?.message ?? '', /扫描|OCR|文本层/u);

  const html = '<html><head><title>网页资料</title><script>window.x=1</script></head>' +
    '<body><style>.x{}</style><h1>网页标题</h1><p>这是网页正文 &amp; 实体。</p></body></html>';
  const htmlPreview = await preview([file('资料.html', 'text/html', Buffer.from(html))]);
  const htmlFile = (htmlPreview.body as { files: { status: string; text: string; format: string }[] })
    .files[0];
  assert.equal(htmlFile?.status, 'READY');
  assert.equal(htmlFile?.format, 'HTML');
  assert.equal(htmlFile?.text.includes('window.x'), false);
  assert.equal(htmlFile?.text.includes('网页正文 & 实体'), true);

  const docxPreview = await preview([file('报告.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx('季度报告正文'))]);
  assert.equal(docxPreview.status, 200, docxPreview.text);
  const docxFile = (docxPreview.body as { files: { status: string; text: string; format: string }[] })
    .files[0];
  assert.equal(docxFile?.status, 'READY');
  assert.equal(docxFile?.format, 'DOCX');
  assert.equal(docxFile?.text, '季度报告正文');

  const invalid = await preview([{ name: '坏.md', media_type: 'text/markdown',
    content_base64: '!!!not-base64!!!' }]);
  const invalidFile = (invalid.body as { files: { status: string; failure: string }[] }).files[0];
  assert.equal(invalidFile?.status, 'REJECTED');
  assert.equal(invalidFile?.failure, 'MALFORMED');
});

test('提交扫描 PDF 返回 422 IMPORT_REJECTED，不留下知识行', async () => {
  const before = ((await api.get(path('/knowledge/page?q=' + encodeURIComponent('扫描')))).body as { items: unknown[] }).items;
  const response = await api.post(path('/knowledge-import'), { command_id: randomUUID(),
    project_id: null, file: file('扫描.pdf', 'application/pdf',
      pdf('q 200 0 0 200 0 0 cm /Im1 Do')) });
  expectProblem(response, 422, 'KNOWLEDGE_IMPORT_REJECTED');
  const afterPage = ((await api.get(path('/knowledge/page?q=' + encodeURIComponent('扫描')))).body as { items: unknown[] }).items;
  assert.deepEqual(afterPage, before);
});
