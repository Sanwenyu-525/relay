import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { createRule } from '../../src/application/information-commands.js';
import { readRunById } from '../../src/application/run-queries.js';
import { applySafeControl, requestRunControl, resumeRun } from '../../src/application/control-requests.js';
import {
  claimGatewayWorker, claimRunForGateway, dispatchGatewayAction, prepareGatewayAction,
  readGatewayOperation, reconcileGatewayInvocation, releaseGatewayWorker, SimulatedGatewayCrash,
  type GatewayOrigin,
} from '../../src/application/gateway-actions.js';
import {
  createFakeConnection, createGatewayPolicy, createImportJob, registerManagedResource,
  revokeGatewayPolicy, setFakeConnection,
} from '../../src/application/gateway-configuration.js';
import { createGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, expectCommandAccepted, expectProblem, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, expectSqlState, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p09-gateway');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

interface RunFixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  root: string; resourceId: string; connectionId: string; policyId: string;
}

async function runFixture(input: { workspaceId?: string; projectRoot?: string; decision?: 'AUTO' | 'ASK' } = {}): Promise<RunFixture> {
  const workspaceId = input.workspaceId ?? randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  if (input.workspaceId === undefined) {
    await withTransaction(app.db, async (repositories) => {
      await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `p09-${workspaceId}` });
      await repositories.workspaces.insertAuthorityRow(workspaceId);
    });
  }
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'P09 Gateway', projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Fake marker',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Gateway 执行', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const storage = new ManagedContentStore(dataRoot);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const result = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  const step = await withTransaction(app.db, (repositories) => repositories.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(step);
  const root = input.projectRoot ?? join(dataRoot, `gateway-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const connection = await createFakeConnection(app.db, { workspaceId, projectId, capabilities: ['FAKE_WRITE'] });
  const policy = await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FAKE_WRITE',
    actionType: 'WRITE_MARKER', targetPrefix: resource.canonicalRoot,
    decision: input.decision ?? 'AUTO', maxPayloadBytes: 1024 });
  return { workspaceId, projectId, taskId, runId, stepId: step.id, root: resource.canonicalRoot,
    resourceId: resource.resourceId, connectionId: connection.connectionId, policyId: policy.policyId };
}

async function worker(f: RunFixture, workerId = `worker-${randomUUID()}`) {
  const claim = await claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId, workerId });
  const origin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId, workerEpoch: BigInt(claim.worker_epoch) };
  return origin;
}

async function prepareRun(f: RunFixture, origin: GatewayOrigin, target = join(f.root, `${randomUUID()}.json`),
  operationId = randomUUID(), intentKey = `intent-${randomUUID()}`) {
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, intentKey, connectionId: f.connectionId, origin, actionType: 'WRITE_MARKER',
    target, params: { content: 'P09 Fake effect' } });
  return { prepared, target, operationId, intentKey };
}

async function approve(workspaceId: string, reviewId: string, decision: 'APPROVE' | 'DENY' = 'APPROVE') {
  const review = await withTransaction(app.db, (repositories) => repositories.reviews.readRequest(reviewId));
  assert.ok(review);
  return resolveReview(app.db, { workspaceId, reviewId, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'), decision });
}

function barrier() {
  let enter!: () => void;
  let leave!: () => void;
  return { entered: new Promise<void>((resolve) => { enter = resolve; }),
    release: () => leave(), wait: async () => { enter(); await new Promise<void>((resolve) => { leave = resolve; }); } };
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

test('P09 AUTO keeps Connection, Capability and Permission separate and records one invocation', async () => {
  const f = await runFixture();
  const origin = await worker(f);
  const action = await prepareRun(f, origin);
  assert.equal(action.prepared.status, 'PREPARED');
  assert.ok(action.prepared.invocation_id);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin });
  assert.equal(result.status, 'SUCCEEDED');
  assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId));
  const persisted = await readGatewayOperation(app.db, f.workspaceId, action.operationId);
  assert.equal(persisted.operation.status, 'SUCCEEDED');
  assert.equal(persisted.invocations[0]?.status, 'SUCCEEDED');
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin }), (error: unknown) => code(error) === 'GATEWAY_OPERATION_SETTLED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.kind === 'RUN' ? origin.workerId : '', workerEpoch: origin.kind === 'RUN' ? origin.workerEpoch : 0n });
});

test('P09 ASK releases old Worker; Review decision and new epoch admit only the original target', async () => {
  const f = await runFixture({ decision: 'ASK' });
  const old = await worker(f);
  const action = await prepareRun(f, old);
  assert.equal(action.prepared.status, 'WAITING_APPROVAL');
  assert.equal(action.prepared.invocation_id, null);
  assert.ok(action.prepared.review_id);
  const decided = await approve(f.workspaceId, action.prepared.review_id);
  assert.equal(decided.result.effect.external_effect_executed, false);
  const reviewResume = await sql<{ id: string }>`
    select c.id from run_commands c
    where c.run_id = ${f.runId} and c.kind = 'RESUME'
  `.execute(app.db);
  assert.equal(reviewResume.rows.length, 0,
    'direct Gateway approval has no frozen graph action, so it must not queue a graph RESUME');
  const nextId = `worker-${randomUUID()}`;
  const nextEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, workerId: nextId })).worker_epoch);
  assert.notEqual(nextEpoch, old.kind === 'RUN' ? old.workerEpoch : 0n);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin: old }), (error: unknown) => code(error) === 'GATEWAY_STALE_WORKER');
  const next: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId: nextId, workerEpoch: nextEpoch };
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin: next });
  assert.equal(result.status, 'SUCCEEDED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: nextId, workerEpoch: nextEpoch });
  await withTransaction(app.db, async (repositories) => {
    await repositories.tasks.lockTask(f.taskId);
    await repositories.runs.lockRun(f.runId);
    const start = await sql<{ id: string }>`select id from run_commands
      where run_id = ${f.runId} and kind = 'START'`.execute(app.db);
    assert.ok(start.rows[0]);
    await repositories.dispatch.settlePending(start.rows[0].id);
  });
  const deferred = await withTransaction(app.db,
    (repositories) => repositories.dispatch.listPending(1000));
  assert.equal(deferred.some((row) => row.run_id === f.runId), false,
    'the directly dispatched operation cannot leave an unclaimable graph command');
  const bindings = await sql<{ count: bigint }>`select count(*) as count from invocation_approval_bindings
    where operation_id = ${action.operationId}`.execute(app.db);
  assert.equal(bindings.rows[0]?.count, 1n);
});

test('M03 denied or expired ACTION_APPROVAL cannot queue a Run RESUME', async () => {
  const denied = await runFixture({ decision: 'ASK' });
  const deniedAction = await prepareRun(denied, await worker(denied));
  assert.ok(deniedAction.prepared.review_id);
  const denial = await approve(denied.workspaceId, deniedAction.prepared.review_id, 'DENY');
  assert.equal(denial.result.effect.action_authorized, false);
  const expired = await runFixture({ decision: 'ASK' });
  const expiredAction = await prepareRun(expired, await worker(expired));
  assert.ok(expiredAction.prepared.review_id);
  await sql`update review_requests set expires_at = now() - interval '1 second'
    where id = ${expiredAction.prepared.review_id}`.execute(app.db);
  await assert.rejects(approve(expired.workspaceId, expiredAction.prepared.review_id),
    (error: unknown) => code(error) === 'INVALID_TRANSITION');
  const queued = await sql<{ run_id: string; count: bigint }>`
    select run_id, count(*)::bigint as count from run_commands
    where run_id in (${denied.runId}, ${expired.runId}) and kind = 'RESUME'
    group by run_id
  `.execute(app.db);
  assert.deepEqual(queued.rows, []);
});

test('M03 PAUSE denies a directly approved action without blocking a later manual RESUME', async () => {
  const f = await runFixture({ decision: 'ASK' });
  const action = await prepareRun(f, await worker(f));
  assert.ok(action.prepared.review_id);
  const approval = await approve(f.workspaceId, action.prepared.review_id);
  assert.equal(approval.result.effect.external_effect_executed, false);
  const start = await sql<{ id: string }>`select id from run_commands
    where run_id = ${f.runId} and kind = 'START'`.execute(app.db);
  assert.ok(start.rows[0]);
  await withTransaction(app.db, async (repositories) => {
    await repositories.tasks.lockTask(f.taskId);
    await repositories.runs.lockRun(f.runId);
    await repositories.dispatch.settlePending(start.rows[0]!.id);
  });
  const beforePause = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from tasks t join runs r on r.task_id = t.id where r.id = ${f.runId}
  `.execute(app.db);
  assert.ok(beforePause.rows[0]);
  await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    commandId: randomUUID(), type: 'PAUSE',
    expectedTaskRevision: beforePause.rows[0].task_revision.toString(),
    expectedRunRevision: beforePause.rows[0].run_revision.toString() });
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'APPLIED');
  const invalidated = await sql<{ operation_status: string; review_status: string;
    decision_id: string; resume_count: bigint }>`
    select op.status as operation_status, review.status as review_status,
      decision.id as decision_id,
      (select count(*)::bigint from run_commands c where c.run_id = op.run_id
        and c.kind = 'RESUME') as resume_count
    from logical_operations op
    join review_requests review on review.operation_id = op.id
    join review_decisions decision on decision.review_id = review.id
    where op.id = ${action.operationId}
  `.execute(app.db);
  assert.deepEqual([invalidated.rows[0]?.operation_status,
    invalidated.rows[0]?.review_status, invalidated.rows[0]?.decision_id,
    invalidated.rows[0]?.resume_count],
  ['DENIED', 'DECIDED', approval.result.decision_id, 0n]);
  const paused = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from tasks t join runs r on r.task_id = t.id where r.id = ${f.runId}
  `.execute(app.db);
  assert.ok(paused.rows[0]);
  const resumed = await resumeRun(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    commandId: randomUUID(), expectedTaskRevision: paused.rows[0].task_revision.toString(),
    expectedRunRevision: paused.rows[0].run_revision.toString() });
  assert.equal(resumed.result.status, 'RUNNING');
  const commands = await sql<{ id: string; ordinal: bigint; status: string;
    review_decision_id: string | null }>`
    select c.id, c.ordinal, o.status, c.review_decision_id
    from run_commands c join run_command_outbox o on o.command_id = c.id
    where c.run_id = ${f.runId} order by c.ordinal
  `.execute(app.db);
  assert.deepEqual(commands.rows.map((row) => [row.ordinal, row.status]),
    [[1n, 'DONE'], [2n, 'PENDING']]);
  assert.equal(commands.rows[1]?.review_decision_id, null);
  const pending = await withTransaction(app.db,
    (repositories) => repositories.dispatch.listPending(1000));
  assert.equal(pending.some((row) => row.command_id === commands.rows[1]?.id), true,
    'the valid manual RESUME must not be blocked by a non-graph approval');
});

test('M03 rejected approved claim leaves no Worker owner after expiry, Connection or Permission change', async () => {
  for (const cause of ['EXPIRY', 'CONNECTION', 'PERMISSION'] as const) {
    const f = await runFixture({ decision: 'ASK' });
    const action = await prepareRun(f, await worker(f));
    assert.ok(action.prepared.review_id);
    const approval = await approve(f.workspaceId, action.prepared.review_id);
    if (cause === 'EXPIRY') {
      await sql`update review_requests set expires_at = now() - interval '1 second'
        where id = ${action.prepared.review_id}`.execute(app.db);
    } else if (cause === 'CONNECTION') {
      await setFakeConnection(app.db, { workspaceId: f.workspaceId, connectionId: f.connectionId,
        status: 'DISABLED', config: {} });
    } else {
      await revokeGatewayPolicy(app.db, { workspaceId: f.workspaceId, policyId: f.policyId });
    }
    await assert.rejects(claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
      operationId: action.operationId, workerId: `worker-${randomUUID()}` }),
    (error: unknown) => cause === 'EXPIRY' ? code(error) === 'GATEWAY_APPROVAL_REQUIRED'
      : cause === 'CONNECTION' ? code(error) === 'GATEWAY_CONNECTION_STALE'
        : ['GATEWAY_PERMISSION_DENIED', 'GATEWAY_PERMISSION_STALE'].includes(code(error) ?? ''));
    const owner = await sql<{ worker_id: string | null }>`select worker_id from runs
      where id = ${f.runId}`.execute(app.db);
    assert.equal(owner.rows[0]?.worker_id, null, `${cause} cannot retain a Worker claim`);
    await assert.rejects(readFile(action.target), { code: 'ENOENT' });
    const revisions = await sql<{ task_revision: bigint; run_revision: bigint }>`
      select t.revision as task_revision, r.revision as run_revision
      from tasks t join runs r on r.task_id = t.id where r.id = ${f.runId}
    `.execute(app.db);
    assert.ok(revisions.rows[0]);
    const type = cause === 'EXPIRY' ? 'PAUSE' : cause === 'CONNECTION' ? 'CANCEL' : 'HANDOFF';
    await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
      commandId: randomUUID(), type,
      expectedTaskRevision: revisions.rows[0].task_revision.toString(),
      expectedRunRevision: revisions.rows[0].run_revision.toString() });
    assert.equal((await applySafeControl(app.db, f.runId))?.status, 'APPLIED');
    const withdrawn = await sql<{ operation_status: string; review_status: string;
      decision_id: string; resume_count: bigint }>`
      select op.status as operation_status, review.status as review_status,
        decision.id as decision_id,
        (select count(*)::bigint from run_commands c where c.run_id = op.run_id
          and c.kind = 'RESUME') as resume_count
      from logical_operations op
      join review_requests review on review.operation_id = op.id
      join review_decisions decision on decision.review_id = review.id
      where op.id = ${action.operationId}
    `.execute(app.db);
    assert.deepEqual(withdrawn.rows[0], { operation_status: 'DENIED',
      review_status: 'DECIDED', decision_id: approval.result.decision_id,
      resume_count: 0n });
  }
});

test('M03 revocation between approved claim and Admit releases a no-effect Worker for safe control', async () => {
  const f = await runFixture({ decision: 'ASK' });
  const action = await prepareRun(f, await worker(f));
  assert.ok(action.prepared.review_id);
  await approve(f.workspaceId, action.prepared.review_id);
  const workerId = `worker-${randomUUID()}`;
  const workerEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, workerId })).worker_epoch);
  await revokeGatewayPolicy(app.db, { workspaceId: f.workspaceId, policyId: f.policyId });
  const origin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId, workerEpoch };
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin }), (error: unknown) =>
    ['GATEWAY_PERMISSION_DENIED', 'GATEWAY_PERMISSION_STALE'].includes(code(error) ?? ''));
  const stillOwned = await sql<{ worker_id: string | null }>`select worker_id from runs
    where id = ${f.runId}`.execute(app.db);
  assert.equal(stillOwned.rows[0]?.worker_id, null);
  const attempts = await sql<{ count: bigint }>`select count(*)::bigint as count
    from invocation_attempts where operation_id = ${action.operationId}`.execute(app.db);
  assert.equal(attempts.rows[0]?.count, 0n);
  await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  const revisions = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from tasks t join runs r on r.task_id = t.id where r.id = ${f.runId}
  `.execute(app.db);
  assert.ok(revisions.rows[0]);
  await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    commandId: randomUUID(), type: 'PAUSE',
    expectedTaskRevision: revisions.rows[0].task_revision.toString(),
    expectedRunRevision: revisions.rows[0].run_revision.toString() });
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'APPLIED');
  const withdrawn = await sql<{ operation_status: string; resume_count: bigint }>`
    select op.status as operation_status,
      (select count(*)::bigint from run_commands c where c.run_id = op.run_id
        and c.kind = 'RESUME') as resume_count
    from logical_operations op where op.id = ${action.operationId}
  `.execute(app.db);
  assert.deepEqual(withdrawn.rows[0], { operation_status: 'DENIED', resume_count: 0n });
});

