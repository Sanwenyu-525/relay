import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { applySafeControl, readControlRequest, requestRunControl, resumeRun } from '../../src/application/control-requests.js';
import { advanceRunStep, SimulatedWorkerCrash } from '../../src/application/run-steps.js';
import { recoverStoppedWorker, scanRecoveryCandidates } from '../../src/application/recover-run.js';
import { readRunById } from '../../src/application/run-queries.js';
import { lockTaskAndRun } from '../../src/application/lock-task-run.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunEventRepository } from '../../src/run/run-event-repository.js';
import { ManagedContentStore, resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
import { createDataRoot, delay, expectCommandAccepted, startTestApi, withTimeout, workspacePath } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p08-recovery');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

async function fixture(method: 'HUMAN' | 'MARKDOWN_STRUCTURE' = 'HUMAN'): Promise<{
  workspaceId: string; taskId: string; runId: string; workerId: string; storage: ManagedContentStore;
}> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `p08-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'P08 recovery', projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'P08 controlled Fake action',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
      currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '核对控制与恢复', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'structure',
      statement: 'Markdown 结构核对', required: true, method, targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(),
    expectedTaskRevision: '0' });
  return { workspaceId, taskId, runId: delegated.result.run_id,
    workerId: `worker-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) };
}

async function runState(runId: string): Promise<{ status: string; revision: bigint; worker_id: string | null }> {
  const rows = await sql<{ status: string; revision: bigint; worker_id: string | null }>`
    select status, revision, worker_id from runs where id = ${runId}
  `.execute(app.db);
  if (rows.rows[0] === undefined) throw new Error('missing Run');
  return rows.rows[0];
}

async function taskState(taskId: string): Promise<{ status: string; revision: bigint; executor_kind: string }> {
  const rows = await sql<{ status: string; revision: bigint; executor_kind: string }>`
    select status, revision, executor_kind from tasks where id = ${taskId}
  `.execute(app.db);
  if (rows.rows[0] === undefined) throw new Error('missing Task');
  return rows.rows[0];
}

async function request(f: Awaited<ReturnType<typeof fixture>>, type: 'PAUSE' | 'CANCEL' | 'HANDOFF' | 'CANCEL_TASK', supersedesRequestId?: string) {
  const task = await taskState(f.taskId);
  const run = await runState(f.runId);
  return requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId, commandId: randomUUID(),
    expectedTaskRevision: task.revision.toString(), expectedRunRevision: run.revision.toString(), type,
    ...(supersedesRequestId === undefined ? {} : { supersedesRequestId }) });
}

async function advanceToPersist(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const result = await advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
}

function barrier(): { entered: Promise<void>; release: () => void; wait: () => Promise<void> } {
  let entered!: () => void;
  let release!: () => void;
  return { entered: new Promise((resolve) => { entered = resolve; }),
    release: () => release(), wait: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); } };
}

const CHILD_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), 'recovery-worker-child.js');

function runWorkerChild(mode: 'crash-after-dispatch' | 'recover', f: Awaited<ReturnType<typeof fixture>>): Promise<{
  readonly exitCode: number | null; readonly stdout: string; readonly stderr: string;
}> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [CHILD_ENTRY], {
      env: { ...process.env, RELAY_P08_CHILD_MODE: mode, RELAY_P08_RUN_ID: f.runId,
        RELAY_P08_WORKER_ID: f.workerId, RELAY_P08_DATA_ROOT: f.storage.dataRoot },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', rejectChild);
    child.on('exit', (exitCode) => resolveChild({ exitCode, stdout, stderr }));
  });
}

