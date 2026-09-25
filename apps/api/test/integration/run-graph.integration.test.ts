import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { Client } from 'pg';

import { claimNextRunCommand, settleRunCommand } from '../../src/application/run-dispatch.js';
import type { ClaimedRunCommand } from '../../src/application/run-dispatch.js';
import { denyGraphActionBeforeInvocation } from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource,
  revokeGatewayPolicy } from '../../src/application/gateway-configuration.js';
import { applySafeControl, requestRunControl, resumeRun } from '../../src/application/control-requests.js';
import { recoverStoppedWorker } from '../../src/application/recover-run.js';
import { reviewTargetHash } from '../../src/application/review-requests.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import type { JsonObject, JsonValue } from '../../src/infrastructure/json.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import { graphCheckpointsReady, installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { runSupervisedWorkerOnce } from '../../src/worker/supervisor.js';
import {
  createTemporaryDatabase, expectSqlState, MIGRATIONS_DIRECTORY, openDatabase,
  type TemporaryDatabase,
} from './integration-support.js';
import {
  createWorkspace, expectCommandAccepted, startTestApi, withTimeout,
  workspacePath, type TestApi,
} from './api-harness.js';

const WORKER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'src', 'worker', 'main.js');

interface Fixture {
  readonly database: TemporaryDatabase;
  readonly app: ReturnType<typeof openDatabase>;
  readonly api: TestApi;
  readonly workspaceId: string;
  close(): Promise<void>;
}

async function fixture(install: boolean): Promise<Fixture> {
  const database = await createTemporaryDatabase('m03_graph');
  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
    if (install) await installGraphCheckpoints(database.migrationUrl);
    const app = openDatabase(database.appUrl, 'relay-m03-graph-test');
    try {
      const api = await startTestApi({ databaseUrl: database.appUrl });
      const workspaceId = await createWorkspace(app.db);
      return { database, app, api, workspaceId, close: async () => {
        await api.stop();
        await app.close();
        await database.drop();
      } };
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    await database.drop();
    throw error;
  }
}

async function delegatedRun(f: Fixture): Promise<string> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/projects'), {
    command_id: projectCommand, title: `graph-${projectCommand.slice(0, 8)}`,
    project_type: 'GENERAL',
  }), 201, projectCommand);
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: project.project_id,
    title: 'Graph checkpoint replay', objective: 'Verify one managed Mock candidate',
    criteria: [{ criterion_id: 'human', statement: 'Review the candidate', method: 'HUMAN' }],
  }), 201, taskCommand);
  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/tasks/${task.task_id as string}/ready`), {
      command_id: readyCommand, expected_revision: task.revision,
    }), 200, readyCommand);
  const delegateCommand = randomUUID();
  const delegated = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/tasks/${task.task_id as string}/delegations`), {
      command_id: delegateCommand, expected_task_revision: ready.revision,
    }), 202, delegateCommand);
  return delegated.run_id as string;
}

async function approveValidationReview(f: Fixture, runId: string): Promise<string> {
  const listed = await f.api.get(workspacePath(f.workspaceId, '/reviews?status=OPEN'));
  const review = (listed.body as { items: Array<{ id: string; run_id: string;
    revision: string; target_hash: string }> }).items.find((item) => item.run_id === runId);
  assert.ok(review);
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_revision: review.revision,
    target_hash: review.target_hash, decision: 'ACCEPT' };
  const decided = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/reviews/${review.id}/decisions`), body), 200, commandId);
  const replay = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/reviews/${review.id}/decisions`), body), 200, commandId);
  assert.equal(replay.decision_id, decided.decision_id);
  return decided.decision_id as string;
}

async function workerOnce(f: Fixture): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [WORKER_ENTRY, '--once'], {
    env: { ...process.env, RELAY_DB_URL: f.database.appUrl,
      RELAY_DATA_ROOT: f.api.dataRoot, RELAY_WORKER_ID: `worker:${randomUUID()}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  const closed = new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  });
  let code: number | null;
  try {
    code = await withTimeout(closed, 20_000, 'graph Worker');
  } catch (error) {
    process.stderr.write(`graph_worker_timeout ${JSON.stringify({ pid: child.pid ?? null,
      output })}\n`);
    child.kill('SIGTERM');
    try {
      await withTimeout(closed, 5_000, 'graph Worker stop after timeout');
    } catch {
      child.kill('SIGKILL');
      await withTimeout(closed, 5_000, 'graph Worker force stop after timeout');
    }
    throw error;
  }
  return { code, output };
}

async function delegatedGatewayRun(f: Fixture, decision: 'ASK' | 'AUTO' = 'ASK'): Promise<{
  runId: string; taskId: string; target: string; operationId: string;
  connectionId: string; policyId: string; resourceId: string;
}> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/projects'), {
    command_id: projectCommand, title: 'Graph Gateway', project_type: 'GENERAL',
  }), 201, projectCommand);
  const projectId = project.project_id as string;
  const root = join(f.api.dataRoot, `graph-gateway-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(f.app.db, {
    workspaceId: f.workspaceId, projectId, rootPath: root,
  });
  const connection = await createFakeConnection(f.app.db, {
    workspaceId: f.workspaceId, projectId, capabilities: ['FAKE_WRITE'],
  });
  const policy = await createGatewayPolicy(f.app.db, {
    workspaceId: f.workspaceId, projectId, capability: 'FAKE_WRITE',
    actionType: 'WRITE_MARKER', targetPrefix: resource.canonicalRoot,
    decision, maxPayloadBytes: 1024,
  });
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: projectId, title: 'Graph approved marker',
    objective: 'Produce a managed Mock candidate and marker',
    criteria: [{ criterion_id: 'human', statement: 'Review the candidate', method: 'HUMAN' }],
  }), 201, taskCommand);
  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/tasks/${task.task_id as string}/ready`), {
    command_id: readyCommand, expected_revision: task.revision,
  }), 200, readyCommand);
  const target = join(resource.canonicalRoot, 'approved-marker.json');
  const delegateCommand = randomUUID();
  const delegated = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/tasks/${task.task_id as string}/delegations`), {
    command_id: delegateCommand, expected_task_revision: ready.revision,
    mock_gateway_action: { connection_id: connection.connectionId,
      resource_id: resource.resourceId, target, content: 'approved Graph marker' },
  }), 202, delegateCommand);
  const runId = delegated.run_id as string;
  const contract = await sql<{ frozen_snapshot: { mock_gateway_action: { operation_id: string } } }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}
  `.execute(f.app.db);
  return { runId, taskId: task.task_id as string, target,
    operationId: contract.rows[0]!.frozen_snapshot.mock_gateway_action.operation_id,
    connectionId: connection.connectionId, policyId: policy.policyId,
    resourceId: resource.resourceId };
}

async function actionReview(f: Fixture, operationId: string): Promise<{
  id: string; revision: bigint; target_hash: Buffer;
}> {
  const result = await sql<{ id: string; revision: bigint; target_hash: Buffer }>`
    select id, revision, target_hash from review_requests where operation_id = ${operationId}
  `.execute(f.app.db);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function decideAction(f: Fixture, operationId: string,
  decision: 'APPROVE' | 'DENY'): Promise<{ decisionId: string; commandId: string }> {
  const review = await actionReview(f, operationId);
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_revision: review.revision.toString(),
    target_hash: review.target_hash.toString('hex'), decision };
  const decided = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/reviews/${review.id}/decisions`), body), 200, commandId);
  const replay = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
    `/reviews/${review.id}/decisions`), body), 200, commandId);
  assert.equal(replay.decision_id, decided.decision_id);
  return { decisionId: decided.decision_id as string, commandId };
}

