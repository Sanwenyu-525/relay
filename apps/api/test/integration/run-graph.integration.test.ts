import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { Client } from 'pg';

import { claimNextRunCommand, settleRunCommand } from '../../src/application/run-dispatch.js';
import type { ClaimedRunCommand } from '../../src/application/run-dispatch.js';
import { denyGraphActionBeforeInvocation, reconcileGatewayInvocation } from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource,
  revokeGatewayPolicy } from '../../src/application/gateway-configuration.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { applySafeControl, requestRunControl, resumeRun } from '../../src/application/control-requests.js';
import { recoverStoppedWorker } from '../../src/application/recover-run.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { publishRunDraftPreview } from '../../src/application/run-draft-preview.js';
import { reviewTargetHash } from '../../src/application/review-requests.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { draftInputHash, loadRunReadEvidence,
  MAX_MODEL_READ_BYTES } from '../../src/application/run-read-evidence.js';
import type { JsonObject, JsonValue } from '../../src/infrastructure/json.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import { graphCheckpointsReady, installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { CANDIDATE_OUTPUT_SCHEMA } from '../../src/workflow/markdown-deliverable.js';
import { extractWebText } from '../../src/web/web-fetch.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { runSupervisedWorkerOnce } from '../../src/worker/supervisor.js';
import { recoverStoppedDesktopLaunch } from '../../src/worker/supervisor.js';
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

async function fixture(install: boolean, apiPoolMax = 4): Promise<Fixture> {
  const database = await createTemporaryDatabase('m03_graph');
  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
    if (install) await installGraphCheckpoints(database.migrationUrl);
    const app = openDatabase(database.appUrl, 'relay-m03-graph-test');
    try {
      const api = await startTestApi({ databaseUrl: database.appUrl,
        databasePoolMax: apiPoolMax });
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

async function delegatedRun(f: Fixture, method: 'HUMAN' | 'SEMANTIC' = 'HUMAN'): Promise<string> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/projects'), {
    command_id: projectCommand, title: `graph-${projectCommand.slice(0, 8)}`,
    project_type: 'GENERAL',
  }), 201, projectCommand);
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: project.project_id,
    title: 'Graph checkpoint replay', objective: 'Verify one managed Mock candidate',
    criteria: [{ criterion_id: method.toLowerCase(), statement: 'Review the candidate', method }],
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

