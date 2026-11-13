import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Unified runtime logger for every Relay process (API / Worker / Supervisor / Tauri host).
 *
 * Why this exists: Fastify disables its pino instance in desktop mode
 * (`logger: config.desktopMode ? false : ...`), so every `app.log.*` call was a no-op inside
 * the packaged desktop app and a failed message left nothing behind. This module is
 * dependency-free, independent of Fastify, and always writes a durable structured record.
 *
 * Guarantees:
 * - JSON Lines, one record per write, with `ts` / `level` / `event` plus caller fields.
 * - Every record carries `process` / `pid`; every record has an ISO timestamp.
 * - Never writes to stdout: in desktop mode stdout is the host JSON event channel.
 * - Deep-redacts secret-looking field names, Bearer / sk- values and DB URLs with passwords.
 * - Errors are serialized with name / message / bounded stack / code / bounded cause chain.
 * - Records are capped at {@link MAX_LOG_RECORD_BYTES}; oversized payloads collapse instead of
 *   growing without bound.
 * - Repeated warn/error records are throttled per (event, error, correlation ids) with an explicit
 *   summary line; request-scoped errors are never aggregated.
 * - Size-based rotation with a bounded retention window; a best-effort lock file keeps several
 *   processes sharing one log file from interleaving renames.
 * - Log failures never throw into business code: first failure falls back to stderr, further
 *   failures are counted and reported at most once per minute.
 * - Silently does nothing until `configureRuntimeLog` runs, so unit tests never touch disk.
 */
export type RuntimeLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const RUNTIME_LOG_LEVELS: readonly RuntimeLogLevel[] = [
  'fatal', 'error', 'warn', 'info', 'debug', 'trace',
];
export const DEFAULT_LOG_LEVEL: RuntimeLogLevel = 'info';

const LEVEL_ORDER: Record<RuntimeLogLevel, number> = {
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};

export const DEFAULT_LOG_FILE_NAME = 'relay-api.log';
export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOG_RETAIN_FILES = 5;
/** 单条记录上限：超过即折叠成带关联 ID 的紧凑记录，避免超大对象拖垮回写。 */
export const MAX_LOG_RECORD_BYTES = 64 * 1024;

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 2000;
/** 栈比普通字段长：保留完整调用链才有定位价值，仍设上限防止日志失控。 */
const MAX_STACK_LENGTH = 4000;
const MAX_CAUSE_DEPTH = 3;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_SUPPRESS_KEY_PART = 200;

const SUPPRESS_WINDOW_MS = 10_000;
const SUPPRESS_AFTER = 5;
const SUPPRESS_MAP_LIMIT = 256;

const ROTATION_LOCK_STALE_MS = 10_000;
const ROTATION_LOCK_SUFFIX = '.rotate.lock';
const WRITE_FAILURE_REPORT_INTERVAL_MS = 60_000;

const REDACTED = '[redacted]';
const NEWLINE = String.fromCharCode(10);

const SECRET_KEY = new RegExp(
  'api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token'
  + '|session[_-]?token|csrf[_-]?token|xsrf[_-]?token'
  + '|bearer|secret|password|passwd|credential|cookie|private[_-]?key|set-cookie',
  'i',
);

/** 关联 ID 在记录被折叠时也必须保留：排障靠它们把跨进程链路串起来。 */
const CORRELATION_FIELDS = [
  'request_id', 'command_id', 'session_id', 'message_id', 'model_call_id',
  'project_id', 'task_id', 'run_id', 'operation_id', 'invocation_id', 'worker_id',
] as const;

export interface RuntimeLogConfig {
  // `| undefined` is explicit because the API tsconfig enables exactOptionalPropertyTypes.
  readonly directory?: string | undefined;
  readonly fileName?: string | undefined;
  readonly level?: RuntimeLogLevel | undefined;
  /** 进程标识（api / worker / supervisor / desktop-host），用于多进程共用目录时区分来源。 */
  readonly processName?: string | undefined;
  readonly echoToStderr?: boolean | undefined;
  readonly maxBytes?: number | undefined;
  readonly retainFiles?: number | undefined;
}