test('the fixed Mock graph prepares ASK and only the approved RESUME executes its original operation', async () => {
  const f = await fixture(true);
  try {
    const { runId, taskId, target } = await delegatedGatewayRun(f);
    const start = await workerOnce(f);
    assert.equal(start.code, 0, start.output);
    const waiting = await sql<{ id: string; status: string; operation_id: string; review_id: string }>`
      select o.id, o.status, o.id as operation_id, r.id as review_id
      from logical_operations o join review_requests r on r.operation_id = o.id
      where o.run_id = ${runId}
    `.execute(f.app.db);
    assert.equal(waiting.rows.length, 1);
    assert.equal(waiting.rows[0]?.status, 'WAITING_APPROVAL');
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    const startOutbox = await sql<{ status: string }>`select o.status from run_commands c
      join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${runId} and c.kind = 'START'`.execute(f.app.db);
    assert.equal(startOutbox.rows[0]?.status, 'DONE');
    const beforeApproval = await sql<{ step_kind: string; status: string }>`
      select step_kind, status from run_steps where run_id = ${runId}
        and step_kind in ('PERSIST_CANDIDATE', 'VERIFY', 'COMPLETE')
      order by step_index
    `.execute(f.app.db);
    assert.deepEqual(beforeApproval.rows.map((row) => [row.step_kind, row.status]), [
      ['PERSIST_CANDIDATE', 'PENDING'], ['VERIFY', 'PENDING'], ['COMPLETE', 'PENDING'],
    ]);
    const artifactCount = await sql<{ count: bigint }>`select count(*)::bigint as count
      from artifacts where task_id = ${taskId}`.execute(f.app.db);
    assert.equal(artifactCount.rows[0]?.count, 0n);
    const review = await sql<{ revision: bigint; target_hash: Buffer }>`
      select revision, target_hash from review_requests where id = ${waiting.rows[0]!.review_id}
    `.execute(f.app.db);
    const approveCommand = randomUUID();
    const approveBody = { command_id: approveCommand,
      expected_revision: review.rows[0]!.revision.toString(),
      target_hash: review.rows[0]!.target_hash.toString('hex'), decision: 'APPROVE' };
    const approved = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
      `/reviews/${waiting.rows[0]!.review_id}/decisions`), approveBody), 200, approveCommand);
    assert.equal((approved.effect as { external_effect_executed: boolean }).external_effect_executed, false);
    const replay = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
      `/reviews/${waiting.rows[0]!.review_id}/decisions`), approveBody), 200, approveCommand);
    assert.equal(replay.decision_id, approved.decision_id);
    const resumed = await workerOnce(f);
    assert.equal(resumed.code, 0, resumed.output);
    const marker = await readFile(target, 'utf8');
    assert.match(marker, new RegExp(waiting.rows[0]!.operation_id, 'u'));
    const operation = await sql<{ status: string; count: bigint }>`
      select o.status, count(i.id)::bigint as count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${waiting.rows[0]!.operation_id} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(operation.rows[0], { status: 'SUCCEEDED', count: 1n });
  } finally { await f.close(); }
});

test('ACTION approval status changes do not rebuild Context or rerun the successful Draft', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    const beforeAttempts = await sql<{ id: string; attempt_key: string; step_kind: string }>`
      select a.id, a.attempt_key, s.step_kind from step_attempts a
      join run_steps s on s.id = a.step_id
      where s.run_id = ${action.runId} and s.step_kind in ('BUILD_CONTEXT', 'DRAFT')
      order by s.step_index, a.attempt_number
    `.execute(f.app.db);
    assert.deepEqual(beforeAttempts.rows.map((row) => row.step_kind), ['BUILD_CONTEXT', 'DRAFT']);
    const beforeManifests = await sql<{ id: string; manifest_hash: Buffer }>`
      select id, manifest_hash from context_manifests where run_id = ${action.runId}
    `.execute(f.app.db);
    assert.equal(beforeManifests.rows.length, 1);
    await decideAction(f, action.operationId, 'APPROVE');
    const resumed = await workerOnce(f);
    assert.equal(resumed.code, 0, resumed.output);
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    const afterAttempts = await sql<{ id: string; attempt_key: string; step_kind: string }>`
      select a.id, a.attempt_key, s.step_kind from step_attempts a
      join run_steps s on s.id = a.step_id
      where s.run_id = ${action.runId} and s.step_kind in ('BUILD_CONTEXT', 'DRAFT')
      order by s.step_index, a.attempt_number
    `.execute(f.app.db);
    const afterManifests = await sql<{ id: string; manifest_hash: Buffer }>`
      select id, manifest_hash from context_manifests where run_id = ${action.runId}
    `.execute(f.app.db);
    assert.deepEqual(afterAttempts.rows, beforeAttempts.rows);
    assert.deepEqual(afterManifests.rows, beforeManifests.rows);
  } finally { await f.close(); }
});

test('a changed Task input after the approved Mock effect cannot rerun Draft before publication', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    await assert.rejects(() => runOneCommand(f.app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: f.api.dataRoot,
      checkpointUrl: f.database.appUrl,
      afterGatewayFakeEffect: async () => {
        await sql`update tasks set title = 'Changed after Mock effect', revision = revision + 1
          where id = ${action.taskId}`.execute(f.app.db);
      },
    }), { code: 'INVALID_TRANSITION' });
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    const effect = await sql<{ status: string; count: bigint }>`
      select o.status, count(i.id)::bigint as count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(effect.rows[0], { status: 'SUCCEEDED', count: 1n });
    const steps = await sql<{ step_kind: string; status: string; attempts: bigint }>`
      select s.step_kind, s.status, count(a.id)::bigint as attempts from run_steps s
      left join step_attempts a on a.step_id = s.id
      where s.run_id = ${action.runId}
        and s.step_kind in ('BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE')
      group by s.id, s.step_kind, s.status, s.step_index order by s.step_index
    `.execute(f.app.db);
    assert.deepEqual(steps.rows, [
      { step_kind: 'BUILD_CONTEXT', status: 'SUCCEEDED', attempts: 1n },
      { step_kind: 'DRAFT', status: 'SUCCEEDED', attempts: 1n },
      { step_kind: 'PERSIST_CANDIDATE', status: 'PENDING', attempts: 0n },
    ]);
  } finally { await f.close(); }
});

test('a changed Task input during ASK wait denies the original operation before Fake write', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await sql`update tasks set title = 'Changed during approval wait', revision = revision + 1
      where id = ${action.taskId}`.execute(f.app.db);
    await decideAction(f, action.operationId, 'APPROVE');
    const delivered = await runOneCommand(f.app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: f.api.dataRoot,
      checkpointUrl: f.database.appUrl,
    });
    assert.equal(delivered?.outcome, 'DONE');
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const facts = await sql<{ status: string; invocation_count: bigint }>`
      select o.status, count(i.id)::bigint as invocation_count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'DENIED', invocation_count: 0n });
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'FAILED');
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((task.body as { status: string }).status, 'READY');
  } finally { await f.close(); }
});

test('graph outer heartbeat cannot authorize an expired inner Gateway claim', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f, 'AUTO');
    const delivered = await runOneCommand(f.app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: f.api.dataRoot,
      checkpointUrl: f.database.appUrl, leaseMs: 1000,
      afterGatewayAdmit: async (claim) => {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const leases = await sql<{ inner_expired: boolean; outer_current: boolean }>`
          select r.worker_lease_until < clock_timestamp() as inner_expired,
            i.status = 'ACTIVE' and i.lease_until > clock_timestamp() as outer_current
          from runs r join run_invocations i on i.run_id = r.id
          where r.id = ${action.runId} and i.epoch = ${claim.epoch}
        `.execute(f.app.db);
        assert.deepEqual(leases.rows[0], { inner_expired: true, outer_current: true });
      },
    });
    assert.equal(delivered?.outcome, 'BLOCKED');
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const facts = await sql<{ operation_status: string; invocation_status: string;
      claim_status: string; invocation_count: bigint }>`
      select o.status as operation_status, i.status as invocation_status,
        c.status as claim_status,
        (select count(*)::bigint from invocation_attempts where operation_id = o.id) as invocation_count
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      join resource_claims c on c.id = i.resource_claim_id
      where o.id = ${action.operationId}
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { operation_status: 'UNKNOWN', invocation_status: 'UNKNOWN',
      claim_status: 'QUARANTINED', invocation_count: 1n });
  } finally { await f.close(); }
});

