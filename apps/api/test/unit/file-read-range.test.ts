import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FileReadRangeValidationError, readFileRangeParams, sliceUtf8Range,
} from '../../src/application/file-read-range.js';
import { fileReadExecute } from '../../src/application/gateway-actions.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { FILE_READ_MAX_BYTES } from '../../src/workflow/tool-catalog.js';

function operation(target: string, params: JsonObject = {}) {
  return { id: 'op-1', normalized_target: target, params } as
    unknown as Parameters<typeof fileReadExecute>[0];
}
const invocation = { id: 'inv-1' } as unknown as Parameters<typeof fileReadExecute>[1];

async function withFile(content: Buffer | string, run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relay-read-range-'));
  const path = join(root, 'sample.txt');
  try {
    await writeFile(path, content);
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('range params: absent means full read; offset defaults to 0 and limit to the file cap', () => {
  assert.equal(readFileRangeParams({}), undefined);
  assert.deepEqual(readFileRangeParams({ offset: 0, limit: 10 }), { offset: 0, limit: 10 });
  assert.deepEqual(readFileRangeParams({ limit: 5 }), { offset: 0, limit: 5 });
  assert.deepEqual(readFileRangeParams({ offset: 5 }),
    { offset: 5, limit: FILE_READ_MAX_BYTES });
});

test('range params: negative, fractional, zero and over-limit values are typed rejections', () => {
  const rejected = (params: JsonObject): boolean => {
    try {
      readFileRangeParams(params);
      return false;
    } catch (error) {
      return error instanceof FileReadRangeValidationError;
    }
  };
  for (const params of [{ offset: -1 }, { offset: 1.5 }, { offset: FILE_READ_MAX_BYTES + 1 },
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: FILE_READ_MAX_BYTES + 1 }]) {
    assert.equal(rejected(params as JsonObject), true, JSON.stringify(params));
  }
  // 范围之外多带的键不会悄悄变成动作参数。
  assert.throws(() => readFileRangeParams({ relative_path: 'a.ts' } as JsonObject),
    (error: unknown) => error instanceof FileReadRangeValidationError &&
      (error as FileReadRangeValidationError).field === 'relative_path');
});

test('a normal slice reports the effective range and the continuation offset', () => {
  assert.deepEqual(sliceUtf8Range(Buffer.from('abcdefghij'), { offset: 3, limit: 4 }), {
    content: 'defg', offset: 3, returnedBytes: 4, nextOffset: 7,
    hasMoreBefore: true, hasMoreAfter: true, offsetBeyondEnd: false,
  });
});

test('head/middle/tail slices concatenate back to the original, including markers', () => {
  const original = `# 文件头\n${'x'.repeat(20_000)}\n## 中间标记\n${'y'.repeat(20_000)}\n## 文件尾\n`;
  const bytes = Buffer.from(original, 'utf8');
  const parts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const slice = sliceUtf8Range(bytes, { offset, limit: 7_000 });
    parts.push(slice.content);
    offset = slice.nextOffset;
  }
  assert.ok(parts.length >= 3);
  assert.equal(parts.join(''), original);
  assert.ok(parts[0]!.includes('文件头'));
  assert.ok(parts.some((part) => part.includes('中间标记')));
  assert.ok(parts[parts.length - 1]!.includes('文件尾'));
});

test('an offset past EOF returns an empty slice with the note, not a crash', () => {
  const slice = sliceUtf8Range(Buffer.from('abc'), { offset: 10, limit: 5 });
  assert.equal(slice.content, '');
  assert.equal(slice.offset, 10);
  assert.equal(slice.returnedBytes, 0);
  assert.equal(slice.nextOffset, null);
  assert.equal(slice.hasMoreAfter, false);
  assert.equal(slice.offsetBeyondEnd, true);
});

test('an empty file at offset 0 is a successful empty slice', () => {
  const slice = sliceUtf8Range(Buffer.alloc(0), { offset: 0, limit: 10 });
  assert.equal(slice.content, '');
  assert.equal(slice.offset, 0);
  assert.equal(slice.nextOffset, null);
  assert.equal(slice.offsetBeyondEnd, false);
});

