import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { DiagnosticDatabaseProbe, DiagnosticLogQuery } from '../diagnostics/log-reader.js';
import {
  DiagnosticQueryError, exportDiagnosticLogs, isAllowedDiagnosticFile,
  isAllowedDiagnosticProcess, readDiagnosticLogs, readDiagnosticRuntime,
} from '../diagnostics/log-reader.js';
import { RUNTIME_LOG_LEVELS, type RuntimeLogLevel } from '../infrastructure/runtime-log.js';
import { sendProblem } from './envelope.js';
import { ProblemError, validationFailed } from './problem.js';

/**
 * 开发者诊断的只读入口（工作台「设置 → 开发者诊断」）。
 *
 * 边界：
 * - 与其余业务路由同处 Bearer 作用域；日志是进程级的，不按 workspace 过滤，
 *   workspace 段只为复用统一前缀与来源校验。
 * - 文件只能取固定白名单名（读取器内二次校验）；这里再校验一次，保证坏参数
 *   在进入文件系统前就得到 400，而不是悄悄返回空列表。
 * - 不写日志、不触发业务动作；读取失败以 Problem Details 返回，不会反向影响业务进程。
 */

const strict = { additionalProperties: false } as const;

const LOG_LEVELS = RUNTIME_LOG_LEVELS.map((level) => Type.Literal(level));

const CORRELATION_FIELDS = [
  'request_id', 'command_id', 'session_id', 'message_id', 'model_call_id',
  'project_id', 'task_id', 'run_id', 'operation_id', 'invocation_id', 'worker_id',
] as const;

const correlationProperties = Object.fromEntries(CORRELATION_FIELDS.map((field) => [
  field, Type.Optional(Type.String({ maxLength: 128 })),
])) as Record<string, TSchema>;

const querySchema = Type.Object({
  file: Type.Optional(Type.String({ maxLength: 128 })),
  min_level: Type.Optional(Type.String({ maxLength: 8 })),
  process: Type.Optional(Type.String({ maxLength: 400, description: '逗号分隔的进程名' })),
  keyword: Type.Optional(Type.String({ maxLength: 200 })),
  event: Type.Optional(Type.String({ maxLength: 200 })),
  since: Type.Optional(Type.String({ maxLength: 40 })),
  until: Type.Optional(Type.String({ maxLength: 40 })),
  any_id: Type.Optional(Type.String({ maxLength: 128 })),
  ...correlationProperties,
  limit: Type.Optional(Type.String({ maxLength: 4 })),
  cursor: Type.Optional(Type.String({ maxLength: 400 })),
}, strict);

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Integer(), Type.Null()]);

const fileInfoSchema = Type.Object({
  name: Type.String(),
  process: Type.String(),
  label: Type.String(),
  rotation: Type.Integer(),
  exists: Type.Boolean(),
  size_bytes: nullableNumber,
  modified_at: nullableString,
  readable: Type.Boolean(),
  error: nullableString,
}, strict);

const inventorySchema = Type.Object({
  directory: Type.String(),
  exists: Type.Boolean(),
  readable: Type.Boolean(),
  error: nullableString,
  files: Type.Array(fileInfoSchema),
}, strict);

const recordSchema = Type.Object({}, { additionalProperties: true });

const entrySchema = Type.Object({
  id: Type.String(),
  file: Type.String(),
  process: Type.String(),
  offset: Type.Integer(),
  ts: nullableString,
  level: Type.Union(LOG_LEVELS),
  event: nullableString,
  raw: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
  record: Type.Optional(recordSchema),
}, strict);

const pageSchema = Type.Object({
  records: Type.Array(entrySchema),
  next_cursor: nullableString,
  matched_count: Type.Integer(),
  scanned_bytes: Type.Integer(),
  truncated: Type.Boolean(),
  inventory: inventorySchema,
}, strict);

const processStatusSchema = Type.Object({
  status: Type.Union([
    Type.Literal('running'), Type.Literal('stopped'), Type.Literal('failed'), Type.Literal('unknown'),
  ]),
  detail: Type.String(),
  pid: nullableNumber,
  derived_from: Type.Union([Type.Literal('log+pid'), Type.Literal('log'), Type.Null()]),
  last_event: Type.Union([Type.Null(), Type.Object({
    event: nullableString,
    ts: nullableString,
    level: Type.String(),
    file: Type.String(),
    offset: Type.Integer(),
  }, strict)]),
}, strict);

const runtimeSchema = Type.Object({
  generated_at: Type.String(),
  api: Type.Object({
    status: Type.Literal('up'),
    pid: Type.Integer(),
    uptime_seconds: Type.Integer(),
    node: Type.String(),
    started_at: Type.String(),
    log_file: nullableString,
  }, strict),
  database: Type.Object({
    status: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('unknown')]),
    schema: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('unknown')]),
    detail: nullableString,
  }, strict),
  worker: processStatusSchema,
  supervisor: processStatusSchema,
  log_directory: Type.Object({
    path: Type.String(),
    exists: Type.Boolean(),
    writable: Type.Union([Type.Boolean(), Type.Null()]),
    file_count: Type.Integer(),
  }, strict),
  last_error: Type.Union([Type.Null(), Type.Object({
    id: Type.String(),
    ts: nullableString,
    level: Type.String(),
    process: Type.String(),
    event: nullableString,
    message: nullableString,
    file: Type.String(),
    offset: Type.Integer(),
  }, strict)]),
}, strict);

export interface DiagnosticsRouteDependencies {
  readonly dataRoot: string;
  readonly probeDatabase?: (() => Promise<DiagnosticDatabaseProbe>) | undefined;
}

