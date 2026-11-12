import {
  accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  RUNTIME_LOG_LEVELS, getRuntimeLogger, redactLogText, redactRecord, runtimeLogFile,
  type RuntimeLogLevel,
} from '../infrastructure/runtime-log.js';

/**
 * Read-only diagnostics log reader.
 *
 * Security boundaries:
 * - Only the five fixed file families below are readable. Callers cannot pass paths.
 * - Rotated names are generated from the fixed bases; any other name is rejected before fs access.
 * - Symlinked candidates are rejected; real paths must stay inside `<data-root>/logs`.
 * - Each file is tail-read with a byte cap and the whole request has a total scan cap.
 *
 * Robustness boundaries:
 * - Incomplete JSONL, truncated lines and mixed plain-text output are returned as raw lines
 *   instead of being dropped or crashing the endpoint.
 * - Every parsed record is passed through `redactRecord` again before it leaves the process.
 */

interface LogFileSpec {
  readonly base: string;
  readonly process: string;
  readonly label: string;
  readonly rotation: 'numbered' | 'old' | 'none';
}

export const DIAGNOSTIC_LOG_SPECS: readonly LogFileSpec[] = [
  { base: 'relay-api.log', process: 'api', label: 'API 运行日志', rotation: 'numbered' },
  { base: 'relay-worker.log', process: 'worker', label: 'Worker 运行日志', rotation: 'numbered' },
  { base: 'relay-supervisor.log', process: 'supervisor', label: 'Supervisor 运行日志', rotation: 'numbered' },
  { base: 'desktop.log', process: 'desktop', label: '桌面宿主日志', rotation: 'none' },
  { base: 'worker-supervisor.log', process: 'supervisor-host', label: '宿主 Supervisor 输出', rotation: 'old' },
];

export type DiagnosticProcessName = 'api' | 'worker' | 'supervisor' | 'desktop' | 'supervisor-host';

export interface DiagnosticFileInfo {
  readonly name: string;
  readonly process: string;
  readonly label: string;
  /** 0 = active file, 1..n = numbered rotation, -1 = legacy `.old.log`. */
  readonly rotation: number;
  readonly exists: boolean;
  readonly size_bytes: number | null;
  readonly modified_at: string | null;
  readonly readable: boolean;
  readonly error: string | null;
}

export interface DiagnosticFileInventory {
  readonly directory: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly error: string | null;
  readonly files: readonly DiagnosticFileInfo[];
}

export interface DiagnosticLogQuery {
  /** Exact allowed file name; undefined means every allowed file. */
  readonly file?: string | undefined;
  readonly minLevel?: RuntimeLogLevel | undefined;
  readonly processes?: readonly string[] | undefined;
  readonly keyword?: string | undefined;
  readonly eventPattern?: string | undefined;
  readonly sinceMs?: number | undefined;
  readonly untilMs?: number | undefined;
  readonly correlation?: Readonly<Record<string, string>> | undefined;
  readonly anyId?: string | undefined;
}

interface TextLine {
  readonly offset: number;
  readonly text: string;
  readonly truncated: boolean;
}

interface InternalEntry {
  readonly id: string;
  readonly file: string;
  readonly process: string;
  readonly offset: number;
  readonly ts: string | null;
  readonly tsMs: number | null;
  readonly level: RuntimeLogLevel;
  readonly event: string | null;
  readonly raw?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly record?: Record<string, unknown> | undefined;
}

export interface DiagnosticLogEntry {
  readonly id: string;
  readonly file: string;
  readonly process: string;
  readonly offset: number;
  readonly ts: string | null;
  readonly level: RuntimeLogLevel;
  readonly event: string | null;
  readonly raw?: string | undefined;
  readonly truncated?: boolean | undefined;
  readonly record?: Record<string, unknown> | undefined;
}

export interface DiagnosticLogPage {
  readonly records: readonly DiagnosticLogEntry[];
  readonly next_cursor: string | null;
  readonly matched_count: number;
  readonly scanned_bytes: number;
  readonly truncated: boolean;
  readonly inventory: DiagnosticFileInventory;
}

