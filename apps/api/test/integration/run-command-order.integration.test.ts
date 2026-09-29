import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import { applySafeControl, requestRunControl, resumeRun } from '../../src/application/control-requests.js';
import { recoverStoppedWorker } from '../../src/application/recover-run.js';
import { claimNextRunCommand, settleRunCommand } from '../../src/application/run-dispatch.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { runSupervisedWorkerOnce } from '../../src/worker/supervisor.js';
import {
  createTemporaryDatabase, expectSqlState, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase,
} from './integration-support.js';
import {
  createWorkspace, expectCommandAccepted, startTestApi, withTimeout, workspacePath, type TestApi,
} from './api-harness.js';

const WORKER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'worker', 'main.js');
const SUPERVISOR_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'worker', 'supervisor-main.js');
let temporaryDatabase: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let api: TestApi;
let workspaceId: string;

before(async () => {
  temporaryDatabase = await createTemporaryDatabase('m03_order');
  await runMigrations({ connectionString: temporaryDatabase.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(temporaryDatabase.migrationUrl);
  app = openDatabase(temporaryDatabase.appUrl, 'relay-m03-order-test');
  api = await startTestApi({ databaseUrl: temporaryDatabase.appUrl });
  workspaceId = await createWorkspace(app.db);
});

after(async () => {
  if (api !== undefined) await api.stop();
  if (app !== undefined) await app.close();
  if (temporaryDatabase !== undefined) await temporaryDatabase.drop();
});

async function delegatedRun(): Promise<{ runId: string; taskId: string }> {
  const projectCommandId = randomUUID();
  const project = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: projectCommandId, title: `order-${projectCommandId.slice(0, 8)}`, project_type: 'GENERAL',
  }), 201, projectCommandId);
  const taskCommandId = randomUUID();
  const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: taskCommandId, project_id: project.project_id, title: 'Approval ordering',
    objective: 'Keep the old invocation out of approved work',
    criteria: [{ criterion_id: 'human', statement: 'Human approves this result', method: 'HUMAN' }],
  }), 201, taskCommandId);
  const readyCommandId = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id as string}/ready`), {
    command_id: readyCommandId, expected_revision: task.revision,
  }), 200, readyCommandId);
  const delegateCommandId = randomUUID();
  const delegated = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.task_id as string}/delegations`), {
    command_id: delegateCommandId, expected_task_revision: ready.revision,
  }), 202, delegateCommandId);
  return { runId: delegated.run_id as string, taskId: task.task_id as string };
}

async function reviewFor(runId: string): Promise<{ id: string; revision: string; target_hash: string }> {
  const listed = await api.get(workspacePath(workspaceId, '/reviews?status=OPEN'));
  assert.equal(listed.status, 200, listed.text);
  const item = (listed.body as { items: Array<{ id: string; run_id: string | null;
    revision: string; target_hash: string }> }).items.find((row) => row.run_id === runId);
  assert.ok(item, `Run ${runId} must have an OPEN Review`);
  return item;
}

async function approveReview(runId: string, commandId: string): Promise<{ reviewId: string;
  body: { command_id: string; expected_revision: string; target_hash: string; decision: 'ACCEPT' } }> {
  const review = await reviewFor(runId);
  const body = { command_id: commandId, expected_revision: review.revision,
    target_hash: review.target_hash, decision: 'ACCEPT' as const };
  const decided = api.post(workspacePath(workspaceId, `/reviews/${review.id}/decisions`), body);
  const result = expectCommandAccepted(await decided, 200, commandId);
  assert.equal(result.review_id, review.id);
  return { reviewId: review.id, body };
}

