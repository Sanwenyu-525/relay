import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
 * - Never writes to stdout: in desktop mode stdout is the host JSON event channel.
 * - Deep-redacts secret-looking field names and Bearer / sk- style values.
 * - Size-based rotation with a bounded retention window.
 * - Silently does nothing until `configureRuntimeLog` runs, so unit tests never touch disk.
 */
export type RuntimeLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<RuntimeLogLevel, number> = {
  fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
};

export const DEFAULT_LOG_FILE_NAME = 'relay-api.log';
export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOG_RETAIN_FILES = 5;

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 2000;
/** 栈比普通字段长：保留完整调用链才有定位价值，仍设上限防止日志失控。 */
const MAX_STACK_LENGTH = 4000;
const REDACTED = '[redacted]';

const SECRET_KEY = new RegExp(
  'api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token'
  + '|bearer|secret|password|passwd|credential|cookie|private[_-]?key|set-cookie',
  'i',
);

export interface RuntimeLogConfig {
  // `| undefined` is explicit because the API tsconfig enables exactOptionalPropertyTypes.
  readonly directory?: string | undefined;
  readonly fileName?: string | undefined;
  readonly level?: RuntimeLogLevel | undefined;
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
  readonly echoToStderr: boolean;
  readonly maxBytes: number;
  readonly retainFiles: number;
}

const DISABLED: RuntimeLogState = {
  fileName: DEFAULT_LOG_FILE_NAME,
  level: 'info',
  echoToStderr: false,
  maxBytes: DEFAULT_LOG_MAX_BYTES,
  retainFiles: DEFAULT_LOG_RETAIN_FILES,
};

let state: RuntimeLogState = DISABLED;

function logFileOf(current: RuntimeLogState): string | undefined {
  return current.directory === undefined ? undefined : join(current.directory, current.fileName);
}

/** Idempotent. A failed directory creation degrades to stderr instead of throwing. */
export function configureRuntimeLog(config: RuntimeLogConfig = {}): void {
  const level = config.level ?? state.level;
  const echoToStderr = config.echoToStderr ?? state.echoToStderr;
  const fileName = config.fileName ?? state.fileName;
  const maxBytes = config.maxBytes !== undefined && config.maxBytes > 0
    ? config.maxBytes : DEFAULT_LOG_MAX_BYTES;
  const retainFiles = config.retainFiles !== undefined && config.retainFiles >= 0
    ? config.retainFiles : DEFAULT_LOG_RETAIN_FILES;

  if (config.directory === undefined || config.directory === '') {
    state = { fileName, level, echoToStderr, maxBytes, retainFiles };
    return;
  }
  try {
    mkdirSync(config.directory, { recursive: true });
    state = { directory: config.directory, fileName, level, echoToStderr, maxBytes, retainFiles };
  } catch {
    state = { fileName, level, echoToStderr, maxBytes, retainFiles };
  }
}

/** Test seam: drop any configured directory and level back to the disabled state. */
export function resetRuntimeLog(): void {
  state = DISABLED;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + '...[truncated]' : value;
}

/** 错误消息、栈和普通字符串都可能内嵌凭据；按 token 替换，而不是只看整串。 */
function scrubSecretTokens(value: string): string {
  return value
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, REDACTED);
}

function redactString(value: string): string {
  return truncate(scrubSecretTokens(value), MAX_STRING_LENGTH);
}

/** 栈是多行文本，整串锚定规则匹配不到；这里按内嵌 token 保守清洗。 */
function redactStack(value: string): string {
  return truncate(scrubSecretTokens(value), MAX_STACK_LENGTH);
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message),
      ...(typeof value.stack === 'string' ? { stack: redactStack(value.stack) } : {}) };
  }
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY.test(key) && inner !== null && inner !== undefined && inner !== ''
        ? REDACTED : redactValue(inner, depth + 1);
    }
    return result;
  }
  return String(value);
}

/** Deep-redact one arbitrary payload so it is safe to log. */
export function redactRecord(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, 0) as Record<string, unknown>;
}

function rotateIfNeeded(current: RuntimeLogState, file: string): void {
  try {
    if (statSync(file).size < current.maxBytes) return;
  } catch {
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
}

function writeRecord(current: RuntimeLogState, level: RuntimeLogLevel, event: string,
  bound: Record<string, unknown>, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[current.level]) return;

  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(), level, event, ...redactRecord(bound), ...redactRecord(fields),
    });
  } catch {
    return;
  }
  const newline = String.fromCharCode(10);
  const file = logFileOf(current);
  if (file !== undefined) {
    try {
      rotateIfNeeded(current, file);
      appendFileSync(file, line + newline, 'utf8');
      return;
    } catch {
      // Fall through to stderr so the record is not silently lost.
    }
  }
  if (current.echoToStderr) process.stderr.write(line + newline);
}

function createLogger(namespace: string, bound: Record<string, unknown>): RuntimeLogger {
  const emit = (level: RuntimeLogLevel, event: string, fields?: Record<string, unknown>): void => {
    writeRecord(state, level, event, { namespace, ...bound }, fields ?? {});
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
  writeRecord(state, level, event, { namespace: 'api' }, fields);
}