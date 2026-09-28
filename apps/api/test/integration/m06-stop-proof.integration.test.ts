import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { claimNextRunCommand } from '../../src/application/run-dispatch.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { scanRecoveryCandidates } from '../../src/application/recover-run.js';
import { claimGatewayWorker, claimRunForGateway, dispatchGatewayAction,
  prepareGatewayAction, reconcileGatewayInvocation, SimulatedGatewayCrash,
  type GatewayOrigin } from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource } from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { recoverStoppedDesktopLaunch, runSupervisedWorkerOnce } from '../../src/worker/supervisor.js';
import { createDataRoot } from './api-harness.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase,
  type TemporaryDatabase, expectSqlState } from './integration-support.js';

let database: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let dataRoot: string;

before(async () => {
  database = await createTemporaryDatabase('m06_stop_proof');
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  app = openDatabase(database.appUrl, 'relay-m06-stop-proof');
  dataRoot = await createDataRoot();
});
after(async () => {
  if (app !== undefined) await app.close();
  if (database !== undefined) await database.drop();
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

async function stoppedFileWriteFixture() {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `stop-proof-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'Stop proof', projectType: 'DEVELOPMENT' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'File write',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Prove stopped worker', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: 'Review', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId,
    commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const launchId = randomUUID();
  const workerId = `worker:desktop:${launchId}:${randomUUID()}`;
  const delivery = await claimNextRunCommand(app.db, workerId, 60_000);
  assert.equal(delivery?.runId, runId);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const step = await advanceRunStep(app.db, { runId, workerId,
      invocationEpoch: delivery!.epoch, leaseMs: 60_000,
      storage: new ManagedContentStore(dataRoot) });
    assert.equal(step.status, 'STEP_SUCCEEDED', kind);
  }
  const draft = await withTransaction(app.db, (r) => r.runs.readStepByKind(runId, 'DRAFT'));
  assert.ok(draft);
  const root = join(dataRoot, `stop-proof-${randomUUID()}`);
  await mkdir(root);
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const connection = await createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: ['FILE_WRITE'] });
  await createGatewayPolicy(app.db, { workspaceId, projectId, capability: 'FILE_WRITE',
    actionType: 'APPLY_CHANGESET', targetPrefix: resource.canonicalRoot,
    decision: 'ASK', maxPayloadBytes: 8192 });
  const firstEpoch = BigInt((await claimRunForGateway(app.db, { workspaceId, runId, workerId,
    delivery: { commandId: delivery!.commandId, invocationEpoch: delivery!.epoch } })).worker_epoch);
  const first: GatewayOrigin = { kind: 'RUN', runId, stepId: draft.id,
    resourceId: resource.resourceId, workerId, workerEpoch: firstEpoch,
    delivery: { commandId: delivery!.commandId, invocationEpoch: delivery!.epoch } };
  const operationId = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId, operationId,
    intentKey: `proof-${randomUUID()}`, connectionId: connection.connectionId, origin: first,
    actionType: 'APPLY_CHANGESET', target: resource.canonicalRoot,
    params: { changes: [{ path: 'proof.txt', action: 'CREATE', content: 'proof\n' }] } });
  assert.equal(prepared.status, 'WAITING_APPROVAL');
  const review = await withTransaction(app.db, (r) => r.reviews.readRequest(prepared.review_id!));
  assert.ok(review);
  await resolveReview(app.db, { workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
    decision: 'APPROVE' });
  const workerEpoch = BigInt((await claimGatewayWorker(app.db, { workspaceId, operationId, workerId,
    delivery: { commandId: delivery!.commandId, invocationEpoch: delivery!.epoch } })).worker_epoch);
  const origin: GatewayOrigin = { ...first, workerEpoch };
  await assert.rejects(dispatchGatewayAction(app.db, { workspaceId, operationId, origin,
    hooks: { afterAdmit: async () => { throw new SimulatedGatewayCrash('before file adapter'); } } }),
  SimulatedGatewayCrash);
  const invocation = await createRepositories(app.db).gateway.lastInvocation(operationId);
  assert.equal(invocation?.status, 'DISPATCHING');
  return { runId, launchId, workerId, workerEpoch, dispatchEpoch: delivery!.epoch,
    commandId: delivery!.commandId, operationId, invocationId: invocation!.id, workspaceId };
}

test('trusted desktop Job stop stores the original FILE_WRITE identity once before fencing', async () => {
  const f = await stoppedFileWriteFixture();
  const outcome = await recoverStoppedDesktopLaunch({ db: app.db, dataRoot,
    launchId: f.launchId, stopEvidence: 'armed_job_terminated_and_active_count_zero' });
  assert.deepEqual(outcome.blockedRunIds, [f.runId]);
  const proof = await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId);
  assert.ok(proof);
  assert.deepEqual({ run: proof.run_id, operation: proof.operation_id,
    invocation: proof.invocation_id, worker: proof.worker_id,
    workerEpoch: proof.worker_epoch, dispatchEpoch: proof.dispatch_epoch,
    command: proof.command_id, launch: proof.launch_id },
  { run: f.runId, operation: f.operationId, invocation: f.invocationId,
    worker: f.workerId, workerEpoch: f.workerEpoch, dispatchEpoch: f.dispatchEpoch,
    command: f.commandId, launch: f.launchId });
  const again = await recoverStoppedDesktopLaunch({ db: app.db, dataRoot,
    launchId: f.launchId, stopEvidence: 'armed_job_absent_after_last_handle_closed' });
  assert.deepEqual(again.blockedRunIds, [f.runId]);
  const persisted = await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId);
  assert.deepEqual(persisted, proof, 'replay cannot rewrite evidence or its timestamp');
  await expectSqlState('42501', 'proof cannot be updated', () => sql`
    update file_write_stop_proofs set stop_evidence = 'armed_job_absent_after_last_handle_closed'
    where invocation_id = ${f.invocationId}
  `.execute(app.db));
});

test('wrong Worker, epoch, or Invocation cannot become a stop proof', async () => {
  const f = await stoppedFileWriteFixture();
  for (const values of [
    { worker: `worker:desktop:${f.launchId}:${randomUUID()}`, epoch: f.workerEpoch, invocation: f.invocationId },
    { worker: f.workerId, epoch: f.workerEpoch + 1n, invocation: f.invocationId },
    { worker: f.workerId, epoch: f.workerEpoch, invocation: randomUUID() },
  ]) {
    await expectSqlState('23503', 'mismatched invocation identity', () => sql`
      insert into file_write_stop_proofs
        (invocation_id, operation_id, run_id, worker_id, worker_epoch,
         dispatch_epoch, command_id, launch_id, stop_evidence, action_type, capability_key)
      values (${values.invocation}, ${f.operationId}, ${f.runId}, ${values.worker},
        ${values.epoch}, ${f.dispatchEpoch}, ${f.commandId}, ${f.launchId},
        'armed_job_terminated_and_active_count_zero', 'APPLY_CHANGESET', 'FILE_WRITE')
    `.execute(app.db));
  }
  assert.equal(await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId), undefined);
});

test('lease expiry and a direct Gateway reconciliation never create desktop Job evidence', async () => {
  const f = await stoppedFileWriteFixture();
  await sql`update runs set worker_lease_until = clock_timestamp() - interval '1 second'
    where id = ${f.runId}`.execute(app.db);
  assert.ok((await scanRecoveryCandidates(app.db)).some((row) => row.run_id === f.runId));
  assert.equal(await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId), undefined);
  await reconcileGatewayInvocation(app.db, { workspaceId: f.workspaceId,
    operationId: f.operationId, invocationId: f.invocationId,
    stoppedWorkerId: f.workerId, stoppedWorkerEpoch: f.workerEpoch, oldProcessStopped: true });
  assert.equal(await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId), undefined);
});

test('a changed Run worker epoch blocks desktop proof before the old claim is fenced', async () => {
  const f = await stoppedFileWriteFixture();
  await sql`update runs set worker_epoch = worker_epoch + 1 where id = ${f.runId}`.execute(app.db);
  const result = await recoverStoppedDesktopLaunch({ db: app.db, dataRoot,
    launchId: f.launchId, stopEvidence: 'armed_job_terminated_and_active_count_zero' });
  assert.deepEqual(result.blockedRunIds, [f.runId]);
  assert.equal(await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId), undefined);
  const claim = await createRepositories(app.db).dispatch.readInvocation(f.runId);
  assert.equal(claim?.worker_id, f.workerId, 'mismatched identity must retain the old claim');
});

test('ordinary child close recovery cannot create desktop Job proof', async () => {
  const f = await stoppedFileWriteFixture();
  const result = await runSupervisedWorkerOnce({ db: app.db, databaseUrl: database.appUrl,
    dataRoot, workerId: f.workerId });
  assert.deepEqual(result.blockedRunIds, [f.runId], result.output);
  assert.equal(await createRepositories(app.db).fileWriteStopProofs.readByInvocation(f.invocationId), undefined);
});