test('ASK business commit before interrupt checkpoint cannot strand START ahead of rapid approval', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGatewayPrepare: true });
    assert.equal(stopped.exitCode, 96, stopped.output);
    assert.deepEqual(stopped.requeuedRunIds, [action.runId]);
    assert.equal((await readFile(action.target).then(() => 'PRESENT', () => 'MISSING')), 'MISSING');
    const { decisionId } = await decideAction(f, action.operationId, 'APPROVE');
    const before = await sql<{ kind: string; ordinal: bigint; status: string }>`
      select c.kind, c.ordinal, o.status from run_commands c
      join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${action.runId} order by c.ordinal
    `.execute(f.app.db);
    assert.deepEqual(before.rows.map((row) => [row.kind, row.ordinal, row.status]), [
      ['START', 1n, 'PENDING'], ['RESUME', 2n, 'PENDING'],
    ]);
    const oldStart = await workerOnce(f);
    assert.equal(oldStart.code, 0, oldStart.output);
    const afterStart = await sql<{ kind: string; status: string }>`
      select c.kind, o.status from run_commands c
      join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${action.runId} order by c.ordinal
    `.execute(f.app.db);
    assert.deepEqual(afterStart.rows.map((row) => [row.kind, row.status]), [
      ['START', 'DONE'], ['RESUME', 'PENDING'],
    ]);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const resumed = await workerOnce(f);
    assert.equal(resumed.code, 0, resumed.output);
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    const facts = await sql<{ status: string; decision_id: string }>`
      select o.status, d.id as decision_id from logical_operations o
      join review_requests r on r.operation_id = o.id
      join review_decisions d on d.review_id = r.id where o.id = ${action.operationId}
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'SUCCEEDED', decision_id: decisionId });
  } finally { await f.close(); }
});

test('denied required Mock action terminates the Run without a tool effect or dangling approval wait', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    const started = await workerOnce(f);
    assert.equal(started.code, 0, started.output);
    await decideAction(f, action.operationId, 'DENY');
    const facts = await sql<{ run_status: string; task_status: string;
      operation_status: string; resume_count: bigint }>`
      select r.status as run_status, t.status as task_status,
        op.status as operation_status,
        (select count(*)::bigint from run_commands c where c.run_id = r.id and c.kind = 'RESUME') as resume_count
      from runs r join tasks t on t.id = r.task_id
      join logical_operations op on op.run_id = r.id where r.id = ${action.runId}
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { run_status: 'FAILED', task_status: 'READY',
      operation_status: 'DENIED', resume_count: 0n });
    assert.equal((await workerOnce(f)).code, 0);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('old ACTION RESUME cannot wake the later human-criterion Review after its graph checkpoint', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const crashed = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGraph: true });
    assert.equal(crashed.exitCode, 94, crashed.output);
    assert.deepEqual(crashed.requeuedRunIds, [action.runId]);
    const marker = await readFile(action.target, 'utf8');
    const review = await sql<{ id: string; status: string }>`
      select id, status from review_requests where run_id = ${action.runId}
        and kind = 'CRITERION' and status = 'OPEN'
    `.execute(f.app.db);
    assert.equal(review.rows.length, 1);
    const replay = await workerOnce(f);
    assert.equal(replay.code, 0, replay.output);
    assert.equal(await readFile(action.target, 'utf8'), marker);
    const facts = await sql<{ command_status: string; review_status: string; run_status: string }>`
      select o.status as command_status, rr.status as review_status, r.status as run_status
      from run_commands c join run_command_outbox o on o.command_id = c.id
      join runs r on r.id = c.run_id join review_requests rr on rr.id = ${review.rows[0]!.id}
      where c.run_id = ${action.runId} and c.kind = 'RESUME'
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { command_status: 'DONE',
      review_status: 'OPEN', run_status: 'WAITING_APPROVAL' });
    await approveValidationReview(f, action.runId);
    const final = await workerOnce(f);
    assert.equal(final.code, 0, final.output);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'COMPLETED');
  } finally { await f.close(); }
});

test('a stopped RESUME reconciles the original Fake effect and can replay after approval expiry', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGatewayEffect: true });
    assert.equal(stopped.exitCode, 97, stopped.output);
    assert.deepEqual(stopped.requeuedRunIds, [action.runId]);
    const marker = await readFile(action.target, 'utf8');
    assert.match(marker, new RegExp(action.operationId, 'u'));
    const review = await actionReview(f, action.operationId);
    await sql`update review_requests set expires_at = clock_timestamp() - interval '1 second'
      where id = ${review.id}`.execute(f.app.db);
    const before = await sql<{ operation_status: string; invocation_count: bigint }>`
      select o.status as operation_status, count(i.id)::bigint as invocation_count
      from logical_operations o left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(before.rows[0], { operation_status: 'SUCCEEDED', invocation_count: 1n });
    const replay = await workerOnce(f);
    assert.equal(replay.code, 0, replay.output);
    assert.equal(await readFile(action.target, 'utf8'), marker);
    const after = await sql<{ operation_status: string; invocation_count: bigint }>`
      select o.status as operation_status, count(i.id)::bigint as invocation_count
      from logical_operations o left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally { await f.close(); }
});

test('a stopped RESUME after Gateway Admit but before Fake write preserves UNKNOWN and the same operation', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGatewayAdmit: true });
    assert.equal(stopped.exitCode, 98, stopped.output);
    assert.deepEqual(stopped.blockedRunIds, [action.runId]);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const facts = await sql<{ status: string; invocation_status: string;
      invocation_count: bigint; outbox_status: string }>`
      select o.status, max(i.status) as invocation_status,
        count(i.id)::bigint as invocation_count, b.status as outbox_status
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      join run_commands c on c.run_id = o.run_id and c.kind = 'RESUME'
      join run_command_outbox b on b.command_id = c.id
      where o.id = ${action.operationId} group by o.id, b.status
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'UNKNOWN', invocation_status: 'UNKNOWN',
      invocation_count: 1n, outbox_status: 'CLAIMED' });
    assert.equal((await workerOnce(f)).code, 0);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('revoked Permission after approval cannot dispatch the frozen Mock action', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    await revokeGatewayPolicy(f.app.db, { workspaceId: f.workspaceId, policyId: action.policyId });
    const delivery = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot });
    assert.equal(delivery.exitCode, 0, delivery.output);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const facts = await sql<{ run_status: string; task_status: string;
      operation_status: string; invocation_count: bigint; outbox_status: string }>`
      select r.status as run_status, t.status as task_status,
        op.status as operation_status, count(i.id)::bigint as invocation_count,
        b.status as outbox_status
      from runs r join tasks t on t.id = r.task_id
      join logical_operations op on op.run_id = r.id
      left join invocation_attempts i on i.operation_id = op.id
      join run_commands c on c.run_id = r.id and c.kind = 'RESUME'
      join run_command_outbox b on b.command_id = c.id
      where r.id = ${action.runId}
      group by r.id, t.id, op.id, b.status
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { run_status: 'FAILED', task_status: 'READY',
      operation_status: 'DENIED', invocation_count: 0n, outbox_status: 'DONE' });
  } finally { await f.close(); }
});

test('a committed PAUSE wins over a pre-invocation Permission refusal under the outer claim fence', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const claim = await claimNextRunCommand(f.app.db, `worker:${randomUUID()}`);
    assert.equal(claim?.runId, action.runId);
    await revokeGatewayPolicy(f.app.db, { workspaceId: f.workspaceId, policyId: action.policyId });
    const versions = await sql<{ task_revision: bigint; run_revision: bigint }>`
      select t.revision as task_revision, r.revision as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${action.runId}
    `.execute(f.app.db);
    await requestRunControl(f.app.db, { workspaceId: f.workspaceId, runId: action.runId,
      commandId: randomUUID(), type: 'PAUSE',
      expectedTaskRevision: versions.rows[0]!.task_revision.toString(),
      expectedRunRevision: versions.rows[0]!.run_revision.toString() });
    assert.equal(await denyGraphActionBeforeInvocation(f.app.db, {
      workspaceId: f.workspaceId, runId: action.runId, operationId: action.operationId,
      resourceId: action.resourceId, workerId: claim!.workerId,
      delivery: { commandId: claim!.commandId, invocationEpoch: claim!.epoch },
      reason: 'GATEWAY_PERMISSION_DENIED',
    }), false);
    assert.equal((await applySafeControl(f.app.db, action.runId))?.status, 'PENDING');
    assert.equal(await settleRunCommand(f.app.db, claim!, 'DONE'), true);
    const facts = await sql<{ control_status: string; run_status: string;
      task_status: string; operation_status: string; invocation_count: bigint }>`
      select c.status as control_status, r.status as run_status,
        t.status as task_status, o.status as operation_status,
        (select count(*)::bigint from invocation_attempts i
          where i.operation_id = o.id) as invocation_count
      from runs r join tasks t on t.id = r.task_id
      join run_control_requests c on c.run_id = r.id
      join logical_operations o on o.run_id = r.id where r.id = ${action.runId}
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { control_status: 'APPLIED', run_status: 'PAUSED',
      task_status: 'WAITING', operation_status: 'DENIED', invocation_count: 0n });
    assert.equal(await applySafeControl(f.app.db, action.runId), null);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('frozen Mock approval withdrawal rolls back with its deferred outbox on failure', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    const { decisionId } = await decideAction(f, action.operationId, 'APPROVE');
    const revisions = await sql<{ task_revision: bigint; run_revision: bigint }>`
      select t.revision as task_revision, r.revision as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${action.runId}
    `.execute(f.app.db);
    const requested = await requestRunControl(f.app.db, {
      workspaceId: f.workspaceId, runId: action.runId, commandId: randomUUID(), type: 'PAUSE',
      expectedTaskRevision: revisions.rows[0]!.task_revision.toString(),
      expectedRunRevision: revisions.rows[0]!.run_revision.toString(),
    });
    const migration = openDatabase(f.database.migrationUrl, 'relay-m03-graph-withdraw-fault');
    try {
      await sql`create function reject_graph_approval_withdrawal() returns trigger language plpgsql as $$
        begin
          if old.status = 'PENDING' and new.status = 'DONE' and exists (
            select 1 from run_commands c where c.id = new.command_id
              and c.review_decision_id is not null
          ) then raise exception 'injected frozen approval outbox failure'; end if;
          return new;
        end $$`.execute(migration.db);
      await sql`create trigger reject_graph_approval_withdrawal
        before update on run_command_outbox for each row
        execute function reject_graph_approval_withdrawal()`.execute(migration.db);
      await assert.rejects(applySafeControl(f.app.db, action.runId));
      const held = await sql<{ operation_status: string; outbox_status: string;
        review_status: string; decision_id: string; run_status: string; control_status: string }>`
        select o.status as operation_status, b.status as outbox_status,
          review.status as review_status, decision.id as decision_id,
          run.status as run_status, control.status as control_status
        from logical_operations o
        join review_requests review on review.operation_id = o.id
        join review_decisions decision on decision.review_id = review.id
        join run_commands command on command.review_decision_id = decision.id
        join run_command_outbox b on b.command_id = command.id
        join runs run on run.id = o.run_id
        join run_control_requests control on control.run_id = run.id
        where o.id = ${action.operationId} and control.id = ${requested.result.control_request_id}
      `.execute(f.app.db);
      assert.deepEqual(held.rows[0], { operation_status: 'WAITING_APPROVAL',
        outbox_status: 'PENDING', review_status: 'DECIDED', decision_id: decisionId,
        run_status: 'WAITING_APPROVAL', control_status: 'PENDING' });
    } finally {
      await sql`drop trigger if exists reject_graph_approval_withdrawal
        on run_command_outbox`.execute(migration.db);
      await sql`drop function if exists reject_graph_approval_withdrawal()`.execute(migration.db);
      await migration.close();
    }
    assert.equal((await applySafeControl(f.app.db, action.runId))?.status, 'APPLIED');
    const settled = await sql<{ operation_status: string; outbox_status: string }>`
      select o.status as operation_status, b.status as outbox_status
      from logical_operations o join review_requests review on review.operation_id = o.id
      join review_decisions decision on decision.review_id = review.id
      join run_commands command on command.review_decision_id = decision.id
      join run_command_outbox b on b.command_id = command.id
      where o.id = ${action.operationId}
    `.execute(f.app.db);
    assert.deepEqual(settled.rows[0], { operation_status: 'DENIED', outbox_status: 'DONE' });
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('stopped PREPARED Mock action replays the same operation after NOT_EXECUTED reconciliation', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f, 'AUTO');
    const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGatewayPrepare: true });
    assert.equal(stopped.exitCode, 96, stopped.output);
    assert.deepEqual(stopped.requeuedRunIds, [action.runId]);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const before = await sql<{ operation_status: string; invocation_status: string }>`
      select o.status as operation_status, i.status as invocation_status
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId}
    `.execute(f.app.db);
    assert.deepEqual(before.rows[0], { operation_status: 'PREPARED',
      invocation_status: 'NOT_EXECUTED' });
    const retry = await workerOnce(f);
    assert.equal(retry.code, 0, retry.output);
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    const after = await sql<{ operation_status: string; invocation_count: bigint }>`
      select o.status as operation_status, count(i.id)::bigint as invocation_count
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(after.rows[0], { operation_status: 'SUCCEEDED', invocation_count: 2n });
  } finally { await f.close(); }
});

test('PENDING control after PREPARED reconciliation prevents any replay of the Mock action', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f, 'AUTO');
    const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGatewayPrepare: true });
    assert.equal(stopped.exitCode, 96, stopped.output);
    const versions = await sql<{ task_revision: bigint; run_revision: bigint }>`
      select t.revision as task_revision, r.revision as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${action.runId}
    `.execute(f.app.db);
    await requestRunControl(f.app.db, { workspaceId: f.workspaceId, runId: action.runId,
      commandId: randomUUID(), type: 'PAUSE',
      expectedTaskRevision: versions.rows[0]!.task_revision.toString(),
      expectedRunRevision: versions.rows[0]!.run_revision.toString() });
    const applied = await applySafeControl(f.app.db, action.runId);
    assert.equal(applied?.status, 'APPLIED');
    const facts = await sql<{ run_status: string; operation_status: string }>`
      select r.status as run_status, o.status as operation_status from runs r
      join logical_operations o on o.run_id = r.id where r.id = ${action.runId}
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { run_status: 'PAUSED', operation_status: 'DENIED' });
    assert.equal((await workerOnce(f)).code, 0);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

