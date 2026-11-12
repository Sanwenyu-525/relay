import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../../src/main.js', import.meta.url));

function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runApi(env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [entry], {
    env, encoding: 'utf8', timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('配置失败在数据库之前落盘：记录启动阶段与安全原因', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-startup-log-'));
  try {
    const result = runApi({
      ...process.env,
      RELAY_DATA_ROOT: join(root, 'data'),
      RELAY_DB_URL: '',
      RELAY_LOG_LEVEL: 'info',
    });
    assert.equal(result.status, 2, String(result.stderr));
    const file = join(root, 'data', 'logs', 'relay-api.log');
    assert.ok(existsSync(file));
    const records = readJsonl(file);
    const begin = records.find((record) => record.event === 'api_startup_begin');
    assert.equal(begin?.stage, 'init');
    assert.equal(begin?.bootstrap_log_file, file);
    const failed = records.find((record) => record.event === 'api_startup_failed');
    assert.equal(failed?.stage, 'config');
    assert.equal(failed?.failure_code, 'STARTUP_INVALID');
    assert.ok(String(failed?.error_message ?? '').includes('RELAY_DB_URL'));
    // 启动失败证据不包含任何凭据值。
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('password'));
    assert.ok(!raw.includes('Bearer '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无效日志环境变量：超早期 warn 后按配置错误拒绝，不静默吞掉', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-startup-log-'));
  try {
    const result = runApi({
      ...process.env,
      RELAY_DATA_ROOT: join(root, 'data'),
      RELAY_DB_URL: '',
      RELAY_LOG_LEVEL: 'verbose',
      RELAY_LOG_MAX_BYTES: '1',
    });
    assert.equal(result.status, 2);
    const records = readJsonl(join(root, 'data', 'logs', 'relay-api.log'));
    const warnings = records.filter((record) => record.event === 'runtime_log_env_invalid');
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((record) => String(record.issue).includes('RELAY_LOG_LEVEL')));
    assert.ok(warnings.some((record) => String(record.issue).includes('RELAY_LOG_MAX_BYTES')));
    assert.ok(records.some((record) => record.event === 'api_startup_failed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('数据根不可用时退回临时目录并写明实际文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-startup-log-'));
  const fallback = join(root, 'tmp');
  try {
    const result = runApi({
      ...process.env,
      TMP: fallback, TEMP: fallback, TMPDIR: fallback,
      RELAY_DATA_ROOT: '',
      RELAY_DB_URL: '',
    });
    assert.equal(result.status, 2);
    const file = join(fallback, 'relay-bootstrap-logs', 'relay-api.log');
    assert.ok(existsSync(file), '超早期日志应落在临时目录');
    const records = readJsonl(file);
    const begin = records.find((record) => record.event === 'api_startup_begin');
    assert.equal(begin?.bootstrap_log_file, file);
    assert.ok(records.some((record) => record.event === 'api_startup_failed'
      && record.stage === 'config'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