interface RawQuery {
  readonly file?: string;
  readonly min_level?: string;
  readonly process?: string;
  readonly keyword?: string;
  readonly event?: string;
  readonly since?: string;
  readonly until?: string;
  readonly any_id?: string;
  readonly limit?: string;
  readonly cursor?: string;
  readonly [key: string]: string | undefined;
}

function clean(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function levelOf(value: string | undefined): RuntimeLogLevel {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === undefined) return 'info';
  if ((RUNTIME_LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as RuntimeLogLevel;
  }
  throw new ProblemError(validationFailed([
    { field: 'min_level', message: `必须是 ${RUNTIME_LOG_LEVELS.join(' / ')} 之一` },
  ]));
}

function timeOf(value: string | undefined, field: 'since' | 'until'): number | undefined {
  const text = clean(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new ProblemError(validationFailed([{ field, message: '必须是可解析的 ISO-8601 时间' }]));
  }
  return parsed;
}

function limitOf(value: string | undefined, fallback: number, max: number): number {
  const text = clean(value);
  if (text === undefined) return fallback;
  if (!/^\d+$/u.test(text)) {
    throw new ProblemError(validationFailed([{ field: 'limit', message: '必须是正整数' }]));
  }
  const parsed = Number(text);
  if (parsed < 1 || parsed > max) {
    throw new ProblemError(validationFailed([
      { field: 'limit', message: `必须在 1 到 ${String(max)} 之间` },
    ]));
  }
  return parsed;
}

function queryOf(raw: RawQuery): DiagnosticLogQuery {
  const file = clean(raw.file);
  if (file !== undefined && !isAllowedDiagnosticFile(file)) {
    throw new ProblemError(validationFailed([
      { field: 'file', message: '必须是受管的日志文件名，不能包含路径' },
    ]));
  }
  const processes = clean(raw.process)?.split(',').map((value) => value.trim()).filter(Boolean);
  if (processes !== undefined) {
    const invalid = processes.find((value) => !isAllowedDiagnosticProcess(value));
    if (invalid !== undefined) {
      throw new ProblemError(validationFailed([
        { field: 'process', message: `未知的日志进程：${invalid}` },
      ]));
    }
  }
  const sinceMs = timeOf(raw.since, 'since');
  const untilMs = timeOf(raw.until, 'until');
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new ProblemError(validationFailed([
      { field: 'since', message: '起始时间不能晚于结束时间' },
    ]));
  }
  const correlation: Record<string, string> = {};
  for (const field of CORRELATION_FIELDS) {
    const value = clean(raw[field]);
    if (value !== undefined) correlation[field] = value;
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(clean(raw.min_level) === undefined ? {} : { minLevel: levelOf(raw.min_level) }),
    ...(processes === undefined ? {} : { processes }),
    ...(clean(raw.keyword) === undefined ? {} : { keyword: clean(raw.keyword) }),
    ...(clean(raw.event) === undefined ? {} : { eventPattern: clean(raw.event) }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    ...(Object.keys(correlation).length === 0 ? {} : { correlation }),
    ...(clean(raw.any_id) === undefined ? {} : { anyId: clean(raw.any_id) }),
  };
}

function sendQueryError(reply: FastifyReply,
  error: DiagnosticQueryError, requestId: string): void {
  void sendProblem(reply, validationFailed([{ field: error.field, message: error.message }]),
    requestId);
}

export function registerDiagnosticsRoutes(app: FastifyInstance,
  dependencies: DiagnosticsRouteDependencies): void {
  const runtimeDependencies = {
    ...(dependencies.probeDatabase === undefined ? {} : { probeDatabase: dependencies.probeDatabase }),
  };

  app.get('/diagnostics/logs', {
    schema: { querystring: querySchema, response: { 200: pageSchema } },
  }, async (request, reply) => {
    const query = queryOf(request.query as RawQuery);
    const limit = limitOf((request.query as RawQuery).limit, 100, 200);
    const cursor = clean((request.query as RawQuery).cursor);
    try {
      const page = readDiagnosticLogs(dependencies.dataRoot, query, limit, cursor);
      return reply.header('Cache-Control', 'no-store').send(page);
    } catch (error) {
      if (error instanceof DiagnosticQueryError) {
        sendQueryError(reply, error, request.id);
        return reply;
      }
      throw error;
    }
  });

  app.get('/diagnostics/logs/export', {
    schema: { querystring: querySchema },
  }, async (request, reply) => {
    const query = queryOf(request.query as RawQuery);
    const limit = limitOf((request.query as RawQuery).limit, 1000, 1000);
    try {
      const exported = exportDiagnosticLogs(dependencies.dataRoot, query, limit);
      const stamp = exportedStamp();
      return reply
        .header('Cache-Control', 'no-store')
        .header('X-Diagnostics-Truncated', String(exported.truncated))
        .header('X-Diagnostics-Records', String(exported.count))
        .type('text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="relay-diagnostics-${stamp}.log"`)
        .send(exported.text);
    } catch (error) {
      if (error instanceof DiagnosticQueryError) {
        sendQueryError(reply, error, request.id);
        return reply;
      }
      throw error;
    }
  });

  app.get('/diagnostics/runtime', {
    schema: { response: { 200: runtimeSchema } },
  }, async (_request, reply) => {
    const status = await readDiagnosticRuntime(dependencies.dataRoot, runtimeDependencies);
    return reply.header('Cache-Control', 'no-store').send(status);
  });
}

function exportedStamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '');
}