async function runWorkerOnce(): Promise<number | null> {
  const child = spawn(process.execPath, [WORKER_ENTRY, '--once'], {
    env: { ...process.env, RELAY_DB_URL: temporaryDatabase.appUrl,
      RELAY_DATA_ROOT: api.dataRoot, RELAY_WORKER_ID: `worker:${randomUUID()}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  const exit = await withTimeout(new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }), 20_000, 'independent Mock Worker');
  assert.equal(exit, 0, output);
  return exit;
}

test('G02: fast approval cannot let the old START invocation execute COMPLETE', async () => {
  const run = await delegatedRun();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const waiting = new Promise<void>((done) => { entered = done; });
  const old = runOneCommand(app.db, {
    workerId: `worker:${randomUUID()}`, dataRoot: api.dataRoot,
    checkpointUrl: temporaryDatabase.appUrl,
    afterStep: async (step) => {
      if (step.status === 'STEP_SUCCEEDED' && step.run_status === 'WAITING_APPROVAL') {
        entered();
        await held;
      }
    },
  });
  try {
    await withTimeout(waiting, 15_000, 'old Worker at Review wait');
    const oldClaim = await sql<{ status: string }>`
      select status from run_invocations where run_id = ${run.runId}
    `.execute(app.db);
    assert.equal(oldClaim.rows[0]?.status, 'ACTIVE');
    const commandId = randomUUID();
    const approval = await approveReview(run.runId, commandId);
    const replay = await api.post(workspacePath(workspaceId,
      `/reviews/${approval.reviewId}/decisions`), approval.body);
    assert.equal(replay.status, 200, replay.text);
    const duplicate = await api.post(workspacePath(workspaceId,
      `/reviews/${approval.reviewId}/decisions`),
    { ...approval.body, command_id: randomUUID() });
    assert.equal(duplicate.status, 409, duplicate.text);
    const foreignWorkspace = await createWorkspace(app.db);
    const foreign = await api.post(workspacePath(foreignWorkspace,
      `/reviews/${approval.reviewId}/decisions`),
    { ...approval.body, command_id: randomUUID() });
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(await claimNextRunCommand(app.db, `worker:${randomUUID()}`), undefined,
      'new RESUME must wait for its START predecessor and the occupied slot');
  } finally { release(); }
  const settled = await withTimeout(old, 15_000, 'old START to release its invocation');
  assert.equal(settled?.outcome, 'DONE');
  const runView = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal((runView.body as { status: string }).status, 'VERIFYING',
    'old START must not execute COMPLETE after fast approval');
  await runWorkerOnce();
  const finished = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal((finished.body as { status: string }).status, 'COMPLETED');
  const commands = await sql<{ kind: string; status: string; ordinal: bigint;
    source_command_id: string; review_decision_id: string | null }>`
    select c.kind, o.status, c.ordinal, c.source_command_id, c.review_decision_id
    from run_commands c join run_command_outbox o on o.command_id = c.id
    where c.run_id = ${run.runId} order by c.created_at, c.id
  `.execute(app.db);
  assert.deepEqual(commands.rows.map((row) => [row.kind, row.status]),
    [['START', 'DONE'], ['RESUME', 'DONE']]);
  assert.deepEqual(commands.rows.map((row) => row.ordinal), [1n, 2n]);
  const decisions = await sql<{ id: string; command_id: string }>`
    select id, command_id from review_decisions where review_id in (
      select id from review_requests where run_id = ${run.runId}
    )
  `.execute(app.db);
  assert.equal(decisions.rows.length, 1, 'HTTP replay must retain one Review decision');
  assert.equal(commands.rows[1]?.source_command_id, decisions.rows[0]?.command_id);
  assert.equal(commands.rows[1]?.review_decision_id, decisions.rows[0]?.id);
  await expectSqlState('42501', 'application role mutating immutable Run command',
    () => sql`update run_commands set ordinal = 9 where run_id = ${run.runId}`.execute(app.db));
  await expectSqlState('23505', 'one Review decision queuing a second RESUME',
    () => sql`insert into run_commands
      (id, workspace_id, run_id, source_command_id, kind, ordinal, review_decision_id)
      values (${randomUUID()}, ${workspaceId}, ${run.runId}, ${randomUUID()},
        'RESUME', 3, ${decisions.rows[0]?.id})`.execute(app.db));
});

test('M03 pending PAUSE, CANCEL and HANDOFF outrank an approved successor at the old START safe point', async () => {
  for (const type of ['PAUSE', 'CANCEL', 'HANDOFF'] as const) {
    const run = await delegatedRun();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const waiting = new Promise<void>((done) => { entered = done; });
    let oldClaim: { workerId: string; epoch: bigint; commandId: string } | undefined;
    const old = runOneCommand(app.db, {
      workerId: `worker:${randomUUID()}`, dataRoot: api.dataRoot,
      checkpointUrl: temporaryDatabase.appUrl,
      afterStep: async (step, claim) => {
        if (step.status === 'STEP_SUCCEEDED' && step.run_status === 'WAITING_APPROVAL') {
          oldClaim = { workerId: claim.workerId, epoch: claim.epoch, commandId: claim.commandId };
          entered();
          await held;
        }
      },
    });
    try {
      await withTimeout(waiting, 15_000, `${type} old START at approval wait`);
      await approveReview(run.runId, randomUUID());
      const revision = await sql<{ task_revision: bigint; run_revision: bigint }>`
        select t.revision as task_revision, r.revision as run_revision
        from tasks t join runs r on r.task_id = t.id where r.id = ${run.runId}
      `.execute(app.db);
      assert.ok(revision.rows[0]);
      await requestRunControl(app.db, { workspaceId, runId: run.runId, commandId: randomUUID(),
        type, expectedTaskRevision: revision.rows[0].task_revision.toString(),
        expectedRunRevision: revision.rows[0].run_revision.toString() });
      assert.ok(oldClaim);
      const result = await advanceRunStep(app.db, { runId: run.runId,
        workerId: oldClaim.workerId, invocationEpoch: oldClaim.epoch,
        storage: new ManagedContentStore(api.dataRoot) });
      assert.equal(result.status, 'CONTROL_PENDING', `${type} must win before COMMAND_SUPERSEDED`);
      const controls = await sql<{ status: string }>`select status from run_control_requests
        where run_id = ${run.runId} order by requested_at desc limit 1`.execute(app.db);
      assert.equal(controls.rows[0]?.status, 'PENDING',
        'the old invocation must stop before its control becomes applied');
    } finally {
      release();
      const settled = await withTimeout(old, 15_000, `${type} old START release`);
      if (settled?.outcome === 'LOST') {
        // LOST 只说明本地投递被控制轮询中止：claim 仍被旧投递占用。与
        // supervisor 见证子进程退出后的顺序一致，必须先停机核对（fence +
        // 效果核对），再 requeue，重投递才可能领取；原编排先领取再 requeue，
        // 第一次尝试必然拿到 undefined。
        assert.ok(oldClaim);
        const stopAndRequeue = async (workerId: string, commandId: string): Promise<void> => {
          await recoverStoppedWorker(app.db, { runId: run.runId,
            stoppedWorkerId: workerId,
            stoppedEvidence: 'test: control poll aborted the parked START',
            storage: new ManagedContentStore(api.dataRoot) });
          const invocation = await sql<{ worker_id: string | null; epoch: bigint }>`
            select worker_id, epoch from run_invocations where run_id = ${run.runId}
          `.execute(app.db);
          assert.equal(invocation.rows[0]?.worker_id, workerId,
            `${type}: stop-witness must fence the claim that held the invocation`);
          const outbox = await sql<{ worker_id: string | null; claim_epoch: bigint | null }>`
            select worker_id, claim_epoch from run_command_outbox where command_id = ${commandId}
          `.execute(app.db);
          assert.equal(outbox.rows[0]?.worker_id, workerId,
            `${type}: the stopped outbox claim belongs to the witnessed worker`);
          assert.equal(outbox.rows[0]?.claim_epoch, invocation.rows[0]?.epoch,
            `${type}: invocation and outbox claim epochs must agree before requeue`);
          await withTransaction(app.db, async (repositories) => {
            await repositories.runs.lockRun(run.runId);
            await repositories.dispatch.lockInvocation(run.runId);
            await repositories.dispatch.lockOutbox(commandId);
            await repositories.dispatch.requeueStoppedClaim(run.runId, workerId,
              invocation.rows[0]!.epoch, commandId,
              'test: control poll aborted the parked START');
          });
        };
        await stopAndRequeue(oldClaim.workerId, oldClaim.commandId);
        let applied = false;
        for (let attempt = 0; attempt < 25 && !applied; attempt++) {
          const workerId = `worker:${randomUUID()}`;
          const redelivered = await runOneCommand(app.db, { workerId,
            dataRoot: api.dataRoot, checkpointUrl: temporaryDatabase.appUrl });
          assert.ok(redelivered !== undefined, `${type}: requeued delivery must claim the CONTROL_PENDING command`);
          if (redelivered.outcome !== 'LOST') {
            assert.equal(redelivered.outcome, 'DONE',
              `${type}: replayed delivery settles at the approval wait`);
            applied = true;
            break;
          }
          await stopAndRequeue(workerId, redelivered.commandId);
        }
        assert.ok(applied, `${type}: supervised redelivery must eventually apply the control`);
      } else {
        assert.equal(settled?.outcome, 'DONE');
      }
    }
    const controls = await sql<{ status: string }>`select status from run_control_requests
      where run_id = ${run.runId} order by requested_at desc limit 1`.execute(app.db);
    assert.equal(controls.rows[0]?.status, 'APPLIED',
      `${type}: command settlement must apply the control after releasing the old invocation`);
    const state = await sql<{ status: string }>`select status from runs where id = ${run.runId}`.execute(app.db);
    assert.equal(state.rows[0]?.status, type === 'PAUSE' ? 'PAUSED' : 'CANCELLED', `${type}: terminal convergence`);
  }
});

test('M03 restarted supervisor applies a control left pending after command settlement', async () => {
  const run = await delegatedRun();
  const claim = await claimNextRunCommand(app.db, `worker:${randomUUID()}`);
  assert.equal(claim?.runId, run.runId);
  assert.ok(claim);
  const revision = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from tasks t join runs r on r.task_id = t.id where r.id = ${run.runId}
  `.execute(app.db);
  assert.ok(revision.rows[0]);
  await requestRunControl(app.db, { workspaceId, runId: run.runId, commandId: randomUUID(),
    type: 'PAUSE', expectedTaskRevision: revision.rows[0].task_revision.toString(),
    expectedRunRevision: revision.rows[0].run_revision.toString() });
  // Persist the exact state of a process that exits after delivery settlement
  // but before its follow-up applySafeControl call. No outbox notification remains.
  await withTransaction(app.db, async (repositories) => {
    await repositories.tasks.lockTask(run.taskId);
    await repositories.runs.lockRun(run.runId);
    await repositories.dispatch.lockInvocation(run.runId);
    await repositories.dispatch.lockOutbox(claim.commandId);
    await repositories.dispatch.settleOutbox(claim.commandId, 'DONE', claim.workerId, claim.epoch);
    await repositories.dispatch.releaseInvocation(run.runId, claim.workerId, claim.epoch);
  });
  const stranded = await sql<{ status: string; invocation_status: string }>`
    select c.status, i.status as invocation_status from run_control_requests c
    join run_invocations i on i.run_id = c.run_id where c.run_id = ${run.runId}
  `.execute(app.db);
  assert.deepEqual([stranded.rows[0]?.status, stranded.rows[0]?.invocation_status], ['PENDING', 'IDLE']);
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY, '--once'], {
    env: { ...process.env, RELAY_DB_URL: temporaryDatabase.appUrl,
      RELAY_DATA_ROOT: api.dataRoot, RELAY_SUPERVISOR_DESKTOP_MODE: undefined,
      RELAY_SUPERVISOR_STOP_ON_STDIN_EOF: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { output += chunk; });
  const exit = await withTimeout(new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  }), 20_000, 'restarted supervisor pending-control scan');
  assert.equal(exit, 0, output);
  const applied = await sql<{ status: string; run_status: string }>`
    select c.status, r.status as run_status from run_control_requests c
    join runs r on r.id = c.run_id where c.run_id = ${run.runId}
  `.execute(app.db);
  assert.deepEqual([applied.rows[0]?.status, applied.rows[0]?.run_status], ['APPLIED', 'PAUSED']);
});

