import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createBearerGuard } from '../../src/api/boundary.js';
import {
  registerClientDiagnosticsRoutes, resetClientDiagnosticsRateLimitForTest,
} from '../../src/api/client-diagnostics-api.js';
import { createServer } from '../../src/api/server.js';
import { configureRuntimeLog, resetRuntimeLog } from '../../src/infrastructure/runtime-log.js';

const TOKEN = 'a'.repeat(48);
const PREFIX = '/api/v1/workspaces/:workspace_id';
const URL_PATH = `/api/v1/workspaces/ws-1/client-diagnostics`;

function buildApp(): FastifyInstance {
  const app = createServer({
    bindHost: '127.0.0.1', port: 8799, allowedOrigins: [],
    bearerToken: TOKEN, logLevel: 'fatal', dataRoot: '',
    databaseUrl: '', databasePoolMax: 1, databaseConnectTimeoutMs: 1000,
    stopOnStdinEof: false, maxConcurrentExecutions: 4, desktopMode: true,
  });
  void app.register(async (scope) => {
    scope.addHook('onRequest', createBearerGuard(TOKEN));
    registerClientDiagnosticsRoutes(scope);
  }, { prefix: PREFIX });
  return app;
}

function readRecords(directory: string): Array<Record<string, unknown>> {
  return readFileSync(join(directory, 'api.log'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const authorized = { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:8799' };

test('诊断端点位于 Bearer 作用域内，匿名写入被拒绝且不落盘', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-client-diag-auth-'));
  configureRuntimeLog({ directory, fileName: 'api.log', level: 'debug', processName: 'api' });
  const app = buildApp();
  try {
    const response = await app.inject({
      method: 'POST', url: URL_PATH, headers: { host: '127.0.0.1:8799' },
      payload: { kind: 'uncaught', message: 'boom' },
    });
    assert.equal(response.statusCode, 401);
    assert.throws(() => readRecords(directory), { code: 'ENOENT' });
  } finally {
    await app.close();
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('受信诊断写入固定字段记录，保留错误栈但不接受额外字段', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-client-diag-'));
  configureRuntimeLog({ directory, fileName: 'api.log', level: 'debug', processName: 'api' });
  resetClientDiagnosticsRateLimitForTest();
  const app = buildApp();
  try {
    const accepted = await app.inject({
      method: 'POST', url: URL_PATH, headers: authorized,
      payload: {
        kind: 'render', name: 'TypeError', message: 'x is undefined', stack: 'at View (app.js:1:2)',
        component_stack: 'in View', route: '/projects', request_id: 'req-9',
        error_code: 'INTERNAL_ERROR', status: 500, client_ts: '2026-11-12T00:00:00.000Z',
      },
    });
    assert.equal(accepted.statusCode, 204);
    assert.equal(accepted.body, '');

    const records = readRecords(directory);
    assert.equal(records.length, 1);
    const record = records[0] as Record<string, unknown>;
    assert.equal(record.event, 'frontend_error');
    assert.equal(record.namespace, 'frontend');
    assert.equal(record.process, 'api');
    assert.equal(record.kind, 'render');
    assert.equal(record.route, '/projects');
    assert.equal(record.request_id, 'req-9');
    assert.equal(record.error_code, 'INTERNAL_ERROR');
    assert.equal(record.status_code, 500);
    assert.equal(record.client_ts, '2026-11-12T00:00:00.000Z');
    assert.equal(record.component_stack, 'in View');
    const error = record.error as Record<string, unknown>;
    assert.equal(error.name, 'TypeError');
    assert.equal(error.message, 'x is undefined');
    assert.equal(error.stack, 'at View (app.js:1:2)');
    assert.ok(typeof record.ts === 'string' && !Number.isNaN(Date.parse(record.ts)));

    const extra = await app.inject({
      method: 'POST', url: URL_PATH, headers: authorized,
      payload: { kind: 'uncaught', message: 'boom', chat_content: 'should not be accepted' },
    });
    assert.equal(extra.statusCode, 422);
    const long = await app.inject({
      method: 'POST', url: URL_PATH, headers: authorized,
      payload: { kind: 'uncaught', message: 'm'.repeat(1001) },
    });
    assert.equal(long.statusCode, 422);
    assert.equal(readRecords(directory).length, 1);
  } finally {
    await app.close();
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('重复诊断由日志去重收敛，仍返回 204', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-client-diag-rate-'));
  configureRuntimeLog({ directory, fileName: 'api.log', level: 'debug', processName: 'api' });
  resetClientDiagnosticsRateLimitForTest();
  const app = buildApp();
  try {
    for (let index = 0; index < 12; index += 1) {
      const response = await app.inject({
        method: 'POST', url: URL_PATH, headers: authorized,
        payload: { kind: 'uncaught', message: 'repeat' },
      });
      assert.equal(response.statusCode, 204);
    }
    const records = readRecords(directory);
    // 运行日志对 warn/error 已有 5 条/10 秒的上限，第 6 条落成 log_suppressed 汇总。
    assert.equal(records.filter((record) => record.event === 'frontend_error').length, 5);
    assert.equal(records.filter((record) => record.event === 'log_suppressed').length, 1);
  } finally {
    await app.close();
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('超出服务端窗口的不同诊断被丢弃但仍返回 204', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-client-diag-window-'));
  configureRuntimeLog({ directory, fileName: 'api.log', level: 'debug', processName: 'api' });
  resetClientDiagnosticsRateLimitForTest();
  const app = buildApp();
  try {
    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: 'POST', url: URL_PATH, headers: authorized,
        payload: { kind: 'uncaught', message: `boom-${index}` },
      });
      assert.equal(response.statusCode, 204);
    }
    assert.equal(readRecords(directory).length, 100);
  } finally {
    await app.close();
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});
