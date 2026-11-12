import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./log-query.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');

const LINES = [
  {
    ts: '2026-11-12T08:00:00.000Z', level: 'debug', event: 'assist_model_route_resolve',
    process: 'worker', namespace: 'assist', message_id: 'm-1',
  },
  {
    ts: '2026-11-12T08:00:01.000Z', level: 'info', event: 'model_call_started',
    process: 'worker', namespace: 'model-call', message_id: 'm-1', model_call_id: 'c-1',
    request_id: 'req-1',
  },
  {
    ts: '2026-11-12T08:00:02.000Z', level: 'error', event: 'model_call_failed',
    process: 'worker', namespace: 'model-call', message_id: 'm-1', model_call_id: 'c-1',
    request_id: 'req-1', error_name: 'FetchError', error_code: 'ECONNREFUSED',
    error_message: 'provider refused', failure_stage: 'provider_invoke',
  },
  {
    ts: '2026-11-12T08:00:03.000Z', level: 'info', event: 'api_listening',
    process: 'api', namespace: 'api', request_id: 'req-2',
  },
];

function withLogs(run) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-log-query-'));
  writeFileSync(join(directory, 'relay-worker.log'),
    LINES.map((line) => JSON.stringify(line)).join('\n') + '\n');
  writeFileSync(join(directory, 'relay-worker.log.1'),
    JSON.stringify({
      ts: '2026-11-12T07:59:00.000Z', level: 'warn', event: 'rotated_warning',
      process: 'worker', namespace: 'worker',
    }) + '\n');
  writeFileSync(join(directory, 'worker-supervisor.log'), 'plain supervisor protocol line\n');
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function query(directory, args) {
  return execFileSync(process.execPath, [script, '--dir', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('默认 info 级别过滤掉 debug 且输出关联字段', () => withLogs((directory) => {
  const output = query(directory, []);
  assert.ok(output.includes('model_call_failed'));
  assert.ok(output.includes('error_code=ECONNREFUSED'));
  assert.ok(output.includes('message_id=m-1'));
  assert.ok(!output.includes('assist_model_route_resolve'));
  assert.ok(output.includes('rotated_warning'));
}));

test('--level debug 与 --event 通配可组合', () => withLogs((directory) => {
  const output = query(directory, ['--level', 'debug', '--event', 'model_call_*']);
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.includes('model_call_started'));
  assert.ok(lines[1]?.includes('model_call_failed'));
}));

test('按关联 id、时间窗口与命名空间过滤', () => withLogs((directory) => {
  const byId = query(directory, ['--request-id', 'req-2']);
  assert.equal(byId.trim().split('\n').length, 1);
  assert.ok(byId.includes('api_listening'));

  const byMessage = query(directory, ['--id', 'c-1']);
  assert.equal(byMessage.trim().split('\n').length, 2);

  const window = query(directory, ['--since', '2026-11-12T08:00:02.000Z']);
  assert.equal(window.trim().split('\n').length, 2);
  assert.ok(!window.includes('model_call_started'));

  const namespace = query(directory, ['--namespace', 'model-call', '--level', 'error']);
  assert.equal(namespace.trim().split('\n').length, 1);
  assert.ok(namespace.includes('model_call_failed'));
}));

test('--grep 可检索未解析的 supervisor 原始行', () => withLogs((directory) => {
  const output = query(directory, ['--grep', 'supervisor protocol']);
  assert.ok(output.includes('(unparsed) plain supervisor protocol line'));
}));

test('--json 输出可直接再解析的原始记录', () => withLogs((directory) => {
  const output = query(directory, ['--json', '--event', 'api_listening']);
  const record = JSON.parse(output.trim());
  assert.equal(record.event, 'api_listening');
  assert.equal(record.request_id, 'req-2');
}));

test('--list 只列文件与字节数', () => withLogs((directory) => {
  const output = query(directory, ['--list']);
  assert.ok(output.includes('relay-worker.log'));
  assert.ok(output.includes('worker-supervisor.log'));
  assert.ok(!output.includes('model_call_failed'));
}));

test('非法选项与缺失目录以退出码 2 拒绝', () => {
  assert.throws(() => execFileSync(process.execPath, [script, '--level', 'loud'], {
    cwd: tmpdir(), stdio: 'ignore',
  }), (error) => error.status === 2);
  assert.throws(() => execFileSync(process.execPath,
    [script, '--dir', join(tmpdir(), 'relay-log-query-does-not-exist')], { stdio: 'ignore' }),
  (error) => error.status === 2);
});