async function workerOnce(f: Fixture, env: Record<string, string> = {}): Promise<{
  code: number | null; output: string }> {
  const child = spawn(process.execPath, [WORKER_ENTRY, '--once'], {
    env: { ...process.env, RELAY_DB_URL: f.database.appUrl,
      RELAY_DATA_ROOT: f.api.dataRoot, RELAY_WORKER_ID: `worker:${randomUUID()}`,
      ...env },
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

async function delegatedFileWriteRun(f: Fixture): Promise<{
  runId: string; root: string; operationId: string; taskId: string;
  delegateCommand: string; expectedTaskRevision: string;
  connectionId: string; resourceId: string;
}> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/projects'), {
    command_id: projectCommand, title: 'Graph FileWrite', project_type: 'GENERAL',
  }), 201, projectCommand);
  const projectId = project.project_id as string;
  const root = join(f.api.dataRoot, `graph-file-write-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(f.app.db, { workspaceId: f.workspaceId,
    projectId, rootPath: root });
  const connection = await createGatewayConnectionCommand(f.app.db, { workspaceId: f.workspaceId,
    projectId, commandId: randomUUID(), capabilities: ['FILE_WRITE'], rootPath: root });
  await createGatewayPolicy(f.app.db, { workspaceId: f.workspaceId, projectId,
    capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET', targetPrefix: resource.canonicalRoot,
    decision: 'AUTO', maxPayloadBytes: 262144 });
  await writeFile(join(root, 'existing.txt'), 'baseline\n');
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: projectId, title: 'Graph approved file write',
    objective: 'Write managed files through the Gateway',
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
    file_write_action: { connection_id: connection.result.connection_id!,
      resource_id: resource.resourceId, changes: [
        { path: 'new.txt', action: 'CREATE', content: 'created\n' },
        { path: 'existing.txt', action: 'MODIFY', content: 'updated\n',
          baselineSha256: createHash('sha256').update('baseline\n').digest('hex') },
      ] },
  }), 202, delegateCommand);
  const runId = delegated.run_id as string;
  const frozen = await sql<{ frozen_snapshot: { file_write_action: { operation_id: string } } }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}`.execute(f.app.db);
  return { runId, root: resource.canonicalRoot, taskId: task.task_id as string,
    operationId: frozen.rows[0]!.frozen_snapshot.file_write_action.operation_id,
    delegateCommand, expectedTaskRevision: ready.revision as string,
    connectionId: connection.result.connection_id!, resourceId: resource.resourceId };
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

test('API pool size one leaves the separate Worker semantic accounting path runnable', async () => {
  const f = await fixture(true, 1);
  try {
    const runId = await delegatedRun(f, 'SEMANTIC');
    const delivered = await workerOnce(f, { RELAY_DB_POOL_MAX: '1' });
    assert.equal(delivered.code, 0, delivered.output);
    const calls = (await sql<{ kind: string; status: string }>`
      select mc.kind, mc.status from model_calls mc
      join step_attempts a on a.id = mc.step_attempt_id
      join run_steps s on s.id = a.step_id
      where s.run_id = ${runId} order by mc.started_at, mc.id
    `.execute(f.app.db)).rows;
    assert.deepEqual(calls, [
      { kind: 'DRAFT', status: 'COMPLETED' },
      { kind: 'SEMANTIC_CHECK', status: 'COMPLETED' },
    ]);
  } finally { await f.close(); }
});

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

test('a frozen file write waits for approval, then keeps one operation and an exact file ledger', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileWriteRun(f);
    const frozen = await sql<{ frozen_snapshot: { file_write_action: {
      operation_id: string; intent_key: string; changes: unknown[] } }; contract_hash: Buffer }>`
      select frozen_snapshot, contract_hash from execution_contracts where run_id = ${action.runId}`
      .execute(f.app.db);
    assert.equal(frozen.rows[0]?.frozen_snapshot.file_write_action.operation_id, action.operationId);
    assert.equal(frozen.rows[0]?.frozen_snapshot.file_write_action.intent_key, 'file-write-v1');
    assert.equal(frozen.rows[0]?.frozen_snapshot.file_write_action.changes.length, 2);
    const reused = await f.api.post(workspacePath(f.workspaceId,
      `/tasks/${action.taskId}/delegations`), {
      command_id: action.delegateCommand, expected_task_revision: action.expectedTaskRevision,
      file_write_action: { connection_id: action.connectionId, resource_id: action.resourceId,
        changes: [{ path: 'new.txt', action: 'CREATE', content: 'different payload' }] },
    });
    assert.equal(reused.status, 409, reused.text);
    assert.equal((reused.body as { code: string }).code, 'COMMAND_ID_REUSED');
    const prepared = await workerOnce(f);
    assert.equal(prepared.code, 0, prepared.output);
    const before = await sql<{ status: string; action_type: string; normalized_target: string;
      step_kind: string;
      invocation_count: bigint }>`
      select o.status, o.action_type, o.normalized_target, s.step_kind,
        count(i.id)::bigint as invocation_count from logical_operations o
      join run_steps s on s.id = o.step_id
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId}
      group by o.id, s.step_kind`.execute(f.app.db);
    assert.deepEqual(before.rows[0], { status: 'WAITING_APPROVAL', action_type: 'APPLY_CHANGESET',
      normalized_target: action.root, step_kind: 'DRAFT', invocation_count: 0n });
    await assert.rejects(readFile(join(action.root, 'new.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(action.root, 'existing.txt'), 'utf8'), 'baseline\n');
    await decideAction(f, action.operationId, 'APPROVE');
    assert.equal((await workerOnce(f)).code, 0);
    assert.equal(await readFile(join(action.root, 'new.txt'), 'utf8'), 'created\n');
    assert.equal(await readFile(join(action.root, 'existing.txt'), 'utf8'), 'updated\n');
    const facts = await sql<{ operation_status: string; invocation_id: string;
      invocation_count: bigint; change_set_status: string; relative_path: string;
      file_status: string; actual_sha256: string }>`
      select o.status as operation_status, i.id as invocation_id,
        (select count(*)::bigint from invocation_attempts where operation_id = o.id) as invocation_count,
        cs.status as change_set_status, cf.relative_path, cf.status as file_status,
        cf.actual_sha256 from logical_operations o
      join invocation_attempts i on i.operation_id = o.id
      join change_sets cs on cs.invocation_id = i.id
      join change_set_files cf on cf.change_set_id = cs.id
      where o.id = ${action.operationId} order by cf.relative_path`.execute(f.app.db);
    assert.deepEqual(facts.rows.map((row) => [row.operation_status, row.invocation_count,
      row.change_set_status, row.relative_path, row.file_status, row.actual_sha256]), [
      ['SUCCEEDED', 1n, 'SUCCEEDED', 'existing.txt', 'APPLIED',
        createHash('sha256').update('updated\n').digest('hex')],
      ['SUCCEEDED', 1n, 'SUCCEEDED', 'new.txt', 'APPLIED',
        createHash('sha256').update('created\n').digest('hex')],
    ]);
    await writeFile(join(action.root, 'new.txt'), 'external-after-success\n');
    assert.equal((await workerOnce(f)).code, 0);
    assert.equal(await readFile(join(action.root, 'new.txt'), 'utf8'), 'external-after-success\n');
    const after = await sql<{ invocation_count: bigint; ledger_count: bigint }>`
      select (select count(*)::bigint from invocation_attempts where operation_id = ${action.operationId})
        as invocation_count,
        (select count(*)::bigint from change_sets where operation_id = ${action.operationId})
        as ledger_count`.execute(f.app.db);
    assert.deepEqual(after.rows[0], { invocation_count: 1n, ledger_count: 1n });
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.notEqual((task.body as { status: string }).status, 'DONE');
  } finally { await f.close(); }
});

test('a frozen file write keeps the baseline conflict after approval', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileWriteRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await writeFile(join(action.root, 'existing.txt'), 'external edit\n');
    await decideAction(f, action.operationId, 'APPROVE');
    assert.equal((await workerOnce(f)).code, 0);
    assert.equal(await readFile(join(action.root, 'existing.txt'), 'utf8'), 'external edit\n');
    const files = await sql<{ relative_path: string; status: string }>`
      select cf.relative_path, cf.status from change_set_files cf
      join change_sets cs on cs.id = cf.change_set_id
      where cs.operation_id = ${action.operationId} order by cf.relative_path`.execute(f.app.db);
    assert.deepEqual(files.rows, [
      { relative_path: 'existing.txt', status: 'CONFLICT' },
      { relative_path: 'new.txt', status: 'APPLIED' },
    ]);
    const blocked = await sql<{ operation_status: string; invocation_status: string;
      claim_status: string; run_status: string; invocation_count: bigint }>`
      select o.status as operation_status, i.status as invocation_status,
        c.status as claim_status, r.status as run_status,
        (select count(*)::bigint from invocation_attempts where operation_id = o.id)
          as invocation_count
      from logical_operations o join runs r on r.id = o.run_id
      join invocation_attempts i on i.operation_id = o.id
      join resource_claims c on c.id = i.resource_claim_id
      where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(blocked.rows[0], { operation_status: 'UNKNOWN', invocation_status: 'UNKNOWN',
      claim_status: 'QUARANTINED', run_status: 'RUNNING', invocation_count: 1n });
    const visible = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal(visible.status, 200);
    assert.deepEqual((visible.body as { unresolved_operation_ids: string[] }).unresolved_operation_ids,
      [action.operationId], 'the quarantined original action must remain visible to the user');
    const identity = await sql<{ id: string; worker_id: string; worker_epoch: bigint }>`
      select id, worker_id, worker_epoch from invocation_attempts
      where operation_id = ${action.operationId}`.execute(f.app.db);
    const reconciled = await reconcileGatewayInvocation(f.app.db, {
      workspaceId: f.workspaceId, operationId: action.operationId,
      invocationId: identity.rows[0]!.id, stoppedWorkerId: identity.rows[0]!.worker_id,
      stoppedWorkerEpoch: identity.rows[0]!.worker_epoch, oldProcessStopped: true,
    });
    assert.equal(reconciled.status, 'UNKNOWN');
    const ledger = await sql<{ status: string }>`select status from change_sets
      where operation_id = ${action.operationId}`.execute(f.app.db);
    assert.equal(ledger.rows[0]?.status, 'PARTIAL', 'recovery must preserve the execution report');
    const successor = await sql<{ status: string; attempts: bigint }>`
      select s.status, count(a.id)::bigint as attempts from run_steps s
      left join step_attempts a on a.step_id = s.id
      where s.run_id = ${action.runId} and s.step_kind = 'PERSIST_CANDIDATE'
      group by s.id`.execute(f.app.db);
    assert.deepEqual(successor.rows[0], { status: 'PENDING', attempts: 0n });
    assert.equal((await workerOnce(f)).code, 0);
    const replayed = await sql<{ count: bigint }>`select count(*)::bigint as count
      from invocation_attempts where operation_id = ${action.operationId}`.execute(f.app.db);
    assert.equal(replayed.rows[0]?.count, 1n, 'a partial write cannot automatically retry');
  } finally { await f.close(); }
});

test('a partial file write needs trusted stop proof and a fresh human snapshot before closure', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileWriteRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await writeFile(join(action.root, 'existing.txt'), 'external edit\n');
    await decideAction(f, action.operationId, 'APPROVE');
    const launchId = randomUUID();
    const workerId = `worker:desktop:${launchId}:${randomUUID()}`;
    assert.equal((await workerOnce(f, { RELAY_WORKER_ID: workerId })).code, 0);
    const route = workspacePath(f.workspaceId,
      `/operations/${action.operationId}/file-write-disposition`);
    const before = await f.api.get(route);
    assert.equal(before.status, 200, before.text);
    assert.equal((before.body as { can_dispose: boolean }).can_dispose, false);
    assert.ok((before.body as { blocking_reasons: string[] }).blocking_reasons
      .includes('TRUSTED_STOP_PROOF_REQUIRED'));
    const invocationId = (before.body as { invocation_id: string }).invocation_id;
    const baseBody = { invocation_id: invocationId,
      decision: 'KEEP_CURRENT_AND_FAIL_RUN',
      expected_run_revision: (before.body as { run_revision: string }).run_revision,
      expected_task_revision: (before.body as { task_revision: string }).task_revision,
      expected_observation_sha256: (before.body as { observation_sha256: string }).observation_sha256 };
    assert.equal((await f.api.post(route, { ...baseBody, command_id: randomUUID() })).status, 409);
    const recovered = await recoverStoppedDesktopLaunch({ db: f.app.db,
      dataRoot: f.api.dataRoot, launchId,
      stopEvidence: 'armed_job_terminated_and_active_count_zero' });
    assert.deepEqual(recovered.blockedRunIds, [action.runId]);
    const preview = await f.api.get(route);
    assert.equal(preview.status, 200, preview.text);
    assert.equal((preview.body as { can_dispose: boolean }).can_dispose, true);
    assert.equal((preview.body as { stop_proof_recorded: boolean }).stop_proof_recorded, true);
    const newFile = join(action.root, 'new.txt');
    const savedFile = join(action.root, 'new.txt.saved');
    await rename(newFile, savedFile);
    await mkdir(newFile);
    const unreadable = await f.api.get(route);
    assert.equal((unreadable.body as { can_dispose: boolean }).can_dispose, false);
    assert.ok((unreadable.body as { blocking_reasons: string[] }).blocking_reasons
      .includes('CURRENT_FILES_UNREADABLE'));
    await rmdir(newFile);
    await rename(savedFile, newFile);
    await writeFile(newFile, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const oversized = await f.api.get(route);
    assert.equal((oversized.body as { can_dispose: boolean }).can_dispose, false);
    assert.ok((oversized.body as { blocking_reasons: string[] }).blocking_reasons
      .includes('CURRENT_FILES_UNREADABLE'), 'unbounded external files cannot be loaded for a decision');
    await writeFile(newFile, 'created\n');
    const freshBody = { ...baseBody,
      expected_run_revision: (preview.body as { run_revision: string }).run_revision,
      expected_task_revision: (preview.body as { task_revision: string }).task_revision,
      expected_observation_sha256: (preview.body as { observation_sha256: string }).observation_sha256 };
    await writeFile(newFile, 'human changed this after review\n');
    assert.equal((await f.api.post(route, { ...freshBody, command_id: randomUUID() })).status, 409,
      'the reviewed file snapshot cannot silently drift');
    const latest = await f.api.get(route);
    assert.equal(latest.status, 200, latest.text);
    const commandId = randomUUID();
    const body = { ...freshBody, command_id: commandId,
      expected_observation_sha256: (latest.body as { observation_sha256: string }).observation_sha256 };
    const closed = expectCommandAccepted(await f.api.post(route, body), 200, commandId);
    assert.equal(closed.run_status, 'FAILED');
    assert.equal(closed.task_status, 'READY');
    assert.equal(await readFile(newFile, 'utf8'), 'human changed this after review\n');
    const replay = expectCommandAccepted(await f.api.post(route, body), 200, commandId);
    assert.equal(replay.disposition_id, closed.disposition_id);
    const history = await f.api.get(route);
    assert.equal((history.body as { disposition: { observation: { files: Array<{
      path: string; current_sha256: string | null }> } } }).disposition.observation.files
      .find((file) => file.path === 'new.txt')?.current_sha256,
    createHash('sha256').update('human changed this after review\n').digest('hex'));
    assert.equal((await f.api.post(route, { ...body, command_id: randomUUID() })).status, 409);
    const facts = await sql<{ operation_status: string; invocation_status: string;
      ledger_status: string; claim_status: string; run_status: string; task_status: string;
      delivery_status: string; outbox_status: string; invocation_count: bigint;
      disposition_count: bigint }>`
      select o.status as operation_status, i.status as invocation_status,
        cs.status as ledger_status, c.status as claim_status, r.status as run_status,
        t.status as task_status, d.status as delivery_status, outbox.status as outbox_status,
        (select count(*)::bigint from invocation_attempts where operation_id = o.id) as invocation_count,
        (select count(*)::bigint from file_write_manual_dispositions where operation_id = o.id) as disposition_count
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      join change_sets cs on cs.invocation_id = i.id
      join resource_claims c on c.id = i.resource_claim_id
      join runs r on r.id = o.run_id join tasks t on t.id = r.task_id
      join run_invocations d on d.run_id = r.id
      join file_write_stop_proofs proof on proof.invocation_id = i.id
      join run_command_outbox outbox on outbox.command_id = proof.command_id
      where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { operation_status: 'MANUALLY_CLOSED',
      invocation_status: 'UNKNOWN', ledger_status: 'PARTIAL', claim_status: 'RELEASED',
      run_status: 'FAILED', task_status: 'READY', delivery_status: 'IDLE',
      outbox_status: 'DONE', invocation_count: 1n, disposition_count: 1n });
    const project = await sql<{ project_id: string }>`select project_id from tasks where id = ${action.taskId}`
      .execute(f.app.db);
    const blockers = await createRepositories(f.app.db).projects.listArchiveBlockers(project.rows[0]!.project_id);
    assert.equal(blockers.includes('UNKNOWN_EFFECT'), false,
      'the disposed historical UNKNOWN is no longer an active archive blocker');
    assert.equal((await workerOnce(f)).code, 0);
    const count = await sql<{ count: bigint }>`select count(*)::bigint as count
      from invocation_attempts where operation_id = ${action.operationId}`.execute(f.app.db);
    assert.equal(count.rows[0]?.count, 1n, 'the old action cannot be replayed after closure');
  } finally { await f.close(); }
});