test('M03 direct approval withdrawal rolls back operation, Run and control on operation failure', async () => {
  const f = await runFixture({ decision: 'ASK' });
  const action = await prepareRun(f, await worker(f));
  assert.ok(action.prepared.review_id);
  const approval = await approve(f.workspaceId, action.prepared.review_id);
  const revisions = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from tasks t join runs r on r.task_id = t.id where r.id = ${f.runId}
  `.execute(app.db);
  assert.ok(revisions.rows[0]);
  const requested = await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    commandId: randomUUID(), type: 'PAUSE',
    expectedTaskRevision: revisions.rows[0].task_revision.toString(),
    expectedRunRevision: revisions.rows[0].run_revision.toString() });
  const migration = openDatabase(MIGRATION_DATABASE_URL, 'relay-m03-direct-withdraw-fault');
  try {
    await sql`
      create function reject_direct_approval_withdrawal() returns trigger language plpgsql as $$
      begin
        if old.status = 'WAITING_APPROVAL' and new.status = 'DENIED' then
          raise exception 'injected direct operation withdrawal failure';
        end if;
        return new;
      end $$
    `.execute(migration.db);
    await sql`create trigger reject_direct_approval_withdrawal before update on logical_operations
      for each row execute function reject_direct_approval_withdrawal()`.execute(migration.db);
    await assert.rejects(applySafeControl(app.db, f.runId));
    const facts = await sql<{ operation_status: string; review_status: string;
      resume_count: bigint; run_status: string; control_status: string }>`
      select op.status as operation_status, review.status as review_status,
        (select count(*)::bigint from run_commands c where c.run_id = op.run_id
          and c.kind = 'RESUME') as resume_count,
        run.status as run_status, control.status as control_status
      from logical_operations op
      join review_requests review on review.operation_id = op.id
      join review_decisions decision on decision.review_id = review.id
      join runs run on run.id = op.run_id
      join run_control_requests control on control.run_id = run.id
      where op.id = ${action.operationId} and control.id = ${requested.result.control_request_id}
    `.execute(app.db);
    assert.deepEqual(facts.rows[0], { operation_status: 'WAITING_APPROVAL',
      review_status: 'DECIDED', resume_count: 0n, run_status: 'WAITING_APPROVAL',
      control_status: 'PENDING' });
  } finally {
    await sql`drop trigger if exists reject_direct_approval_withdrawal on logical_operations`.execute(migration.db);
    await sql`drop function if exists reject_direct_approval_withdrawal()`.execute(migration.db);
    await migration.close();
  }
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'APPLIED');
  const preserved = await sql<{ id: string; status: string }>`
    select decision.id, review.status from review_decisions decision
    join review_requests review on review.id = decision.review_id
    where review.id = ${action.prepared.review_id}
  `.execute(app.db);
  assert.deepEqual(preserved.rows[0], { id: approval.result.decision_id, status: 'DECIDED' });
});

test('P09 USER_IMPORT has a real job source, ASK Review and no Run/claim identity', async () => {
  const f = await runFixture();
  const sourceUri = 'https://public.example/fixture/article';
  const job = await createImportJob(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    actorRef: 'user:local', configVersion: 'fixture-v1', sourceUri, commandId: randomUUID() });
  const connection = await createFakeConnection(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capabilities: ['FAKE_PUBLIC_READ'] });
  await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'FAKE_PUBLIC_READ', actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/',
    decision: 'ASK', maxPayloadBytes: 16 });
  const origin: GatewayOrigin = { kind: 'USER_IMPORT', importJobId: job.importJobId,
    actorRef: 'user:local', configVersion: 'fixture-v1' };
  const opId = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: opId, intentKey: 'public-read-1', connectionId: connection.connectionId,
    origin, actionType: 'READ_PUBLIC', target: sourceUri, params: {} });
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  assert.ok(prepared.review_id);
  await approve(f.workspaceId, prepared.review_id);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: opId, origin });
  assert.equal(result.status, 'SUCCEEDED');
  const invocation = (await readGatewayOperation(app.db, f.workspaceId, opId)).invocations[0];
  assert.equal(invocation?.origin, 'USER_IMPORT');
  assert.equal(invocation?.run_id, null);
  assert.equal(invocation?.resource_claim_id, null);
  const currentJob = await withTransaction(app.db, (repositories) => repositories.gateway.readImportJob(job.importJobId));
  assert.equal(currentJob?.status, 'RUNNING'); // P17 persists a KnowledgeVersion before marking SUCCEEDED.
  // P17/web-fetch 的 Knowledge 结算用各自 fixture 覆盖；共享库里不能留下
  // RUNNING+已成功 USER_IMPORT operation——后续 web-fetch 的全局 tick 会把它
  // 结算为 WEB_TEXT_UNAVAILABLE 并计入 failed，污染其计数断言。断言后清理。
  await withTransaction(app.db, (repositories) =>
    repositories.gateway.settleImportJob(job.importJobId, 'FAILED', 'gateway-fixture-cleanup'));
});

test('P09 revocation before Admit rejects, while Admit before revocation completes the already admitted effect', async () => {
  const f = await runFixture();
  const origin = await worker(f);
  const first = await prepareRun(f, origin);
  await revokeGatewayPolicy(app.db, { workspaceId: f.workspaceId, policyId: f.policyId });
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: first.operationId, origin }), (error: unknown) =>
      code(error) === 'GATEWAY_PERMISSION_DENIED' || code(error) === 'GATEWAY_PERMISSION_STALE');
  await assert.rejects(readFile(first.target), { code: 'ENOENT' });

  const g = await runFixture();
  const next = await worker(g);
  const second = await prepareRun(g, next);
  const gate = barrier();
  const dispatched = dispatchGatewayAction(app.db, { workspaceId: g.workspaceId,
    operationId: second.operationId, origin: next, hooks: { afterAdmit: gate.wait } });
  await gate.entered;
  await revokeGatewayPolicy(app.db, { workspaceId: g.workspaceId, policyId: g.policyId });
  gate.release();
  assert.equal((await dispatched).status, 'SUCCEEDED');
  assert.match(await readFile(second.target, 'utf8'), new RegExp(second.operationId));
});

test('P09 overlapping roots across Projects occupy one physical directory until the first effect settles', async () => {
  const parent = join(dataRoot, `overlap-${randomUUID()}`);
  const child = join(parent, 'child');
  await mkdir(child, { recursive: true });
  const a = await runFixture({ projectRoot: parent });
  const b = await runFixture({ projectRoot: child });
  const ao = await worker(a);
  const bo = await worker(b);
  const [aResult, bResult] = await Promise.allSettled([prepareRun(a, ao), prepareRun(b, bo)]);
  assert.equal([aResult, bResult].filter((item) => item.status === 'fulfilled').length, 1);
  const failed = aResult.status === 'rejected' ? aResult : bResult;
  assert.equal(failed.status === 'rejected' ? code(failed.reason) : undefined, 'RESOURCE_OCCUPIED');
  const winner = aResult.status === 'fulfilled' ? { f: a, origin: ao, action: aResult.value }
    : { f: b, origin: bo, action: (bResult as PromiseFulfilledResult<Awaited<ReturnType<typeof prepareRun>>>).value };
  assert.equal((await dispatchGatewayAction(app.db, { workspaceId: winner.f.workspaceId,
    operationId: winner.action.operationId, origin: winner.origin })).status, 'SUCCEEDED');
  const loser = aResult.status === 'rejected' ? { f: a, origin: ao } : { f: b, origin: bo };
  const retry = await prepareRun(loser.f, loser.origin);
  assert.equal((await dispatchGatewayAction(app.db, { workspaceId: loser.f.workspaceId,
    operationId: retry.operationId, origin: loser.origin })).status, 'SUCCEEDED');
});

test('P09 crashed Fake dispatch reconciles the same ID; tampering remains UNKNOWN and blocks new IDs', async () => {
  const f = await runFixture();
  const origin = await worker(f);
  const action = await prepareRun(f, origin);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after write'); } } }), SimulatedGatewayCrash);
  const invocationId = action.prepared.invocation_id!;
  assert.equal((await readGatewayOperation(app.db, f.workspaceId, action.operationId)).invocations[0]?.status, 'DISPATCHING');
  const reconciled = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, invocationId, oldProcessStopped: true,
    stoppedWorkerId: origin.kind === 'RUN' ? origin.workerId : '',
    stoppedWorkerEpoch: origin.kind === 'RUN' ? origin.workerEpoch : 0n });
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal((await readGatewayOperation(app.db, f.workspaceId, action.operationId)).invocations.length, 1);

  const g = await runFixture();
  const go = await worker(g);
  const uncertain = await prepareRun(g, go);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: g.workspaceId,
    operationId: uncertain.operationId, origin: go,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after write'); } } }), SimulatedGatewayCrash);
  await writeFile(uncertain.target, 'tampered');
  const unknown = await reconcileGatewayInvocation(app.db, { workspaceId: g.workspaceId,
    operationId: uncertain.operationId, invocationId: uncertain.prepared.invocation_id!,
    oldProcessStopped: true, stoppedWorkerId: go.kind === 'RUN' ? go.workerId : '',
    stoppedWorkerEpoch: go.kind === 'RUN' ? go.workerEpoch : 0n });
  assert.equal(unknown.status, 'UNKNOWN');
  const nextWorker = `worker-${randomUUID()}`;
  await assert.rejects(claimRunForGateway(app.db, { workspaceId: g.workspaceId,
    runId: g.runId, workerId: nextWorker }), (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
});

test('M03 G03 Run query exposes only its Workspace Gateway UNKNOWN operation ID', async () => {
  const settledRun = await runFixture();
  const settledOrigin = await worker(settledRun);
  const settled = await prepareRun(settledRun, settledOrigin);
  assert.deepEqual((await readRunById(app.db, settledRun.workspaceId, settledRun.runId))
    .unresolved_operation_ids, [], 'PREPARED is not UNKNOWN');
  assert.equal((await dispatchGatewayAction(app.db, { workspaceId: settledRun.workspaceId,
    operationId: settled.operationId, origin: settledOrigin })).status, 'SUCCEEDED');
  assert.deepEqual((await readRunById(app.db, settledRun.workspaceId, settledRun.runId))
    .unresolved_operation_ids, [], 'SUCCEEDED is not UNKNOWN');

  const unknownRun = await runFixture({ workspaceId: settledRun.workspaceId });
  const unknownOrigin = await worker(unknownRun);
  const action = await prepareRun(unknownRun, unknownOrigin);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: unknownRun.workspaceId,
    operationId: action.operationId, origin: unknownOrigin,
    hooks: { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after write'); } } }),
  SimulatedGatewayCrash);
  assert.deepEqual((await readRunById(app.db, unknownRun.workspaceId, unknownRun.runId))
    .unresolved_operation_ids, [], 'DISPATCHING is not UNKNOWN');
  await writeFile(action.target, 'tampered');
  const reconciled = await reconcileGatewayInvocation(app.db, { workspaceId: unknownRun.workspaceId,
    operationId: action.operationId, invocationId: action.prepared.invocation_id!,
    oldProcessStopped: true, stoppedWorkerId: unknownOrigin.kind === 'RUN' ? unknownOrigin.workerId : '',
    stoppedWorkerEpoch: unknownOrigin.kind === 'RUN' ? unknownOrigin.workerEpoch : 0n });
  assert.equal(reconciled.status, 'UNKNOWN');
  assert.deepEqual((await readRunById(app.db, unknownRun.workspaceId, unknownRun.runId))
    .unresolved_operation_ids, [action.operationId]);
  assert.deepEqual((await readRunById(app.db, settledRun.workspaceId, settledRun.runId))
    .unresolved_operation_ids, [], 'another Run in the same Workspace stays isolated');

  const otherWorkspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: otherWorkspaceId, name: `g03-${otherWorkspaceId}` });
    await repositories.workspaces.insertAuthorityRow(otherWorkspaceId);
  });
  const api = await startTestApi();
  try {
    const read = await api.get(workspacePath(unknownRun.workspaceId, `/runs/${unknownRun.runId}`));
    assert.equal(read.status, 200);
    assert.deepEqual((read.body as { unresolved_operation_ids: string[] }).unresolved_operation_ids,
      [action.operationId]);
    assert.equal(read.text.includes(action.target), false, 'target path must not enter the Run DTO');
    assert.equal(read.text.includes('tampered'), false, 'effect contents must not enter the Run DTO');
    expectProblem(await api.get(workspacePath(otherWorkspaceId, `/runs/${unknownRun.runId}`)),
      404, 'RESOURCE_NOT_FOUND');
  } finally {
    await api.stop();
  }
});

test('P09 expired inner Worker lease after Admit cannot start the Fake effect', async () => {
  const f = await runFixture();
  const workerId = `worker-${randomUUID()}`;
  const epoch = BigInt((await claimRunForGateway(app.db, { workspaceId: f.workspaceId,
    runId: f.runId, workerId, leaseMs: 1000 })).worker_epoch);
  const origin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId, workerEpoch: epoch };
  const action = await prepareRun(f, origin);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin, hooks: { afterAdmit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const expired = await sql<{ expired: boolean }>`select worker_lease_until < clock_timestamp() as expired
        from runs where id = ${f.runId}`.execute(app.db);
      assert.equal(expired.rows[0]?.expired, true);
    } } });
  assert.equal(result.status, 'UNKNOWN');
  await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  const persisted = await readGatewayOperation(app.db, f.workspaceId, action.operationId);
  assert.equal(persisted.invocations.length, 1);
  assert.equal(persisted.invocations[0]?.status, 'UNKNOWN');
  const claim = await sql<{ status: string }>`select status from resource_claims
    where id = ${persisted.invocations[0]?.resource_claim_id}`.execute(app.db);
  assert.equal(claim.rows[0]?.status, 'QUARANTINED');
});

test('P09 expired inner Worker lease after Fake effect preserves original identity as UNKNOWN', async () => {
  const f = await runFixture();
  const workerId = `worker-${randomUUID()}`;
  const epoch = BigInt((await claimRunForGateway(app.db, { workspaceId: f.workspaceId,
    runId: f.runId, workerId, leaseMs: 1000 })).worker_epoch);
  const origin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId, workerEpoch: epoch };
  const action = await prepareRun(f, origin);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin, hooks: { afterFakeEffect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const expired = await sql<{ expired: boolean }>`select worker_lease_until < clock_timestamp() as expired
        from runs where id = ${f.runId}`.execute(app.db);
      assert.equal(expired.rows[0]?.expired, true);
    } } });
  assert.equal(result.status, 'UNKNOWN');
  assert.match(await readFile(action.target, 'utf8'), new RegExp(action.operationId));
  const persisted = await readGatewayOperation(app.db, f.workspaceId, action.operationId);
  assert.equal(persisted.invocations.length, 1);
  assert.equal(persisted.invocations[0]?.status, 'UNKNOWN');
  const claim = await sql<{ status: string }>`select status from resource_claims
    where id = ${persisted.invocations[0]?.resource_claim_id}`.execute(app.db);
  assert.equal(claim.rows[0]?.status, 'QUARANTINED');
});

test('P09 database rejects crossed operation scope, Review pair, Invocation origin and claim token', async () => {
  const f = await runFixture({ decision: 'ASK' });
  const old = await worker(f);
  const action = await prepareRun(f, old);
  assert.ok(action.prepared.review_id);
  await approve(f.workspaceId, action.prepared.review_id);
  const newWorkerId = `worker-${randomUUID()}`;
  const epoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, workerId: newWorkerId })).worker_epoch);
  const next: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId: newWorkerId, workerEpoch: epoch };
  await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: action.operationId, origin: next });
  const invocation = (await readGatewayOperation(app.db, f.workspaceId, action.operationId)).invocations[0];
  assert.ok(invocation);
  const g = await runFixture();
  await expectSqlState('23514', 'Fake Connection cannot persist raw credentials', () => sql`
    update gateway_connections set config = ${JSON.stringify({ token: 'raw' })}::jsonb
    where id = ${f.connectionId}
  `.execute(app.db));
  await expectSqlState('23503', 'operation project scope', () => sql`
    update logical_operations set project_id = ${g.projectId} where id = ${action.operationId}
  `.execute(app.db));
  await expectSqlState('23503', 'invocation claim token', () => sql`
    update invocation_attempts set claim_token = ${randomUUID()} where id = ${invocation.id}
  `.execute(app.db));
  await expectSqlState('23514', 'invocation origin', () => sql`
    update invocation_attempts set origin = 'USER_IMPORT' where id = ${invocation.id}
  `.execute(app.db));
  const another = await worker(g);
  const otherAction = await prepareRun(g, another);
  const h = await runFixture({ decision: 'ASK' });
  const ho = await worker(h);
  const unreserved = await prepareRun(h, ho);
  assert.ok(unreserved.prepared.review_id);
  await expectSqlState('23503', 'Review and operation pair', () => sql`
    insert into approval_reservations (review_id, operation_id)
    values (${unreserved.prepared.review_id}, ${otherAction.operationId})
  `.execute(app.db));
});

test('P09 PREPARED Worker exit proves no dispatch; the same logical ID gets a new Invocation and epoch', async () => {
  const f = await runFixture();
  const old = await worker(f);
  const action = await prepareRun(f, old);
  await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  const absent = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, invocationId: action.prepared.invocation_id!,
    oldProcessStopped: true, stoppedWorkerId: old.kind === 'RUN' ? old.workerId : '',
    stoppedWorkerEpoch: old.kind === 'RUN' ? old.workerEpoch : 0n });
  assert.equal(absent.status, 'NOT_EXECUTED');
  const newWorkerId = `worker-${randomUUID()}`;
  const newEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, workerId: newWorkerId })).worker_epoch);
  const next: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId: newWorkerId, workerEpoch: newEpoch };
  assert.equal((await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin: next })).status, 'SUCCEEDED');
  const attempts = await sql<{ attempt_number: bigint; status: string }>`
    select attempt_number, status from invocation_attempts
    where operation_id = ${action.operationId} order by attempt_number
  `.execute(app.db);
  assert.deepEqual(attempts.rows.map((row) => [row.attempt_number, row.status]),
    [[1n, 'NOT_EXECUTED'], [2n, 'SUCCEEDED']]);
});

test('P09 DISPATCHING with a missing target stays UNKNOWN; a different intent cannot bypass it', async () => {
  const f = await runFixture();
  const old = await worker(f);
  const action = await prepareRun(f, old);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin: old,
    hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('before adapter call'); } } }), SimulatedGatewayCrash);
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin: old }),
  (error: unknown) => code(error) === 'GATEWAY_OPERATION_SETTLED');
  const stillFenced = await sql<{ worker_id: string | null }>`select worker_id from runs
    where id = ${f.runId}`.execute(app.db);
  assert.equal(stillFenced.rows[0]?.worker_id, old.kind === 'RUN' ? old.workerId : null,
    'a DISPATCHING Invocation cannot lose its Worker claim on rejected redispatch');
  await assert.rejects(readFile(action.target), { code: 'ENOENT' });
  const unresolved = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, invocationId: action.prepared.invocation_id!,
    oldProcessStopped: true, stoppedWorkerId: old.kind === 'RUN' ? old.workerId : '',
    stoppedWorkerEpoch: old.kind === 'RUN' ? old.workerEpoch : 0n });
  assert.equal(unresolved.status, 'UNKNOWN');
  await assert.rejects(claimRunForGateway(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: `worker-${randomUUID()}` }), (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
  const claim = await sql<{ status: string }>`select status from resource_claims
    where resource_id = ${f.resourceId} order by created_at desc limit 1`.execute(app.db);
  assert.equal(claim.rows[0]?.status, 'QUARANTINED');
});

test('P09 pending control before Admit abandons PREPARED without a Fake effect', async () => {
  const f = await runFixture();
  const origin = await worker(f);
  const action = await prepareRun(f, origin);
  await assert.rejects(releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.kind === 'RUN' ? origin.workerId : '',
    workerEpoch: origin.kind === 'RUN' ? origin.workerEpoch : 0n }),
  (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
  const state = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from tasks t join runs r on r.task_id = t.id where r.id = ${f.runId}
  `.execute(app.db);
  const control = await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    commandId: randomUUID(), expectedTaskRevision: state.rows[0]!.task_revision.toString(),
    expectedRunRevision: state.rows[0]!.run_revision.toString(), type: 'HANDOFF' });
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'PENDING');
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin }), (error: unknown) => code(error) === 'GATEWAY_RUN_NOT_READY');
  assert.equal((await readGatewayOperation(app.db, f.workspaceId, action.operationId)).operation.status, 'DENIED');
  assert.equal(await applySafeControl(app.db, f.runId), null);
  assert.equal((await sql<{ status: string }>`select status from run_control_requests
    where id = ${control.result.control_request_id}`.execute(app.db)).rows[0]?.status, 'APPLIED');
  await assert.rejects(readFile(action.target), { code: 'ENOENT' });
});

