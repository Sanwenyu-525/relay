import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureRuntimeLog, getRuntimeLogger, redactRecord, resetRuntimeLog,
  runtimeLogFile } from '../../src/infrastructure/runtime-log.js';

function withTempLog<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'relay-runtime-log-'));
  try {
    return run(directory);
  } finally {
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
}

function readLines(directory: string, fileName = 'relay-api.log'): string[] {
  return readFileSync(join(directory, fileName), 'utf8').trim().split('\n');
}

test('未配置时不写磁盘：单测不会留下日志文件', () => {
  resetRuntimeLog();
  const logger = getRuntimeLogger('test');
  logger.error('should_not_persist', { message_id: 'm-1' });
  assert.equal(runtimeLogFile(), undefined);
});

test('级别过滤：低于配置级别的记录不落盘', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'level.log', level: 'warn' });
  const logger = getRuntimeLogger('test');
  logger.info('dropped_info', { message_id: 'm-1' });
  logger.debug('dropped_debug', { message_id: 'm-1' });
  logger.error('kept_error', { message_id: 'm-1' });
  const lines = readLines(directory, 'level.log');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(record.event, 'kept_error');
  assert.equal(record.level, 'error');
  assert.equal(record.message_id, 'm-1');
  assert.equal(record.namespace, 'test');
  assert.equal(typeof record.ts, 'string');
}));

test('深度脱敏：密钥字段与 Bearer 值都不出现在日志里', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'redact.log', level: 'debug' });
  getRuntimeLogger('test').info('provider_request', {
    message_id: 'm-1',
    apiKey: 'sk-should-never-appear',
    headers: { authorization: 'Bearer secret-token', 'x-trace': 'keep-me' },
    config: { model: 'spark-x2.6', password: 'p@ss' },
  });
  const raw = readFileSync(join(directory, 'redact.log'), 'utf8');
  assert.ok(!raw.includes('sk-should-never-appear'));
  assert.ok(!raw.includes('secret-token'));
  assert.ok(!raw.includes('p@ss'));
  assert.ok(raw.includes('keep-me'));
  assert.ok(raw.includes('spark-x2.6'));
}));

test('独立值脱敏：内嵌 Bearer 与 sk- 值都被清洗', () => {
  const redacted = redactRecord({ note: 'Bearer abc.def', error: new Error('sk-1234567890123456'), model: 'x' });
  assert.equal(redacted.note, 'Bearer [redacted]');
  assert.deepEqual((redacted.error as Record<string, unknown>).message, '[redacted]');
  assert.equal(redacted.model, 'x');
  const inline = redactRecord({ message: 'provider rejected key sk-abcdefghijklmnop for spark-x2.6' });
  assert.ok(!String(inline.message).includes('sk-abcdefghijklmnop'));
  assert.ok(String(inline.message).includes('spark-x2.6'));
});

test('错误栈有界保留并清洗内嵌密钥', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'stack.log', level: 'error' });
  const error = new Error('request failed');
  error.stack = `Error: request failed\n    at send (sk-1234567890123456)\n${'    at frame (file.js:1:1)\n'.repeat(200)}`;
  getRuntimeLogger('test').error('request_failed', { error });
  const record = JSON.parse(readLines(directory, 'stack.log')[0] ?? '{}') as {
    error?: { message?: string; stack?: string };
  };
  assert.equal(record.error?.message, 'request failed');
  assert.ok(!record.error?.stack?.includes('sk-1234567890123456'));
  assert.ok(record.error?.stack?.includes('...[truncated]'));
  assert.ok((record.error?.stack?.length ?? 0) < 4200);
}));

test('child 日志器绑定关联 id，不污染父级', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'child.log', level: 'debug' });
  const parent = getRuntimeLogger('api');
  const child = parent.child({ message_id: 'm-9', worker_id: 'w-2' });
  child.info('worker_claimed', { model_call_id: 'c-3' });
  parent.info('api_ready');
  const [first, second] = readLines(directory, 'child.log');
  const claimed = JSON.parse(first ?? '{}') as Record<string, unknown>;
  assert.equal(claimed.message_id, 'm-9');
  assert.equal(claimed.worker_id, 'w-2');
  assert.equal(claimed.model_call_id, 'c-3');
  const ready = JSON.parse(second ?? '{}') as Record<string, unknown>;
  assert.equal(ready.message_id, undefined);
}));

test('按大小轮转并保留有界份数', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'rotate.log', level: 'debug',
    maxBytes: 256, retainFiles: 2 });
  const logger = getRuntimeLogger('test');
  for (let index = 0; index < 40; index += 1) {
    logger.info('tick', { index, padding: 'x'.repeat(20) });
  }
  const files = readdirSync(directory);
  assert.ok(files.includes('rotate.log'));
  assert.ok(files.includes('rotate.log.1'));
  assert.ok(!files.includes('rotate.log.3'));
  assert.ok(files.length <= 3);
}));