export interface DiagnosticExport {
  readonly text: string;
  readonly count: number;
  readonly truncated: boolean;
}

export interface DiagnosticDatabaseProbe {
  readonly database: 'up' | 'down';
  readonly schema: 'up' | 'down' | 'unknown';
}

export interface DiagnosticRuntimeDependencies {
  readonly probeDatabase?: (() => Promise<DiagnosticDatabaseProbe>) | undefined;
}

export type DiagnosticProcessStatusKind = 'running' | 'stopped' | 'failed' | 'unknown';

export interface DiagnosticProcessStatus {
  readonly status: DiagnosticProcessStatusKind;
  readonly detail: string;
  readonly pid: number | null;
  readonly derived_from: 'log+pid' | 'log' | null;
  readonly last_event: {
    readonly event: string | null;
    readonly ts: string | null;
    readonly level: string;
    readonly file: string;
    readonly offset: number;
  } | null;
}

export interface DiagnosticRuntimeStatus {
  readonly generated_at: string;
  readonly api: {
    readonly status: 'up';
    readonly pid: number;
    readonly uptime_seconds: number;
    readonly node: string;
    readonly started_at: string;
    readonly log_file: string | null;
  };
  readonly database: {
    readonly status: 'up' | 'down' | 'unknown';
    readonly schema: 'up' | 'down' | 'unknown';
    readonly detail: string | null;
  };
  readonly worker: DiagnosticProcessStatus;
  readonly supervisor: DiagnosticProcessStatus;
  readonly log_directory: {
    readonly path: string;
    readonly exists: boolean;
    readonly writable: boolean | null;
    readonly file_count: number;
  };
  readonly last_error: {
    readonly id: string;
    readonly ts: string | null;
    readonly level: string;
    readonly process: string;
    readonly event: string | null;
    readonly message: string | null;
    readonly file: string;
    readonly offset: number;
  } | null;
}

const MAX_FILE_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const MAX_RAW_TEXT = 8 * 1024;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_RECORDS = 1000;
const MAX_NUMBERED_ROTATIONS = 99;
const PROC_LIVENESS_TIMEOUT_MS = 1500;

const LEVEL_ORDER: Record<RuntimeLogLevel, number> = {
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};

const CORRELATION_FIELDS = [
  'request_id', 'command_id', 'session_id', 'message_id', 'model_call_id',
  'project_id', 'task_id', 'run_id', 'operation_id', 'invocation_id', 'worker_id',
] as const;

const WORKER_LIFECYCLE_EVENTS = new Set([
  'worker_started', 'worker_one_shot_exit', 'worker_failed', 'worker_configuration_failed',
]);
const WORKER_FAILURE_EVENTS = new Set(['worker_failed', 'worker_configuration_failed']);
const WORKER_STOP_EVENTS = new Set(['worker_one_shot_exit']);
const SUPERVISOR_LIFECYCLE_EVENTS = new Set([
  'supervisor_started', 'supervisor_failed', 'supervisor_configuration_failed',
  'worker_spawned', 'worker_exited',
]);
const SUPERVISOR_FAILURE_EVENTS = new Set(['supervisor_failed', 'supervisor_configuration_failed']);

const ALLOWED_PROCESSES = new Set(DIAGNOSTIC_LOG_SPECS.map((spec) => spec.process));

export function diagnosticLogDirectory(dataRoot: string): string {
  return resolve(dataRoot, 'logs');
}

export function allowedDiagnosticFile(name: string): { spec: LogFileSpec; rotation: number } | undefined {
  for (const spec of DIAGNOSTIC_LOG_SPECS) {
    if (name === spec.base) return { spec, rotation: 0 };
    if (spec.rotation === 'old' && name === `${spec.base}.old.log`) {
      return { spec, rotation: -1 };
    }
    if (spec.rotation === 'numbered') {
      const matched = /^\.([1-9]\d?)$/u.exec(name.slice(spec.base.length));
      if (name.startsWith(spec.base) && matched !== null) {
        const rotation = Number(matched[1]);
        if (rotation >= 1 && rotation <= MAX_NUMBERED_ROTATIONS) return { spec, rotation };
      }
    }
  }
  return undefined;
}

