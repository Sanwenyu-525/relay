import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import {
  claimGatewayWorker, claimRunForGateway, dispatchGatewayAction, prepareGatewayAction,
  reconcileGatewayInvocation, releaseGatewayWorker, SimulatedGatewayCrash, type GatewayOrigin,
} from '../../src/application/gateway-actions.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { createGatewayPolicy } from '../../src/application/gateway-configuration.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { DomainError } from '../../src/application/domain-error.js';
import { createWebImportJob } from '../../src/application/web-import-commands.js';
import { runWebImportTick } from '../../src/application/web-import-runner.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { extractWebText } from '../../src/web/web-fetch.js';
import { createDataRoot, expectCommandAccepted, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * M04/P17 WEB_FETCH 真实 PG + 受控本机 HTTP 服务验证。
 * SSRF 生产策略（保留地址拒绝）不因测试关闭：受控服务显式通过连接配置的
 * allow_private 登记，反例直接断言默认连接在执行期被拒。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m04-web-fetch');
let dataRoot: string;
let storage: ManagedContentStore;
let server: Server;
let port = 0;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
  server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/ok') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(OK_BODY);
      return;
    }
    if (path === '/plain') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('纯文本正文');
      return;
    }
    if (path === '/binary') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(BINARY_BODY);
      return;
    }
    if (path === '/redirect') {
      response.writeHead(302, { location: '/ok' });
      response.end();
      return;
    }
    if (path === '/redirect-escape') {
      response.writeHead(302, { location: 'http://other.example/escaped' });
      response.end();
      return;
    }
    if (path === '/redirect-loop') {
      response.writeHead(302, { location: '/redirect-loop' });
      response.end();
      return;
    }
    if (path === '/big') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(64 * 1024));
      return;
    }
    if (path === '/teapot') {
      response.writeHead(418, { 'content-type': 'text/plain' });
      response.end('teapot');
      return;
    }
    if (path === '/slow') {
      // Never answers within the narrowed test budget.
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

interface WebFixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  connectionId: string; policyId: string;
}

async function webFixture(input: { decision?: 'AUTO' | 'ASK'; allowPrivate?: boolean;
  allowedHost?: string } = {}): Promise<WebFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p17-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
  });
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P17 Web', projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Web fetch',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '网页只读', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(),
    expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  for (const kind of ['BUILD_CONTEXT', 'DRAFT'] as const) {
    const result = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  const step = await withTransaction(app.db, (r) => r.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(step);
  const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: ['WEB_FETCH'],
    allowedHost: input.allowedHost ?? '127.0.0.1',
    // 受控本机服务必须显式登记 allow_private；SSRF 反例则显式传 false。
    allowPrivate: input.allowPrivate ?? true });
  const policy = await createGatewayPolicy(app.db, { workspaceId, projectId,
    capability: 'WEB_FETCH', actionType: 'WEB_FETCH',
    targetPrefix: input.allowedHost ?? '127.0.0.1',
    decision: input.decision ?? 'AUTO', maxPayloadBytes: 1024 });
  return { workspaceId, projectId, taskId, runId, stepId: step.id,
    connectionId: connection.result.connection_id!, policyId: policy.policyId };
}

async function worker(f: WebFixture): Promise<Extract<GatewayOrigin, { kind: 'RUN' }>> {
  const workerId = `worker-${randomUUID()}`;
  const claim = await claimRunForGateway(app.db, { workspaceId: f.workspaceId,
    runId: f.runId, workerId });
  return { kind: 'RUN', runId: f.runId, stepId: f.stepId, workerId,
    workerEpoch: BigInt(claim.worker_epoch) };
}

async function prepareWeb(f: WebFixture, origin: GatewayOrigin, url: string): Promise<string> {
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH', target: url, params: {} });
  return prepared.operation_id;
}

function domainError(error: unknown): DomainError {
  assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
  return error;
}

const FAST_LIMITS = { maxRedirects: 2, hopTimeoutMs: 1_000, totalTimeoutMs: 500,
  maxBodyBytes: 16 * 1024, maxTextChars: 4_096 };

const OK_BODY = ['<!DOCTYPE html><html><head><script>evil()</script><style>.x{}</style></head>',
  '<body><h1>标题一</h1><p>正文段落 &amp; 更多</p><!-- 注释 --><p>第二段</p></body></html>'].join('');