export interface RuntimeLogger {
  readonly namespace: string;
  readonly file?: string | undefined;
  fatal(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
  trace(event: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): RuntimeLogger;
  isEnabled(level: RuntimeLogLevel): boolean;
}

interface RuntimeLogState {
  readonly directory?: string;
  readonly fileName: string;
  readonly level: RuntimeLogLevel;
  readonly processName: string;
  readonly pid: number;
  readonly echoToStderr: boolean;
  readonly maxBytes: number;
  readonly retainFiles: number;
}

export interface RuntimeLogEnvSettings {
  readonly level: RuntimeLogLevel;
  readonly maxBytes: number;
  readonly retainFiles: number;
  /** 配置值无效时的说明；调用方应在日志就绪后写入一条 warn。 */
  readonly issues: readonly string[];
}

const DISABLED: RuntimeLogState = {
  fileName: DEFAULT_LOG_FILE_NAME,
  level: DEFAULT_LOG_LEVEL,
  processName: 'api',
  pid: process.pid,
  echoToStderr: false,
  maxBytes: DEFAULT_LOG_MAX_BYTES,
  retainFiles: DEFAULT_LOG_RETAIN_FILES,
};

let state: RuntimeLogState = DISABLED;

interface SuppressEntry {
  windowStart: number;
  count: number;
  readonly namespace: string;
  readonly level: RuntimeLogLevel;
  readonly event: string;
  readonly bound: Record<string, unknown>;
  readonly fields: Record<string, unknown>;
}

let suppressState = new Map<string, SuppressEntry>();
let suppressTimer: NodeJS.Timeout | undefined;
let exitHookInstalled = false;

interface WriteFailureState {
  lastReportAt: number;
  dropped: number;
}

let writeFailure: WriteFailureState = { lastReportAt: 0, dropped: 0 };

function logFileOf(current: RuntimeLogState): string | undefined {
  return current.directory === undefined ? undefined : join(current.directory, current.fileName);
}

export function parseRuntimeLogLevel(value: string | undefined): RuntimeLogLevel | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return (RUNTIME_LOG_LEVELS as readonly string[]).includes(normalized)
    ? normalized as RuntimeLogLevel
    : undefined;
}

function readEnvInteger(raw: string | undefined, min: number, max: number, fallback: number,
  name: string, issues: string[]): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(`${name} 取值无效（${raw}），已回退 ${String(fallback)}。`);
    return fallback;
  }
  return value;
}

/**
 * 从环境变量解析日志配置，绝不抛错：无效值回退默认并给出可记录的说明。
 * API / Worker / Supervisor 在日志目录尚未确定时就用它，保证超早期失败也能落盘。
 */
export function runtimeLogSettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeLogEnvSettings {
  const issues: string[] = [];
  const rawLevel = env.RELAY_LOG_LEVEL?.trim() ?? '';
  let level = DEFAULT_LOG_LEVEL;
  if (rawLevel !== '') {
    const parsed = parseRuntimeLogLevel(rawLevel);
    if (parsed === undefined) {
      issues.push(`RELAY_LOG_LEVEL 取值无效（${rawLevel}），已回退 ${DEFAULT_LOG_LEVEL}。`);
    } else {
      level = parsed;
    }
  }
  const maxBytes = readEnvInteger(env.RELAY_LOG_MAX_BYTES, 64 * 1024, 1024 * 1024 * 1024,
    DEFAULT_LOG_MAX_BYTES, 'RELAY_LOG_MAX_BYTES', issues);
  const retainFiles = readEnvInteger(env.RELAY_LOG_RETAIN_FILES, 0, 100,
    DEFAULT_LOG_RETAIN_FILES, 'RELAY_LOG_RETAIN_FILES', issues);
  return { level, maxBytes, retainFiles, issues };
}

/**
 * 启动最早期（配置尚未通过校验）使用的日志目录。
 *
 * 优先用进程环境里的 RELAY_DATA_ROOT；它缺失或不是绝对路径时退回系统临时目录——
 * 此时配置本身很可能马上失败，必须保证失败原因仍有一个可写位置。返回值的“实际落点”
 * 由调用方记入 `*_startup_begin.bootstrap_log_file`，避免排障时猜目录。
 */
export function bootstrapLogDirectory(dataRoot: string | undefined): string {
  const normalized = dataRoot?.trim() ?? '';
  return normalized !== '' && isAbsolute(normalized)
    ? join(normalized, 'logs')
    : join(tmpdir(), 'relay-bootstrap-logs');
}

