import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  classifyAction,
  computeAlignedDiff,
  computeLineDiff,
  computeSnapshotDiff,
  isBinaryContent,
  isBinaryText,
  normalizeLineEndings,
  toLogicalLines,
  type BaselineFile,
  type CurrentFile,
  type SnapshotDiffInput,
} from '../../src/conversation-diff/diff-engine.js';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

function lineCount(text: string | null): number | null {
  if (text === null) return null;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/u, '');
  return normalized === '' ? 0 : normalized.split('\n').length;
}

function shaOf(text: string | null): string {
  if (text === null) return `missing-${Math.random().toString(36).slice(2)}`;
  return createHash('sha256').update(text).digest('hex');
}

function baseline(path: string, text: string | null, sha: string = shaOf(text)): BaselineFile {
  return {
    path,
    sha256: sha,
    text,
    lineCount: lineCount(text),
    sizeBytes: text === null ? 0 : Buffer.byteLength(text),
    unavailableReason: null,
  };
}

function current(path: string, text: string | null, sha: string | null = text === null ? null : shaOf(text)): CurrentFile {
  return {
    path,
    sha256: sha,
    text,
    lineCount: lineCount(text),
    sizeBytes: text === null ? null : Buffer.byteLength(text),
    unavailableReason: null,
  };
}

function buildInput(parts: {
  baseline: readonly BaselineFile[];
  current: readonly CurrentFile[];
  incomplete?: boolean;
}): SnapshotDiffInput {
  const baselineMap = new Map<string, BaselineFile>();
  for (const file of parts.baseline) baselineMap.set(file.path, file);
  const currentMap = new Map<string, CurrentFile>();
  for (const file of parts.current) currentMap.set(file.path, file);
  return {
    rootPath: '/repo',
    resourceId: 'res-1',
    baselineCapturedAt: '2026-01-01T00:00:00.000Z',
    baselineRevision: 1n,
    incomplete: parts.incomplete ?? false,
    baseline: baselineMap,
    current: currentMap,
  };
}

test('normalizeLineEndings unifies CRLF and CR to LF', () => {
  assert.equal(normalizeLineEndings(`a${CR}${LF}b${CR}${LF}`), `a${LF}b${LF}`);
  assert.equal(normalizeLineEndings(`a${CR}b`), `a${LF}b`);
  assert.equal(normalizeLineEndings(`a${LF}b`), `a${LF}b`);
});

test('toLogicalLines ignores trailing newline and normalizes CRLF', () => {
  assert.deepEqual(toLogicalLines(''), []);
  assert.deepEqual(toLogicalLines(`a${LF}`), ['a']);
  assert.deepEqual(toLogicalLines(`a${LF}b${LF}`), ['a', 'b']);
  assert.deepEqual(toLogicalLines(`a${CR}${LF}b${CR}${LF}`), ['a', 'b']);
  assert.deepEqual(toLogicalLines(`a${LF}b`), ['a', 'b']);
});

test('computeLineDiff: identical content is zero; net revert cannot be negative', () => {
  assert.deepEqual(computeLineDiff('', ''), { added: 0, removed: 0 });
  assert.deepEqual(computeLineDiff(`a${LF}b`, `a${LF}b`), { added: 0, removed: 0 });
  // 同一行改了又改回：基线 a 当前 a => 0/0（净语义）。
  assert.deepEqual(computeLineDiff(`a${LF}b`, `a${LF}c`), { added: 1, removed: 1 });
  assert.deepEqual(computeLineDiff(`a${LF}c`, `a${LF}b`), { added: 1, removed: 1 });
});

test('computeLineDiff: create and delete whole file', () => {
  assert.deepEqual(computeLineDiff('', `hello${LF}world`), { added: 2, removed: 0 });
  assert.deepEqual(computeLineDiff(`line1${LF}line2`, ''), { added: 0, removed: 2 });
});

test('computeLineDiff: added and removed are non-negative and bounded by file size', () => {
  const big = Array.from({ length: 50000 }, (_, i) => `row${i}`).join(LF);
  const other = Array.from({ length: 49990 }, (_, i) => `row${i}`).join(LF);
  const result = computeLineDiff(big, other);
  assert.ok(result.added >= 0 && result.removed >= 0);
  assert.ok(result.added + result.removed <= 50000);
});