test('P09 USER_IMPORT unresolved invocation blocks a new intent for the same job', async () => {
  const f = await runFixture();
  const sourceUri = 'https://public.example/fixture/unresolved';
  const job = await createImportJob(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    actorRef: 'user:local', configVersion: 'fixture-v1', sourceUri, commandId: randomUUID() });
  const connection = await createFakeConnection(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capabilities: ['FAKE_PUBLIC_READ'] });
  await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'FAKE_PUBLIC_READ', actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/',
    decision: 'AUTO', maxPayloadBytes: 16 });
  const origin: GatewayOrigin = { kind: 'USER_IMPORT', importJobId: job.importJobId,
    actorRef: 'user:local', configVersion: 'fixture-v1' };
  const operationId = randomUUID();
  await prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId,
    intentKey: 'first-read', connectionId: connection.connectionId, origin,
    actionType: 'READ_PUBLIC', target: sourceUri, params: {} });
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, origin, hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('after admit'); } } }),
  SimulatedGatewayCrash);
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: 'second-read', connectionId: connection.connectionId,
    origin, actionType: 'READ_PUBLIC', target: sourceUri, params: {} }),
  (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
});

test('P09 URL Permission matches path segments and concurrent Review decisions consume once', async () => {
  const f = await runFixture({ decision: 'ASK' });
  const origin = await worker(f);
  const action = await prepareRun(f, origin);
  const review = await withTransaction(app.db, (repositories) =>
    repositories.reviews.readRequest(action.prepared.review_id!));
  assert.ok(review);
  const two = await Promise.allSettled(['APPROVE', 'APPROVE'].map((decision) => resolveReview(app.db, {
    workspaceId: f.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
    decision: decision as 'APPROVE',
  })));
  assert.equal(two.filter((item) => item.status === 'fulfilled').length, 1);
  const nextId = `worker-${randomUUID()}`;
  const nextEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, workerId: nextId })).worker_epoch);
  const next: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId: nextId, workerEpoch: nextEpoch };
  assert.equal((await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin: next })).status, 'SUCCEEDED');
  const bindings = await sql<{ count: bigint }>`select count(*) as count from invocation_approval_bindings
    where operation_id = ${action.operationId}`.execute(app.db);
  assert.equal(bindings.rows[0]?.count, 1n);

  const sourceUri = 'https://public.example/safeevil';
  const job = await createImportJob(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    actorRef: 'user:local', configVersion: 'fixture-v1', sourceUri, commandId: randomUUID() });
  const connection = await createFakeConnection(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capabilities: ['FAKE_PUBLIC_READ'] });
  await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'FAKE_PUBLIC_READ', actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/safe',
    decision: 'AUTO', maxPayloadBytes: 16 });
  await assert.rejects(prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: 'url-boundary', connectionId: connection.connectionId,
    origin: { kind: 'USER_IMPORT', importJobId: job.importJobId,
      actorRef: 'user:local', configVersion: 'fixture-v1' },
    actionType: 'READ_PUBLIC', target: sourceUri, params: {} }),
  (error: unknown) => code(error) === 'GATEWAY_PERMISSION_DENIED');
});