test('P08 control is durable PENDING before the safe point; PAUSE/Resume keep Task and Run aligned', async () => {
  const f = await fixture();
  const accepted = await request(f, 'PAUSE');
  assert.equal(accepted.result.status, 'PENDING');
  assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, accepted.result.control_request_id)).status, 'PENDING');
  assert.equal((await readRunById(app.db, f.workspaceId, f.runId)).pending_control_request?.id, accepted.result.control_request_id);
  const applied = await applySafeControl(app.db, f.runId);
  assert.equal(applied?.status, 'APPLIED');
  assert.equal((await taskState(f.taskId)).status, 'WAITING');
  assert.equal((await runState(f.runId)).status, 'PAUSED');
  const task = await taskState(f.taskId);
  const run = await runState(f.runId);
  const resumeCommandId = randomUUID();
  const resumeInput = { workspaceId: f.workspaceId, runId: f.runId,
    commandId: resumeCommandId, expectedTaskRevision: task.revision.toString(),
    expectedRunRevision: run.revision.toString() };
  const resumed = await resumeRun(app.db, resumeInput);
  assert.equal(resumed.result.status, 'CONTEXT_BUILDING');
  assert.equal((await taskState(f.taskId)).status, 'IN_PROGRESS');
  const replayed = await resumeRun(app.db, resumeInput);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.result, resumed.result);
  const commands = await sql<{ kind: string; ordinal: bigint; source_command_id: string;
    outbox_status: string }>`
    select c.kind, c.ordinal, c.source_command_id, o.status as outbox_status
    from run_commands c join run_command_outbox o on o.command_id = c.id
    where c.run_id = ${f.runId} order by c.ordinal
  `.execute(app.db);
  assert.deepEqual(commands.rows.map((row) => [row.kind, row.ordinal, row.outbox_status]),
    [['START', 1n, 'PENDING'], ['RESUME', 2n, 'PENDING']]);
  assert.equal(commands.rows[1]?.source_command_id, resumeCommandId);
});

test('P08 conflicting controls reject unless explicitly superseded; terminal Run rejects a new intent', async () => {
  const f = await fixture();
  const first = await request(f, 'PAUSE');
  await assert.rejects(request(f, 'CANCEL'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONTROL_CONFLICT');
  const second = await request(f, 'CANCEL', first.result.control_request_id);
  assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, first.result.control_request_id)).status, 'SUPERSEDED');
  assert.equal((await applySafeControl(app.db, f.runId))?.id, second.result.control_request_id);
  assert.equal((await runState(f.runId)).status, 'CANCELLED');
  assert.deepEqual([ (await taskState(f.taskId)).status, (await taskState(f.taskId)).executor_kind ], ['READY', 'HUMAN']);
  await assert.rejects(request(f, 'PAUSE'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'RUN_TERMINAL');
});

test('P08 control arriving before Fake publish dispatch prevents the effect', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  const gate = barrier();
  const worker = advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterClaim: gate.wait } });
  await gate.entered;
  const control = await request(f, 'CANCEL');
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'PENDING');
  gate.release();
  const result = await worker;
  assert.equal(result.status, 'CONTROL_PENDING', JSON.stringify(result));
  assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, control.result.control_request_id)).status, 'APPLIED');
  assert.equal((await runState(f.runId)).status, 'CANCELLED');
  const versions = await sql<{ count: bigint }>`select count(*) as count from artifact_versions v join artifacts a on a.id = v.artifact_id where a.task_id = ${f.taskId}`.execute(app.db);
  assert.equal(versions.rows[0]?.count, 0n);
  const effects = await sql<{ status: string; dispatch_count: number }>`select status, dispatch_count from run_effect_actions where run_id = ${f.runId}`.execute(app.db);
  assert.deepEqual(effects.rows.map((row) => [row.status, row.dispatch_count]), [['PREPARED', 0]]);
});

