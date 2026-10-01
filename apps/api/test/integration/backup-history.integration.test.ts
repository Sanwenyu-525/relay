import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { closePartialFileWriteCommand, readFileWriteDispositionPreview }
  from '../../src/application/file-write-disposition.js';
import { claimGatewayWorker, claimRunForGateway, dispatchGatewayAction, prepareGatewayAction,
  SimulatedGatewayCrash, type GatewayOrigin } from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { claimNextRunCommand } from '../../src/application/run-dispatch.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { changeAdmission, readAdmissionStatus } from '../../src/application/runtime-maintenance.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { loadMigrations, runMigrations } from '../../src/infrastructure/migration-runner.js';
import { assertBackupWritersStopped, BackupStateError, readBackupDatabaseState }
  from '../../src/runtime/backup-state.js';
import { exportFirstPartyRegistryArchive } from '../../src/skills/first-party-registry.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { recoverStoppedDesktopLaunch } from '../../src/worker/supervisor.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

for (const variant of ['PARTIAL', 'NO_RECEIPT'] as const) {
  test(`backup preserves Owner-closed ${variant} UNKNOWN without requiring a retired launch`, async (t) => {
    const database = await createTemporaryDatabase('m07_backup_history');
    const app = openDatabase(database.appUrl, 'relay-m07-backup-history-app');
    const observer = openDatabase(database.adminUrl, 'relay-m07-backup-history-observer');
    const dataRoot = await createDataRoot();
    try {
      await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
      await installGraphCheckpoints(database.migrationUrl);
      const migrations = await loadMigrations(MIGRATIONS_DIRECTORY);
      assert.equal(migrations.length, 48, 'the real complete migration set is required');
      const resourceHashes = Object.fromEntries(migrations.map(migration =>
        [`api/migrations/${migration.name}.sql`, migration.sha256.toString('hex')]));
      const state = () => readBackupDatabaseState({ migrationUrl: database.migrationUrl,
        registry: exportFirstPartyRegistryArchive(), resourceHashes,
        signal: AbortSignal.timeout(15_000), assertHeld: async () => {} });

      const workspaceId = await createWorkspace(app.db);
      const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
        title: 'Backup history', projectType: 'GENERAL' });
      const projectId = project.result.project_id, taskId = randomUUID();
      await withTransaction(app.db, async (r) => {
        await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Original file write',
          status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
          ownershipEpoch: 0n, currentCompletionId: null });
        await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
          objective: 'Preserve original action identity', requiredOutputSpec: {}, source: 'CREATE' });
        await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
          statement: 'Review result', required: true, method: 'HUMAN', targetSpec: {} });
      });
      const f = { workspaceId, projectId, taskId };
      const root = join(dataRoot, 'external-resource');
      await mkdir(root);
      if (variant === 'PARTIAL') await writeFile(join(root, 'existing.txt'), 'keep original\n');
      const resource = await registerManagedResource(app.db, { ...f, rootPath: root });
      const connection = await createFakeConnection(app.db, { ...f, capabilities: ['FILE_WRITE'] });
      await createGatewayPolicy(app.db, { ...f, capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET',
        targetPrefix: resource.canonicalRoot, decision: 'ASK', maxPayloadBytes: 8192 });
      const delegated = await delegateTask(app.db, { ...f, commandId: randomUUID(), expectedTaskRevision: '0' });
      const runId = delegated.result.run_id, launchId = randomUUID();
      const workerId = `worker:desktop:${launchId}:${randomUUID()}`;
      const claim = await claimNextRunCommand(app.db, workerId, 60_000);
      assert.equal(claim?.runId, runId);
      const delivery = { commandId: claim!.commandId, invocationEpoch: claim!.epoch };
      const storage = new ManagedContentStore(dataRoot);
      for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
        assert.equal((await advanceRunStep(app.db, { runId, workerId,
          invocationEpoch: claim!.epoch, leaseMs: 60_000, storage })).status, 'STEP_SUCCEEDED', kind);
      }
      const draft = await createRepositories(app.db).runs.readStepByKind(runId, 'DRAFT');
      const firstEpoch = BigInt((await claimRunForGateway(app.db,
        { workspaceId, runId, workerId, delivery })).worker_epoch);
      const origin: GatewayOrigin = { kind: 'RUN', runId, stepId: draft!.id,
        resourceId: resource.resourceId, workerId, workerEpoch: firstEpoch, delivery };
      const operationId = randomUUID();
      const changes = [{ path: 'created.txt', action: 'CREATE', content: 'partial created\n' },
        ...(variant === 'NO_RECEIPT' ? [] : [{ path: 'existing.txt', action: 'MODIFY',
          baselineSha256: '0'.repeat(64), content: 'must not replace\n' }])];
      const prepared = await prepareGatewayAction(app.db, { workspaceId, operationId,
        intentKey: `backup-history-${variant}`, connectionId: connection.connectionId,
        origin, actionType: 'APPLY_CHANGESET', target: resource.canonicalRoot, params: { changes } });
      const review = await createRepositories(app.db).reviews.readRequest(prepared.review_id!);
      await resolveReview(app.db, { workspaceId, reviewId: review!.id,
        commandId: randomUUID(), expectedRevision: review!.revision.toString(),
        targetHash: review!.target_hash.toString('hex'), decision: 'APPROVE' });
      await changeAdmission(app.db, { commandId: randomUUID(), action: 'begin-drain',
        expectedRevision: (await readAdmissionStatus(app.db)).revision });
      const workerEpoch = BigInt((await claimGatewayWorker(app.db,
        { workspaceId, operationId, workerId, delivery })).worker_epoch);
      await assert.rejects(() => dispatchGatewayAction(app.db, { workspaceId,
        operationId, origin: { ...origin, workerEpoch }, hooks: variant === 'NO_RECEIPT'
          ? { afterAdmit: async () => { throw new SimulatedGatewayCrash('before adapter receipt'); } }
          : { afterFakeEffect: async () => { throw new SimulatedGatewayCrash('after partial adapter receipt'); } } }),
      SimulatedGatewayCrash);
      const invocation = await createRepositories(app.db).gateway.lastInvocation(operationId);
      assert.ok(invocation);
      // This is the trusted process-manager fixture input, not a native Job termination test.
      const recovered = await recoverStoppedDesktopLaunch({ db: app.db, dataRoot, launchId,
        stopEvidence: 'armed_job_terminated_and_active_count_zero' });
      assert.deepEqual(recovered.blockedRunIds, [runId]);
      const preview = await readFileWriteDispositionPreview(app.db, workspaceId, operationId);
      assert.equal(preview.stop_proof_recorded, true);
      assert.equal(preview.operation_status, 'UNKNOWN');
      assert.equal(preview.observation_mode, variant === 'PARTIAL' ? 'PARTIAL_LEDGER' : 'NO_RECEIPT');
      assert.equal(preview.can_dispose, true, JSON.stringify(preview.blocking_reasons));
      const closed = await closePartialFileWriteCommand(app.db, { workspaceId, operationId,
        invocationId: invocation.id, commandId: randomUUID(), decision: 'KEEP_CURRENT_AND_FAIL_RUN',
        expectedRunRevision: preview.run_revision, expectedTaskRevision: preview.task_revision,
        expectedObservationSha256: preview.observation_sha256! });
      assert.equal(closed.result.run_status, 'FAILED');
      const facts = await sql<{ operation_status: string; invocation_status: string;
        claim_status: string; delivery_status: string; run_worker_id: string | null; invocation_count: bigint }>`
        select o.status as operation_status, i.status as invocation_status, c.status as claim_status,
          delivery.status as delivery_status, r.worker_id as run_worker_id,
          (select count(*)::bigint from invocation_attempts where operation_id=o.id) as invocation_count
        from logical_operations o join invocation_attempts i on i.operation_id=o.id
        join resource_claims c on c.id=i.resource_claim_id join runs r on r.id=i.run_id
        join run_invocations delivery on delivery.run_id=r.id where i.id=${invocation.id}`.execute(app.db);
      assert.deepEqual(facts.rows, [{ operation_status: 'MANUALLY_CLOSED', invocation_status: 'UNKNOWN',
        claim_status: 'RELEASED', delivery_status: 'IDLE', run_worker_id: null, invocation_count: 1n }]);
      const assertRetiredHistory = async () => {
        const snapshot = await state();
        assert.equal(snapshot.admission.mode, 'DRAINING');
        assert.deepEqual(snapshot.workers, []);
        assertBackupWritersStopped(snapshot, []);
        const history = snapshot.unresolved_invocations.find(row => row.id === invocation.id);
        assert.ok(history, 'the original UNKNOWN must remain in the backup summary');
        assert.equal(history.operation_id, operationId);
        assert.equal(history.worker_id, workerId);
        assert.equal(history.status, 'UNKNOWN');
        assert.equal(snapshot.unresolved_operations.some(row => row.id === operationId), false);
      };
      await assertRetiredHistory();
      if (variant === 'PARTIAL') {
        assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'partial created\n');
        assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'keep original\n');
      }
      const disposition = await observer.db.selectFrom('file_write_manual_dispositions').selectAll()
        .where('invocation_id', '=', invocation.id).executeTakeFirstOrThrow();
      const proof = await observer.db.selectFrom('file_write_stop_proofs').selectAll()
        .where('invocation_id', '=', invocation.id).executeTakeFirstOrThrow();
      assert.equal(proof.worker_id, workerId);
      assert.equal(proof.worker_epoch, workerEpoch);
      assert.equal(proof.launch_id, launchId);
      const assertRejectedWriter = async () => {
        const snapshot = await state();
        assert.ok(snapshot.workers.some(row => row.kind === 'WRITE_INVOCATION' && row.id === invocation.id),
          'incomplete retirement evidence must retain the original writer');
        assert.throws(() => assertBackupWritersStopped(snapshot, []),
          (error: unknown) => error instanceof BackupStateError && error.code === 'BACKUP_WRITER_NOT_STOPPED');
        assert.equal(snapshot.unresolved_invocations.find(row => row.id === invocation.id)?.status, 'UNKNOWN');
      };
      await t.test('missing human disposition still refuses', async () => {
        await observer.db.deleteFrom('file_write_manual_dispositions').where('id', '=', disposition.id).execute();
        try { await assertRejectedWriter(); }
        finally { await observer.db.insertInto('file_write_manual_dispositions').values(disposition).execute(); }
      });
      await t.test('missing durable stop proof still refuses without disabling its foreign key', async () => {
        // The disposition FK requires deleting this fixture's dependent row before its proof.
        await observer.db.deleteFrom('file_write_manual_dispositions').where('id', '=', disposition.id).execute();
        await observer.db.deleteFrom('file_write_stop_proofs').where('invocation_id', '=', invocation.id).execute();
        try { await assertRejectedWriter(); }
        finally {
          await observer.db.insertInto('file_write_stop_proofs').values(proof).execute();
          await observer.db.insertInto('file_write_manual_dispositions').values(disposition).execute();
        }
      });
      await t.test('non-released original resource claim still refuses', async () => {
        await observer.db.updateTable('resource_claims').set({ status: 'QUARANTINED', released_at: null })
          .where('id', '=', invocation.resource_claim_id!).execute();
        try { await assertRejectedWriter(); }
        finally {
          await observer.db.updateTable('resource_claims').set({ status: 'RELEASED', released_at: new Date() })
            .where('id', '=', invocation.resource_claim_id!).execute();
        }
      });
      await assertRetiredHistory();
    } finally {
      await app.close(); await observer.close(); await database.drop();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
}