export function isAllowedDiagnosticFile(name: string): boolean {
  return allowedDiagnosticFile(name) !== undefined;
}

export function isAllowedDiagnosticProcess(name: string): boolean {
  return ALLOWED_PROCESSES.has(name);
}

function safeErrorText(error: unknown): string {
  return redactLogText(error instanceof Error ? error.message : String(error), 500);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  // Windows paths are case-insensitive; realpath does not guarantee the same casing as the
  // configured root, so compare normalized keys rather than raw strings.
  if (process.platform === 'win32') {
    return !relative(root.toLowerCase(), candidate.toLowerCase()).startsWith('..');
  }
  return true;
}

interface Candidate {
  readonly info: DiagnosticFileInfo;
  readonly path: string;
  readonly mtimeMs: number;
}

export function inventoryDiagnosticLogs(dataRoot: string): {
  inventory: DiagnosticFileInventory;
  candidates: readonly Candidate[];
} {
  const directory = diagnosticLogDirectory(dataRoot);
  const baseInfos = DIAGNOSTIC_LOG_SPECS.map((spec): DiagnosticFileInfo => ({
    name: spec.base, process: spec.process, label: spec.label, rotation: 0,
    exists: false, size_bytes: null, modified_at: null, readable: false, error: null,
  }));
  let directoryExists = false;
  let directoryReadable = false;
  let directoryError: string | null = null;
  try {
    directoryExists = statSync(directory).isDirectory();
  } catch (error) {
    directoryError = safeErrorText(error);
  }
  if (!directoryExists) {
    return {
      inventory: {
        directory, exists: false, readable: false,
        error: directoryError ?? '日志目录尚未创建', files: baseInfos,
      },
      candidates: [],
    };
  }

  let names: string[];
  try {
    names = readdirSync(directory);
    directoryReadable = true;
  } catch (error) {
    return {
      inventory: {
        directory, exists: true, readable: false,
        error: safeErrorText(error), files: baseInfos,
      },
      candidates: [],
    };
  }

  let realDirectory: string;
  try {
    realDirectory = realpathSync(directory);
  } catch (error) {
    return {
      inventory: {
        directory, exists: true, readable: false,
        error: safeErrorText(error), files: baseInfos,
      },
      candidates: [],
    };
  }

  const candidates: Candidate[] = [];
  const infos = new Map<string, DiagnosticFileInfo>();
  for (const name of names) {
    const allowed = allowedDiagnosticFile(name);
    if (allowed === undefined) continue;
    const path = join(directory, name);
    let info: DiagnosticFileInfo;
    try {
      const link = lstatSync(path);
      if (link.isSymbolicLink() || !link.isFile()) {
        info = {
          name, process: allowed.spec.process, label: allowed.spec.label,
          rotation: allowed.rotation, exists: true, size_bytes: null, modified_at: null,
          readable: false, error: link.isSymbolicLink() ? '符号链接被拒绝' : '不是普通文件',
        };
      } else {
        const real = realpathSync(path);
        if (!isInside(realDirectory, real)) {
          info = {
            name, process: allowed.spec.process, label: allowed.spec.label,
            rotation: allowed.rotation, exists: true, size_bytes: null, modified_at: null,
            readable: false, error: '文件落在受管日志目录之外',
          };
        } else {
          const stat = statSync(real);
          let readable = true;
          try {
            accessSync(real, constants.R_OK);
          } catch {
            readable = false;
          }
          info = {
            name, process: allowed.spec.process, label: allowed.spec.label,
            rotation: allowed.rotation, exists: true, size_bytes: stat.size,
            modified_at: stat.mtime.toISOString(), readable, error: readable ? null : '文件不可读',
          };
          if (readable) candidates.push({ info, path: real, mtimeMs: stat.mtimeMs });
        }
      }
    } catch (error) {
      info = {
        name, process: allowed.spec.process, label: allowed.spec.label,
        rotation: allowed.rotation, exists: false, size_bytes: null, modified_at: null,
        readable: false, error: safeErrorText(error),
      };
    }
    infos.set(name, info);
  }

  const files: DiagnosticFileInfo[] = [];
  for (const spec of DIAGNOSTIC_LOG_SPECS) {
    const base = infos.get(spec.base);
    files.push(base ?? {
      name: spec.base, process: spec.process, label: spec.label, rotation: 0,
      exists: false, size_bytes: null, modified_at: null, readable: false, error: null,
    });
    const rotations = [...infos.values()]
      .filter((info) => info.name !== spec.base && info.process === spec.process
        && (info.name.startsWith(`${spec.base}.`)))
      .sort((left, right) => left.rotation - right.rotation);
    files.push(...rotations);
  }

  return {
    inventory: {
      directory, exists: true, readable: directoryReadable,
      error: directoryError, files,
    },
    candidates: candidates.sort((left, right) => right.mtimeMs - left.mtimeMs
      || left.info.name.localeCompare(right.info.name)),
  };
}