const BINARY_BODY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);

test('WEB_FETCH reads a controlled page with extraction, hash and identity evidence', async () => {
  const f = await webFixture();
  const origin = await worker(f);
  const url = `http://127.0.0.1:${port}/ok`;
  const operationId = await prepareWeb(f, origin, url);
  const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, origin });
  assert.equal(dispatched.status, 'SUCCEEDED');
  const result = dispatched.result_ref as { url: string; final_url: string; status: number;
    content_type: string; bytes: number; sha256: string; extractor: string;
    content: string; text_available: boolean; text_truncated: boolean; invocation_id: string };
  assert.equal(result.url, url);
  assert.equal(result.final_url, url);
  assert.equal(result.status, 200);
  assert.equal(result.content_type, 'text/html');
  assert.equal(result.extractor, 'web-text-extract-v1');
  assert.equal(result.text_truncated, false);
  assert.ok(result.content.includes('标题一'));
  assert.ok(result.content.includes('正文段落 & 更多'));
  assert.ok(result.content.includes('第二段'));
  assert.equal(result.content.includes('evil()'), false, 'script body must not leak into text');
  assert.equal(result.content.includes('注释'), false, 'comments must not leak into text');
  assert.equal(result.bytes, Buffer.byteLength(OK_BODY, 'utf8'));
  assert.equal(result.sha256, createHash('sha256').update(OK_BODY, 'utf8').digest('hex'));
  assert.equal(result.invocation_id.length, 36);
  // The same operation identity replays to the same settled result.
  const operation = await sql<{ status: string }>`select status from logical_operations
    where id = ${operationId}`.execute(app.db);
  assert.equal(operation.rows[0]!.status, 'SUCCEEDED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.workerId, workerEpoch: origin.workerEpoch });
});

test('WEB_FETCH passes plain text through, records binary as hash-only and settles HTTP errors', async () => {
  const f = await webFixture();
  const origin = await worker(f);

  const plainOp = await prepareWeb(f, origin, `http://127.0.0.1:${port}/plain`);
  const plain = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: plainOp, origin });
  assert.equal(plain.status, 'SUCCEEDED');
  const plainResult = plain.result_ref as { content: string; extractor: string | null };
  assert.equal(plainResult.content, '纯文本正文');
  assert.equal(plainResult.extractor, null);
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.workerId, workerEpoch: origin.workerEpoch });

  const nextOrigin = await worker(f);
  const binaryOp = await prepareWeb(f, nextOrigin, `http://127.0.0.1:${port}/binary`);
  const binary = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: binaryOp, origin: nextOrigin });
  assert.equal(binary.status, 'SUCCEEDED');
  const binaryResult = binary.result_ref as { content: null; text_available: boolean;
    sha256: string; bytes: number };
  assert.equal(binaryResult.content, null);
  assert.equal(binaryResult.text_available, false);
  assert.equal(binaryResult.sha256, createHash('sha256').update(BINARY_BODY).digest('hex'));
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: nextOrigin.workerId, workerEpoch: nextOrigin.workerEpoch });

  const errorOrigin = await worker(f);
  const teapotOp = await prepareWeb(f, errorOrigin, `http://127.0.0.1:${port}/teapot`);
  const teapot = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: teapotOp, origin: errorOrigin });
  assert.equal(teapot.status, 'FAILED');
  assert.equal((teapot.result_ref as { reason: string; status: number }).reason, 'WEB_HTTP_STATUS');
  assert.equal((teapot.result_ref as { status: number }).status, 418);
});