test('a killed Windows helper with no receipt requires observed residuals and a fresh human decision',
  { skip: process.platform !== 'win32' || !process.env.RELAY_FILE_IO_DEBUG_HELPER }, async () => {
    const f = await fixture(true);
    try {
      const action = await delegatedFileWriteRun(f);
      assert.equal((await workerOnce(f)).code, 0);
      await decideAction(f, action.operationId, 'APPROVE');
      const launchId = randomUUID();
      const workerId = `worker:desktop:${launchId}:${randomUUID()}`;
      const ready = join(f.api.dataRoot, `file-io-gap-${randomUUID()}.ready`);
      const release = join(f.api.dataRoot, `file-io-gap-${randomUUID()}.release`);
      const running = workerOnce(f, { RELAY_WORKER_ID: workerId,
        RELAY_FILE_IO_HELPER: process.env.RELAY_FILE_IO_DEBUG_HELPER!,
        RELAY_FILE_IO_TEST_STAGE: 'gap', RELAY_FILE_IO_TEST_READY: ready,
        RELAY_FILE_IO_TEST_RELEASE: release });
      let helperPid: number | null = null;
      for (let attempt = 0; attempt < 500; attempt++) {
        try {
          helperPid = Number(await readFile(ready, 'utf8'));
          break;
        } catch { await delay(10); }
      }
      assert.ok(helperPid !== null && Number.isSafeInteger(helperPid) && helperPid > 0,
        'debug helper did not reach the backup rename gap');
      assert.equal(await readFile(join(action.root, 'new.txt'), 'utf8'), 'created\n');
      await assert.rejects(readFile(join(action.root, 'existing.txt')),
        { code: 'ENOENT' });
      process.kill(helperPid);
      const stopped = await running;
      assert.equal(stopped.code, 1, stopped.output);
      assert.match(stopped.output, /worker_failed/u);
      const names = (await readdir(action.root)).filter((name) =>
        name.startsWith('.__relay-file-io-'));
      assert.equal(names.length, 2, 'the original and staged bytes must remain observable');
      const route = workspacePath(f.workspaceId,
        `/operations/${action.operationId}/file-write-disposition`);
      const before = await f.api.get(route);
      assert.equal(before.status, 200, before.text);
      assert.equal((before.body as { can_dispose: boolean }).can_dispose, false);
      assert.ok((before.body as { blocking_reasons: string[] }).blocking_reasons
        .includes('TRUSTED_STOP_PROOF_REQUIRED'));
      const recovered = await recoverStoppedDesktopLaunch({ db: f.app.db,
        dataRoot: f.api.dataRoot, launchId,
        stopEvidence: 'armed_job_terminated_and_active_count_zero' });
      assert.deepEqual(recovered.blockedRunIds, [action.runId]);
      const preview = await f.api.get(route);
      assert.equal(preview.status, 200, preview.text);
      const observed = preview.body as { can_dispose: boolean; observation_mode: string;
        observation_sha256: string; invocation_id: string; run_revision: string;
        task_revision: string; files: Array<{ relative_path: string;
          current_sha256: string | null; current_target_id: string | null;
          residual_candidates: Array<{ path: string; sha256: string; id: string }> }> };
      assert.equal(observed.can_dispose, true, preview.text);
      assert.equal(observed.observation_mode, 'NO_RECEIPT');
      const missing = observed.files.find((file) => file.relative_path === 'existing.txt');
      assert.ok(missing);
      assert.equal(missing.current_target_id, null);
      assert.equal(missing.current_sha256, null);
      assert.equal(missing.residual_candidates.length, 2);
      assert.deepEqual(new Set(missing.residual_candidates.map((candidate) => candidate.path)),
        new Set(names));
      const command = { command_id: randomUUID(), invocation_id: observed.invocation_id,
        decision: 'KEEP_CURRENT_AND_FAIL_RUN', expected_run_revision: observed.run_revision,
        expected_task_revision: observed.task_revision,
        expected_observation_sha256: observed.observation_sha256 };
      await writeFile(join(action.root, names[0]!), 'human changed candidate\n');
      assert.equal((await f.api.post(route, command)).status, 409,
        'a changed residual invalidates the reviewed snapshot');
      const latest = await f.api.get(route);
      assert.equal(latest.status, 200, latest.text);
      const current = latest.body as typeof observed;
      assert.notEqual(current.observation_sha256, observed.observation_sha256);
      const closeCommandId = randomUUID();
      const committed = expectCommandAccepted(await f.api.post(route, {
        ...command, command_id: closeCommandId,
        expected_observation_sha256: current.observation_sha256,
      }), 200, closeCommandId);
      assert.equal(committed.run_status, 'FAILED');
      assert.equal(committed.task_status, 'READY');
      assert.deepEqual((await readdir(action.root)).filter((name) =>
        name.startsWith('.__relay-file-io-')).sort(), names.sort());
      await assert.rejects(readFile(join(action.root, 'existing.txt')),
        { code: 'ENOENT' });
      assert.equal(await readFile(join(action.root, 'new.txt'), 'utf8'), 'created\n');
      assert.equal((await workerOnce(f)).code, 0);
      const facts = await sql<{ operation_status: string; invocation_status: string;
        ledger_status: string; claim_status: string; invocation_count: bigint }>`
        select o.status as operation_status, i.status as invocation_status,
          cs.status as ledger_status, c.status as claim_status,
          (select count(*)::bigint from invocation_attempts where operation_id = o.id)
            as invocation_count
        from logical_operations o join invocation_attempts i on i.operation_id = o.id
        join change_sets cs on cs.invocation_id = i.id
        join resource_claims c on c.id = i.resource_claim_id
        where o.id = ${action.operationId}`.execute(f.app.db);
      assert.deepEqual(facts.rows[0], { operation_status: 'MANUALLY_CLOSED',
        invocation_status: 'UNKNOWN', ledger_status: 'UNKNOWN',
        claim_status: 'RELEASED', invocation_count: 1n });
      const history = await f.api.get(route);
      assert.equal((history.body as { disposition: { observation: {
        observation_mode: string } } }).disposition.observation.observation_mode,
      'NO_RECEIPT');
    } finally { await f.close(); }
  });