test('isBinaryContent detects NUL bytes; isBinaryText detects NUL char', () => {
  assert.equal(isBinaryContent(new Uint8Array([104, 101, 108, 108, 111])), false);
  assert.equal(isBinaryContent(new Uint8Array([104, 0, 108])), true);
  assert.equal(isBinaryText(`abc`), false);
  assert.equal(isBinaryText(`a${NUL}b`), true);
});

test('classifyAction derives file action from baseline/current hashes', () => {
  assert.equal(classifyAction('h1', 'h1'), 'SAME');
  assert.equal(classifyAction('h1', 'h2'), 'MODIFY');
  assert.equal(classifyAction(null, 'h2'), 'CREATE');
  assert.equal(classifyAction(undefined, 'h2'), 'CREATE');
  assert.equal(classifyAction('h1', null), 'DELETE');
  assert.equal(classifyAction(null, null), 'SAME');
  assert.equal(classifyAction(undefined, undefined), 'SAME');
});

test('computeSnapshotDiff: modify, create, delete, same with net totals', () => {
  const input = buildInput({
    baseline: [
      baseline('a.txt', `one${LF}two`),
      baseline('b.txt', `brand${LF}new`),
      baseline('c.txt', `gone`),
      baseline('d.txt', `same`),
    ],
    current: [
      current('a.txt', `one${LF}two${LF}three`),
      current('b.txt', `brand${LF}new`),
      // c.txt deleted (absent from current)
      current('d.txt', `same`),
    ],
  });
  const diff = computeSnapshotDiff(input);
  // d.txt 相同被排除；c.txt 删除；b.txt 相同不计入；a.txt 修改 +1。
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('a.txt')?.action, 'MODIFY');
  assert.deepEqual({ a: byPath.get('a.txt')?.added, r: byPath.get('a.txt')?.removed }, { a: 1, r: 0 });
  assert.equal(byPath.get('b.txt'), undefined);
  assert.equal(byPath.get('c.txt')?.action, 'DELETE');
  assert.deepEqual({ a: byPath.get('c.txt')?.added, r: byPath.get('c.txt')?.removed }, { a: 0, r: 1 });
  assert.equal(byPath.get('d.txt'), undefined);
  assert.equal(diff.totalFiles, 2);
  assert.equal(diff.totalAdded, 1);
  assert.equal(diff.totalRemoved, 1);
  assert.equal(diff.resourceId, 'res-1');
  assert.equal(diff.baselineRevision, 1n);
  assert.equal(diff.incomplete, false);
});

test('computeSnapshotDiff: net revert across files collapses to zero', () => {
  // 基线 a=1，当前 a=1（即便中间经历过改动，净变化只看两端）。
  const input = buildInput({
    baseline: [baseline('a.txt', `1`)],
    current: [current('a.txt', `1`)],
  });
  const diff = computeSnapshotDiff(input);
  assert.deepEqual(diff.files, []);
  assert.equal(diff.totalFiles, 0);
  assert.equal(diff.totalAdded, 0);
  assert.equal(diff.totalRemoved, 0);
});

test('computeSnapshotDiff: create then delete within a segment yields zero net for that path', () => {
  // 基线里没有 e.txt（全新创建然后被删），当前也没有 => 不产生任何项。
  const input = buildInput({
    baseline: [baseline('keep.txt', `x`)],
    current: [current('keep.txt', `x`)],
  });
  const diff = computeSnapshotDiff(input);
  assert.deepEqual(diff.files, []);
});

test('computeSnapshotDiff: binary/unavailable files are not counted in totals', () => {
  const input = buildInput({
    baseline: [
      baseline('a.txt', `ok`),
      baseline('bin.dat', null, 'bin-sha'),
    ],
    current: [
      current('a.txt', `ok${LF}more`),
      // bin.dat 当前不可统计（二进制）：文本为 null、原因 BINARY。
      { path: 'bin.dat', sha256: 'bin-sha-2', text: null, lineCount: null, sizeBytes: 3, unavailableReason: 'BINARY' },
    ],
  });
  const diff = computeSnapshotDiff(input);
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('a.txt')?.unavailableReason, null);
  assert.equal(byPath.get('bin.dat')?.unavailableReason, 'BINARY');
  // 总数只含可统计的 a.txt。
  assert.equal(diff.totalFiles, 1);
  assert.equal(diff.totalAdded, 1);
  assert.equal(diff.totalRemoved, 0);
});