test('P09 HTTP config commands replay, isolate scope, and expose full Invocation history', async () => {
  const f = await runFixture();
  const api = await startTestApi();
  try {
    const connections = workspacePath(f.workspaceId, `/projects/${f.projectId}/connections`);
    const connectionCommand = randomUUID();
    const connectionBody = { command_id: connectionCommand, capabilities: ['FAKE_PUBLIC_READ'] };
    const created = await api.post(connections, connectionBody);
    const connection = expectCommandAccepted(created, 201, connectionCommand);
    const connectionId = connection.connection_id as string;
    assert.match((created.body as { links: { resource: string } }).links.resource,
      new RegExp(`/connections/${connectionId}$`));
    const replay = await api.post(connections, connectionBody);
    assert.deepEqual(replay.body, created.body);
    assert.equal(replay.headers['command-replayed'], 'true');
    expectProblem(await api.post(connections, { ...connectionBody, capabilities: ['FAKE_WRITE'] }),
      409, 'COMMAND_ID_REUSED');
    const connectionRead = await api.get(`${connections}/${connectionId}`);
    assert.equal(connectionRead.status, 200);
    assert.equal((connectionRead.body as { version: string }).version, '1');
    assert.equal((connectionRead.body as { allowed_host: string | null }).allowed_host, null);
    assert.equal(connectionRead.text.includes('config'), false);
    assert.equal((await api.post(`${connections}/${connectionId}/test`, {})).status, 200);
    const listedConnections = await api.get(connections);
    assert.equal(listedConnections.status, 200);
    assert.ok((listedConnections.body as { id: string }[]).some((row) => row.id === connectionId));
    expectProblem(await api.get(workspacePath(randomUUID(),
      `/projects/${f.projectId}/connections/${connectionId}`)), 404, 'RESOURCE_NOT_FOUND');
    const disableConnectionCommand = randomUUID();
    const disabledConnection = expectCommandAccepted(await api.post(`${connections}/${connectionId}/disable`, {
      command_id: disableConnectionCommand, expected_version: connection.version,
    }), 200, disableConnectionCommand);
    assert.equal(disabledConnection.status, 'DISABLED');

    const policies = workspacePath(f.workspaceId, `/projects/${f.projectId}/permission-policies`);
    const policyCommand = randomUUID();
    const policy = expectCommandAccepted(await api.post(policies, { command_id: policyCommand,
      capability: 'FAKE_PUBLIC_READ', resource_id: null, decision: 'AUTO', max_payload_bytes: 0 }),
    201, policyCommand);
    const policyId = policy.policy_id as string;
    const versionCommand = randomUUID();
    const version = expectCommandAccepted(await api.post(`${policies}/${policyId}/versions`, {
      command_id: versionCommand, expected_revision: policy.revision,
      capability: 'FAKE_PUBLIC_READ', resource_id: null, decision: 'ASK', max_payload_bytes: 16,
    }), 200, versionCommand);
    assert.equal(version.version, '2');
    assert.equal((await api.get(`${policies}/${policyId}/versions`)).status, 200);
    expectProblem(await api.post(`${policies}/${policyId}/versions`, {
      command_id: randomUUID(), expected_revision: policy.revision,
      capability: 'FAKE_PUBLIC_READ', resource_id: null, decision: 'AUTO', max_payload_bytes: 0,
    }), 409, 'REVISION_CONFLICT');
    const revokeCommand = randomUUID();
    const revoked = expectCommandAccepted(await api.post(`${policies}/${policyId}/revoke`, {
      command_id: revokeCommand, expected_revision: version.revision,
    }), 200, revokeCommand);
    assert.equal(revoked.status, 'REVOKED');

    const resourceRoot = join(f.root, `http-${randomUUID()}`);
    await mkdir(resourceRoot);
    const resources = workspacePath(f.workspaceId, `/projects/${f.projectId}/managed-resources`);
    const resourceCommand = randomUUID();
    const resource = expectCommandAccepted(await api.post(resources, {
      command_id: resourceCommand, root_path: resourceRoot,
    }), 201, resourceCommand);
    const resourceId = resource.resource_id as string;
    const resourceRead = await api.get(`${resources}/${resourceId}`);
    assert.equal(resourceRead.status, 200);
    assert.equal((resourceRead.body as { file_write_identity_bound: boolean }).file_write_identity_bound,
      process.platform === 'win32');
    assert.ok((await api.get(resources)).text.includes(resourceId));
    await rmdir(resourceRoot);
    const resourceReplay = await api.post(resources, { command_id: resourceCommand, root_path: resourceRoot });
    assert.equal(resourceReplay.headers['command-replayed'], 'true');
    assert.equal((resourceReplay.body as { result: { resource_id: string } }).result.resource_id, resourceId);
    expectProblem(await api.post(resources, { command_id: randomUUID(), root_path: resourceRoot }),
      422, 'VALIDATION_FAILED');
    const disableResourceCommand = randomUUID();
    const disabledResource = expectCommandAccepted(await api.post(`${resources}/${resourceId}/disable`, {
      command_id: disableResourceCommand, expected_revision: resource.revision,
    }), 200, disableResourceCommand);
    assert.equal(disabledResource.status, 'DISABLED');
    await mkdir(resourceRoot);
    const replacementCommandId = randomUUID();
    const replacement = expectCommandAccepted(await api.post(resources, {
      command_id: replacementCommandId, root_path: resourceRoot,
    }), 201, replacementCommandId);
    assert.notEqual(replacement.resource_id, resourceId);
    const replacementRead = await api.get(`${resources}/${replacement.resource_id}`);
    assert.equal(replacementRead.status, 200);
    assert.equal((replacementRead.body as { file_write_identity_bound: boolean }).file_write_identity_bound,
      process.platform === 'win32');

    const origin = await worker(f);
    const action = await prepareRun(f, origin);
    assert.equal((await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
      operationId: action.operationId, invocationId: action.prepared.invocation_id!,
      oldProcessStopped: true, stoppedWorkerId: origin.kind === 'RUN' ? origin.workerId : '',
      stoppedWorkerEpoch: origin.kind === 'RUN' ? origin.workerEpoch : 0n })).status, 'NOT_EXECUTED');
    const nextId = `worker-${randomUUID()}`;
    const nextEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId: f.workspaceId,
      operationId: action.operationId, workerId: nextId })).worker_epoch);
    const next: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
      resourceId: f.resourceId, workerId: nextId, workerEpoch: nextEpoch };
    assert.equal((await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
      operationId: action.operationId, origin: next })).status, 'SUCCEEDED');
    const operations = await api.get(workspacePath(f.workspaceId, `/runs/${f.runId}/operations`));
    assert.equal(operations.status, 200);
    assert.ok((operations.body as { id: string }[]).some((row) => row.id === action.operationId));
    const detail = await api.get(workspacePath(f.workspaceId, `/operations/${action.operationId}`));
    assert.equal(detail.status, 200);
    assert.deepEqual((detail.body as { invocations: { status: string }[] }).invocations.map((row) => row.status),
      ['NOT_EXECUTED', 'SUCCEEDED']);
    assert.equal(detail.text.includes('claim_token'), false);
  } finally {
    await api.stop();
  }
});