test('an all-conflict file write fails its Run without leaving a quarantined resource', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileWriteRun(f);
    assert.equal((await workerOnce(f)).code, 0);
    await writeFile(join(action.root, 'new.txt'), 'occupied\n');
    await writeFile(join(action.root, 'existing.txt'), 'external edit\n');
    await decideAction(f, action.operationId, 'APPROVE');
    assert.equal((await workerOnce(f)).code, 0);
    const facts = await sql<{ operation_status: string; invocation_status: string;
      claim_status: string; run_status: string; invocation_count: bigint }>`
      select o.status as operation_status, i.status as invocation_status,
        c.status as claim_status, r.status as run_status,
        (select count(*)::bigint from invocation_attempts where operation_id = o.id)
          as invocation_count
      from logical_operations o join runs r on r.id = o.run_id
      join invocation_attempts i on i.operation_id = o.id
      join resource_claims c on c.id = i.resource_claim_id
      where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { operation_status: 'FAILED', invocation_status: 'FAILED',
      claim_status: 'RELEASED', run_status: 'FAILED', invocation_count: 1n });
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((task.body as { status: string }).status, 'READY');
    assert.equal(await readFile(join(action.root, 'new.txt'), 'utf8'), 'occupied\n');
    assert.equal(await readFile(join(action.root, 'existing.txt'), 'utf8'), 'external edit\n');
  } finally { await f.close(); }
});

test('Delegate rejects mixed file write intents and invalid frozen changes before creating a Run', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileWriteRun(f);
    const source = await sql<{ project_id: string; file_write_action: {
      connection_id: string; resource_id: string } }>`
      select t.project_id, ec.frozen_snapshot->'file_write_action' as file_write_action
      from tasks t join runs r on r.task_id = t.id
      join execution_contracts ec on ec.run_id = r.id where r.id = ${action.runId}`.execute(f.app.db);
    const projectId = source.rows[0]!.project_id;
    const { connection_id, resource_id } = source.rows[0]!.file_write_action;
    const taskCommand = randomUUID();
    const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
      command_id: taskCommand, project_id: projectId, title: 'Reject mixed frozen actions',
      objective: 'Keep the input boundary explicit',
      criteria: [{ criterion_id: 'human', statement: 'Review', method: 'HUMAN' }],
    }), 201, taskCommand);
    const readyCommand = randomUUID();
    const ready = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
      `/tasks/${task.task_id as string}/ready`), {
      command_id: readyCommand, expected_revision: task.revision,
    }), 200, readyCommand);
    const common = { connection_id, resource_id };
    const otherProjectCommand = randomUUID();
    const otherProject = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId,
      '/projects'), { command_id: otherProjectCommand, title: 'Other file project',
      project_type: 'GENERAL' }), 201, otherProjectCommand);
    const otherRoot = join(f.api.dataRoot, `graph-other-resource-${randomUUID()}`);
    await mkdir(otherRoot, { recursive: true });
    const otherResource = await registerManagedResource(f.app.db, { workspaceId: f.workspaceId,
      projectId: otherProject.project_id as string, rootPath: otherRoot });
    const invalid = [
      { file_write_action: { ...common, changes: [{ path: 'a.txt', action: 'CREATE', content: 'x' }] },
        web_fetch_action: { connection_id, url: 'https://example.com/' } },
      { file_write_action: { ...common, changes: [
        { path: 'dir/../a.txt', action: 'CREATE', content: 'x' },
        { path: 'a.txt', action: 'CREATE', content: 'y' },
      ] } },
      { file_write_action: { ...common, changes: [
        { path: 'a.txt', action: 'CREATE', content: 'x', targetSha256: '0'.repeat(64) },
      ] } },
      { file_write_action: { ...common, changes: [
        { path: 'a.txt', action: 'MODIFY', content: 'x' },
      ] } },
      { file_write_action: { ...common, resource_id: otherResource.resourceId,
        changes: [{ path: 'a.txt', action: 'CREATE', content: 'x' }] } },
    ];
    for (const extra of invalid) {
      const response = await f.api.post(workspacePath(f.workspaceId,
        `/tasks/${task.task_id as string}/delegations`), {
        command_id: randomUUID(), expected_task_revision: ready.revision, ...extra,
      });
      assert.equal(response.status, 409, response.text);
      assert.equal((response.body as { code: string }).code, 'INVALID_TRANSITION');
    }
    const runs = await sql<{ count: bigint }>`select count(*)::bigint as count from runs
      where task_id = ${task.task_id as string}`.execute(f.app.db);
    assert.equal(runs.rows[0]?.count, 0n);
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
  ['manifest row missing', async (f, _migrationDb, runId) => {
    // Only the isolated test-cluster admin may bypass the model-call FK to
    // simulate physical corruption; the production migrator cannot delete it.
    const admin = openDatabase(f.database.adminUrl, 'relay-m03-manifest-corruption-admin');
    try {
      await admin.db.transaction().execute(async (transaction) => {
        await sql`set local session_replication_role = replica`.execute(transaction);
        await sql`delete from context_manifests where run_id = ${runId}`.execute(transaction);
      });
    } finally {
      await admin.close();
    }
  }],
  ['contract source content tampered', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      const contractSource = (payload.sources as WritableJsonObject[])
        .find((source) => source.kind === 'CONTRACT');
      assert.ok(contractSource);
      contractSource.content = '{"workflow":{"version":"tampered"}}';
    });
  }],
  ['contract source self-consistent tamper', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      const contractSource = (payload.sources as WritableJsonObject[])
        .find((source) => source.kind === 'CONTRACT');
      assert.ok(contractSource);
      contractSource.content = '{"workflow":{"version":"self-consistent"}}';
      const digest = createHash('sha256').update(String(contractSource.content), 'utf8').digest('hex');
      contractSource.sha256 = digest;
      contractSource.source_sha256 = digest;
    });
  }],
  ['project source content tampered', async (f, migrationDb, runId) => {
    await rewriteManifestPayload(f, migrationDb, runId, (payload) => {
      const projectSource = (payload.sources as WritableJsonObject[])
        .find((source) => source.kind === 'PROJECT');
      assert.ok(projectSource);
      projectSource.content = '{"id":"tampered"}';
    });
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

async function delegatedFileReadRun(f: Fixture, decision: 'AUTO' | 'ASK' = 'ASK'): Promise<{
  runId: string; taskId: string; root: string; operationId: string;
  connectionId: string; resourceId: string; targetPath: string;
}> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/projects'), {
    command_id: projectCommand, title: 'Graph FileRead', project_type: 'GENERAL',
  }), 201, projectCommand);
  const projectId = project.project_id as string;
  const root = join(f.api.dataRoot, `graph-file-read-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(f.app.db, { workspaceId: f.workspaceId,
    projectId, rootPath: root });
  const connection = await createGatewayConnectionCommand(f.app.db, { workspaceId: f.workspaceId,
    projectId, commandId: randomUUID(), capabilities: ['FILE_READ'], rootPath: root });
  const policy = await createGatewayPolicy(f.app.db, { workspaceId: f.workspaceId, projectId,
    capability: 'FILE_READ', actionType: 'READ_FILE', targetPrefix: resource.canonicalRoot,
    decision, maxPayloadBytes: 1024 });
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: projectId, title: 'Graph approved file read',
    objective: 'Read a managed file through the Gateway',
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
    file_read_action: { connection_id: connection.result.connection_id!,
      resource_id: resource.resourceId, relative_target: 'read-target.txt' },
  }), 202, delegateCommand);
  const runId = delegated.run_id as string;
  const contract = await sql<{ frozen_snapshot: { file_read_action: { operation_id: string } } }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}`.execute(f.app.db);
  return { runId, taskId: task.task_id as string, root: resource.canonicalRoot,
    operationId: contract.rows[0]!.frozen_snapshot.file_read_action.operation_id,
    connectionId: connection.result.connection_id!, resourceId: resource.resourceId,
    targetPath: join(resource.canonicalRoot, 'read-target.txt') };
}

async function deliverWithReadPreview(f: Fixture, runId: string,
  revokeAfterPreview = false) {
  let claim: ClaimedRunCommand | undefined;
  let revocationError: unknown;
  const delivery = runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
    dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl,
    fakeModelDelayMs: 2_500, onClaim: async (value) => { claim = value; } });
  try {
    const current = await withTimeout((async () => {
      for (;;) {
        const rows = await sql<{ call_id: string; manifest_id: string;
          input_sha256: string; attempt_id: string; claim_epoch: bigint;
          step_id: string; worker_epoch: bigint; worker_id: string }>`
          select c.id as call_id, c.manifest_id, c.input_sha256,
            a.id as attempt_id, a.claim_epoch, s.id as step_id,
            r.worker_epoch, r.worker_id
          from model_calls c
          join step_attempts a on a.id = c.step_attempt_id
          join run_steps s on s.id = a.step_id
          join runs r on r.id = s.run_id
          where s.run_id = ${runId} and c.kind = 'DRAFT' and c.status = 'STARTED'
          order by c.started_at desc limit 1`.execute(f.app.db);
        if (rows.rows[0] !== undefined) return rows.rows[0];
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(), 8_000, 'read-first DRAFT model call');
    assert.ok(claim);
    assert.equal(await publishRunDraftPreview(f.app.db, {
      workspaceId: f.workspaceId, runId, stepId: current.step_id,
      attemptId: current.attempt_id, attemptClaimEpoch: current.claim_epoch,
      runWorkerEpoch: current.worker_epoch, workerId: current.worker_id,
      invocationEpoch: claim.epoch, modelCallId: current.call_id,
      manifestId: current.manifest_id, inputHash: current.input_sha256,
      text: '# 受控读入生成中的预览', truncated: false,
    }), true);
    const response = await f.api.get(workspacePath(f.workspaceId,
      `/runs/${runId}/draft-preview`));
    assert.equal(response.status, 200, response.text);
    assert.equal((response.body as { preview_text: string | null }).preview_text,
      '# 受控读入生成中的预览');
    assert.equal((response.body as { preview_available: boolean }).preview_available, true);
    if (revokeAfterPreview) {
      const operation = (await sql<{ id: string; policy_id: string }>`
        select id, policy_id from logical_operations where run_id = ${runId}
        and capability_key in ('FILE_READ', 'WEB_FETCH') limit 1`
        .execute(f.app.db)).rows[0]!;
      await revokeGatewayPolicy(f.app.db, { workspaceId: f.workspaceId,
        policyId: operation.policy_id });
      const hidden = await f.api.get(workspacePath(f.workspaceId,
        `/runs/${runId}/draft-preview`));
      assert.equal(hidden.status, 200, hidden.text);
      assert.equal((hidden.body as { preview_available: boolean }).preview_available, false);
      assert.equal((hidden.body as { preview_text: string | null }).preview_text, null);
      assert.equal(JSON.stringify(hidden.body).includes(operation.id), false);
    }
  } finally {
    if (revokeAfterPreview) {
      try { await delivery; } catch (error) { revocationError = error; }
    } else await delivery;
  }
  if (revokeAfterPreview) {
    assert.equal((revocationError as { code?: string } | undefined)?.code,
      'INVALID_TRANSITION');
    return undefined;
  }
  return delivery;
}

test('an AUTO frozen file-read intent reads the real file once and records hash evidence', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'AUTO');
    await writeFile(action.targetPath, '受控读取的图内正文', 'utf8');
    const delivered = await deliverWithReadPreview(f, action.runId);
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint; content: string; sha256: string }>`
      select o.status, count(i.id)::bigint as invocation_count,
        (i.result_ref->>'content') as content, (i.result_ref->>'sha256') as sha256
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id, i.result_ref`.execute(f.app.db);
    assert.equal(facts.rows.length, 1);
    assert.equal(facts.rows[0]?.status, 'SUCCEEDED');
    assert.equal(facts.rows[0]?.invocation_count, 1n);
    assert.equal(facts.rows[0]?.content, '受控读取的图内正文');
    assert.equal(facts.rows[0]?.sha256,
      createHash('sha256').update('受控读取的图内正文', 'utf8').digest('hex'));
    const bound = await sql<{ step_kind: string; invocation_id: string; input_sha256: string;
      draft_input_sha256: string }>`
      select s.step_kind, i.id as invocation_id, mc.input_sha256,
        a.result_ref->>'input_sha256' as draft_input_sha256
      from logical_operations o join run_steps s on s.id = o.step_id
      join invocation_attempts i on i.operation_id = o.id
      join model_calls mc on mc.read_operation_id = o.id and mc.read_invocation_id = i.id
      join step_attempts a on a.id = mc.step_attempt_id
      where o.id = ${action.operationId}`.execute(f.app.db);
    assert.equal(bound.rows.length, 1);
    assert.equal(bound.rows[0]!.step_kind, 'BUILD_CONTEXT');
    assert.equal(bound.rows[0]!.input_sha256, bound.rows[0]!.draft_input_sha256);
    const manifest = await sql<{ payload: JsonObject }>`select payload from context_manifests
      where run_id = ${action.runId}`.execute(f.app.db);
    const read = await loadRunReadEvidence(createRepositories(f.app.db), action.runId);
    assert.ok(read);
    assert.equal(read.invocationId, bound.rows[0]!.invocation_id);
    assert.equal(read.input.content, '受控读取的图内正文');
    assert.equal(read.input.trust, 'UNTRUSTED_DATA');
    assert.equal(bound.rows[0]!.input_sha256, draftInputHash(
      { ...manifest.rows[0]!.payload, tool_read: read.input }, CANDIDATE_OUTPUT_SCHEMA));
    assert.equal(await readFile(action.targetPath, 'utf8'), '受控读取的图内正文',
      'a read must never modify its target');
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
    const attempts = await sql<{ step_kind: string; count: bigint }>`
      select s.step_kind, count(a.id)::bigint as count from step_attempts a
      join run_steps s on s.id = a.step_id
      where s.run_id = ${action.runId} and s.step_kind in ('BUILD_CONTEXT', 'DRAFT')
      group by s.step_kind`.execute(f.app.db);
    assert.deepEqual(attempts.rows.map((row) => [row.step_kind, row.count]),
      [['BUILD_CONTEXT', 1n], ['DRAFT', 1n]]);

    await approveValidationReview(f, action.runId);
    const final = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(final?.outcome, 'DONE');
    const doneRun = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((doneRun.body as { status: string }).status, 'COMPLETED');
  } finally { await f.close(); }
});

test('revoking the completed FILE_READ policy hides its in-flight DRAFT preview', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'AUTO');
    await writeFile(action.targetPath, '稍后撤销的受管文件', 'utf8');
    await deliverWithReadPreview(f, action.runId, true);
  } finally { await f.close(); }
});

test('an ASK frozen file-read intent waits, and only the approved RESUME reads once', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'ASK');
    await writeFile(action.targetPath, '批准后的读取正文', 'utf8');
    const prepared = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    if (prepared === undefined) {
      const diag = await sql`select c.kind, o.status from run_commands c
        join run_command_outbox o on o.command_id = c.id where c.run_id = ${action.runId}`.execute(f.app.db);
      process.stderr.write(`ASK_DIAG ${JSON.stringify(diag.rows)}
