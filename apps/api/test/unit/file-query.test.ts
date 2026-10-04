import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertQueryDirectoryInsideRoot, boundedQueryLimit, executeFileQuery,
  findPaths, listDirectory, searchText, FILE_QUERY_MAX_RESULTS } from '../../src/files/file-query.js';
import type { JsonObject } from '../../src/infrastructure/json.js';

async function syntheticRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-file-query-')));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Relay\n工具循环说明\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
  await writeFile(join(root, 'src', '工具.ts'), 'export const 中文标识 = 1;\n', 'utf8');
  await writeFile(join(root, 'docs', 'guide.md'), '第一步：搜索受管根。\n', 'utf8');
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
  return root;
}

function entries(result: JsonObject): { path: string }[] {
  return (result.entries ?? result.matches ?? []) as { path: string }[];
}

test('listDirectory returns one bounded layer and skips protected and build directories', async () => {
  const root = await syntheticRoot();
  try {
    const listed = await listDirectory({ kind: 'LIST_DIRECTORY', directory: root });
    assert.equal(listed.outcome, 'SUCCEEDED');
    const paths = entries(listed.result).map((entry) => entry.path).sort();
    assert.deepEqual(paths, ['README.md', 'binary.bin', 'docs', 'src']);
    assert.equal(listed.result.truncated, false);
    // 被跳过的目录计入 skipped，而不是静默当作不存在。
    assert.equal(listed.result.skipped, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('listDirectory truncates at the limit and marks it instead of hiding it', async () => {
  const root = await syntheticRoot();
  try {
    const listed = await listDirectory({ kind: 'LIST_DIRECTORY', directory: root, limit: 2 });
    assert.equal(listed.outcome, 'SUCCEEDED');
    assert.equal(entries(listed.result).length, 2);
    assert.equal(listed.result.limit, 2);
    assert.equal(listed.result.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('findPaths matches path substrings case-insensitively and never reads file content', async () => {
  const root = await syntheticRoot();
  try {
    const found = await findPaths({ kind: 'FIND_PATHS', directory: root, query: '.TS' });
    assert.equal(found.outcome, 'SUCCEEDED');
    const paths = entries(found.result).map((entry) => entry.path).sort();
    assert.deepEqual(paths, ['src/index.ts', 'src/工具.ts']);
    // 受保护内容与依赖目录不出现在结果里。
    assert.ok(!paths.some((path) => path.includes('node_modules') || path.includes('.git')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('searchText returns the first matching line per file with its 1-based position', async () => {
  const root = await syntheticRoot();
  try {
    const searched = await searchText({ kind: 'SEARCH_TEXT', directory: root, query: '受管根' });
    assert.equal(searched.outcome, 'SUCCEEDED');
    const matches = entries(searched.result) as { path: string; line: number; text: string }[];
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.path, 'docs/guide.md');
    assert.equal(matches[0]!.line, 1);
    assert.equal(searched.result.binary_skipped, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing or empty query is a typed failure rather than a silent empty result', async () => {
  const root = await syntheticRoot();
  try {
    assert.equal((await searchText({ kind: 'SEARCH_TEXT', directory: root, query: '  ' })).outcome,
      'FAILED');
    assert.equal((await findPaths({ kind: 'FIND_PATHS', directory: root })).outcome, 'FAILED');
    const missing = await listDirectory({ kind: 'LIST_DIRECTORY',
      directory: join(root, 'does-not-exist') });
    assert.equal(missing.outcome, 'FAILED');
    assert.equal(missing.result.reason, 'FILE_QUERY_DIRECTORY_UNREADABLE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an abort signal stops the query before any result is claimed', async () => {
  const root = await syntheticRoot();
  try {
    const controller = new AbortController();
    controller.abort();
    const stopped = await executeFileQuery({ kind: 'FIND_PATHS', directory: root,
      query: 'index', signal: controller.signal });
    assert.equal(stopped.outcome, 'FAILED');
    assert.equal(stopped.result.reason, 'FILE_QUERY_ABORTED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a directory link is not descended into, so one file cannot appear twice', async (t) => {
  const root = await syntheticRoot();
  let linked = true;
  try {
    try { await symlink(join(root, 'src'), join(root, 'src-link'), 'junction'); }
    catch { linked = false; }
    if (!linked) { t.skip('this platform does not allow creating a directory link'); return; }
    const found = await findPaths({ kind: 'FIND_PATHS', directory: root, query: 'index.ts' });
    const paths = entries(found.result).map((entry) => entry.path);
    assert.deepEqual(paths, ['src/index.ts']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the query limit is clamped to the adapter bound instead of being trusted', () => {
  assert.equal(boundedQueryLimit(undefined), FILE_QUERY_MAX_RESULTS);
  assert.equal(boundedQueryLimit(0), FILE_QUERY_MAX_RESULTS);
  assert.equal(boundedQueryLimit(1_000_000), FILE_QUERY_MAX_RESULTS);
  assert.equal(boundedQueryLimit(7), 7);
});

test('a query directory outside the managed root is refused by path shape', () => {
  assert.doesNotThrow(() => assertQueryDirectoryInsideRoot(join('D:', 'root'), join('D:', 'root')));
  assert.throws(() => assertQueryDirectoryInsideRoot(join('D:', 'root'), join('D:', 'other')),
    /escapes the resource root/);
  assert.throws(() => assertQueryDirectoryInsideRoot(join('D:', 'root'), join('D:', 'root', '.git')),
    /protected/);
});