for (const type of ['PAUSE', 'CANCEL', 'HANDOFF'] as const) {
  test(`${type} after rapid action approval applies before any Mock effect`, async () => {
    const f = await fixture(true);
    try {
      const action = await delegatedGatewayRun(f);
      const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
        databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
        testExitAfterGatewayPrepare: true });
      assert.equal(stopped.exitCode, 96, stopped.output);
      await decideAction(f, action.operationId, 'APPROVE');
      const before = await sql<{ task_revision: bigint; run_revision: bigint }>`
        select t.revision as task_revision, r.revision as run_revision
        from runs r join tasks t on t.id = r.task_id where r.id = ${action.runId}
      `.execute(f.app.db);
      const requested = await requestRunControl(f.app.db, {
        workspaceId: f.workspaceId, runId: action.runId, commandId: randomUUID(),
        expectedTaskRevision: before.rows[0]!.task_revision.toString(),
        expectedRunRevision: before.rows[0]!.run_revision.toString(), type,
      });
      assert.equal(requested.result.status, 'PENDING');
      const applied = await applySafeControl(f.app.db, action.runId);
      assert.equal(applied?.status, 'APPLIED');
      await assert.rejects(readFile(action.target), { code: 'ENOENT' });
      const facts = await sql<{ run_status: string; operation_status: string;
        resume_status: string }>`
        select r.status as run_status, op.status as operation_status, b.status as resume_status
        from runs r join logical_operations op on op.run_id = r.id
        join run_commands c on c.run_id = r.id and c.kind = 'RESUME'
        join run_command_outbox b on b.command_id = c.id where r.id = ${action.runId}
      `.execute(f.app.db);
      assert.deepEqual(facts.rows[0], { run_status: type === 'PAUSE' ? 'PAUSED' : 'CANCELLED',
        operation_status: 'DENIED', resume_status: 'DONE' });
      assert.equal((await workerOnce(f)).code, 0);
      await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
}

test('manual resume cannot revive a PAUSE-invalidated Mock approval or strand a RUNNING Run', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const before = await sql<{ task_revision: bigint; run_revision: bigint }>`
      select t.revision as task_revision, r.revision as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${action.runId}
    `.execute(f.app.db);
    await requestRunControl(f.app.db, { workspaceId: f.workspaceId, runId: action.runId,
      commandId: randomUUID(), type: 'PAUSE',
      expectedTaskRevision: before.rows[0]!.task_revision.toString(),
      expectedRunRevision: before.rows[0]!.run_revision.toString() });
    assert.equal((await applySafeControl(f.app.db, action.runId))?.status, 'APPLIED');
    const paused = await sql<{ task_revision: bigint; run_revision: bigint }>`
      select t.revision as task_revision, r.revision as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${action.runId}
    `.execute(f.app.db);
    await assert.rejects(resumeRun(f.app.db, { workspaceId: f.workspaceId,
      runId: action.runId, commandId: randomUUID(),
      expectedTaskRevision: paused.rows[0]!.task_revision.toString(),
      expectedRunRevision: paused.rows[0]!.run_revision.toString() }),
    (error: unknown) => error instanceof Error && error.message.includes('INVALID_TRANSITION'));
    const facts = await sql<{ run_status: string; task_status: string;
      operation_status: string; resume_count: bigint }>`
      select r.status as run_status, t.status as task_status, op.status as operation_status,
        (select count(*)::bigint from run_commands c where c.run_id = r.id and c.kind = 'RESUME') as resume_count
      from runs r join tasks t on t.id = r.task_id
      join logical_operations op on op.run_id = r.id where r.id = ${action.runId}
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { run_status: 'PAUSED', task_status: 'WAITING',
      operation_status: 'DENIED', resume_count: 1n });
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('two independent Workers racing one approved RESUME create one Gateway invocation', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const [left, right] = await Promise.all([workerOnce(f), workerOnce(f)]);
    assert.equal(left.code, 0, left.output);
    assert.equal(right.code, 0, right.output);
    const claimed = [left.output, right.output].filter((output) => output.includes('worker_claimed'));
    assert.equal(claimed.length, 1);
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    const facts = await sql<{ invocation_count: bigint; outbox_status: string }>`
      select count(i.id)::bigint as invocation_count, b.status as outbox_status
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      join run_commands c on c.run_id = o.run_id and c.kind = 'RESUME'
      join run_command_outbox b on b.command_id = c.id
      where o.id = ${action.operationId} group by b.status
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { invocation_count: 1n, outbox_status: 'DONE' });
  } finally { await f.close(); }
});