`);
    }
    assert.equal(prepared?.outcome, 'DONE');
    const beforeFacts = await sql<{ status: string; invocation_count: bigint }>`
      select o.status, count(i.id)::bigint as invocation_count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id`.execute(f.app.db);
    assert.deepEqual(beforeFacts.rows[0], { status: 'WAITING_APPROVAL', invocation_count: 0n });
    const beforeDraft = await sql<{ count: bigint }>`select count(*)::bigint as count
      from step_attempts a join run_steps s on s.id = a.step_id
      where s.run_id = ${action.runId} and s.step_kind = 'DRAFT'`.execute(f.app.db);
    assert.equal(beforeDraft.rows[0]?.count, 0n, 'ASK must precede model generation');
    await decideAction(f, action.operationId, 'APPROVE');
    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    if (delivered === undefined) {
      const diag = await sql`select c.kind, c.ordinal, o.status as outbox, r.status as run_status,
        (select count(*) from review_requests rr where rr.run_id = ${action.runId}) as reviews
        from run_commands c join run_command_outbox o on o.command_id = c.id
        join runs r on r.id = c.run_id where c.run_id = ${action.runId}`.execute(f.app.db);
      process.stderr.write(`RESUME_DIAG ${JSON.stringify(diag.rows, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}
`);
    }
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint; content: string }>`
      select o.status, count(i.id)::bigint as invocation_count,
        (i.result_ref->>'content') as content
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id, i.result_ref`.execute(f.app.db);
    assert.equal(facts.rows.length, 1);
    assert.deepEqual(facts.rows[0], { status: 'SUCCEEDED', invocation_count: 1n,
      content: '批准后的读取正文' });
    const modelCalls = await sql<{ operation_id: string; invocation_id: string;
      status: string }>`select read_operation_id as operation_id,
        read_invocation_id as invocation_id, status from model_calls
        where step_attempt_id in (select a.id from step_attempts a
          join run_steps s on s.id = a.step_id
          where s.run_id = ${action.runId} and s.step_kind = 'DRAFT')`.execute(f.app.db);
    assert.deepEqual(modelCalls.rows, [{ operation_id: action.operationId,
      invocation_id: (await sql<{ id: string }>`select id from invocation_attempts
        where operation_id = ${action.operationId}`.execute(f.app.db)).rows[0]!.id,
      status: 'COMPLETED' }]);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
  } finally { await f.close(); }
});

test('a long UTF-8 file read is budgeted before DRAFT and retains the full capture hash', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'AUTO');
    const content = '😀'.repeat(8_000);
    await writeFile(action.targetPath, content, 'utf8');
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const read = await loadRunReadEvidence(createRepositories(f.app.db), action.runId);
    assert.ok(read);
    assert.equal(read.input.content_bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(read.input.source_sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(read.input.input_truncated, true);
    assert.ok((read.input.included_bytes as number) <= MAX_MODEL_READ_BYTES);
    assert.equal((read.input.content as string).includes('\ufffd'), false,
      'UTF-8 cut must never create a replacement character');
    const call = await sql<{ input_sha256: string; read_operation_id: string }>`
      select input_sha256, read_operation_id from model_calls
      where read_operation_id = ${action.operationId}`.execute(f.app.db);
    assert.equal(call.rows.length, 1);
    assert.equal(call.rows[0]!.read_operation_id, action.operationId);
    assert.match(call.rows[0]!.input_sha256, /^[0-9a-f]{64}$/u);
  } finally { await f.close(); }
});

test('a typed failed file read releases execution without starting DRAFT', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'AUTO');
    await writeFile(action.targetPath, 'x'.repeat(128 * 1024 + 1), 'utf8');
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const facts = await sql<{ status: string; reason: string; invocation_id: string;
      invocation_status: string; run_status: string; wait_reason: string; worker_id: string | null;
      task_status: string; executor_run_id: string | null; draft_count: bigint }>`
      select o.status, o.result_ref->>'reason' as reason, i.id as invocation_id,
        i.status as invocation_status, r.status as run_status, r.wait_reason,
        r.worker_id, t.status as task_status, t.executor_run_id,
        (select count(*)::bigint from model_calls mc join step_attempts a
          on a.id = mc.step_attempt_id join run_steps s on s.id = a.step_id
          where s.run_id = r.id and s.step_kind = 'DRAFT') as draft_count
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      join runs r on r.id = o.run_id join tasks t on t.id = r.task_id
      where o.id = ${action.operationId}`.execute(f.app.db);
    assert.equal(facts.rows.length, 1);
    assert.equal(facts.rows[0]?.status, 'FAILED');
    assert.equal(facts.rows[0]?.reason, 'FILE_TOO_LARGE');
    assert.equal(facts.rows[0]?.invocation_status, 'FAILED');
    assert.ok(facts.rows[0]?.invocation_id);
    assert.equal(facts.rows[0]?.run_status, 'FAILED');
    assert.equal(facts.rows[0]?.wait_reason, 'FILE_TOO_LARGE');
    assert.equal(facts.rows[0]?.worker_id, null);
    assert.equal(facts.rows[0]?.task_status, 'READY');
    assert.equal(facts.rows[0]?.executor_run_id, null);
    assert.equal(facts.rows[0]?.draft_count, 0n);
  } finally { await f.close(); }
});

test('a revoked ASK file-read source does not invoke the model after approval', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'ASK');
    await writeFile(action.targetPath, '未授权正文', 'utf8');
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const policy = await sql<{ policy_id: string }>`select policy_id from logical_operations
      where id = ${action.operationId}`.execute(f.app.db);
    await revokeGatewayPolicy(f.app.db, { workspaceId: f.workspaceId,
      policyId: policy.rows[0]!.policy_id });
    await decideAction(f, action.operationId, 'APPROVE');
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint; model_count: bigint }>`
      select o.status, (select count(*)::bigint from invocation_attempts i
        where i.operation_id = o.id) as invocation_count,
        (select count(*)::bigint from model_calls mc join step_attempts a
          on a.id = mc.step_attempt_id join run_steps s on s.id = a.step_id
          where s.run_id = o.run_id and mc.kind = 'DRAFT') as model_count
      from logical_operations o where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'DENIED', invocation_count: 0n,
      model_count: 0n });
  } finally { await f.close(); }
});

