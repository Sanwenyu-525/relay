import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { Client } from 'pg';

type Command =
  | 'setup'
  | 'create-task'
  | 'delegate'
  | 'create-active'
  | 'pause'
  | 'claim-next'
  | 'finish'
  | 'cancel'
  | 'handoff-request'
  | 'mark-unknown-stopped'
  | 'resolve-unknown'
  | 'handoff-finalize'
  | 'expire-lease'
  | 'hold-old-writer'
  | 'resource-claim'
  | 'reclaim'
  | 'record-result';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function safeId(value: string, label: string): string {
  if (!/^[a-z0-9-]{1,80}$/u.test(value)) throw new Error(`${label} must be a safe test identifier`);
  return value;
}

function print(event: string, payload: Record<string, boolean | number | string>): void {
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...payload })}\n`);
}

async function connect(): Promise<Client> {
  const client = new Client({
    connectionString: required('RECOVERY_DATABASE_URL'),
    application_name: process.env.CONTROL_APPLICATION_NAME,
  });
  await client.connect();
  return client;
}

async function transaction<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function event(client: Client, subjectId: string, type: string, payload: Record<string, boolean | number | string>): Promise<void> {
  await client.query(
    'insert into control_events(subject_id, event_type, payload) values ($1, $2, $3::jsonb)',
    [subjectId, type, JSON.stringify(payload)],
  );
}

function barrierDirectory(): string | undefined {
  return process.env.CONTROL_BARRIER_DIR;
}

async function markBarrier(name: string): Promise<void> {
  const directory = barrierDirectory();
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}\\${name}`, '', { flag: 'wx' });
}

