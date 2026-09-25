import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const experimentRoot = resolve(sourceDirectory, '..', '..');
const repositoryRoot = resolve(experimentRoot, '..', '..');
const localRoot = resolve(experimentRoot, '.local');
const resultsRoot = resolve(experimentRoot, 'results');
const portableNode = resolve(repositoryRoot, '.research', 'runtime-cache', 'node-v24.21.0-win-x64', 'node.exe');
const postgresBin = resolve(repositoryRoot, '.research', 'runtime-cache', 'postgresql-18.6-2', 'pgsql', 'bin');
const initdb = join(postgresBin, 'initdb.exe');
const pgCtl = join(postgresBin, 'pg_ctl.exe');
const worker = resolve(experimentRoot, 'dist', 'src', 'worker.js');
const controlWorker = resolve(experimentRoot, 'dist', 'src', 'control-worker.js');
const inputPaths = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'src/worker.ts', 'src/control-worker.ts', 'src/run-recovery.ts'] as const;

type ChildEvidence = {
  args: readonly string[];
  duration_ms: number;
  exit_code: number | null;
  name: string;
  pid: number | undefined;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timed_out: boolean;
};

type Scenario = {
  assertions: readonly string[];
  artifact_matches_expected_now: boolean;
  business_completion_count: number;
  external_effect_writes_observed: number;
  harness: 'control-worker' | 'main-worker';
  protocol_commit_count: number;
  evidence_records: number;
  model_calls: number;
  name: string;
  operation_id: string;
  tool_calls: number;
};

type Report = {
  assertions: readonly string[];
  environment: { node: string; postgres: string };
  failure?: { message: string; scenarios_completed: number };
  finished_at: string;
  input_sha256: Record<(typeof inputPaths)[number], string>;
  limitations: readonly string[];
  process_evidence: readonly ChildEvidence[];
  run_id: string;
  scenarios: readonly Scenario[];
  started_at: string;
  status: 'FAILED' | 'PASSED' | 'RUNNING';
};

function assertOwnedPath(path: string, allowedRoot: string): void {
  const root = resolve(allowedRoot);
  const candidate = resolve(path);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(':')) {
    throw new Error(`refusing to delete or mutate non-owned path: ${candidate}`);
  }
}

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('cannot obtain dynamic loopback port'));
        return;
      }
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
    });
  });
}

function sanitize(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted-postgres-url]')
    .trim()
    .slice(0, 8_000);
}

type RunningChild = {
  child: ChildProcess;
  evidence: Promise<ChildEvidence>;
};

/**
 * Spawns a child and exposes both the parent-held process handle and the
 * eventual evidence record. The handle is what the liveness assertions use:
 * `exitCode === null` means this exact child has not exited, which is stronger
 * than probing a reusable PID.
 */
function spawnChild(name: string, executable: string, args: readonly string[], environment: NodeJS.ProcessEnv, captureOutput = true): RunningChild {
  const started = Date.now();
  const child = spawn(executable, [...args], { env: environment, windowsHide: true, stdio: captureOutput ? 'pipe' : 'ignore' });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 30_000);
  let stdout = '';
  let stderr = '';
  if (captureOutput) {
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  }
  const evidence = new Promise<ChildEvidence>((resolveChild, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveChild({
        name,
        args,
        pid: child.pid,
        exit_code: code,
        signal,
        duration_ms: Date.now() - started,
        stdout: sanitize(stdout),
        stderr: sanitize(stderr),
        timed_out: timedOut,
      });
    });
  });
  return { child, evidence };
}

async function runProcess(name: string, executable: string, args: readonly string[], environment: NodeJS.ProcessEnv, captureOutput = true): Promise<ChildEvidence> {
  return spawnChild(name, executable, args, environment, captureOutput).evidence;
}

/** True while this exact child process is still running, judged from the parent handle. */
function childIsRunning(handle: RunningChild): boolean {
  return handle.child.exitCode === null && handle.child.signalCode === null && handle.child.killed === false;
}

function checkExit(evidence: ChildEvidence, expected: number, context: string): void {
  assert.equal(evidence.exit_code, expected, `${context}: child stderr: ${evidence.stderr}`);
  assert.equal(evidence.timed_out, false, `${context}: child exceeded 30 second bound`);
  assert.equal(evidence.signal, null, `${context}: child terminated by signal`);
}

async function hashInputs(): Promise<Record<(typeof inputPaths)[number], string>> {
  const entries = await Promise.all(inputPaths.map(async (path) => {
    const contents = await readFile(join(experimentRoot, path));
    return [path, createHash('sha256').update(contents).digest('hex')] as const;
  }));
  return Object.fromEntries(entries) as Record<(typeof inputPaths)[number], string>;
}

async function writeReport(path: string, report: Report): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function count(client: Client, operationId: string, eventType?: string): Promise<number> {
  const query = eventType === undefined
    ? 'select count(*)::int as count from audit_events where operation_id = $1'
    : 'select count(*)::int as count from audit_events where operation_id = $1 and event_type = $2';
  const values = eventType === undefined ? [operationId] : [operationId, eventType];
  const result = await client.query<{ count: number }>(query, values);
  return result.rows[0]?.count ?? 0;
}

async function protocolCommitCount(client: Client, operationId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    'select count(*)::int as count from protocol_commits where operation_id = $1',
    [operationId],
  );
  return result.rows[0]?.count ?? 0;
}

type DispatchInvocation = {
  dispatch_worker_pid: number;
  effect_id: string;
  id: string;
};

async function currentDispatchInvocation(client: Client, operationId: string): Promise<DispatchInvocation> {
  const result = await client.query<DispatchInvocation>(
    "select id, effect_id, dispatch_worker_pid from invocations where operation_id = $1 and status = 'DISPATCHING'",
    [operationId],
  );
  assert.equal(result.rows.length, 1, `operation ${operationId} must have exactly one current DISPATCHING invocation`);
  const invocation = result.rows[0];
  if (invocation === undefined) {
    throw new Error(`missing current DISPATCHING invocation for ${operationId}`);
  }
  return invocation;
}

async function writeExitReceipt(root: string, operationId: string, invocation: DispatchInvocation, exitCode: number): Promise<void> {
  const receiptPath = join(root, 'exit-receipts', `${invocation.id}.json`);
  await mkdir(dirname(receiptPath), { recursive: true });
  const contents = `${JSON.stringify({ operationId, invocationId: invocation.id, effectId: invocation.effect_id, pid: invocation.dispatch_worker_pid, exitCode })}\n`;
  await writeFile(receiptPath, contents, { encoding: 'utf8', flag: 'wx' });
}

async function operationState(client: Client, operationId: string): Promise<{ operation: string; invocation: string | null; pause_reason: string | null; review: string; run_phase: string }> {
  const result = await client.query<{ operation: string; invocation: string |null; pause_reason: string | null; review: string; run_phase: string }>(
    `select o.status as operation, i.status as invocation, pr.phase as run_phase, pr.pause_reason, r.status as review
     from operations o join probe_runs pr on pr.id = o.run_id join reviews r on r.operation_id = o.id
     left join lateral (
       select status from invocations where operation_id = o.id
       order by case status when 'SUCCEEDED' then 0 when 'UNKNOWN' then 1 when 'DISPATCHING' then 2 else 3 end
       limit 1
     ) i on true where o.id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`missing state for ${operationId}`);
  }
  return row;
}

async function effectCount(root: string, operationId: string): Promise<number> {
  const path = join(root, 'effects', `${operationId}.jsonl`);
  if (!existsSync(path)) return 0;
  const contents = await readFile(path, 'utf8');
  return contents.split(/\r?\n/u).filter((line) => line.length > 0).length;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

type ResourceClaimState = {
  operationId: string;
  runId: string;
  status: string;
  taskId: string;
  workerClaimEpoch: string;
};

async function activeResourceClaim(client: Client, resourceId: string): Promise<ResourceClaimState> {
  const result = await client.query<ResourceClaimState>(
    `select operation_id as "operationId", run_id as "runId", status, task_id as "taskId", worker_claim_epoch::text as "workerClaimEpoch"
     from resource_claims where resource_id = $1 and status in ('HELD', 'QUARANTINED')`,
    [resourceId],
  );
  assert.equal(result.rows.length, 1, `resource ${resourceId} must have exactly one active claim`);
  const claim = result.rows[0];
  if (claim === undefined) throw new Error(`missing active claim for ${resourceId}`);
  return claim;
}

async function artifactMatchesExpectedNow(root: string, operationId: string, resourceId = operationId): Promise<boolean> {
  const path = join(root, resourceId, 'managed-artifact.txt');
  if (!existsSync(path)) return false;
  return (await readFile(path, 'utf8')) === 'P00 cross-process recovery fixture\n';
}

async function scenarioCounts(client: Client, root: string, name: string, operationId: string, assertions: readonly string[], externalEffectWritesObserved?: number, resourceId = operationId): Promise<Scenario> {
  const artifactMatches = await artifactMatchesExpectedNow(root, operationId, resourceId);
  return {
    name,
    operation_id: operationId,
    harness: 'main-worker',
    assertions,
    model_calls: await count(client, operationId, 'MODEL_CALL'),
    tool_calls: await count(client, operationId, 'TOOL_CALL'),
    artifact_matches_expected_now: artifactMatches,
    external_effect_writes_observed: externalEffectWritesObserved ?? (artifactMatches ? 1 : 0),
    evidence_records: await effectCount(root, operationId),
    protocol_commit_count: await protocolCommitCount(client, operationId),
    business_completion_count: await businessCompletionCount(client, operationId),
  };
}

/** Business completions are counted from completion records, never from protocol commits. */
async function businessCompletionCount(client: Client, operationId: string): Promise<number> {
  return scalar(client, 'select count(*)::int as count from completion_records where run_id = (select run_id from operations where id = $1)', [operationId]);
}

async function scalar(client: Client, sql: string, values: readonly unknown[]): Promise<number> {
  const result = await client.query<{ count: number }>(sql, [...values]);
  return result.rows[0]?.count ?? 0;
}

function childEvent(evidence: ChildEvidence, eventName: string): Record<string, unknown> | undefined {
  for (const line of evidence.stdout.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as Record<string, unknown>).event === eventName) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

type ProbeTaskState = {
  completion_basis: string | null;
  owner_run_id: string | null;
  ownership_epoch: string;
  state_revision: string;
  task_status: string;
};

async function taskState(client: Client, operationId: string): Promise<ProbeTaskState> {
  const result = await client.query<ProbeTaskState>(
    `select t.task_status, t.owner_run_id, t.state_revision::text, t.ownership_epoch::text, t.completion_basis
     from probe_tasks t join probe_runs r on r.task_id = t.id join operations o on o.run_id = r.id
     where o.id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`missing task state for ${operationId}`);
  return row;
}

type ProbeRunPosition = { lease_expired: boolean; next_step_index: number; phase: string; step_count: number };