test('P08 control arriving after dispatch waits for the same Fake effect to settle', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  const gate = barrier();
  const worker = advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: gate.wait } });
  await gate.entered;
  const control = await request(f, 'PAUSE');
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'PENDING');
  gate.release();
  const result = await worker;
  assert.equal(result.status, 'STEP_SUCCEEDED', JSON.stringify(result));
  assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, control.result.control_request_id)).status, 'APPLIED');
  assert.equal((await runState(f.runId)).status, 'PAUSED');
  const versions = await sql<{ count: bigint }>`select count(*) as count from artifact_versions v join artifacts a on a.id = v.artifact_id where a.task_id = ${f.taskId}`.execute(app.db);
  assert.equal(versions.rows[0]?.count, 1n);
});

test('P08 a known pre-effect failure releases its claim, while an uncertain dispatched effect retains it', async () => {
  const draft = await fixture();
  assert.equal((await advanceRunStep(app.db, { runId: draft.runId, workerId: draft.workerId,
    storage: draft.storage })).status, 'STEP_SUCCEEDED');
  await assert.rejects(advanceRunStep(app.db, { runId: draft.runId, workerId: draft.workerId,
    storage: draft.storage, hooks: { beforeCommit: async () => { throw new Error('known DRAFT failure'); } } }),
  /known DRAFT failure/u);
  assert.equal((await runState(draft.runId)).worker_id, null);
  assert.equal((await advanceRunStep(app.db, { runId: draft.runId, workerId: `${draft.workerId}-next`,
    storage: draft.storage })).status, 'STEP_SUCCEEDED');

  const effect = await fixture();
  await advanceToPersist(effect);
  await assert.rejects(advanceRunStep(app.db, { runId: effect.runId, workerId: effect.workerId,
    storage: effect.storage, hooks: { afterEffectDispatch: async () => { throw new Error('uncertain publish'); } } }),
  /uncertain publish/u);
  assert.equal((await runState(effect.runId)).worker_id, effect.workerId);
  const effectRows = await sql<{ status: string }>`select status from run_effect_actions where run_id = ${effect.runId}`.execute(app.db);
  assert.equal(effectRows.rows[0]?.status, 'DISPATCHING');
});

test('P08 scanner fences a stopped worker and retries a missing effect with the same operation_id', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: async () => { throw new SimulatedWorkerCrash('after dispatch'); } } }), SimulatedWorkerCrash);
  const before = await sql<{ operation_id: string; status: string }>`select operation_id, status from run_effect_actions where run_id = ${f.runId}`.execute(app.db);
  assert.equal(before.rows[0]?.status, 'DISPATCHING');
  await sql`update runs set worker_lease_until = now() - interval '1 second' where id = ${f.runId}`.execute(app.db);
  assert.ok((await scanRecoveryCandidates(app.db)).some((row) => row.run_id === f.runId));
  const recovered = await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
    stoppedEvidence: 'test: child worker terminated', storage: f.storage });
  assert.equal(recovered.fenced, true);
  assert.deepEqual(recovered.unresolved_operation_ids, []);
  const result = await advanceRunStep(app.db, { runId: f.runId, workerId: `${f.workerId}-restart`, storage: f.storage });
  assert.equal(result.status, 'STEP_SUCCEEDED', JSON.stringify(result));
  const after = await sql<{ operation_id: string; status: string; dispatch_count: number }>`select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}`.execute(app.db);
  assert.equal(after.rows[0]?.operation_id, before.rows[0]?.operation_id);
  assert.deepEqual([after.rows[0]?.status, after.rows[0]?.dispatch_count], ['SUCCEEDED', 2]);
});

