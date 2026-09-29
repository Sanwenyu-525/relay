import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { cancelAssistMessage, createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { claimNextRunCommand, type ClaimedRunCommand } from '../../src/application/run-dispatch.js';
import { advanceRunStep, SimulatedWorkerCrash } from '../../src/application/run-steps.js';
import { recoverStoppedWorker } from '../../src/application/recover-run.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { RunDispatchRepository } from '../../src/run/run-dispatch-repository.js';
import { ManagedContentStore, resolveStoredContentPath } from '../../src/storage/managed-content-store.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { runSupervisedWorkerOnce } from '../../src/worker/supervisor.js';
import {
  MIGRATIONS_DIRECTORY, createTemporaryDatabase, openDatabase, type TemporaryDatabase,
} from './integration-support.js';
import {
  baseEnvironment, createWorkspace, delay, expectCommandAccepted, expectProblem,
  pickFreePort, sendRequest, startApi, startTestApi, stopApi, waitForLiveness,
  withTimeout, workspacePath, type TestApi,
} from './api-harness.js';

const SUPERVISOR_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'worker', 'supervisor-main.js');
const WORKER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'worker', 'main.js');
let api: TestApi;
let temporaryDatabase: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let databaseUrl: string;
let workspaceId: string;

before(async () => {
  temporaryDatabase = await createTemporaryDatabase('m03_dispatch');
  databaseUrl = temporaryDatabase.appUrl;
  await runMigrations({
    connectionString: temporaryDatabase.migrationUrl, directory: MIGRATIONS_DIRECTORY,
  });
  await installGraphCheckpoints(temporaryDatabase.migrationUrl);
  app = openDatabase(databaseUrl, 'relay-m03-dispatch-test');
  api = await startTestApi({ databaseUrl });
  workspaceId = await createWorkspace(app.db);
});

after(async () => {
  if (api !== undefined) await api.stop();
  if (app !== undefined) await app.close();
  if (temporaryDatabase !== undefined) await temporaryDatabase.drop();
});

async function readyTask(): Promise<{ taskId: string; revision: string }> {
  const projectCommandId = randomUUID();
  const project = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: projectCommandId, title: `m03-${projectCommandId.slice(0, 8)}`, project_type: 'GENERAL',
  }), 201, projectCommandId);
  const taskCommandId = randomUUID();
  const task = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: taskCommandId, project_id: project.project_id,
    title: 'M03 transport', objective: 'Create one durable mock Run',
    criteria: [{ statement: 'Human review of the generated artifact' }],
  }), 201, taskCommandId);
  const readyCommandId = randomUUID();
  const ready = expectCommandAccepted(await api.post(
    workspacePath(workspaceId, `/tasks/${task.task_id as string}/ready`), {
      command_id: readyCommandId, expected_revision: task.revision,
    }), 200, readyCommandId);
  return { taskId: task.task_id as string, revision: ready.revision as string };
}

async function delegatedRun(): Promise<{ runId: string; taskId: string; commandId: string;
  revision: string; requestBody: { command_id: string; expected_task_revision: string } }> {
  const task = await readyTask();
  const commandId = randomUUID();
  const requestBody = { command_id: commandId, expected_task_revision: task.revision };
  const result = expectCommandAccepted(await api.post(
    workspacePath(workspaceId, `/tasks/${task.taskId}/delegations`), requestBody,
  ), 202, commandId);
  return { runId: result.run_id as string, taskId: task.taskId,
    commandId, revision: task.revision, requestBody };
}

function pausePoint(): { entered: Promise<void>; wait: () => Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((done) => { enter = done; });
  const held = new Promise<void>((done) => { release = done; });
  return { entered, wait: async () => { enter(); await held; }, release: () => release() };
}