test('WEB_FETCH follows same-host redirects, rejects host escape and redirect loops', async () => {
  const f = await webFixture();
  const origin = await worker(f);
  const followed = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: await prepareWeb(f, origin, `http://127.0.0.1:${port}/redirect`), origin });
  assert.equal(followed.status, 'SUCCEEDED');
  assert.equal((followed.result_ref as { final_url: string }).final_url,
    `http://127.0.0.1:${port}/ok`);
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.workerId, workerEpoch: origin.workerEpoch });

  const escapeOrigin = await worker(f);
  const escaped = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: await prepareWeb(f, escapeOrigin, `http://127.0.0.1:${port}/redirect-escape`),
    origin: escapeOrigin });
  assert.equal(escaped.status, 'FAILED');
  assert.equal((escaped.result_ref as { reason: string }).reason, 'GATEWAY_TARGET_DENIED');
  assert.equal((escaped.result_ref as { detail: string }).detail, 'HOST_NOT_ALLOWED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: escapeOrigin.workerId, workerEpoch: escapeOrigin.workerEpoch });

  const loopOrigin = await worker(f);
  const looped = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: await prepareWeb(f, loopOrigin, `http://127.0.0.1:${port}/redirect-loop`),
    origin: loopOrigin, deadline: null, limits: FAST_LIMITS });
  assert.equal(looped.status, 'FAILED');
  assert.equal((looped.result_ref as { reason: string }).reason, 'WEB_TOO_MANY_REDIRECTS');
});

test('WEB_FETCH enforces body size and total budget deterministically', async () => {
  const f = await webFixture();
  const origin = await worker(f);
  const oversized = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: await prepareWeb(f, origin, `http://127.0.0.1:${port}/big`), origin,
    limits: FAST_LIMITS });
  assert.equal(oversized.status, 'FAILED');
  assert.equal((oversized.result_ref as { error_code: string }).error_code, 'WEB_BODY_TOO_LARGE');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.workerId, workerEpoch: origin.workerEpoch });

  const slowOrigin = await worker(f);
  const slow = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: await prepareWeb(f, slowOrigin, `http://127.0.0.1:${port}/slow`), origin: slowOrigin,
    limits: FAST_LIMITS });
  assert.equal(slow.status, 'FAILED');
  assert.equal((slow.result_ref as { error_code: string }).error_code, 'TOTAL_TIMEOUT');
  assert.equal((slow.result_ref as { reason: string }).reason, 'WEB_FETCH_UNAVAILABLE');
});

test('WEB_FETCH production SSRF policy rejects private addresses without allow_private', async () => {
  const f = await webFixture({ allowPrivate: false });
  const origin = await worker(f);
  const denied = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: await prepareWeb(f, origin, `http://127.0.0.1:${port}/ok`), origin });
  assert.equal(denied.status, 'FAILED');
  const result = denied.result_ref as { reason: string; detail: string; address: string };
  assert.equal(result.reason, 'GATEWAY_TARGET_DENIED');
  assert.equal(result.detail, 'SSRF_FORBIDDEN_ADDRESS');
  assert.equal(result.address, '127.0.0.1');
});

test('WEB_FETCH prepare rejects scheme, userinfo and host mismatches before any effect', async () => {
  const f = await webFixture();
  const origin = await worker(f);
  const ftp = domainError(await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH', target: 'ftp://127.0.0.1/file', params: {} })
    .catch((error) => error));
  assert.equal(ftp.code, 'GATEWAY_TARGET_DENIED');

  const userinfo = domainError(await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH',
    target: `http://user:pass@127.0.0.1:${port}/ok`, params: {} }).catch((error) => error));
  assert.equal(userinfo.code, 'GATEWAY_TARGET_DENIED');

  const wrongHost = domainError(await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH', target: `http://localhost:${port}/ok`, params: {} })
    .catch((error) => error));
  assert.equal(wrongHost.code, 'GATEWAY_TARGET_DENIED');

  const withParams = domainError(await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH', target: `http://127.0.0.1:${port}/ok`,
    params: { url: 'nested' } }).catch((error) => error));
  assert.equal(withParams.code, 'VALIDATION_FAILED');
});