test('a Review rebound to another operation cannot wake the frozen action checkpoint', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, action.operationId, 'APPROVE');
    const before = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${action.runId}`.execute(f.app.db);
    const otherId = randomUUID();
    await sql`insert into logical_operations (id, workspace_id, project_id, origin,
      task_id, run_id, step_id, import_job_id, intent_key,
      connection_id, connection_version, connection_config, policy_id, policy_version,
      capability_key, action_type, normalized_target, params_hash, params,
      resource_id, status, result_ref)
      select ${otherId}, workspace_id, project_id, origin,
        task_id, run_id, step_id, import_job_id, intent_key || '-mismatch',
        connection_id, connection_version, connection_config, policy_id, policy_version,
        capability_key, action_type, normalized_target, params_hash, params,
        resource_id, status, result_ref
      from logical_operations where id = ${action.operationId}`.execute(f.app.db);
    const review = await actionReview(f, action.operationId);
    await sql`update review_requests set operation_id = ${otherId}
      where id = ${review.id}`.execute(f.app.db);
    const rejected = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot });
    assert.equal(rejected.exitCode, 1, rejected.output);
    assert.deepEqual(rejected.requeuedRunIds, [action.runId]);
    const after = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${action.runId}`.execute(f.app.db);
    assert.deepEqual(after.rows[0], before.rows[0]);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('a same-Run operation mismatch cannot approve a forged frozen Mock Review', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    const review = await actionReview(f, action.operationId);
    const otherId = randomUUID();
    await sql`insert into logical_operations (id, workspace_id, project_id, origin,
      task_id, run_id, step_id, import_job_id, intent_key,
      connection_id, connection_version, connection_config, policy_id, policy_version,
      capability_key, action_type, normalized_target, params_hash, params,
      resource_id, status, result_ref)
      select ${otherId}, workspace_id, project_id, origin,
        task_id, run_id, step_id, import_job_id, intent_key || '-forged',
        connection_id, connection_version, connection_config, policy_id, policy_version,
        capability_key, action_type, normalized_target, params_hash, params,
        resource_id, status, result_ref
      from logical_operations where id = ${action.operationId}`.execute(f.app.db);
    const original = await sql<{ target: JsonObject }>`select target from review_requests
      where id = ${review.id}`.execute(f.app.db);
    const forgedTarget = { ...original.rows[0]!.target, operation_id: otherId };
    const forgedHash = reviewTargetHash(forgedTarget);
    await sql`update review_requests set operation_id = ${otherId},
      target = ${JSON.stringify(forgedTarget)}::jsonb, target_hash = ${forgedHash}
      where id = ${review.id}`.execute(f.app.db);
    const rejected = await f.api.post(workspacePath(f.workspaceId,
      `/reviews/${review.id}/decisions`), {
      command_id: randomUUID(), expected_revision: review.revision.toString(),
      target_hash: forgedHash.toString('hex'), decision: 'APPROVE',
    });
    assert.equal(rejected.status, 409, rejected.text);
    const facts = await sql<{ decisions: bigint; resumes: bigint; original_invocations: bigint }>`
      select (select count(*)::bigint from review_decisions where review_id = ${review.id}) as decisions,
        (select count(*)::bigint from run_commands where run_id = ${action.runId}
          and kind = 'RESUME') as resumes,
        (select count(*)::bigint from invocation_attempts
          where operation_id = ${action.operationId}) as original_invocations
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { decisions: 0n, resumes: 0n, original_invocations: 0n });
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('official Saver setup is migrator-only; missing or damaged graph schema blocks Worker before claim', async () => {
  const f = await fixture(false);
  try {
    const runId = await delegatedRun(f);
    assert.equal(await graphCheckpointsReady(f.app.db, f.database.appUrl), false);
    const missing = await workerOnce(f);
    assert.equal(missing.code, 2, missing.output);
    assert.match(missing.output, /worker_configuration_failed/u);
    const untouched = await sql<{ status: string; outbox: string }>`
      select i.status, o.status as outbox from run_invocations i
      join run_commands c on c.run_id = i.run_id
      join run_command_outbox o on o.command_id = c.id where i.run_id = ${runId}
    `.execute(f.app.db);
    assert.deepEqual(untouched.rows[0], { status: 'IDLE', outbox: 'PENDING' });

    await Promise.all([
      installGraphCheckpoints(f.database.migrationUrl),
      installGraphCheckpoints(f.database.migrationUrl),
    ]);
    assert.equal(await graphCheckpointsReady(f.app.db, f.database.appUrl), true);
    const versions = await sql<{ v: number }>`
      select v from relay_graph_v1.checkpoint_migrations order by v
    `.execute(f.app.db);
    assert.deepEqual(versions.rows.map((row) => row.v), [0, 1, 2, 3, 4]);
    await expectSqlState('42501', 'application role cannot create graph tables',
      () => sql`create table relay_graph_v1.illicit(id int)`.execute(f.app.db));
    await expectSqlState('42501', 'application role cannot rewrite Saver migrations',
      () => sql`update relay_graph_v1.checkpoint_migrations set v = 99`.execute(f.app.db));

    const migrator = new Client({ connectionString: f.database.migrationUrl });
    await migrator.connect();
    try {
      await migrator.query('alter table relay_graph_v1.checkpoint_writes rename column blob to damaged_blob');
    } finally { await migrator.end(); }
    assert.equal(await graphCheckpointsReady(f.app.db, f.database.appUrl), false);
    const damaged = await workerOnce(f);
    assert.equal(damaged.code, 2, damaged.output);
    assert.deepEqual((await sql<{ status: string }>`select status from run_invocations
      where run_id = ${runId}`.execute(f.app.db)).rows[0], { status: 'IDLE' });
  } finally { await f.close(); }
});

test('the one Run graph persists an empty-namespace Review interrupt, then resumes the original decision', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    const first = await workerOnce(f);
    assert.equal(first.code, 0, first.output);
    const waiting = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((waiting.body as { status: string }).status, 'WAITING_APPROVAL');
    const rows = await sql<{ checkpoint_ns: string; count: bigint }>`
      select checkpoint_ns, count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${runId}
      group by checkpoint_ns
    `.execute(f.app.db);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.checkpoint_ns, '');
    assert.ok((rows.rows[0]?.count ?? 0n) > 1n);
    const invocation = await sql<{ status: string }>`select status from run_invocations
      where run_id = ${runId}`.execute(f.app.db);
    assert.equal(invocation.rows[0]?.status, 'IDLE');

    const decisionId = await approveValidationReview(f, runId);
    const second = await runOneCommand(f.app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: f.api.dataRoot,
      checkpointUrl: f.database.appUrl, maxSteps: 1,
    });
    assert.equal(second?.outcome, 'DONE',
      'a terminal COMPLETE exactly at the graph delivery budget must settle DONE');
    const final = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((final.body as { status: string }).status, 'COMPLETED');
    const commands = await sql<{ status: string; review_decision_id: string | null }>`
      select o.status, c.review_decision_id from run_commands c
      join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${runId} order by c.ordinal
    `.execute(f.app.db);
    assert.deepEqual(commands.rows.map((row) => row.status), ['DONE', 'DONE']);
    assert.equal(commands.rows[1]?.review_decision_id, decisionId);
  } finally { await f.close(); }
});

test('a saved Review interrupt with an unacknowledged START is replayed by the same command', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    const crashed = await runSupervisedWorkerOnce({
      db: f.app.db, databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGraph: true,
    });
    assert.equal(crashed.exitCode, 94, crashed.output);
    assert.deepEqual(crashed.requeuedRunIds, [runId]);
    const checkpoint = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(f.app.db);
    assert.ok((checkpoint.rows[0]?.count ?? 0n) > 1n);
    const interrupt = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoint_writes
      where thread_id = ${runId} and channel = '__interrupt__'`.execute(f.app.db);
    assert.ok((interrupt.rows[0]?.count ?? 0n) > 0n,
      'the Review interrupt must be durable before this child exits');
    const pending = await sql<{ kind: string; status: string }>`
      select c.kind, o.status from run_commands c
      join run_command_outbox o on o.command_id = c.id where c.run_id = ${runId}
    `.execute(f.app.db);
    assert.deepEqual(pending.rows, [{ kind: 'START', status: 'PENDING' }]);
    const resumedStart = await workerOnce(f);
    assert.equal(resumedStart.code, 0, resumedStart.output);
    const after = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(f.app.db);
    assert.equal(after.rows[0]?.count, checkpoint.rows[0]?.count,
      'replayed START acknowledges the saved interrupt without new graph steps');
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
    const effect = await sql<{ count: bigint }>`select count(*)::bigint as count
      from run_effect_actions where run_id = ${runId}`.execute(f.app.db);
    assert.equal(effect.rows[0]?.count, 1n);
  } finally { await f.close(); }
});

test('PAUSE and resume of a saved Review wait cannot strand the unacknowledged START before approval', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    const crashed = await runSupervisedWorkerOnce({
      db: f.app.db, databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGraph: true,
    });
    assert.equal(crashed.exitCode, 94, crashed.output);
    assert.deepEqual(crashed.requeuedRunIds, [runId]);
    const revision = async (): Promise<{ task_revision: bigint; run_revision: bigint }> => {
      const rows = await sql<{ task_revision: bigint; run_revision: bigint }>`
        select t.revision as task_revision, r.revision as run_revision
        from runs r join tasks t on t.id = r.task_id where r.id = ${runId}
      `.execute(f.app.db);
      assert.ok(rows.rows[0]);
      return rows.rows[0];
    };
    const beforePause = await revision();
    await requestRunControl(f.app.db, { workspaceId: f.workspaceId, runId,
      commandId: randomUUID(), type: 'PAUSE',
      expectedTaskRevision: beforePause.task_revision.toString(),
      expectedRunRevision: beforePause.run_revision.toString() });
    assert.equal((await applySafeControl(f.app.db, runId))?.status, 'APPLIED');
    const paused = await revision();
    assert.equal((await resumeRun(f.app.db, { workspaceId: f.workspaceId, runId,
      commandId: randomUUID(), expectedTaskRevision: paused.task_revision.toString(),
      expectedRunRevision: paused.run_revision.toString() })).result.status, 'WAITING_APPROVAL');
    const before = await sql<{ operation_id: string; dispatch_count: number }>`
      select operation_id, dispatch_count from run_effect_actions where run_id = ${runId}
    `.execute(f.app.db);
    const decisionId = await approveValidationReview(f, runId);
    const acknowledgedStart = await workerOnce(f);
    assert.equal(acknowledgedStart.code, 0, acknowledgedStart.output);
    const midway = await sql<{ kind: string; status: string }>`
      select c.kind, o.status from run_commands c join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${runId} order by c.ordinal
    `.execute(f.app.db);
    assert.deepEqual(midway.rows.map((row) => [row.kind, row.status]),
      [['START', 'DONE'], ['RESUME', 'PENDING']],
      'the old START may acknowledge its saved interrupt but may not execute the approved successor');
    const midwayRun = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((midwayRun.body as { status: string }).status, 'VERIFYING');
    assert.deepEqual((await sql<{ operation_id: string; dispatch_count: number }>`
      select operation_id, dispatch_count from run_effect_actions where run_id = ${runId}
    `.execute(f.app.db)).rows, before.rows);
    const resumedDecision = await workerOnce(f);
    assert.equal(resumedDecision.code, 0, resumedDecision.output);
    const completed = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((completed.body as { status: string }).status, 'COMPLETED');
    const commands = await sql<{ kind: string; status: string; review_decision_id: string | null }>`
      select c.kind, o.status, c.review_decision_id from run_commands c
      join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${runId} order by c.ordinal
    `.execute(f.app.db);
    assert.deepEqual(commands.rows.map((row) => [row.kind, row.status]),
      [['START', 'DONE'], ['RESUME', 'DONE']]);
    assert.equal(commands.rows[1]?.review_decision_id, decisionId);
  } finally { await f.close(); }
});