test('P10 Rule update after Gateway Admit preserves the old Invocation outcome and blocks new work', async () => {
  const f = await runFixture();
  const origin = await worker(f);
  const action = await prepareRun(f, origin);
  const result = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: action.operationId, origin,
    hooks: { afterAdmit: async () => {
      await createRule(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
        scope: 'PROJECT', scopeId: f.projectId, ruleKey: 'after-admit',
        statement: '准入后新增规则', strength: 'HARD', applicability: 'AI_RUN',
        enforcement: 'HUMAN' });
    } } });
  assert.equal(result.status, 'SUCCEEDED');
  const persisted = await readGatewayOperation(app.db, f.workspaceId, action.operationId);
  assert.equal(persisted.operation.status, 'SUCCEEDED');
  assert.equal(persisted.invocations.at(-1)?.status, 'SUCCEEDED');
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.kind === 'RUN' ? origin.workerId : '',
    workerEpoch: origin.kind === 'RUN' ? origin.workerEpoch : 0n });
  await assert.rejects(claimRunForGateway(app.db, { workspaceId: f.workspaceId,
    runId: f.runId, workerId: `worker-${randomUUID()}` }),
  (error: unknown) => code(error) === 'RULE_SNAPSHOT_STALE');
});

interface FileReadFixture {
  workspaceId: string; projectId: string; taskId: string; runId: string; stepId: string;
  root: string; resourceId: string; connectionId: string; policyId: string;
}