async function waitForRelease(): Promise<void> {
  const directory = barrierDirectory();
  if (directory === undefined) return;
  const release = `${directory}\\release`;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (existsSync(release)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('barrier release was not received within 30 seconds');
}

async function setup(): Promise<void> {
  const client = await connect();
  try {
    await client.query(`
      create table if not exists control_tasks (
        id text primary key,
        owner_run_id text,
        ownership_epoch bigint not null check (ownership_epoch >= 0),
        task_status text not null check (task_status in ('READY', 'IN_PROGRESS', 'DONE'))
      );
      create table if not exists control_runs (
        id text primary key,
        task_id text not null references control_tasks(id),
        status text not null check (status in ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED')),
        ownership_epoch bigint not null,
        claim_epoch bigint not null check (claim_epoch >= 0),
        lease_expires_at timestamptz not null,
        control_request text
      );
      create table if not exists control_resources (
        scope text primary key,
        task_id text not null,
        run_id text not null,
        claim_epoch bigint not null,
        status text not null check (status in ('HELD', 'QUARANTINED', 'RELEASED'))
      );
      create table if not exists control_actions (
        id text primary key,
        run_id text not null unique references control_runs(id),
        status text not null check (status in ('DISPATCHING', 'UNKNOWN', 'RECONCILED_NOT_STARTED', 'SUCCEEDED')),
        old_writer_stopped boolean not null default false
      );
      create table if not exists control_events (
        id bigint generated always as identity primary key,
        subject_id text not null,
        event_type text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
    `);
    print('control_setup_complete', {});
  } finally {
    await client.end();
  }
}

async function createTask(taskId: string): Promise<void> {
  const client = await connect();
  try {
    await client.query(
      "insert into control_tasks(id, owner_run_id, ownership_epoch, task_status) values ($1, null, 0, 'READY')",
      [safeId(taskId, 'task id')],
    );
    print('control_task_created', { task_id: taskId });
  } finally {
    await client.end();
  }
}

async function delegate(taskId: string, runId: string): Promise<void> {
  const client = await connect();
  try {
    const accepted = await transaction(client, async () => {
      const task = await client.query<{ owner_run_id: string | null; ownership_epoch: string }>(
        'select owner_run_id, ownership_epoch::text from control_tasks where id = $1 for update',
        [taskId],
      );
      const current = task.rows[0];
      if (current === undefined) throw new Error('control task does not exist');
      await markBarrier(`locked-${runId}`);
      await waitForRelease();
      if (current.owner_run_id !== null) return false;
      const ownershipEpoch = BigInt(current.ownership_epoch) + 1n;
      await client.query(
        "update control_tasks set owner_run_id = $2, ownership_epoch = $3, task_status = 'IN_PROGRESS' where id = $1",
        [taskId, runId, ownershipEpoch.toString()],
      );
      await client.query(
        "insert into control_runs(id, task_id, status, ownership_epoch, claim_epoch, lease_expires_at) values ($1, $2, 'RUNNING', $3, 1, now() + interval '5 minutes')",
        [runId, taskId, ownershipEpoch.toString()],
      );
      await event(client, taskId, 'DELEGATE_GRANTED', { runId, ownershipEpoch: ownershipEpoch.toString() });
      return true;
    });
    print('delegate_result', { task_id: taskId, run_id: runId, accepted });
  } finally {
    await client.end();
  }
}

async function createActive(taskId: string, runId: string, scope: string): Promise<void> {
  const client = await connect();
  try {
    await transaction(client, async () => {
      await client.query(
        "insert into control_tasks(id, owner_run_id, ownership_epoch, task_status) values ($1, $2, 1, 'IN_PROGRESS')",
        [taskId, runId],
      );
      await client.query(
        "insert into control_runs(id, task_id, status, ownership_epoch, claim_epoch, lease_expires_at) values ($1, $2, 'RUNNING', 1, 1, now() + interval '5 minutes')",
        [runId, taskId],
      );
      await client.query(
        "insert into control_resources(scope, task_id, run_id, claim_epoch, status) values ($1, $2, $3, 1, 'HELD')",
        [scope, taskId, runId],
      );
      await client.query(
        "insert into control_actions(id, run_id, status) values ($1, $2, 'DISPATCHING')",
        [`action-${runId}`, runId],
      );
      await event(client, runId, 'ACTIVE_RUN_CREATED', { scope });
    });
    print('active_run_created', { task_id: taskId, run_id: runId, scope });
  } finally {
    await client.end();
  }
}

async function pause(taskId: string, runId: string): Promise<void> {
  const client = await connect();
  try {
    await transaction(client, async () => {
      await client.query("update control_runs set control_request = 'PAUSE_APPLIED', status = 'PAUSED' where id = $1 and task_id = $2", [runId, taskId]);
      await event(client, runId, 'PAUSE_PERSISTED', {});
    });
    print('pause_result', { task_id: taskId, run_id: runId });
  } finally {
    await client.end();
  }
}

async function claimNext(taskId: string, runId: string): Promise<void> {
  const client = await connect();
  try {
    const claimed = await transaction(client, async () => {
      const result = await client.query(
        "update control_runs set claim_epoch = claim_epoch + 1 where id = $1 and task_id = $2 and status = 'RUNNING' and control_request is null returning claim_epoch::text as claim_epoch",
        [runId, taskId],
      );
      return (result.rowCount ?? 0) === 1;
    });
    print('claim_next_result', { task_id: taskId, run_id: runId, claimed });
  } finally {
    await client.end();
  }
}

async function lockRun(client: Client, taskId: string, runId: string): Promise<{ status: string; ownerRunId: string | null } | undefined> {
  const row = await client.query<{ status: string; ownerRunId: string | null }>(
    `select r.status, t.owner_run_id as "ownerRunId"
     from control_runs r join control_tasks t on t.id = r.task_id
     where r.id = $1 and r.task_id = $2 for update of r, t`,
    [runId, taskId],
  );
  return row.rows[0];
}

async function finish(taskId: string, runId: string): Promise<void> {
  const client = await connect();
  try {
    const completed = await transaction(client, async () => {
      const row = await lockRun(client, taskId, runId);
      if (row === undefined) throw new Error('control run does not exist');
      await markBarrier(`locked-${runId}`);
      await waitForRelease();
      if (row.status !== 'RUNNING' || row.ownerRunId !== runId) return false;
      await client.query("update control_runs set status = 'COMPLETED' where id = $1", [runId]);
      await client.query("update control_tasks set owner_run_id = null, ownership_epoch = ownership_epoch + 1, task_status = 'DONE' where id = $1", [taskId]);
      await event(client, runId, 'COMPLETION_COMMITTED', {});
      return true;
    });
    print('finish_result', { task_id: taskId, run_id: runId, completed });
  } finally {
    await client.end();
  }
}

async function cancel(taskId: string, runId: string): Promise<void> {
  const client = await connect();
  try {
    const cancelled = await transaction(client, async () => {
      const row = await lockRun(client, taskId, runId);
      if (row === undefined) throw new Error('control run does not exist');
      await markBarrier(`locked-${runId}`);
      await waitForRelease();
      if (row.status !== 'RUNNING' || row.ownerRunId !== runId) return false;
      await client.query("update control_runs set status = 'CANCELLED', control_request = 'CANCEL_APPLIED' where id = $1", [runId]);
      await client.query("update control_tasks set owner_run_id = null, ownership_epoch = ownership_epoch + 1, task_status = 'READY' where id = $1", [taskId]);
      await event(client, runId, 'CANCEL_COMMITTED', {});
      return true;
    });
    print('cancel_result', { task_id: taskId, run_id: runId, cancelled });
  } finally {
    await client.end();
  }
}

async function handoffRequest(taskId: string, runId: string, scope: string): Promise<void> {
  const client = await connect();
  try {
    const waiting = await transaction(client, async () => {
      const row = await lockRun(client, taskId, runId);
      if (row === undefined || row.ownerRunId !== runId || row.status !== 'RUNNING') return false;
      const action = await client.query<{ status: string }>('select status from control_actions where run_id = $1 for update', [runId]);
      const resource = await client.query<{ status: string }>('select status from control_resources where scope = $1 for update', [scope]);
      if (action.rows[0]?.status !== 'DISPATCHING' || resource.rows[0]?.status !== 'HELD') return false;
      await client.query("update control_runs set control_request = 'HANDOFF_PENDING' where id = $1", [runId]);
      await client.query("update control_resources set status = 'QUARANTINED' where scope = $1", [scope]);
      await event(client, runId, 'HANDOFF_WAITING_SAFE_BOUNDARY', { scope });
      return true;
    });
    print('handoff_request_result', { task_id: taskId, run_id: runId, waiting });
  } finally {
    await client.end();
  }
}

async function markUnknownStopped(runId: string): Promise<void> {
  const client = await connect();
  try {
    await transaction(client, async () => {
      await client.query("update control_actions set status = 'UNKNOWN', old_writer_stopped = true where run_id = $1 and status = 'DISPATCHING'", [runId]);
      await event(client, runId, 'OLD_WRITER_STOPPED_UNKNOWN_REQUIRES_RECONCILIATION', {});
    });
    print('old_writer_marked_unknown_stopped', { run_id: runId });
  } finally {
    await client.end();
  }
}

/**
 * The control harness has no real adapter. This command represents a separate
 * reconciliation result already captured as evidence; it is intentionally not
 * inferred from a stopped process or an expired lease.
 */
async function resolveUnknown(runId: string): Promise<void> {
  const client = await connect();
  try {
    const resolved = await transaction(client, async () => {
      const result = await client.query(
        "update control_actions set status = 'RECONCILED_NOT_STARTED' where run_id = $1 and status = 'UNKNOWN' and old_writer_stopped = true",
        [runId],
      );
      if ((result.rowCount ?? 0) !== 1) return false;
      await event(client, runId, 'INDEPENDENT_RECONCILIATION_CONFIRMED_NOT_STARTED', {});
      return true;
    });
    print('unknown_reconciliation_result', { run_id: runId, resolved });
  } finally {
    await client.end();
  }
}

async function handoffFinalize(taskId: string, runId: string, scope: string): Promise<void> {
  const client = await connect();
  try {
    const finalized = await transaction(client, async () => {
      const row = await lockRun(client, taskId, runId);
      const action = await client.query<{ old_writer_stopped: boolean; status: string }>('select status, old_writer_stopped from control_actions where run_id = $1 for update', [runId]);
      const resource = await client.query<{ status: string }>('select status from control_resources where scope = $1 for update', [scope]);
      if (row === undefined || row.ownerRunId !== runId || action.rows[0]?.status !== 'RECONCILED_NOT_STARTED' || action.rows[0]?.old_writer_stopped !== true || resource.rows[0]?.status !== 'QUARANTINED') return false;
      await client.query("update control_runs set status = 'CANCELLED', control_request = 'HANDOFF_APPLIED' where id = $1", [runId]);
      await client.query("update control_tasks set owner_run_id = null, ownership_epoch = ownership_epoch + 1, task_status = 'IN_PROGRESS' where id = $1", [taskId]);
      await client.query("update control_resources set status = 'RELEASED' where scope = $1", [scope]);
      await event(client, runId, 'HANDOFF_APPLIED_AFTER_SAFE_BOUNDARY', { scope });
      return true;
    });
    print('handoff_finalize_result', { task_id: taskId, run_id: runId, finalized });
  } finally {
    await client.end();
  }
}

async function expireLease(runId: string): Promise<void> {
  const client = await connect();
  try {
    await client.query("update control_runs set lease_expires_at = now() - interval '1 second' where id = $1", [runId]);
    print('lease_expired', { run_id: runId });
  } finally {
    await client.end();
  }
}

async function holdOldWriter(runId: string): Promise<void> {
  await markBarrier(`old-writer-${runId}`);
  await waitForRelease();
  print('old_writer_exited', { run_id: runId });
}

async function resourceClaim(scope: string, taskId: string, runId: string): Promise<void> {
  const client = await connect();
  try {
    const granted = await transaction(client, async () => {
      const resource = await client.query<{ status: string }>('select status from control_resources where scope = $1 for update', [scope]);
      if (resource.rows[0] !== undefined && resource.rows[0].status !== 'RELEASED') return false;
      if (resource.rows[0] === undefined) {
        await client.query("insert into control_resources(scope, task_id, run_id, claim_epoch, status) values ($1, $2, $3, 1, 'HELD')", [scope, taskId, runId]);
      } else {
        await client.query("update control_resources set task_id = $2, run_id = $3, claim_epoch = claim_epoch + 1, status = 'HELD' where scope = $1", [scope, taskId, runId]);
      }
      await event(client, scope, 'RESOURCE_CLAIM_GRANTED', { taskId, runId });
      return true;
    });
    print('resource_claim_result', { scope, task_id: taskId, run_id: runId, granted });
  } finally {
    await client.end();
  }
}

async function reclaim(runId: string): Promise<void> {
  const client = await connect();
  try {
    const result = await client.query<{ claim_epoch: string }>(
      "update control_runs set claim_epoch = claim_epoch + 1, lease_expires_at = now() + interval '5 minutes' where id = $1 returning claim_epoch::text",
      [runId],
    );
    if (result.rows[0] === undefined) throw new Error('control run does not exist');
    print('claim_reclaimed', { run_id: runId, claim_epoch: result.rows[0].claim_epoch });
  } finally {
    await client.end();
  }
}

async function recordResult(taskId: string, runId: string, ownershipEpoch: string, claimEpoch: string): Promise<void> {
  const client = await connect();
  try {
    const accepted = await transaction(client, async () => {
      const result = await client.query<{ ownership_epoch: string; owner_run_id: string | null; claim_epoch: string; status: string }>(
        `select t.owner_run_id, t.ownership_epoch::text, r.claim_epoch::text, r.status
         from control_tasks t join control_runs r on r.task_id = t.id
         where t.id = $1 and r.id = $2 for update of t, r`,
        [taskId, runId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('control run does not exist');
      const current = row.owner_run_id === runId && row.status === 'RUNNING' && row.ownership_epoch === ownershipEpoch && row.claim_epoch === claimEpoch;
      if (!current) {
        await event(client, runId, 'STALE_CLAIM_OR_OWNERSHIP_EVIDENCE_RETAINED', { ownershipEpoch, claimEpoch });
        return false;
      }
      const action = await client.query(
        "update control_actions set status = 'SUCCEEDED' where run_id = $1 and status = 'DISPATCHING'",
        [runId],
      );
      if ((action.rowCount ?? 0) !== 1) {
        await event(client, runId, 'RESULT_NOT_COMMITTED_ACTION_NOT_DISPATCHING', { ownershipEpoch, claimEpoch });
        return false;
      }
      await event(client, runId, 'CURRENT_CLAIM_RESULT_ACCEPTED', { ownershipEpoch, claimEpoch });
      return true;
    });
    print('record_result', { task_id: taskId, run_id: runId, accepted });
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  const args = process.argv.slice(3);
  switch (command) {
    case 'setup': return setup();
    case 'create-task': return createTask(safeId(requiredArgument(args, 0), 'task id'));
    case 'delegate': return delegate(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'));
    case 'create-active': return createActive(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'), safeId(requiredArgument(args, 2), 'resource scope'));
    case 'pause': return pause(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'));
    case 'claim-next': return claimNext(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'));
    case 'finish': return finish(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'));
    case 'cancel': return cancel(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'));
    case 'handoff-request': return handoffRequest(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'), safeId(requiredArgument(args, 2), 'resource scope'));
    case 'mark-unknown-stopped': return markUnknownStopped(safeId(requiredArgument(args, 0), 'run id'));
    case 'resolve-unknown': return resolveUnknown(safeId(requiredArgument(args, 0), 'run id'));
    case 'handoff-finalize': return handoffFinalize(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'), safeId(requiredArgument(args, 2), 'resource scope'));
    case 'expire-lease': return expireLease(safeId(requiredArgument(args, 0), 'run id'));
    case 'hold-old-writer': return holdOldWriter(safeId(requiredArgument(args, 0), 'run id'));
    case 'resource-claim': return resourceClaim(safeId(requiredArgument(args, 0), 'resource scope'), safeId(requiredArgument(args, 1), 'task id'), safeId(requiredArgument(args, 2), 'run id'));
    case 'reclaim': return reclaim(safeId(requiredArgument(args, 0), 'run id'));
    case 'record-result': return recordResult(safeId(requiredArgument(args, 0), 'task id'), safeId(requiredArgument(args, 1), 'run id'), requiredArgument(args, 2), requiredArgument(args, 3));
    default: throw new Error('unknown control-worker command');
  }
}

function requiredArgument(args: readonly string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error(`missing argument ${index + 1}`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