test('M03 effect reconciliation waits in Task→Run order before touching the effect row', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId,
    storage: f.storage, hooks: { afterEffectDispatch: async () => {
      throw new SimulatedWorkerCrash('after dispatch before publish');
    } } }), SimulatedWorkerCrash);
  const effect = await sql<{ operation_id: string; status: string }>`
    select operation_id, status from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  assert.equal(effect.rows[0]?.status, 'DISPATCHING');
  const draft = await sql<{ result_ref: { content: string } }>`
    select result_ref from run_steps where run_id = ${f.runId} and step_kind = 'DRAFT'
  `.execute(app.db);
  assert.ok(draft.rows[0]?.result_ref.content);
  await f.storage.publish({ artifactId: f.runId, versionId: effect.rows[0]!.operation_id,
    content: Buffer.from(draft.rows[0]!.result_ref.content, 'utf8') });
  const events = new RunEventRepository(app.db);
  const before = await events.latestVisibleSeq(f.workspaceId, f.runId);
  assert.ok(before !== null);

  const recoveryDb = openDatabase(APP_DATABASE_URL, 'relay-m03-effect-recovery-order');
  const blockerDb = openDatabase(APP_DATABASE_URL, 'relay-m03-effect-blocker');
  const fenceGate = barrier();
  const recovery = recoverStoppedWorker(recoveryDb.db, { runId: f.runId,
    stoppedWorkerId: f.workerId, stoppedEvidence: 'test: stopped process',
    storage: f.storage, hooks: { afterFence: fenceGate.wait } });
  let releaseBlocker!: () => void;
  let blockerEntered!: () => void;
  const held = new Promise<void>((done) => { releaseBlocker = done; });
  const locked = new Promise<void>((done) => { blockerEntered = done; });
  let blocker: Promise<void> | undefined;
  try {
    await withTimeout(fenceGate.entered, 5000, 'recovery to commit the fence');
    blocker = blockerDb.db.transaction().execute(async (transaction) => {
      await lockTaskAndRun(createRepositories(transaction), f.runId);
      blockerEntered();
      await held;
      await sql`select operation_id from run_effect_actions
        where run_id = ${f.runId} for update`.execute(transaction);
    });
    await withTimeout(locked, 5000, 'the competing writer to hold Task and Run');
    fenceGate.release();
    await withTimeout((async () => {
      while (true) {
        const activity = await sql<{ waiting: boolean }>`
          select exists(select 1 from pg_stat_activity
            where application_name = 'relay-m03-effect-recovery-order'
              and wait_event_type = 'Lock') as waiting
        `.execute(app.db);
        if (activity.rows[0]?.waiting) return;
        await delay(10);
      }
    })(), 5000, 'recovery to wait on the business lock');
    releaseBlocker();
    await withTimeout(blocker, 5000, 'the competing writer to lock effect without deadlock');
    const result = await withTimeout(recovery, 5000, 'effect recovery after Run unlock');
    assert.deepEqual(result.unresolved_operation_ids, []);
    const resolved = await sql<{ operation_id: string; status: string }>`
      select operation_id, status from run_effect_actions where run_id = ${f.runId}
    `.execute(app.db);
    assert.deepEqual(resolved.rows[0], { operation_id: effect.rows[0]!.operation_id, status: 'SUCCEEDED' });
    const rows = await events.listAfter(f.runId, before, 20);
    assert.ok(rows.some((row) => row.kind === 'EFFECT_CHANGED'));
    rows.forEach((row, index) => assert.equal(row.seq, before + BigInt(index + 1)));
  } finally {
    fenceGate.release();
    releaseBlocker();
    await Promise.allSettled([blocker, recovery]);
    await blockerDb.close();
    await recoveryDb.close();
  }
});

test('P08 a crash after publish reconciles success without a second publish or artifact version', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { beforeCommit: async () => { throw new SimulatedWorkerCrash('after publish'); } } }), SimulatedWorkerCrash);
  const first = await sql<{ operation_id: string; status: string; dispatch_count: number }>`select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}`.execute(app.db);
  assert.deepEqual([first.rows[0]?.status, first.rows[0]?.dispatch_count], ['SUCCEEDED', 1]);
  await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
    stoppedEvidence: 'test: child worker terminated', storage: f.storage });
  const result = await advanceRunStep(app.db, { runId: f.runId, workerId: `${f.workerId}-restart`, storage: f.storage });
  assert.equal(result.status, 'STEP_SUCCEEDED', JSON.stringify(result));
  const after = await sql<{ operation_id: string; dispatch_count: number }>`select operation_id, dispatch_count from run_effect_actions where run_id = ${f.runId}`.execute(app.db);
  assert.equal(after.rows[0]?.operation_id, first.rows[0]?.operation_id);
  assert.equal(after.rows[0]?.dispatch_count, 1);
  const versions = await sql<{ count: bigint }>`select count(*) as count from artifact_versions v join artifacts a on a.id = v.artifact_id where a.task_id = ${f.taskId}`.execute(app.db);
  assert.equal(versions.rows[0]?.count, 1n);
});

test('P08 a second crash after durable fence resumes reconciliation with the same operation_id', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: async () => { throw new SimulatedWorkerCrash('after dispatch'); } } }), SimulatedWorkerCrash);
  const before = await sql<{ operation_id: string; dispatch_count: number }>`
    select operation_id, dispatch_count from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  await assert.rejects(recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
    stoppedEvidence: 'test: first worker process stopped', storage: f.storage,
    hooks: { afterFence: async () => { throw new SimulatedWorkerCrash('after fence commit'); } } }), SimulatedWorkerCrash);
  assert.equal((await runState(f.runId)).worker_id, null);
  assert.ok((await scanRecoveryCandidates(app.db)).some((row) => row.run_id === f.runId && row.worker_id === f.workerId));
  const recovered = await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
    stoppedEvidence: 'test: reconfirmed first worker process stopped', storage: f.storage });
  assert.equal(recovered.fenced, false);
  assert.deepEqual(recovered.unresolved_operation_ids, []);
  const result = await advanceRunStep(app.db, { runId: f.runId, workerId: `${f.workerId}-next`, storage: f.storage });
  assert.equal(result.status, 'STEP_SUCCEEDED');
  const after = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
    select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  assert.deepEqual([after.rows[0]?.operation_id, after.rows[0]?.status, after.rows[0]?.dispatch_count],
    [before.rows[0]?.operation_id, 'SUCCEEDED', 2]);
});