function readTailLines(path: string, maxBytes: number): {
  lines: readonly TextLine[];
  truncatedHead: boolean;
  size: number;
} {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) return { lines: [], truncatedHead: false, size };
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    if (read === 0) return { lines: [], truncatedHead: start > 0, size };

    let cursor = 0;
    if (start > 0) {
      const newline = buffer.subarray(0, read).indexOf(0x0a);
      if (newline < 0) return { lines: [], truncatedHead: true, size };
      cursor = newline + 1;
    }
    const lines: TextLine[] = [];
    while (cursor < read) {
      const newline = buffer.subarray(cursor, read).indexOf(0x0a);
      const end = newline < 0 ? read : cursor + newline;
      if (end > cursor) {
        const raw = buffer.subarray(cursor, end);
        const truncated = raw.length > MAX_LINE_BYTES;
        const text = raw.subarray(0, MAX_LINE_BYTES).toString('utf8').replace(/\r$/u, '');
        lines.push({ offset: start + cursor, text, truncated });
      }
      if (newline < 0) break;
      cursor = end + 1;
    }
    return { lines, truncatedHead: start > 0, size };
  } finally {
    closeSync(fd);
  }
}

function normalizeLevel(value: unknown): RuntimeLogLevel {
  return typeof value === 'string'
    && (RUNTIME_LOG_LEVELS as readonly string[]).includes(value.toLowerCase())
    ? value.toLowerCase() as RuntimeLogLevel : 'info';
}

function inferRawLevel(text: string): RuntimeLogLevel {
  if (/\bfatal\b/iu.test(text)) return 'fatal';
  if (/\berror\b|\bfailed\b/iu.test(text)) return 'error';
  if (/\bwarn(?:ing)?\b/iu.test(text)) return 'warn';
  return 'info';
}

function rawTimestamp(text: string): { ts: string | null; tsMs: number | null } {
  const anchored = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/u.exec(text);
  // 不完整的 JSONL 仍可能带着完整的 `ts` 字段；按片段提取，避免整行退化成无法按时间排序。
  const embedded = anchored ?? /"ts"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/u.exec(text);
  if (embedded === null || embedded[1] === undefined) return { ts: null, tsMs: null };
  const tsMs = Date.parse(embedded[1]);
  return Number.isNaN(tsMs) ? { ts: null, tsMs: null } : { ts: embedded[1], tsMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(fileName: string, processName: string, line: TextLine): InternalEntry | null {
  const text = line.text.replace(/^\uFEFF/u, '');
  if (text.trim() === '') return null;
  const id = `${fileName}:${String(line.offset)}`;
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const safe = redactRecord(parsed);
        const rawTs = typeof safe.ts === 'string' ? safe.ts : null;
        const tsMs = rawTs === null ? Number.NaN : Date.parse(rawTs);
        const ts = rawTs !== null && !Number.isNaN(tsMs) ? rawTs : null;
        return {
          id, file: fileName, offset: line.offset, ts, tsMs: ts === null ? null : tsMs,
          level: normalizeLevel(safe.level),
          process: typeof safe.process === 'string' && safe.process !== '' ? safe.process : processName,
          event: typeof safe.event === 'string' && safe.event !== '' ? safe.event : null,
          record: safe,
          ...(line.truncated ? { truncated: true } : {}),
        };
      }
    } catch {
      // Incomplete JSONL or a foreign writer: keep the line as raw text.
    }
  }
  const timestamp = rawTimestamp(text);
  return {
    id, file: fileName, offset: line.offset, ts: timestamp.ts, tsMs: timestamp.tsMs,
    level: inferRawLevel(text), process: processName, event: null,
    raw: redactLogText(text, MAX_RAW_TEXT),
    ...(line.truncated ? { truncated: true } : {}),
  };
}

