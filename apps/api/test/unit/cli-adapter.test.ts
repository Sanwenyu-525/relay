import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  buildSafeEnvironment,
  executeCliCommand,
} from '../../src/cli-worker/cli-adapter.js';

test('buildSafeEnvironment sanitizes environment and strips secrets', () => {
  const custom = {
    MY_SAFE_VAR: 'value123',
    API_KEY: 'secret_key_should_be_stripped',
    RELAY_DB_URL: 'postgres://user:pass@localhost/db',
    DATABASE_URL: 'postgres://user:pass@localhost/db',
    USER_TOKEN: 'bearer_token_123',
    SECRET_KEY: 'sensitive',
    PASSWORD: 'admin',
  };

  const safe = buildSafeEnvironment(custom);

  assert.equal(safe.MY_SAFE_VAR, 'value123');
  assert.equal(safe.API_KEY, undefined);
  assert.equal(safe.RELAY_DB_URL, undefined);
  assert.equal(safe.DATABASE_URL, undefined);
  assert.equal(safe.USER_TOKEN, undefined);
  assert.equal(safe.SECRET_KEY, undefined);
  assert.equal(safe.PASSWORD, undefined);
});

test('executeCliCommand runs safe executable with args array', async () => {
  const result = await executeCliCommand({
    executable: process.execPath,
    args: ['-e', 'console.log("cli adapter works")'],
    cwd: tmpdir(),
  });

  assert.equal(result.outcome, 'SUCCEEDED');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'cli adapter works');
  assert.equal(result.truncated, false);
  assert.ok(result.durationMs >= 0);
});

test('executeCliCommand captures non-zero exit code and stderr', async () => {
  const result = await executeCliCommand({
    executable: process.execPath,
    args: ['-e', 'console.error("something failed"); process.exit(42)'],
    cwd: tmpdir(),
  });

  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.exitCode, 42);
  assert.equal(result.stderr.trim(), 'something failed');
});