async function claimedPersistStep(workerId = `worker:${randomUUID()}`): Promise<{
  runId: string; workerId: string; commandId: string; epoch: bigint;
}> {
  const { runId } = await delegatedRun();
  const claim = await claimNextRunCommand(app.db, workerId, 5_000);
  assert.ok(claim);
  assert.equal(claim?.runId, runId);
  for (const kind of ['BUILD_CONTEXT', 'DRAFT']) {
    const step = await advanceRunStep(app.db, { runId, workerId,
      invocationEpoch: claim.epoch, leaseMs: 5_000,
      storage: new ManagedContentStore(api.dataRoot) });
    assert.equal(step.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(step)}`);
  }
  return { runId, workerId, commandId: claim.commandId, epoch: claim.epoch };
}

interface DesktopSupervisorProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: Record<string, unknown>[];
  readonly closed: Promise<number | null>;
  readOutput(): string;
}

function startDesktopSupervisor(input: {
  frame?: unknown; rawFrame?: string; once?: boolean; databaseUrl?: string;
  env?: Record<string, string>;
}): DesktopSupervisorProcess {
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY, ...(input.once ? ['--once'] : [])], {
    env: { ...process.env, RELAY_DB_URL: input.databaseUrl ?? databaseUrl,
      RELAY_DATA_ROOT: api.dataRoot, RELAY_SUPERVISOR_DESKTOP_MODE: 'true', ...input.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: Record<string, unknown>[] = [];
  let stdout = '';
  let stderr = '';
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      if (line.startsWith('{')) events.push(JSON.parse(line) as Record<string, unknown>);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.on('error', () => { /* malformed-frame tests may close the child first */ });
  const closed = new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', done);
  });
  if (input.rawFrame !== undefined) child.stdin.write(input.rawFrame);
  else if (input.frame !== undefined) child.stdin.write(`${JSON.stringify(input.frame)}\n`);
  return { child, events, closed, readOutput: () => `${stdout}${stderr}` };
}

async function waitForDesktopEvent(process: DesktopSupervisorProcess, type: string): Promise<Record<string, unknown>> {
  return withTimeout((async () => {
    while (true) {
      const found = process.events.find((event) => event.type === type);
      if (found !== undefined) return found;
      await delay(20);
    }
  })(), 10_000, `desktop ${type}`);
}

function desktopFrame(launchId = randomUUID(), stoppedLaunches: readonly {
  launchId: string; stopEvidence: string;
}[] = []): { nonce: string; launchId: string; stoppedLaunches: readonly {
  launchId: string; stopEvidence: string;
}[] } {
  return { nonce: randomUUID(), launchId, stoppedLaunches };
}

async function forceReplaceClaim(previous: { runId: string; workerId: string;
  commandId: string; epoch: bigint }): Promise<ClaimedRunCommand> {
  await sql`
    update run_invocations set lease_until = clock_timestamp() - interval '1 millisecond'
    where run_id = ${previous.runId} and worker_id = ${previous.workerId}
      and epoch = ${previous.epoch}
  `.execute(app.db);
  await withTransaction(app.db, async (repositories) => {
    await repositories.runs.lockRun(previous.runId);
    assert.ok(await repositories.runs.fenceWorker(previous.runId));
    await repositories.dispatch.lockInvocation(previous.runId);
    await repositories.dispatch.lockOutbox(previous.commandId);
    await repositories.dispatch.requeueStoppedClaim(previous.runId, previous.workerId,
      previous.epoch, previous.commandId, 'test: injected stale publisher');
  });
  const next = await claimNextRunCommand(app.db, `worker:${randomUUID()}`, 5_000);
  assert.ok(next);
  assert.equal(next.runId, previous.runId);
  assert.equal(next.epoch, previous.epoch + 1n);
  return next;
}

test('G01/G04: 202 contains the committed Run, immutable command, outbox and receipt; restart replays it', async () => {
  const task = await readyTask();
  const commandId = randomUUID();
  const path = workspacePath(workspaceId, `/tasks/${task.taskId}/delegations`);
  const body = { command_id: commandId, expected_task_revision: task.revision };
  const accepted = await api.post(path, body);
  const result = expectCommandAccepted(accepted, 202, commandId);
  const runId = result.run_id as string;
  const rows = await sql<{ commands: bigint; outbox: bigint; invocations: bigint; receipts: bigint }>`
    select
      (select count(*) from run_commands where run_id = ${runId}) as commands,
      (select count(*) from run_command_outbox o join run_commands c on c.id = o.command_id
        where c.run_id = ${runId} and o.status = 'PENDING') as outbox,
      (select count(*) from run_invocations where run_id = ${runId} and status = 'IDLE') as invocations,
      (select count(*) from command_receipts where command_id = ${commandId}) as receipts
  `.execute(app.db);
  assert.deepEqual(rows.rows[0], { commands: 1n, outbox: 1n, invocations: 1n, receipts: 1n });

  // Kill the API transport; the command remains in PostgreSQL without a notification.
  assert.equal(await stopApi(api.running), 0);
  const port = await pickFreePort();
  const restarted = startApi(baseEnvironment({ port, allowedOrigin: api.allowedOrigin,
    bearerToken: api.bearerToken, dataRoot: api.dataRoot, databaseUrl }));
  try {
    await waitForLiveness(restarted, port);
    const headers = { authorization: `Bearer ${api.bearerToken}` };
    const replay = await sendRequest(port, 'POST', path, { body, headers });
    assert.equal(replay.status, 202, replay.text);
    assert.deepEqual((replay.body as { result: unknown }).result, result);
    expectProblem(await sendRequest(port, 'POST', path, {
      body: { command_id: commandId, expected_task_revision: '999' }, headers,
    }), 409, 'COMMAND_ID_REUSED');

    const worker = await runSupervisedWorkerOnce({
      db: app.db, databaseUrl, dataRoot: api.dataRoot,
    });
    assert.equal(worker.exitCode, 0, worker.output);
    assert.match(worker.output, /worker_claimed/u);
    assert.match(worker.output, /worker_settled/u);
    const outbox = await sql<{ status: string }>`
      select o.status from run_command_outbox o join run_commands c on c.id = o.command_id
      where c.run_id = ${runId}
    `.execute(app.db);
    assert.equal(outbox.rows[0]?.status, 'DONE');
    const run = await sendRequest(port, 'GET', workspacePath(workspaceId, `/runs/${runId}`), { headers });
    assert.equal(run.status, 200, run.text);
    assert.notEqual((run.body as { status: string }).status, 'CREATED');
  } finally {
    assert.equal(await stopApi(restarted), 0);
    await api.stop();
    api = await startTestApi({ databaseUrl });
  }
});

test('an already aborted shutdown cannot claim or execute a pending command', async () => {
  const { runId } = await delegatedRun();
  const controller = new AbortController();
  controller.abort();
  const result = await runOneCommand(app.db, {
    workerId: `worker:${randomUUID()}`, dataRoot: api.dataRoot, checkpointUrl: databaseUrl,
    signal: controller.signal,
  });
  assert.equal(result, undefined);
  const rows = await sql<{ invocation_status: string; outbox_status: string;
    attempts: bigint; effects: bigint }>`
    select i.status as invocation_status, o.status as outbox_status,
      (select count(*) from step_attempts a join run_steps s on s.id = a.step_id
        where s.run_id = ${runId}) as attempts,
      (select count(*) from run_effect_actions where run_id = ${runId}) as effects
    from run_invocations i join run_commands c on c.run_id = i.run_id
    join run_command_outbox o on o.command_id = c.id where i.run_id = ${runId}
  `.execute(app.db);
  assert.deepEqual(rows.rows[0], { invocation_status: 'IDLE',
    outbox_status: 'PENDING', attempts: 0n, effects: 0n });
  const later = await runSupervisedWorkerOnce({
    db: app.db, databaseUrl, dataRoot: api.dataRoot,
  });
  assert.equal(later.exitCode, 0, later.output);
});

test('shutdown signalled from onClaim does not execute a step after the claim', async () => {
  const { runId } = await delegatedRun();
  const controller = new AbortController();
  const result = await runOneCommand(app.db, {
    workerId: `worker:${randomUUID()}`, dataRoot: api.dataRoot, checkpointUrl: databaseUrl,
    signal: controller.signal,
    onClaim: async () => { controller.abort(); },
  });
  assert.equal(result?.runId, runId);
  assert.equal(result?.outcome, 'LOST');
  const rows = await sql<{ attempts: bigint; effects: bigint }>`
    select (select count(*) from step_attempts a join run_steps s on s.id = a.step_id
      where s.run_id = ${runId}) as attempts,
      (select count(*) from run_effect_actions where run_id = ${runId}) as effects
  `.execute(app.db);
  assert.deepEqual(rows.rows[0], { attempts: 0n, effects: 0n });
});

test('a replaced invocation cannot insert PREPARED after a delayed PERSIST claim', async () => {
  const previous = await claimedPersistStep();
  const gate = pausePoint();
  const stale = advanceRunStep(app.db, { runId: previous.runId, workerId: previous.workerId,
    invocationEpoch: previous.epoch, leaseMs: 5_000,
    storage: new ManagedContentStore(api.dataRoot),
    hooks: { afterClaim: gate.wait } });
  try {
    await withTimeout(gate.entered, 5_000, 'delayed PERSIST claim');
    // This deliberately simulates a false stop report while the old callback is
    // still alive, so the inner domain write fence is tested independently.
    await sql`
      update run_invocations set lease_until = clock_timestamp() - interval '1 millisecond'
      where run_id = ${previous.runId} and epoch = ${previous.epoch}
    `.execute(app.db);
    await recoverStoppedWorker(app.db, { runId: previous.runId,
      stoppedWorkerId: previous.workerId, stoppedEvidence: 'test: injected epoch replacement',
      storage: new ManagedContentStore(api.dataRoot) });
    await withTransaction(app.db, async (repositories) => {
      await repositories.runs.lockRun(previous.runId);
      await repositories.dispatch.lockInvocation(previous.runId);
      await repositories.dispatch.lockOutbox(previous.commandId);
      await repositories.dispatch.requeueStoppedClaim(previous.runId, previous.workerId,
        previous.epoch, previous.commandId, 'test: injected epoch replacement');
    });
    const next = await claimNextRunCommand(app.db, `worker:${randomUUID()}`, 5_000);
    assert.ok(next);
    assert.equal(next?.runId, previous.runId);
    assert.equal(next.epoch, previous.epoch + 1n);
  } finally {
    gate.release();
  }
  await stale;
  const effects = await sql<{ count: bigint }>`
    select count(*) as count from run_effect_actions where run_id = ${previous.runId}
  `.execute(app.db);
  assert.equal(effects.rows[0]?.count, 0n);
});

test('a stale publisher cannot resolve DISPATCHING; recovery reconciles the same operation or leaves UNKNOWN', async () => {
  for (const target of ['PRESENT', 'TAMPERED'] as const) {
    const previous = await claimedPersistStep();
    const gate = pausePoint();
    const stale = advanceRunStep(app.db, { runId: previous.runId, workerId: previous.workerId,
      invocationEpoch: previous.epoch, leaseMs: 5_000,
      storage: new ManagedContentStore(api.dataRoot),
      hooks: { afterEffectDispatch: gate.wait } });
    let operationId: string;
    let targetRef: string;
    try {
      await withTimeout(gate.entered, 5_000, 'dispatched effect before stale epoch');
      const before = await sql<{ operation_id: string; target_ref: string;
        status: string; dispatch_count: number }>`
        select operation_id, target_ref, status, dispatch_count
        from run_effect_actions where run_id = ${previous.runId}
      `.execute(app.db);
      assert.equal(before.rows[0]?.status, 'DISPATCHING');
      assert.equal(before.rows[0]?.dispatch_count, 1);
      operationId = before.rows[0]!.operation_id;
      targetRef = before.rows[0]!.target_ref;
      // Fault injection: advance both the single-step fence and transport
      // invocation while an old callback is still suspended. Production
      // supervision must first prove that the whole old process stopped.
      await forceReplaceClaim(previous);
    } finally {
      gate.release();
    }
    const result = await stale;
    assert.equal(result.status, 'INVOCATION_LOST');
    const afterOld = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
      select operation_id, status, dispatch_count from run_effect_actions
      where run_id = ${previous.runId}
    `.execute(app.db);
    assert.deepEqual(afterOld.rows[0], {
      operation_id: operationId!, status: 'DISPATCHING', dispatch_count: 1,
    });
    if (target === 'TAMPERED') {
      await writeFile(resolveStoredContentPath(api.dataRoot, targetRef!), 'tampered');
    }
    await recoverStoppedWorker(app.db, { runId: previous.runId,
      stoppedWorkerId: previous.workerId, stoppedEvidence: 'test: stale publisher returned',
      storage: new ManagedContentStore(api.dataRoot) });
    const reconciled = await sql<{ operation_id: string; status: string;
      dispatch_count: number; rows: bigint }>`
      select operation_id, status, dispatch_count,
        (select count(*) from run_effect_actions where run_id = ${previous.runId}) as rows
      from run_effect_actions where run_id = ${previous.runId}
    `.execute(app.db);
    assert.deepEqual(reconciled.rows[0], { operation_id: operationId!,
      status: target === 'PRESENT' ? 'SUCCEEDED' : 'UNKNOWN',
      dispatch_count: 1, rows: 1n });
  }
});