function eventMatcher(pattern: string | undefined): (event: string | null) => boolean {
  if (pattern === undefined || pattern === '') return () => true;
  if (!pattern.includes('*')) return (event) => event === pattern;
  const regex = new RegExp('^' + pattern.split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*') + '$', 'u');
  return (event) => event !== null && regex.test(event);
}

function entryMatches(entry: InternalEntry, query: DiagnosticLogQuery,
  matchesEvent: (event: string | null) => boolean): boolean {
  if ((LEVEL_ORDER[entry.level] ?? LEVEL_ORDER.info) > LEVEL_ORDER[query.minLevel ?? 'info']) {
    return false;
  }
  if (query.processes !== undefined && query.processes.length > 0
    && !query.processes.includes(entry.process)) return false;
  if (!matchesEvent(entry.event)) return false;
  if (query.sinceMs !== undefined || query.untilMs !== undefined) {
    if (entry.tsMs === null) return false;
    if (query.sinceMs !== undefined && entry.tsMs < query.sinceMs) return false;
    if (query.untilMs !== undefined && entry.tsMs > query.untilMs) return false;
  }
  if (query.correlation !== undefined) {
    const record = entry.record ?? {};
    for (const [key, value] of Object.entries(query.correlation)) {
      if (value === '') continue;
      if (String(record[key] ?? '') !== value) return false;
    }
  }
  if (query.anyId !== undefined && query.anyId !== '') {
    const record = entry.record ?? {};
    if (!CORRELATION_FIELDS.some((key) => String(record[key] ?? '') === query.anyId)) return false;
  }
  if (query.keyword !== undefined && query.keyword !== '') {
    const haystack = entry.raw ?? JSON.stringify(entry.record ?? {});
    if (!haystack.toLowerCase().includes(query.keyword.toLowerCase())) return false;
  }
  return true;
}

/** Newer first (oldest last). Entries without a timestamp sort after timestamped ones. */
function compareEntries(left: InternalEntry, right: InternalEntry): number {
  if (left.tsMs !== right.tsMs) {
    if (left.tsMs === null) return -1;
    if (right.tsMs === null) return 1;
    return left.tsMs - right.tsMs;
  }
  if (left.file !== right.file) return left.file < right.file ? 1 : -1;
  return left.offset - right.offset;
}

interface Cursor { readonly t: number | null; readonly f: string; readonly o: number }

function encodeCursor(entry: InternalEntry): string {
  return Buffer.from(JSON.stringify({
    t: entry.tsMs, f: entry.file, o: entry.offset,
  } satisfies Cursor), 'utf8').toString('base64url');
}

export function decodeDiagnosticCursor(value: string): Cursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!isRecord(parsed)) return undefined;
    const t = parsed.t;
    const f = parsed.f;
    const o = parsed.o;
    if ((t !== null && typeof t !== 'number') || typeof f !== 'string'
      || typeof o !== 'number' || !Number.isInteger(o) || o < 0) return undefined;
    return { t, f, o };
  } catch {
    return undefined;
  }
}