test('G04: restarted START after supervised crash cannot consume the approved continuation', async () => {
  const run = await delegatedRun();
  const stopped = await runSupervisedWorkerOnce({ db: app.db,
    databaseUrl: temporaryDatabase.appUrl, dataRoot: api.dataRoot,
    testExitAfterApprovalWait: true });
  assert.equal(stopped.exitCode, 92, stopped.output);
  assert.deepEqual(stopped.requeuedRunIds, [run.runId]);
  const beforeInterrupt = await sql<{ count: bigint }>`
    select count(*)::bigint as count from relay_graph_v1.checkpoint_writes
    where thread_id = ${run.runId} and channel = '__interrupt__'
  `.execute(app.db);
  assert.equal(beforeInterrupt.rows[0]?.count, 0n,
    'the child exited after the Review business commit but before saving the graph interrupt');
  const commandId = randomUUID();
  await approveReview(run.runId, commandId);
  await runWorkerOnce();
  const midway = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal((midway.body as { status: string }).status, 'VERIFYING',
    'requeued START must settle without running approved COMPLETE');
  const afterFirst = await sql<{ kind: string; status: string; invocation_status: string }>`
    select c.kind, o.status, i.status as invocation_status from run_commands c
    join run_command_outbox o on o.command_id = c.id
    join run_invocations i on i.run_id = c.run_id
    where c.run_id = ${run.runId} order by c.ordinal
  `.execute(app.db);
  assert.deepEqual(afterFirst.rows.map((row) => [row.kind, row.status]),
    [['START', 'DONE'], ['RESUME', 'PENDING']]);
  assert.equal(afterFirst.rows[0]?.invocation_status, 'IDLE');
  await runWorkerOnce();
  const completed = await api.get(workspacePath(workspaceId, `/runs/${run.runId}`));
  assert.equal((completed.body as { status: string }).status, 'COMPLETED');
});

