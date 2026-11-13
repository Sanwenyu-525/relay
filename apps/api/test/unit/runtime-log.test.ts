import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireRotationLock, bootstrapLogDirectory, configureRuntimeLog,
  flushRuntimeLogSuppressions, getRuntimeLogger, redactLogText, redactRecord,
  releaseRotationLock, resetRuntimeLog, runtimeLogFile, runtimeLogSettingsFromEnv,
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

function readRecords(directory: string, fileName = 'relay-api.log'): Record<string, unknown>[] {
  return readLines(directory, fileName).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const runtimeLogModuleUrl = new URL(
  '../../src/infrastructure/runtime-log.js', import.meta.url,
).href;

/** 子进程脚本写在临时目录，验证跨进程行为（退出钩子、并发轮转）。 */
function writeChildScript(directory: string, name: string, body: string): string {
  const file = join(directory, name);
  writeFileSync(file, `const log = await import(${JSON.stringify(runtimeLogModuleUrl)});\n${body}`,
    'utf8');
  return file;
}

function runChild(script: string, env: Record<string, string> = {}): Promise<{
  status: number | null;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
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

test('100 个不同 request_id 的相同错误逐条保留，不被聚合吞掉', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'requests.log', level: 'error' });
  const logger = getRuntimeLogger('api');
  for (let index = 0; index < 100; index += 1) {
    logger.error('request_failed', {
      request_id: `req-${String(index)}`,
      error: Object.assign(new Error('same failure'), { code: 'E_SAME' }),
    });
  }
  flushRuntimeLogSuppressions();
  const records = readRecords(directory, 'requests.log');
  const failures = records.filter((record) => record.event === 'request_failed');
  assert.equal(failures.length, 100);
  assert.equal(new Set(failures.map((record) => record.request_id)).size, 100);
  assert.equal(records.filter((record) => record.event === 'log_suppressed').length, 0);
}));

test('10/100/1000 次相同后台错误：行数有界且 total/emitted/suppressed 准确', () => withTempLog((directory) => {
  for (const total of [10, 100, 1000]) {
    const fileName = `count-${String(total)}.log`;
    configureRuntimeLog({ directory, fileName, level: 'error' });
    const logger = getRuntimeLogger('scheduler');
    for (let index = 0; index < total; index += 1) {
      logger.error('tick_failed', { error: new Error('same background failure') });
    }
    flushRuntimeLogSuppressions();
    const records = readRecords(directory, fileName);
    const failures = records.filter((record) => record.event === 'tick_failed');
    const summaries = records.filter((record) => record.event === 'log_suppressed');
    assert.equal(failures.length, 5, `total=${String(total)} 只写前 5 条原文`);
    assert.equal(summaries.length, 1, `total=${String(total)} 只有一个汇总`);
    assert.equal(summaries[0]?.total_count, total);
    assert.equal(summaries[0]?.emitted_count, 5);
    assert.equal(summaries[0]?.suppressed_count, total - 5);
    assert.equal(records.length, 6, `total=${String(total)} 行数保持有界`);
  }
}));

test('run_id 参与去重键：不同执行链的相同错误不合并', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'runs.log', level: 'error' });
  const logger = getRuntimeLogger('worker');
  for (let index = 0; index < 6; index += 1) {
    logger.error('run_failed', { run_id: 'run-a', error: new Error('same failure') });
    logger.error('run_failed', { run_id: 'run-b', error: new Error('same failure') });
  }
  flushRuntimeLogSuppressions();
  const records = readRecords(directory, 'runs.log');
  const summaries = records.filter((record) => record.event === 'log_suppressed');
  assert.equal(records.filter((record) => record.event === 'run_failed').length, 10);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map((record) => record.run_id).sort(), ['run-a', 'run-b']);
  for (const summary of summaries) {
    assert.equal(summary.total_count, 6);
    assert.equal(summary.suppressed_count, 1);
  }
}));

test('窗口到期后先写旧窗口汇总，再为新窗口重新计数', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'window.log', level: 'error' });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const logger = getRuntimeLogger('test');
    for (let index = 0; index < 8; index += 1) {
      logger.error('window_failure', { error: new Error('same failure') });
    }
    assert.equal(readRecords(directory, 'window.log').length, 5);
    offset += 11_000;
    logger.error('window_failure', { error: new Error('same failure') });
    flushRuntimeLogSuppressions();
  } finally {
    Date.now = realNow;
  }
  const records = readRecords(directory, 'window.log');
  const summaries = records.filter((record) => record.event === 'log_suppressed');
  assert.equal(records.filter((record) => record.event === 'window_failure').length, 6);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.total_count, 8);
  assert.equal(summaries[0]?.emitted_count, 5);
  assert.equal(summaries[0]?.suppressed_count, 3);
}));