function cursorEntry(cursor: Cursor): InternalEntry {
  return {
    id: `${cursor.f}:${String(cursor.o)}`, file: cursor.f, process: '', offset: cursor.o,
    ts: null, tsMs: cursor.t, level: 'info', event: null,
  };
}

function publicEntry(entry: InternalEntry): DiagnosticLogEntry {
  return {
    id: entry.id, file: entry.file, process: entry.process, offset: entry.offset,
    ts: entry.ts, level: entry.level, event: entry.event,
    ...(entry.raw === undefined ? {} : { raw: entry.raw }),
    ...(entry.truncated === true ? { truncated: true } : {}),
    ...(entry.record === undefined ? {} : { record: entry.record }),
  };
}

function collectEntries(dataRoot: string, query: DiagnosticLogQuery,
  limit: number, cursor: Cursor | undefined): {
  page: DiagnosticLogEntry[];
  matchedCount: number;
  scannedBytes: number;
  truncated: boolean;
  inventory: DiagnosticFileInventory;
  hasMore: boolean;
} {
  const { inventory, candidates } = inventoryDiagnosticLogs(dataRoot);
  const selected = query.file === undefined
    ? candidates
    : candidates.filter((candidate) => candidate.info.name === query.file);
  const matchesEvent = eventMatcher(query.eventPattern);
  const entries: InternalEntry[] = [];
  let scannedBytes = 0;
  let truncated = false;
  for (const candidate of selected) {
    const remaining = MAX_TOTAL_SCAN_BYTES - scannedBytes;
    if (remaining <= 0) { truncated = true; break; }
    const budget = Math.min(MAX_FILE_SCAN_BYTES, remaining);
    let tail: ReturnType<typeof readTailLines>;
    try {
      tail = readTailLines(candidate.path, budget);
    } catch {
      continue;
    }
    scannedBytes += Math.min(tail.size, budget);
    if (tail.truncatedHead) truncated = true;
    for (const line of tail.lines) {
      const entry = parseEntry(candidate.info.name, candidate.info.process, line);
      if (entry === null) continue;
      if (entryMatches(entry, query, matchesEvent)) entries.push(entry);
    }
  }
  entries.sort((left, right) => compareEntries(right, left));
  const matchedCount = entries.length;
  let start = 0;
  if (cursor !== undefined) {
    const marker = cursorEntry(cursor);
    const index = entries.findIndex((entry) => compareEntries(marker, entry) > 0);
    start = index < 0 ? entries.length : index;
  }
  const page = entries.slice(start, start + limit);
  const hasMore = start + limit < entries.length;
  return {
    page: page.map(publicEntry), matchedCount, scannedBytes, truncated, inventory, hasMore,
  };
}

export function readDiagnosticLogs(dataRoot: string, query: DiagnosticLogQuery,
  limit: number, cursor?: string): DiagnosticLogPage {
  const decoded = cursor === undefined ? undefined : decodeDiagnosticCursor(cursor);
  if (cursor !== undefined && decoded === undefined) {
    throw new DiagnosticQueryError('cursor', 'cursor 无法识别');
  }
  const result = collectEntries(dataRoot, query, limit, decoded);
  const last = result.page.length === 0 ? undefined : result.page[result.page.length - 1];
  return {
    records: result.page,
    next_cursor: result.hasMore && last !== undefined
      ? encodeCursor({
        id: last.id, file: last.file, process: last.process, offset: last.offset,
        ts: last.ts, tsMs: last.ts === null ? null : Date.parse(last.ts),
        level: last.level, event: last.event,
      })
      : null,
    matched_count: result.matchedCount,
    scanned_bytes: result.scannedBytes,
    truncated: result.truncated,
    inventory: result.inventory,
  };
}

