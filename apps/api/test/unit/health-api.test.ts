import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

import { registerHealthRoutes } from '../../src/api/health-api.js';
import { ProblemError, problemBody } from '../../src/api/problem.js';
import type { RelayDatabase } from '../../src/infrastructure/database.js';
import type { SchemaReadinessChecker } from '../../src/infrastructure/schema-readiness.js';
import { configureRuntimeLog, resetRuntimeLog } from '../../src/infrastructure/runtime-log.js';

const BEARER = 'b'.repeat(48);

type Probe = Awaited<ReturnType<RelayDatabase['checkReadiness']>>;

function readRecords(directory: string): Record<string, unknown>[] {
  const file = join(directory, 'health.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('就绪探针只记录状态变化与低频心跳，并保留当次 request_id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-health-log-'));
  configureRuntimeLog({ directory, fileName: 'health.log', level: 'debug' });
  let probe: Probe = { database: 'up', schema: 'up' };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      return reply.code(error.problem.status).type('application/problem+json')
        .send(problemBody(error.problem, request.id));
    }
    return reply.code(500).send({ request_id: request.id });
  });
  registerHealthRoutes(app, {
    bearerToken: BEARER,
    database: { checkReadiness: async () => probe } as unknown as RelayDatabase,
    schemaReadiness: {} as SchemaReadinessChecker,
  });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const call = () => app.inject({
      method: 'GET', url: '/health/ready',
      headers: { authorization: `Bearer ${BEARER}` },
    });
    const requestIdOf = (response: Awaited<ReturnType<typeof call>>): string =>
      (response.json() as { request_id: string }).request_id;

    const healthy = await call();
    assert.equal(healthy.statusCode, 200);
    assert.equal(readRecords(directory).length, 0, '健康状态不写日志');

    probe = { database: 'up', schema: 'down' };
    const schemaDown = await call();
    assert.equal(schemaDown.statusCode, 503);
    const schemaDownId = requestIdOf(schemaDown);
    let records = readRecords(directory);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, 'readiness_degraded');
    assert.equal(records[0]?.previous_status, 'ready');
    assert.equal(records[0]?.status, 'schema_unavailable');
    assert.equal(records[0]?.request_id, schemaDownId);

    const sameState = await call();
    assert.equal(sameState.statusCode, 503);
    assert.equal(readRecords(directory).length, 1, '同一状态不逐次刷屏');

    offset += 5 * 60_000;
    const heartbeat = await call();
    assert.equal(heartbeat.statusCode, 503);
    records = readRecords(directory);
    assert.equal(records.length, 2);
    assert.equal(records[1]?.event, 'readiness_still_unavailable');
    assert.equal(records[1]?.request_id, requestIdOf(heartbeat));
    assert.equal(records[1]?.status, 'schema_unavailable');
    assert.ok(Number(records[1]?.failed_probes) >= 3);

    offset += 60_000;
    await call();
    assert.equal(readRecords(directory).length, 2, '心跳间隔内不重复记录');

    probe = { database: 'down', schema: 'unknown' };
    const databaseDown = await call();
    assert.equal(databaseDown.statusCode, 503);
    records = readRecords(directory);
    assert.equal(records.length, 3);
    assert.equal(records[2]?.event, 'readiness_degraded');
    assert.equal(records[2]?.previous_status, 'schema_unavailable');
    assert.equal(records[2]?.status, 'database_unavailable');
    assert.equal(records[2]?.request_id, requestIdOf(databaseDown));
    assert.equal(records[2]?.database, 'down');

    probe = { database: 'up', schema: 'up' };
    offset += 30_000;
    const recovered = await call();
    assert.equal(recovered.statusCode, 200);
    records = readRecords(directory);
    assert.equal(records.length, 4);
    assert.equal(records[3]?.event, 'readiness_recovered');
    assert.equal(records[3]?.previous_status, 'database_unavailable');
    assert.equal(typeof records[3]?.request_id, 'string');
    assert.ok(String(records[3]?.request_id).length > 0);
    assert.equal(records[3]?.failed_probes, 5);
    assert.ok(Number(records[3]?.duration_ms) >= 30_000);
    assert.ok(Number(records[3]?.duration_ms) < 31_000);

    await call();
    assert.equal(readRecords(directory).length, 4, '恢复后健康状态不重复记录');

    const unauthenticated = await app.inject({
      method: 'GET', url: '/health/ready',
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(readRecords(directory).length, 4, '鉴权失败是 4xx，不写就绪日志');

    const liveness = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(liveness.statusCode, 200);
  } finally {
    Date.now = realNow;
    await app.close();
    resetRuntimeLog();
    rmSync(directory, { recursive: true, force: true });
  }
});