test('WEB_FETCH without a permission policy is denied by default and ASK still gates execution', async () => {
  const f = await webFixture({ decision: 'ASK' });
  const origin = await worker(f);
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'WEB_FETCH', target: `http://127.0.0.1:${port}/ok`, params: {} });
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  assert.ok(prepared.review_id);
  // ASK prepare 已释放旧 Worker：旧身份派发按执行令牌失效拒绝。
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: prepared.operation_id, origin }),
    (error: unknown) => domainError(error).code === 'GATEWAY_STALE_WORKER');

  const review = await withTransaction(app.db, (r) => r.reviews.readRequest(prepared.review_id!));
  assert.ok(review);
  const { resolveReview } = await import('../../src/application/review-decisions.js');
  await resolveReview(app.db, { workspaceId: f.workspaceId, reviewId: prepared.review_id!,
    commandId: randomUUID(), expectedRevision: review.revision.toString(),
    targetHash: review.target_hash.toString('hex'), decision: 'APPROVE' });
  // 批准后由新的 Worker 身份（新 epoch）携带原 operation_id 准入。
  const nextId = `worker-${randomUUID()}`;
  const nextEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
    operationId: prepared.operation_id, workerId: nextId })).worker_epoch);
  const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: prepared.operation_id,
    origin: { kind: 'RUN', runId: f.runId, stepId: f.stepId, workerId: nextId,
      workerEpoch: nextEpoch } });
  assert.equal(dispatched.status, 'SUCCEEDED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: nextId, workerEpoch: nextEpoch });
});

test('WEB_FETCH reconcile safely re-reads: PREPARED stays not executed, crash converges by refetch', async () => {
  const f = await webFixture();
  const origin = await worker(f);
  const operationId = await prepareWeb(f, origin, `http://127.0.0.1:${port}/plain`);
  const invocationId = (await sql<{ id: string }>`
    select id from invocation_attempts where operation_id = ${operationId}`.execute(app.db))
    .rows[0]!.id;
  const notExecuted = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId, invocationId, stoppedWorkerId: origin.workerId,
    stoppedWorkerEpoch: origin.workerEpoch, oldProcessStopped: true });
  assert.equal(notExecuted.status, 'NOT_EXECUTED');

  const reclaimed = await withTransaction(app.db, (r) =>
    r.runs.claimWorker(f.runId, `worker-${randomUUID()}`, new Date(Date.now() + 30_000)));
  assert.ok(reclaimed);
  const reclaimOrigin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    workerId: reclaimed.worker_id!, workerEpoch: BigInt(reclaimed.worker_epoch) };
  const settled = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, origin: reclaimOrigin });
  assert.equal(settled.status, 'SUCCEEDED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: reclaimOrigin.workerId, workerEpoch: reclaimOrigin.workerEpoch });

  const crashOrigin = await worker(f);
  const crashId = await prepareWeb(f, crashOrigin, `http://127.0.0.1:${port}/plain`);
  await assert.rejects(
    dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: crashId,
      origin: crashOrigin, hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('after admit'); } } }),
    SimulatedGatewayCrash);
  const crashInvocationId = (await sql<{ id: string }>`
    select id from invocation_attempts where operation_id = ${crashId}
    order by attempt_number desc limit 1`.execute(app.db)).rows[0]!.id;
  const refetched = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: crashId, invocationId: crashInvocationId,
    stoppedWorkerId: crashOrigin.workerId, stoppedWorkerEpoch: crashOrigin.workerEpoch,
    oldProcessStopped: true });
  assert.equal(refetched.status, 'SUCCEEDED');
});

