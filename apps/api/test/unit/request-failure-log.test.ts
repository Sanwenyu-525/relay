import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';

import { ProblemError, malformedRequest } from '../../src/api/problem.js';
import { logRequestFailure } from '../../src/api/request-failure-log.js';
import { createServer } from '../../src/api/server.js';
import { sendReadError } from '../../src/api/envelope.js';
import { configureRuntimeLog, resetRuntimeLog } from '../../src/infrastructure/runtime-log.js';

function readRecords(directory: string, fileName = 'request.log'): Array<Record<string, unknown>> {
  return readFileSync(join(directory, fileName), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('helper 只记录 5xx，路由模板不带 query，附加 id 只保留非空值', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-request-log-'));
  try {
    configureRuntimeLog({ directory, fileName: 'request.log', level: 'debug' });
    const request = {
      id: 'req-1', method: 'POST', url: '/runs/abc?token=should-not-appear',
      routeOptions: { url: '/runs/:run_id' },
    } as unknown as FastifyRequest;
    logRequestFailure(request, new Error('boom sk-abcdefghijklmnop'), {
      type: '/problems/internal', title: '内部错误', status: 500, detail: 'x',
      code: 'INTERNAL_ERROR', retryable: false, retryAction: 'NONE',
    }, { run_id: 'run-1', task_id: '' });
    logRequestFailure(request, new Error('rejected'), {
      type: '/problems/malformed-request', title: '请求无法解析', status: 400, detail: 'x',
      code: 'MALFORMED_REQUEST', retryable: false, retryAction: 'NONE',
    });
    const records = readRecords(directory);
    assert.equal(records.length, 1);
    const record = records[0] as Record<string, unknown>;
    assert.equal(record.event, 'request_failed');
    assert.equal(record.request_id, 'req-1');
    assert.equal(record.route, '/runs/:run_id');
    assert.equal(record.run_id, 'run-1');
    assert.equal(record.task_id, undefined);
    assert.ok(!JSON.stringify(record).includes('should-not-appear'));
    assert.ok(!JSON.stringify(record).includes('sk-abcdefghijklmnop'));
  } finally {
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('桌面模式 500 经全局 handler 与读端点都落盘，request_id 与响应一致', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-request-api-'));
  configureRuntimeLog({ directory, fileName: 'api.log', level: 'debug' });
  const app = createServer({
    bindHost: '127.0.0.1', port: 8799, allowedOrigins: [],
    bearerToken: 'a'.repeat(48), logLevel: 'fatal', dataRoot: '',
    databaseUrl: '', databasePoolMax: 1, databaseConnectTimeoutMs: 1000,
    stopOnStdinEof: false, maxConcurrentExecutions: 4, desktopMode: true,
  });
  app.get('/boom', async () => { throw new TypeError('kaboom sk-abcdefghijklmnop'); });
  app.get('/read-boom', async (request, reply) =>
    sendReadError(reply, new TypeError('read kaboom'), request.id));
  app.get('/bad', async () => { throw new ProblemError(malformedRequest('nope')); });
  try {
    const failed = await app.inject({
      url: '/boom', headers: { host: '127.0.0.1:8799', 'x-request-id': 'req-500' },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal((failed.json() as { request_id: string }).request_id, 'req-500');
    const readFailed = await app.inject({
      url: '/read-boom', headers: { host: '127.0.0.1:8799', 'x-request-id': 'req-501' },
    });
    assert.equal(readFailed.statusCode, 500);
    const rejected = await app.inject({
      url: '/bad', headers: { host: '127.0.0.1:8799', 'x-request-id': 'req-400' },
    });
    assert.equal(rejected.statusCode, 400);

    const records = readRecords(directory, 'api.log');
    assert.equal(records.length, 2);
    const byId = new Map(records.map((record) => [record.request_id, record]));
    const internal = byId.get('req-500') as Record<string, unknown>;
    assert.equal(internal.event, 'request_failed');
    assert.equal(internal.method, 'GET');
    assert.equal(internal.route, '/boom');
    assert.equal(internal.status_code, 500);
    assert.equal(internal.code, 'INTERNAL_ERROR');
    assert.equal((internal.error as Record<string, unknown>).name, 'TypeError');
    assert.ok(typeof (internal.error as Record<string, unknown>).stack === 'string');
    assert.equal((byId.get('req-501') as Record<string, unknown>).route, '/read-boom');
    assert.equal(byId.get('req-400'), undefined);
    const raw = readFileSync(join(directory, 'api.log'), 'utf8');
    assert.ok(!raw.includes('sk-abcdefghijklmnop'));
  } finally {
    await app.close();
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});
