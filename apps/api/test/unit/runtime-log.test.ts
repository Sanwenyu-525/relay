import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapLogDirectory, configureRuntimeLog, getRuntimeLogger, redactRecord,
  resetRuntimeLog, runtimeLogFile, runtimeLogSettingsFromEnv,
  MAX_LOG_RECORD_BYTES } from '../../src/infrastructure/runtime-log.js';

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
  const assignments = redactRecord({
    message: 'connect failed password=hunter2 api_key: "abc-123" token=plain-token; password authentication failed',
  });
  const assignmentText = String(assignments.message);
  assert.ok(!assignmentText.includes('hunter2'));
  assert.ok(!assignmentText.includes('abc-123'));
  assert.ok(!assignmentText.includes('plain-token'));
  // 普通句子不是凭据赋值，保持原样便于定位。
  assert.ok(assignmentText.includes('password authentication failed'));
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

test('另一个进程正在轮转时不改名也不丢写', () => withTempLog((directory) => {
  const file = join(directory, 'locked.log');
  writeFileSync(file, 'x'.repeat(512));
  writeFileSync(file + '.rotate.lock', '');
  configureRuntimeLog({ directory, fileName: 'locked.log', level: 'info',
    maxBytes: 256, retainFiles: 2 });
  getRuntimeLogger('test').info('append_while_locked', { message_id: 'm-lock' });
  assert.equal(readdirSync(directory).includes('locked.log.1'), false);
  const raw = readFileSync(file, 'utf8');
  assert.ok(raw.includes('append_while_locked'));
  assert.ok(raw.includes('m-lock'));
}));

test('错误对象序列化：code/name/message/stack 与有界 cause 链', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'error.log', level: 'error' });
  const deepest = new Error('deepest failure');
  const root = Object.assign(new Error('root failure'), { code: 'E_ROOT', cause: deepest });
  const middle = new Error('middle failure', { cause: root });
  const top = new Error('top failure', { cause: middle });
  getRuntimeLogger('test').error('chain_failed', { error: top, request_id: 'req-1' });
  const record = JSON.parse(readLines(directory, 'error.log')[0] ?? '{}') as {
    request_id?: string;
    error?: { name?: string; message?: string; stack?: string; code?: string;
      cause?: { message?: string;
        cause?: { message?: string; code?: string; cause?: unknown } } };
    error_name?: string; error_message?: string; error_code?: string; error_stack?: string;
  };
  assert.equal(record.request_id, 'req-1');
  assert.equal(record.error?.name, 'Error');
  assert.equal(record.error?.message, 'top failure');
  assert.equal(record.error?.code, undefined);
  assert.ok((record.error?.stack ?? '').includes('top failure'));
  assert.equal(record.error?.cause?.message, 'middle failure');
  assert.equal(record.error?.cause?.cause?.message, 'root failure');
  assert.equal(record.error?.cause?.cause?.code, 'E_ROOT');
  assert.equal(record.error?.cause?.cause?.cause, '[cause-depth-limit]');
  // 平铺字段供日志检索直接按 error_code 过滤，不要求消费方理解嵌套结构。
  assert.equal(record.error_name, 'Error');
  assert.equal(record.error_message, 'top failure');
  assert.ok((record.error_stack ?? '').includes('top failure'));
}));

test('循环引用不会让序列化抛错', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'circular.log', level: 'debug' });
  const loop: Record<string, unknown> = { name: 'loop' };
  loop.self = loop;
  const list: unknown[] = [loop];
  loop.list = list;
  assert.doesNotThrow(() => {
    getRuntimeLogger('test').info('circular_payload', { loop, message_id: 'm-2' });
  });
  const raw = readFileSync(join(directory, 'circular.log'), 'utf8');
  const record = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(record.event, 'circular_payload');
  assert.equal(record.message_id, 'm-2');
  assert.ok(raw.includes('[circular]'));
}));