test('computeSnapshotDiff: create counts added lines, delete counts removed lines', () => {
  const input = buildInput({
    baseline: [baseline('old.txt', `gone${LF}file`)],
    current: [current('new.txt', `fresh${LF}content${LF}here`)],
  });
  const diff = computeSnapshotDiff(input);
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('old.txt')?.action, 'DELETE');
  assert.equal(byPath.get('old.txt')?.removed, 2);
  assert.equal(byPath.get('old.txt')?.added, 0);
  assert.equal(byPath.get('new.txt')?.action, 'CREATE');
  assert.equal(byPath.get('new.txt')?.added, 3);
  assert.equal(byPath.get('new.txt')?.removed, 0);
  assert.equal(diff.totalFiles, 2);
  assert.equal(diff.totalAdded, 3);
  assert.equal(diff.totalRemoved, 2);
});

test('computeSnapshotDiff: incomplete flag propagates and files are sorted by path', () => {
  const input = buildInput({
    baseline: [baseline('z.txt', `1`), baseline('a.txt', `2`)],
    current: [current('z.txt', `1`), current('a.txt', `2${LF}extra`)],
    incomplete: true,  });
  const diff = computeSnapshotDiff(input);
  assert.equal(diff.incomplete, true);
  // z.txt 内容相同归为 SAME 被排除，只剩 a.txt（排序后）。
  assert.deepEqual(diff.files.map((f) => f.path), ['a.txt']);
});

test('computeAlignedDiff: 替换行成对，未改动行是 CONTEXT，行号双侧对齐', () => {
  const before = `keep${LF}old${LF}tail`;
  const after = `keep${LF}new${LF}tail`;
  const aligned = computeAlignedDiff(before, after);
  assert.ok(aligned);
  assert.equal(aligned.truncated, false);
  assert.deepEqual(aligned.rows.map((row) => row.kind), ['CONTEXT', 'REMOVE', 'ADD', 'CONTEXT']);
  assert.deepEqual(aligned.rows[0], { kind: 'CONTEXT', oldLine: 1, newLine: 1, text: 'keep' });
  assert.deepEqual(aligned.rows[1], { kind: 'REMOVE', oldLine: 2, newLine: null, text: 'old' });
  assert.deepEqual(aligned.rows[2], { kind: 'ADD', oldLine: null, newLine: 2, text: 'new' });
  assert.deepEqual(aligned.rows[3], { kind: 'CONTEXT', oldLine: 3, newLine: 3, text: 'tail' });
});

test('computeAlignedDiff: 改回原文全为 CONTEXT；新建文件全为 ADD；删除全为 REMOVE', () => {
  const back = computeAlignedDiff(`a${LF}b`, `a${LF}b`);
  assert.ok(back);
  assert.equal(back.rows.every((row) => row.kind === 'CONTEXT'), true);

  const created = computeAlignedDiff('', `x${LF}y`);
  assert.ok(created);
  assert.deepEqual(created.rows.map((row) => row.kind), ['ADD', 'ADD']);
  assert.deepEqual(created.rows.map((row) => row.newLine), [1, 2]);

  const deleted = computeAlignedDiff(`x${LF}y`, '');
  assert.ok(deleted);
  assert.deepEqual(deleted.rows.map((row) => row.kind), ['REMOVE', 'REMOVE']);
  assert.deepEqual(deleted.rows.map((row) => row.oldLine), [1, 2]);
});

test('computeAlignedDiff: 超过展示上限时截断并标记；规模超限返回 null', () => {
  const many = Array.from({ length: 50 }, (_, index) => `line-${index}`).join(LF);
  const aligned = computeAlignedDiff(many, `${many}${LF}extra`, 10);
  assert.ok(aligned);
  assert.equal(aligned.rows.length, 10);
  assert.equal(aligned.truncated, true);
  // 规模上限：两侧各 4000 行已超出 4e6 单元预算，不做对齐也不编造近似正文。
  const big = Array.from({ length: 4_000 }, (_, index) => `l${index}`).join(LF);
  assert.equal(computeAlignedDiff(big, big, 600), null);
});