test('a single-line file can be paged by bytes; line semantics would not split it', () => {
  const bytes = Buffer.from('a'.repeat(100_000), 'utf8');
  const first = sliceUtf8Range(bytes, { offset: 0, limit: 16_000 });
  assert.equal(first.content.length, 16_000);
  assert.equal(first.nextOffset, 16_000);
  assert.equal(first.hasMoreAfter, true);
  const last = sliceUtf8Range(bytes, { offset: 96_000, limit: 16_000 });
  assert.equal(last.content.length, 4_000);
  assert.equal(last.nextOffset, null);
});

test('UTF-8 cut points align to code points and never emit a replacement character', () => {
  const bytes = Buffer.from('中a中b', 'utf8');
  // offset=1 落在「中」的续字节内：向前对齐到 0，而不是跳过半个字符。
  const midCharOffset = sliceUtf8Range(bytes, { offset: 1, limit: 3 });
  assert.equal(midCharOffset.content, '中');
  assert.equal(midCharOffset.offset, 0);
  assert.equal(midCharOffset.nextOffset, 3);
  // limit 小于一个码点时，仍返回完整码点（软上限），不会吐空串。
  const tooSmall = sliceUtf8Range(bytes, { offset: 0, limit: 1 });
  assert.equal(tooSmall.content, '中');
  assert.equal(tooSmall.returnedBytes, 3);
  const cutMidChar = sliceUtf8Range(bytes, { offset: 0, limit: 2 });
  assert.equal(cutMidChar.content, '中');
  assert.equal(cutMidChar.content.includes('\uFFFD'), false);
});

test('CRLF is not split across slices and concatenation preserves it', () => {
  const bytes = Buffer.from('ab\r\ncd', 'utf8');
  const first = sliceUtf8Range(bytes, { offset: 0, limit: 3 });
  assert.equal(first.content, 'ab');
  assert.equal(first.returnedBytes, 2);
  assert.equal(first.nextOffset, 2);
  const rest = sliceUtf8Range(bytes, { offset: first.nextOffset!, limit: 10 });
  assert.equal(rest.content, '\r\ncd');
  assert.equal(first.content + rest.content, 'ab\r\ncd');
});

test('fileReadExecute: a range read keeps the full-file sha256 and exposes continuation metadata', async () => {
  const content = `head\n${'z'.repeat(99_990)}\ntail`;
  await withFile(content, async (path) => {
    const full = await fileReadExecute(operation(path), invocation);
    assert.equal(full.outcome, 'SUCCEEDED');
    const fullSha = full.result.sha256;
    assert.equal(fullSha, createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'));
    assert.equal(full.result.truncated, false);
    assert.equal(full.result.content, content);
    // 没有范围参数时不出现新增元数据，短文件整读行为不变。
    assert.equal('range' in full.result, false);

    const first = await fileReadExecute(operation(path, { offset: 0, limit: 1_000 }), invocation);
    assert.equal(first.outcome, 'SUCCEEDED');
    // baselineSha256 的语义是完整文件摘要，不因只读片段而改变。
    assert.equal(first.result.sha256, fullSha);
    assert.equal(first.result.truncated, true);
    assert.equal(first.result.content, content.slice(0, 1_000));
    const range = first.result.range as Record<string, unknown>;
    assert.equal(range.offset, 0);
    assert.equal(range.limit, 1_000);
    assert.equal(range.total_bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(range.returned_bytes, 1_000);
    assert.equal(range.next_offset, 1_000);
    assert.equal(range.has_more_after, true);
  });
});

test('fileReadExecute: a corrupted frozen range is a typed failure, not a silent full read', async () => {
  await withFile('abc', async (path) => {
    const read = await fileReadExecute(operation(path, { offset: -1 } as JsonObject), invocation);
    assert.equal(read.outcome, 'FAILED');
    assert.equal(read.result.reason, 'READ_FILE_RANGE_INVALID');
  });
});

test('fileReadExecute: an empty file with a range returns empty content and total_bytes 0', async () => {
  await withFile('', async (path) => {
    const read = await fileReadExecute(operation(path, { offset: 0, limit: 10 }), invocation);
    assert.equal(read.outcome, 'SUCCEEDED');
    assert.equal(read.result.content, '');
    assert.equal(read.result.truncated, false);
    const range = read.result.range as Record<string, unknown>;
    assert.equal(range.total_bytes, 0);
    assert.equal(range.next_offset, null);
  });
});