test('P08 a logged successful publish with missing or damaged content becomes UNKNOWN and blocks Handoff', async () => {
  for (const damage of ['MISSING', 'TAMPERED'] as const) {
    const f = await fixture();
    await advanceToPersist(f);
    await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
      hooks: { beforeCommit: async () => { throw new SimulatedWorkerCrash('after publish'); } } }), SimulatedWorkerCrash);
    const effect = await sql<{ operation_id: string; status: string; target_ref: string }>`
      select operation_id, status, target_ref from run_effect_actions where run_id = ${f.runId}
    `.execute(app.db);
    assert.equal(effect.rows[0]?.status, 'SUCCEEDED');
    const path = resolveStoredContentPath(f.storage.dataRoot, effect.rows[0]!.target_ref);
    if (damage === 'MISSING') await unlink(path);
    else await writeFile(path, 'damaged content');
    const handoff = await request(f, 'HANDOFF');
    assert.equal((await applySafeControl(app.db, f.runId))?.status, 'PENDING');
    const recovered = await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
      stoppedEvidence: `test: stopped before ${damage} reconciliation`, storage: f.storage });
    assert.deepEqual(recovered.unresolved_operation_ids, [effect.rows[0]?.operation_id]);
    const again = await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
      stoppedEvidence: 'test: worker remains stopped', storage: f.storage });
    assert.deepEqual(again.unresolved_operation_ids, [effect.rows[0]?.operation_id]);
    const current = await sql<{ status: string; dispatch_count: number }>`
      select status, dispatch_count from run_effect_actions where run_id = ${f.runId}
    `.execute(app.db);
    assert.deepEqual([current.rows[0]?.status, current.rows[0]?.dispatch_count], ['UNKNOWN', 1]);
    assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, handoff.result.control_request_id)).status, 'PENDING');
    assert.equal((await taskState(f.taskId)).executor_kind, 'AI');
  }
});