async function fileReadFixture(decision: 'AUTO' | 'ASK' = 'AUTO'): Promise<FileReadFixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `p09-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'P09 Gateway', projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'File read',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Gateway 执行', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const storage = new ManagedContentStore(dataRoot);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT'] as const) {
    const result = await advanceRunStep(app.db, { runId, workerId: `setup-${randomUUID()}`, storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  const step = await withTransaction(app.db, (repositories) => repositories.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(step);
  const root = join(dataRoot, `file-read-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const connection = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capabilities: ['FILE_READ'], rootPath: root });
  const policy = await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_READ',
    actionType: 'READ_FILE', targetPrefix: resource.canonicalRoot, decision, maxPayloadBytes: 1024 });
  return { workspaceId, projectId, taskId, runId, stepId: step.id, root: resource.canonicalRoot,
    resourceId: resource.resourceId, connectionId: connection.result.connection_id!,
    policyId: policy.policyId };
}

async function prepareFileRead(f: FileReadFixture, origin: GatewayOrigin, relative: string): Promise<string> {
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId: randomUUID(), intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId,
    origin, actionType: 'READ_FILE', target: join(f.root, relative), params: {} });
  return prepared.operation_id;
}

/** Direct dispatches must release the Run worker the way the graph path does. */
async function releaseWorker(f: FileReadFixture, origin: Extract<GatewayOrigin, { kind: 'RUN' }>): Promise<void> {
  await releaseGatewayWorker(app.db, { workspaceId: f.workspaceId, runId: f.runId,
    workerId: origin.workerId, workerEpoch: origin.workerEpoch });
}