test('a read crash after the adapter call resumes the original action before drafting', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'AUTO');
    await writeFile(action.targetPath, '崩溃后读取正文', 'utf8');
    const stopped = await runSupervisedWorkerOnce({ db: f.app.db,
      databaseUrl: f.database.appUrl, dataRoot: f.api.dataRoot,
      testExitAfterGatewayEffect: true });
    assert.equal(stopped.exitCode, 97, stopped.output);
    assert.deepEqual(stopped.requeuedRunIds, [action.runId]);
    const before = await sql<{ status: string; invocation_count: bigint;
      draft_count: bigint }>`select o.status,
        (select count(*)::bigint from invocation_attempts i where i.operation_id = o.id)
          as invocation_count,
        (select count(*)::bigint from model_calls mc join step_attempts a
          on a.id = mc.step_attempt_id join run_steps s on s.id = a.step_id
          where s.run_id = o.run_id and mc.kind = 'DRAFT') as draft_count
        from logical_operations o where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(before.rows[0], { status: 'SUCCEEDED', invocation_count: 1n,
      draft_count: 0n });
    assert.equal((await workerOnce(f)).code, 0);
    const after = await sql<{ status: string; invocation_count: bigint;
      draft_count: bigint }>`select o.status,
        (select count(*)::bigint from invocation_attempts i where i.operation_id = o.id)
          as invocation_count,
        (select count(*)::bigint from model_calls mc join step_attempts a
          on a.id = mc.step_attempt_id join run_steps s on s.id = a.step_id
          where s.run_id = o.run_id and mc.kind = 'DRAFT') as draft_count
        from logical_operations o where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(after.rows[0], { status: 'SUCCEEDED', invocation_count: 1n,
      draft_count: 1n });
  } finally { await f.close(); }
});

