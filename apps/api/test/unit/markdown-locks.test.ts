import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownBlocks, mapHumanLocks, protectedTextConflict } from '../../src/artifact/markdown-locks.js';

const original = '# 结论\n\n证据支持 A。\n\n## 方法\n\n稳定过程。';
const lock = { id: 'lock', kind: 'PARAGRAPH' as const, block_index: 1,
  text: '证据支持 A。', status: 'MAPPED' as const };

test('paragraph and section selectors bind exact Markdown content', () => {
  assert.equal(markdownBlocks(original, 'PARAGRAPH')[1]?.text, lock.text);
  assert.equal(markdownBlocks(original, 'SECTION')[0]?.text, original);
  assert.equal(markdownBlocks(original, 'SECTION')[1]?.text, '## 方法\n\n稳定过程。');
});

test('AI may edit adjacent blocks but cannot edit, delete, split or move locked text', () => {
  assert.equal(protectedTextConflict([lock], original,
    '# 结论\n\n新摘要。\n\n证据支持 A。\n\n## 方法\n\n稳定过程。'), null);
  for (const candidate of [
    '# 结论\n\n证据支持 B。\n\n## 方法\n\n稳定过程。',
    '# 结论\n\n## 方法\n\n稳定过程。',
    '# 结论\n\n证据支持\n\nA。\n\n## 方法\n\n稳定过程。',
    '# 结论\n\n## 方法\n\n稳定过程。\n\n证据支持 A。',
    '# 新结论\n\n其他\n\n证据支持 A。\n\n## 新方法\n\n新过程。',
  ]) assert.notEqual(protectedTextConflict([lock], original, candidate), null);
});

test('human revision rebinds lock to changed text; ambiguity remains locked and blocks AI', () => {
  const edited = mapHumanLocks([lock], original,
    '# 结论\n\n证据支持 B。\n\n## 方法\n\n稳定过程。');
  assert.equal(edited[0]?.text, '证据支持 B。');
  assert.equal(edited[0]?.status, 'MAPPED');
  const ambiguous = mapHumanLocks([lock], original,
    '# 结论\n\n新增段落。\n\n证据支持 B。\n\n## 方法\n\n稳定过程。');
  assert.equal(ambiguous[0]?.status, 'UNMAPPED');
  assert.notEqual(protectedTextConflict(ambiguous,
    '# 结论\n\n新增段落。\n\n证据支持 B。\n\n## 方法\n\n稳定过程。',
    '# 结论\n\n新增段落。\n\n证据支持 B。\n\n## 方法\n\n稳定过程。'), null);
});

test('section lock preserves trailing spaces and line endings in the protected original', () => {
  const source = '# 结论\n原文  \n';
  const section = markdownBlocks(source, 'SECTION')[0]!;
  assert.equal(section.text, source);
  const locked = [{ id: 'section', kind: 'SECTION' as const, block_index: 0,
    text: section.text, status: 'MAPPED' as const }];
  assert.notEqual(protectedTextConflict(locked, source, '# 结论\n原文\n'), null);
  assert.notEqual(protectedTextConflict(locked, source, '# 结论\n原文  '), null);
});

test('paragraph lock preserves internal CRLF and allows an adjacent edit', () => {
  const source = '# 结论\r\n\r\n第一行\r\n第二行\r\n\r\n开放部分。';
  const paragraph = markdownBlocks(source, 'PARAGRAPH')[1]!;
  assert.equal(paragraph.text, '第一行\r\n第二行');
  const locked = [{ id: 'paragraph', kind: 'PARAGRAPH' as const, block_index: 1,
    text: paragraph.text, status: 'MAPPED' as const }];
  assert.notEqual(protectedTextConflict(locked, source,
    '# 结论\r\n\r\n第一行\n第二行\r\n\r\n开放部分。'), null);
  assert.equal(protectedTextConflict(locked, source,
    '# 结论\r\n\r\n第一行\r\n第二行\r\n\r\n更新的开放部分。'), null);
});

test('legacy normalized lock cannot silently remap after a human edit', () => {
  const source = '# 结论\r\n\r\n第一行\r\n第二行';
  const legacy = [{ id: 'legacy', kind: 'PARAGRAPH' as const, block_index: 1,
    text: '第一行\n第二行', status: 'MAPPED' as const }];
  assert.notEqual(protectedTextConflict(legacy, source, source), null);
  const changed = '# 结论\r\n\r\n更新的第一行\r\n第二行';
  const rebound = mapHumanLocks(legacy, source, changed);
  assert.equal(rebound[0]?.status, 'UNMAPPED');
  assert.equal(rebound[0]?.text, legacy[0]?.text);
  assert.notEqual(protectedTextConflict(rebound, changed, changed), null);
});