test('P08 a verified published effect can finish a waiting Handoff while retaining the orphan target', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { beforeCommit: async () => { throw new SimulatedWorkerCrash('after publish'); } } }), SimulatedWorkerCrash);
  const handoff = await request(f, 'HANDOFF');
  await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
    stoppedEvidence: 'test: worker stopped after publish', storage: f.storage });
  const decided = await readControlRequest(app.db, f.workspaceId, f.runId, handoff.result.control_request_id);
  assert.equal(decided.status, 'APPLIED');
  assert.equal((await taskState(f.taskId)).executor_kind, 'HUMAN');
  assert.equal((await runState(f.runId)).status, 'CANCELLED');
  const versions = await sql<{ count: bigint }>`
    select count(*) as count from artifact_versions v join artifacts a on a.id = v.artifact_id where a.task_id = ${f.taskId}
  `.execute(app.db);
  assert.equal(versions.rows[0]?.count, 0n);
});

test('P08 Handoff stores deterministic step and candidate references with or without a committed candidate', async () => {
  const empty = await fixture();
  const emptyRequest = await request(empty, 'HANDOFF');
  await applySafeControl(app.db, empty.runId);
  const emptyRef = (await readControlRequest(app.db, empty.workspaceId, empty.runId,
    emptyRequest.result.control_request_id)).result_ref?.handoff as { candidate_artifact_version_id: string | null; step_positions: unknown[] };
  assert.equal(emptyRef.candidate_artifact_version_id, null);
  assert.equal(emptyRef.step_positions.length, 5);

  const candidate = await fixture();
  await advanceToPersist(candidate);
  const persisted = await advanceRunStep(app.db, { runId: candidate.runId, workerId: candidate.workerId,
    storage: candidate.storage });
  assert.equal(persisted.status, 'STEP_SUCCEEDED');
  const versionId = persisted.result_ref?.artifact_version_id;
  assert.ok(typeof versionId === 'string');
  const requestWithCandidate = await request(candidate, 'HANDOFF');
  await applySafeControl(app.db, candidate.runId);
  const candidateRef = (await readControlRequest(app.db, candidate.workspaceId, candidate.runId,
    requestWithCandidate.result.control_request_id)).result_ref?.handoff as { candidate_artifact_version_id: string | null; step_positions: unknown[] };
  assert.equal(candidateRef.candidate_artifact_version_id, versionId);
  assert.equal(candidateRef.step_positions.length, 5);
});