test('a persisted legacy DRAFT and approved read Review resume on the original DRAFT step', async () => {
  const f = await fixture(true);
  const migrator = openDatabase(f.database.migrationUrl, 'relay-legacy-read-fixture');
  try {
    const action = await delegatedFileReadRun(f, 'ASK');
    await writeFile(action.targetPath, '旧 Run 读取正文', 'utf8');
    assert.equal((await advanceRunStep(f.app.db, { runId: action.runId,
      workerId: `legacy:${randomUUID()}`,
      storage: new ManagedContentStore(f.api.dataRoot) })).status, 'STEP_SUCCEEDED');
    const legacyContent = '# 旧 Run 候选\n\n## 摘要\n\n升级前草稿。\n\n## 结论\n\n保留原草稿。\n';
    await sql`update run_steps set status = 'SUCCEEDED', revision = revision + 1,
      result_ref = ${JSON.stringify({ kind: 'CONTENT', content: legacyContent })}::jsonb
      where run_id = ${action.runId} and step_kind = 'DRAFT'`.execute(migrator.db);
    await sql`update runs set status = 'RUNNING', revision = revision + 1
      where id = ${action.runId}`.execute(migrator.db);
    const draft = await sql<{ id: string }>`select id from run_steps
      where run_id = ${action.runId} and step_kind = 'DRAFT'`.execute(f.app.db);
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const waiting = await sql<{ status: string; step_id: string }>`select status, step_id
      from logical_operations where id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(waiting.rows[0], { status: 'WAITING_APPROVAL', step_id: draft.rows[0]!.id });
    await decideAction(f, action.operationId, 'APPROVE');
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const result = await sql<{ status: string; step_id: string; invocation_count: bigint;
      draft_content: string; model_count: bigint }>`select o.status, o.step_id,
      (select count(*)::bigint from invocation_attempts i where i.operation_id = o.id)
        as invocation_count,
      (select s.result_ref->>'content' from run_steps s where s.run_id = o.run_id
        and s.step_kind = 'DRAFT') as draft_content,
      (select count(*)::bigint from model_calls mc join step_attempts a
        on a.id = mc.step_attempt_id join run_steps s on s.id = a.step_id
        where s.run_id = o.run_id and mc.kind = 'DRAFT') as model_count
      from logical_operations o where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(result.rows[0], { status: 'SUCCEEDED', step_id: draft.rows[0]!.id,
      invocation_count: 1n, draft_content: legacyContent, model_count: 0n });
  } finally { await migrator.close(); await f.close(); }
});

test('a context change during an ASK file-read wait denies the original operation before any read', async () => {
  const f = await fixture(true);
  try {
    const action = await delegatedFileReadRun(f, 'ASK');
    await writeFile(action.targetPath, '不应被读取的正文', 'utf8');
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    await sql`update tasks set title = 'Changed during file-read approval wait', revision = revision + 1
      where id = ${action.taskId}`.execute(f.app.db);
    await decideAction(f, action.operationId, 'APPROVE');
    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint }>`
      select o.status, count(i.id)::bigint as invocation_count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id`.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'DENIED', invocation_count: 0n });
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'FAILED');
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((task.body as { status: string }).status, 'READY');
  } finally { await f.close(); }
});