export function exportDiagnosticLogs(dataRoot: string, query: DiagnosticLogQuery,
  limit: number): DiagnosticExport {
  const boundedLimit = Math.min(Math.max(limit, 1), MAX_EXPORT_RECORDS);
  const result = collectEntries(dataRoot, query, boundedLimit, undefined);
  const lines: string[] = [
    '# Relay diagnostics export',
    `# generated_at: ${new Date().toISOString()}`,
    `# records: ${String(result.page.length)} of ${String(result.matchedCount)} matched`,
    `# scan_limited: ${String(result.truncated)}`,
  ];
  let bytes = Buffer.byteLength(lines.join('\n'), 'utf8') + 1;
  let truncated = result.truncated;
  let count = 0;
  for (const entry of result.page) {
    // Re-redact the final exported shape: old logs may predate the current redaction rules.
    const safe = redactRecord({
      id: entry.id, ts: entry.ts, level: entry.level, process: entry.process,
      event: entry.event, file: entry.file, offset: entry.offset,
      ...(entry.raw === undefined ? {} : { raw: entry.raw }),
      ...(entry.record === undefined ? {} : { record: entry.record }),
    });
    const line = JSON.stringify(safe);
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + lineBytes > MAX_EXPORT_BYTES) { truncated = true; break; }
    lines.push(line);
    bytes += lineBytes;
    count += 1;
  }
  return { text: lines.join('\n') + '\n', count, truncated };
}

function probePid(pid: unknown): 'alive' | 'dead' | 'unknown' {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function latestEntriesForFile(dataRoot: string, file: string, limit = 300): readonly DiagnosticLogEntry[] {
  try {
    return readDiagnosticLogs(dataRoot, { file, minLevel: 'trace' }, limit).records;
  } catch {
    return [];
  }
}

function processStatus(entries: readonly DiagnosticLogEntry[], kind: 'worker' | 'supervisor'):
DiagnosticProcessStatus {
  const lifecycleEvents = kind === 'worker' ? WORKER_LIFECYCLE_EVENTS : SUPERVISOR_LIFECYCLE_EVENTS;
  const failureEvents = kind === 'worker' ? WORKER_FAILURE_EVENTS : SUPERVISOR_FAILURE_EVENTS;
  const stopEvents = kind === 'worker' ? WORKER_STOP_EVENTS : new Set<string>();
  const latest = entries[0];
  const lifecycle = entries.find((entry) => entry.event !== null && lifecycleEvents.has(entry.event));
  if (latest === undefined || lifecycle === undefined) {
    return {
      status: 'unknown',
      detail: '日志中没有可核实的进程生命周期记录。',
      pid: null, derived_from: null, last_event: null,
    };
  }
  const lastEvent = {
    event: latest.event, ts: latest.ts, level: latest.level,
    file: latest.file, offset: latest.offset,
  };
  // Prefer the newest `*_started` record: later spawn/exit events may carry a child PID,
  // which would make liveness about the wrong process.
  const started = entries.find((entry) => entry.event === 'worker_started'
    || entry.event === 'supervisor_started');
  const pid = typeof started?.record?.pid === 'number' ? started.record.pid
    : typeof latest.record?.pid === 'number' ? latest.record.pid : null;
  const liveness = probePid(pid);
  const derived = liveness === 'unknown' ? 'log' : 'log+pid';
  if (lastEvent.ts === null) {
    return {
      status: 'unknown',
      detail: '最后一条生命周期记录缺少时间戳，无法核对进程是否仍在运行。',
      pid, derived_from: derived, last_event: lastEvent,
    };
  }
  const ageMs = Date.now() - Date.parse(lastEvent.ts);
  const ageText = ageMs >= 0 ? `，最近记录距今 ${formatAge(ageMs)}` : '';
  if (lifecycle.event !== null && failureEvents.has(lifecycle.event)) {
    return {
      status: 'failed',
      detail: `最后生命周期事件为 ${lifecycle.event}${ageText}。`,
      pid, derived_from: derived, last_event: lastEvent,
    };
  }
  if (lifecycle.event !== null && stopEvents.has(lifecycle.event)) {
    return {
      status: 'stopped',
      detail: `最后生命周期事件为 ${lifecycle.event}，进程已按一次性模式退出${ageText}。`,
      pid, derived_from: derived, last_event: lastEvent,
    };
  }
  if (liveness === 'alive') {
    return {
      status: 'running',
      detail: `日志 PID ${String(pid)} 在本机仍存活${ageText}；这是日志与进程探活的推断，不是原子快照。`,
      pid, derived_from: derived, last_event: lastEvent,
    };
  }
  if (liveness === 'dead') {
    return {
      status: 'stopped',
      detail: `日志 PID ${String(pid)} 已不存在${ageText}。`,
      pid, derived_from: derived, last_event: lastEvent,
    };
  }
  return {
    status: 'unknown',
    detail: `无法可靠探活日志 PID${ageText}；请结合最后事件核对。`,
    pid, derived_from: derived, last_event: lastEvent,
  };
}

function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return `${String(Math.floor(ageMs / 1000))} 秒`;
  if (ageMs < 3_600_000) return `${String(Math.floor(ageMs / 60_000))} 分钟`;
  if (ageMs < 86_400_000) return `${String(Math.floor(ageMs / 3_600_000))} 小时`;
  return `${String(Math.floor(ageMs / 86_400_000))} 天`;
}

