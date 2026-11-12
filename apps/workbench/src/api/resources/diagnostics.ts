import { RelayContractError } from "../core/errors";
import { RelayHttp } from "../core/http";
import {
  boolean, integer, isRecord, nullableInteger, nullableString, object, optionalString, string,
} from "../core/primitives";

/** 开发者诊断：只读受管日志与运行状态。响应由 API 二次脱敏，UI 不再拼装敏感字段。 */

export type RelayDiagnosticLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export const RELAY_DIAGNOSTIC_LEVELS: readonly RelayDiagnosticLogLevel[] = [
  "fatal", "error", "warn", "info", "debug", "trace",
];

export interface RelayDiagnosticFileInfo {
  readonly name: string;
  readonly process: string;
  readonly label: string;
  readonly rotation: number;
  readonly exists: boolean;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
  readonly readable: boolean;
  readonly error: string | null;
}

export interface RelayDiagnosticInventory {
  readonly directory: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly error: string | null;
  readonly files: readonly RelayDiagnosticFileInfo[];
}

export interface RelayDiagnosticLogEntry {
  readonly id: string;
  readonly file: string;
  readonly process: string;
  readonly offset: number;
  readonly ts: string | null;
  readonly level: RelayDiagnosticLogLevel;
  readonly event: string | null;
  readonly raw: string | null;
  readonly truncated: boolean;
  readonly record: Readonly<Record<string, unknown>> | null;
}

export interface RelayDiagnosticsQuery {
  readonly file?: string | undefined;
  readonly minLevel?: RelayDiagnosticLogLevel | undefined;
  readonly processes?: readonly string[] | undefined;
  readonly keyword?: string | undefined;
  readonly eventPattern?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly anyId?: string | undefined;
  readonly correlation?: Readonly<Record<string, string>> | undefined;
}

export interface RelayDiagnosticsLogPage {
  readonly records: readonly RelayDiagnosticLogEntry[];
  readonly nextCursor: string | null;
  readonly matchedCount: number;
  readonly scannedBytes: number;
  readonly truncated: boolean;
  readonly inventory: RelayDiagnosticInventory;
}

export type RelayDiagnosticProcessStatusKind = "running" | "stopped" | "failed" | "unknown";

export interface RelayDiagnosticProcessStatus {
  readonly status: RelayDiagnosticProcessStatusKind;
  readonly detail: string;
  readonly pid: number | null;
  readonly derivedFrom: "log+pid" | "log" | null;
  readonly lastEvent: {
    readonly event: string | null;
    readonly ts: string | null;
    readonly level: string;
    readonly file: string;
    readonly offset: number;
  } | null;
}