test('a stale retry cannot reconcile an existing DISPATCHING effect before recovery', async () => {
  const first = await claimedPersistStep();
  const storage = new ManagedContentStore(api.dataRoot);
  let operationId = '';
  await assert.rejects(advanceRunStep(app.db, {
    runId: first.runId, workerId: first.workerId, invocationEpoch: first.epoch,
    leaseMs: 5_000, storage,
    hooks: { afterEffectDispatch: async () => {
      const effect = await sql<{ operation_id: string; target_ref: string }>`
        select operation_id, target_ref from run_effect_actions where run_id = ${first.runId}
      `.execute(app.db);
      const draft = await sql<{ result_ref: { content?: unknown } }>`
        select result_ref from run_steps where run_id = ${first.runId}
          and step_kind = 'DRAFT'
      `.execute(app.db);
      const content = draft.rows[0]?.result_ref.content;
      assert.equal(typeof content, 'string');
      operationId = effect.rows[0]!.operation_id;
      const published = await storage.publish({
        artifactId: first.runId, versionId: operationId,
        content: Buffer.from(content as string, 'utf8'),
      });
      assert.equal(published.storageRef, effect.rows[0]?.target_ref);
      throw new SimulatedWorkerCrash('published before effect resolution');
    } },
  }), SimulatedWorkerCrash);
  const second = await forceReplaceClaim(first);
  const gate = pausePoint();
  const stale = advanceRunStep(app.db, {
    runId: first.runId, workerId: second.workerId, invocationEpoch: second.epoch,
    leaseMs: 5_000, storage, hooks: { afterEffectIntent: gate.wait },
  });
  try {
    await withTimeout(gate.entered, 5_000, 'existing DISPATCHING intent');
    await forceReplaceClaim({ runId: first.runId, workerId: second.workerId,
      commandId: second.commandId, epoch: second.epoch });
  } finally {
    gate.release();
  }
  const lateResult = await stale;
  const beforeRecovery = await sql<{ operation_id: string; status: string;
    dispatch_count: number }>`
    select operation_id, status, dispatch_count from run_effect_actions
    where run_id = ${first.runId}
  `.execute(app.db);
  assert.deepEqual(beforeRecovery.rows[0], {
    operation_id: operationId, status: 'DISPATCHING', dispatch_count: 1,
  });
  assert.equal(lateResult.status, 'INVOCATION_LOST');
  await recoverStoppedWorker(app.db, { runId: first.runId,
    stoppedWorkerId: second.workerId, stoppedEvidence: 'test: stale retry returned',
    storage });
  const reconciled = await sql<{ operation_id: string; status: string;
    dispatch_count: number }>`
    select operation_id, status, dispatch_count from run_effect_actions
    where run_id = ${first.runId}
  `.execute(app.db);
  assert.deepEqual(reconciled.rows[0], {
    operation_id: operationId, status: 'SUCCEEDED', dispatch_count: 1,
  });
});

test('G05: expired live Worker cannot create a second invocation or write; observed exit requeues the same command', async () => {
  const { runId } = await delegatedRun();
  const workerId = `worker:${randomUUID()}`;
  let resolveClaim!: (claim: { epoch: bigint; child: import('node:child_process').ChildProcessWithoutNullStreams }) => void;
  const claimed = new Promise<{ epoch: bigint; child: import('node:child_process').ChildProcessWithoutNullStreams }>((done) => {
    resolveClaim = done;
  });
  const supervised = runSupervisedWorkerOnce({
    db: app.db, databaseUrl, dataRoot: api.dataRoot,
    workerId, leaseMs: 150, testHoldMs: 5_000,
    onOutput: (line, child) => {
      const event = JSON.parse(line) as { type: string; run_id?: string; epoch?: string };
      if (event.type === 'worker_claimed' && event.run_id === runId && event.epoch !== undefined) {
        resolveClaim({ epoch: BigInt(event.epoch), child });
      }
    },
  });
  const held = await withTimeout(claimed, 5_000, 'held worker claim');
  await app.db.transaction().execute(async (transaction) => {
    // PostgreSQL now() is frozen at transaction start. A lease that expires
    // while this transaction waits must still be rejected at the actual time.
    await sql`select now()`.execute(transaction);
    await delay(300);
    assert.equal(await new RunDispatchRepository(transaction).hasCurrentInvocation(
      runId, workerId, held.epoch), false);
  });
  const late = await advanceRunStep(app.db, { runId, workerId, invocationEpoch: held.epoch,
    storage: new ManagedContentStore(api.dataRoot) });
  assert.equal(late.status, 'INVOCATION_LOST');
  assert.equal(await claimNextRunCommand(app.db, `worker:${randomUUID()}`, 150), undefined);
  const beforeExit = await sql<{ status: string; epoch: bigint }>`
    select status, epoch from run_invocations where run_id = ${runId}
  `.execute(app.db);
  assert.equal(beforeExit.rows[0]?.status, 'ACTIVE');
  assert.equal(held.child.kill('SIGKILL'), true);
  const recovered = await withTimeout(supervised, 10_000, 'supervisor recovery after child close');
  assert.deepEqual(recovered.requeuedRunIds, [runId]);
  assert.deepEqual(recovered.blockedRunIds, []);
  const pending = await sql<{ status: string; epoch: bigint; stop_evidence: string }>`
    select o.status, i.epoch, i.stop_evidence from run_command_outbox o
    join run_commands c on c.id = o.command_id
    join run_invocations i on i.run_id = c.run_id where c.run_id = ${runId}
  `.execute(app.db);
  assert.equal(pending.rows[0]?.status, 'PENDING');
  assert.equal(pending.rows[0]?.epoch, held.epoch);
  assert.match(pending.rows[0]?.stop_evidence ?? '', /mock-worker-child-close/u);
  const restarted = await runSupervisedWorkerOnce({
    db: app.db, databaseUrl, dataRoot: api.dataRoot,
  });
  assert.equal(restarted.exitCode, 0, restarted.output);
  assert.match(restarted.output, /worker_claimed/u);
  const final = await sql<{ status: string; epoch: bigint }>`
    select o.status, i.epoch from run_command_outbox o
    join run_commands c on c.id = o.command_id
    join run_invocations i on i.run_id = c.run_id where c.run_id = ${runId}
  `.execute(app.db);
  assert.equal(final.rows[0]?.status, 'DONE');
  assert.equal(final.rows[0]?.epoch, held.epoch + 1n);
});

