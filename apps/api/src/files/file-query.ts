import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { isProtectedPath } from './file-changeset.js';

/**
 * FILE_QUERY 只读适配器（docs/architecture/tool-adapters.md §1.4）。
 *
 * 目录浏览、路径查找与内容搜索共用受管根边界：调用方传入已冻结并 realpath 过的目录，
 * 本模块只在其下做有界枚举。结果一律是根内相对路径加定位信息，并显式带 limit/truncated；
 * 截断的结果不能被下游当作完整证据。
 */

export type FileQueryKind = 'LIST_DIRECTORY' | 'FIND_PATHS' | 'SEARCH_TEXT';

/** 单次查询返回的最大条目数；调用方可用更小的 limit，但不能更大。 */
export const FILE_QUERY_MAX_RESULTS = 200;
/** 单个文件参与内容搜索的最大字节数；超过只按文件名/路径匹配，不整篇读入。 */
export const FILE_QUERY_MAX_SEARCH_BYTES = 256 * 1024;
/** 路径查找与内容搜索单次遍历的硬性条目上限，防止在巨型目录上无界下降。 */
export const FILE_QUERY_MAX_VISITED_ENTRIES = 20_000;

/**
 * 默认跳过的目录。除 isProtectedPath 的既有词表外再加构建产物与依赖目录：
 * 把这些内容喂给模型既没有决策价值，也会让一次查询退化成全仓扫描。
 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '__pycache__',
  '.venv', 'venv', '.next', '.nuxt', '.cache', '.turbo',
]);

export interface FileQueryInput {
  readonly kind: FileQueryKind;
  /** 已冻结并 realpath 过的查询目录；调用方负责证明它在受管根内。 */
  readonly directory: string;
  /** 根内相对子目录；缺省或空串表示查询目录自身。 */
  readonly relativePath?: string | undefined;
  /** FIND_PATHS 的路径子串；SEARCH_TEXT 的字面查询串。 */
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface FileQueryResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly result: JsonObject;
}

function failed(reason: string, detail: string): FileQueryResult {
  return { outcome: 'FAILED', result: { reason, detail } };
}

/** 把调用方给的 limit 收敛到 1..FILE_QUERY_MAX_RESULTS；非法值退回上限而不是报错。 */
export function boundedQueryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return FILE_QUERY_MAX_RESULTS;
  return Math.min(limit, FILE_QUERY_MAX_RESULTS);
}

function skippedEntry(name: string, isDirectory: boolean): boolean {
  if (isProtectedPath(name)) return true;
  return isDirectory && SKIPPED_DIRECTORY_NAMES.has(name.toLowerCase());
}

/** 目录枚举只返回一层；下降是 FIND_PATHS/SEARCH_TEXT 的事。 */
export async function listDirectory(input: FileQueryInput): Promise<FileQueryResult> {
  const limit = boundedQueryLimit(input.limit);
  let entries;
  try {
    entries = await readdir(input.directory, { withFileTypes: true });
  } catch (error) {
    return failed('FILE_QUERY_DIRECTORY_UNREADABLE', (error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
  }
  const listed: JsonValue[] = [];
  let truncated = false;
  let skipped = 0;
  const sorted = [...entries].sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of sorted) {
    if (listed.length >= limit) { truncated = true; break; }
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    let size: number | null = null;
    if (entry.isSymbolicLink() || !isDirectory) {
      // Dirent 不跟随链接，且不给出普通文件的实际大小；这里做一次有界 stat。
      try {
        const stats = await stat(resolve(input.directory, entry.name));
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
        size = isFile ? stats.size : null;
      } catch {
        size = null;
      }
    }
    if (skippedEntry(entry.name, isDirectory)) { skipped += 1; continue; }
    listed.push({ path: entry.name, kind: isDirectory ? 'directory' : isFile ? 'file' : 'other', size });
  }
  return { outcome: 'SUCCEEDED',
    result: { directory: '.', entries: listed, count: listed.length, limit, truncated, skipped } };
}

interface WalkedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

/**
 * 深度优先下降，跳过保护内容与构建产物。达到访问上限就停止并把 truncated 交给调用方，
 * 不为了「找全」而无界读取一个巨型目录。
 */
async function walkFiles(root: string, signal: AbortSignal | undefined,
  onFile: (file: WalkedFile) => Promise<boolean>): Promise<{ visited: number; stopped: boolean }> {
  const aborted = (): boolean => signal?.aborted === true;
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= FILE_QUERY_MAX_VISITED_ENTRIES) return { visited, stopped: true };
    if (aborted()) return { visited, stopped: true };
    const directory = stack.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (visited >= FILE_QUERY_MAX_VISITED_ENTRIES) return { visited, stopped: true };
      if (aborted()) return { visited, stopped: true };
      if (isProtectedPath(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      // 链接一律按普通文件处理：跟随目录链接会让同一份内容出现两次，也可能越出根。
      // 真正读取时再由 realpath 收敛，越界的文件按读失败跳过。
      const isDirectory = entry.isDirectory();
      const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
      if (isDirectory) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
        visited += 1;
        stack.push(absolutePath);
        continue;
      }
      visited += 1;
      if (!await onFile({ relativePath, absolutePath })) return { visited, stopped: true };
    }
  }
  return { visited, stopped: false };
}