export interface RelayDiagnosticsRuntimeStatus {
  readonly generatedAt: string;
  readonly api: {
    readonly status: "up";
    readonly pid: number;
    readonly uptimeSeconds: number;
    readonly node: string;
    readonly startedAt: string;
    readonly logFile: string | null;
  };
  readonly database: {
    readonly status: "up" | "down" | "unknown";
    readonly schema: "up" | "down" | "unknown";
    readonly detail: string | null;
  };
  readonly worker: RelayDiagnosticProcessStatus;
  readonly supervisor: RelayDiagnosticProcessStatus;
  readonly logDirectory: {
    readonly path: string;
    readonly exists: boolean;
    readonly writable: boolean | null;
    readonly fileCount: number;
  };
  readonly lastError: {
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

const CORRELATION_FIELDS = [
  "request_id", "command_id", "session_id", "message_id", "model_call_id",
  "project_id", "task_id", "run_id", "operation_id", "invocation_id", "worker_id",
] as const;

function level(value: unknown, name: string): RelayDiagnosticLogLevel {
  if (typeof value !== "string" || !(RELAY_DIAGNOSTIC_LEVELS as readonly string[]).includes(value)) {
    throw new RelayContractError(`${name} 响应格式无效。`);
  }
  return value as RelayDiagnosticLogLevel;
}

function fileInfo(value: unknown, name: string): RelayDiagnosticFileInfo {
  const row = object(value, name);
  return {
    name: string(row, "name", name),
    process: string(row, "process", name),
    label: string(row, "label", name),
    rotation: integer(row, "rotation", name),
    exists: boolean(row, "exists", name),
    sizeBytes: nullableInteger(row, "size_bytes", name),
    modifiedAt: nullableString(row, "modified_at", name),
    readable: boolean(row, "readable", name),
    error: nullableString(row, "error", name),
  };
}

function inventory(value: unknown, name: string): RelayDiagnosticInventory {
  const row = object(value, name);
  if (!Array.isArray(row.files)) throw new RelayContractError(`${name}.files 响应格式无效。`);
  return {
    directory: string(row, "directory", name),
    exists: boolean(row, "exists", name),
    readable: boolean(row, "readable", name),
    error: nullableString(row, "error", name),
    files: row.files.map((entry, index) => fileInfo(entry, `${name}.files[${String(index)}]`)),
  };
}

function logEntry(value: unknown, name: string): RelayDiagnosticLogEntry {
  const row = object(value, name);
  const record = row.record;
  if (record !== undefined && record !== null && !isRecord(record)) {
    throw new RelayContractError(`${name}.record 响应格式无效。`);
  }
  return {
    id: string(row, "id", name),
    file: string(row, "file", name),
    process: string(row, "process", name),
    offset: integer(row, "offset", name),
    ts: nullableString(row, "ts", name),
    level: level(row.level, name),
    event: nullableString(row, "event", name),
    raw: optionalString(row, "raw"),
    truncated: row.truncated === true,
    record: record ?? null,
  };
}

function processStatus(value: unknown, name: string): RelayDiagnosticProcessStatus {
  const row = object(value, name);
  const status = string(row, "status", name);
  if (status !== "running" && status !== "stopped" && status !== "failed" && status !== "unknown") {
    throw new RelayContractError(`${name}.status 响应格式无效。`);
  }
  const derived = nullableString(row, "derived_from", name);
  if (derived !== null && derived !== "log+pid" && derived !== "log") {
    throw new RelayContractError(`${name}.derived_from 响应格式无效。`);
  }
  let lastEvent: RelayDiagnosticProcessStatus["lastEvent"] = null;
  if (row.last_event !== null && row.last_event !== undefined) {
    const event = object(row.last_event, `${name}.last_event`);
    lastEvent = {
      event: nullableString(event, "event", name),
      ts: nullableString(event, "ts", name),
      level: string(event, "level", name),
      file: string(event, "file", name),
      offset: integer(event, "offset", name),
    };
  }
  return {
    status, detail: string(row, "detail", name),
    pid: nullableInteger(row, "pid", name),
    derivedFrom: derived,
    lastEvent,
  };
}

export async function getDiagnosticsLogs(http: RelayHttp,
  query: RelayDiagnosticsQuery, limit: number, cursor?: string): Promise<RelayDiagnosticsLogPage> {
  const body = await http.request(http.workspacePath(
    `/diagnostics/logs?${queryString(query, limit, cursor)}`));
  const row = object(body, "diagnostics.logs");
  if (!Array.isArray(row.records)) throw new RelayContractError("diagnostics.logs.records 响应格式无效。");
  return {
    records: row.records.map((entry, index) => logEntry(entry,
      `diagnostics.logs.records[${String(index)}]`)),
    nextCursor: nullableString(row, "next_cursor", "diagnostics.logs"),
    matchedCount: integer(row, "matched_count", "diagnostics.logs"),
    scannedBytes: integer(row, "scanned_bytes", "diagnostics.logs"),
    truncated: boolean(row, "truncated", "diagnostics.logs"),
    inventory: inventory(row.inventory, "diagnostics.logs.inventory"),
  };
}

export async function exportDiagnosticsLogs(http: RelayHttp,
  query: RelayDiagnosticsQuery, limit: number): Promise<string> {
  return http.requestText(http.workspacePath(
    `/diagnostics/logs/export?${queryString(query, limit)}`));
}

export async function getDiagnosticsRuntime(http: RelayHttp): Promise<RelayDiagnosticsRuntimeStatus> {
  const body = await http.request(http.workspacePath("/diagnostics/runtime"));
  const row = object(body, "diagnostics.runtime");
  const api = object(row.api, "diagnostics.runtime.api");
  const database = object(row.database, "diagnostics.runtime.database");
  const logDirectory = object(row.log_directory, "diagnostics.runtime.log_directory");
  const databaseStatus = databaseStatusOf(database.status, "diagnostics.runtime.database.status");
  const schemaStatus = databaseStatusOf(database.schema, "diagnostics.runtime.database.schema");
  let lastError: RelayDiagnosticsRuntimeStatus["lastError"] = null;
  if (row.last_error !== null && row.last_error !== undefined) {
    const error = object(row.last_error, "diagnostics.runtime.last_error");
    lastError = {
      id: string(error, "id", "diagnostics.runtime.last_error"),
      ts: nullableString(error, "ts", "diagnostics.runtime.last_error"),
      level: string(error, "level", "diagnostics.runtime.last_error"),
      process: string(error, "process", "diagnostics.runtime.last_error"),
      event: nullableString(error, "event", "diagnostics.runtime.last_error"),
      message: nullableString(error, "message", "diagnostics.runtime.last_error"),
      file: string(error, "file", "diagnostics.runtime.last_error"),
      offset: integer(error, "offset", "diagnostics.runtime.last_error"),
    };
  }
  const writable = logDirectory.writable;
  if (writable !== null && typeof writable !== "boolean") {
    throw new RelayContractError("diagnostics.runtime.log_directory.writable 响应格式无效。");
  }
  return {
    generatedAt: string(row, "generated_at", "diagnostics.runtime"),
    api: {
      status: "up",
      pid: integer(api, "pid", "diagnostics.runtime.api"),
      uptimeSeconds: integer(api, "uptime_seconds", "diagnostics.runtime.api"),
      node: string(api, "node", "diagnostics.runtime.api"),
      startedAt: string(api, "started_at", "diagnostics.runtime.api"),
      logFile: nullableString(api, "log_file", "diagnostics.runtime.api"),
    },
    database: {
      status: databaseStatus,
      schema: schemaStatus,
      detail: nullableString(database, "detail", "diagnostics.runtime.database"),
    },
    worker: processStatus(row.worker, "diagnostics.runtime.worker"),
    supervisor: processStatus(row.supervisor, "diagnostics.runtime.supervisor"),
    logDirectory: {
      path: string(logDirectory, "path", "diagnostics.runtime.log_directory"),
      exists: boolean(logDirectory, "exists", "diagnostics.runtime.log_directory"),
      writable,
      fileCount: integer(logDirectory, "file_count", "diagnostics.runtime.log_directory"),
    },
    lastError,
  };
}

function databaseStatusOf(value: unknown, name: string): "up" | "down" | "unknown" {
  if (value !== "up" && value !== "down" && value !== "unknown") {
    throw new RelayContractError(`${name} 响应格式无效。`);
  }
  return value;
}

function queryString(query: RelayDiagnosticsQuery, limit: number, cursor?: string): string {
  const params = new URLSearchParams();
  if (query.file !== undefined && query.file !== "") params.set("file", query.file);
  if (query.minLevel !== undefined) params.set("min_level", query.minLevel);
  if (query.processes !== undefined && query.processes.length > 0) {
    params.set("process", query.processes.join(","));
  }
  if (query.keyword !== undefined && query.keyword.trim() !== "") {
    params.set("keyword", query.keyword.trim());
  }
  if (query.eventPattern !== undefined && query.eventPattern.trim() !== "") {
    params.set("event", query.eventPattern.trim());
  }
  if (query.since !== undefined && query.since !== "") params.set("since", query.since);
  if (query.until !== undefined && query.until !== "") params.set("until", query.until);
  if (query.anyId !== undefined && query.anyId.trim() !== "") {
    params.set("any_id", query.anyId.trim());
  }
  for (const field of CORRELATION_FIELDS) {
    const value = query.correlation?.[field];
    if (value !== undefined && value.trim() !== "") params.set(field, value.trim());
  }
  params.set("limit", String(limit));
  if (cursor !== undefined && cursor !== "") params.set("cursor", cursor);
  return params.toString();
}