test('超大记录折叠成紧凑记录，保留关联 id 与错误摘要', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'oversize.log', level: 'error' });
  const big = Object.fromEntries(Array.from({ length: 50 },
    (_, index) => [`k${index}`, 'x'.repeat(2000)]));
  const error = Object.assign(new Error('oversized payload'), { code: 'E_BIG' });
  getRuntimeLogger('test').error('oversized_event', {
    error, big, session_id: 's-1', message_id: 'm-3', model_call_id: 'c-4',
  });
  const raw = readFileSync(join(directory, 'oversize.log'), 'utf8').trim();
  const record = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(record.log_truncated, true);
  assert.ok(Number(record.original_bytes) > MAX_LOG_RECORD_BYTES);
  assert.equal(record.session_id, 's-1');
  assert.equal(record.message_id, 'm-3');
  assert.equal(record.model_call_id, 'c-4');
  assert.equal(record.error_name, 'Error');
  assert.equal(record.error_code, 'E_BIG');
  assert.equal(record.error_message, 'oversized payload');
}));

test('高频重复错误在窗口内只写上限条数并留下抑制摘要', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'dedupe.log', level: 'error' });
  const logger = getRuntimeLogger('test');
  for (let index = 0; index < 8; index += 1) {
    logger.error('repeated_failure', { error: new Error('same failure') });
  }
  const records = readLines(directory, 'dedupe.log')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const failures = records.filter((record) => record.event === 'repeated_failure');
  const summaries = records.filter((record) => record.event === 'log_suppressed');
  assert.equal(failures.length, 5);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.suppressed_event, 'repeated_failure');
  assert.equal(summaries[0]?.error_message, 'same failure');
  assert.ok(Number(summaries[0]?.suppressed_count) >= 6);
}));

test('写盘失败不抛异常：回退 stderr 并给出可诊断记录', () => withTempLog((directory) => {
  const logDirectory = join(directory, 'gone');
  configureRuntimeLog({ directory: logDirectory, fileName: 'fail.log', level: 'error' });
  rmSync(logDirectory, { recursive: true, force: true });
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => {
      getRuntimeLogger('test').error('disk_full_simulation', { message_id: 'm-4' });
    });
  } finally {
    process.stderr.write = original;
  }
  const combined = writes.join('');
  assert.ok(combined.includes('disk_full_simulation'));
  assert.ok(combined.includes('m-4'));
  assert.ok(combined.includes('runtime_log_write_failed'));
}));

test('环境变量解析：合法值生效，非法值回退默认并给出说明', () => {
  const valid = runtimeLogSettingsFromEnv({
    RELAY_LOG_LEVEL: ' DEBUG ', RELAY_LOG_MAX_BYTES: '1048576', RELAY_LOG_RETAIN_FILES: '3',
  });
  assert.equal(valid.level, 'debug');
  assert.equal(valid.maxBytes, 1048576);
  assert.equal(valid.retainFiles, 3);
  assert.deepEqual(valid.issues, []);

  const invalid = runtimeLogSettingsFromEnv({
    RELAY_LOG_LEVEL: 'verbose', RELAY_LOG_MAX_BYTES: '1', RELAY_LOG_RETAIN_FILES: 'lots',
  });
  assert.equal(invalid.level, 'info');
  assert.equal(invalid.maxBytes, 8 * 1024 * 1024);
  assert.equal(invalid.retainFiles, 5);
  assert.equal(invalid.issues.length, 3);
});

test('超早期日志目录：数据根绝对时落在其 logs，否则退回系统临时目录', () => {
  const dataRoot = join(tmpdir(), 'relay-data-root');
  assert.equal(bootstrapLogDirectory(dataRoot), join(dataRoot, 'logs'));
  assert.equal(bootstrapLogDirectory(undefined), join(tmpdir(), 'relay-bootstrap-logs'));
  assert.equal(bootstrapLogDirectory('  '), join(tmpdir(), 'relay-bootstrap-logs'));
  assert.equal(bootstrapLogDirectory('relative/path'), join(tmpdir(), 'relay-bootstrap-logs'));
});