export async function findPaths(input: FileQueryInput): Promise<FileQueryResult> {
  const limit = boundedQueryLimit(input.limit);
  const pattern = (input.query ?? '').trim().toLowerCase();
  if (pattern === '') return failed('FILE_QUERY_PATTERN_REQUIRED', 'find_paths 需要非空 pattern。');
  const matches: JsonValue[] = [];
  let stopped = false;
  const walked = await walkFiles(input.directory, input.signal, async (file) => {
    if (matches.length >= limit) { stopped = true; return false; }
    if (file.relativePath.toLowerCase().includes(pattern)) {
      matches.push({ path: file.relativePath,
        name: file.relativePath.split('/').pop() ?? file.relativePath });
    }
    return true;
  });
  return { outcome: 'SUCCEEDED', result: { pattern: input.query ?? '', matches,
    count: matches.length, limit, truncated: stopped || walked.stopped,
    visited_entries: walked.visited } };
}

export async function searchText(input: FileQueryInput): Promise<FileQueryResult> {
  const limit = boundedQueryLimit(input.limit);
  const needle = (input.query ?? '').trim();
  if (needle === '') return failed('FILE_QUERY_QUERY_REQUIRED', 'search_text 需要非空 query。');
  const matches: JsonValue[] = [];
  let stopped = false;
  let binarySkipped = 0;
  const walked = await walkFiles(input.directory, input.signal, async (file) => {
    if (matches.length >= limit) { stopped = true; return false; }
    let content: string;
    try {
      const resolved = await realpath(file.absolutePath);
      const stats = await stat(resolved);
      if (!stats.isFile() || stats.size > FILE_QUERY_MAX_SEARCH_BYTES) return true;
      const bytes = await readFile(resolved, { signal: input.signal });
      if (bytes.includes(0)) { binarySkipped += 1; return true; }
      content = bytes.toString('utf8');
    } catch { return true; }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(needle)) continue;
      matches.push({ path: file.relativePath, line: index + 1, text: line.trim().slice(0, 300) });
      break;
    }
    return true;
  });
  return { outcome: 'SUCCEEDED', result: { query: needle, matches, count: matches.length,
    limit, truncated: stopped || walked.stopped, visited_entries: walked.visited,
    binary_skipped: binarySkipped } };
}

/** 统一入口：只按调用方已冻结的 kind 分派，不接受模型自带的动作名。 */
export async function executeFileQuery(input: FileQueryInput): Promise<FileQueryResult> {
  if (input.signal?.aborted === true) return failed('FILE_QUERY_ABORTED', '查询在开始前被取消。');
  if (input.kind === 'LIST_DIRECTORY') return listDirectory(input);
  if (input.kind === 'FIND_PATHS') return findPaths(input);
  return searchText(input);
}

/**
 * 核对用安全重读。只读动作没有外部效果：按同一冻结输入重跑一次，把本次真实读到的
 * 结果记进证据。查询失败记 NOT_EXECUTED 之外的真实类型化原因，不假装读到了内容。
 */
export async function reconcileFileQuery(op: {
  readonly normalized_target: string;
  readonly action_type: string;
  readonly params: JsonObject;
}): Promise<{ readonly status: 'SUCCEEDED' | 'NOT_EXECUTED'; readonly result: JsonObject }> {
  const rerun = await executeFileQuery({
    kind: op.action_type as FileQueryKind,
    directory: op.normalized_target,
    relativePath: typeof op.params.relative_path === 'string' ? op.params.relative_path : '',
    query: typeof op.params.query === 'string' ? op.params.query : undefined,
    limit: typeof op.params.limit === 'number' ? op.params.limit : undefined,
  });
  return { status: rerun.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'NOT_EXECUTED',
    result: { reconciliation: 'SAFE_RE_READ', ...rerun.result } };
}

/** 查询目录必须仍在受管根下且不是受保护路径；绝对路径与链接的最终判定留给 realpath。 */
export function assertQueryDirectoryInsideRoot(root: string, directory: string): void {
  const relativePath = relative(root, resolve(directory));
  if (relativePath === '') return;
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Query directory '${directory}' escapes the resource root`);
  }
  if (isProtectedPath(relativePath)) {
    throw new Error(`Query directory '${relativePath}' is protected`);
  }
}