test('进程正常退出时自动写出未到期的抑制汇总', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-runtime-log-'));
  try {
    const script = writeChildScript(directory, 'exit-child.mjs', `
log.configureRuntimeLog({ directory: ${JSON.stringify(directory)}, fileName: 'exit.log', level: 'error' });
const logger = log.getRuntimeLogger('child');
for (let index = 0; index < 12; index += 1) {
  logger.error('exit_failure', { error: new Error('same failure') });
}
`);
    const result = await runChild(script);
    assert.equal(result.status, 0, result.stderr);
    const records = readRecords(directory, 'exit.log');
    const summaries = records.filter((record) => record.event === 'log_suppressed');
    assert.equal(records.filter((record) => record.event === 'exit_failure').length, 5);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.total_count, 12);
    assert.equal(summaries[0]?.suppressed_count, 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('抑制表达到容量上限：先写旧窗口汇总再驱逐，不静默丢计数', () => withTempLog((directory) => {
  configureRuntimeLog({ directory, fileName: 'capacity.log', level: 'error' });
  const logger = getRuntimeLogger('worker');
  for (let worker = 0; worker < 256; worker += 1) {
    for (let index = 0; index < 6; index += 1) {
      logger.error('background_failure', {
        worker_id: `w-${String(worker)}`, error: new Error('same failure'),
      });
    }
  }
  const beforeFlush = readRecords(directory, 'capacity.log');
  const evicted = beforeFlush.filter((record) => record.event === 'log_suppressed');
  assert.equal(evicted.length, 0, '未超出容量时不提前汇总');
  logger.error('background_failure', { worker_id: 'w-final', error: new Error('same failure') });
  const afterEviction = readRecords(directory, 'capacity.log');
  const evictionSummary = afterEviction.filter((record) => record.event === 'log_suppressed');
  assert.equal(evictionSummary.length, 1);
  assert.equal(evictionSummary[0]?.worker_id, 'w-0');
  assert.equal(evictionSummary[0]?.total_count, 6);
  assert.equal(evictionSummary[0]?.suppressed_count, 1);
  flushRuntimeLogSuppressions();
  const all = readRecords(directory, 'capacity.log');
  assert.equal(all.filter((record) => record.event === 'log_suppressed').length, 256);
}));

test('轮转锁只释放自己持有的锁', () => withTempLog((directory) => {
  const file = join(directory, 'owned.log');
  writeFileSync(file, 'x');
  const lockPath = file + '.rotate.lock';
  const lock = acquireRotationLock(file);
  assert.ok(lock !== undefined);
  assert.equal(acquireRotationLock(file), undefined, '存活进程持有的新锁不可抢占');
  releaseRotationLock(file, lock);
  assert.equal(existsSync(lockPath), false, '释放自己的锁');

  const second = acquireRotationLock(file);
  assert.ok(second !== undefined);
  // 模拟旧锁恢复把锁文件换成了另一个进程的锁（inode 改变）。
  unlinkSync(lockPath);
  writeFileSync(lockPath, `${String(process.pid)}\n`);
  releaseRotationLock(file, second);
  assert.equal(existsSync(lockPath), true, '不删除别人的锁');
}));

test('旧轮转锁：持锁进程存活时不抢占，进程已消失才恢复', () => withTempLog((directory) => {
  const file = join(directory, 'stale.log');
  writeFileSync(file, 'x');
  const lockPath = file + '.rotate.lock';
  const old = new Date(Date.now() - 60_000);

  writeFileSync(lockPath, `${String(process.pid)}\n`);
  utimesSync(lockPath, old, old);
  assert.equal(acquireRotationLock(file), undefined);
  assert.equal(existsSync(lockPath), true);

  unlinkSync(lockPath);
  writeFileSync(lockPath, '999999\n');
  utimesSync(lockPath, old, old);
  const recovered = acquireRotationLock(file);
  assert.ok(recovered !== undefined);
  releaseRotationLock(file, recovered);
  assert.equal(existsSync(lockPath), false);
}));

test('两个进程并发写同一日志并轮转：行数不丢且文件可解析', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-runtime-log-'));
  try {
    const body = (writer: string): string => `
log.configureRuntimeLog({ directory: ${JSON.stringify(directory)}, fileName: 'concurrent.log',
  level: 'info', maxBytes: 4096, retainFiles: 50 });
const logger = log.getRuntimeLogger('child');
for (let index = 0; index < 300; index += 1) {
  logger.info('concurrent_tick', { writer: '${writer}', index, padding: 'x'.repeat(40) });
}
`;
    const first = writeChildScript(directory, 'writer-a.mjs', body('a'));
    const second = writeChildScript(directory, 'writer-b.mjs', body('b'));
    const [resultA, resultB] = await Promise.all([runChild(first), runChild(second)]);
    assert.equal(resultA.status, 0, resultA.stderr);
    assert.equal(resultB.status, 0, resultB.stderr);
    const files = readdirSync(directory).filter((name) => /^concurrent\.log(?:\.\d+)?$/u.test(name));
    assert.ok(files.length > 1, '产生了轮转文件');
    const records = files.flatMap((name) => readRecords(directory, name));
    assert.equal(records.length, 600);
    assert.equal(records.filter((record) => record.writer === 'a').length, 300);
    assert.equal(records.filter((record) => record.writer === 'b').length, 300);
    assert.equal(readdirSync(directory).some((name) => name.endsWith('.rotate.lock')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('凭据脱敏覆盖字段、嵌套数组、Error 链与内嵌连接串', () => {
  const error = new Error('request failed with sk-1234567890123456');
  error.stack = 'Error: request failed\n    Authorization: Bearer abcdefghijklmnop';
  (error as Error & { cause?: unknown }).cause = new Error('db password=hunter2');
  const redacted = redactRecord({
    request_id: 'req-keep', run_id: 'run-keep', task_id: 'task-keep',
    comment: '普通说明保持原样',
    access_token: 'access-123456789',
    refresh_token: { value: 'refresh-123456789' },
    session_token: 'session-123456789',
    cookie: 'sid=abc; theme=dark',
    nested: { list: [{ password: 'hunter2' }, { apiKey: 'sk-abcdefghijklmnop' }] },
    database_url: 'postgres://relay:s3cret-pw@127.0.0.1:5432/relay',
    note: 'Authorization: Bearer abcdefghijklmnop',
    error,
  });
  const raw = JSON.stringify(redacted);
  for (const secret of ['access-123456789', 'refresh-123456789', 'session-123456789',
    'hunter2', 'sk-abcdefghijklmnop', 's3cret-pw', 'abcdefghijklmnop']) {
    assert.equal(raw.includes(secret), false, `泄露了 ${secret}`);
  }
  assert.equal(redacted.request_id, 'req-keep');
  assert.equal(redacted.run_id, 'run-keep');
  assert.equal(redacted.task_id, 'task-keep');
  assert.equal(redacted.comment, '普通说明保持原样');
  assert.ok(String(redacted.database_url).includes('postgres://relay:[redacted]@'));
  const serialized = redacted.error as { message?: string; stack?: string; cause?: { message?: string } };
  assert.equal(String(serialized.message).includes('sk-1234567890123456'), false);
  assert.equal(String(serialized.stack).includes('abcdefghijklmnop'), false);
  assert.equal(String(serialized.cause?.message).includes('hunter2'), false);
  assert.ok(String(redacted.note).includes('Bearer [redacted]'));
  assert.equal(typeof redacted.nested, 'object');
});

test('超长文本脱敏保持有界且不泄露内嵌 token', () => {
  const text = redactLogText(`Authorization: Bearer ${'a'.repeat(200)} password=hunter2 `
    + 'y'.repeat(5000), 1000);
  assert.ok(text.length <= 1000 + '...[truncated]'.length);
  assert.equal(text.includes('hunter2'), false);
});

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

test('日志目录创建失败：不抛错、记 runtime_log_directory_unavailable 并回退 stderr', () => withTempLog((directory) => {
  const blocker = join(directory, 'not-a-directory');
  writeFileSync(blocker, 'block');
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => {
      configureRuntimeLog({ directory: join(blocker, 'logs'), fileName: 'x.log', level: 'error' });
      getRuntimeLogger('test').error('after_directory_failure', { request_id: 'req-dir-1' });
    });
  } finally {
    process.stderr.write = original;
  }
  const combined = writes.join('');
  assert.ok(combined.includes('runtime_log_directory_unavailable'));
  assert.ok(combined.includes('after_directory_failure'));
  assert.ok(combined.includes('req-dir-1'));
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