test('a claimed RESUME killed before its checkpoint reuses the one Review decision', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    const decisionId = await approveValidationReview(f, runId);
    const before = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(f.app.db);
    const crashed = await runSupervisedWorkerOnce({
      db: f.app.db, databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterResumeClaim: true,
    });
    assert.equal(crashed.exitCode, 95, crashed.output);
    assert.deepEqual(crashed.requeuedRunIds, [runId]);
    const unadvanced = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(f.app.db);
    assert.equal(unadvanced.rows[0]?.count, before.rows[0]?.count);
    const continued = await workerOnce(f);
    assert.equal(continued.code, 0, continued.output);
    const completed = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((completed.body as { status: string }).status, 'COMPLETED');
    const commands = await sql<{ kind: string; status: string; review_decision_id: string | null }>`
      select c.kind, o.status, c.review_decision_id from run_commands c
      join run_command_outbox o on o.command_id = c.id
      where c.run_id = ${runId} order by c.ordinal
    `.execute(f.app.db);
    assert.deepEqual(commands.rows.map((row) => [row.kind, row.status]),
      [['START', 'DONE'], ['RESUME', 'DONE']]);
    assert.equal(commands.rows[1]?.review_decision_id, decisionId);
  } finally { await f.close(); }
});

test('a real child exit after business commit but before graph checkpoint replays without a second effect', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    const crashed = await runSupervisedWorkerOnce({
      db: f.app.db, databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterStepKind: 'PERSIST_CANDIDATE',
    });
    assert.equal(crashed.exitCode, 93, crashed.output);
    assert.deepEqual(crashed.requeuedRunIds, [runId]);
    const before = await sql<{ operation_id: string; dispatch_count: number }>`
      select operation_id, dispatch_count from run_effect_actions where run_id = ${runId}
    `.execute(f.app.db);
    assert.equal(before.rows.length, 1);
    const continued = await workerOnce(f);
    assert.equal(continued.code, 0, continued.output);
    const after = await sql<{ operation_id: string; dispatch_count: number }>`
      select operation_id, dispatch_count from run_effect_actions where run_id = ${runId}
    `.execute(f.app.db);
    assert.deepEqual(after.rows, before.rows);
    const versions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from artifact_versions
      where source_ref like ${`run:${runId}/%`}
    `.execute(f.app.db);
    assert.equal(versions.rows[0]?.count, 1n);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
  } finally { await f.close(); }
});

test('lost invocation after a committed node cannot write its normal successor checkpoint', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const waiting = new Promise<void>((done) => { entered = done; });
    let oldClaim: { commandId: string; workerId: string; epoch: bigint } | undefined;
    const old = runOneCommand(f.app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: f.api.dataRoot,
      checkpointUrl: f.database.appUrl, leaseMs: 5_000,
      afterStep: async (step, claim) => {
        if (step.status === 'STEP_SUCCEEDED' && step.step_kind === 'BUILD_CONTEXT') {
          oldClaim = claim;
          entered();
          await held;
        }
      },
    });
    try {
      await withTimeout(waiting, 10_000, 'committed graph node before checkpoint');
      const captured = oldClaim;
      assert.ok(captured);
      const before = await sql<{ count: bigint }>`select count(*)::bigint as count
        from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(f.app.db);
      await sql`update run_invocations set lease_until = clock_timestamp() - interval '1 millisecond'
        where run_id = ${runId}`.execute(f.app.db);
      await recoverStoppedWorker(f.app.db, { runId, stoppedWorkerId: captured.workerId,
        stoppedEvidence: 'test: false stop to exercise graph epoch fence',
        storage: new ManagedContentStore(f.api.dataRoot) });
      await withTransaction(f.app.db, async (repositories) => {
        await repositories.runs.lockRun(runId);
        await repositories.dispatch.lockInvocation(runId);
        await repositories.dispatch.lockOutbox(captured.commandId);
        await repositories.dispatch.requeueStoppedClaim(runId, captured.workerId,
          captured.epoch, captured.commandId, 'test: false stop');
      });
      const next = await claimNextRunCommand(f.app.db, `worker:${randomUUID()}`, 5_000);
      assert.equal(next?.epoch, captured.epoch + 1n);
      release();
      const lost = await withTimeout(old, 10_000, 'old graph node after epoch replacement');
      assert.equal(lost?.outcome, 'LOST');
      const after = await sql<{ count: bigint }>`select count(*)::bigint as count
        from relay_graph_v1.checkpoints where thread_id = ${runId}`.execute(f.app.db);
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    } finally { release(); }
  } finally { await f.close(); }
});