test('G04: a later Run command cannot overtake pending, claimed or blocked predecessor', async () => {
  const run = await delegatedRun();
  const start = await sql<{ id: string }>`
    select id from run_commands where run_id = ${run.runId} and kind = 'START'
  `.execute(app.db);
  assert.equal(start.rows.length, 1);
  const successorId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.tasks.lockTask(run.taskId);
    await repositories.dispatch.insertCommand({ id: successorId, workspaceId,
      runId: run.runId, sourceCommandId: randomUUID(), kind: 'RESUME' });
  });
  // Make the successor oldest in the polling index; its ordinal still cannot overtake START.
  await sql`update run_command_outbox set updated_at = now() - interval '1 day'
    where command_id = ${successorId}`.execute(app.db);
  const first = await claimNextRunCommand(app.db, `worker:${randomUUID()}`);
  assert.equal(first?.commandId, start.rows[0]?.id);
  assert.equal(await claimNextRunCommand(app.db, `worker:${randomUUID()}`), undefined,
    'claimed predecessor and active invocation fence the successor');
  assert.ok(first);
  assert.equal(await settleRunCommand(app.db, first, 'BLOCKED'), true);
  assert.equal(await claimNextRunCommand(app.db, `worker:${randomUUID()}`), undefined,
    'a blocked predecessor must not let a successor overtake it');
  const rows = await sql<{ ordinal: bigint; status: string }>`
    select c.ordinal, o.status from run_commands c
    join run_command_outbox o on o.command_id = c.id
    where c.run_id = ${run.runId} order by c.ordinal
  `.execute(app.db);
  assert.deepEqual(rows.rows.map((row) => [row.ordinal, row.status]),
    [[1n, 'BLOCKED'], [2n, 'PENDING']]);
});

