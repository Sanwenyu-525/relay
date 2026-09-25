import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConfigError,
  loadConfig,
  validateDataRoot,
  validateDatabaseUrl,
  validateOrigin,
  type ApiConfig,
} from '../../src/config/config.js';

const REPOSITORY_ROOT = join(tmpdir(), 'relay-api-unit-repository-root');

function baseEnvironment(dataRoot: string): Record<string, string | undefined> {
  return {
    RELAY_API_BIND_HOST: '127.0.0.1',
    RELAY_API_PORT: '8787',
    RELAY_API_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    RELAY_API_BEARER_TOKEN: 'a'.repeat(48),
    RELAY_DB_URL: 'postgresql://relay_api_app@127.0.0.1:5432/relay_unit',
    RELAY_DB_POOL_MAX: '4',
    RELAY_DB_CONNECT_TIMEOUT_MS: '2000',
    RELAY_DATA_ROOT: dataRoot,
    RELAY_LOG_LEVEL: 'info',
    RELAY_API_STOP_ON_STDIN_EOF: 'true',
  };
}

function expectConfigError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env, REPOSITORY_ROOT);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error;
  }

  throw new assert.AssertionError({ message: 'expected configuration loading to fail' });
}

test('accepts a complete environment and normalizes the data root', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-api-unit-data-'));

  try {
    const config: ApiConfig = loadConfig(baseEnvironment(dataRoot), REPOSITORY_ROOT);

    assert.equal(config.bindHost, '127.0.0.1');
    assert.equal(config.port, 8787);
    assert.deepEqual(config.allowedOrigins, ['http://127.0.0.1:5173']);
    assert.equal(config.databasePoolMax, 4);
    assert.equal(config.dataRoot, dataRoot);
    assert.equal(config.stopOnStdinEof, true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('reports every missing key at once instead of silently defaulting', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-api-unit-data-'));
  const env = baseEnvironment(dataRoot);

  try {
    delete env.RELAY_DB_URL;
    delete env.RELAY_API_BEARER_TOKEN;

    const error = expectConfigError(env);

    assert.deepEqual(error.issues, [
      'RELAY_API_BEARER_TOKEN is required',
      'RELAY_DB_URL is required',
    ]);
    assert.equal(JSON.stringify(error.issues).includes('a'.repeat(48)), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('rejects a non-loopback bind host, a privileged port and illegal values', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-api-unit-data-'));

  try {
    const error = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_API_BIND_HOST: '0.0.0.0',
      RELAY_API_PORT: '80',
      RELAY_DB_POOL_MAX: '0',
      RELAY_API_STOP_ON_STDIN_EOF: 'yes',
      RELAY_LOG_LEVEL: 'verbose',
    });

    assert.ok(error.issues.some((issue) => issue.includes('RELAY_API_BIND_HOST')));
    assert.ok(error.issues.some((issue) => issue.includes('RELAY_API_PORT')));
    assert.ok(error.issues.some((issue) => issue.includes('RELAY_DB_POOL_MAX')));
    assert.ok(error.issues.some((issue) => issue.includes('RELAY_API_STOP_ON_STDIN_EOF')));
    assert.ok(error.issues.some((issue) => issue.includes('RELAY_LOG_LEVEL')));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('rejects wildcard, null and non-loopback origins', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-api-unit-data-'));

  try {
    const error = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_API_ALLOWED_ORIGINS: '*,null,https://example.com,http://127.0.0.1:5173/',
    });

    assert.equal(error.issues.length, 4);
    assert.ok(error.issues.every((issue) => issue.startsWith('RELAY_API_ALLOWED_ORIGINS entry')));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('rejects placeholder and short bearer credentials', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-api-unit-data-'));

  try {
    const placeholder = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_API_BEARER_TOKEN: 'replace-with-a-random-credential-of-at-least-32-chars',
    });
    assert.ok(placeholder.issues.some((issue) => issue.includes('placeholder')));

    const short = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_API_BEARER_TOKEN: 'short-token',
    });
    assert.ok(short.issues.some((issue) => issue.includes('at least 32 characters')));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('rejects a data root inside the repository or missing on disk', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-api-unit-data-'));
  const insideRepository = join(REPOSITORY_ROOT, 'artifacts');

  try {
    await mkdir(REPOSITORY_ROOT, { recursive: true });
    await mkdir(insideRepository, { recursive: true });

    const inside = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_DATA_ROOT: insideRepository,
    });
    assert.ok(inside.issues.some((issue) => issue.includes('outside the source repository')));

    const missing = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_DATA_ROOT: join(tmpdir(), 'relay-api-unit-missing-data-root'),
    });
    assert.ok(missing.issues.some((issue) => issue.includes('existing directory')));

    const relative = expectConfigError({
      ...baseEnvironment(dataRoot),
      RELAY_DATA_ROOT: 'relative/data-root',
    });
    assert.ok(relative.issues.some((issue) => issue.includes('absolute path')));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(REPOSITORY_ROOT, { recursive: true, force: true });
  }
});

test('origin, database URL and data root validators stay explicit', () => {
  assert.equal(validateOrigin('http://127.0.0.1:5173'), undefined);
  assert.equal(validateOrigin('http://localhost:5173'), undefined);
  assert.equal(validateOrigin('*'), 'must not contain a wildcard');
  assert.equal(validateOrigin('null'), 'must not be the null origin');
  assert.equal(validateOrigin('https://example.com'), 'must point at a loopback host');
  assert.equal(
    validateOrigin('http://127.0.0.1:80'),
    'must be written in normalized form (expected http://127.0.0.1)',
  );

  assert.equal(validateDatabaseUrl('postgresql://user@127.0.0.1:5432/db'), undefined);
  assert.equal(validateDatabaseUrl('mysql://user@127.0.0.1:5432/db'), 'must use the postgres or postgresql scheme');
  assert.equal(validateDatabaseUrl('not-a-url'), 'must be a PostgreSQL connection URL');

  assert.equal(validateDataRoot('\\\\server\\share', REPOSITORY_ROOT), 'must not be a UNC or network path');
});