for (const controlType of ['CANCEL', 'CANCEL_TASK'] as const) {
  test(`G06 ${controlType} aborts an in-flight Mock model only after durable control`, async () => {
    const f = await fixture(true);
    let stopChild = (): void => {};
    let delivery: ReturnType<typeof runSupervisedWorkerOnce> | undefined;
    try {
      const runId = await delegatedRun(f);
      const taskRow = await sql<{ id: string }>`select task_id as id from runs where id = ${runId}`.execute(f.app.db);
      const taskId = taskRow.rows[0]?.id;
      assert.ok(taskId);
      let modelStarted!: () => void;
      const started = new Promise<void>((resolve) => { modelStarted = resolve; });
      delivery = runSupervisedWorkerOnce({ db: f.app.db, databaseUrl: f.database.appUrl,
        dataRoot: f.api.dataRoot, testModelDelayMs: 12_000,
        onSpawn: (child) => { stopChild = () => { child.kill('SIGTERM'); }; },
        onOutput: (line) => {
          if (line.includes('"type":"mock_model_started"')) modelStarted();
        },
      });
      await withTimeout(started, 10_000, 'Mock model started in independent Worker');
      const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
      const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${taskId}`));
      assert.equal(run.status, 200);
      assert.equal(task.status, 200);
      const runRevision = (run.body as { revision: string }).revision;
      const taskRevision = (task.body as { revision: string }).revision;
      const commandId = randomUUID();
      const requestedAt = Date.now();
      const requested = controlType === 'CANCEL_TASK'
        ? await f.api.post(workspacePath(f.workspaceId, `/tasks/${taskId}/cancel`), {
          command_id: commandId, expected_task_revision: taskRevision,
          expected_run_revision: runRevision,
        })
        : await f.api.post(workspacePath(f.workspaceId, `/runs/${runId}/control-requests`), {
          command_id: commandId, expected_task_revision: taskRevision,
          expected_run_revision: runRevision, type: 'CANCEL',
        });
      const receipt = expectCommandAccepted(requested, 202, commandId);
      assert.equal(receipt.status, 'PENDING');
      assert.ok(Date.now() - requestedAt < 6_000, 'control request waited for the model delay');
      const stopped = await withTimeout(delivery, 8_000, 'stopped Mock Worker and recovery');
      assert.equal(stopped.exitCode, 0, stopped.output);
      assert.match(stopped.output, /"type":"mock_model_cancelled"/);
      assert.deepEqual(stopped.requeuedRunIds, [runId]);
      const control = await f.api.get(workspacePath(f.workspaceId,
        `/runs/${runId}/control-requests/${receipt.control_request_id as string}`));
      assert.equal((control.body as { status: string }).status, 'APPLIED');
      const finalRun = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
      const finalTask = await f.api.get(workspacePath(f.workspaceId, `/tasks/${taskId}`));
      assert.equal((finalRun.body as { status: string }).status, 'CANCELLED');
      assert.equal((finalTask.body as { status: string }).status,
        controlType === 'CANCEL_TASK' ? 'CANCELLED' : 'READY');
      const draft = await sql<{ step_status: string; attempt_status: string; evidence: { reason: string } }>`
        select s.status as step_status, a.status as attempt_status, a.evidence
        from run_steps s join step_attempts a on a.step_id = s.id
        where s.run_id = ${runId} and s.step_kind = 'DRAFT'
      `.execute(f.app.db);
      assert.equal(draft.rows.length, 1);
      assert.equal(draft.rows[0]?.attempt_status, 'FAILED');
      assert.equal(draft.rows[0]?.evidence.reason, 'CONTROL_PREEMPTED_AFTER_WORKER_STOP');
      const versions = await sql<{ count: bigint }>`select count(*)::bigint as count
        from artifact_versions where source_ref like ${`run:${runId}/%`}`.execute(f.app.db);
      assert.equal(versions.rows[0]?.count, 0n);
      const stopEvidence = await sql<{ fact_refs: { stopped_evidence: string } }>`
        select fact_refs from activity_records where task_id = ${taskId}
          and event_type = 'RUN_WORKER_FENCED' order by created_at desc limit 1
      `.execute(f.app.db);
      assert.match(stopEvidence.rows[0]?.fact_refs.stopped_evidence ?? '', /mock-worker-child-close/);
      assert.equal((await runSupervisedWorkerOnce({ db: f.app.db,
        databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot })).exitCode, 0);
      const stillTerminal = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
      assert.equal((stillTerminal.body as { status: string }).status, 'CANCELLED');
    } finally {
      stopChild();
      if (delivery !== undefined) await Promise.allSettled([delivery]);
      await f.close();
    }
  });
}

test('G06 forced Worker termination needs close evidence and invents no user cancellation', async () => {
  const f = await fixture(true);
  let stopChild = (): void => {};
  let delivery: ReturnType<typeof runSupervisedWorkerOnce> | undefined;
  try {
    const runId = await delegatedRun(f);
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    delivery = runSupervisedWorkerOnce({ db: f.app.db, databaseUrl: f.database.appUrl,
      dataRoot: f.api.dataRoot, testModelDelayMs: 12_000,
      onSpawn: (child) => { stopChild = () => { child.kill('SIGTERM'); }; },
      onOutput: (line) => {
        if (line.includes('"type":"mock_model_started"')) modelStarted();
      },
    });
    await withTimeout(started, 10_000, 'Mock model started before Worker shutdown');
    stopChild();
    const stopped = await withTimeout(delivery, 8_000, 'stopped Mock Worker without control');
    assert.equal(stopped.exitCode, null, stopped.output);
    assert.equal(stopped.signal, 'SIGTERM');
    assert.match(stopped.output, /"type":"mock_model_started"/);
    assert.deepEqual(stopped.requeuedRunIds, [runId]);
    const controls = await sql<{ count: bigint }>`select count(*)::bigint as count
      from run_control_requests where run_id = ${runId}`.execute(f.app.db);
    assert.equal(controls.rows[0]?.count, 0n);
    const before = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((before.body as { status: string }).status, 'RUNNING');
    const resumed = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot });
    assert.equal(resumed.exitCode, 0, resumed.output);
    const after = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((after.body as { status: string }).status, 'WAITING_APPROVAL');
  } finally {
    stopChild();
    if (delivery !== undefined) await Promise.allSettled([delivery]);
    await f.close();
  }
});

test('G06 settled independent Workers close promptly while control polling is active', async () => {
  const f = await fixture(true);
  try {
    const expected = new Set<string>();
    for (let index = 0; index < 3; index += 1) expected.add(await delegatedRun(f));
    const settled = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      let stopChild = (): void => {};
      let workerSettled!: () => void;
      const settlement = new Promise<void>((resolve) => { workerSettled = resolve; });
      const delivery = runSupervisedWorkerOnce({ db: f.app.db,
        databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
        onSpawn: (child) => { stopChild = () => { child.kill('SIGTERM'); }; },
        onOutput: (line) => {
          if (line.includes('"type":"worker_settled"')) workerSettled();
        },
      });
      try {
        await withTimeout(settlement, 10_000, 'independent Worker settlement');
        const closed = await withTimeout(delivery, 5_000, 'independent Worker close after settlement');
        assert.equal(closed.exitCode, 0, closed.output);
        const runId = /"type":"worker_settled"[^\n]*"run_id":"([^"]+)"/.exec(closed.output)?.[1];
        assert.ok(runId);
        settled.add(runId);
      } finally {
        stopChild();
        await Promise.allSettled([delivery]);
      }
    }
    assert.deepEqual(settled, expected);
  } finally { await f.close(); }
});

type WritableJsonObject = { [key: string]: JsonValue };
type ManifestTamper = (f: Fixture, migrationDb: DbExecutor, runId: string) => Promise<void>;

async function rewriteManifestPayload(f: Fixture, migrationDb: DbExecutor, runId: string,
  mutate: (payload: WritableJsonObject) => void): Promise<void> {
  const row = await sql<{ payload: JsonObject }>`
    select payload from context_manifests where run_id = ${runId}
  `.execute(f.app.db);
  assert.equal(row.rows.length, 1);
  const payload = JSON.parse(JSON.stringify(row.rows[0]!.payload)) as WritableJsonObject;
  mutate(payload);
  await sql`update context_manifests set payload = ${JSON.stringify(payload)}::jsonb
    where run_id = ${runId}`.execute(migrationDb);
}

/** Item-by-item tampering of the persisted manifest plus its read paths; the
 * application role cannot write these rows, so the migrations role models the
 * corruption or upgrade-side anomaly an admission fence must still catch. */
const MANIFEST_CORRUPTIONS: ReadonlyArray<readonly [string, ManifestTamper]> = [
  ['task id mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.task as WritableJsonObject).id = 'task:tampered';
    });
  }],
  ['task title mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.task as WritableJsonObject).title = 'Tampered title';
    });
  }],
  ['task id wrong type', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.task as WritableJsonObject).id = 42;
    });
  }],
  ['project id mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.project as WritableJsonObject).id = '11111111-1111-1111-1111-111111111111';
    });
  }],
  ['sources not an array', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      payload.sources = { broken: true };
    });
  }],
  ['task source version stale', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      const taskSource = (payload.sources as WritableJsonObject[]).find((source) => source.kind === 'TASK');
      assert.ok(taskSource);
      taskSource.version = '0';
    });
  }],
  ['task source missing', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      payload.sources = (payload.sources as WritableJsonObject[]).filter((source) => source.kind !== 'TASK');
    });
  }],
  ['context revision mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.dependencies as WritableJsonObject).context_revision = '999';
    });
  }],
  ['context revision wrong type', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.dependencies as WritableJsonObject).context_revision = 7;
    });
  }],
  ['authority revision mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.dependencies as WritableJsonObject).authority_revision = '999';
    });
  }],
  ['project revision mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.dependencies as WritableJsonObject).project_revision = '999';
    });
  }],
  ['run id mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.run as WritableJsonObject).id = '11111111-1111-1111-1111-111111111111';
    });
  }],
  ['ownership epoch mismatch', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      (payload.run as WritableJsonObject).ownership_epoch = '999';
    });
  }],
  ['manifest hash stripped from BUILD_CONTEXT step', async (_f, migrationDb, runId) => {
    await sql`update run_steps set result_ref = result_ref - 'manifest_hash'
      where run_id = ${runId} and step_kind = 'BUILD_CONTEXT'`.execute(migrationDb);
  }],
  ['manifest row missing', async (_f, migrationDb, runId) => {
    await sql`delete from context_manifests where run_id = ${runId}`.execute(migrationDb);
  }],
];

async function expectDeniedBeforeInvocation(f: Fixture, action: Awaited<ReturnType<typeof delegatedGatewayRun>>,
  label: string): Promise<void> {
  await assert.rejects(readFile(action.target), { code: 'ENOENT' }, label);
  const facts = await sql<{ status: string; invocation_count: bigint }>`
    select o.status, count(i.id)::bigint as invocation_count from logical_operations o
    left join invocation_attempts i on i.operation_id = o.id
    where o.id = ${action.operationId} group by o.id
  `.execute(f.app.db);
  assert.deepEqual(facts.rows[0], { status: 'DENIED', invocation_count: 0n }, label);
  const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
  assert.equal((run.body as { status: string }).status, 'FAILED', label);
  const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
  assert.equal((task.body as { status: string }).status, 'READY', label);
}

test('a tampered persisted manifest field denies the frozen Mock action before any invocation', async () => {
  const f = await fixture(true);
  let migration: ReturnType<typeof openDatabase> | undefined;
  try {
    const control = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await decideAction(f, control.operationId, 'APPROVE');
    const admitted = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(admitted?.outcome, 'DONE');
    assert.match(await readFile(control.target, 'utf8'), new RegExp(control.operationId, 'u'));

    migration = openDatabase(f.database.migrationUrl, 'relay-m03-manifest-corruption');
    for (const [label, tamper] of MANIFEST_CORRUPTIONS) {
      const action = await delegatedGatewayRun(f);
      const prepared = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
        dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
      assert.equal(prepared?.outcome, 'DONE', `${label}: ASK wait`);
      await tamper(f, migration.db, action.runId);
      await decideAction(f, action.operationId, 'APPROVE');
      const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
        dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
      assert.equal(delivered?.outcome, 'DONE', label);
      await expectDeniedBeforeInvocation(f, action, label);
    }
  } finally {
    await migration?.close();
    await f.close();
  }
});

test('G06 a control durable across settlement converges without a second delivery', async () => {
  const f = await fixture(true);
  let captured: ClaimedRunCommand | undefined;
  try {
    const runId = await delegatedRun(f);
    const delivered = await runOneCommand(f.app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl,
      onClaim: async (claim) => { captured = claim; },
      afterGraph: async () => {
        const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
        const taskRow = await sql<{ task_id: string }>`
          select task_id from runs where id = ${runId}`.execute(f.app.db);
        const taskId = taskRow.rows[0]!.task_id;
        const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${taskId}`));
        const commandId = randomUUID();
        const requested = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
          `/runs/${runId}/control-requests`), {
          command_id: commandId, expected_task_revision: (task.body as { revision: string }).revision,
          expected_run_revision: (run.body as { revision: string }).revision, type: 'CANCEL',
        }), 202, commandId);
        assert.equal(requested.status, 'PENDING');
      },
    });
    if (delivered?.outcome === 'LOST') {
      // The control poll observed the durable control before settlement; the
      // supervisor would reconcile the aborted in-process claim the same way.
      assert.ok(captured);
      await recoverStoppedWorker(f.app.db, { runId, stoppedWorkerId: captured.workerId,
        stoppedEvidence: 'test: control poll abort during settlement race',
        storage: new ManagedContentStore(f.api.dataRoot) });
      await withTransaction(f.app.db, async (repositories) => {
        await repositories.runs.lockRun(runId);
        await repositories.dispatch.lockInvocation(runId);
        await repositories.dispatch.lockOutbox(captured!.commandId);
        await repositories.dispatch.requeueStoppedClaim(runId, captured!.workerId,
          captured!.epoch, captured!.commandId, 'test: control poll abort during settlement race');
      });
      const resumed = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
        dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
      assert.ok(resumed, 'requeued delivery must consume the CONTROL_PENDING claim');
    } else {
      assert.equal(delivered?.outcome, 'DONE');
    }
    const controls = await sql<{ status: string }>`
      select status from run_control_requests where run_id = ${runId}
    `.execute(f.app.db);
    assert.equal(controls.rows.length, 1);
    assert.equal(controls.rows[0]?.status, 'APPLIED');
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((run.body as { status: string }).status, 'CANCELLED');
    const taskRow = await sql<{ task_id: string }>`
      select task_id from runs where id = ${runId}`.execute(f.app.db);
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${taskRow.rows[0]!.task_id}`));
    assert.equal((task.body as { status: string }).status, 'READY');
    const versions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from artifact_versions where source_ref like ${`run:${runId}/%`}
    `.execute(f.app.db);
    assert.equal(versions.rows[0]?.count, 1n);
    assert.equal(await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }), undefined);
  } finally { await f.close(); }
});