test('G02: Review, RESUME, outbox and receipt roll back together on outbox failure', async () => {
  const run = await delegatedRun();
  await runWorkerOnce();
  const review = await reviewFor(run.runId);
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_revision: review.revision,
    target_hash: review.target_hash, decision: 'ACCEPT' };
  const migration = openDatabase(temporaryDatabase.migrationUrl, 'relay-m03-order-fault');
  try {
    await sql`
      create function reject_resume_outbox() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from run_commands where id = new.command_id and kind = 'RESUME') then
          raise exception 'injected RESUME outbox failure';
        end if;
        return new;
      end $$
    `.execute(migration.db);
    await sql`create trigger reject_resume_outbox before insert on run_command_outbox
      for each row execute function reject_resume_outbox()`.execute(migration.db);
    const failed = await api.post(workspacePath(workspaceId,
      `/reviews/${review.id}/decisions`), body);
    assert.notEqual(failed.status, 200, 'outbox insert must abort the entire decision');
    const facts = await sql<{ review_status: string; decisions: bigint; resumes: bigint;
      receipts: bigint; run_status: string }>`
      select r.status as review_status, x.status as run_status,
        (select count(*) from review_decisions where review_id = ${review.id}) as decisions,
        (select count(*) from run_commands where run_id = ${run.runId} and kind = 'RESUME') as resumes,
        (select count(*) from command_receipts where command_id = ${commandId}) as receipts
      from review_requests r join runs x on x.id = r.run_id where r.id = ${review.id}
    `.execute(app.db);
    assert.deepEqual([facts.rows[0]?.review_status, facts.rows[0]?.run_status,
      facts.rows[0]?.decisions, facts.rows[0]?.resumes, facts.rows[0]?.receipts],
    ['OPEN', 'WAITING_APPROVAL', 0n, 0n, 0n]);
  } finally {
    await sql`drop trigger if exists reject_resume_outbox on run_command_outbox`.execute(migration.db);
    await sql`drop function if exists reject_resume_outbox()`.execute(migration.db);
    await migration.close();
  }
  const accepted = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/reviews/${review.id}/decisions`), body), 200, commandId);
  const stored = await sql<{ decisions: bigint; resumes: bigint; outboxes: bigint; receipts: bigint }>`
    select (select count(*) from review_decisions where review_id = ${review.id}) as decisions,
      (select count(*) from run_commands where run_id = ${run.runId} and kind = 'RESUME') as resumes,
      (select count(*) from run_command_outbox o join run_commands c on c.id = o.command_id
        where c.run_id = ${run.runId} and c.kind = 'RESUME') as outboxes,
      (select count(*) from command_receipts where command_id = ${commandId}) as receipts
  `.execute(app.db);
  assert.ok(accepted.decision_id);
  assert.deepEqual(Object.values(stored.rows[0] ?? {}), [1n, 1n, 1n, 1n]);
  await runWorkerOnce();
});

test('G02: resuming a paused Review wait creates no runnable RESUME command', async () => {
  const run = await delegatedRun();
  await runWorkerOnce();
  const beforePause = await sql<{ task_revision: bigint; run_revision: bigint }>`
    select t.revision as task_revision, r.revision as run_revision
    from runs r join tasks t on t.id = r.task_id where r.id = ${run.runId}
  `.execute(app.db);
  assert.ok(beforePause.rows[0]);
  await requestRunControl(app.db, { workspaceId, runId: run.runId,
    commandId: randomUUID(), type: 'PAUSE',
    expectedTaskRevision: beforePause.rows[0].task_revision.toString(),
    expectedRunRevision: beforePause.rows[0].run_revision.toString() });
  assert.equal((await applySafeControl(app.db, run.runId))?.status, 'APPLIED');
  const paused = await sql<{ status: string; resume_phase: string;
    task_revision: bigint; run_revision: bigint }>`
    select r.status, r.resume_phase, t.revision as task_revision, r.revision as run_revision
    from runs r join tasks t on t.id = r.task_id where r.id = ${run.runId}
  `.execute(app.db);
  assert.deepEqual([paused.rows[0]?.status, paused.rows[0]?.resume_phase],
    ['PAUSED', 'WAITING_APPROVAL']);
  const resumeInput = { workspaceId, runId: run.runId, commandId: randomUUID(),
    expectedTaskRevision: paused.rows[0]!.task_revision.toString(),
    expectedRunRevision: paused.rows[0]!.run_revision.toString() };
  const resumed = await resumeRun(app.db, resumeInput);
  assert.equal(resumed.result.status, 'WAITING_APPROVAL');
  assert.equal((await resumeRun(app.db, resumeInput)).replayed, true);
  const queued = await sql<{ count: bigint }>`select count(*)::bigint as count
    from run_commands where run_id = ${run.runId} and kind = 'RESUME'`.execute(app.db);
  assert.equal(queued.rows[0]?.count, 0n);
  assert.equal(await claimNextRunCommand(app.db, `worker:${randomUUID()}`), undefined);
});
