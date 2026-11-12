import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createBearerGuard } from '../../src/api/boundary.js';
import { registerDiagnosticsRoutes } from '../../src/api/diagnostics-api.js';
import { createServer } from '../../src/api/server.js';
import {
  allowedDiagnosticFile, exportDiagnosticLogs, isAllowedDiagnosticFile, readDiagnosticLogs,
  readDiagnosticRuntime,
} from '../../src/diagnostics/log-reader.js';

const TOKEN = 'b'.repeat(48);
const PREFIX = '/api/v1/workspaces/:workspace_id';
const BASE = `/api/v1/workspaces/ws-1/diagnostics`;
const authorized = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8799' };
const HOST_ONLY = { host: '127.0.0.1:8799' };

function buildApp(dataRoot: string, probeDatabase?: () => Promise<{
  database: 'up' | 'down'; schema: 'up' | 'down';
}>): FastifyInstance {
  const app = createServer({
    bindHost: '127.0.0.1', port: 8799, allowedOrigins: [],
    bearerToken: TOKEN, logLevel: 'fatal', dataRoot: '',
    databaseUrl: '', databasePoolMax: 1, databaseConnectTimeoutMs: 1000,
    stopOnStdinEof: false, maxConcurrentExecutions: 4, desktopMode: true,
  });
  void app.register(async (scope) => {
    scope.addHook('onRequest', createBearerGuard(TOKEN));
    registerDiagnosticsRoutes(scope, {
      dataRoot,
      ...(probeDatabase === undefined ? {} : { probeDatabase }),
    });
  }, { prefix: PREFIX });
  return app;
}

function jsonl(ts: string, level: string, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, level, event, namespace: 'test', ...extra });
}

interface Fixture { root: string; logs: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'relay-diag-'));
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'relay-api.log'), [
    jsonl('2026-11-12T10:00:00.000Z', 'info', 'api_request_started', {
      request_id: 'req-1', task_id: 'task-1',
    }),
    jsonl('2026-11-12T10:00:05.000Z', 'warn', 'model_call_retry_scheduled', {
      model_call_id: 'call-1',
    }),
    jsonl('2026-11-12T10:00:10.000Z', 'error', 'api_request_failed', {
      request_id: 'req-2', task_id: 'task-2',
      error: { message: 'upstream failed with Bearer secret-token-123', password: 'hunter2' },
    }),
    jsonl('2026-11-12T10:00:15.000Z', 'debug', 'api_request_completed', { request_id: 'req-3' }),
    '{"ts":"2026-11-12T10:00:20.000Z","level":"error","event":"truncated_json"',
  ].join('\n') + '\n');
  writeFileSync(join(logs, 'relay-api.log.1'), [
    jsonl('2026-11-12T09:00:00.000Z', 'info', 'api_started', { pid: 999999 }),
  ].join('\n') + '\n');
  writeFileSync(join(logs, 'relay-worker.log'), [
    jsonl('2026-11-12T09:59:00.000Z', 'info', 'worker_started', { pid: process.pid }),
    jsonl('2026-11-12T10:00:30.000Z', 'error', 'worker_job_failed', { run_id: 'run-1' }),
  ].join('\n') + '\n');
  writeFileSync(join(logs, 'relay-supervisor.log'), [
    jsonl('2026-11-12T09:58:00.000Z', 'info', 'supervisor_started', { pid: process.pid }),
    jsonl('2026-11-12T10:00:40.000Z', 'info', 'worker_exited'),
  ].join('\n') + '\n');
  writeFileSync(join(logs, 'desktop.log'), [
    '2026-11-12T10:01:00.000Z host: desktop ready',
    '2026-11-12T10:01:05.000Z error: webview failed token=abc123',
  ].join('\n') + '\n');
  writeFileSync(join(logs, 'worker-supervisor.log'), [
    '{"ts":"2026-11-12T10:02:00.000Z","level":"warn","event":"host_restart","pid":123',
    'host: plain line without level',
  ].join('\n') + '\n');
  writeFileSync(join(logs, 'mystery.log'), 'secret outside whitelist\n');
  return { root, logs };
}