test('P08 tampered Fake effect remains UNKNOWN and blocks Handoff after worker fencing', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: async () => { throw new SimulatedWorkerCrash('after dispatch'); } } }), SimulatedWorkerCrash);
  const effect = await sql<{ operation_id: string; status: string }>`
    select operation_id, status from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  const operationId = effect.rows[0]?.operation_id;
  assert.ok(operationId);
  await f.storage.publish({ artifactId: f.runId, versionId: operationId,
    content: Buffer.from('different content', 'utf8') });
  const handoff = await request(f, 'HANDOFF');
  assert.equal((await applySafeControl(app.db, f.runId))?.status, 'PENDING');
  const recovered = await recoverStoppedWorker(app.db, { runId: f.runId, stoppedWorkerId: f.workerId,
    stoppedEvidence: 'test: worker stopped', storage: f.storage });
  assert.deepEqual(recovered.unresolved_operation_ids, [operationId]);
  assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, handoff.result.control_request_id)).status, 'PENDING');
  assert.equal((await taskState(f.taskId)).executor_kind, 'AI');
  assert.deepEqual((await readRunById(app.db, f.workspaceId, f.runId)).unresolved_operation_ids, [operationId]);
  const after = await sql<{ status: string; dispatch_count: number }>`
    select status, dispatch_count from run_effect_actions where operation_id = ${operationId}
  `.execute(app.db);
  assert.deepEqual([after.rows[0]?.status, after.rows[0]?.dispatch_count], ['UNKNOWN', 1]);
  const attempt = await sql<{ status: string }>`
    select a.status from step_attempts a join run_effect_actions e on e.attempt_id = a.id
    where e.operation_id = ${operationId}
  `.execute(app.db);
  assert.equal(attempt.rows[0]?.status, 'RUNNING');
});

test('P08 completion and control serialize: earlier control prevents completion, earlier completion rejects control', async () => {
  const f = await fixture('MARKDOWN_STRUCTURE');
  for (const kind of ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY']) {
    const result = await advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  const gate = barrier();
  const worker = advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { beforeCommit: gate.wait } });
  await gate.entered;
  const control = await request(f, 'CANCEL');
  gate.release();
  assert.equal((await worker).status, 'CONTROL_PENDING');
  assert.equal((await readControlRequest(app.db, f.workspaceId, f.runId, control.result.control_request_id)).status, 'APPLIED');
  assert.equal((await runState(f.runId)).status, 'CANCELLED');
  const completions = await sql<{ count: bigint }>`select count(*) as count from completion_records where task_id = ${f.taskId}`.execute(app.db);
  assert.equal(completions.rows[0]?.count, 0n);

  const completed = await fixture('MARKDOWN_STRUCTURE');
  for (const kind of ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY', 'COMPLETE']) {
    const result = await advanceRunStep(app.db, { runId: completed.runId, workerId: completed.workerId,
      storage: completed.storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  assert.equal((await runState(completed.runId)).status, 'COMPLETED');
  await assert.rejects(request(completed, 'CANCEL'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'RUN_TERMINAL');
});

test('P08 an exited Worker process is fenced and a new Worker process reuses its operation_id', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  const crashed = await runWorkerChild('crash-after-dispatch', f);
  assert.equal(crashed.exitCode, 92, crashed.stderr);
  const effect = await sql<{ operation_id: string; status: string }>`select operation_id, status from run_effect_actions where run_id = ${f.runId}`.execute(app.db);
  assert.equal(effect.rows[0]?.status, 'DISPATCHING');
  await sql`update runs set worker_lease_until = now() - interval '1 second' where id = ${f.runId}`.execute(app.db);
  const continued = await runWorkerChild('recover', f);
  assert.equal(continued.exitCode, 0, continued.stderr);
  assert.deepEqual(JSON.parse(continued.stdout), { candidate: true, fenced: true, status: 'STEP_SUCCEEDED' });
  const finalEffect = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
    select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  assert.equal(finalEffect.rows[0]?.operation_id, effect.rows[0]?.operation_id);
  assert.deepEqual([finalEffect.rows[0]?.status, finalEffect.rows[0]?.dispatch_count], ['SUCCEEDED', 2]);
});

test('P08 HTTP exposes control receipt, Run projection, Resume and AI-owned Task cancel as 202', async () => {
  const f = await fixture();
  const api = await startTestApi();
  try {
    const base = workspacePath(f.workspaceId);
    const pauseId = randomUUID();
    const pauseResponse = await api.post(`${base}/runs/${f.runId}/control-requests`, {
      command_id: pauseId, expected_task_revision: '1', expected_run_revision: '0', type: 'PAUSE',
    });
    const pause = expectCommandAccepted(pauseResponse, 202, pauseId);
    assert.equal(pause.status, 'PENDING');
    const controlId = pause.control_request_id as string;
    const control = await api.get(`${base}/runs/${f.runId}/control-requests/${controlId}`);
    assert.equal(control.status, 200);
    assert.equal((control.body as { status: string }).status, 'APPLIED');
    const task = await api.get(`${base}/tasks/${f.taskId}`);
    assert.equal(task.status, 200);
    const taskBody = task.body as { status: string; revision: string; waiting_reason: string | null };
    assert.deepEqual([taskBody.status, taskBody.waiting_reason], ['WAITING', 'PAUSED_BY_USER']);
    const run = await api.get(`${base}/runs/${f.runId}`);
    const runBody = run.body as { revision: string; pending_control_request: unknown; unresolved_operation_ids: unknown[] };
    assert.equal(runBody.pending_control_request, null);
    assert.deepEqual(runBody.unresolved_operation_ids, []);
    const resumeId = randomUUID();
    const resumeResponse = await api.post(`${base}/runs/${f.runId}/resume`, {
      command_id: resumeId, expected_task_revision: taskBody.revision, expected_run_revision: runBody.revision,
    });
    assert.equal(expectCommandAccepted(resumeResponse, 202, resumeId).status, 'CONTEXT_BUILDING');
    const currentTask = (await api.get(`${base}/tasks/${f.taskId}`)).body as { revision: string };
    const currentRun = (await api.get(`${base}/runs/${f.runId}`)).body as { revision: string };
    const cancelId = randomUUID();
    const cancelResponse = await api.post(`${base}/tasks/${f.taskId}/cancel`, {
      command_id: cancelId, expected_task_revision: currentTask.revision,
      expected_run_revision: currentRun.revision,
    });
    const cancel = expectCommandAccepted(cancelResponse, 202, cancelId);
    assert.equal(cancel.status, 'PENDING');
    assert.equal(cancel.type, 'CANCEL_TASK');
    const cancelled = await api.get(`${base}/runs/${f.runId}/control-requests/${cancel.control_request_id as string}`);
    assert.equal((cancelled.body as { status: string }).status, 'APPLIED');
    assert.equal((await taskState(f.taskId)).status, 'CANCELLED');

    const human = await fixture();
    await request(human, 'CANCEL');
    await applySafeControl(app.db, human.runId);
    const humanTask = await taskState(human.taskId);
    assert.deepEqual([humanTask.status, humanTask.executor_kind], ['READY', 'HUMAN']);
    const humanCancelId = randomUUID();
    const humanCancel = await api.post(`${workspacePath(human.workspaceId)}/tasks/${human.taskId}/cancel`, {
      command_id: humanCancelId, expected_task_revision: humanTask.revision.toString(),
    });
    assert.equal(expectCommandAccepted(humanCancel, 200, humanCancelId).status, 'CANCELLED');
  } finally { await api.stop(); }
});

test('P08 a real API process restart preserves PENDING and the new process reads the safe outcome', async () => {
  const f = await fixture();
  await advanceToPersist(f);
  let api = await startTestApi();
  const gate = barrier();
  const worker = advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: gate.wait } });
  try {
    await gate.entered;
    const task = await taskState(f.taskId);
    const run = await runState(f.runId);
    const commandId = randomUUID();
    const base = workspacePath(f.workspaceId);
    const response = await api.post(`${base}/runs/${f.runId}/control-requests`, {
      command_id: commandId, expected_task_revision: task.revision.toString(),
      expected_run_revision: run.revision.toString(), type: 'PAUSE',
    });
    const result = expectCommandAccepted(response, 202, commandId);
    const controlId = result.control_request_id as string;
    await api.stop();
    api = await startTestApi();
    const pending = await api.get(`${base}/runs/${f.runId}/control-requests/${controlId}`);
    assert.equal((pending.body as { status: string }).status, 'PENDING');
    const projection = await api.get(`${base}/runs/${f.runId}`);
    assert.equal((projection.body as { pending_control_request: { id: string } | null }).pending_control_request?.id, controlId);
    gate.release();
    assert.equal((await worker).status, 'STEP_SUCCEEDED');
    const applied = await api.get(`${base}/runs/${f.runId}/control-requests/${controlId}`);
    assert.equal((applied.body as { status: string }).status, 'APPLIED');
    assert.equal((await runState(f.runId)).status, 'PAUSED');
  } finally {
    gate.release();
    await Promise.allSettled([worker]);
    await api.stop();
  }
});