function errorMessageOf(entry: DiagnosticLogEntry | undefined): string | null {
  if (entry === undefined) return null;
  const record = entry.record ?? {};
  const error = isRecord(record.error) ? record.error : {};
  const message = record.error_message ?? error.message;
  if (typeof message === 'string' && message !== '') return message.slice(0, 500);
  if (typeof record.raw === 'string' && record.raw !== '') return record.raw.slice(0, 500);
  return null;
}

async function probeDatabase(dependencies: DiagnosticRuntimeDependencies):
Promise<DiagnosticRuntimeStatus['database']> {
  if (dependencies.probeDatabase === undefined) {
    return { status: 'unknown', schema: 'unknown', detail: '当前实例没有提供数据库探针。' };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(null), 2500);
    });
    const probe = await Promise.race([dependencies.probeDatabase(), timeout]);
    if (probe === null) {
      return { status: 'unknown', schema: 'unknown', detail: '数据库探针在 2.5 秒内未返回。' };
    }
    return { status: probe.database, schema: probe.schema, detail: null };
  } catch (error) {
    return {
      status: 'down', schema: 'unknown',
      detail: safeErrorText(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readDiagnosticRuntime(dataRoot: string,
  dependencies: DiagnosticRuntimeDependencies = {}): Promise<DiagnosticRuntimeStatus> {
  const { inventory } = inventoryDiagnosticLogs(dataRoot);
  const [database, workerEntries, supervisorEntries, errorPage] = await Promise.all([
    probeDatabase(dependencies),
    Promise.resolve(latestEntriesForFile(dataRoot, 'relay-worker.log')),
    Promise.resolve(latestEntriesForFile(dataRoot, 'relay-supervisor.log')),
    Promise.resolve((() => {
      try {
        return readDiagnosticLogs(dataRoot, { minLevel: 'error' }, 1).records;
      } catch (error) {
        getRuntimeLogger('diagnostics').warn('diagnostics_runtime_error_scan_failed', { error });
        return [];
      }
    })()),
  ]);
  let writable: boolean | null = null;
  try {
    accessSync(inventory.directory, constants.W_OK);
    writable = true;
  } catch {
    writable = inventory.exists ? false : null;
  }
  const lastError = errorPage[0];
  return {
    generated_at: new Date().toISOString(),
    api: {
      status: 'up', pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      node: process.version,
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      log_file: runtimeLogFile() ?? null,
    },
    database,
    worker: processStatus(workerEntries, 'worker'),
    supervisor: processStatus(supervisorEntries, 'supervisor'),
    log_directory: {
      path: inventory.directory,
      exists: inventory.exists,
      writable,
      file_count: inventory.files.filter((file) => file.exists).length,
    },
    last_error: lastError === undefined ? null : {
      id: lastError.id, ts: lastError.ts, level: lastError.level,
      process: lastError.process, event: lastError.event,
      message: errorMessageOf(lastError), file: lastError.file, offset: lastError.offset,
    },
  };
}

export class DiagnosticQueryError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'DiagnosticQueryError';
    this.field = field;
  }
}