/** Idempotent. A failed directory creation degrades to stderr instead of throwing. */
export function configureRuntimeLog(config: RuntimeLogConfig = {}): void {
  const level = config.level ?? state.level;
  const echoToStderr = config.echoToStderr ?? state.echoToStderr;
  const fileName = config.fileName ?? state.fileName;
  const processName = config.processName ?? state.processName;
  const maxBytes = config.maxBytes !== undefined && config.maxBytes > 0
    ? config.maxBytes : DEFAULT_LOG_MAX_BYTES;
  const retainFiles = config.retainFiles !== undefined && config.retainFiles >= 0
    ? config.retainFiles : DEFAULT_LOG_RETAIN_FILES;

  if (config.directory === undefined || config.directory === '') {
    state = { fileName, level, processName, pid: process.pid, echoToStderr, maxBytes, retainFiles };
    return;
  }
  try {
    mkdirSync(config.directory, { recursive: true });
    state = {
      directory: config.directory, fileName, level, processName, pid: process.pid,
      echoToStderr, maxBytes, retainFiles,
    };
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    state = { fileName, level, processName, pid: process.pid, echoToStderr: true, maxBytes, retainFiles };
    safeStderr(JSON.stringify({
      ts: new Date().toISOString(), level: 'error', event: 'runtime_log_directory_unavailable',
      namespace: 'runtime-log', process: processName, pid: process.pid,
      log_directory: config.directory, error_message: redactString(reason),
    }));
  }
}

/** Test seam: drop any configured directory and level back to the disabled state. */
export function resetRuntimeLog(): void {
  state = DISABLED;
  suppressState = new Map<string, SuppressEntry>();
  if (suppressTimer !== undefined) {
    clearTimeout(suppressTimer);
    suppressTimer = undefined;
  }
  writeFailure = { lastReportAt: 0, dropped: 0 };
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + '...[truncated]' : value;
}

/** 错误消息、栈和普通字符串都可能内嵌凭据；按 token 替换，而不是只看整串。 */
function scrubSecretTokens(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/giu, 'Bearer ' + REDACTED)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/giu, 'Basic ' + REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
      REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, REDACTED)
    // JWT（三段 base64url）常被直接粘进消息或 Header 值。
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED)
    // Cookie / Set-Cookie 整行；字段名脱敏之外的字符串路径也要覆盖。
    .replace(/\b(set-?cookie|cookie)\s*:\s*[^\r\n]+/giu, '$1: ' + REDACTED)
    // 任意 scheme 的 URL 口令：postgres://user:pass@host -> postgres://user:[redacted]@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/giu, '$1' + REDACTED + '$2')
    // 错误消息里内嵌的凭据赋值（password=… / api_key: …）；只匹配带值分隔符的形式，
    // 普通英文句子（如 "password authentication failed"）不会被误伤。
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|secret|password|passwd)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)}\]&]+)/giu,
      '$1$2' + REDACTED);
}

function redactString(value: string): string {
  return truncate(scrubSecretTokens(value), MAX_STRING_LENGTH);
}

/** 栈是多行文本，整串锚定规则匹配不到；这里按内嵌 token 保守清洗。 */
function redactStack(value: string): string {
  return truncate(scrubSecretTokens(value), MAX_STACK_LENGTH);
}