test('a missing file read target fails the delivery deterministically and succeeds once the file exists', async () => {
  const f = await fixture(true);
  let claim: ClaimedRunCommand | undefined;
  try {
    const action = await delegatedFileReadRun(f, 'AUTO');
    // The frozen target does not exist yet: prepare refuses deterministically
    // before any operation row or invocation, and the delivery fails.
    await assert.rejects(
      runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
        dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl,
        onClaim: async (captured) => { claim = captured; } }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error &&
        (error as { code: string }).code === 'GATEWAY_TARGET_DENIED');
    const operations = await sql<{ count: bigint }>`
      select count(*)::bigint as count from logical_operations where run_id = ${action.runId}`.execute(f.app.db);
    assert.equal(operations.rows[0]?.count, 0n, 'no operation row is created for a refused target');
    assert.equal(await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`)).then(
      (run) => (run.body as { status: string }).status), 'RUNNING');

    // The supervisor would fence the stopped claim, requeue the same command,
    // and the next delivery succeeds once the file exists.
    assert.ok(claim);
    await recoverStoppedWorker(f.app.db, { runId: action.runId, stoppedWorkerId: claim.workerId,
      stoppedEvidence: 'test: file read target missing',
      storage: new ManagedContentStore(f.api.dataRoot) });
    await withTransaction(f.app.db, async (repositories) => {
      await repositories.runs.lockRun(action.runId);
      await repositories.dispatch.lockInvocation(action.runId);
      await repositories.dispatch.lockOutbox(claim!.commandId);
      await repositories.dispatch.requeueStoppedClaim(action.runId, claim!.workerId,
        claim!.epoch, claim!.commandId, 'test: file read target missing');
    });
    await writeFile(action.targetPath, '迟到的正文', 'utf8');
    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint; content: string }>`
      select o.status, count(i.id)::bigint as invocation_count, (i.result_ref->>'content') as content
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id, i.result_ref`.execute(f.app.db);
    assert.equal(facts.rows.length, 1);
    assert.equal(facts.rows[0]?.status, 'SUCCEEDED');
    assert.equal(facts.rows[0]?.content, '迟到的正文');
  } finally { await f.close(); }
});

const WEB_PAGE_BODY = '<!DOCTYPE html><html><head><script>evil()</script><style>.x{}</style></head>' +
  '<body><h1>图内网页读</h1><p>正文段落 &amp; 更多</p><!-- 注释 --><p>第二段</p></body></html>';

interface PageServer {
  url(path: string): string;
  close(): Promise<void>;
}

function startPageServer(): Promise<PageServer> {
  return new Promise((resolve, reject) => {
    let server: Server | undefined;
    const done = (error?: unknown): void => {
      if (server === undefined) reject(error ?? new Error('page server failed'));
    };
    server = createServer((request, response) => {
      if ((request.url ?? '/') === '/ok') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(WEB_PAGE_BODY);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
    server.once('error', done);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: (path: string) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done2, fail) => server!.close((error) => error ? fail(error) : done2())),
      });
    });
  });
}

async function delegatedWebFetchRun(f: Fixture, decision: 'AUTO' | 'ASK', url: string): Promise<{
  runId: string; taskId: string; operationId: string; connectionId: string;
}> {
  const projectCommand = randomUUID();
  const project = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/projects'), {
    command_id: projectCommand, title: 'Graph WebFetch', project_type: 'GENERAL',
  }), 201, projectCommand);
  const projectId = project.project_id as string;
  const connection = await createGatewayConnectionCommand(f.app.db, { workspaceId: f.workspaceId,
    projectId, commandId: randomUUID(), capabilities: ['WEB_FETCH'],
    allowedHost: '127.0.0.1', allowPrivate: true });
  const policy = await createGatewayPolicy(f.app.db, { workspaceId: f.workspaceId, projectId,
    capability: 'WEB_FETCH', actionType: 'WEB_FETCH', targetPrefix: '127.0.0.1',
    decision, maxPayloadBytes: 1024 });
  assert.ok(policy.policyId);
  const taskCommand = randomUUID();
  const task = expectCommandAccepted(await f.api.post(workspacePath(f.workspaceId, '/tasks'), {
    command_id: taskCommand, project_id: projectId, title: 'Graph approved web fetch',
    objective: 'Read a public page through the Gateway',
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
      web_fetch_action: { connection_id: connection.result.connection_id!, url },
    }), 202, delegateCommand);
  const runId = delegated.run_id as string;
  const contract = await sql<{ frozen_snapshot: { web_fetch_action: { operation_id: string } } }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}`.execute(f.app.db);
  return { runId, taskId: task.task_id as string,
    operationId: contract.rows[0]!.frozen_snapshot.web_fetch_action.operation_id,
    connectionId: connection.result.connection_id! };
}

test('an AUTO frozen web-fetch intent reads the page once and records extraction evidence', async () => {
  const f = await fixture(true);
  const page = await startPageServer();
  try {
    const action = await delegatedWebFetchRun(f, 'AUTO', page.url('/ok'));
    const delivered = await deliverWithReadPreview(f, action.runId);
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint; content: string;
      sha256: string; status_code: string; extractor: string }>`
      select o.status, count(i.id)::bigint as invocation_count,
        (i.result_ref->>'content') as content, (i.result_ref->>'sha256') as sha256,
        (i.result_ref->>'status') as status_code, (i.result_ref->>'extractor') as extractor
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id, i.result_ref`.execute(f.app.db);
    assert.equal(facts.rows.length, 1);
    assert.equal(facts.rows[0]?.status, 'SUCCEEDED');
    assert.equal(facts.rows[0]?.invocation_count, 1n);
    assert.equal(facts.rows[0]?.status_code, '200');
    assert.equal(facts.rows[0]?.extractor, 'web-text-extract-v1');
    assert.equal(facts.rows[0]?.content, extractWebText(WEB_PAGE_BODY));
    assert.equal(facts.rows[0]?.sha256,
      createHash('sha256').update(WEB_PAGE_BODY, 'utf8').digest('hex'));
    const read = await loadRunReadEvidence(createRepositories(f.app.db), action.runId);
    assert.ok(read);
    assert.equal(read.input.kind, 'WEB_FETCH');
    assert.equal(read.input.content, extractWebText(WEB_PAGE_BODY));
    assert.equal(read.input.trust, 'UNTRUSTED_DATA');
    const call = await sql<{ step_kind: string; operation_id: string;
      invocation_id: string; input_sha256: string }>`select s.step_kind,
        mc.read_operation_id as operation_id, mc.read_invocation_id as invocation_id,
        mc.input_sha256 from model_calls mc
        join logical_operations o on o.id = mc.read_operation_id
        join run_steps s on s.id = o.step_id
        where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(call.rows, [{ step_kind: 'BUILD_CONTEXT',
      operation_id: action.operationId, invocation_id: read.invocationId,
      input_sha256: call.rows[0]!.input_sha256 }]);
    assert.match(call.rows[0]!.input_sha256, /^[0-9a-f]{64}$/u);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
    const attempts = await sql<{ step_kind: string; count: bigint }>`
      select s.step_kind, count(a.id)::bigint as count from step_attempts a
      join run_steps s on s.id = a.step_id
      where s.run_id = ${action.runId} and s.step_kind in ('BUILD_CONTEXT', 'DRAFT')
      group by s.step_kind`.execute(f.app.db);
    assert.deepEqual(attempts.rows.map((row) => [row.step_kind, row.count]),
      [['BUILD_CONTEXT', 1n], ['DRAFT', 1n]]);

    await approveValidationReview(f, action.runId);
    const final = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(final?.outcome, 'DONE');
    const doneRun = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((doneRun.body as { status: string }).status, 'COMPLETED');
  } finally { await page.close(); await f.close(); }
});

test('a typed failed web fetch releases execution without starting DRAFT', async () => {
  const f = await fixture(true);
  const page = await startPageServer();
  try {
    const action = await delegatedWebFetchRun(f, 'AUTO', page.url('/missing'));
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    const facts = await sql<{ status: string; reason: string; invocation_status: string;
      run_status: string; wait_reason: string; worker_id: string | null;
      task_status: string; executor_run_id: string | null; draft_count: bigint }>`
      select o.status, o.result_ref->>'reason' as reason, i.status as invocation_status,
        r.status as run_status, r.wait_reason, r.worker_id,
        t.status as task_status, t.executor_run_id,
        (select count(*)::bigint from model_calls mc join step_attempts a
          on a.id = mc.step_attempt_id join run_steps s on s.id = a.step_id
          where s.run_id = r.id and s.step_kind = 'DRAFT') as draft_count
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      join runs r on r.id = o.run_id join tasks t on t.id = r.task_id
      where o.id = ${action.operationId}`.execute(f.app.db);
    assert.deepEqual(facts.rows, [{ status: 'FAILED', reason: 'WEB_HTTP_STATUS',
      invocation_status: 'FAILED', run_status: 'FAILED', wait_reason: 'WEB_HTTP_STATUS',
      worker_id: null, task_status: 'READY', executor_run_id: null, draft_count: 0n }]);
  } finally { await page.close(); await f.close(); }
});

test('an ASK frozen web-fetch intent waits, and only the approved RESUME fetches once', async () => {
  const f = await fixture(true);
  const page = await startPageServer();
  try {
    const action = await delegatedWebFetchRun(f, 'ASK', page.url('/ok'));
    const prepared = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(prepared?.outcome, 'DONE');
    const beforeFacts = await sql<{ status: string; invocation_count: bigint }>`
      select o.status, count(i.id)::bigint as invocation_count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id`.execute(f.app.db);
    assert.deepEqual(beforeFacts.rows[0], { status: 'WAITING_APPROVAL', invocation_count: 0n });
    const beforeDraft = await sql<{ count: bigint }>`select count(*)::bigint as count
      from step_attempts a join run_steps s on s.id = a.step_id
      where s.run_id = ${action.runId} and s.step_kind = 'DRAFT'`.execute(f.app.db);
    assert.equal(beforeDraft.rows[0]?.count, 0n);
    await decideAction(f, action.operationId, 'APPROVE');
    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint; content: string }>`
      select o.status, count(i.id)::bigint as invocation_count,
        (i.result_ref->>'content') as content
      from logical_operations o join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id, i.result_ref`.execute(f.app.db);
    assert.equal(facts.rows.length, 1);
    assert.deepEqual(facts.rows[0], { status: 'SUCCEEDED', invocation_count: 1n,
      content: extractWebText(WEB_PAGE_BODY) });
    const modelCall = await sql<{ operation_id: string; invocation_id: string }>`
      select read_operation_id as operation_id, read_invocation_id as invocation_id
      from model_calls where read_operation_id = ${action.operationId}`.execute(f.app.db);
    assert.equal(modelCall.rows.length, 1);
    assert.equal(modelCall.rows[0]!.operation_id, action.operationId);
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'WAITING_APPROVAL');
  } finally { await page.close(); await f.close(); }
});

test('a context change during an ASK web-fetch wait denies the original operation before any fetch', async () => {
  const f = await fixture(true);
  const page = await startPageServer();
  try {
    const action = await delegatedWebFetchRun(f, 'ASK', page.url('/ok'));
    assert.equal((await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }))?.outcome, 'DONE');
    await sql`update tasks set title = 'Changed during web-fetch approval wait', revision = revision + 1
      where id = ${action.taskId}`.execute(f.app.db);
    await decideAction(f, action.operationId, 'APPROVE');
    const delivered = await runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
      dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl });
    assert.equal(delivered?.outcome, 'DONE');
    const facts = await sql<{ status: string; invocation_count: bigint }>`
      select o.status, count(i.id)::bigint as invocation_count from logical_operations o
      left join invocation_attempts i on i.operation_id = o.id
      where o.id = ${action.operationId} group by o.id`.execute(f.app.db);
    assert.deepEqual(facts.rows[0], { status: 'DENIED', invocation_count: 0n });
    const run = await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`));
    assert.equal((run.body as { status: string }).status, 'FAILED');
    const task = await f.api.get(workspacePath(f.workspaceId, `/tasks/${action.taskId}`));
    assert.equal((task.body as { status: string }).status, 'READY');
  } finally { await page.close(); await f.close(); }
});

test('a frozen web-fetch URL outside the connection host refuses deterministically before any operation', async () => {
  const f = await fixture(true);
  const page = await startPageServer();
  try {
    // The server URL host is 127.0.0.1 but the frozen intent names another host:
    // the connection binding is the admission boundary and the prepare refuses
    // with no operation row, so the Run stays RUNNING and the delivery fails
    // (same frozen-intent semantics as an absent file read target).
    const action = await delegatedWebFetchRun(f, 'AUTO', 'http://other.example/ok');
    await assert.rejects(
      runOneCommand(f.app.db, { workerId: `worker:${randomUUID()}`,
        dataRoot: f.api.dataRoot, checkpointUrl: f.database.appUrl }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error &&
        (error as { code: string }).code === 'GATEWAY_TARGET_DENIED');
    const operations = await sql<{ count: bigint }>`
      select count(*)::bigint as count from logical_operations where run_id = ${action.runId}`.execute(f.app.db);
    assert.equal(operations.rows[0]?.count, 0n, 'no operation row is created for a refused host');
    assert.equal(await f.api.get(workspacePath(f.workspaceId, `/runs/${action.runId}`)).then(
      (run) => (run.body as { status: string }).status), 'RUNNING');
  } finally { await page.close(); await f.close(); }
});