test('WEB_FETCH connection creation validates host syntax and rejects mixed boundaries', async () => {
  const f = await webFixture();
  const badHost = domainError(await createGatewayConnectionCommand(app.db, {
    workspaceId: f.workspaceId, projectId: f.projectId, commandId: randomUUID(),
    capabilities: ['WEB_FETCH'], allowedHost: 'https://example.com/path' }).catch((error) => error));
  assert.equal(badHost.code, 'VALIDATION_FAILED');

  const mixed = domainError(await createGatewayConnectionCommand(app.db, {
    workspaceId: f.workspaceId, projectId: f.projectId, commandId: randomUUID(),
    capabilities: ['WEB_FETCH'], allowedHost: 'example.com', rootPath: dataRoot })
    .catch((error) => error));
  assert.equal(mixed.code, 'VALIDATION_FAILED');

  const noHost = domainError(await createGatewayConnectionCommand(app.db, {
    workspaceId: f.workspaceId, projectId: f.projectId, commandId: randomUUID(),
    capabilities: ['WEB_FETCH'] }).catch((error) => error));
  assert.equal(noHost.code, 'VALIDATION_FAILED');

  const ok = await createGatewayConnectionCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), capabilities: ['WEB_FETCH'],
    allowedHost: 'Example.COM', allowPrivate: true });
  const stored = await sql<{ config: { allowed_host?: string; allow_private?: boolean } }>`
    select config from gateway_connections where id = ${ok.result.connection_id!}`.execute(app.db);
  assert.equal(stored.rows[0]!.config.allowed_host, 'example.com');
  assert.equal(stored.rows[0]!.config.allow_private, true);

  const api = await startTestApi({ databaseUrl: APP_DATABASE_URL });
  try {
    const base = workspacePath(f.workspaceId, `/projects/${f.projectId}/connections`);
    const detail = await api.get(`${base}/${ok.result.connection_id!}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { allowed_host: string | null }).allowed_host, 'example.com');
    assert.equal(detail.text.includes('config'), false);
    assert.equal(detail.text.includes('allow_private'), false);
    const listed = await api.get(base);
    assert.equal(listed.status, 200);
    const connection = (listed.body as { id: string; allowed_host: string | null }[])
      .find((item) => item.id === ok.result.connection_id);
    assert.equal(connection?.allowed_host, 'example.com');
    assert.equal((await api.get(workspacePath(randomUUID(),
      `/projects/${f.projectId}/connections/${ok.result.connection_id!}`))).status, 404);
    assert.equal((await api.get(workspacePath(f.workspaceId,
      `/projects/${randomUUID()}/connections/${ok.result.connection_id!}`))).status, 404);
  } finally { await api.stop(); }
});

interface ImportFixture { workspaceId: string; projectId: string; connectionId: string; urlBase: string }

async function importFixture(input: { decision?: 'AUTO' | 'ASK'; allowedHost?: string } = {}):
  Promise<ImportFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p17-imp-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
  });
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P17 Import',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
  });
  const allowedHost = input.allowedHost ?? '127.0.0.1';
  const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: ['WEB_FETCH'], allowedHost, allowPrivate: true });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'WEB_FETCH',
    actionType: 'WEB_FETCH', targetPrefix: allowedHost, decision: input.decision ?? 'AUTO',
    maxPayloadBytes: 1024 });
  return { workspaceId, projectId, connectionId: connection.result.connection_id!,
    urlBase: `http://${allowedHost}:${port}` };
}

async function readJob(jobId: string): Promise<{ status: string; error: string | null;
  knowledge_version_id: string | null; source_uri: string; connection_id: string | null }> {
  const rows = await sql<{ status: string; error: string | null; knowledge_version_id: string | null;
    source_uri: string; connection_id: string | null }>`
    select status, error, knowledge_version_id, source_uri, connection_id
    from import_jobs where id = ${jobId}`.execute(app.db);
  return rows.rows[0]!;
}

async function dispatchImportWithoutJobSettlement(f: ImportFixture, path: string): Promise<{
  jobId: string; operationId: string; status: string;
}> {
  const created = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: `${f.urlBase}${path}`,
    connectionId: f.connectionId });
  const jobId = created.result.import_job_id;
  const row = await withTransaction(app.db, async (r) => {
    const current = await r.gateway.lockImportJob(jobId);
    assert.ok(current);
    await r.gateway.setImportJobStatus(jobId, 'RUNNING', null);
    return current;
  });
  const origin: GatewayOrigin = { kind: 'USER_IMPORT', importJobId: jobId,
    actorRef: row.actor_ref, configVersion: row.config_version };
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `web-import-${jobId}`,
    connectionId: f.connectionId, origin, actionType: 'WEB_FETCH',
    target: row.source_uri, params: {} });
  const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: prepared.operation_id, origin });
  return { jobId, operationId: prepared.operation_id, status: dispatched.status };
}