async function runPosition(client: Client, operationId: string): Promise<ProbeRunPosition> {
  const result = await client.query<ProbeRunPosition>(
    `select r.phase, r.next_step_index, r.step_count, (r.lease_expires_at is not null and r.lease_expires_at < now()) as lease_expired
     from probe_runs r join operations o on o.run_id = r.id where o.id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`missing run position for ${operationId}`);
  return row;
}

async function stepStates(client: Client, operationId: string): Promise<{ attempt: number; name: string; status: string; step_index: number }[]> {
  const result = await client.query<{ attempt: number; name: string; status: string; step_index: number }>(
    `select s.step_index, s.name, s.status, s.attempt
     from probe_steps s join probe_runs r on r.id = s.run_id join operations o on o.run_id = r.id
     where o.id = $1 order by s.step_index`,
    [operationId],
  );
  return result.rows;
}

async function commandReceiptRow(client: Client, commandId: string): Promise<{ payload_hash: string; result: Record<string, unknown> } | undefined> {
  const result = await client.query<{ payload_hash: string; result: Record<string, unknown> }>(
    'select payload_hash, result from command_receipts where command_id = $1',
    [commandId],
  );
  return result.rows[0];
}

async function controlRequestRow(client: Client, requestId: string): Promise<{ result_ref: string | null; status: string; type: string } | undefined> {
  const result = await client.query<{ result_ref: string | null; status: string; type: string }>(
    'select status, type, result_ref from control_requests where request_id = $1',
    [requestId],
  );
  return result.rows[0];
}

/** Auxiliary PID probe; on Windows a recycled PID can satisfy it, so liveness assertions use the child handle. */
function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}

/** Reads the client OS PID the barrier holder wrote into its ready file. */
async function barrierReadyPid(directory: string, filename: string): Promise<number | undefined> {
  const contents = await readFile(join(directory, filename), 'utf8');
  const pid = Number.parseInt(contents.trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

async function waitForBarrierFile(directory: string, filename: string): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === filename)) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`barrier did not receive ${filename}`);
}

async function releaseBarrier(directory: string): Promise<void> {
  await writeFile(join(directory, 'release'), '', { flag: 'wx' });
}

type LockWaitObservation = {
  blocked: boolean;
  blockerBackendPids: number[];
  holderBackendPids: number[];
};

/**
 * Observes a real lock wait and checks that the blocker is the holder's own
 * backend connection. The waiter must be in wait_event_type = 'Lock' and the
 * backend PID reported by pg_blocking_pids must belong to the connection whose
 * application_name is the holder's, so an unrelated lock cannot satisfy the
 * assertion. `holderBackendPids` are server-side backend PIDs, not client OS
 * PIDs; the client OS PID is checked separately through the parent-held child
 * handle and the barrier ready file.
 */
async function observeLockWaitFromHolder(client: Client, waiterApplicationName: string, holderApplicationName: string): Promise<LockWaitObservation> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const holder = await client.query<{ pid: number }>('select pid from pg_stat_activity where application_name = $1', [holderApplicationName]);
    const holderBackendPids = holder.rows.map((row) => row.pid);
    if (holderBackendPids.length > 0) {
      const result = await client.query<{ blockers: number[] }>(
        `select coalesce(array_agg(distinct blocker), array[]::int[]) as blockers
         from pg_stat_activity a
         cross join lateral unnest(pg_blocking_pids(a.pid)) as blocker
         where a.application_name = $1 and a.wait_event_type = 'Lock'`,
        [waiterApplicationName],
      );
      const blockerBackendPids = result.rows[0]?.blockers ?? [];
      if (holderBackendPids.some((pid) => blockerBackendPids.includes(pid))) {
        return { blocked: true, blockerBackendPids, holderBackendPids };
      }
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return { blocked: false, blockerBackendPids: [], holderBackendPids: [] };
}

function controlScenario(name: string, id: string, assertions: readonly string[]): Scenario {
  return {
    name,
    operation_id: id,
    harness: 'control-worker',
    assertions,
    model_calls: 0,
    tool_calls: 0,
    artifact_matches_expected_now: false,
    external_effect_writes_observed: 0,
    evidence_records: 0,
    protocol_commit_count: 0,
    business_completion_count: 0,
  };
}

async function claimStatuses(client: Client, operationId: string): Promise<string[]> {
  const result = await client.query<{ status: string }>(
    'select status from resource_claims where operation_id = $1 order by id',
    [operationId],
  );
  return result.rows.map((row) => row.status);
}

async function projectState(client: Client): Promise<{ done_task_count: string; revision: string }> {
  const result = await client.query<{ done_task_count: string; revision: string }>(
    "select revision::text as revision, done_task_count::text as done_task_count from probe_project_state where id = 'project-default'",
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('missing probe_project_state row');
  return row;
}

async function verificationCount(client: Client, operationId: string): Promise<number> {
  return scalar(client, 'select count(*)::int as count from verifications where run_id = (select run_id from operations where id = $1)', [operationId]);
}

async function stateDeltaCount(client: Client, operationId: string): Promise<number> {
  return scalar(client, 'select count(*)::int as count from state_deltas where task_id = (select r.task_id from probe_runs r join operations o on o.run_id = r.id where o.id = $1)', [operationId]);
}

async function main(): Promise<void> {
  assert.equal(process.versions.node.split('.')[0], '24', 'portable Node 24 must run this experiment');
  assert.equal(existsSync(portableNode), true, `portable Node missing: ${portableNode}`);
  assert.equal(existsSync(initdb), true, `portable initdb missing: ${initdb}`);
  assert.equal(existsSync(worker), true, `compiled worker missing: ${worker}; run build first`);
  assert.equal(existsSync(controlWorker), true, `compiled control worker missing: ${controlWorker}; run build first`);

  const runId = `recovery-p00-${randomUUID()}`;
  const runRoot = join(localRoot, runId);
  assertOwnedPath(runRoot, localRoot);
  const dataDirectory = join(runRoot, 'pgdata');
  const postgresLog = join(runRoot, 'postgres.log');
  const recoveryRoot = join(runRoot, 'recovery-files');
  const reportPath = join(resultsRoot, `${runId}.json`);
  const latestPath = join(resultsRoot, 'latest.json');
  const inputSha = await hashInputs();
  const processEvidence: ChildEvidence[] = [];
  const scenarios: Scenario[] = [];
  const startedAt = new Date().toISOString();
  const inProgress: Report = {
    run_id: runId,
    status: 'RUNNING',
    started_at: startedAt,
    finished_at: startedAt,
    environment: { node: process.versions.node, postgres: 'starting' },
    input_sha256: inputSha,
    assertions: [],
    process_evidence: [],
    scenarios: [],
    limitations: [],
  };
  await writeReport(latestPath, inProgress);
  await writeReport(reportPath, inProgress);

  let postgresStarted = false;
  let pool: Client | undefined;
  let postgresVersion = 'unavailable';
  let failure: unknown;
  try {
    await mkdir(runRoot, { recursive: true });
    await mkdir(recoveryRoot, { recursive: true });
    const init = await runProcess('initdb', initdb, ['-D', dataDirectory, '-A', 'trust', '-U', 'postgres', '--no-locale'], process.env, false);
    processEvidence.push(init);
    checkExit(init, 0, 'initdb');
    const port = await allocatePort();
    const start = await runProcess('pg_ctl_start', pgCtl, ['start', '-D', dataDirectory, '-l', postgresLog, '-o', `-p ${port} -h 127.0.0.1`, '-w', '-t', '30'], process.env, false);
    processEvidence.push(start);
    checkExit(start, 0, 'pg_ctl start');
    postgresStarted = true;
    const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    const environment = { ...process.env, RECOVERY_DATABASE_URL: databaseUrl, RECOVERY_ROOT: recoveryRoot };
    const workerRun = async (name: string, ...args: string[]): Promise<ChildEvidence> => {
      const evidence = await runProcess(name, portableNode, [worker, ...args], environment);
      processEvidence.push(evidence);
      return evidence;
    };
    const workerRunWith = async (name: string, overrides: Record<string, string>, ...args: string[]): Promise<ChildEvidence> => {
      const evidence = await runProcess(name, portableNode, [worker, ...args], { ...environment, ...overrides });
      processEvidence.push(evidence);
      return evidence;
    };
    const controlRun = async (name: string, overrides: Record<string, string>, ...args: string[]): Promise<ChildEvidence> => {
      const evidence = await runProcess(name, portableNode, [controlWorker, ...args], { ...environment, ...overrides });
      processEvidence.push(evidence);
      return evidence;
    };
    /**
     * Starts a long-lived holder and keeps the parent-held process handle, so
     * liveness assertions can use the handle instead of a reusable PID.
     */
    const workerRunWithHandle = (name: string, overrides: Record<string, string>, ...args: string[]): RunningChild => {
      const handle = spawnChild(name, portableNode, [worker, ...args], { ...environment, ...overrides });
      handle.evidence.then((evidence) => { processEvidence.push(evidence); }, () => undefined);
      return handle;
    };
    const setup = await workerRun('setup', 'setup');
    checkExit(setup, 0, 'schema setup');
    pool = new Client({ connectionString: databaseUrl });
    await pool.connect();
    postgresVersion = (await pool.query<{ server_version: string }>('show server_version')).rows[0]?.server_version ?? 'unknown';
    checkExit(await controlRun('control_setup', { CONTROL_APPLICATION_NAME: 'control_setup' }, 'setup'), 0, 'control schema setup');

    const continueOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('continue_prepare', 'prepare', continueOp), 0, 'continuation prepare');
    const approvalBarrier = join(runRoot, 'continue-approval-barrier');
    await mkdir(approvalBarrier, { recursive: true });
    const approvalHolder = workerRunWith('continue_approve_lock_holder', {
      RECOVERY_APPLICATION_NAME: 'recovery_approval_holder',
      RECOVERY_LOCK_BARRIER_DIR: approvalBarrier,
      RECOVERY_LOCK_BARRIER_PHASE: 'approval',
    }, 'approve', continueOp);
    await waitForBarrierFile(approvalBarrier, `approval-locked-${continueOp}`);
    const approvalWaiter = workerRunWith('continue_approve_lock_waiter', {
      RECOVERY_APPLICATION_NAME: 'recovery_approval_waiter',
    }, 'approve', continueOp);
    const approvalWait = await observeLockWaitFromHolder(pool, 'recovery_approval_waiter', 'recovery_approval_holder');
    assert.equal(approvalWait.blocked, true, 'second approval process must wait on the holder backend of the locked review row');
    await releaseBarrier(approvalBarrier);
    const approvals = await Promise.all([approvalHolder, approvalWaiter]);
    approvals.forEach((entry, index) => checkExit(entry, 0, `continuation approval ${index}`));
    const dispatchBarrier = join(runRoot, 'continue-dispatch-barrier');
    await mkdir(dispatchBarrier, { recursive: true });
    const dispatchHolder = workerRunWith('continue_execute_lock_holder', {
      RECOVERY_APPLICATION_NAME: 'recovery_dispatch_holder',
      RECOVERY_LOCK_BARRIER_DIR: dispatchBarrier,
      RECOVERY_LOCK_BARRIER_PHASE: 'dispatch',
    }, 'execute', continueOp);
    await waitForBarrierFile(dispatchBarrier, `dispatch-locked-${continueOp}`);
    const dispatchWaiter = workerRunWith('continue_execute_lock_waiter', {
      RECOVERY_APPLICATION_NAME: 'recovery_dispatch_waiter',
    }, 'execute', continueOp);
    const dispatchWait = await observeLockWaitFromHolder(pool, 'recovery_dispatch_waiter', 'recovery_dispatch_holder');
    assert.equal(dispatchWait.blocked, true, 'second execute process must wait on the holder backend of the locked operation rows');
    await releaseBarrier(dispatchBarrier);
    const workers = await Promise.all([dispatchHolder, dispatchWaiter]);
    workers.forEach((entry, index) => checkExit(entry, 0, `continuation execute ${index}`));
    assert.deepEqual(await operationState(pool, continueOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, continueOp, 'MODEL_CALL'), 1);
    assert.equal(await count(pool, continueOp, 'TOOL_CALL'), 1);
    assert.equal(await effectCount(recoveryRoot, continueOp), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'approval_then_two_process_starts_one_effect', continueOp, [
      '一个子进程使用实际 AI SDK Mock 生成并持久化候选；后续批准和执行子进程未再生成候选。',
      '第一个批准子进程在锁定 Review 后进入 barrier，第二个独立连接被 pg_stat_activity 观测为 Lock 等待；释放后批准最多消费一次。',
      '第一个执行子进程在锁定 Operation/Run/Review 后进入 barrier，第二个独立连接被观测为 Lock 等待；释放后模型调用、工具调用和效果日志各为一次。',
      '动作和调用记录成功，但 probe Run 保持 RUNNING；本实验没有 PASS、CompletionRecord 或业务完成提交。',
    ]));

    const preparedOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('prepared_prepare', 'prepare', preparedOp), 0, 'prepared recovery prepare');
    checkExit(await workerRun('prepared_approve', 'approve', preparedOp), 0, 'prepared recovery approve');
    checkExit(await workerRun('prepared_crash', 'execute', preparedOp, 'after-prepared'), 72, 'hard exit after prepared');
    assert.deepEqual(await operationState(pool, preparedOp), { operation: 'PREPARED', invocation: null, run_phase: 'WAITING_APPROVAL', pause_reason: null, review: 'APPROVED' });
    checkExit(await workerRun('prepared_resume', 'execute', preparedOp), 0, 'prepared recovery resume');
    assert.deepEqual(await operationState(pool, preparedOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, preparedOp, 'MODEL_CALL'), 1);
    assert.equal(await count(pool, preparedOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'after_prepared_hard_exit_reuses_original_candidate', preparedOp, [
      '批准后的 PREPARED 短事务提交后，Worker 以 exit 72 退出且未调用外部工具。',
      '新的执行进程从同一 PREPARED 动作继续，未重新调用模型生成参数。',
    ]));

    const beforeAdapterOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('before_adapter_prepare', 'prepare', beforeAdapterOp), 0, 'before adapter prepare');
    checkExit(await workerRun('before_adapter_approve', 'approve', beforeAdapterOp), 0, 'before adapter approve');
    const beforeAdapterCrash = await workerRun('before_adapter_crash', 'execute', beforeAdapterOp, 'after-dispatch');
    checkExit(beforeAdapterCrash, 74, 'hard exit after dispatch before controlled adapter');
    assert.notEqual(beforeAdapterCrash.pid, undefined, 'crashed worker PID must be observed by parent');
    assert.deepEqual(await operationState(pool, beforeAdapterOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, beforeAdapterOp, 'TOOL_CALL'), 0);
    assert.equal(await artifactMatchesExpectedNow(recoveryRoot, beforeAdapterOp), false);
    assert.equal(await effectCount(recoveryRoot, beforeAdapterOp), 0);
    const firstInvocation = await currentDispatchInvocation(pool, beforeAdapterOp);
    assert.equal(firstInvocation.dispatch_worker_pid, beforeAdapterCrash.pid);
    await writeExitReceipt(recoveryRoot, beforeAdapterOp, firstInvocation, 74);
    checkExit(await workerRun('before_adapter_confirm_not_started', 'confirm-not-started', beforeAdapterOp), 0, 'confirm controlled adapter not started');
    const confirmed = await pool.query<{ invocation_status: string; operation_status: string }>(
      `select o.status as operation_status, i.status as invocation_status
       from operations o join invocations i on i.operation_id = o.id where o.id = $1 and i.id = $2`,
      [beforeAdapterOp, firstInvocation.id],
    );
    assert.deepEqual(confirmed.rows[0], { operation_status: 'CONFIRMED_NOT_STARTED', invocation_status: 'CONFIRMED_NOT_STARTED' });
    const retryCrash = await workerRun('before_adapter_retry_external_effect_crash', 'execute', beforeAdapterOp, 'after-external-effect');
    checkExit(retryCrash, 73, 'safe retry hard exit after external effect');
    const retryInvocation = await currentDispatchInvocation(pool, beforeAdapterOp);
    assert.notEqual(retryInvocation.id, firstInvocation.id, 'safe retry must create a new invocation');
    assert.notEqual(retryInvocation.effect_id, firstInvocation.effect_id, 'safe retry must use its own effect identity');
    const retryEffectObservedBeforeReconcile = await artifactMatchesExpectedNow(recoveryRoot, beforeAdapterOp);
    assert.equal(retryEffectObservedBeforeReconcile, true, 'parent must observe safe-retry external effect before reconciliation');
    checkExit(await workerRun('before_adapter_retry_reconcile', 'reconcile', beforeAdapterOp), 0, 'reconcile current safe retry after external effect');
    assert.deepEqual(await operationState(pool, beforeAdapterOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, beforeAdapterOp, 'MODEL_CALL'), 1);
    assert.equal(await count(pool, beforeAdapterOp, 'TOOL_CALL'), 1);
    assert.equal(await effectCount(recoveryRoot, beforeAdapterOp), 1);
    const retryResult = await pool.query<{ effect_id: string; result_effect_id: string | null; status: string }>(
      "select effect_id, status, result_evidence->>'effectId' as result_effect_id from invocations where id = $1",
      [retryInvocation.id],
    );
    assert.deepEqual(retryResult.rows[0], { effect_id: retryInvocation.effect_id, result_effect_id: retryInvocation.effect_id, status: 'SUCCEEDED' });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'safe_retry_current_invocation_reconciles_its_own_external_effect', beforeAdapterOp, [
      '第一子进程在 DISPATCHING 后、受控文件 Adapter 入口前以 exit 74 退出；父进程把退出收据绑定到该 Invocation、effect ID 和 PID。',
      '确认未启动后，安全重试创建新的 DISPATCHING Invocation，并在外部效果后以 exit 73 退出；恢复只核对这个当前 Invocation 的 effect ID。',
      '旧 CONFIRMED_NOT_STARTED Invocation 仍保留，新的 Invocation 被记录为 SUCCEEDED；模型、工具和效果各为一次。',
    ], retryEffectObservedBeforeReconcile ? 1 : 0));

    const replayReceiptOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('replay_receipt_prepare', 'prepare', replayReceiptOp), 0, 'replay receipt prepare');
    checkExit(await workerRun('replay_receipt_approve', 'approve', replayReceiptOp), 0, 'replay receipt approve');
    const replayFirstCrash = await workerRun('replay_receipt_first_crash', 'execute', replayReceiptOp, 'after-dispatch');
    checkExit(replayFirstCrash, 74, 'replay receipt first dispatch crash');
    const replayFirstInvocation = await currentDispatchInvocation(pool, replayReceiptOp);
    await writeExitReceipt(recoveryRoot, replayReceiptOp, replayFirstInvocation, 74);
    checkExit(await workerRun('replay_receipt_first_confirmed', 'confirm-not-started', replayReceiptOp), 0, 'confirm original receipt');
    const replaySecondCrash = await workerRun('replay_receipt_second_crash', 'execute', replayReceiptOp, 'after-dispatch');
    checkExit(replaySecondCrash, 74, 'replay receipt safe retry dispatch crash');
    const replaySecondInvocation = await currentDispatchInvocation(pool, replayReceiptOp);
    const replayPath = join(recoveryRoot, 'exit-receipts', `${replaySecondInvocation.id}.json`);
    await mkdir(dirname(replayPath), { recursive: true });
    await writeFile(replayPath, `${JSON.stringify({ operationId: replayReceiptOp, invocationId: replayFirstInvocation.id, effectId: replayFirstInvocation.effect_id, pid: replaySecondInvocation.dispatch_worker_pid, exitCode: 74 })}\n`, { encoding: 'utf8', flag: 'wx' });
    checkExit(await workerRun('replay_receipt_rejected', 'confirm-not-started', replayReceiptOp), 0, 'reject receipt replayed with a controlled same-PID fixture');
    assert.deepEqual(await operationState(pool, replayReceiptOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, replayReceiptOp, 'ADAPTER_ENTRY_CONFIRMED_NOT_REACHED'), 1, 'old receipt must not confirm the new invocation');
    assert.equal(await count(pool, replayReceiptOp, 'TOOL_CALL'), 0);
    checkExit(await workerRun('replay_receipt_reconcile_unknown', 'reconcile', replayReceiptOp), 0, 'reconcile unapproved replay receipt safely as unknown');
    assert.deepEqual(await operationState(pool, replayReceiptOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'old_or_replayed_exit_receipt_cannot_approve_new_invocation', replayReceiptOp, [
      '第一 Invocation 的真实 exit 74 收据仍按其 ID 保存；安全重试后创建第二个 DISPATCHING Invocation。',
      '第二次确认注入 PID 等于新 Worker 的旧 Invocation 收据，模拟 PID 复用或收据重放；Invocation ID 和 effect ID 不匹配，因此拒绝确认。',
      '没有 Adapter 入口或效果证据时，后续恢复保持 UNKNOWN，而不是把旧收据泛化为新 attempt 的安全重试授权。',
    ]));

    const oldAliveOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('old_alive_prepare', 'prepare', oldAliveOp), 0, 'old alive prepare');
    checkExit(await workerRun('old_alive_approve', 'approve', oldAliveOp), 0, 'old alive approve');
    const oldAliveBarrier = join(runRoot, 'barriers', `old-alive-${randomUUID()}`);
    await mkdir(oldAliveBarrier, { recursive: true });
    const oldAliveWorker = workerRunWith('old_alive_holds_before_adapter', { RECOVERY_BARRIER_DIR: oldAliveBarrier }, 'execute', oldAliveOp, 'hold-after-dispatch');
    await waitForBarrierFile(oldAliveBarrier, `ready-${oldAliveOp}`);
    checkExit(await workerRun('old_alive_confirmation_rejected', 'confirm-not-started', oldAliveOp), 0, 'active old worker confirmation attempt');
    assert.deepEqual(await operationState(pool, oldAliveOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, oldAliveOp, 'ADAPTER_ENTRY_CONFIRMED_NOT_REACHED'), 0);
    await releaseBarrier(oldAliveBarrier);
    checkExit(await oldAliveWorker, 0, 'old worker resumes after rejected confirmation');
    assert.deepEqual(await operationState(pool, oldAliveOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'live_worker_before_adapter_rejects_safe_retry_confirmation', oldAliveOp, [
      '一个实际子进程在 DISPATCHING 与适配器入口之间由 barrier 保持存活；此时目标、效果日志和 TOOL_CALL 都尚不存在。',
      '第二个恢复进程因原 Invocation PID 仍存活且没有绑定 exit 74 收据而拒绝 CONFIRMED_NOT_STARTED；释放 barrier 后仅旧进程调用工具。',
    ]));

    const partialWriteOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('partial_write_prepare', 'prepare', partialWriteOp), 0, 'partial write prepare');
    checkExit(await workerRun('partial_write_approve', 'approve', partialWriteOp), 0, 'partial write approve');
    checkExit(await workerRun('partial_write_crash', 'execute', partialWriteOp, 'after-partial-write'), 75, 'hard exit after partial write');
    assert.equal(await artifactMatchesExpectedNow(recoveryRoot, partialWriteOp), false);
    assert.equal(await effectCount(recoveryRoot, partialWriteOp), 0);
    checkExit(await workerRun('partial_write_reconcile', 'reconcile', partialWriteOp), 0, 'partial write reconciliation');
    assert.deepEqual(await operationState(pool, partialWriteOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    assert.equal(await count(pool, partialWriteOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'partial_write_without_identity_evidence_stays_unknown', partialWriteOp, [
      '受控 Adapter 已进入并只写入部分文件后以 exit 75 退出，没有动作身份效果证据。',
      '恢复不把部分内容当成功或未发生；保持 UNKNOWN、PAUSED 且不重调工具，并在同一主 Worker 短事务把该动作的资源 claim 转为 QUARANTINED。',
    ]));

    const heldResourceKey = randomUUID();
    const heldResourceId = `shared-${heldResourceKey}`;
    const heldFirstOp = `operation-${randomUUID()}`;
    const heldSecondOp = `operation-${randomUUID()}`;
    checkExit(await workerRunWith('resource_held_first_prepare', { RECOVERY_SHARED_TARGET_KEY: heldResourceKey }, 'prepare', heldFirstOp), 0, 'held resource first prepare');
    checkExit(await workerRun('resource_held_first_approve', 'approve', heldFirstOp), 0, 'held resource first approve');
    const heldResourceBarrier = join(runRoot, 'barriers', `resource-held-${randomUUID()}`);
    await mkdir(heldResourceBarrier, { recursive: true });
    const heldFirstWorker = workerRunWith('resource_held_first_dispatch', { RECOVERY_BARRIER_DIR: heldResourceBarrier }, 'execute', heldFirstOp, 'hold-after-dispatch');
    await waitForBarrierFile(heldResourceBarrier, `ready-${heldFirstOp}`);
    assert.deepEqual(await activeResourceClaim(pool, heldResourceId), {
      operationId: heldFirstOp,
      runId: `run-${heldFirstOp}`,
      status: 'HELD',
      taskId: `task-${heldFirstOp}`,
      workerClaimEpoch: '1',
    });
    checkExit(await workerRunWith('resource_held_second_prepare', { RECOVERY_SHARED_TARGET_KEY: heldResourceKey }, 'prepare', heldSecondOp), 0, 'held resource second prepare');
    checkExit(await workerRun('resource_held_second_approve', 'approve', heldSecondOp), 0, 'held resource second approve');
    checkExit(await workerRun('resource_held_second_execute_refused', 'execute', heldSecondOp), 0, 'held resource second execute refused');
    assert.deepEqual(await operationState(pool, heldSecondOp), { operation: 'PREPARED', invocation: null, run_phase: 'WAITING_APPROVAL', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, heldSecondOp, 'RESOURCE_CLAIM_UNAVAILABLE'), 1);
    assert.equal(await count(pool, heldSecondOp, 'TOOL_CALL'), 0);
    assert.equal(await effectCount(recoveryRoot, heldSecondOp), 0);
    await releaseBarrier(heldResourceBarrier);
    checkExit(await heldFirstWorker, 0, 'held resource first worker resumes');
    assert.equal(await artifactMatchesExpectedNow(recoveryRoot, heldFirstOp, heldResourceId), true);
    const releasedHeldClaim = await pool.query<{ status: string }>('select status from resource_claims where operation_id = $1', [heldFirstOp]);
    assert.deepEqual(releasedHeldClaim.rows[0], { status: 'RELEASED' });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'held_resource_blocks_second_task_before_adapter', heldSecondOp, [
      '两个独立 Task/Run 在 prepare 时由测试运行器显式绑定同一个隔离临时资源；第一 Task 已 DISPATCHING 并持有 HELD claim，但尚未进入 Adapter。',
      '第二 Task 的准入事务锁定自身 Task/Run、同一资源与动作后，看到 HELD claim 即停止；没有 Invocation、TOOL_CALL、效果日志或文件写入。',
      '释放第一 Worker 后其调用成功并在结果短事务中释放 claim；本场景不把该局部机制扩展为生产资源协议。',
    ]));

    const quarantinedResourceKey = randomUUID();
    const quarantinedResourceId = `shared-${quarantinedResourceKey}`;
    const quarantinedFirstOp = `operation-${randomUUID()}`;
    const quarantinedSecondOp = `operation-${randomUUID()}`;
    checkExit(await workerRunWith('resource_quarantine_first_prepare', { RECOVERY_SHARED_TARGET_KEY: quarantinedResourceKey }, 'prepare', quarantinedFirstOp), 0, 'quarantined resource first prepare');
    checkExit(await workerRun('resource_quarantine_first_approve', 'approve', quarantinedFirstOp), 0, 'quarantined resource first approve');
    checkExit(await workerRun('resource_quarantine_first_partial_write', 'execute', quarantinedFirstOp, 'after-partial-write'), 75, 'quarantined resource first partial write');
    const partialSharedTarget = join(recoveryRoot, quarantinedResourceId, 'managed-artifact.txt');
    assert.equal(await readFile(partialSharedTarget, 'utf8'), 'partial-write-without-action-identity-evidence\n');
    checkExit(await workerRun('resource_quarantine_first_reconcile', 'reconcile', quarantinedFirstOp), 0, 'quarantined resource first reconcile');
    assert.deepEqual(await operationState(pool, quarantinedFirstOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    assert.deepEqual(await activeResourceClaim(pool, quarantinedResourceId), {
      operationId: quarantinedFirstOp,
      runId: `run-${quarantinedFirstOp}`,
      status: 'QUARANTINED',
      taskId: `task-${quarantinedFirstOp}`,
      workerClaimEpoch: '1',
    });
    checkExit(await workerRunWith('resource_quarantine_second_prepare', { RECOVERY_SHARED_TARGET_KEY: quarantinedResourceKey }, 'prepare', quarantinedSecondOp), 0, 'quarantined resource second prepare');
    const matchingBaseline = await pool.query<{ baseline_hash: string }>('select baseline_hash from operations where id = $1', [quarantinedSecondOp]);
    assert.equal(matchingBaseline.rows[0]?.baseline_hash, sha256(await readFile(partialSharedTarget)));
    checkExit(await workerRun('resource_quarantine_second_approve', 'approve', quarantinedSecondOp), 0, 'quarantined resource second approve');
    checkExit(await workerRun('resource_quarantine_second_execute_refused', 'execute', quarantinedSecondOp), 0, 'quarantined resource second execute refused');
    assert.deepEqual(await operationState(pool, quarantinedSecondOp), { operation: 'PREPARED', invocation: null, run_phase: 'WAITING_APPROVAL', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, quarantinedSecondOp, 'RESOURCE_CLAIM_UNAVAILABLE'), 1);
    assert.equal(await count(pool, quarantinedSecondOp, 'TOOL_CALL'), 0);
    assert.equal(await effectCount(recoveryRoot, quarantinedSecondOp), 0);
    assert.deepEqual(await activeResourceClaim(pool, quarantinedResourceId), {
      operationId: quarantinedFirstOp,
      runId: `run-${quarantinedFirstOp}`,
      status: 'QUARANTINED',
      taskId: `task-${quarantinedFirstOp}`,
      workerClaimEpoch: '1',
    });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'unknown_resource_claim_stays_quarantined_before_second_adapter', quarantinedSecondOp, [
      '第一 Task 在共享资源只写部分内容后以 exit 75 退出；主 Worker 的同一 UNKNOWN 短事务把原 HELD claim 转为 QUARANTINED。',
      '第二 Task 在部分文件已经存在后才 prepare，其持久化基线与该部分文件哈希相同；准入仍先看到 QUARANTINED claim，而非把文件存在当作绕过资源隔离的理由。',
      '第二 Task 没有 Invocation、TOOL_CALL、效果日志或文件写入；UNKNOWN 的 claim 不因进程退出或任何租约推定而自动释放。',
    ]));

    const crashOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('crash_prepare', 'prepare', crashOp), 0, 'crash prepare');
    checkExit(await workerRun('crash_approve', 'approve', crashOp), 0, 'crash approve');
    const crash = await workerRun('crash_execute', 'execute', crashOp, 'after-external-effect');
    checkExit(crash, 73, 'hard exit after external effect');
    const crashEffectObservedBeforeReconcile = await artifactMatchesExpectedNow(recoveryRoot, crashOp);
    assert.equal(crashEffectObservedBeforeReconcile, true, 'parent must observe the expected file after child exit 73');
    assert.deepEqual(await operationState(pool, crashOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    checkExit(await workerRun('crash_reconcile', 'reconcile', crashOp), 0, 'reconcile after hard exit');
    assert.deepEqual(await operationState(pool, crashOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, crashOp, 'MODEL_CALL'), 1);
    assert.equal(await count(pool, crashOp, 'TOOL_CALL'), 1);
    assert.equal(await effectCount(recoveryRoot, crashOp), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'after_external_effect_hard_exit_reconciles_original_evidence', crashOp, [
      '执行子进程在受管文件和独立效果日志 fsync 后以 exit 73 退出。',
      '新进程凭原逻辑动作 ID、effect ID、参数哈希、基线哈希、内容哈希和目标哈希补记同一调用结果。',
      '恢复期间模型调用和工具调用均没有增加。',
    ], crashEffectObservedBeforeReconcile ? 1 : 0));

    const restartOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('restart_prepare', 'prepare', restartOp), 0, 'restart recovery prepare');
    checkExit(await workerRun('restart_approve', 'approve', restartOp), 0, 'restart recovery approve');
    checkExit(await workerRun('restart_crash', 'execute', restartOp, 'after-external-effect'), 73, 'restart recovery hard exit after external effect');
    const restartEffectObservedBeforeDatabaseRestart = await artifactMatchesExpectedNow(recoveryRoot, restartOp);
    assert.equal(restartEffectObservedBeforeDatabaseRestart, true, 'parent must observe the expected file before PostgreSQL restart');
    assert.deepEqual(await operationState(pool, restartOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    await pool.end();
    pool = undefined;
    const restartStop = await runProcess('pg_ctl_restart_stop', pgCtl, ['stop', '-D', dataDirectory, '-m', 'immediate', '-w', '-t', '30'], process.env, false);
    processEvidence.push(restartStop);
    checkExit(restartStop, 0, 'PostgreSQL restart stop');
    postgresStarted = false;
    const restartStart = await runProcess('pg_ctl_restart_start', pgCtl, ['start', '-D', dataDirectory, '-l', postgresLog, '-o', `-p ${port} -h 127.0.0.1`, '-w', '-t', '30'], process.env, false);
    processEvidence.push(restartStart);
    checkExit(restartStart, 0, 'PostgreSQL restart start');
    postgresStarted = true;
    const restartedPool = new Client({ connectionString: databaseUrl });
    await restartedPool.connect();
    pool = restartedPool;
    assert.equal((await restartedPool.query<{ server_version: string }>('show server_version')).rows[0]?.server_version, postgresVersion, 'PostgreSQL version must remain stable across the test restart');
    assert.deepEqual(await operationState(restartedPool, restartOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    checkExit(await workerRun('restart_reconcile', 'reconcile', restartOp), 0, 'reconcile after real PostgreSQL restart');
    assert.deepEqual(await operationState(restartedPool, restartOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(restartedPool, restartOp, 'MODEL_CALL'), 1);
    assert.equal(await count(restartedPool, restartOp, 'TOOL_CALL'), 1);
    assert.equal(await effectCount(recoveryRoot, restartOp), 1);
    scenarios.push(await scenarioCounts(restartedPool, recoveryRoot, 'after_external_effect_hard_exit_reconciles_after_real_postgres_restart', restartOp, [
      '受控外部效果写入后，Worker 以 exit 73 退出，数据库中的 Invocation 仍为 DISPATCHING。',
      '父运行器关闭连接并以 pg_ctl immediate 停止、再以同一 data directory 和端口启动真实 PostgreSQL。',
      '新 Worker 从重启后的数据库按原动作身份核对证据并补记结果，模型调用和工具调用均没有增加。',
    ], restartEffectObservedBeforeDatabaseRestart ? 1 : 0));

    const missingOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('missing_prepare', 'prepare', missingOp), 0, 'missing evidence prepare');
    checkExit(await workerRun('missing_approve', 'approve', missingOp), 0, 'missing evidence approve');
    checkExit(await workerRun('missing_crash', 'execute', missingOp, 'after-external-effect'), 73, 'missing evidence hard exit');
    const missingEffectObservedBeforeEvidenceRemoval = await artifactMatchesExpectedNow(recoveryRoot, missingOp);
    assert.equal(missingEffectObservedBeforeEvidenceRemoval, true, 'parent must observe original file before evidence deletion');
    const missingLog = join(recoveryRoot, 'effects', `${missingOp}.jsonl`);
    assertOwnedPath(missingLog, recoveryRoot);
    await rm(missingLog);
    checkExit(await workerRun('missing_reconcile', 'reconcile', missingOp), 0, 'missing evidence reconcile');
    assert.deepEqual(await operationState(pool, missingOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    assert.equal(await count(pool, missingOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'missing_action_identity_evidence_stays_unknown', missingOp, [
      '即使固定受管文件内容仍在，原动作身份效果日志缺失时也不把内容相同当作本次成功证据。',
      '恢复不重调工具，动作进入 UNKNOWN，probe Run 进入 PAUSED 并写入 INSUFFICIENT_EVIDENCE 原因。',
    ], missingEffectObservedBeforeEvidenceRemoval ? 1 : 0));

    const editedAfterEffectOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('edited_after_effect_prepare', 'prepare', editedAfterEffectOp), 0, 'edited after effect prepare');
    checkExit(await workerRun('edited_after_effect_approve', 'approve', editedAfterEffectOp), 0, 'edited after effect approve');
    checkExit(await workerRun('edited_after_effect_crash', 'execute', editedAfterEffectOp, 'after-external-effect'), 73, 'edited after effect hard exit');
    const editedEffectObservedBeforeExternalEdit = await artifactMatchesExpectedNow(recoveryRoot, editedAfterEffectOp);
    assert.equal(editedEffectObservedBeforeExternalEdit, true, 'parent must observe original file before external edit');
    const editedAfterEffectTarget = join(recoveryRoot, editedAfterEffectOp, 'managed-artifact.txt');
    assertOwnedPath(editedAfterEffectTarget, recoveryRoot);
    await writeFile(editedAfterEffectTarget, 'externally edited after original effect\n', 'utf8');
    checkExit(await workerRun('edited_after_effect_reconcile', 'reconcile', editedAfterEffectOp), 0, 'edited after effect reconcile');
    assert.deepEqual(await operationState(pool, editedAfterEffectOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    assert.equal(await count(pool, editedAfterEffectOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'external_edit_after_effect_does_not_match_old_evidence', editedAfterEffectOp, [
      '外部效果后的受管文件被实验外部内容改写，而原效果日志仍保留。',
      '恢复要求日志 afterHash 与当前目标和预期内容哈希同时匹配，因此不重调工具并转 UNKNOWN。',
    ], editedEffectObservedBeforeExternalEdit ? 1 : 0));

    const truncatedEvidenceOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('truncated_evidence_prepare', 'prepare', truncatedEvidenceOp), 0, 'truncated evidence prepare');
    checkExit(await workerRun('truncated_evidence_approve', 'approve', truncatedEvidenceOp), 0, 'truncated evidence approve');
    checkExit(await workerRun('truncated_evidence_crash', 'execute', truncatedEvidenceOp, 'after-external-effect'), 73, 'truncated evidence hard exit');
    const truncatedEffectObservedBeforeCorruption = await artifactMatchesExpectedNow(recoveryRoot, truncatedEvidenceOp);
    assert.equal(truncatedEffectObservedBeforeCorruption, true, 'parent must observe original file before evidence corruption');
    const truncatedLog = join(recoveryRoot, 'effects', `${truncatedEvidenceOp}.jsonl`);
    assertOwnedPath(truncatedLog, recoveryRoot);
    await writeFile(truncatedLog, '{"schemaVersion":', 'utf8');
    checkExit(await workerRun('truncated_evidence_reconcile', 'reconcile', truncatedEvidenceOp), 0, 'truncated evidence reconcile');
    assert.deepEqual(await operationState(pool, truncatedEvidenceOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    assert.equal(await count(pool, truncatedEvidenceOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'truncated_effect_evidence_stays_unknown', truncatedEvidenceOp, [
      '外部效果后将独立效果日志截断为不可解析 JSON。',
      '恢复将损坏日志视为证据不足，不抛出为成功，也不重调工具。',
    ], truncatedEffectObservedBeforeCorruption ? 1 : 0));

    const nullEvidenceOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('null_evidence_prepare', 'prepare', nullEvidenceOp), 0, 'null evidence prepare');
    checkExit(await workerRun('null_evidence_approve', 'approve', nullEvidenceOp), 0, 'null evidence approve');
    checkExit(await workerRun('null_evidence_crash', 'execute', nullEvidenceOp, 'after-external-effect'), 73, 'null evidence hard exit');
    const nullEffectObservedBeforeCorruption = await artifactMatchesExpectedNow(recoveryRoot, nullEvidenceOp);
    assert.equal(nullEffectObservedBeforeCorruption, true, 'parent must observe original file before replacing evidence with null');
    const nullLog = join(recoveryRoot, 'effects', `${nullEvidenceOp}.jsonl`);
    assertOwnedPath(nullLog, recoveryRoot);
    await writeFile(nullLog, 'null\n', 'utf8');
    checkExit(await workerRun('null_evidence_reconcile', 'reconcile', nullEvidenceOp), 0, 'null evidence reconcile');
    assert.deepEqual(await operationState(pool, nullEvidenceOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    assert.equal(await count(pool, nullEvidenceOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'non_object_effect_evidence_stays_unknown', nullEvidenceOp, [
      '外部效果后将效果日志替换为合法 JSON 的 null。',
      '恢复拒绝非对象证据，不重调工具并转 UNKNOWN。',
    ], nullEffectObservedBeforeCorruption ? 1 : 0));

    const externalBaselineOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('external_baseline_prepare', 'prepare', externalBaselineOp), 0, 'external baseline prepare');
    checkExit(await workerRun('external_baseline_approve', 'approve', externalBaselineOp), 0, 'external baseline approve');
    const externallyEditedTarget = join(recoveryRoot, externalBaselineOp, 'managed-artifact.txt');
    assertOwnedPath(externallyEditedTarget, recoveryRoot);
    await mkdir(dirname(externallyEditedTarget), { recursive: true });
    await writeFile(externallyEditedTarget, 'externally edited after approval\n', { encoding: 'utf8', flag: 'wx' });
    checkExit(await workerRun('external_baseline_execute', 'execute', externalBaselineOp), 0, 'external baseline execute');
    assert.deepEqual(await operationState(pool, externalBaselineOp), { operation: 'DENIED', invocation: null, run_phase: 'PAUSED', pause_reason: 'BASELINE_CHANGED', review: 'INVALID' });
    assert.equal(await count(pool, externalBaselineOp, 'TOOL_CALL'), 0);
    assert.equal(await readFile(externallyEditedTarget, 'utf8'), 'externally edited after approval\n');
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'external_file_edit_after_approval_is_not_overwritten', externalBaselineOp, [
      '批准后由实验外部写入操作专属固定受管目标。',
      '执行前重新读取真实基线并拒绝；exclusive create 没有覆盖该文件，也没有工具调用。',
    ]));

    for (const field of ['parameter', 'baseline', 'permission', 'acceptance', 'ownership'] as const) {
      const invalidOp = `operation-${randomUUID()}`;
      checkExit(await workerRun(`invalidate_${field}_prepare`, 'prepare', invalidOp), 0, `${field} prepare`);
      checkExit(await workerRun(`invalidate_${field}_approve`, 'approve', invalidOp), 0, `${field} approve`);
      checkExit(await workerRun(`invalidate_${field}_mutate`, 'mutate', invalidOp, field), 0, `${field} mutate`);
      checkExit(await workerRun(`invalidate_${field}_execute`, 'execute', invalidOp), 0, `${field} execute`);
      assert.deepEqual(await operationState(pool, invalidOp), { operation: 'DENIED', invocation: null, run_phase: 'PAUSED', pause_reason: 'APPROVAL_INVALIDATED', review: 'INVALID' });
      assert.equal(await count(pool, invalidOp, 'TOOL_CALL'), 0);
      scenarios.push(await scenarioCounts(pool, recoveryRoot, `approval_invalidated_by_${field}_change`, invalidOp, [
        `批准后的当前 ${field} 绑定发生变化。`,
        '执行进程在外部效果前失效批准，不产生调用或效果。',
      ]));
    }

    const oldEpochOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('old_epoch_prepare', 'prepare', oldEpochOp), 0, 'old epoch prepare');
    checkExit(await workerRun('old_epoch_approve', 'approve', oldEpochOp), 0, 'old epoch approve');
    checkExit(await workerRun('old_epoch_crash', 'execute', oldEpochOp, 'after-external-effect'), 73, 'old epoch hard exit');
    const oldEpochEffectObservedBeforeOwnershipChange = await artifactMatchesExpectedNow(recoveryRoot, oldEpochOp);
    assert.equal(oldEpochEffectObservedBeforeOwnershipChange, true, 'parent must observe original file before ownership transfer');
    checkExit(await workerRun('old_epoch_mutate', 'mutate', oldEpochOp, 'ownership'), 0, 'old epoch ownership transfer');
    checkExit(await workerRun('old_epoch_reconcile', 'reconcile', oldEpochOp), 0, 'old epoch reconcile');
    assert.deepEqual(await operationState(pool, oldEpochOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, oldEpochOp, 'STALE_OWNERSHIP_EPOCH_EVIDENCE_RETAINED'), 1);
    assert.equal(await count(pool, oldEpochOp, 'TOOL_CALL'), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'old_ownership_epoch_cannot_commit_result', oldEpochOp, [
      '外部效果后转移 ownership_epoch；旧 epoch 的恢复进程不能把动作或调用更新为 SUCCEEDED。',
      '原证据被单独保留，等待当前执行权持有者处理；没有二次工具调用。',
    ], oldEpochEffectObservedBeforeOwnershipChange ? 1 : 0));

    const jointAdmissionOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('joint_admission_prepare', 'prepare', jointAdmissionOp), 0, 'joint admission prepare');
    checkExit(await workerRun('joint_admission_approve', 'approve', jointAdmissionOp), 0, 'joint admission approve');
    const admissionPool: Client = pool;
    const admissionWrites = async (): Promise<{ claims: string[]; dispatches: number; events: number; invocations: number; states: { operation: string; invocation: string | null; pause_reason: string | null; review: string; run_phase: string } }> => ({
      claims: await claimStatuses(admissionPool, jointAdmissionOp),
      dispatches: await count(admissionPool, jointAdmissionOp, 'DISPATCH_CLAIMED'),
      events: await count(admissionPool, jointAdmissionOp, 'RESOURCE_CLAIM_HELD'),
      invocations: await scalar(admissionPool, 'select count(*)::int as count from invocations where operation_id = $1', [jointAdmissionOp]),
      states: await operationState(admissionPool, jointAdmissionOp),
    });
    const admitted: { operation: string; invocation: string | null; pause_reason: string | null; review: string; run_phase: string } = { operation: 'PREPARED', invocation: null, run_phase: 'WAITING_APPROVAL', pause_reason: null, review: 'APPROVED' };
    checkExit(await workerRunWith('joint_admission_rollback', { RECOVERY_INJECT_FAILURE: 'admission-rollback' }, 'execute', jointAdmissionOp), 76, 'injected failure inside the admission transaction');
    assert.deepEqual(await admissionWrites(), { claims: [], dispatches: 0, events: 0, invocations: 0, states: admitted });
    checkExit(await workerRunWith('joint_admission_abrupt_exit', { RECOVERY_INJECT_FAILURE: 'admission-crash' }, 'execute', jointAdmissionOp), 77, 'abrupt exit with the admission transaction still open');
    /*
     * An uncommitted row is never visible to another connection, so the rollback
     * of the disconnected transaction cannot be "observed" as an intermediate
     * state. The honest assertions are that every write of that transaction is
     * absent and that a following clean run acquires exactly one claim.
     */
    assert.deepEqual(await admissionWrites(), { claims: [], dispatches: 0, events: 0, invocations: 0, states: admitted });
    assert.deepEqual(await runPosition(pool, jointAdmissionOp), { phase: 'WAITING_APPROVAL', next_step_index: 1, step_count: 2, lease_expired: false });
    assert.deepEqual(await stepStates(pool, jointAdmissionOp), [
      { step_index: 0, name: 'CAPTURE_CANDIDATE', status: 'SUCCEEDED', attempt: 1 },
      { step_index: 1, name: 'APPLY_MANAGED_WRITE', status: 'PENDING', attempt: 0 },
    ]);
    checkExit(await workerRun('joint_admission_clean', 'execute', jointAdmissionOp), 0, 'clean admission after the injected failures');
    assert.deepEqual(await operationState(pool, jointAdmissionOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, jointAdmissionOp, 'RESOURCE_CLAIM_HELD'), 1, 'only the committed admission may record a held claim');
    assert.equal(await count(pool, jointAdmissionOp, 'DISPATCH_CLAIMED'), 1);
    assert.equal(await scalar(pool, 'select count(*)::int as count from invocations where operation_id = $1', [jointAdmissionOp]), 1);
    assert.deepEqual(await claimStatuses(pool, jointAdmissionOp), ['RELEASED']);
    assert.deepEqual(await stepStates(pool, jointAdmissionOp), [
      { step_index: 0, name: 'CAPTURE_CANDIDATE', status: 'SUCCEEDED', attempt: 1 },
      { step_index: 1, name: 'APPLY_MANAGED_WRITE', status: 'SUCCEEDED', attempt: 1 },
    ]);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'dispatching_admission_and_resource_claim_commit_or_roll_back_together', jointAdmissionOp, [
      'DISPATCHING 准入、Invocation 记录、run 阶段与资源 claim 取得在同一短事务；注入点位于该事务全部写入之后、提交之前，因此只要提交发生，claim 行、Invocation 行、DISPATCHING 状态与两个事件都会一起可见。',
      'exit 76（连接执行真实 ROLLBACK）与 exit 77（未提交断连由 PostgreSQL 回滚）后，claim 行、Invocation 行、DISPATCH_CLAIMED / RESOURCE_CLAIM_HELD 事件都为 0，动作回到 PREPARED，Step 位置仍为 1/2。',
      '随后无注入执行完成同一动作：claim、Invocation 与事件计数各为 1，证明注入事务的写入没有残留；未提交断连的回滚证据是这些行的缺失加上 clean 运行成功，而不是观测到的中间态。',
    ]));

    const jointResultOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('joint_result_prepare', 'prepare', jointResultOp), 0, 'joint result prepare');
    checkExit(await workerRun('joint_result_approve', 'approve', jointResultOp), 0, 'joint result approve');
    checkExit(await workerRunWith('joint_result_rollback', { RECOVERY_INJECT_FAILURE: 'result-rollback' }, 'execute', jointResultOp), 76, 'injected failure inside the result transaction');
    const jointResultEffectObserved = await artifactMatchesExpectedNow(recoveryRoot, jointResultOp);
    assert.equal(jointResultEffectObserved, true, 'the external effect happened before the injected result failure');
    assert.deepEqual(await operationState(pool, jointResultOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.deepEqual(await claimStatuses(pool, jointResultOp), ['HELD'], 'the rolled-back result transaction must not release the claim');
    assert.deepEqual(await runPosition(pool, jointResultOp), { phase: 'RUNNING', next_step_index: 1, step_count: 2, lease_expired: false });
    assert.equal(await count(pool, jointResultOp, 'RESULT_RECORDED'), 0);
    assert.equal(await count(pool, jointResultOp, 'RESOURCE_CLAIM_RELEASED'), 0);
    assert.equal(await count(pool, jointResultOp, 'TOOL_CALL'), 1);
    checkExit(await workerRun('joint_result_reconcile', 'reconcile', jointResultOp), 0, 'reconcile after the rolled-back result transaction');
    assert.deepEqual(await operationState(pool, jointResultOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.deepEqual(await claimStatuses(pool, jointResultOp), ['RELEASED']);
    assert.deepEqual(await runPosition(pool, jointResultOp), { phase: 'RUNNING', next_step_index: 2, step_count: 2, lease_expired: false });
    assert.equal(await count(pool, jointResultOp, 'RESULT_RECORDED'), 1);
    const duplicateReconcile = await workerRun('joint_result_duplicate_reconcile', 'reconcile', jointResultOp);
    checkExit(duplicateReconcile, 0, 'reconcile replay after the result was committed');
    assert.equal(childEvent(duplicateReconcile, 'reconcile_skipped')?.status, 'SUCCEEDED', 'a repeated recovery path must observe the terminal action instead of re-invoking');
    assert.deepEqual(await operationState(pool, jointResultOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, jointResultOp, 'MODEL_CALL'), 1);
    assert.equal(await count(pool, jointResultOp, 'TOOL_CALL'), 1);
    assert.equal(await effectCount(recoveryRoot, jointResultOp), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'call_result_and_resource_state_commit_in_one_transaction', jointResultOp, [
      '外部效果已经写入后，结果与 claim 释放所在短事务注入失败（exit 76）：动作保持 DISPATCHING，claim 保持 HELD，没有 RESULT_RECORDED 或 RESOURCE_CLAIM_RELEASED 事件，Step 也没有推进。',
      '恢复进程用原 Invocation 与 effect 身份核对同一证据后提交结果；这次已提交的短事务同时释放 claim 并把 Step 推进到 2/2。',
      '提交后再次运行恢复路径只读到终态 SUCCEEDED，不改变动作、claim 或调用计数。',
    ], jointResultEffectObserved ? 1 : 0));

    const staleClaimOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('stale_claim_prepare', 'prepare', staleClaimOp), 0, 'stale claim prepare');
    checkExit(await workerRun('stale_claim_approve', 'approve', staleClaimOp), 0, 'stale claim approve');
    checkExit(await workerRun('stale_claim_crash', 'execute', staleClaimOp, 'after-external-effect'), 73, 'stale claim hard exit');
    const staleClaimEffectObserved = await artifactMatchesExpectedNow(recoveryRoot, staleClaimOp);
    assert.equal(staleClaimEffectObserved, true, 'parent must observe the original file before the claim epoch advances');
    checkExit(await workerRun('stale_claim_mutate', 'mutate', staleClaimOp, 'claim'), 0, 'stale claim epoch advance');
    checkExit(await workerRun('stale_claim_reconcile', 'reconcile', staleClaimOp), 0, 'stale claim reconcile');
    assert.deepEqual(await operationState(pool, staleClaimOp), { operation: 'DISPATCHING', invocation: 'DISPATCHING', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, staleClaimOp, 'STALE_WORKER_CLAIM_EPOCH_EVIDENCE_RETAINED'), 1);
    assert.deepEqual(await claimStatuses(pool, staleClaimOp), ['HELD'], 'a rejected stale result must not release or quarantine the claim');
    assert.equal(await count(pool, staleClaimOp, 'RESULT_RECORDED'), 0);
    assert.equal(await count(pool, staleClaimOp, 'TOOL_CALL'), 1);
    assert.equal(await scalar(pool, 'select count(*)::int as count from reconciliation_evidence where operation_id = $1', [staleClaimOp]), 1);
    assert.deepEqual(await runPosition(pool, staleClaimOp), { phase: 'RUNNING', next_step_index: 1, step_count: 2, lease_expired: false });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'stale_worker_claim_epoch_result_rejected_without_changing_claim', staleClaimOp, [
      '外部效果后 Worker claim epoch 被推进；旧 epoch 的 Invocation 结果在真实长事务比对下被拒绝，事件保留核对证据。',
      '同一拒绝路径不释放、不隔离也不改变 claim 状态，Step 位置停留在 1/2；没有第二次工具调用。',
    ], staleClaimEffectObserved ? 1 : 0));

    const stepOp = `operation-${randomUUID()}`;
    const stepPrepare = await workerRun('step_prepare', 'prepare', stepOp);
    checkExit(stepPrepare, 0, 'step prepare');
    assert.equal(childEvent(stepPrepare, 'prepared')?.model_rounds_this_process, 1, 'the prepare child must report its own single model round');
    assert.deepEqual(await stepStates(pool, stepOp), [
      { step_index: 0, name: 'CAPTURE_CANDIDATE', status: 'SUCCEEDED', attempt: 1 },
      { step_index: 1, name: 'APPLY_MANAGED_WRITE', status: 'PENDING', attempt: 0 },
    ]);
    assert.deepEqual(await runPosition(pool, stepOp), { phase: 'WAITING_APPROVAL', next_step_index: 1, step_count: 2, lease_expired: false });
    checkExit(await workerRun('step_approve', 'approve', stepOp), 0, 'step approve');
    checkExit(await workerRun('step_between_steps_crash', 'execute', stepOp, 'after-prepared'), 72, 'hard exit between step 0 and step 1');
    assert.deepEqual(await runPosition(pool, stepOp), { phase: 'WAITING_APPROVAL', next_step_index: 1, step_count: 2, lease_expired: false });
    assert.deepEqual(await claimStatuses(pool, stepOp), []);
    const stepResume = await workerRun('step_resume', 'execute', stepOp);
    checkExit(stepResume, 0, 'resume from the persisted step position');
    const resumeEvent = childEvent(stepResume, 'resume_from_step');
    assert.equal(resumeEvent?.step_index, 1, 'the new process must resume from the persisted second step');
    assert.equal(resumeEvent?.completed_steps, 1);
    assert.equal(resumeEvent?.step_count, 2);
    assert.equal(resumeEvent?.model_rounds_this_process, 0, 'the resuming process must measure zero model rounds of its own');
    assert.equal(childEvent(stepResume, 'execute_result')?.model_rounds_this_process, 0);
    assert.equal(await count(pool, stepOp, 'MODEL_CALL'), 1, 'resuming must not repeat the model round of the committed step');
    assert.equal(await count(pool, stepOp, 'TOOL_CALL'), 1);
    assert.deepEqual(await stepStates(pool, stepOp), [
      { step_index: 0, name: 'CAPTURE_CANDIDATE', status: 'SUCCEEDED', attempt: 1 },
      { step_index: 1, name: 'APPLY_MANAGED_WRITE', status: 'SUCCEEDED', attempt: 1 },
    ]);
    assert.deepEqual(await runPosition(pool, stepOp), { phase: 'RUNNING', next_step_index: 2, step_count: 2, lease_expired: false });
    const stepRepeat = await workerRun('step_repeat_after_completion', 'execute', stepOp);
    checkExit(stepRepeat, 0, 'repeat execute after both steps succeeded');
    assert.notEqual(childEvent(stepRepeat, 'execute_skipped'), undefined, 'a completed action must be skipped instead of re-dispatched');
    assert.equal(await count(pool, stepOp, 'MODEL_CALL'), 1);
    assert.equal(await count(pool, stepOp, 'TOOL_CALL'), 1);
    assert.equal(await effectCount(recoveryRoot, stepOp), 1);
    assert.deepEqual(await stepStates(pool, stepOp), [
      { step_index: 0, name: 'CAPTURE_CANDIDATE', status: 'SUCCEEDED', attempt: 1 },
      { step_index: 1, name: 'APPLY_MANAGED_WRITE', status: 'SUCCEEDED', attempt: 1 },
    ]);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'two_step_position_is_persisted_and_resumed_without_repeating_model_rounds', stepOp, [
      'prepare 在同一短事务持久化两步计划：Step 0 CAPTURE_CANDIDATE 成功、Step 1 APPLY_MANAGED_WRITE 待执行，Run 位置为 1/2；prepare 子进程自己的计数上报 model_rounds_this_process=1。',
      '两步之间以 exit 72 崩溃后，新进程从数据库读到的位置就是 Step 1，并在 stdout 事件里报道自己真实测得的 model_rounds_this_process=0。',
      '结果提交与 Step 推进在同一短事务，最终两步均为 SUCCEEDED、位置 2/2；模型轮次仍为一次，重复执行只跳过而不重跑。',
    ]));

    const completionBasisOp = `operation-${randomUUID()}`;
    const completionCommand = `command-complete-${randomUUID()}`;
    checkExit(await workerRun('completion_prepare', 'prepare', completionBasisOp), 0, 'completion prepare');
    checkExit(await workerRun('completion_approve', 'approve', completionBasisOp), 0, 'completion approve');
    checkExit(await workerRun('completion_execute', 'execute', completionBasisOp), 0, 'completion execute');
    assert.deepEqual(await runPosition(pool, completionBasisOp), { phase: 'RUNNING', next_step_index: 2, step_count: 2, lease_expired: false });
    checkExit(await workerRunWith('completion_rollback', { RECOVERY_INJECT_FAILURE: 'completion-rollback' }, 'complete', completionBasisOp, completionCommand), 76, 'injected failure inside the completion transaction');
    assert.deepEqual(await taskState(pool, completionBasisOp), {
      task_status: 'IN_PROGRESS',
      owner_run_id: `run-${completionBasisOp}`,
      state_revision: '0',
      ownership_epoch: '1',
      completion_basis: null,
    });
    assert.equal(await verificationCount(pool, completionBasisOp), 0);
    assert.equal(await businessCompletionCount(pool, completionBasisOp), 0);
    assert.equal(await stateDeltaCount(pool, completionBasisOp), 0);
    assert.deepEqual(await projectState(pool), { revision: '0', done_task_count: '0' });
    assert.equal(await commandReceiptRow(pool, completionCommand), undefined, 'a rolled-back completion must not leave a command receipt');
    assert.deepEqual(await operationState(pool, completionBasisOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    checkExit(await workerRun('completion_clean', 'complete', completionBasisOp, completionCommand), 0, 'clean business completion');
    assert.deepEqual(await taskState(pool, completionBasisOp), {
      task_status: 'DONE',
      owner_run_id: null,
      state_revision: '1',
      ownership_epoch: '2',
      completion_basis: 'AUTOMATED_VERIFICATION',
    });
    assert.deepEqual(await operationState(pool, completionBasisOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'COMPLETED', pause_reason: null, review: 'APPROVED' });
    assert.equal(await verificationCount(pool, completionBasisOp), 1);
    assert.equal(await businessCompletionCount(pool, completionBasisOp), 1);
    assert.equal(await stateDeltaCount(pool, completionBasisOp), 1);
    assert.deepEqual(await projectState(pool), { revision: '1', done_task_count: '1' });
    assert.notEqual(await commandReceiptRow(pool, completionCommand), undefined);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'business_completion_transaction_writes_pass_record_task_done_delta_and_receipt_atomically', completionBasisOp, [
      '完成事务内注入失败（exit 76）后整个短事务回滚：没有 PASS 记录、完成记录、State delta、命令回执，Task 仍为 IN_PROGRESS、state_revision 仍为 0，Run 仍为 RUNNING。',
      '重试只重做短事务：PASS 记录、CompletionRecord、Task DONE + completion_basis、state delta、命令回执与 Run COMPLETED 全部落在同一事务并一起可见。',
      'Project State 的 revision 与完成任务计数各增加一次，因此完成计数与协议提交计数可以分别核对。',
    ]));

    const replayCompletionOp = `operation-${randomUUID()}`;
    const replayCompletionCommand = `command-complete-${randomUUID()}`;
    checkExit(await workerRun('completion_crash_prepare', 'prepare', replayCompletionOp), 0, 'completion crash prepare');
    checkExit(await workerRun('completion_crash_approve', 'approve', replayCompletionOp), 0, 'completion crash approve');
    checkExit(await workerRun('completion_crash_execute', 'execute', replayCompletionOp), 0, 'completion crash execute');
    checkExit(await workerRun('completion_commit_crash', 'complete', replayCompletionOp, replayCompletionCommand, 'after-completion-commit'), 79, 'hard exit after the completion transaction committed');
    const receiptBeforeReplay = await commandReceiptRow(pool, replayCompletionCommand);
    assert.notEqual(receiptBeforeReplay, undefined, 'the receipt must already be committed before the hard exit');
    const taskAfterCompletionCrash = await taskState(pool, replayCompletionOp);
    const projectStateAfterCompletionCrash = await projectState(pool);
    assert.equal(await businessCompletionCount(pool, replayCompletionOp), 1);
    assert.deepEqual(taskAfterCompletionCrash.task_status, 'DONE');
    const replayAfterCommit = await workerRun('completion_replay', 'complete', replayCompletionOp, replayCompletionCommand);
    checkExit(replayAfterCommit, 0, 'replay the completion command after the hard exit');
    const replayEvent = childEvent(replayAfterCommit, 'command_receipt_replay');
    assert.equal(replayEvent?.same_payload, true);
    assert.equal(replayEvent?.completion_record_id, receiptBeforeReplay?.result.completionRecordId);
    assert.deepEqual(await commandReceiptRow(pool, replayCompletionCommand), receiptBeforeReplay, 'replay must return the original receipt unchanged');
    assert.equal(await businessCompletionCount(pool, replayCompletionOp), 1, 'a replayed command id must not create a second completion');
    assert.equal(await stateDeltaCount(pool, replayCompletionOp), 1);
    assert.deepEqual(await taskState(pool, replayCompletionOp), taskAfterCompletionCrash);
    assert.deepEqual(await projectState(pool), projectStateAfterCompletionCrash);
    const secondCommand = `command-complete-${randomUUID()}`;
    checkExit(await workerRun('completion_second_command_refused', 'complete', replayCompletionOp, secondCommand), 0, 'second command id on the completed task');
    assert.equal(await count(pool, replayCompletionOp, 'COMPLETION_REFUSED_TASK_ALREADY_DONE'), 1);
    assert.equal(await businessCompletionCount(pool, replayCompletionOp), 1);
    assert.equal(await commandReceiptRow(pool, secondCommand), undefined);
    checkExit(await workerRun('completion_late_reconcile', 'reconcile', replayCompletionOp), 0, 'late recovery path after completion');
    assert.deepEqual(await operationState(pool, replayCompletionOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'COMPLETED', pause_reason: null, review: 'APPROVED' });
    assert.equal(await count(pool, replayCompletionOp, 'TOOL_CALL'), 1);
    assert.equal(await businessCompletionCount(pool, replayCompletionOp), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'completion_commit_crash_replays_receipt_without_second_completion', replayCompletionOp, [
      '完成短事务提交后进程以 exit 79 退出；新进程读到的是已提交的完成记录、命令回执、Task DONE 和 Project State delta。',
      '相同 command_id 重放返回原回执（payload 相同、完成记录 ID 一致），完成记录、状态 delta 与 Project State revision 都不再增加。',
      '同一已完成 Task 上使用另一个 command_id 被拒绝且不写回执；迟到的恢复路径只观察到终态 SUCCEEDED，不重新调用工具。',
    ]));

    const conflictingCommandOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('conflicting_command_prepare', 'prepare', conflictingCommandOp), 0, 'conflicting command prepare');
    checkExit(await workerRun('conflicting_command_approve', 'approve', conflictingCommandOp), 0, 'conflicting command approve');
    checkExit(await workerRun('conflicting_command_execute', 'execute', conflictingCommandOp), 0, 'conflicting command execute');
    const conflictingCommandReplay = await workerRun('conflicting_command_reused_id', 'complete', conflictingCommandOp, replayCompletionCommand);
    checkExit(conflictingCommandReplay, 0, 'reuse the first operation command id for another operation');
    assert.equal(childEvent(conflictingCommandReplay, 'command_receipt_replay')?.same_payload, false, 'the same command id with different payload must be rejected');
    assert.equal(await count(pool, conflictingCommandOp, 'COMMAND_RECEIPT_PAYLOAD_CONFLICT_RETAINED'), 1);
    assert.equal(await businessCompletionCount(pool, conflictingCommandOp), 0);
    assert.equal((await taskState(pool, conflictingCommandOp)).task_status, 'IN_PROGRESS');
    assert.equal(await businessCompletionCount(pool, replayCompletionOp), 1, 'the original completion must stay untouched');
    const conflictingOwnCommand = `command-complete-${randomUUID()}`;
    checkExit(await workerRun('conflicting_command_own_id', 'complete', conflictingCommandOp, conflictingOwnCommand), 0, 'complete the second operation with its own command id');
    assert.equal(await businessCompletionCount(pool, conflictingCommandOp), 1);
    assert.equal((await taskState(pool, conflictingCommandOp)).task_status, 'DONE');

    const unknownCompletionOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('unknown_completion_prepare', 'prepare', unknownCompletionOp), 0, 'unknown completion prepare');
    checkExit(await workerRun('unknown_completion_approve', 'approve', unknownCompletionOp), 0, 'unknown completion approve');
    checkExit(await workerRun('unknown_completion_partial_write', 'execute', unknownCompletionOp, 'after-partial-write'), 75, 'unknown completion partial write');
    checkExit(await workerRun('unknown_completion_reconcile', 'reconcile', unknownCompletionOp), 0, 'unknown completion reconcile');
    assert.deepEqual(await operationState(pool, unknownCompletionOp), { operation: 'UNKNOWN', invocation: 'UNKNOWN', run_phase: 'PAUSED', pause_reason: 'INSUFFICIENT_EVIDENCE', review: 'APPROVED' });
    checkExit(await workerRun('unknown_completion_refused', 'complete', unknownCompletionOp, `command-complete-${randomUUID()}`), 0, 'completion attempt while an action is UNKNOWN');
    assert.equal(await count(pool, unknownCompletionOp, 'COMPLETION_REFUSED_UNRESOLVED_ACTION'), 1);
    assert.equal(await verificationCount(pool, unknownCompletionOp), 0);
    assert.equal(await businessCompletionCount(pool, unknownCompletionOp), 0);
    assert.equal((await taskState(pool, unknownCompletionOp)).task_status, 'IN_PROGRESS');
    assert.deepEqual(await claimStatuses(pool, unknownCompletionOp), ['QUARANTINED']);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'completion_refuses_conflicting_command_ids_and_unresolved_unknown_actions', unknownCompletionOp, [
      '同一个 command_id 用在不同操作上时 payload 不一致；该请求只保留冲突审计，既不改动原完成记录，也不完成新 Task、不写回执。',
      '使用自己的 command_id 完成第二个 Task 后，两个 Task 各有一次业务完成，命令回执与完成记录一一对应。',
      '存在 UNKNOWN 在途动作时完成用例拒绝提交：没有 PASS 记录、没有完成记录，Task 保持 IN_PROGRESS，资源 claim 保持 QUARANTINED。',
    ]));

    const pauseFirstOp = `operation-${randomUUID()}`;
    const pauseFirstCommand = `command-complete-${randomUUID()}`;
    const pauseRequestId = `pause-request-${pauseFirstOp}`;
    checkExit(await workerRun('control_pause_prepare', 'prepare', pauseFirstOp), 0, 'control pause prepare');
    checkExit(await workerRun('control_pause_approve', 'approve', pauseFirstOp), 0, 'control pause approve');
    checkExit(await workerRun('control_pause_execute', 'execute', pauseFirstOp), 0, 'control pause execute');
    const pauseFirstBarrier = join(runRoot, 'barriers', `control-pause-${randomUUID()}`);
    await mkdir(pauseFirstBarrier, { recursive: true });
    const pauseHolder = workerRunWithHandle('control_pause_lock_holder', {
      RECOVERY_APPLICATION_NAME: 'recovery_control_holder',
      RECOVERY_LOCK_BARRIER_DIR: pauseFirstBarrier,
      RECOVERY_LOCK_BARRIER_PHASE: 'control',
    }, 'control-apply', pauseFirstOp, 'PAUSE');
    await waitForBarrierFile(pauseFirstBarrier, `control-locked-${pauseFirstOp}`);
    assert.equal(await barrierReadyPid(pauseFirstBarrier, `control-locked-${pauseFirstOp}`), pauseHolder.child.pid, 'the barrier ready file must carry the holder process PID');
    assert.equal(childIsRunning(pauseHolder), true, 'the control holder must still be running while it holds the barrier');
    const pauseWaiter = workerRunWith('control_pause_completion_waiter', { RECOVERY_APPLICATION_NAME: 'recovery_completion_waiter' }, 'complete', pauseFirstOp, pauseFirstCommand);
    const pauseWait = await observeLockWaitFromHolder(pool, 'recovery_completion_waiter', 'recovery_control_holder');
    assert.equal(pauseWait.blocked, true, 'completion must wait on the control holder backend, not on any lock');
    await releaseBarrier(pauseFirstBarrier);
    checkExit(await pauseHolder.evidence, 0, 'control Pause holder');
    checkExit(await pauseWaiter, 0, 'completion that raced an applied Pause');
    assert.equal(childIsRunning(pauseHolder), false, 'the control holder handle must report the child as exited after the barrier release');
    assert.equal(await count(pool, pauseFirstOp, 'COMPLETION_REFUSED_RUN_NOT_RUNNING'), 1, 'completion must be refused after Pause was applied first');
    assert.equal(await businessCompletionCount(pool, pauseFirstOp), 0);
    assert.deepEqual(await controlRequestRow(pool, pauseRequestId), { status: 'APPLIED', type: 'PAUSE', result_ref: `run-${pauseFirstOp}` });
    assert.deepEqual(await operationState(pool, pauseFirstOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'PAUSED', pause_reason: 'CONTROL_REQUEST_PAUSE', review: 'APPROVED' });
    assert.equal((await taskState(pool, pauseFirstOp)).task_status, 'WAITING');
    assert.equal((await taskState(pool, pauseFirstOp)).ownership_epoch, '1', 'Pause keeps the AI execution right');
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'pause_applied_first_refuses_completion_and_keeps_execution_right', pauseFirstOp, [
      '第二子进程在完成提交前真实等待控制事务持有的 Task/Run 行锁：等待方在 pg_stat_activity 为 Lock，pg_blocking_pids 报告的阻塞者后端 PID 属于持锁 holder 的 application_name，因此不是任意锁。',
      'holder 由父进程的子进程句柄确认仍在运行（exitCode 为 null），其 PID 也写在 barrier ready 文件里；释放后句柄报告已退出。',
      '完成用例随后读到 PAUSED 与已应用的 Pause 请求，拒绝提交：没有完成记录，Task 为 WAITING，ownership epoch 不变。',
    ]));

    const cancelFirstOp = `operation-${randomUUID()}`;
    const cancelFirstCommand = `command-complete-${randomUUID()}`;
    checkExit(await workerRun('control_cancel_prepare', 'prepare', cancelFirstOp), 0, 'control cancel prepare');
    checkExit(await workerRun('control_cancel_approve', 'approve', cancelFirstOp), 0, 'control cancel approve');
    checkExit(await workerRun('control_cancel_execute', 'execute', cancelFirstOp), 0, 'control cancel execute');
    checkExit(await workerRun('control_cancel_applied', 'control-apply', cancelFirstOp, 'CANCEL'), 0, 'apply Cancel at a safe point');
    checkExit(await workerRun('control_cancel_completion_refused', 'complete', cancelFirstOp, cancelFirstCommand), 0, 'completion after Cancel was applied');
    assert.equal(await count(pool, cancelFirstOp, 'COMPLETION_REFUSED_CANCELLED_STATE'), 1);
    assert.equal(await businessCompletionCount(pool, cancelFirstOp), 0);
    assert.deepEqual(await controlRequestRow(pool, `cancel-request-${cancelFirstOp}`), { status: 'APPLIED', type: 'CANCEL', result_ref: `run-${cancelFirstOp}` });
    assert.deepEqual(await operationState(pool, cancelFirstOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'CANCELLED', pause_reason: null, review: 'APPROVED' });
    assert.deepEqual(await taskState(pool, cancelFirstOp), {
      task_status: 'READY',
      owner_run_id: null,
      state_revision: '0',
      ownership_epoch: '2',
      completion_basis: null,
    });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'cancel_applied_first_refuses_completion_and_releases_execution_right', cancelFirstOp, [
      'Cancel 在安全点入库：Run 为 CANCELLED、Task 回到 READY 且 ownership epoch 增加一次，资源与 Step 位置不被"完成"覆盖。',
      '之后到达的完成命令被拒绝且没有完成记录，Task 不会在取消后变为 DONE。',
    ]));

    const completionFirstOp = `operation-${randomUUID()}`;
    const completionFirstCommand = `command-complete-${randomUUID()}`;
    checkExit(await workerRun('completion_first_prepare', 'prepare', completionFirstOp), 0, 'completion first prepare');
    checkExit(await workerRun('completion_first_approve', 'approve', completionFirstOp), 0, 'completion first approve');
    checkExit(await workerRun('completion_first_execute', 'execute', completionFirstOp), 0, 'completion first execute');
    const completionFirstBarrier = join(runRoot, 'barriers', `completion-first-${randomUUID()}`);
    await mkdir(completionFirstBarrier, { recursive: true });
    const completionHolder = workerRunWithHandle('completion_first_lock_holder', {
      RECOVERY_APPLICATION_NAME: 'recovery_completion_holder',
      RECOVERY_LOCK_BARRIER_DIR: completionFirstBarrier,
      RECOVERY_LOCK_BARRIER_PHASE: 'completion',
    }, 'complete', completionFirstOp, completionFirstCommand);
    await waitForBarrierFile(completionFirstBarrier, `completion-locked-${completionFirstOp}`);
    assert.equal(await barrierReadyPid(completionFirstBarrier, `completion-locked-${completionFirstOp}`), completionHolder.child.pid, 'the barrier ready file must carry the completion holder process PID');
    assert.equal(childIsRunning(completionHolder), true, 'the completion holder must still be running while it holds the barrier');
    const controlWaiter = workerRunWith('completion_first_control_waiter', { RECOVERY_APPLICATION_NAME: 'recovery_control_waiter' }, 'control-apply', completionFirstOp, 'CANCEL');
    const controlWait = await observeLockWaitFromHolder(pool, 'recovery_control_waiter', 'recovery_completion_holder');
    assert.equal(controlWait.blocked, true, 'control must wait on the completion holder backend, not on any lock');
    await releaseBarrier(completionFirstBarrier);
    checkExit(await completionHolder.evidence, 0, 'completion holder');
    checkExit(await controlWaiter, 0, 'control that raced a committed completion');
    assert.equal(childIsRunning(completionHolder), false, 'the completion holder handle must report the child as exited after the barrier release');
    assert.equal(await count(pool, completionFirstOp, 'CONTROL_REJECTED_ALREADY_TERMINAL'), 1);
    assert.deepEqual(await controlRequestRow(pool, `cancel-request-${completionFirstOp}`), {
      status: 'REJECTED',
      type: 'CANCEL',
      result_ref: `completion-run-${completionFirstOp}`,
    });
    assert.deepEqual(await taskState(pool, completionFirstOp), {
      task_status: 'DONE',
      owner_run_id: null,
      state_revision: '1',
      ownership_epoch: '2',
      completion_basis: 'AUTOMATED_VERIFICATION',
    });
    assert.deepEqual(await operationState(pool, completionFirstOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'COMPLETED', pause_reason: null, review: 'APPROVED' });
    assert.equal(await businessCompletionCount(pool, completionFirstOp), 1);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'completion_committed_first_makes_late_control_act_on_the_new_state', completionFirstOp, [
      '完成事务先提交；后到的控制子进程等待同一 Task/Run 行锁，pg_blocking_pids 报告的阻塞者后端 PID 属于完成 holder 的 application_name，holder 子进程句柄同时确认仍在运行。',
      '控制请求被记录为 REJECTED 并引用原完成记录，不把已完成的 Task 退回 READY，也不产生第二次完成。',
    ]));

    const pendingGateOp = `operation-${randomUUID()}`;
    checkExit(await workerRun('pending_gate_prepare', 'prepare', pendingGateOp), 0, 'pending gate prepare');
    checkExit(await workerRun('pending_gate_approve', 'approve', pendingGateOp), 0, 'pending gate approve');
    checkExit(await workerRun('pending_gate_execute', 'execute', pendingGateOp), 0, 'pending gate execute');
    checkExit(await workerRun('pending_gate_request', 'control-request', pendingGateOp, 'PAUSE'), 0, 'persist a pending Pause request');
    assert.deepEqual(await controlRequestRow(pool, `pause-request-${pendingGateOp}`), { status: 'PENDING', type: 'PAUSE', result_ref: null });
    checkExit(await workerRun('pending_gate_completion_refused', 'complete', pendingGateOp, `command-complete-${randomUUID()}`), 0, 'completion while a control request is pending');
    assert.equal(await count(pool, pendingGateOp, 'COMPLETION_REFUSED_CONTROL_REQUEST_PENDING'), 1);
    assert.equal(await businessCompletionCount(pool, pendingGateOp), 0);
    assert.equal((await taskState(pool, pendingGateOp)).task_status, 'IN_PROGRESS');
    assert.deepEqual(await operationState(pool, pendingGateOp), { operation: 'SUCCEEDED', invocation: 'SUCCEEDED', run_phase: 'RUNNING', pause_reason: null, review: 'APPROVED' });
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'persisted_pending_control_request_blocks_completion_before_it_is_applied', pendingGateOp, [
      '控制意图先持久化为 PENDING；完成用例在执行前检查到未决请求即拒绝提交，不产生完成记录或状态 delta。',
      '请求尚未应用时 Run 保持 RUNNING、Task 保持 IN_PROGRESS，因此"已请求"与"已停止"在数据里可以区分。',
    ]));

    const leaseSharedKey = randomUUID();
    const leaseSharedResource = `shared-${leaseSharedKey}`;
    const leaseOldOp = `operation-${randomUUID()}`;
    const leaseNewOp = `operation-${randomUUID()}`;
    checkExit(await workerRunWith('lease_old_prepare', { RECOVERY_SHARED_TARGET_KEY: leaseSharedKey }, 'prepare', leaseOldOp), 0, 'lease old prepare');
    checkExit(await workerRun('lease_old_approve', 'approve', leaseOldOp), 0, 'lease old approve');
    const leaseBarrier = join(runRoot, 'barriers', `lease-live-${randomUUID()}`);
    await mkdir(leaseBarrier, { recursive: true });
    const leaseOldWorker = workerRunWithHandle('lease_old_live_writer', { RECOVERY_BARRIER_DIR: leaseBarrier }, 'execute', leaseOldOp, 'hold-after-dispatch');
    await waitForBarrierFile(leaseBarrier, `ready-${leaseOldOp}`);
    const leaseOldInvocation = await currentDispatchInvocation(pool, leaseOldOp);
    /*
     * Liveness is judged from the parent-held handle of this exact child, not
     * from a PID probe: `exitCode === null` cannot be satisfied by an unrelated
     * process that reused the PID. The barrier ready file and the persisted
     * dispatch_worker_pid are recorded as auxiliary correlation evidence.
     */
    assert.equal(childIsRunning(leaseOldWorker), true, 'the old writer child handle must report it as still running');
    assert.equal(leaseOldWorker.child.pid, leaseOldInvocation.dispatch_worker_pid, 'the handle PID must match the persisted dispatch worker PID');
    assert.equal(await barrierReadyPid(leaseBarrier, `ready-${leaseOldOp}`), leaseOldInvocation.dispatch_worker_pid, 'the barrier ready file must carry the same writer PID');
    assert.equal(processAlive(leaseOldInvocation.dispatch_worker_pid), true, 'auxiliary PID probe agrees the writer PID is occupied');
    assert.deepEqual(await claimStatuses(pool, leaseOldOp), ['HELD']);
    checkExit(await workerRun('lease_expired', 'expire-lease', leaseOldOp), 0, 'force the persisted lease to expire');
    assert.equal((await runPosition(pool, leaseOldOp)).lease_expired, true);
    assert.deepEqual(await claimStatuses(pool, leaseOldOp), ['HELD'], 'an expired lease alone must not release the claim');
    checkExit(await workerRunWith('lease_new_prepare', { RECOVERY_SHARED_TARGET_KEY: leaseSharedKey }, 'prepare', leaseNewOp), 0, 'lease new prepare');
    checkExit(await workerRun('lease_new_approve', 'approve', leaseNewOp), 0, 'lease new approve');
    checkExit(await workerRun('lease_new_execute_refused', 'execute', leaseNewOp), 0, 'lease new execute refused');
    assert.deepEqual(await operationState(pool, leaseNewOp), { operation: 'PREPARED', invocation: null, run_phase: 'WAITING_APPROVAL', pause_reason: null, review: 'APPROVED' });
    assert.equal(await scalar(pool, 'select count(*)::int as count from invocations where operation_id = $1', [leaseNewOp]), 0, 'the refused execution must not create an Invocation');
    assert.equal(await count(pool, leaseNewOp, 'RESOURCE_CLAIM_UNAVAILABLE'), 1);
    assert.equal(await count(pool, leaseNewOp, 'TOOL_CALL'), 0);
    assert.deepEqual(await claimStatuses(pool, leaseNewOp), []);
    assert.equal(await effectCount(recoveryRoot, leaseNewOp), 0);
    assert.equal(childIsRunning(leaseOldWorker), true, 'the old writer handle must still report it as running when the conflicting claim is refused');
    await releaseBarrier(leaseBarrier);
    checkExit(await leaseOldWorker.evidence, 0, 'old writer resumes after the rejected conflicting claim');
    assert.equal(childIsRunning(leaseOldWorker), false, 'the old writer handle must report the child as exited after the barrier release');
    assert.equal(await artifactMatchesExpectedNow(recoveryRoot, leaseOldOp, leaseSharedResource), true);
    assert.deepEqual(await claimStatuses(pool, leaseOldOp), ['RELEASED']);
    scenarios.push(await scenarioCounts(pool, recoveryRoot, 'expired_claim_lease_with_live_old_writer_refuses_conflicting_resource_claim', leaseNewOp, [
      '旧 Worker 子进程由 barrier 保持真实存活：判据是父进程持有的该子进程句柄（exitCode 为 null、未被 kill），PID 探测、barrier ready 文件里的 PID 与持久化 dispatch_worker_pid 三者一致，仅作辅助关联。',
      'lease 过期只改变可核对字段：claim 仍为 HELD，另一 Task 在同一隔离资源上的准入仍被拒绝，没有 Invocation、TOOL_CALL 或文件写入。',
      '释放 barrier 后旧 Worker 句柄报告退出、正常提交自己的结果并释放 claim，说明拒绝冲突领取不是以时间假设而是以真实存活进程为证据。',
    ], 0, leaseSharedResource));

    const b01Task = `task-b01-${randomUUID()}`;
    const b01RunA = `run-b01-a-${randomUUID()}`;
    const b01RunB = `run-b01-b-${randomUUID()}`;
    checkExit(await controlRun('b01_create_task', { CONTROL_APPLICATION_NAME: 'control_b01_create' }, 'create-task', b01Task), 0, 'B01 create task');
    const b01Barrier = join(runRoot, 'barriers', `b01-${randomUUID()}`);
    await mkdir(b01Barrier, { recursive: true });
    const b01First = controlRun('b01_delegate_first', { CONTROL_APPLICATION_NAME: 'control_b01_delegate_first', CONTROL_BARRIER_DIR: b01Barrier }, 'delegate', b01Task, b01RunA);
    await waitForBarrierFile(b01Barrier, `locked-${b01RunA}`);
    const b01Second = controlRun('b01_delegate_second', { CONTROL_APPLICATION_NAME: 'control_b01_delegate_second' }, 'delegate', b01Task, b01RunB);
    const b01Wait = await observeLockWaitFromHolder(pool, 'control_b01_delegate_second', 'control_b01_delegate_first');
    assert.equal(b01Wait.blocked, true, 'second Delegate must wait on the first Delegate backend, not on any lock');
    await releaseBarrier(b01Barrier);
    checkExit(await b01First, 0, 'B01 first Delegate');
    checkExit(await b01Second, 0, 'B01 second Delegate');
    const b01State = await pool.query<{ owner_run_id: string | null; run_count: number }>(
      `select t.owner_run_id, (select count(*)::int from control_runs where task_id = t.id) as run_count
       from control_tasks t where t.id = $1`,
      [b01Task],
    );
    assert.deepEqual(b01State.rows[0], { owner_run_id: b01RunA, run_count: 1 });
    scenarios.push(controlScenario('b01_concurrent_delegate_has_one_owner_with_observed_lock_wait', b01Task, [
      '两个独立 Node 子进程通过 barrier 竞争同一真实 PostgreSQL Task 行；第二个进程在 pg_stat_activity 中观察到 Lock 等待。',
      '提交后只有第一个 Run 获得 AI 执行权并入库，Task 只有一个 owner。',
    ]));

    const b03Task = `task-b03-${randomUUID()}`;
    const b03Run = `run-b03-${randomUUID()}`;
    const b03Scope = `scope-b03-${randomUUID()}`;
    checkExit(await controlRun('b03_create_active', { CONTROL_APPLICATION_NAME: 'control_b03_create' }, 'create-active', b03Task, b03Run, b03Scope), 0, 'B03 create active run');
    checkExit(await controlRun('b03_pause', { CONTROL_APPLICATION_NAME: 'control_b03_pause' }, 'pause', b03Task, b03Run), 0, 'B03 persist Pause');
    checkExit(await controlRun('b03_restart_claim', { CONTROL_APPLICATION_NAME: 'control_b03_restart' }, 'claim-next', b03Task, b03Run), 0, 'B03 fresh process claim');
    const b03State = await pool.query<{ claim_epoch: string; control_request: string | null; status: string }>('select status, control_request, claim_epoch::text from control_runs where id = $1', [b03Run]);
    assert.deepEqual(b03State.rows[0], { status: 'PAUSED', control_request: 'PAUSE_APPLIED', claim_epoch: '1' });
    scenarios.push(controlScenario('b03_persisted_pause_blocks_fresh_process_claim', b03Run, [
      'Pause 先在短事务持久化；随后独立子进程重新尝试领取。',
      'Run 保持 PAUSED，claim epoch 未增加，说明刷新/重启后不会继续领取下一步。',
    ]));

    const b04CompleteTask = `task-b04-complete-${randomUUID()}`;
    const b04CompleteRun = `run-b04-complete-${randomUUID()}`;
    const b04CompleteScope = `scope-b04-complete-${randomUUID()}`;
    checkExit(await controlRun('b04_complete_create', { CONTROL_APPLICATION_NAME: 'control_b04_complete_create' }, 'create-active', b04CompleteTask, b04CompleteRun, b04CompleteScope), 0, 'B04 complete-first setup');
    const b04CompleteBarrier = join(runRoot, 'barriers', `b04-complete-${randomUUID()}`);
    await mkdir(b04CompleteBarrier, { recursive: true });
    const completeFirst = controlRun('b04_finish_first', { CONTROL_APPLICATION_NAME: 'control_b04_finish_first', CONTROL_BARRIER_DIR: b04CompleteBarrier }, 'finish', b04CompleteTask, b04CompleteRun);
    await waitForBarrierFile(b04CompleteBarrier, `locked-${b04CompleteRun}`);
    const cancelSecond = controlRun('b04_cancel_second', { CONTROL_APPLICATION_NAME: 'control_b04_cancel_second' }, 'cancel', b04CompleteTask, b04CompleteRun);
    const b04CompleteWait = await observeLockWaitFromHolder(pool, 'control_b04_cancel_second', 'control_b04_finish_first');
    assert.equal(b04CompleteWait.blocked, true, 'Cancel must wait for the completion transaction backend, not on any lock');
    await releaseBarrier(b04CompleteBarrier);
    checkExit(await completeFirst, 0, 'B04 completion first');
    checkExit(await cancelSecond, 0, 'B04 cancel second');
    const b04CompleteState = await pool.query<{ task_status: string; status: string }>('select t.task_status, r.status from control_tasks t join control_runs r on r.task_id = t.id where t.id = $1', [b04CompleteTask]);
    assert.deepEqual(b04CompleteState.rows[0], { task_status: 'DONE', status: 'COMPLETED' });

    const b04CancelTask = `task-b04-cancel-${randomUUID()}`;
    const b04CancelRun = `run-b04-cancel-${randomUUID()}`;
    const b04CancelScope = `scope-b04-cancel-${randomUUID()}`;
    checkExit(await controlRun('b04_cancel_create', { CONTROL_APPLICATION_NAME: 'control_b04_cancel_create' }, 'create-active', b04CancelTask, b04CancelRun, b04CancelScope), 0, 'B04 cancel-first setup');
    const b04CancelBarrier = join(runRoot, 'barriers', `b04-cancel-${randomUUID()}`);
    await mkdir(b04CancelBarrier, { recursive: true });
    const cancelFirst = controlRun('b04_cancel_first', { CONTROL_APPLICATION_NAME: 'control_b04_cancel_first', CONTROL_BARRIER_DIR: b04CancelBarrier }, 'cancel', b04CancelTask, b04CancelRun);
    await waitForBarrierFile(b04CancelBarrier, `locked-${b04CancelRun}`);
    const finishSecond = controlRun('b04_finish_second', { CONTROL_APPLICATION_NAME: 'control_b04_finish_second' }, 'finish', b04CancelTask, b04CancelRun);
    const b04CancelWait = await observeLockWaitFromHolder(pool, 'control_b04_finish_second', 'control_b04_cancel_first');
    assert.equal(b04CancelWait.blocked, true, 'completion must wait for the Cancel transaction backend, not on any lock');
    await releaseBarrier(b04CancelBarrier);
    checkExit(await cancelFirst, 0, 'B04 cancel first');
    checkExit(await finishSecond, 0, 'B04 completion second');
    const b04CancelState = await pool.query<{ task_status: string; status: string }>('select t.task_status, r.status from control_tasks t join control_runs r on r.task_id = t.id where t.id = $1', [b04CancelTask]);
    assert.deepEqual(b04CancelState.rows[0], { task_status: 'READY', status: 'CANCELLED' });
    scenarios.push(controlScenario('b04_completion_and_cancel_have_two_deterministic_transaction_orders', b04CompleteRun, [
      'finish-first：Cancel 在真实行锁后读取 COMPLETED，最终只有 DONE/COMPLETED。',
      'cancel-first：完成用例在真实行锁后读取 CANCELLED，最终只有 READY/CANCELLED。两种顺序均由 barrier 和 pg_stat_activity Lock 等待确定。',
    ]));

    const b05Task = `task-b05-${randomUUID()}`;
    const b05Run = `run-b05-${randomUUID()}`;
    const b05Scope = `scope-b05-${randomUUID()}`;
    checkExit(await controlRun('b05_create_active', { CONTROL_APPLICATION_NAME: 'control_b05_create' }, 'create-active', b05Task, b05Run, b05Scope), 0, 'B05 create active write');
    checkExit(await controlRun('b05_handoff_request', { CONTROL_APPLICATION_NAME: 'control_b05_request' }, 'handoff-request', b05Task, b05Run, b05Scope), 0, 'B05 persist handoff request');
    checkExit(await controlRun('b05_handoff_dispatching_refused', { CONTROL_APPLICATION_NAME: 'control_b05_refuse_dispatching' }, 'handoff-finalize', b05Task, b05Run, b05Scope), 0, 'B05 refuse handoff while dispatching');
    checkExit(await controlRun('b05_mark_unknown_stopped', { CONTROL_APPLICATION_NAME: 'control_b05_unknown' }, 'mark-unknown-stopped', b05Run), 0, 'B05 mark old writer stopped');
    checkExit(await controlRun('b05_handoff_unknown_refused', { CONTROL_APPLICATION_NAME: 'control_b05_refuse_unknown' }, 'handoff-finalize', b05Task, b05Run, b05Scope), 0, 'B05 refuse unknown handoff');
    const b05Held = await pool.query<{ owner_run_id: string | null; status: string }>('select t.owner_run_id, r.status from control_tasks t join control_runs r on r.task_id = t.id where t.id = $1', [b05Task]);
    assert.deepEqual(b05Held.rows[0], { owner_run_id: b05Run, status: 'RUNNING' });
    checkExit(await controlRun('b05_conflicting_claim_refused', { CONTROL_APPLICATION_NAME: 'control_b05_conflict' }, 'resource-claim', b05Scope, `task-b05-conflict-${randomUUID()}`, `run-b05-conflict-${randomUUID()}`), 0, 'B05 conflicting resource claim');
    const b05ResourceHeld = await pool.query<{ status: string }>('select status from control_resources where scope = $1', [b05Scope]);
    assert.deepEqual(b05ResourceHeld.rows[0], { status: 'QUARANTINED' });
    checkExit(await controlRun('b05_independent_reconcile', { CONTROL_APPLICATION_NAME: 'control_b05_reconcile' }, 'resolve-unknown', b05Run), 0, 'B05 independent controlled reconciliation');
    checkExit(await controlRun('b05_handoff_after_reconcile', { CONTROL_APPLICATION_NAME: 'control_b05_finalize' }, 'handoff-finalize', b05Task, b05Run, b05Scope), 0, 'B05 finalize handoff after reconciliation');
    const b05Final = await pool.query<{ owner_run_id: string | null; resource_status: string; task_status: string }>(
      'select t.owner_run_id, t.task_status, r.status as resource_status from control_tasks t join control_resources r on r.scope = $2 where t.id = $1',
      [b05Task, b05Scope],
    );
    assert.deepEqual(b05Final.rows[0], { owner_run_id: null, task_status: 'IN_PROGRESS', resource_status: 'RELEASED' });
    scenarios.push(controlScenario('b05_handoff_quarantines_unknown_resource_until_independent_reconciliation', b05Run, [
      '在途写动作时 Handoff 只持久化请求并将资源置为 QUARANTINED；DISPATCHING 和 UNKNOWN+旧进程已停两种状态都拒绝转交。',
      '冲突 Task 不能领取隔离资源；只有实验内显式的独立核对事件确认未发生后才释放资源并把接手编辑 Task 保持为 IN_PROGRESS。',
      '该控制 harness 不含真实 Adapter，独立核对事件不是生产 UNKNOWN 处置证明。',
    ]));

    const d07Task = `task-d07-${randomUUID()}`;
    const d07Run = `run-d07-${randomUUID()}`;
    const d07Scope = `scope-d07-${randomUUID()}`;
    checkExit(await controlRun('d07_create_active', { CONTROL_APPLICATION_NAME: 'control_d07_create' }, 'create-active', d07Task, d07Run, d07Scope), 0, 'D07 create active writer');
    checkExit(await controlRun('d07_expire_lease', { CONTROL_APPLICATION_NAME: 'control_d07_expire' }, 'expire-lease', d07Run), 0, 'D07 expire lease');
    const d07Barrier = join(runRoot, 'barriers', `d07-${randomUUID()}`);
    await mkdir(d07Barrier, { recursive: true });
    const oldWriter = controlRun('d07_old_writer_live', { CONTROL_APPLICATION_NAME: 'control_d07_old_writer', CONTROL_BARRIER_DIR: d07Barrier }, 'hold-old-writer', d07Run);
    await waitForBarrierFile(d07Barrier, `old-writer-${d07Run}`);
    checkExit(await controlRun('d07_conflicting_claim', { CONTROL_APPLICATION_NAME: 'control_d07_conflict' }, 'resource-claim', d07Scope, `task-d07-conflict-${randomUUID()}`, `run-d07-conflict-${randomUUID()}`), 0, 'D07 refuse conflicting resource');
    const d07State = await pool.query<{ lease_expired: boolean; status: string }>(
      "select r.lease_expires_at < now() as lease_expired, c.status from control_runs r join control_resources c on c.run_id = r.id where r.id = $1",
      [d07Run],
    );
    assert.deepEqual(d07State.rows[0], { lease_expired: true, status: 'HELD' });
    await releaseBarrier(d07Barrier);
    checkExit(await oldWriter, 0, 'D07 old writer exits');
    scenarios.push(controlScenario('d07_expired_lease_with_live_old_process_keeps_conflicting_resource_isolated', d07Run, [
      '租约被明确设为过期后，旧 Worker 子进程仍由 barrier 保持存活。',
      '另一 Task 的资源领取被拒绝，资源维持 HELD；租约过期不被当作旧进程已经停止或可并发写的证据。',
    ]));

    const epochTask = `task-epoch-${randomUUID()}`;
    const epochRun = `run-epoch-${randomUUID()}`;
    const epochScope = `scope-epoch-${randomUUID()}`;
    checkExit(await controlRun('epoch_create_active', { CONTROL_APPLICATION_NAME: 'control_epoch_create' }, 'create-active', epochTask, epochRun, epochScope), 0, 'claim epoch setup');
    checkExit(await controlRun('epoch_reclaim', { CONTROL_APPLICATION_NAME: 'control_epoch_reclaim' }, 'reclaim', epochRun), 0, 'claim epoch reclaim');
    checkExit(await controlRun('epoch_old_result', { CONTROL_APPLICATION_NAME: 'control_epoch_old_result' }, 'record-result', epochTask, epochRun, '1', '1'), 0, 'old claim result');
    const staleAction = await pool.query<{ status: string; retained: number }>(
      `select a.status, (select count(*)::int from control_events where subject_id = $1 and event_type = 'STALE_CLAIM_OR_OWNERSHIP_EVIDENCE_RETAINED') as retained
       from control_actions a where a.run_id = $1`,
      [epochRun],
    );
    assert.deepEqual(staleAction.rows[0], { status: 'DISPATCHING', retained: 1 });
    checkExit(await controlRun('epoch_current_result', { CONTROL_APPLICATION_NAME: 'control_epoch_current_result' }, 'record-result', epochTask, epochRun, '1', '2'), 0, 'current claim result');
    const currentAction = await pool.query<{ status: string }>('select status from control_actions where run_id = $1', [epochRun]);
    assert.deepEqual(currentAction.rows[0], { status: 'SUCCEEDED' });
    checkExit(await controlRun('epoch_repeated_result_rejected', { CONTROL_APPLICATION_NAME: 'control_epoch_repeated_result' }, 'record-result', epochTask, epochRun, '1', '2'), 0, 'repeat result after success');
    const repeatedAction = await pool.query<{ rejected: number; status: string }>(
      `select a.status, (select count(*)::int from control_events where subject_id = $1 and event_type = 'RESULT_NOT_COMMITTED_ACTION_NOT_DISPATCHING') as rejected
       from control_actions a where a.run_id = $1`,
      [epochRun],
    );
    assert.deepEqual(repeatedAction.rows[0], { status: 'SUCCEEDED', rejected: 1 });

    const unknownResultTask = `task-unknown-result-${randomUUID()}`;
    const unknownResultRun = `run-unknown-result-${randomUUID()}`;
    const unknownResultScope = `scope-unknown-result-${randomUUID()}`;
    checkExit(await controlRun('unknown_result_create_active', { CONTROL_APPLICATION_NAME: 'control_unknown_result_create' }, 'create-active', unknownResultTask, unknownResultRun, unknownResultScope), 0, 'unknown result setup');
    checkExit(await controlRun('unknown_result_mark_unknown', { CONTROL_APPLICATION_NAME: 'control_unknown_result_mark' }, 'mark-unknown-stopped', unknownResultRun), 0, 'unknown result mark unknown');
    checkExit(await controlRun('unknown_result_rejected', { CONTROL_APPLICATION_NAME: 'control_unknown_result_reject' }, 'record-result', unknownResultTask, unknownResultRun, '1', '1'), 0, 'unknown action result rejection');
    const unknownAction = await pool.query<{ rejected: number; status: string }>(
      `select a.status, (select count(*)::int from control_events where subject_id = $1 and event_type = 'RESULT_NOT_COMMITTED_ACTION_NOT_DISPATCHING') as rejected
       from control_actions a where a.run_id = $1`,
      [unknownResultRun],
    );
    assert.deepEqual(unknownAction.rows[0], { status: 'UNKNOWN', rejected: 1 });
    scenarios.push(controlScenario('claim_epoch_is_distinct_from_task_ownership_epoch_and_result_requires_dispatching_action', epochRun, [
      'Task ownership epoch 保持 1，Worker 重新领取后 claim epoch 从 1 增至 2。',
      '旧 claim 的结果被保留为核对证据但不提交；当前 claim 的同一 ownership epoch 结果只在 action 仍为 DISPATCHING 时被接受。',
      '同一结果重复提交和 action 已为 UNKNOWN 的当前 claim 都返回未接受，并保留 action 状态和拒绝事件。',
    ]));
  } catch (error) {
    failure = error;
  } finally {
    if (pool !== undefined) {
      await pool.end().catch(() => undefined);
    }
    if (postgresStarted || existsSync(join(dataDirectory, 'postmaster.pid'))) {
      const stop = await runProcess('pg_ctl_stop', pgCtl, ['stop', '-D', dataDirectory, '-m', 'immediate', '-w', '-t', '30'], process.env, false).catch((error: unknown) => ({
        name: 'pg_ctl_stop', args: ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop'], pid: undefined, exit_code: null, signal: null, duration_ms: 0, stdout: '', stderr: error instanceof Error ? error.message : String(error), timed_out: false,
      }));
      processEvidence.push(stop);
      if (stop.exit_code !== 0 && failure === undefined) {
        failure = new Error(`pg_ctl stop failed: ${stop.stderr}`);
      }
    }
  }

  const report: Report = {
    run_id: runId,
    status: failure === undefined ? 'PASSED' : 'FAILED',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: { node: process.versions.node, postgres: postgresVersion },
    input_sha256: inputSha,
    process_evidence: processEvidence,
    scenarios,
    ...(failure === undefined
      ? {}
      : {
          failure: {
            message: failure instanceof Error ? failure.message : String(failure),
            scenarios_completed: scenarios.length,
          },
        }),
    assertions: failure === undefined ? [
      '实验使用独立 initdb 数据目录、动态 127.0.0.1 端口和实际 PostgreSQL 18 子进程。',
      '所有模型候选由实际 ai@7.0.107 的官方 MockLanguageModelV4 和无 execute 的工具定义产生。',
      `本次报告包含 ${scenarios.filter((entry) => entry.harness === 'main-worker').length} 个主恢复 Worker 场景和 ${scenarios.filter((entry) => entry.harness === 'control-worker').length} 个独立 control-worker 场景；两者共享临时 PostgreSQL，但不是一个生产协议实现。`,
      '模型调用、工具调用、外部效果写入观测、协议提交和业务完成分别计数；业务完成只按 completion_records 统计，协议提交数不冒充业务完成数。',
      '并发场景用子进程 barrier 加 pg_stat_activity Lock 等待证明；崩溃场景使用真实子进程退出码 72/73/74/75/76/77/79，不以抛异常代替。',
      '每次运行先写 RUNNING 结果；失败时 latest.json 写 FAILED，不继承旧 PASS。',
    ] : [],
    limitations: [
      '这是 P00 最小恢复实验，不是生产 Workflow、Gateway、权限系统或文件适配器。',
      '官方 MockLanguageModelV4 仅验证 AI SDK 协议边界；没有真实 Provider 网络调用或 Provider 可替换性证明。',
      '主恢复 Worker 已覆盖调用前崩溃、绑定当前 invocation/effect/PID/exit 74 收据后的受控安全重试、旧收据重放拒绝、存活旧 PID 的负向拒绝、部分写入转 UNKNOWN、实验用两步位置推进、联合准入/结果短事务、业务完成短事务与命令回执。它仍然只使用实验专用表和一个受控单文件 Adapter，没有接入生产 Gateway、权限判定或多产物版本存储。',
      '业务完成事务覆盖单动作两步固定计划：PASS 记录由确定性检查器写入，没有 Hard/Rule/Semantic 分类验证器、真实人工 Review 审批链、多产物集合或部分失败重试验证。',
      '控制请求与完成的两种顺序在主动作 Worker 的实验表上验证，Pause/Cancel 语义是实验简化版；control-worker 的场景仍是独立状态替身，其 UNKNOWN 结果核对是显式注入，不代表完整 B05 或 Spike 2 通过。',
      '仍未实现生产资源-动作联合协议、Gateway/权限系统或真实外部文件 Adapter。单一受控外部效果后的 PostgreSQL 重启恢复已单列验证，不能推广为完整业务恢复。',
      '未覆盖四份契约的 37 个验收场景；结果只映射到本实验的局部恢复裂缝。',
      '效果证据是实验专用 JSONL 和单文件 fixture，未验证生产文件系统、审计存储或人工核对流程。',
    ],
  };
  await writeReport(reportPath, report);
  await writeReport(latestPath, report);
  assertOwnedPath(runRoot, localRoot);
  await rm(runRoot, { recursive: true, force: true });
  if (failure !== undefined) {
    throw failure;
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, run_id: runId, result: reportPath })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
