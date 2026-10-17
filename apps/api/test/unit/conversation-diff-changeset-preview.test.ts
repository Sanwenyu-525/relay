import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplyChangesetStreamParser,
  extractApplyChangesetPreview,
  MAX_PREVIEW_CONTENT_CHARS,
  readString,
} from '../../src/conversation-diff/changeset-preview.js';

const LF = String.fromCharCode(10);
const BS = String.fromCharCode(92); // backslash
const DQUOTE = String.fromCharCode(34); // double quote

function wrap(items: string): string {
  return `{"tool":"apply_changeset","items":[${items}]}`;
}

test('extractApplyChangesetPreview parses a complete item with path/action/content', () => {
  const text = wrap(`{"path":"a.ts","action":"CREATE","content":"hello"}`);
  const result = extractApplyChangesetPreview(text);
  assert.equal(result.complete, true);
  assert.equal(result.parseError, null);
  assert.equal(result.files.length, 1);
  const file = result.files[0]!;
  assert.equal(file.path, 'a.ts');
  assert.equal(file.action, 'CREATE');
  assert.equal(file.contentPreview, 'hello');
  assert.equal(file.contentComplete, true);
  assert.equal(file.itemComplete, true);
});

test('extractApplyChangesetPreview decodes escape sequences', () => {
  // content 内 "line1\nline2" => 解码为换行；"a\"b" => a"b。
  const content = `line1${BS}nline2`;
  const text = wrap(`{"path":"a","action":"MODIFY","content":${DQUOTE}${content}${DQUOTE}}`);
  const result = extractApplyChangesetPreview(text);
  const file = result.files[0]!;
  assert.equal(file.contentPreview, `line1${LF}line2`);
  assert.equal(file.contentComplete, true);
});

test('extractApplyChangesetPreview decodes split Unicode escape across stream chunks', () => {
  const parser = new ApplyChangesetStreamParser();
  // 第一段包含完整 \u00e9（é），第二段补齐剩余内容。
  const part1 = `{"items":[{"path":"u","content":"x${BS}u00e9`;
  const part2 = ` tail${DQUOTE}}]}`;
  parser.push(part1);
  const mid = parser.snapshot();
  assert.equal(mid.files[0]?.contentPreview, `x${String.fromCharCode(0xe9)}`);
  parser.push(part2);
  const done = parser.snapshot();
  assert.equal(done.complete, true);
  assert.equal(done.files[0]?.contentPreview, `x${String.fromCharCode(0xe9)} tail`);
  assert.equal(done.files[0]?.contentComplete, true);
});

test('extractApplyChangesetPreview marks incomplete content when string is truncated', () => {
  // 构造一个 content 字符串真的未闭合（不含结尾的 " 与 ]}）的输入。
  const text = `{"items":[{"path":"x","action":"MODIFY","content":"incompl`;
  const result = extractApplyChangesetPreview(text);
  assert.equal(result.complete, false);
  const file = result.files[0]!;
  assert.equal(file.contentComplete, false);
  assert.equal(file.itemComplete, false);
  assert.equal(file.contentPreview, 'incompl');
});

test('extractApplyChangesetPreview handles late-arriving path and unknown action', () => {
  const text = wrap(`{"action":"CREATE","content":"z"},{"path":"late"}`);
  const result = extractApplyChangesetPreview(text);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0]!.path, null);
  assert.equal(result.files[0]!.action, 'CREATE');
  assert.equal(result.files[0]!.contentPreview, 'z');
  assert.equal(result.files[1]!.path, 'late');
  assert.equal(result.files[1]!.action, 'UNKNOWN');
});

test('extractApplyChangesetPreview handles multiple files', () => {
  const text = wrap(
    `{"path":"a","action":"CREATE","content":"1"},{"path":"b","action":"DELETE"},{"path":"c","action":"MODIFY","content":"2"}`,
  );
  const result = extractApplyChangesetPreview(text);
  assert.equal(result.files.length, 3);
  assert.equal(result.files[0]!.path, 'a');
  assert.equal(result.files[1]!.path, 'b');
  assert.equal(result.files[1]!.action, 'DELETE');
  assert.equal(result.files[1]!.contentPreview, null);
  assert.equal(result.files[2]!.path, 'c');
});

test('extractApplyChangesetPreview truncates over-limit content and marks incomplete', () => {
  const huge = 'x'.repeat(MAX_PREVIEW_CONTENT_CHARS + 100);
  const text = wrap(`{"path":"big","action":"CREATE","content":${DQUOTE}${huge}${DQUOTE}}`);
  const result = extractApplyChangesetPreview(text);
  const file = result.files[0]!;
  assert.equal(file.contentPreview?.length, MAX_PREVIEW_CONTENT_CHARS);
  assert.equal(file.contentComplete, false);
});

test('extractApplyChangesetPreview normalizes invalid action to UNKNOWN', () => {
  const text = wrap(`{"path":"a","action":"FROB"}`);
  const result = extractApplyChangesetPreview(text);
  assert.equal(result.files[0]!.action, 'UNKNOWN');
});

test('extractApplyChangesetPreview emits a partial item and is incomplete until the top-level object closes', () => {
  const text = `{"items":[{"path":"a"`;
  const result = extractApplyChangesetPreview(text);
  assert.equal(result.complete, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.path, 'a');
  assert.equal(result.files[0]!.itemComplete, false);
});

test('readString returns incomplete when string is cut before closing quote', () => {
  const partial = `${DQUOTE}abc`;
  const result = readString(partial, 0);
  assert.equal(result.value, 'abc');
  assert.equal(result.complete, false);
});

test('readString decodes escaped backslash and quote', () => {
  const text = `${DQUOTE}a${BS}${BS}b${BS}${DQUOTE}c${DQUOTE}`;
  const result = readString(text, 0);
  assert.equal(result.value, `a${BS}b${DQUOTE}c`);
  assert.equal(result.complete, true);
});