function cleanup(f: Fixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

test('只读固定白名单文件，不列目录外或未授权文件', () => {
  const f = fixture();
  try {
    assert.equal(isAllowedDiagnosticFile('relay-api.log'), true);
    assert.equal(isAllowedDiagnosticFile('relay-api.log.1'), true);
    assert.equal(isAllowedDiagnosticFile('relay-api.log.99'), true);
    assert.equal(isAllowedDiagnosticFile('relay-api.log.100'), false);
    assert.equal(isAllowedDiagnosticFile('relay-api.log.0'), false);
    assert.equal(isAllowedDiagnosticFile('worker-supervisor.log.old.log'), true);
    assert.equal(isAllowedDiagnosticFile('mystery.log'), false);
    assert.equal(isAllowedDiagnosticFile('../logs/relay-api.log'), false);
    assert.equal(isAllowedDiagnosticFile('C:\\Windows\\relay-api.log'), false);
    assert.equal(allowedDiagnosticFile('relay-api.log.2')?.rotation, 2);

    const page = readDiagnosticLogs(f.root, { minLevel: 'trace' }, 100);
    const names = page.records.map((record) => record.file);
    assert.ok(names.includes('relay-api.log'));
    assert.ok(names.includes('relay-api.log.1'));
    assert.ok(names.includes('desktop.log'));
    assert.ok(!names.includes('mystery.log'));
    assert.ok(page.inventory.files.every((file) => file.name !== 'mystery.log'));
    const rotated = page.inventory.files.find((file) => file.name === 'relay-api.log.1');
    assert.equal(rotated?.rotation, 1);
  } finally {
    cleanup(f);
  }
});

test('按级别、进程、关键字、事件与关联 ID 过滤，并按时间倒序返回', () => {
  const f = fixture();
  try {
    const all = readDiagnosticLogs(f.root, { minLevel: 'trace' }, 100);
    const timestamps = all.records.flatMap((record) => record.ts === null ? [] : [record.ts]);
    assert.deepEqual([...timestamps].sort().reverse(), timestamps);

    const warning = readDiagnosticLogs(f.root, { minLevel: 'warn' }, 100);
    assert.ok(warning.records.every((record) => ['fatal', 'error', 'warn'].includes(record.level)));
    assert.ok(warning.records.some((record) => record.event === 'model_call_retry_scheduled'));

    const worker = readDiagnosticLogs(f.root, { minLevel: 'trace', processes: ['worker'] }, 100);
    assert.ok(worker.records.length > 0);
    assert.ok(worker.records.every((record) => record.process === 'worker'));

    const keyword = readDiagnosticLogs(f.root, { minLevel: 'trace', keyword: 'retry' }, 100);
    assert.equal(keyword.records.length, 1);
    assert.equal(keyword.records[0]?.event, 'model_call_retry_scheduled');

    const event = readDiagnosticLogs(f.root, { minLevel: 'trace', eventPattern: 'api_request_*' }, 100);
    assert.deepEqual(new Set(event.records.map((record) => record.event)),
      new Set(['api_request_started', 'api_request_failed', 'api_request_completed']));

    const correlation = readDiagnosticLogs(f.root, {
      minLevel: 'trace', correlation: { request_id: 'req-2' },
    }, 100);
    assert.equal(correlation.records.length, 1);
    assert.equal(correlation.records[0]?.event, 'api_request_failed');

    const anyId = readDiagnosticLogs(f.root, { minLevel: 'trace', anyId: 'run-1' }, 100);
    assert.equal(anyId.records.length, 1);
    assert.equal(anyId.records[0]?.process, 'worker');

    const timeRange = readDiagnosticLogs(f.root, {
      minLevel: 'trace', sinceMs: Date.parse('2026-11-12T10:00:05.000Z'),
      untilMs: Date.parse('2026-11-12T10:00:10.000Z'),
    }, 100);
    assert.deepEqual(timeRange.records.map((record) => record.ts), [
      '2026-11-12T10:00:10.000Z', '2026-11-12T10:00:05.000Z',
    ]);
  } finally {
    cleanup(f);
  }
});

test('不完整 JSONL 与混合纯文本保留为原始行，不丢失也不崩溃', () => {
  const f = fixture();
  try {
    const page = readDiagnosticLogs(f.root, { minLevel: 'trace' }, 100);
    const broken = page.records.find((record) => record.ts === '2026-11-12T10:00:20.000Z');
    assert.ok(broken !== undefined);
    assert.equal(broken.raw?.startsWith('{"ts":"2026-11-12T10:00:20.000Z"'), true);
    assert.equal(broken.event, null);

    const plain = page.records.filter((record) => record.file === 'desktop.log');
    assert.equal(plain.length, 2);
    assert.ok(plain.every((record) => typeof record.raw === 'string'));
    assert.ok(plain.some((record) => record.level === 'error'));

    const host = page.records.filter((record) => record.file === 'worker-supervisor.log');
    assert.equal(host.length, 2);
    assert.ok(host.some((record) => record.raw?.includes('plain line without level')));
  } finally {
    cleanup(f);
  }
});

test('游标分页无重复、无遗漏，最后一页 next_cursor 为空', () => {
  const f = fixture();
  try {
    const full = readDiagnosticLogs(f.root, { minLevel: 'trace' }, 100);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 20; round += 1) {
      const page = readDiagnosticLogs(f.root, { minLevel: 'trace' }, 2, cursor);
      seen.push(...page.records.map((record) => record.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    assert.equal(seen.length, full.records.length);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen, full.records.map((record) => record.id));
  } finally {
    cleanup(f);
  }
});

test('旧日志里的凭据在读取与导出时再次脱敏', () => {
  const f = fixture();
  try {
    const page = readDiagnosticLogs(f.root, { minLevel: 'trace' }, 100);
    const serialized = JSON.stringify(page);
    assert.ok(!serialized.includes('secret-token-123'));
    assert.ok(!serialized.includes('hunter2'));
    assert.ok(serialized.includes('[redacted]'));

    const exported = exportDiagnosticLogs(f.root, { minLevel: 'trace' }, 100);
    assert.ok(exported.text.startsWith('# Relay diagnostics export\n'));
    assert.ok(!exported.text.includes('secret-token-123'));
    assert.ok(!exported.text.includes('hunter2'));
    assert.ok(exported.count > 0);
  } finally {
    cleanup(f);
  }
});

test('超长行被截断并标记，扫描窗口上限如实上报', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-diag-big-'));
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  try {
    const huge = jsonl('2026-11-12T11:00:00.000Z', 'error', 'huge_line', { detail: 'x'.repeat(40_000) });
    writeFileSync(join(logs, 'relay-api.log'), huge + '\n');
    const page = readDiagnosticLogs(root, { minLevel: 'trace' }, 10);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0]?.truncated, true);
    // 行被截断后不再是合法 JSON，只能按原始行返回；原始行仍受 8 KiB 上限约束。
    const raw = page.records[0]?.raw ?? '';
    assert.ok(raw.length <= 8 * 1024 + '...[truncated]'.length);

    // 超过单文件 2 MiB 扫描窗口时，只读尾部并明确标记 truncated。
    const filler = jsonl('2026-11-12T11:00:01.000Z', 'info', 'filler', { pad: 'y'.repeat(200) });
    appendFileSync(join(logs, 'relay-api.log'), (filler + '\n').repeat(12_000));
    const capped = readDiagnosticLogs(root, { minLevel: 'trace' }, 10);
    assert.equal(capped.truncated, true);
    assert.ok(capped.scanned_bytes <= 2 * 1024 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('符号链接日志文件被拒绝；普通未授权文件不可读', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relay-diag-link-'));
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'top secret\n');
  try {
    try {
      symlinkSync(secret, join(logs, 'relay-api.log'));
    } catch {
      rmSync(root, { recursive: true, force: true });
      t.skip('当前 Windows 环境不允许创建符号链接，无法验证链接拒绝');
      return;
    }
    const page = readDiagnosticLogs(root, { minLevel: 'trace' }, 10);
    assert.ok(!page.records.some((record) => record.raw?.includes('top secret')));
    const linked = page.inventory.files.find((file) => file.name === 'relay-api.log');
    assert.equal(linked?.readable, false);
    assert.equal(linked?.error, '符号链接被拒绝');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('诊断路由要求 Bearer；坏参数在文件系统访问前被拒绝', async () => {
  const f = fixture();
  const app = buildApp(f.root);
  try {
    for (const url of [`${BASE}/logs`, `${BASE}/logs/export`, `${BASE}/runtime`]) {
      const anonymous = await app.inject({ method: 'GET', url, headers: HOST_ONLY });
      assert.equal(anonymous.statusCode, 401);
    }

    const page = await app.inject({ method: 'GET', url: `${BASE}/logs?min_level=trace`, headers: authorized });
    assert.equal(page.statusCode, 200);
    const body = page.json() as { records: Array<Record<string, unknown>> };
    assert.ok(body.records.length > 0);
    // 响应序列化后 record 仍保留任意已脱敏字段。
    assert.ok(body.records.some((record) =>
      (record.record as Record<string, unknown> | undefined)?.namespace === 'test'));

    for (const query of [
      'file=..%2Fsecret.log', 'file=mystery.log', 'file=C%3A%5CWindows%5Crelay-api.log',
      'process=evil', 'min_level=loud', 'since=not-a-time',
      'since=2026-11-12T11%3A00%3A00.000Z&until=2026-11-12T10%3A00%3A00.000Z',
      'cursor=not-base64', 'limit=0', 'limit=201', 'unknown=1',
    ]) {
      const response = await app.inject({ method: 'GET', url: `${BASE}/logs?${query}`, headers: authorized });
      assert.equal(response.statusCode, 422, query);
      assert.equal((response.json() as { code: string }).code, 'VALIDATION_FAILED', query);
    }

    const anonymousExport = await app.inject({
      method: 'GET', url: `${BASE}/logs/export`, headers: HOST_ONLY,
    });
    assert.equal(anonymousExport.statusCode, 401);
  } finally {
    await app.close();
    cleanup(f);
  }
});

test('导出走受控文本响应，带截断标记且不泄露凭据', async () => {
  const f = fixture();
  const app = buildApp(f.root);
  try {
    const response = await app.inject({
      method: 'GET', url: `${BASE}/logs/export?min_level=trace&limit=100`, headers: authorized,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/plain/u);
    assert.match(String(response.headers['content-disposition']), /attachment; filename="relay-diagnostics-/u);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(Number(response.headers['x-diagnostics-records']) > 0);
    assert.ok(!response.body.includes('secret-token-123'));
    assert.ok(!response.body.includes('hunter2'));
  } finally {
    await app.close();
    cleanup(f);
  }
});

test('运行状态如实区分在线、停止与未知，数据库探针失败不拖垮接口', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-diag-runtime-'));
  const logs = join(root, 'logs');
  mkdirSync(logs, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  const deadPid = dead.pid ?? 999999;
  try {
    writeFileSync(join(logs, 'relay-worker.log'), jsonl(
      '2026-11-12T09:59:00.000Z', 'info', 'worker_started', { pid: process.pid },
    ) + '\n');
    writeFileSync(join(logs, 'relay-supervisor.log'), jsonl(
      '2026-11-12T09:58:00.000Z', 'info', 'supervisor_started', { pid: deadPid },
    ) + '\n');

    const up = await readDiagnosticRuntime(root, {
      probeDatabase: async () => ({ database: 'up', schema: 'up' }),
    });
    assert.equal(up.api.status, 'up');
    assert.equal(up.api.pid, process.pid);
    assert.equal(up.database.status, 'up');
    assert.equal(up.worker.status, 'running');
    assert.equal(up.worker.pid, process.pid);

    const down = await readDiagnosticRuntime(root, {
      probeDatabase: async () => { throw new Error('connection refused password=hunter2'); },
    });
    assert.equal(down.database.status, 'down');
    assert.ok(!(down.database.detail ?? '').includes('hunter2'));
    assert.ok((down.database.detail ?? '').includes('[redacted]'));

    const unknown = await readDiagnosticRuntime(root);
    assert.equal(unknown.database.status, 'unknown');
    assert.equal(unknown.log_directory.exists, true);
    assert.equal(unknown.log_directory.file_count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const empty = mkdtempSync(join(tmpdir(), 'relay-diag-empty-'));
  try {
    const status = await readDiagnosticRuntime(empty);
    assert.equal(status.log_directory.exists, false);
    assert.equal(status.worker.status, 'unknown');
    assert.equal(status.worker.derived_from, null);
    assert.equal(status.last_error, null);
    assert.match(status.worker.detail, /没有可核实/u);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('运行状态接口在数据库不可用时仍返回 unknown 而不是 5xx', async () => {
  const f = fixture();
  const app = buildApp(f.root, async () => ({ database: 'down', schema: 'down' }));
  try {
    const response = await app.inject({ method: 'GET', url: `${BASE}/runtime`, headers: authorized });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { database: { status: string }, worker: { status: string } };
    assert.equal(body.database.status, 'down');
    assert.equal(body.worker.status, 'running');
  } finally {
    await app.close();
    cleanup(f);
  }
});