test('P16 FILE_READ reads a bounded real file through the Gateway with hash evidence', async () => {
  const f = await fileReadFixture();
  const origin = await worker(f);
  await writeFile(join(f.root, 'data.txt'), '受控读取的正文', 'utf8');
  const operationId = await prepareFileRead(f, origin, 'data.txt');
  const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, origin });
  assert.equal(dispatched.status, 'SUCCEEDED');
  const result = dispatched.result_ref as { content: string; sha256: string; size: number; truncated: boolean };
  assert.equal(result.content, '受控读取的正文');
  assert.equal(result.size, Buffer.byteLength('受控读取的正文', 'utf8'));
  assert.equal(result.sha256, createHash('sha256').update('受控读取的正文', 'utf8').digest('hex'));
  assert.equal(result.truncated, false);
  const facts = await sql<{ op_status: string; claim_status: string }>`
    select o.status as op_status, c.status as claim_status from logical_operations o
    join invocation_attempts i on i.operation_id = o.id
    left join resource_claims c on c.id = i.resource_claim_id
    where o.id = ${operationId}`.execute(app.db);
  assert.deepEqual(facts.rows[0], { op_status: 'SUCCEEDED', claim_status: 'RELEASED' });
  await releaseWorker(f, origin);
});

test('P16 FILE_READ rejects traversal, outside roots, missing files and link escape before any read', async () => {
  const f = await fileReadFixture();
  const origin = await worker(f);
  const outside = join(dataRoot, `outside-${randomUUID()}.txt`);
  await writeFile(outside, '根外文件', 'utf8');
  for (const target of [
    join(f.root, '..', `outside-${randomUUID()}.txt`),
    outside,
    join(f.root, 'missing.txt'),
  ]) {
    await assert.rejects(
      prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
        intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
        actionType: 'READ_FILE', target, params: {} }),
      (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED');
  }
  // Windows junction pointing outside the registered root must not retarget reads.
  const outsideDir = join(dataRoot, `escape-${randomUUID()}`);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.txt'), '逃逸正文', 'utf8');
  await symlink(outsideDir, join(f.root, 'link'), 'junction');
  await assert.rejects(
    prepareGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: randomUUID(),
      intentKey: `intent-${randomUUID()}`, connectionId: f.connectionId, origin,
      actionType: 'READ_FILE', target: join(f.root, 'link', 'secret.txt'), params: {} }),
    (error: unknown) => code(error) === 'GATEWAY_TARGET_DENIED');
  await rm(outsideDir, { recursive: true, force: true });
});