test('G04/G05: two independent supervisor entries race for one durable command', async () => {
  const { runId } = await delegatedRun();
  const runSupervisor = async (): Promise<{ code: number | null; output: string }> => {
    const child = spawn(process.execPath, [SUPERVISOR_ENTRY, '--once'], {
      env: { ...process.env, RELAY_DB_URL: databaseUrl, RELAY_DATA_ROOT: api.dataRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const code = await withTimeout(new Promise<number | null>((done, fail) => {
      child.once('error', fail);
      child.once('close', done);
    }), 15_000, 'independent supervisor entry');
    return { code, output };
  };
  const [first, second] = await Promise.all([runSupervisor(), runSupervisor()]);
  assert.equal(first.code, 0, first.output);
  assert.equal(second.code, 0, second.output);
  assert.match(`${first.output}${second.output}`, /supervisor_ready/u);
  const rows = await sql<{ outbox_status: string; epoch: bigint; first_step_attempts: bigint }>`
    select o.status as outbox_status, i.epoch,
      (select count(*) from step_attempts a join run_steps s on s.id = a.step_id
        where s.run_id = r.id and s.step_kind = 'BUILD_CONTEXT') as first_step_attempts
    from runs r join run_invocations i on i.run_id = r.id
    join run_commands c on c.run_id = r.id
    join run_command_outbox o on o.command_id = c.id where r.id = ${runId}
  `.execute(app.db);
  assert.equal(rows.rows[0]?.outbox_status, 'DONE');
  assert.equal(rows.rows[0]?.epoch, 1n);
  assert.equal(rows.rows[0]?.first_step_attempts, 1n);
});

test('G04: supervisor crash does not forge stop evidence or reclaim its former child', async () => {
  const { runId } = await delegatedRun();
  const first = spawn(process.execPath, [SUPERVISOR_ENTRY, '--once'], {
    env: { ...process.env, NODE_ENV: 'test', RELAY_DB_URL: databaseUrl,
      RELAY_DATA_ROOT: api.dataRoot, RELAY_WORKER_LEASE_MS: '150',
      RELAY_WORKER_TEST_HOLD_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  first.stdout.setEncoding('utf8');
  first.stderr.setEncoding('utf8');
  let firstOutput = '';
  let workerPid: number | undefined;
  const started = new Promise<void>((done, fail) => {
    first.once('error', fail);
    first.stdout.on('data', (chunk: string) => {
      firstOutput += chunk;
      for (const line of firstOutput.split('\n')) {
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        const event = JSON.parse(line) as { type: string; pid?: number };
        if (event.type === 'worker_started' && event.pid !== undefined) {
          workerPid = event.pid;
          done();
        }
      }
    });
    first.stderr.on('data', (chunk: string) => { firstOutput += chunk; });
  });
  const firstExit = new Promise<number | null>((done) => first.once('close', done));
  try {
    await withTimeout(started, 5_000, 'supervisor child start');
    await withTimeout((async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await sql<{ status: string }>`
          select status from run_invocations where run_id = ${runId}
        `.execute(app.db);
        if (rows.rows[0]?.status === 'ACTIVE') return;
        await delay(25);
      }
      throw new Error('supervisor child never claimed command');
    })(), 6_000, 'supervisor child claim');
    assert.equal(first.kill('SIGKILL'), true);
    await withTimeout(firstExit, 5_000, 'crashed supervisor close');
    await delay(300);

    const second = spawn(process.execPath, [SUPERVISOR_ENTRY, '--once'], {
      env: { ...process.env, RELAY_DB_URL: databaseUrl, RELAY_DATA_ROOT: api.dataRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secondOutput = '';
    second.stdout.setEncoding('utf8');
    second.stderr.setEncoding('utf8');
    second.stdout.on('data', (chunk: string) => { secondOutput += chunk; });
    second.stderr.on('data', (chunk: string) => { secondOutput += chunk; });
    const secondExit = await withTimeout(new Promise<number | null>((done, fail) => {
      second.once('error', fail);
      second.once('close', done);
    }), 10_000, 'restarted supervisor close');
    assert.equal(secondExit, 0, secondOutput);
    assert.match(secondOutput, /worker_recovery_required/u);
    assert.doesNotMatch(secondOutput, /worker_started/u);
    const rows = await sql<{ outbox_status: string; invocation_status: string;
      epoch: bigint; stop_evidence: string | null }>`
      select o.status as outbox_status, i.status as invocation_status,
        i.epoch, i.stop_evidence
      from run_invocations i join run_commands c on c.run_id = i.run_id
      join run_command_outbox o on o.command_id = c.id
      where i.run_id = ${runId}
    `.execute(app.db);
    assert.deepEqual(rows.rows[0], { outbox_status: 'CLAIMED',
      invocation_status: 'ACTIVE', epoch: 1n, stop_evidence: null });
  } finally {
    first.kill('SIGKILL');
    if (workerPid !== undefined) {
      try { process.kill(workerPid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
});

test('supervisor sidecar echoes readiness nonce and Node version, then exits on stdin EOF', async () => {
  const nonce = randomUUID();
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY], {
    env: { ...process.env, RELAY_DB_URL: databaseUrl, RELAY_DATA_ROOT: api.dataRoot,
      RELAY_SUPERVISOR_READY_NONCE: nonce, RELAY_SUPERVISOR_STOP_ON_STDIN_EOF: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  const ready = new Promise<{ nonce: string; nodeVersion: string }>((done, fail) => {
    child.once('error', fail);
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      for (const line of output.split('\n')) {
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        const event = JSON.parse(line) as { type: string; nonce: string; nodeVersion: string };
        if (event.type === 'supervisor_ready') done(event);
      }
    });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
  });
  try {
    const frame = await withTimeout(ready, 5_000, 'supervisor private readiness');
    assert.equal(frame.nonce, nonce);
    assert.equal(frame.nodeVersion, process.version);
    child.stdin.end();
    const code = await withTimeout(new Promise<number | null>((done, fail) => {
      child.once('error', fail);
      child.once('close', done);
    }), 5_000, 'supervisor EOF shutdown');
    assert.equal(code, 0, output);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a bounded delivery never marks an unfinished Run command DONE', async () => {
  const { runId } = await delegatedRun();
  const result = await runOneCommand(app.db, {
    workerId: `worker:${randomUUID()}`, dataRoot: api.dataRoot,
    checkpointUrl: databaseUrl, maxSteps: 1,
  });
  assert.equal(result?.runId, runId);
  assert.equal(result?.outcome, 'BLOCKED');
  const rows = await sql<{ outbox_status: string; invocation_status: string; run_status: string }>`
    select o.status as outbox_status, i.status as invocation_status, r.status as run_status
    from runs r join run_invocations i on i.run_id = r.id
    join run_commands c on c.run_id = r.id
    join run_command_outbox o on o.command_id = c.id
    where r.id = ${runId}
  `.execute(app.db);
  assert.equal(rows.rows[0]?.outbox_status, 'BLOCKED');
  assert.equal(rows.rows[0]?.invocation_status, 'IDLE');
  assert.notEqual(rows.rows[0]?.run_status, 'COMPLETED');
});

test('Delegate rollback removes Run, command, outbox, invocation and receipt together', async () => {
  const task = await readyTask();
  const commandId = randomUUID();
  await assert.rejects(delegateTask(app.db, {
    workspaceId, taskId: task.taskId, commandId,
    expectedTaskRevision: task.revision,
    hooks: { afterDispatchInsert: async () => { throw new Error('after-dispatch-fault'); } },
  }), /after-dispatch-fault/u);
  const rows = await sql<{ runs: bigint; commands: bigint; outbox: bigint;
    invocations: bigint; receipts: bigint; task_status: string }>`
    select
      (select count(*) from runs where task_id = ${task.taskId}) as runs,
      (select count(*) from run_commands where source_command_id = ${commandId}) as commands,
      (select count(*) from run_command_outbox o join run_commands c on c.id = o.command_id
        where c.source_command_id = ${commandId}) as outbox,
      (select count(*) from run_invocations i join runs r on r.id = i.run_id
        where r.task_id = ${task.taskId}) as invocations,
      (select count(*) from command_receipts where command_id = ${commandId}) as receipts,
      (select status from tasks where id = ${task.taskId}) as task_status
  `.execute(app.db);
  assert.deepEqual(rows.rows[0], { runs: 0n, commands: 0n, outbox: 0n,
    invocations: 0n, receipts: 0n, task_status: 'READY' });
});

test('desktop malformed or oversized private frames fail before any PostgreSQL connection or Worker spawn', async () => {
  let connections = 0;
  const probe = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  try {
    const address = probe.address();
    assert.ok(address !== null && typeof address !== 'string');
    const unavailableDatabaseUrl = `postgresql://relay_app@127.0.0.1:${address.port}/invalid`;
    const old = randomUUID();
    const valid = desktopFrame();
    const badFrames = [
      'not-json\n',
      `${JSON.stringify({ ...desktopFrame(), extra: true })}\n`,
      `{"nonce":"${valid.nonce}","nonce":"${valid.nonce}","launchId":"${valid.launchId}","stoppedLaunches":[]}\n`,
      `${JSON.stringify(desktopFrame(randomUUID(), [{ launchId: old, stopEvidence: 'lease_expired' }]))}\n`,
      `${JSON.stringify(desktopFrame(randomUUID(), [
        { launchId: old, stopEvidence: 'armed_job_absent_after_last_handle_closed' },
        { launchId: old, stopEvidence: 'armed_job_absent_after_last_handle_closed' },
      ]))}\n`,
      `${JSON.stringify(desktopFrame(randomUUID(), Array.from({ length: 4097 }, () => ({
        launchId: randomUUID(), stopEvidence: 'armed_job_absent_after_last_handle_closed',
      }))))}\n`,
      `${'x'.repeat(1_048_577)}\n`,
    ];
    for (const rawFrame of badFrames) {
      const supervisor = startDesktopSupervisor({ rawFrame, once: true,
        databaseUrl: unavailableDatabaseUrl });
      try {
        supervisor.child.stdin.end();
        assert.equal(await withTimeout(supervisor.closed, 5_000, 'malformed desktop frame'), 2,
          supervisor.readOutput());
        assert.deepEqual(supervisor.events, []);
        assert.match(supervisor.readOutput(), /supervisor_configuration_failed/u);
      } finally {
        supervisor.child.kill('SIGKILL');
      }
    }
    assert.equal(connections, 0);
  } finally {
    await new Promise<void>((done) => probe.close(() => done()));
  }
});

test('desktop startup emits private readiness before any claim and tags its Worker with launch ID', async () => {
  const { runId } = await delegatedRun();
  const frame = desktopFrame();
  const supervisor = startDesktopSupervisor({ frame, once: true });
  try {
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'desktop first delivery'), 0,
      supervisor.readOutput());
    const types = supervisor.events.map((event) => event.type);
    assert.ok(types.indexOf('supervisor_ready') >= 0, supervisor.readOutput());
    assert.ok(types.indexOf('dispatch_ready') > types.indexOf('supervisor_ready'));
    assert.ok(types.indexOf('worker_started') > types.indexOf('dispatch_ready'));
    assert.ok(types.indexOf('worker_exit') > types.indexOf('worker_started'));
    const ready = supervisor.events.find((event) => event.type === 'supervisor_ready');
    const dispatch = supervisor.events.find((event) => event.type === 'dispatch_ready');
    const started = supervisor.events.find((event) => event.type === 'worker_started');
    assert.deepEqual({ nonce: ready?.nonce, launchId: ready?.launchId,
      nodeVersion: ready?.nodeVersion }, { nonce: frame.nonce,
      launchId: frame.launchId, nodeVersion: process.version });
    assert.deepEqual({ nonce: dispatch?.nonce, launchId: dispatch?.launchId,
      requeuedRunIds: dispatch?.requeuedRunIds, blockedRunIds: dispatch?.blockedRunIds,
      requeuedRunCount: dispatch?.requeuedRunCount,
      blockedRunCount: dispatch?.blockedRunCount,
      runIdsTruncated: dispatch?.runIdsTruncated },
    { nonce: frame.nonce, launchId: frame.launchId,
      requeuedRunIds: [], blockedRunIds: [], requeuedRunCount: 0,
      blockedRunCount: 0, runIdsTruncated: false });
    assert.match(String(started?.worker_id),
      new RegExp(`^worker:desktop:${frame.launchId}:[0-9a-f-]+$`, 'u'));
    const outbox = await sql<{ status: string }>`
      select o.status from run_command_outbox o join run_commands c on c.id = o.command_id
      where c.run_id = ${runId}
    `.execute(app.db);
    assert.equal(outbox.rows[0]?.status, 'DONE');
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('desktop supervisor starts an Assist child without a Run command and settles the message', async () => {
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Desktop Assist dispatch' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '请回复桌面消息', intent: 'DISCUSS' });
  const messageId = requested.result.assistant_message_id;
  const frame = desktopFrame();
  const supervisor = startDesktopSupervisor({ frame, once: true });
  try {
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'desktop Assist delivery'), 0,
      supervisor.readOutput());
    const started = supervisor.events.filter((event) => event.type === 'worker_started');
    assert.equal(started.length, 1, supervisor.readOutput());
    assert.match(String(started[0]?.worker_id),
      new RegExp(`^worker:desktop:${frame.launchId}:[0-9a-f-]+$`, 'u'));
    const row = (await sql<{ status: string; content: string | null }>`
      select status, content from assist_messages where id = ${messageId}
    `.execute(app.db)).rows[0];
    assert.equal(row?.status, 'COMPLETED', supervisor.readOutput());
    assert.match(row?.content ?? '', /Fake Assist/u);
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('desktop supervisor delivers one Run and one Assist from concurrent backlogs', async () => {
  const { runId } = await delegatedRun();
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Concurrent desktop queues' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '并存队列', intent: 'DISCUSS' });
  const supervisor = startDesktopSupervisor({ frame: desktopFrame(), once: true });
  try {
    assert.equal(await withTimeout(supervisor.closed, 20_000, 'desktop Run and Assist delivery'), 0,
      supervisor.readOutput());
    assert.equal(supervisor.events.filter((event) => event.type === 'worker_started').length, 2,
      supervisor.readOutput());
    const run = (await sql<{ status: string }>`select status from run_command_outbox o
      join run_commands c on c.id = o.command_id where c.run_id = ${runId}`
      .execute(app.db)).rows[0];
    const message = (await sql<{ status: string }>`select status from assist_messages
      where id = ${requested.result.assistant_message_id}`.execute(app.db)).rows[0];
    assert.equal(run?.status, 'DONE');
    assert.equal(message?.status, 'COMPLETED');
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('desktop supervised Assist model failure settles FAILED without another delivery', async () => {
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Desktop Assist failure' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: 'FAKE_ASSIST_THROW', intent: 'DISCUSS' });
  const messageId = requested.result.assistant_message_id;
  const supervisor = startDesktopSupervisor({ frame: desktopFrame(), once: true });
  try {
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'desktop Assist failure'), 0,
      supervisor.readOutput());
    assert.equal(supervisor.events.filter((event) => event.type === 'worker_started').length, 1);
    const row = (await sql<{ status: string; error_code: string | null }>`
      select status, error_code from assist_messages where id = ${messageId}
    `.execute(app.db)).rows[0];
    assert.deepEqual(row, { status: 'FAILED', error_code: 'MODEL_FAILED' });
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('desktop supervised Assist child observes a persisted running cancellation', async () => {
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Desktop Assist cancel' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: 'FAKE_ASSIST_ABORT 请等待取消', intent: 'DISCUSS' });
  const messageId = requested.result.assistant_message_id;
  const supervisor = startDesktopSupervisor({ frame: desktopFrame(), once: true });
  try {
    await withTimeout((async () => {
      while (true) {
        const row = (await sql<{ status: string }>`select status from assist_messages
          where id = ${messageId}`.execute(app.db)).rows[0];
        if (row?.status === 'RUNNING') return;
        await delay(20);
      }
    })(), 10_000, 'desktop Assist claim');
    await cancelAssistMessage(app.db, { workspaceId, messageId, commandId: randomUUID() });
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'desktop Assist cancellation'), 0,
      supervisor.readOutput());
    const row = (await sql<{ status: string; cancel_requested: boolean }>`
      select status, cancel_requested from assist_messages where id = ${messageId}
    `.execute(app.db)).rows[0];
    assert.deepEqual(row, { status: 'CANCELLED', cancel_requested: true });
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('desktop EOF during Assist generation leaves no false user cancellation and expires its claim', async () => {
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Desktop Assist shutdown' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: 'FAKE_ASSIST_ABORT 请等待停机', intent: 'DISCUSS' });
  const messageId = requested.result.assistant_message_id;
  const env = { NODE_ENV: 'test', RELAY_WORKER_LEASE_MS: '150' };
  const first = startDesktopSupervisor({ frame: desktopFrame(), once: true, env });
  try {
    await withTimeout((async () => {
      while (true) {
        const row = (await sql<{ status: string }>`select status from assist_messages
          where id = ${messageId}`.execute(app.db)).rows[0];
        if (row?.status === 'RUNNING') return;
        await delay(20);
      }
    })(), 10_000, 'desktop Assist claim before EOF');
    first.child.stdin.end();
    assert.equal(await withTimeout(first.closed, 10_000, 'desktop Assist EOF'), 0,
      first.readOutput());
    const running = (await sql<{ status: string; cancel_requested: boolean }>`
      select status, cancel_requested from assist_messages where id = ${messageId}
    `.execute(app.db)).rows[0];
    assert.deepEqual(running, { status: 'RUNNING', cancel_requested: false });
    await sql`update assist_messages set updated_at = now() - interval '1 second'
      where id = ${messageId}`.execute(app.db);
    const recovery = startDesktopSupervisor({ frame: desktopFrame(), once: true, env });
    try {
      assert.equal(await withTimeout(recovery.closed, 15_000, 'desktop Assist lease sweep'), 0,
        recovery.readOutput());
      const failed = (await sql<{ status: string; error_code: string | null }>`
        select status, error_code from assist_messages where id = ${messageId}
      `.execute(app.db)).rows[0];
      assert.deepEqual(failed, { status: 'FAILED', error_code: 'LEASE_LOST' });
      const calls = (await sql<{ count: bigint }>`select count(*) as count from model_calls
        where assist_message_id = ${messageId}`.execute(app.db)).rows[0];
      assert.equal(calls?.count, 1n);
    } finally {
      recovery.child.kill('SIGKILL');
    }
  } finally {
    first.child.kill('SIGKILL');
  }
});

test('desktop acknowledges empty old launches in input order before dispatch readiness', async () => {
  const oldLaunches = [randomUUID(), randomUUID()];
  const frame = desktopFrame(randomUUID(), oldLaunches.map((launchId) => ({
    launchId, stopEvidence: 'armed_job_absent_after_last_handle_closed',
  })));
  const supervisor = startDesktopSupervisor({ frame, once: true });
  try {
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'empty old launch acknowledgements'), 0,
      supervisor.readOutput());
    assert.deepEqual(supervisor.events.slice(0, 4).map((event) => event.type),
      ['supervisor_ready', 'launch_recovery_ack', 'launch_recovery_ack', 'dispatch_ready']);
    const acknowledgements = supervisor.events.filter((event) => event.type === 'launch_recovery_ack');
    assert.deepEqual(acknowledgements.map((event) => ({ nonce: event.nonce,
      launchId: event.launchId, retainedClaims: event.retainedClaims })),
    oldLaunches.map((launchId) => ({ nonce: frame.nonce, launchId, retainedClaims: 0 })));
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('two desktop supervisors use one stopped launch claim once; old Worker cannot write after requeue', async () => {
  const { runId } = await delegatedRun();
  const oldLaunch = randomUUID();
  const oldWorker = `worker:desktop:${oldLaunch}:${randomUUID()}`;
  const oldClaim = await claimNextRunCommand(app.db, oldWorker, 150);
  assert.equal(oldClaim?.runId, runId);
  const proof = [{ launchId: oldLaunch,
    stopEvidence: 'armed_job_absent_after_last_handle_closed' }];
  const first = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), proof), once: true });
  const second = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), proof), once: true });
  try {
    const codes = await withTimeout(Promise.all([first.closed, second.closed]), 20_000,
      'competing desktop supervisors');
    assert.deepEqual(codes, [0, 0], `${first.readOutput()}\n${second.readOutput()}`);
    const dispatches = [first, second].map((process) =>
      process.events.find((event) => event.type === 'dispatch_ready'));
    for (const supervisor of [first, second]) {
      const types = supervisor.events.map((event) => event.type);
      assert.ok(types.indexOf('launch_recovery_ack') > types.indexOf('supervisor_ready'));
      assert.ok(types.indexOf('dispatch_ready') > types.indexOf('launch_recovery_ack'));
      const ack = supervisor.events.find((event) => event.type === 'launch_recovery_ack');
      assert.deepEqual({ launchId: ack?.launchId, retainedClaims: ack?.retainedClaims },
        { launchId: oldLaunch, retainedClaims: 0 });
    }
    assert.equal(dispatches.reduce((count, event) => count +
      (Array.isArray(event?.requeuedRunIds) ? event.requeuedRunIds.length : 0), 0), 1);
    const rows = await sql<{ outbox_status: string; epoch: bigint; first_step_attempts: bigint }>`
      select o.status as outbox_status, i.epoch,
        (select count(*) from step_attempts a join run_steps s on s.id = a.step_id
          where s.run_id = i.run_id and s.step_kind = 'BUILD_CONTEXT') as first_step_attempts
      from run_invocations i join run_commands c on c.run_id = i.run_id
      join run_command_outbox o on o.command_id = c.id where i.run_id = ${runId}
    `.execute(app.db);
    assert.deepEqual(rows.rows[0], { outbox_status: 'DONE', epoch: 2n,
      first_step_attempts: 1n });
    const late = await advanceRunStep(app.db, { runId, workerId: oldWorker,
      invocationEpoch: oldClaim!.epoch, storage: new ManagedContentStore(api.dataRoot) });
    assert.equal(late.status, 'INVOCATION_LOST');
  } finally {
    first.child.kill('SIGKILL');
    second.child.kill('SIGKILL');
  }
});

test('a delayed old desktop Worker process cannot write after a new launch takes its command', async () => {
  const { runId } = await delegatedRun();
  const oldLaunch = randomUUID();
  const oldWorkerId = `worker:desktop:${oldLaunch}:${randomUUID()}`;
  const oldWorker = spawn(process.execPath, [WORKER_ENTRY, '--once'], {
    env: { ...process.env, RELAY_DB_URL: databaseUrl, RELAY_DATA_ROOT: api.dataRoot,
      RELAY_WORKER_ID: oldWorkerId, NODE_ENV: 'test',
      RELAY_WORKER_LEASE_MS: '10000', RELAY_WORKER_TEST_HOLD_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  oldWorker.stdout.setEncoding('utf8');
  oldWorker.stderr.setEncoding('utf8');
  let oldOutput = '';
  let pending = '';
  let claimed!: () => void;
  const oldClaimed = new Promise<void>((done) => { claimed = done; });
  oldWorker.stdout.on('data', (chunk: string) => {
    oldOutput += chunk;
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const event = JSON.parse(pending.slice(0, newline)) as { type: string; run_id?: string };
      if (event.type === 'worker_claimed' && event.run_id === runId) claimed();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  });
  oldWorker.stderr.on('data', (chunk: string) => { oldOutput += chunk; });
  const oldClosed = new Promise<number | null>((done, fail) => {
    oldWorker.once('error', fail);
    oldWorker.once('close', done);
  });
  let supervisor: DesktopSupervisorProcess | undefined;
  try {
    await withTimeout(oldClaimed, 5_000, 'old desktop Worker claim');
    const old = await sql<{ epoch: bigint }>`
      select epoch from run_invocations where run_id = ${runId}
    `.execute(app.db);
    // Fault injection only: a real host must never attest that a still-live
    // Job is stopped. This isolates the old process's database epoch fence.
    supervisor = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), [{
      launchId: oldLaunch, stopEvidence: 'armed_job_absent_after_last_handle_closed',
    }]), once: true });
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'replacement desktop delivery'), 0,
      supervisor.readOutput());
    assert.equal(await withTimeout(oldClosed, 8_000, 'late old Worker close'), 0, oldOutput);
    assert.match(oldOutput, /"outcome":"LOST"/u);
    const rows = await sql<{ epoch: bigint; first_step_attempts: bigint }>`
      select i.epoch,
        (select count(*) from step_attempts a join run_steps s on s.id = a.step_id
          where s.run_id = i.run_id and s.step_kind = 'BUILD_CONTEXT') as first_step_attempts
      from run_invocations i where i.run_id = ${runId}
    `.execute(app.db);
    assert.deepEqual(rows.rows[0], { epoch: old.rows[0]!.epoch + 1n, first_step_attempts: 1n });
  } finally {
    supervisor?.child.kill('SIGKILL');
    oldWorker.kill('SIGKILL');
  }
});

test('desktop stopped-launch recovery reconciles the same operation and blocks UNKNOWN', async () => {
  for (const target of ['PRESENT', 'TAMPERED'] as const) {
    const oldLaunch = randomUUID();
    const oldWorker = `worker:desktop:${oldLaunch}:${randomUUID()}`;
    const previous = await claimedPersistStep(oldWorker);
    const storage = new ManagedContentStore(api.dataRoot);
    let operationId = '';
    await assert.rejects(advanceRunStep(app.db, {
      runId: previous.runId, workerId: oldWorker, invocationEpoch: previous.epoch,
      storage, hooks: { afterEffectDispatch: async () => {
        const effect = await sql<{ operation_id: string; target_ref: string }>`
          select operation_id, target_ref from run_effect_actions where run_id = ${previous.runId}
        `.execute(app.db);
        const draft = await sql<{ result_ref: { content?: unknown } }>`
          select result_ref from run_steps where run_id = ${previous.runId} and step_kind = 'DRAFT'
        `.execute(app.db);
        const content = draft.rows[0]?.result_ref.content;
        assert.equal(typeof content, 'string');
        operationId = effect.rows[0]!.operation_id;
        await storage.publish({ artifactId: previous.runId, versionId: operationId,
          content: Buffer.from(content as string, 'utf8') });
        if (target === 'TAMPERED') {
          await writeFile(resolveStoredContentPath(api.dataRoot, effect.rows[0]!.target_ref), 'tampered');
        }
        throw new SimulatedWorkerCrash('old launch stopped after external publish');
      } },
    }), SimulatedWorkerCrash);
    if (target === 'TAMPERED') {
      // A prior per-step fence can leave no RUN_WORKER_FENCED activity for this
      // recovery call. The invocation claim must still count as retained.
      await sql`
        update runs set worker_id = null, worker_epoch = worker_epoch + 1,
          worker_lease_until = null where id = ${previous.runId}
      `.execute(app.db);
    }
    const frame = desktopFrame(randomUUID(), [{ launchId: oldLaunch,
      stopEvidence: 'armed_job_terminated_and_active_count_zero' }]);
    const supervisor = startDesktopSupervisor({ frame, once: true });
    try {
      assert.equal(await withTimeout(supervisor.closed, 15_000, 'effect recovery desktop supervisor'), 0,
        supervisor.readOutput());
      const dispatch = supervisor.events.find((event) => event.type === 'dispatch_ready');
      assert.deepEqual(dispatch?.requeuedRunIds, target === 'PRESENT' ? [previous.runId] : []);
      assert.deepEqual(dispatch?.blockedRunIds, target === 'TAMPERED' ? [previous.runId] : []);
      assert.equal(dispatch?.requeuedRunCount, target === 'PRESENT' ? 1 : 0);
      assert.equal(dispatch?.blockedRunCount, target === 'TAMPERED' ? 1 : 0);
      assert.equal(dispatch?.runIdsTruncated, false);
      const ack = supervisor.events.find((event) => event.type === 'launch_recovery_ack');
      assert.ok(supervisor.events.indexOf(ack!) < supervisor.events.indexOf(dispatch!));
      assert.deepEqual({ nonce: ack?.nonce, launchId: ack?.launchId,
        retainedClaims: ack?.retainedClaims },
      { nonce: frame.nonce, launchId: oldLaunch,
        retainedClaims: target === 'TAMPERED' ? 1 : 0 });
      const effects = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
        select operation_id, status, dispatch_count from run_effect_actions
        where run_id = ${previous.runId}
      `.execute(app.db);
      assert.deepEqual(effects.rows[0], { operation_id: operationId,
        status: target === 'PRESENT' ? 'SUCCEEDED' : 'UNKNOWN', dispatch_count: 1 });
      if (target === 'TAMPERED') {
        assert.equal(supervisor.events.some((event) => event.type === 'worker_started'), false);
        const fenced = await sql<{ count: bigint }>`
          select count(*)::bigint as count from activity_records
          where event_type = 'RUN_WORKER_FENCED' and fact_refs->>'run_id' = ${previous.runId}
        `.execute(app.db);
        assert.equal(fenced.rows[0]?.count, 0n);
      }
    } finally {
      supervisor.child.kill('SIGKILL');
    }
  }
});

test('a slow multi-claim launch has no early ack; a killed supervisor retries the same claims', async () => {
  const oldLaunch = randomUUID();
  const runIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const { runId } = await delegatedRun();
    const workerId = `worker:desktop:${oldLaunch}:${randomUUID()}`;
    const claim = await claimNextRunCommand(app.db, workerId, 30_000);
    assert.equal(claim?.runId, runId);
    runIds.push(runId);
  }
  const [firstRunId, heldRunId] = runIds.sort();
  assert.ok(firstRunId && heldRunId);
  let release!: () => void;
  let locked!: () => void;
  const released = new Promise<void>((done) => { release = done; });
  const acquired = new Promise<void>((done) => { locked = done; });
  const heldTransaction = withTransaction(app.db, async (repositories) => {
    await repositories.runs.lockRun(heldRunId);
    locked();
    await released;
  });
  await withTimeout(acquired, 5_000, 'held old launch Run lock');
  const proof = [{ launchId: oldLaunch,
    stopEvidence: 'armed_job_absent_after_last_handle_closed' }];
  const first = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), proof), once: true });
  try {
    await withTimeout((async () => {
      while (true) {
        const rows = await sql<{ status: string }>`
          select status from run_invocations where run_id = ${firstRunId}
        `.execute(app.db);
        if (rows.rows[0]?.status === 'IDLE') return;
        await delay(20);
      }
    })(), 8_000, 'first claim recovered before held claim');
    const heldAt = Date.now();
    await delay(1_200);
    const heldMs = Date.now() - heldAt;
    assert.ok(heldMs >= 1_000);
    assert.equal(first.events.some((event) => event.type === 'launch_recovery_ack'), false);
    assert.equal(first.events.some((event) => event.type === 'dispatch_ready'), false);
    assert.equal(first.events.some((event) => event.type === 'worker_started'), false);
    process.stdout.write(`controlled old-launch backlog held ${heldMs} ms without ack\n`);
  } finally {
    first.child.kill('SIGKILL');
    await withTimeout(first.closed, 5_000, 'killed old launch supervisor');
    release();
    await heldTransaction;
  }
  const retried = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), proof), once: true });
  try {
    assert.equal(await withTimeout(retried.closed, 20_000, 'retried old launch supervisor'), 0,
      retried.readOutput());
    const types = retried.events.map((event) => event.type);
    assert.ok(types.indexOf('launch_recovery_ack') > types.indexOf('supervisor_ready'));
    assert.ok(types.indexOf('dispatch_ready') > types.indexOf('launch_recovery_ack'));
    const ack = retried.events.find((event) => event.type === 'launch_recovery_ack');
    assert.deepEqual({ launchId: ack?.launchId, retainedClaims: ack?.retainedClaims },
      { launchId: oldLaunch, retainedClaims: 0 });
    const remaining = await sql<{ count: bigint }>`
      select count(*)::bigint as count from run_invocations
      where worker_id like ${`worker:desktop:${oldLaunch}:%`}
        and status in ('ACTIVE', 'STOP_REQUIRED')
    `.execute(app.db);
    assert.equal(remaining.rows[0]?.count, 0n);
  } finally {
    retried.child.kill('SIGKILL');
  }
  await runOneCommand(app.db, { workerId: `worker:${randomUUID()}`,
    dataRoot: api.dataRoot, checkpointUrl: databaseUrl });
  const settled = await sql<{ count: bigint }>`
    select count(*)::bigint as count from run_command_outbox o
    join run_commands c on c.id = o.command_id
    where c.run_id in (${firstRunId}, ${heldRunId}) and o.status = 'DONE'
  `.execute(app.db);
  assert.equal(settled.rows[0]?.count, 2n);
});

test('EOF during recovery emits no unfinished launch ack or final dispatch readiness', async () => {
  const { runId } = await delegatedRun();
  const oldLaunch = randomUUID();
  const workerId = `worker:desktop:${oldLaunch}:${randomUUID()}`;
  const claim = await claimNextRunCommand(app.db, workerId, 30_000);
  assert.equal(claim?.runId, runId);
  let release!: () => void;
  let locked!: () => void;
  const released = new Promise<void>((done) => { release = done; });
  const acquired = new Promise<void>((done) => { locked = done; });
  const heldTransaction = withTransaction(app.db, async (repositories) => {
    await repositories.runs.lockRun(runId);
    locked();
    await released;
  });
  await withTimeout(acquired, 5_000, 'held EOF recovery Run lock');
  const supervisor = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), [{
    launchId: oldLaunch, stopEvidence: 'armed_job_absent_after_last_handle_closed',
  }]), once: true });
  try {
    await waitForDesktopEvent(supervisor, 'supervisor_ready');
    await withTimeout((async () => {
      while (true) {
        const waiting = await sql<{ count: bigint }>`
          select count(*)::bigint as count from pg_stat_activity
          where datname = current_database() and usename = current_user
            and wait_event_type = 'Lock' and pid <> pg_backend_pid()
        `.execute(app.db);
        if ((waiting.rows[0]?.count ?? 0n) > 0n) return;
        await delay(20);
      }
    })(), 5_000, 'supervisor waiting inside recovery');
    supervisor.child.stdin.end();
    await delay(100);
  } finally {
    release();
    await heldTransaction;
  }
  try {
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'EOF during old launch recovery'), 0,
      supervisor.readOutput());
    assert.equal(supervisor.events.some((event) => event.type === 'launch_recovery_ack'), false);
    assert.equal(supervisor.events.some((event) => event.type === 'dispatch_ready'), false);
    assert.equal(supervisor.events.some((event) => event.type === 'worker_started'), false);
  } finally {
    supervisor.child.kill('SIGKILL');
  }
  const outbox = await sql<{ status: string }>`
    select o.status from run_command_outbox o join run_commands c on c.id = o.command_id
    where c.run_id = ${runId}
  `.execute(app.db);
  assert.equal(outbox.rows[0]?.status, 'PENDING');
  await runOneCommand(app.db, { workerId: `worker:${randomUUID()}`,
    dataRoot: api.dataRoot, checkpointUrl: databaseUrl });
});

test('a recovery exception emits only prior launch progress and no final readiness', async () => {
  const { runId } = await delegatedRun();
  const emptyLaunch = randomUUID();
  const oldLaunch = randomUUID();
  const workerId = `worker:desktop:${oldLaunch}:${randomUUID()}`;
  const claim = await claimNextRunCommand(app.db, workerId, 60_000);
  assert.equal(claim?.runId, runId);
  // Inject a conflicting per-step owner so recoverStoppedWorker throws during
  // reconciliation. This is intentionally inconsistent persisted test input.
  await sql`
    update runs set worker_id = ${`worker:${randomUUID()}`},
      worker_epoch = worker_epoch + 1,
      worker_lease_until = clock_timestamp() + interval '1 minute'
    where id = ${runId}
  `.execute(app.db);
  const supervisor = startDesktopSupervisor({ frame: desktopFrame(randomUUID(), [
    { launchId: emptyLaunch, stopEvidence: 'armed_job_absent_after_last_handle_closed' },
    { launchId: oldLaunch, stopEvidence: 'armed_job_absent_after_last_handle_closed' },
  ]), once: true });
  try {
    assert.equal(await withTimeout(supervisor.closed, 15_000, 'failed old launch reconciliation'), 1,
      supervisor.readOutput());
    assert.ok(supervisor.events.some((event) => event.type === 'supervisor_ready'));
    const acknowledgements = supervisor.events.filter((event) => event.type === 'launch_recovery_ack');
    assert.deepEqual(acknowledgements.map((event) => ({ launchId: event.launchId,
      retainedClaims: event.retainedClaims })), [{ launchId: emptyLaunch, retainedClaims: 0 }]);
    assert.equal(supervisor.events.some((event) => event.type === 'dispatch_ready'), false);
    assert.equal(supervisor.events.some((event) => event.type === 'worker_started'), false);
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});

test('desktop stdin EOF stops new claims and waits for the active child close', async () => {
  const { runId } = await delegatedRun();
  const supervisor = startDesktopSupervisor({ frame: desktopFrame(),
    env: { NODE_ENV: 'test', RELAY_WORKER_LEASE_MS: '150',
      RELAY_WORKER_TEST_HOLD_MS: '5000' } });
  try {
    await waitForDesktopEvent(supervisor, 'worker_started');
    await withTimeout((async () => {
      while (true) {
        const rows = await sql<{ status: string }>`
          select status from run_invocations where run_id = ${runId}
        `.execute(app.db);
        if (rows.rows[0]?.status === 'ACTIVE') return;
        await delay(25);
      }
    })(), 5_000, 'desktop child claim');
    supervisor.child.stdin.end();
    assert.equal(await withTimeout(supervisor.closed, 10_000, 'desktop EOF close'), 0,
      supervisor.readOutput());
    assert.equal(supervisor.events.filter((event) => event.type === 'worker_started').length, 1);
    const exited = supervisor.events.find((event) => event.type === 'worker_exit');
    assert.deepEqual(exited?.requeued_run_ids, [runId]);
    const rows = await sql<{ outbox_status: string; invocation_status: string }>`
      select o.status as outbox_status, i.status as invocation_status
      from run_invocations i join run_commands c on c.run_id = i.run_id
      join run_command_outbox o on o.command_id = c.id where i.run_id = ${runId}
    `.execute(app.db);
    assert.deepEqual(rows.rows[0], { outbox_status: 'PENDING', invocation_status: 'IDLE' });
  } finally {
    supervisor.child.kill('SIGKILL');
  }
});