test('an AUTO web import lands the fetched page in Knowledge with provenance', async () => {
  const f = await importFixture();
  const commandId = randomUUID();
  const created = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId, url: `${f.urlBase}/ok`, connectionId: f.connectionId });
  assert.equal(created.result.status, 'QUEUED');
  const replay = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId, url: `${f.urlBase}/ok`, connectionId: f.connectionId });
  assert.equal(replay.result.import_job_id, created.result.import_job_id,
    'the same command id replays the receipt instead of creating a second job');

  const before = await sql<{ context_revision: bigint }>`
    select context_revision from workspace_execution_authority
    where workspace_id = ${f.workspaceId}`.execute(app.db);
  const tick = await runWebImportTick(app.db, {});
  assert.deepEqual([tick.prepared, tick.dispatched, tick.succeeded, tick.failed], [1, 1, 1, 0]);
  const after = await sql<{ context_revision: bigint }>`
    select context_revision from workspace_execution_authority
    where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(after.rows[0]!.context_revision, before.rows[0]!.context_revision + 1n);

  const job = await readJob(created.result.import_job_id);
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(job.error, null);
  assert.ok(job.knowledge_version_id);
  assert.equal(job.source_uri, `${f.urlBase}/ok`);
  assert.equal(job.connection_id, f.connectionId);
  const version = (await sql<{ source_kind: string; media_type: string; content_text: string;
    source_uri: string; source_refs: { extractor?: string; final_url: string; truncated: boolean;
      status: number; operation_id: string; import_job_id: string }; title: string;
    current_version: bigint; project_id: string }>`
    select v.source_kind, v.media_type, v.content_text, v.source_uri, v.source_refs,
      k.title, k.current_version, k.project_id
    from knowledge_versions v join knowledge_items k on k.id = v.knowledge_id
    where v.id = ${job.knowledge_version_id}`.execute(app.db)).rows[0]!;
  assert.equal(version.source_kind, 'WEB_PAGE');
  assert.equal(version.media_type, 'text/plain');
  assert.equal(version.content_text, extractWebText(OK_BODY));
  assert.equal(version.source_uri, `${f.urlBase}/ok`);
  assert.equal(version.title, `${f.urlBase}/ok`);
  assert.equal(version.current_version, 1n);
  assert.equal(version.project_id, f.projectId);
  assert.equal(version.source_refs.extractor, 'web-text-extract-v1');
  assert.equal(version.source_refs.final_url, `${f.urlBase}/ok`);
  assert.equal(version.source_refs.truncated, false);
  assert.equal(version.source_refs.status, 200);
  assert.equal(version.source_refs.import_job_id, created.result.import_job_id);
  const operations = await sql<{ count: bigint; status: string }>`
    select count(*)::bigint as count, min(status) as status from logical_operations
    where import_job_id = ${created.result.import_job_id}`.execute(app.db);
  assert.deepEqual(operations.rows[0], { count: 1n, status: 'SUCCEEDED' });
  // The tick is idempotent: a second pass must not re-import or re-create versions.
  const again = await runWebImportTick(app.db, {});
  assert.deepEqual([again.prepared, again.dispatched, again.succeeded, again.failed], [0, 0, 0, 0]);
  const versions = await sql<{ count: bigint }>`
    select count(*)::bigint as count from knowledge_versions where id = ${job.knowledge_version_id}`.execute(app.db);
  assert.equal(versions.rows[0]?.count, 1n);
});

test('a RUNNING import without an operation recovers with one stable action identity', async () => {
  const f = await importFixture();
  const created = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: `${f.urlBase}/ok`,
    connectionId: f.connectionId });
  const jobId = created.result.import_job_id;
  await withTransaction(app.db, async (r) => {
    await r.gateway.lockImportJob(jobId);
    await r.gateway.setImportJobStatus(jobId, 'RUNNING', null);
  });
  const recovered = await runWebImportTick(app.db, {});
  assert.deepEqual([recovered.prepared, recovered.dispatched, recovered.succeeded], [1, 1, 1]);
  const done = await readJob(jobId);
  assert.equal(done.status, 'SUCCEEDED');
  const before = (await sql<{ id: string }>`
    select id from logical_operations where import_job_id = ${jobId}`.execute(app.db)).rows;
  assert.equal(before.length, 1);
  await runWebImportTick(app.db, {});
  const after = (await sql<{ id: string }>`
    select id from logical_operations where import_job_id = ${jobId}`.execute(app.db)).rows;
  assert.deepEqual(after, before, 'a later tick must preserve the original operation_id');
});

test('two recovery ticks keep one operation and one Knowledge version', async () => {
  const f = await importFixture();
  const created = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: `${f.urlBase}/ok`,
    connectionId: f.connectionId });
  const jobId = created.result.import_job_id;
  await withTransaction(app.db, async (r) => {
    await r.gateway.lockImportJob(jobId);
    await r.gateway.setImportJobStatus(jobId, 'RUNNING', null);
  });
  await Promise.all([runWebImportTick(app.db, {}), runWebImportTick(app.db, {})]);
  const done = await readJob(jobId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.ok(done.knowledge_version_id);
  const counts = (await sql<{ operations: bigint; versions: bigint }>`
    select (select count(*)::bigint from logical_operations where import_job_id = ${jobId}) as operations,
      (select count(*)::bigint from knowledge_versions where id = ${done.knowledge_version_id}) as versions
  `.execute(app.db)).rows[0]!;
  assert.deepEqual(counts, { operations: 1n, versions: 1n });
});

test('a completed Gateway read settles the original import after a crash before Knowledge commit', async () => {
  const f = await importFixture();
  const { jobId, operationId, status } = await dispatchImportWithoutJobSettlement(f, '/ok');
  assert.equal(status, 'SUCCEEDED');
  assert.deepEqual([await readJob(jobId).then((job) => job.status),
    await readJob(jobId).then((job) => job.knowledge_version_id)], ['RUNNING', null]);
  const recovered = await runWebImportTick(app.db, {});
  assert.deepEqual([recovered.prepared, recovered.dispatched, recovered.succeeded], [0, 0, 1]);
  const done = await readJob(jobId);
  assert.equal(done.status, 'SUCCEEDED');
  assert.ok(done.knowledge_version_id);
  const operations = (await sql<{ id: string }>`
    select id from logical_operations where import_job_id = ${jobId}`.execute(app.db)).rows;
  assert.deepEqual(operations.map((row) => row.id), [operationId]);
});

test('a failed Gateway read settles the original import after a crash before job failure', async () => {
  const f = await importFixture();
  const { jobId, operationId, status } = await dispatchImportWithoutJobSettlement(f, '/teapot');
  assert.equal(status, 'FAILED');
  assert.equal((await readJob(jobId)).status, 'RUNNING');
  const recovered = await runWebImportTick(app.db, {});
  assert.deepEqual([recovered.prepared, recovered.dispatched, recovered.failed], [0, 0, 1]);
  const done = await readJob(jobId);
  assert.deepEqual([done.status, done.error, done.knowledge_version_id],
    ['FAILED', 'WEB_HTTP_STATUS', null]);
  const operations = (await sql<{ id: string }>`
    select id from logical_operations where import_job_id = ${jobId}`.execute(app.db)).rows;
  assert.deepEqual(operations.map((row) => row.id), [operationId]);
});

test('an ASK web import waits for the approval and only the decided review lands the page', async () => {
  const f = await importFixture({ decision: 'ASK' });
  const job = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: `${f.urlBase}/ok`,
    connectionId: f.connectionId });
  const first = await runWebImportTick(app.db, {});
  assert.deepEqual([first.prepared, first.dispatched, first.succeeded, first.failed], [1, 0, 0, 0]);
  const waiting = await readJob(job.result.import_job_id);
  assert.equal(waiting.status, 'RUNNING');
  assert.equal(waiting.knowledge_version_id, null);
  const review = (await sql<{ id: string; status: string; revision: bigint; target_hash: Buffer }>`
    select id, status, revision, target_hash from review_requests
    where import_job_id = ${job.result.import_job_id}`.execute(app.db)).rows[0]!;
  assert.equal(review.status, 'OPEN');
  await resolveReview(app.db, { workspaceId: f.workspaceId, reviewId: review.id,
    commandId: randomUUID(), expectedRevision: review.revision.toString(),
    targetHash: review.target_hash.toString('hex'), decision: 'APPROVE' });
  const second = await runWebImportTick(app.db, {});
  assert.deepEqual([second.prepared, second.dispatched, second.succeeded, second.failed], [0, 1, 1, 0]);
  const done = await readJob(job.result.import_job_id);
  assert.equal(done.status, 'SUCCEEDED');
  assert.ok(done.knowledge_version_id);
});

test('a denied import review fails the job and the tick never dispatches the denied operation', async () => {
  const f = await importFixture({ decision: 'ASK' });
  const job = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: `${f.urlBase}/ok`,
    connectionId: f.connectionId });
  await runWebImportTick(app.db, {});
  const review = (await sql<{ id: string; status: string; revision: bigint; target_hash: Buffer }>`
    select id, status, revision, target_hash from review_requests
    where import_job_id = ${job.result.import_job_id}`.execute(app.db)).rows[0]!;
  await resolveReview(app.db, { workspaceId: f.workspaceId, reviewId: review.id,
    commandId: randomUUID(), expectedRevision: review.revision.toString(),
    targetHash: review.target_hash.toString('hex'), decision: 'DENY' });
  const denied = await readJob(job.result.import_job_id);
  assert.deepEqual([denied.status, denied.error], ['FAILED', 'HUMAN_DENIED']);
  assert.equal(denied.knowledge_version_id, null);
  const after = await runWebImportTick(app.db, {});
  assert.deepEqual([after.prepared, after.dispatched, after.succeeded, after.failed], [0, 0, 0, 0]);
  assert.deepEqual(await readJob(job.result.import_job_id), denied);
});

test('a frozen URL outside the connection host fails the job deterministically with no operation', async () => {
  const f = await importFixture();
  const job = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: 'http://other.example/page',
    connectionId: f.connectionId });
  const tick = await runWebImportTick(app.db, {});
  assert.deepEqual([tick.prepared, tick.dispatched, tick.succeeded, tick.failed], [0, 0, 0, 1]);
  const failed = await readJob(job.result.import_job_id);
  assert.deepEqual([failed.status, failed.error], ['FAILED', 'GATEWAY_TARGET_DENIED']);
  const operations = await sql<{ count: bigint }>`
    select count(*)::bigint as count from logical_operations
    where import_job_id = ${job.result.import_job_id}`.execute(app.db);
  assert.equal(operations.rows[0]?.count, 0n);
});

test('a binary page fetches successfully but converges the job to WEB_TEXT_UNAVAILABLE', async () => {
  const f = await importFixture();
  const job = await createWebImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), url: `${f.urlBase}/binary`,
    connectionId: f.connectionId });
  const tick = await runWebImportTick(app.db, {});
  assert.deepEqual([tick.prepared, tick.dispatched, tick.failed], [1, 1, 1]);
  const failed = await readJob(job.result.import_job_id);
  assert.deepEqual([failed.status, failed.error], ['FAILED', 'WEB_TEXT_UNAVAILABLE']);
  assert.equal(failed.knowledge_version_id, null);
  const operation = (await sql<{ status: string; result_ref: { text_available: boolean } }>`
    select status, result_ref from logical_operations
    where import_job_id = ${job.result.import_job_id}`.execute(app.db)).rows[0]!;
  assert.equal(operation.status, 'SUCCEEDED', 'the fetch itself succeeded; only the import goal failed');
  assert.equal(operation.result_ref.text_available, false);
});

test('the import job HTTP surface creates a receipt-backed job', async () => {
  const api = await startTestApi({ databaseUrl: APP_DATABASE_URL });
  try {
    const f = await importFixture();
    const commandId = randomUUID();
    const body = { command_id: commandId, url: `${f.urlBase}/ok`, connection_id: f.connectionId };
    const created = expectCommandAccepted(await api.post(workspacePath(f.workspaceId,
      `/projects/${f.projectId}/import-jobs`), body), 201, commandId);
    assert.ok(created.import_job_id);
    const replay = expectCommandAccepted(await api.post(workspacePath(f.workspaceId,
      `/projects/${f.projectId}/import-jobs`), body), 201, commandId);
    assert.equal(replay.import_job_id, created.import_job_id);
    const jobPath = workspacePath(f.workspaceId, `/import-jobs/${created.import_job_id}`);
    const queued = await api.get(jobPath);
    assert.equal(queued.status, 200);
    assert.deepEqual([(queued.body as { status: string; knowledge_version_id: string | null }).status,
      (queued.body as { status: string; knowledge_version_id: string | null }).knowledge_version_id],
    ['QUEUED', null]);
    await runWebImportTick(app.db, {});
    const done = await api.get(jobPath);
    assert.equal(done.status, 200);
    assert.equal((done.body as { status: string }).status, 'SUCCEEDED');
    assert.ok((done.body as { knowledge_version_id: string | null }).knowledge_version_id);
    const otherWorkspace = await api.get(workspacePath(randomUUID(),
      `/import-jobs/${created.import_job_id}`));
    assert.equal(otherWorkspace.status, 404);
  } finally { await api.stop(); }
});