test('P16 FILE_READ re-verifies the pinned path at execute and rejects a swapped link', async () => {
  const f = await fileReadFixture();
  const origin = await worker(f);
  await writeFile(join(f.root, 'swap.txt'), '原始正文', 'utf8');
  const operationId = await prepareFileRead(f, origin, 'swap.txt');
  const outsideDir = join(dataRoot, `swap-escape-${randomUUID()}`);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.txt'), '换后的逃逸正文', 'utf8');
  await unlink(join(f.root, 'swap.txt'));
  await symlink(outsideDir, join(f.root, 'swap.txt'), 'junction');
  const dispatched = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId, origin });
  assert.equal(dispatched.status, 'FAILED');
  assert.equal((dispatched.result_ref as { reason: string }).reason, 'GATEWAY_TARGET_CHANGED');
  const facts = await sql<{ op_status: string; claim_status: string }>`
    select o.status as op_status, c.status as claim_status from logical_operations o
    join invocation_attempts i on i.operation_id = o.id
    left join resource_claims c on c.id = i.resource_claim_id
    where o.id = ${operationId}`.execute(app.db);
  assert.deepEqual(facts.rows[0], { op_status: 'FAILED', claim_status: 'RELEASED' });
  await releaseWorker(f, origin);
  await rm(outsideDir, { recursive: true, force: true });
});

test('P16 FILE_READ enforces the output limit, binary rejection and the caller deadline', async () => {
  const f = await fileReadFixture();
  const origin = await worker(f);
  await writeFile(join(f.root, 'big.txt'), 'x'.repeat(128 * 1024 + 1), 'utf8');
  const bigId = await prepareFileRead(f, origin, 'big.txt');
  const big = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: bigId, origin });
  assert.equal(big.status, 'FAILED');
  assert.equal((big.result_ref as { reason: string; limit_bytes: number }).reason, 'FILE_TOO_LARGE');
  assert.equal((big.result_ref as { limit_bytes: number }).limit_bytes, 131072);
  await releaseWorker(f, origin);

  const binaryOrigin = await worker(f);
  await writeFile(join(f.root, 'blob.bin'), Buffer.from([0x70, 0x00, 0x71]));
  const binaryId = await prepareFileRead(f, binaryOrigin, 'blob.bin');
  const binary = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: binaryId, origin: binaryOrigin });
  assert.equal(binary.status, 'FAILED');
  assert.equal((binary.result_ref as { reason: string }).reason, 'FILE_BINARY_UNSUPPORTED');
  await releaseWorker(f, binaryOrigin);

  const lateOrigin = await worker(f);
  await writeFile(join(f.root, 'late.txt'), '正文', 'utf8');
  const lateId = await prepareFileRead(f, lateOrigin, 'late.txt');
  const late = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: lateId,
    origin: lateOrigin, deadline: new Date(Date.now() - 1000) });
  assert.equal(late.status, 'FAILED');
  assert.equal((late.result_ref as { reason: string }).reason, 'GATEWAY_DEADLINE_EXCEEDED');
  await releaseWorker(f, lateOrigin);
});

test('P16 FILE_READ without a permission policy is denied by default', async () => {
  const f = await fileReadFixture();
  await revokeGatewayPolicy(app.db, { workspaceId: f.workspaceId, policyId: f.policyId });
  const origin = await worker(f);
  await writeFile(join(f.root, 'data.txt'), '正文', 'utf8');
  await assert.rejects(
    prepareFileRead(f, origin, 'data.txt'),
    (error: unknown) => code(error) === 'GATEWAY_PERMISSION_DENIED');
});

test('P16 FILE_READ reconcile re-reads: PREPARED stays not executed, a crash converges by re-reading', async () => {
  const f = await fileReadFixture();
  const origin = await worker(f);
  await writeFile(join(f.root, 'reconcile.txt'), '重读正文', 'utf8');
  const operationId = await prepareFileRead(f, origin, 'reconcile.txt');
  const notExecuted = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId, invocationId: (await sql<{ id: string }>`
      select id from invocation_attempts where operation_id = ${operationId}`.execute(app.db)).rows[0]!.id,
    stoppedWorkerId: origin.workerId, stoppedWorkerEpoch: origin.workerEpoch, oldProcessStopped: true });
  assert.equal(notExecuted.status, 'NOT_EXECUTED');
  // The NOT_EXECUTED reconciliation returns the operation to PREPARED and
  // fences the old claim. Production continues the SAME operation from a fresh
  // outer claim: the graph path skips the run-level gateway claim when the op
  // already exists, so the test claims the Run worker directly.
  const reclaimed = await withTransaction(app.db, (repositories) =>
    repositories.runs.claimWorker(f.runId, `worker-${randomUUID()}`, new Date(Date.now() + 30_000)));
  assert.ok(reclaimed);
  assert.ok(reclaimed.worker_id !== null && reclaimed.worker_lease_until !== null);
  const reclaimOrigin: GatewayOrigin = { kind: 'RUN', runId: f.runId, stepId: f.stepId,
    resourceId: f.resourceId, workerId: reclaimed.worker_id, workerEpoch: BigInt(reclaimed.worker_epoch) };
  const settledFirst = await dispatchGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, origin: reclaimOrigin });
  assert.equal(settledFirst.status, 'SUCCEEDED');
  await releaseWorker(f, reclaimOrigin);

  const crashOrigin = await worker(f);
  const crashId = await prepareFileRead(f, crashOrigin, 'reconcile.txt');
  await assert.rejects(
    dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: crashId,
      origin: crashOrigin, hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('after admit'); } } }),
    SimulatedGatewayCrash);
  // Preparing another action while this one is unresolved is refused by design.
  await assert.rejects((async () => {
    const next = await worker(f);
    return prepareFileRead(f, next, 'reconcile.txt');
  })(), (error: unknown) => code(error) === 'GATEWAY_OPERATION_UNRESOLVED');
  const reconciled = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: crashId, invocationId: (await sql<{ id: string }>`
      select id from invocation_attempts where operation_id = ${crashId}`.execute(app.db)).rows[0]!.id,
    stoppedWorkerId: crashOrigin.workerId, stoppedWorkerEpoch: crashOrigin.workerEpoch, oldProcessStopped: true });
  assert.equal(reconciled.status, 'SUCCEEDED');
  const evidence = await sql<{ result_ref: { content: string; sha256: string } }>`
    select result_ref from invocation_attempts where operation_id = ${crashId}`.execute(app.db);
  assert.equal(evidence.rows[0]?.result_ref.content, '重读正文');

  // A read whose target disappears while the invocation is in flight settles
  // FAILED on reconcile: nothing happened, and the claim is released.
  const deletedOrigin = await worker(f);
  const deletedId = await prepareFileRead(f, deletedOrigin, 'reconcile.txt');
  await assert.rejects(
    dispatchGatewayAction(app.db, { workspaceId: f.workspaceId, operationId: deletedId,
      origin: deletedOrigin, hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('after admit'); } } }),
    SimulatedGatewayCrash);
  await unlink(join(f.root, 'reconcile.txt'));
  const failed = await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: deletedId, invocationId: (await sql<{ id: string }>`
      select id from invocation_attempts where operation_id = ${deletedId}`.execute(app.db)).rows[0]!.id,
    stoppedWorkerId: deletedOrigin.workerId, stoppedWorkerEpoch: deletedOrigin.workerEpoch, oldProcessStopped: true });
  assert.equal(failed.status, 'FAILED');
  const claimStates = await sql<{ status: string }>`
    select distinct c.status as status from resource_claims c
    join invocation_attempts i on i.resource_claim_id = c.id
    where i.operation_id in (${crashId}, ${deletedId})`.execute(app.db);
  assert.ok(claimStates.rows.every((row) => row.status === 'RELEASED'),
    'a pure read never quarantines its resource claim');
});