test('G06 completion-race leftover control is rejected and cannot rewrite a DONE Run', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    const prepared = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(prepared?.outcome, 'DONE');
    await decideAction(f, action.operationId, 'APPROVE');
    const effected = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(effected?.outcome, 'DONE');
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    await approveValidationReview(f, action.runId);
    const completed = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(completed?.outcome, 'DONE');
    const runBefore = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((runBefore.body as { status: string }).status, 'COMPLETED');
    const taskBefore = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((taskBefore.body as { status: string }).status, 'DONE');

    // A cancel that became durable after the last control poll but before the
    // COMPLETE business commit leaves exactly this state: DONE facts plus a
    // PENDING control. The API rejects the same request against a terminal Run,
    // so the leftover row is reconstructed directly with the repository entry.
    const runRow = await sql<{ task_id: string; workspace_id: string }>`
      select task_id, workspace_id from runs where id = ${action.runId}
    `.execute(f.app.db);
    const controlId = randomUUID();
    await withTransaction(f.app.db, async (repositories) => {
      await repositories.recovery.insertControl({ id: controlId,
        workspaceId: runRow.rows[0]!.workspace_id, taskId: runRow.rows[0]!.task_id,
        runId: action.runId, type: 'CANCEL', requestedBy: 'test:completion-race' });
    });
    const converged = await applySafeControl(f.app.db, action.runId);
    assert.equal(converged?.status, 'REJECTED');
    assert.deepEqual(converged?.result_ref, { reason: 'RUN_TERMINAL_OR_STALE' });

    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'COMPLETED');
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((task.body as { status: string }).status, 'DONE');
    const completions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from completion_records where task_id = ${action.taskId}
    `.execute(f.app.db);
    assert.equal(completions.rows[0]?.count, 1n);
    const versions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from artifact_versions where source_ref like ${`run:${action.runId}/%`}
    `.execute(f.app.db);
    assert.equal(versions.rows[0]?.count, 1n);
    assert.equal(await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }), undefined);
  } finally { await f.close(); }
});

/** An older build never wrote the layout channels; blob type 'empty' is how the
 * Saver represents a channel that is absent from a checkpoint. */
async function stripGraphLayoutChannels(db: DbExecutor, runId: string): Promise<void> {
  await sql`update relay_graph_v1.checkpoint_blobs set type = 'empty', blob = null
    where thread_id = ${runId} and channel in ('layoutVersion', 'rebuildLayout')`.execute(db);
}

async function readRunAttempts(db: DbExecutor, runId: string) {
  const rows = await sql<{ step_kind: string; attempt_number: number; attempt_key: string; status: string }>`
    select s.step_kind, a.attempt_number, a.attempt_key, a.status from step_attempts a
    join run_steps s on s.id = a.step_id
    where s.run_id = ${runId} order by s.step_index, a.attempt_number
  `.execute(db);
  return rows.rows;
}

async function readRebuildRecords(db: DbExecutor, taskId: string): Promise<bigint> {
  const rows = await sql<{ count: bigint }>`
    select count(*)::bigint as count from activity_records
    where task_id = ${taskId} and event_type = 'RUN_GRAPH_LAYOUT_REBUILT'
  `.execute(db);
  return rows.rows[0]!.count;
}

test('a Review wait checkpointed by an older graph layout rebuilds and completes the original RESUME', async () => {
  const f = await fixture(true);
  try {
    const runId = await delegatedRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    const runBefore = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((runBefore.body as { status: string }).status, 'WAITING_APPROVAL');
    const attemptsBefore = await readRunAttempts(f.app.db, runId);
    assert.equal(attemptsBefore.filter((row) => row.step_kind === 'COMPLETE').length, 0);
    await stripGraphLayoutChannels(f.app.db, runId);

    await approveValidationReview(f, runId);
    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(delivered?.outcome, 'DONE');

    const attemptsAfter = await readRunAttempts(f.app.db, runId);
    assert.deepEqual(attemptsAfter.filter((row) => row.step_kind !== 'COMPLETE'), attemptsBefore);
    const completeAttempts = attemptsAfter.filter((row) => row.step_kind === 'COMPLETE');
    assert.equal(completeAttempts.length, 1);
    assert.equal(completeAttempts[0]?.status, 'SUCCEEDED');
    const taskRow = await sql<{ task_id: string }>`
      select task_id from runs where id = ${runId}`.execute(f.app.db);
    assert.equal(await readRebuildRecords(f.app.db, taskRow.rows[0]!.task_id), 1n);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${runId}`));
    assert.equal((run.body as { status: string }).status, 'COMPLETED');
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${taskRow.rows[0]!.task_id}`));
    assert.equal((task.body as { status: string }).status, 'DONE');
    const completions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from completion_records where task_id = ${taskRow.rows[0]!.task_id}
    `.execute(f.app.db);
    assert.equal(completions.rows[0]?.count, 1n);
    const versions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from artifact_versions where source_ref like ${`run:${runId}/%`}
    `.execute(f.app.db);
    assert.equal(versions.rows[0]?.count, 1n);
    assert.equal(await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }), undefined);
  } finally { await f.close(); }
});

test('an approved Mock action checkpointed by an older graph layout replays its effect exactly once', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedGatewayRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await stripGraphLayoutChannels(f.app.db, action.runId);
    await decideAction(f, action.operationId, 'APPROVE');

    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(delivered?.outcome, 'DONE');

    const facts = await sql<{ status: string; invocation_count: bigint }>`
      select o.status, count(i.id)::bigint as invocation_count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id
    `.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'SUCCEEDED', invocation_count: 1n });
    assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId, 'u'));
    const attempts = await readRunAttempts(f.app.db, action.runId);
    assert.deepEqual(attempts.filter((row) => row.step_kind !== 'COMPLETE').map((row) =>
      [row.step_kind, row.attempt_number, row.status]), [
      ['BUILD_CONTEXT', 1n, 'SUCCEEDED'], ['DRAFT', 1n, 'SUCCEEDED'],
      ['PERSIST_CANDIDATE', 1n, 'SUCCEEDED'], ['VERIFY', 1n, 'SUCCEEDED'],
    ]);
    assert.equal(await readRebuildRecords(f.app.db, action.taskId), 1n);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((task.body as { status: string }).status, 'WAITING');

    await approveValidationReview(f, action.runId);
    const final = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(final?.outcome, 'DONE');
    const doneRun = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((doneRun.body as { status: string }).status, 'COMPLETED');
    const doneTask = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((doneTask.body as { status: string }).status, 'DONE');
    const completions = await sql<{ count: bigint }>`
      select count(*)::bigint as count from completion_records where task_id = ${action.taskId}
    `.execute(f.app.db);
    assert.equal(completions.rows[0]?.count, 1n);
  } finally { await f.close(); }
});
