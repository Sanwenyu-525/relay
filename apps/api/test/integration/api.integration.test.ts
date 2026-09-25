import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { before } from 'node:test';

import { Pool } from 'pg';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  ADMIN_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
} from './integration-support.js';
import {
  baseEnvironment,
  createDataRoot,
  expectProblemJson,
  pickFreePort,
  portIsFree,
  sendRequest as sendHttpRequest,
  startApi,
  stopApi,
  waitForLiveness,
  withTimeout,
  type HttpResponse,
} from './api-harness.js';

const STARTUP_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;

const testDatabaseUrl = process.env.RELAY_TEST_DATABASE_URL;

if (testDatabaseUrl === undefined) {
  throw new Error(
    'RELAY_TEST_DATABASE_URL is required: run "pnpm run test:integration" so the wrapper can build the temporary PostgreSQL cluster.',
  );
}

const testDatabaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//u, ''));

// API 进程以应用角色连接迁移后的 schema；迁移由迁移角色完成，两者都不是超级用户。
before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
});

/** P01 用例的调用形式：第四个参数直接给 headers。HTTP 基建在 api-harness.ts 中共用。 */
function sendRequest(
  port: number,
  method: 'GET' | 'OPTIONS',
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return sendHttpRequest(port, method, path, { headers });
}