function readSafely(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function textOf(value: unknown, limit = MAX_SUPPRESS_KEY_PART): string {
  if (typeof value === 'string') return value.slice(0, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * `causeDepth` 单独计数：错误通常装在 `{ error }` 字段里，若沿用对象深度，
 * 第一层 cause 就会撞上 MAX_DEPTH，等于没有 cause 可看。对象深度仍由 `depth` 限制。
 */
function serializeError(error: Error, depth: number, seen: WeakSet<object>,
  causeDepth = 0): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const name = readSafely(() => error.name);
  const message = readSafely(() => error.message);
  record.name = typeof name === 'string' && name !== '' ? redactString(name) : 'Error';
  record.message = typeof message === 'string' ? redactString(message) : '[unreadable message]';
  const stack = readSafely(() => error.stack);
  if (typeof stack === 'string' && stack !== '') record.stack = redactStack(stack);
  const code = readSafely(() => (error as { code?: unknown }).code);
  if (typeof code === 'string' || typeof code === 'number') record.code = code;

  const cause = readSafely(() => (error as { cause?: unknown }).cause);
  if (cause !== undefined) {
    record.cause = causeDepth + 1 >= MAX_CAUSE_DEPTH
      ? '[cause-depth-limit]' : redactValue(cause, depth + 1, seen, causeDepth + 1);
  }
  const errors = readSafely(() => (error as { errors?: unknown }).errors);
  if (Array.isArray(errors)) {
    record.errors = causeDepth + 1 >= MAX_CAUSE_DEPTH
      ? '[cause-depth-limit]'
      : errors.slice(0, MAX_ARRAY_ITEMS)
        .map((inner) => redactValue(inner, depth + 1, seen, causeDepth + 1));
  }
  return record;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>,
  causeDepth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (value instanceof Error) return serializeError(value, depth, seen, causeDepth);
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS)
        .map((item) => redactValue(item, depth + 1, seen, causeDepth));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${String(value.length - MAX_ARRAY_ITEMS)} more items]`);
      }
      return items;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, inner] of entries.slice(0, MAX_OBJECT_KEYS)) {
      result[key] = SECRET_KEY.test(key) && inner !== null && inner !== undefined && inner !== ''
        ? REDACTED : redactValue(inner, depth + 1, seen, causeDepth);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      result._truncated_keys = entries.length - MAX_OBJECT_KEYS;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Deep-redact one arbitrary payload so it is safe to log. */
export function redactRecord(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, 0, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * Redact one raw log line read back from disk. The record-level helper caps strings at
 * {@link MAX_STRING_LENGTH}; diagnostics may need a longer single line (host stderr tails),
 * so callers can ask for a larger but still bounded limit.
 */
export function redactLogText(value: string, limit = MAX_STRING_LENGTH): string {
  const bounded = Math.min(Math.max(limit, 1), 16 * 1024);
  return truncate(scrubSecretTokens(value), bounded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface LogRotationLock {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    // EPERM 说明进程存在但当前用户无权发信号；同机 Relay 进程不会走到这里。
    return (caught as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 旧锁恢复只清理确实没人持有的锁：持锁进程仍存活时，年龄再大也不抢占。 */
function lockHolderIsGone(lockPath: string): boolean {
  try {
    const holder = Number(readFileSync(lockPath, 'utf8').trim());
    return !processAlive(holder);
  } catch {
    return true;
  }
}

export function acquireRotationLock(file: string): LogRotationLock | undefined {
  const lockPath = file + ROTATION_LOCK_SUFFIX;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        try {
          writeSync(fd, `${String(process.pid)}\n`);
        } catch {
          // pid 只是旧锁恢复的辅助证据，写不进去不影响持锁本身。
        }
        const stats = fstatSync(fd);
        return { fd, dev: Number(stats.dev), ino: Number(stats.ino) };
      } catch {
        try {
          closeSync(fd);
        } catch {
          // Already closed.
        }
        return undefined;
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= ROTATION_LOCK_STALE_MS) {
          return undefined;
        }
        if (!lockHolderIsGone(lockPath)) return undefined;
        unlinkSync(lockPath);
        continue;
      } catch {
        // Lock vanished between open and stat: retry once.
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * 只释放自己持有的锁。轮转期间锁文件可能已被旧锁恢复换掉；
 * 此时 unlink 会删掉另一个进程的锁，让两次轮转同时发生。
 */
export function releaseRotationLock(file: string, lock: LogRotationLock | undefined): void {
  if (lock === undefined) return;
  try {
    closeSync(lock.fd);
  } catch {
    // Already closed.
  }
  const lockPath = file + ROTATION_LOCK_SUFFIX;
  try {
    const current = statSync(lockPath);
    if (Number(current.dev) !== lock.dev || Number(current.ino) !== lock.ino) return;
    unlinkSync(lockPath);
  } catch {
    // Already released or replaced by another process.
  }
}

function rotateIfNeeded(current: RuntimeLogState, file: string): void {
  try {
    if (statSync(file).size < current.maxBytes) return;
  } catch {
    return;
  }
  const lock = acquireRotationLock(file);
  // 没拿到锁说明另一个进程正在轮转：当前进程继续追加旧文件，不并发改同一串文件名。
  if (lock === undefined) return;
  try {
    try {
      if (statSync(file).size < current.maxBytes) return;
    } catch {
      return;
    }
    if (current.retainFiles === 0) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone.
      }
      return;
    }
    try {
      unlinkSync(file + '.' + String(current.retainFiles));
    } catch {
      // No oldest file to drop.
    }
    for (let index = current.retainFiles - 1; index >= 1; index -= 1) {
      try {
        renameSync(file + '.' + String(index), file + '.' + String(index + 1));
      } catch {
        // Gap in the chain: keep going so a missing middle file cannot block rotation.
      }
    }
    try {
      renameSync(file, file + '.1');
    } catch {
      // A concurrent writer already rotated; appending to the fresh file is correct.
    }
  } finally {
    releaseRotationLock(file, lock);
  }
}

function safeStderr(line: string): void {
  try {
    process.stderr.write(line + NEWLINE);
  } catch {
    // 连 stderr 都不可写时已无安全通道，静默是唯一不破坏业务的选择。
  }
}

function reportWriteFailure(current: RuntimeLogState, file: string, caught: unknown,
  line: string): void {
  const now = Date.now();
  if (now - writeFailure.lastReportAt < WRITE_FAILURE_REPORT_INTERVAL_MS) {
    writeFailure.dropped += 1;
    return;
  }
  const dropped = writeFailure.dropped;
  writeFailure = { lastReportAt: now, dropped: 0 };
  // 原记录先落 stderr：桌面模式下 API/Worker 的 stderr 由宿主写入 worker-supervisor.log，
  // 因此这里不会丢记录，也不会污染 stdout 协议通道。
  safeStderr(line);
  const reason = caught instanceof Error ? caught.message : String(caught);
  safeStderr(JSON.stringify({
    ts: new Date().toISOString(), level: 'error', event: 'runtime_log_write_failed',
    namespace: 'runtime-log', process: current.processName, pid: current.pid,
    log_file: file, error_message: redactString(reason), dropped_records: dropped,
  }));
}

function emitLine(current: RuntimeLogState, line: string): void {
  const file = logFileOf(current);
  if (file !== undefined) {
    try {
      rotateIfNeeded(current, file);
      appendFileSync(file, line + NEWLINE, 'utf8');
      return;
    } catch (caught) {
      reportWriteFailure(current, file, caught, line);
      return;
    }
  }
  if (current.echoToStderr) safeStderr(line);
}

function errorKeyParts(fields: Record<string, unknown>): { name: string; code: string; message: string } {
  const error = fields.error;
  if (error instanceof Error) {
    return {
      name: textOf(readSafely(() => error.name)),
      code: textOf(readSafely(() => (error as { code?: unknown }).code)),
      message: textOf(readSafely(() => error.message)),
    };
  }
  const record = isRecord(error) ? error : {};
  return {
    name: textOf(fields.error_name) || textOf(record.name),
    code: textOf(fields.error_code) || textOf(record.code),
    message: textOf(fields.error_message) || textOf(record.message),
  };
}

/** 关联身份参与去重键：不同 request/run/task 的同文案错误不能合并成一条。 */
function dedupeKey(level: RuntimeLogLevel, namespace: string, event: string,
  fields: Record<string, unknown>): string {
  const parts = errorKeyParts(fields);
  const correlations = JSON.stringify(
    CORRELATION_FIELDS.map((field) => textOf(fields[field])),
  );
  return [level, namespace, event, parts.name, parts.code, parts.message, correlations].join('|');
}

function hasRequestId(fields: Record<string, unknown>): boolean {
  const value = fields.request_id;
  return (typeof value === 'string' && value.trim() !== '') ||
    (typeof value === 'number' && Number.isFinite(value));
}

/** 请求级错误是必须逐条保留的事实；后台重复诊断才走窗口抑制。 */
function checkSuppression(current: RuntimeLogState, key: string, now: number,
  entry: Omit<SuppressEntry, 'windowStart' | 'count'>): 'emit' | 'drop' {
  const existing = suppressState.get(key);
  if (existing !== undefined) {
    if (now - existing.windowStart < SUPPRESS_WINDOW_MS) {
      existing.count += 1;
      return existing.count <= SUPPRESS_AFTER ? 'emit' : 'drop';
    }
    // 定时器被业务阻塞错过窗口：新窗口开始前先把旧窗口的准确计数收尾。
    suppressState.delete(key);
    try {
      writeSuppressionSummary(current, existing, now);
    } catch {
      // 汇总失败只影响日志自身，不能冒泡到业务。
    }
  }
  if (suppressState.size >= SUPPRESS_MAP_LIMIT) {
    const oldest = suppressState.entries().next().value as [string, SuppressEntry] | undefined;
    if (oldest !== undefined) {
      suppressState.delete(oldest[0]);
      try {
        writeSuppressionSummary(current, oldest[1], now);
      } catch {
        // 容量驱逐前先收尾，仍然失败时只能放弃这一条汇总。
      }
    }
  }
  suppressState.set(key, { windowStart: now, count: 1, ...entry });
  installExitHook();
  scheduleSuppressionFlush(current);
  return 'emit';
}

/** 窗口结束时写出准确汇总；只统计真正被抑制的条数。 */
function writeSuppressionSummary(current: RuntimeLogState, entry: SuppressEntry, now: number): void {
  const suppressed = entry.count - SUPPRESS_AFTER;
  if (suppressed <= 0) return;
  const merged = { ...entry.bound, ...entry.fields };
  const parts = errorKeyParts(merged);
  const correlations: Record<string, unknown> = {};
  for (const field of CORRELATION_FIELDS) {
    const value = merged[field];
    if (value !== undefined && value !== '') correlations[field] = value;
  }
  writeRecord(current, entry.level, 'log_suppressed', { namespace: entry.namespace }, {
    suppressed_event: entry.event,
    total_count: entry.count,
    emitted_count: Math.min(entry.count, SUPPRESS_AFTER),
    suppressed_count: suppressed,
    window_ms: SUPPRESS_WINDOW_MS,
    window_started_at: new Date(entry.windowStart).toISOString(),
    window_ended_at: new Date(now).toISOString(),
    ...correlations,
    ...(parts.name === '' ? {} : { error_name: parts.name }),
    ...(parts.code === '' ? {} : { error_code: parts.code }),
    ...(parts.message === '' ? {} : { error_message: parts.message }),
  });
}

function flushSuppressions(current: RuntimeLogState, now: number, onlyExpired: boolean): void {
  for (const [key, entry] of [...suppressState.entries()]) {
    if (onlyExpired && now - entry.windowStart < SUPPRESS_WINDOW_MS) continue;
    suppressState.delete(key);
    try {
      writeSuppressionSummary(current, entry, now);
    } catch {
      // 日志自身异常不向业务传播。
    }
  }
}

function scheduleSuppressionFlush(current: RuntimeLogState): void {
  if (suppressTimer !== undefined) {
    clearTimeout(suppressTimer);
    suppressTimer = undefined;
  }
  if (suppressState.size === 0) return;
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of suppressState.values()) {
    earliest = Math.min(earliest, entry.windowStart + SUPPRESS_WINDOW_MS);
  }
  if (!Number.isFinite(earliest)) return;
  suppressTimer = setTimeout(() => {
    suppressTimer = undefined;
    try {
      flushSuppressions(state, Date.now(), true);
    } catch {
      // 同上：定时器里没有任何可冒泡的调用方。
    }
    scheduleSuppressionFlush(state);
  }, Math.max(1, earliest - Date.now()));
  suppressTimer.unref();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    try {
      flushSuppressions(state, Date.now(), false);
    } catch {
      // 退出阶段所有持久化通道都可能不可用，不能再抛错。
    }
  });
}

/** 立即写出尚未到期的抑制汇总；进程正常退出时也会自动执行。 */
export function flushRuntimeLogSuppressions(): void {
  try {
    flushSuppressions(state, Date.now(), false);
  } catch {
    // 日志自身异常不向业务传播。
  }
  scheduleSuppressionFlush(state);
}

function buildRecord(current: RuntimeLogState, level: RuntimeLogLevel, event: string,
  bound: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const ts = new Date().toISOString();
  const record: Record<string, unknown> = {
    ...redactRecord(bound),
    ...redactRecord(fields),
    ts,
    level,
    event,
    process: current.processName,
    pid: current.pid,
  };
  const error = record.error;
  if (isRecord(error)) {
    if (record.error_name === undefined && typeof error.name === 'string') record.error_name = error.name;
    if (record.error_message === undefined && typeof error.message === 'string') {
      record.error_message = error.message;
    }
    if (record.error_stack === undefined && typeof error.stack === 'string') record.error_stack = error.stack;
    if (record.error_code === undefined
      && (typeof error.code === 'string' || typeof error.code === 'number')) {
      record.error_code = error.code;
    }
  }
  return record;
}

function collapseRecord(current: RuntimeLogState, level: RuntimeLogLevel, event: string,
  record: Record<string, unknown>, originalBytes: number): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    ts: record.ts, level, event, namespace: record.namespace,
    process: current.processName, pid: current.pid,
    log_truncated: true, original_bytes: originalBytes,
  };
  for (const field of CORRELATION_FIELDS) {
    if (record[field] !== undefined) compact[field] = record[field];
  }
  for (const field of ['error_name', 'error_code', 'error_message'] as const) {
    if (record[field] !== undefined) {
      compact[field] = typeof record[field] === 'string'
        ? truncate(record[field] as string, 500) : record[field];
    }
  }
  return compact;
}

function writeRecord(current: RuntimeLogState, level: RuntimeLogLevel, event: string,
  bound: Record<string, unknown>, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[current.level]) return;

  let line: string;
  try {
    const record = buildRecord(current, level, event, bound, fields);
    line = JSON.stringify(record);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LOG_RECORD_BYTES) {
      line = JSON.stringify(collapseRecord(current, level, event, record, bytes));
    }
  } catch {
    // 序列化失败（循环引用之外的极端情况）：降级成最小记录，至少保留事件与错误名。
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(), level, event,
        namespace: textOf(bound.namespace), process: current.processName, pid: current.pid,
        log_serialization_failed: true,
      });
    } catch {
      return;
    }
  }
  emitLine(current, line);
}

function createLogger(namespace: string, bound: Record<string, unknown>): RuntimeLogger {
  const emit = (level: RuntimeLogLevel, event: string, fields?: Record<string, unknown>): void => {
    try {
      const current = state;
      if (LEVEL_ORDER[level] > LEVEL_ORDER[current.level]) return;
      const payload = fields ?? {};
      const merged = { ...bound, ...payload };
      // 请求级错误逐条保留：request_id 是用户报告问题后唯一的追查入口，不能被聚合吞掉。
      if ((level === 'warn' || level === 'error') && !hasRequestId(merged)) {
        const verdict = checkSuppression(current, dedupeKey(level, namespace, event, merged),
          Date.now(), { namespace, level, event, bound: { ...bound }, fields: { ...payload } });
        if (verdict === 'drop') return;
      }
      writeRecord(current, level, event, { namespace, ...bound }, payload);
    } catch (caught) {
      // 最后一道保险：日志内部任何未预期异常都不得冒泡到业务调用方。
      safeStderr(JSON.stringify({
        ts: new Date().toISOString(), level: 'error', event: 'runtime_log_emit_failed',
        namespace: 'runtime-log', process: state.processName, pid: process.pid,
        source_event: textOf(event), error_message: redactString(
          caught instanceof Error ? caught.message : String(caught)),
      }));
    }
  };
  return {
    namespace,
    get file() { return logFileOf(state); },
    fatal: (event, fields) => emit('fatal', event, fields),
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    trace: (event, fields) => emit('trace', event, fields),
    child: (extra) => createLogger(namespace, { ...bound, ...extra }),
    isEnabled: (level) => LEVEL_ORDER[level] <= LEVEL_ORDER[state.level],
  };
}

/** Process-wide logger. `namespace` only labels the record; it does not pick a file. */
export function getRuntimeLogger(namespace = 'api'): RuntimeLogger {
  return createLogger(namespace, {});
}

/** Absolute path of the current log file, for user-facing troubleshooting hints. */
export function runtimeLogFile(): string | undefined {
  return logFileOf(state);
}

/**
 * Backwards-compatible one-shot helper used by the earlier call sites.
 * Prefer `getRuntimeLogger()` for anything new.
 */
export function logRuntimeEvent(
  level: Exclude<RuntimeLogLevel, 'fatal'>,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    writeRecord(state, level, event, { namespace: 'api' }, fields);
  } catch {
    // Same contract as the logger methods: never throw into business code.
  }
}