test('missing configuration fails explicitly with exit code 2', async () => {
  const dataRoot = await createDataRoot();
  const env = baseEnvironment({
    port: await pickFreePort(),
    allowedOrigin: `http://127.0.0.1:${await pickFreePort()}`,
    bearerToken: randomBytes(32).toString('hex'),
    dataRoot,
  });
  delete env.RELAY_DB_URL;

  try {
    const api = startApi(env);
    const exitCode = await withTimeout(api.exit, EXIT_TIMEOUT_MS, 'the API process to exit');

    assert.equal(exitCode, 2);
    assert.match(api.readOutput(), /RELAY_DB_URL is required/u);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('illegal configuration fails explicitly with exit code 2', async () => {
  const dataRoot = await createDataRoot();
  const env = baseEnvironment({
    port: await pickFreePort(),
    allowedOrigin: `http://127.0.0.1:${await pickFreePort()}`,
    bearerToken: randomBytes(32).toString('hex'),
    dataRoot,
  });
  env.RELAY_API_BIND_HOST = '0.0.0.0';
  env.RELAY_API_ALLOWED_ORIGINS = '*';

  try {
    const api = startApi(env);
    const exitCode = await withTimeout(api.exit, EXIT_TIMEOUT_MS, 'the API process to exit');
    const output = api.readOutput();

    assert.equal(exitCode, 2);
    assert.match(output, /RELAY_API_BIND_HOST/u);
    assert.match(output, /RELAY_API_ALLOWED_ORIGINS/u);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('serves the loopback boundary against a real PostgreSQL and exits on stop', async () => {
  const dataRoot = await createDataRoot();
  const port = await pickFreePort();
  const allowedOrigin = `http://127.0.0.1:${await pickFreePort()}`;
  const bearerToken = randomBytes(32).toString('hex');
  const api = startApi(baseEnvironment({ port, allowedOrigin, bearerToken, dataRoot }));
  const authorization = { authorization: `Bearer ${bearerToken}` };

  try {
    await waitForLiveness(api, port);

    const liveness = await sendRequest(port, 'GET', '/health/live');
    assert.equal(liveness.status, 200);
    assert.deepEqual(liveness.body, { status: 'alive' });
    assert.equal(typeof liveness.headers['x-request-id'], 'string');

    const withCustomRequestId = await sendRequest(port, 'GET', '/health/live', {
      'x-request-id': 'req-integration-0001',
    });
    assert.equal(withCustomRequestId.headers['x-request-id'], 'req-integration-0001');

    const unauthenticated = await sendRequest(port, 'GET', '/health/ready');
    assert.equal(unauthenticated.status, 401);
    expectProblemJson(unauthenticated);
    assert.equal(unauthenticated.headers['www-authenticate'], 'Bearer');
    assert.equal((unauthenticated.body as { code: string }).code, 'AUTH_REQUIRED');
    assert.equal(unauthenticated.text.includes('apps'), false);

    const wrongToken = await sendRequest(port, 'GET', '/health/ready', {
      authorization: `Bearer ${randomBytes(32).toString('hex')}`,
    });
    assert.equal(wrongToken.status, 401);
    assert.equal((wrongToken.body as { code: string }).code, 'AUTH_REQUIRED');

    const wrongHost = await sendRequest(port, 'GET', '/health/ready', {
      ...authorization,
      host: `evil.example:${port}`,
    });
    assert.equal(wrongHost.status, 400);
    assert.equal((wrongHost.body as { code: string }).code, 'MALFORMED_REQUEST');
    assert.equal((wrongHost.body as { type: string }).type, '/problems/invalid-host');

    const wrongPort = await sendRequest(port, 'GET', '/health/ready', {
      ...authorization,
      host: `127.0.0.1:${port + 1}`,
    });
    assert.equal(wrongPort.status, 400);

    const wrongOrigin = await sendRequest(port, 'GET', '/health/ready', {
      ...authorization,
      origin: 'http://127.0.0.1:9',
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((wrongOrigin.body as { type: string }).type, '/problems/invalid-origin');
    assert.equal((wrongOrigin.body as { code: string }).code, 'PERMISSION_DENIED');

    const nullOrigin = await sendRequest(port, 'GET', '/health/ready', {
      ...authorization,
      origin: 'null',
    });
    assert.equal(nullOrigin.status, 403);

    const allowedOriginRequest = await sendRequest(port, 'GET', '/health/ready', {
      ...authorization,
      origin: allowedOrigin,
    });
    assert.equal(allowedOriginRequest.status, 200);
    assert.equal(allowedOriginRequest.headers['access-control-allow-origin'], allowedOrigin);
    assert.deepEqual(allowedOriginRequest.body, {
      status: 'ready',
      components: {
        database: { status: 'up' },
        schema: { status: 'up' },
      },
    });

    const preflight = await sendRequest(port, 'OPTIONS', '/health/ready', {
      origin: allowedOrigin,
      'access-control-request-method': 'GET',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], allowedOrigin);
    assert.equal(preflight.text, '');

    const rejectedPreflight = await sendRequest(port, 'OPTIONS', '/health/ready', {
      origin: 'http://127.0.0.1:9',
    });
    assert.equal(rejectedPreflight.status, 403);

    const unknownRoute = await sendRequest(port, 'GET', '/api/v1/workspaces', authorization);
    assert.equal(unknownRoute.status, 404);
    assert.equal((unknownRoute.body as { code: string }).code, 'RESOURCE_NOT_FOUND');
    assert.equal(
      (unknownRoute.body as { request_id: string }).request_id,
      unknownRoute.headers['x-request-id'],
    );

    // 应用身份只连接本次显式指定的测试数据库；观测用管理员连接读取会话列表。
    const observer = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });

    try {
      const observed = await observer.query<{ datname: string }>(
        "select distinct datname from pg_stat_activity where application_name = 'relay-api'",
      );

      assert.deepEqual(
        observed.rows.map((row) => row.datname),
        [testDatabaseName],
      );
    } finally {
      await observer.end();
    }

    const output = api.readOutput();
    assert.equal(output.includes(bearerToken), false);
    assert.equal(output.includes('postgresql://'), false);

    const exitCode = await stopApi(api);
    assert.equal(exitCode, 0);
    assert.equal(await portIsFree(port), true);
  } finally {
    if (api.child.exitCode === null && api.child.signalCode === null) {
      api.child.kill();
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('reports database unavailability while liveness stays alive', async () => {
  const dataRoot = await createDataRoot();
  const port = await pickFreePort();
  const allowedOrigin = `http://127.0.0.1:${await pickFreePort()}`;
  const bearerToken = randomBytes(32).toString('hex');
  const closedPort = await pickFreePort();
  const env = baseEnvironment({ port, allowedOrigin, bearerToken, dataRoot });
  env.RELAY_DB_URL = `postgresql://relay_api_app@127.0.0.1:${closedPort}/relay_absent`;
  env.RELAY_DB_CONNECT_TIMEOUT_MS = '1000';

  const api = startApi(env);

  try {
    await waitForLiveness(api, port);

    const liveness = await sendRequest(port, 'GET', '/health/live');
    assert.equal(liveness.status, 200);
    assert.deepEqual(liveness.body, { status: 'alive' });

    const readiness = await sendRequest(port, 'GET', '/health/ready', {
      authorization: `Bearer ${bearerToken}`,
    });
    assert.equal(readiness.status, 503);
    expectProblemJson(readiness);
    assert.equal((readiness.body as { code: string }).code, 'DATABASE_UNAVAILABLE');
    assert.equal((readiness.body as { retryable: boolean }).retryable, true);
    assert.deepEqual((readiness.body as { components: unknown }).components, {
      database: { status: 'down' },
      schema: { status: 'unknown' },
    });

    const exitCode = await stopApi(api);
    assert.equal(exitCode, 0);
    assert.equal(await portIsFree(port), true);
  } finally {
    if (api.child.exitCode === null && api.child.signalCode === null) {
      api.child.kill();
    }

    await rm(dataRoot, { recursive: true, force: true });
  }
});
