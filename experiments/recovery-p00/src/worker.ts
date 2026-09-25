import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { jsonSchema, simulateReadableStream, streamText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Client } from 'pg';

const writeInputSchema = Type.Object(
  {
    target: Type.Literal('managed-artifact.txt'),
    content: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
type WriteInput = Static<typeof writeInputSchema>;

const writeTools = {
  write_file: {
    description: 'Propose the single managed P00 recovery artifact.',
    inputSchema: jsonSchema<WriteInput>(writeInputSchema, {
      validate(value: unknown) {
        if (Value.Check(writeInputSchema, value)) {
          return { success: true as const, value };
        }
        return { success: false as const, error: new Error('invalid write_file input') };
      },
    }),
  },
} as const;

type Command =
  | 'setup'
  | 'prepare'
  | 'approve'
  | 'execute'
  | 'confirm-not-started'
  | 'reconcile'
  | 'mutate'
  | 'complete'
  | 'control-request'
  | 'control-apply'
  | 'expire-lease';

type EventPayload = Record<string, string | number | boolean | null>;

type ControlRequestType = 'PAUSE' | 'CANCEL';

/**
 * Experiment-only fault injection. A thrown fault runs inside an open short
 * transaction, so the connection issues a real ROLLBACK before the process
 * exits with 76. `admission-crash` exits with 77 while the transaction is still
 * open, so PostgreSQL rolls back on the abrupt disconnect. Neither is a business
 * rule; both exist to prove that joint commits have no partial state.
 */
class InjectedFault extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`injected fault at ${point}`);
    this.point = point;
  }
}

function injectOrThrow(point: string): void {
  if (process.env.RECOVERY_INJECT_FAILURE === point) {
    throw new InjectedFault(point);
  }
}

/**
 * Real per-process model-round counter. It is only incremented where a model
 * round actually happens (`prepare` -> `generateCandidate`), so a process that
 * resumes an already committed step reports 0 from its own measurement rather
 * than from a hardcoded constant.
 */
let modelRoundsThisProcess = 0;
let toolCallsThisProcess = 0;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function print(event: string, payload: EventPayload): void {
  process.stdout.write(`${json({ event, pid: process.pid, ...payload })}\n`);
}

function ownedPath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);
  const rel = relative(resolvedRoot, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(':')) {
    throw new Error(`path escapes experiment root: ${candidate}`);
  }
  return candidate;
}

function resourceScopeForPrepare(operationId: string): string {
  const sharedTargetKey = process.env.RECOVERY_SHARED_TARGET_KEY;
  if (sharedTargetKey === undefined) return operationId;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(sharedTargetKey)) {
    throw new Error('RECOVERY_SHARED_TARGET_KEY must be a lowercase safe test identifier');
  }
  return `shared-${sharedTargetKey}`;
}

function artifactPath(root: string, resourceId: string): string {
  if (!/^operation-[0-9a-f-]+$/u.test(resourceId) && !/^shared-[a-z0-9][a-z0-9-]{0,63}$/u.test(resourceId)) {
    throw new Error('resource id is not safe for an artifact directory');
  }
  return ownedPath(root, resourceId, 'managed-artifact.txt');
}

function effectLogPath(root: string, operationId: string): string {
  if (!/^operation-[0-9a-f-]+$/u.test(operationId)) {
    throw new Error('operation id is not safe for an effect-log filename');
  }
  return ownedPath(root, 'effects', `${operationId}.jsonl`);
}

async function connect(): Promise<Client> {
  const applicationName = process.env.RECOVERY_APPLICATION_NAME;
  const client = new Client({
    connectionString: required('RECOVERY_DATABASE_URL'),
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
  await client.connect();
  return client;
}

async function inTransaction<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const value = await work();
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function event(client: Client, operationId: string | null, type: string, payload: unknown): Promise<void> {
  await client.query(
    'insert into audit_events(operation_id, event_type, payload) values ($1, $2, $3::jsonb)',
    [operationId, type, json(payload)],
  );
}

async function protocolCommit(client: Client, operationId: string, phase: string): Promise<void> {
  await client.query(
    'insert into protocol_commits(operation_id, phase) values ($1, $2)',
    [operationId, phase],
  );
}

async function waitForLockedTransactionBarrier(phase: 'approval' | 'dispatch' | 'completion' | 'control', operationId: string): Promise<void> {
  if (process.env.RECOVERY_LOCK_BARRIER_PHASE !== phase) return;
  const directory = process.env.RECOVERY_LOCK_BARRIER_DIR;
  if (directory === undefined) throw new Error(`RECOVERY_LOCK_BARRIER_DIR is required for ${phase} lock barrier`);
  const ready = ownedPath(directory, `${phase}-locked-${operationId}`);
  const release = ownedPath(directory, 'release');
  mkdirSync(directory, { recursive: true });
  writeFileSync(ready, `${process.pid}\n`, { flag: 'wx' });
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (existsSync(release)) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`${phase} lock barrier release was not received within 30 seconds`);
}

async function setup(): Promise<void> {
  const client = await connect();
  try {
    await client.query(`
      create table if not exists probe_tasks (
        id text primary key,
        ownership_epoch bigint not null check (ownership_epoch >= 0),
        owner_run_id text,
        task_status text not null check (task_status in ('READY', 'WAITING', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
        state_revision bigint not null check (state_revision >= 0),
        completion_basis text check (completion_basis in ('AUTOMATED_VERIFICATION', 'HUMAN'))
      );
      create table if not exists managed_resources (
        id text primary key,
        normalized_target text not null check (normalized_target = 'managed-artifact.txt')
      );
      create table if not exists probe_runs (
        id text primary key,
        task_id text not null references probe_tasks(id),
        phase text not null check (phase in ('WAITING_APPROVAL', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED')),
        pause_reason text,
        worker_claim_epoch bigint not null check (worker_claim_epoch >= 0),
        parameter_hash text not null,
        baseline_hash text not null,
        permission_revision bigint not null,
        acceptance_revision bigint not null,
        lease_expires_at timestamptz,
        step_count int not null check (step_count >= 0),
        next_step_index int not null check (next_step_index >= 0)
      );
      create table if not exists probe_steps (
        id text primary key,
        run_id text not null references probe_runs(id),
        step_index int not null check (step_index >= 0),
        name text not null,
        status text not null check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
        attempt int not null check (attempt >= 0),
        finished_at timestamptz,
        unique (run_id, step_index)
      );
      create table if not exists operations (
        id text primary key,
        run_id text not null references probe_runs(id),
        resource_id text not null references managed_resources(id),
        status text not null check (status in ('CANDIDATE', 'PREPARED', 'DISPATCHING', 'CONFIRMED_NOT_STARTED', 'SUCCEEDED', 'DENIED', 'UNKNOWN')),
        logical_action_id text not null unique,
        tool_call_id text not null,
        normalized_params jsonb not null,
        params_hash text not null,
        content_hash text not null,
        baseline_hash text not null,
        model_request jsonb not null,
        model_response jsonb not null,
        ownership_epoch_snapshot bigint,
        worker_claim_epoch_snapshot bigint,
        created_at timestamptz not null default now()
      );
      create table if not exists reviews (
        id text primary key,
        operation_id text not null references operations(id),
        status text not null check (status in ('PENDING', 'APPROVED', 'INVALID')),
        params_hash text not null,
        baseline_hash text not null,
        permission_revision bigint not null,
        acceptance_revision bigint not null,
        ownership_epoch bigint not null,
        consumed_at timestamptz
      );
      create table if not exists invocations (
        id text primary key,
        operation_id text not null references operations(id),
        status text not null check (status in ('DISPATCHING', 'CONFIRMED_NOT_STARTED', 'SUCCEEDED', 'UNKNOWN')),
        ownership_epoch_snapshot bigint not null,
        worker_claim_epoch_snapshot bigint not null,
        effect_id text not null unique,
        dispatch_worker_pid integer not null,
        result_evidence jsonb
      );
      create unique index if not exists uq_invocation_unsettled
        on invocations(operation_id) where status in ('DISPATCHING', 'UNKNOWN');
      create table if not exists resource_claims (
        id text primary key,
        resource_id text not null references managed_resources(id),
        task_id text not null references probe_tasks(id),
        run_id text not null references probe_runs(id),
        operation_id text not null references operations(id),
        worker_claim_epoch bigint not null,
        status text not null check (status in ('HELD', 'QUARANTINED', 'RELEASED')),
        released_at timestamptz,
        quarantined_at timestamptz
      );
      create unique index if not exists uq_resource_claim_active
        on resource_claims(resource_id) where status in ('HELD', 'QUARANTINED');
      create table if not exists audit_events (
        id bigint generated always as identity primary key,
        operation_id text,
        event_type text not null,
        payload jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists protocol_commits (
        id bigint generated always as identity primary key,
        operation_id text not null,
        phase text not null,
        created_at timestamptz not null default now()
      );
      create table if not exists reconciliation_evidence (
        id bigint generated always as identity primary key,
        operation_id text not null references operations(id),
        evidence jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists control_requests (
        request_id text primary key,
        run_id text not null references probe_runs(id),
        type text not null check (type in ('PAUSE', 'CANCEL')),
        status text not null check (status in ('PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED')),
        requested_at timestamptz not null default now(),
        applied_at timestamptz,
        result_ref text
      );
      create table if not exists verifications (
        id text primary key,
        run_id text not null references probe_runs(id),
        task_id text not null references probe_tasks(id),
        decision text not null check (decision in ('PASS', 'RETRY', 'HUMAN')),
        acceptance_revision bigint not null,
        artifact_version_id text not null,
        content_digest text not null,
        verifier_policy_version text not null,
        created_at timestamptz not null default now()
      );
      create table if not exists completion_records (
        id text primary key,
        task_id text not null references probe_tasks(id),
        run_id text not null references probe_runs(id),
        verification_id text not null references verifications(id),
        acceptance_revision bigint not null,
        completion_basis text not null check (completion_basis in ('AUTOMATED_VERIFICATION', 'HUMAN')),
        state_revision bigint not null,
        completed_at timestamptz not null default now()
      );
      create table if not exists state_deltas (
        id bigint generated always as identity primary key,
        task_id text not null references probe_tasks(id),
        completion_record_id text not null references completion_records(id),
        state_revision bigint not null,
        delta jsonb not null,
        created_at timestamptz not null default now()
      );
      create table if not exists probe_project_state (
        id text primary key,
        revision bigint not null check (revision >= 0),
        done_task_count bigint not null check (done_task_count >= 0)
      );
      create table if not exists command_receipts (
        command_id text primary key,
        command_type text not null,
        payload_hash text not null,
        result jsonb not null,
        created_at timestamptz not null default now()
      );
      insert into probe_project_state(id, revision, done_task_count) values ('project-default', 0, 0)
        on conflict (id) do nothing;
    `);
    print('setup_complete', { database_schema: 'recovery_p00_v3' });
  } finally {
    await client.end();
  }
}

async function generateCandidate(operationId: string): Promise<{
  input: WriteInput;
  paramsHash: string;
  contentHash: string;
  toolCallId: string;
  modelRequest: unknown;
  modelResponse: unknown;
}> {
  modelRoundsThisProcess += 1;
  const input: WriteInput = {
    target: 'managed-artifact.txt',
    content: 'P00 cross-process recovery fixture\n',
  };
  const prompt = 'Propose exactly one write_file candidate for the managed recovery fixture.';
  const usage = {
    inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 6, text: 6, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    provider: 'official-ai-sdk-mock',
    modelId: 'recovery-p00-mock-v4',
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          {
            type: 'response-metadata' as const,
            id: `response-${operationId}`,
            modelId: 'recovery-p00-mock-v4',
            timestamp: new Date('2026-09-20T00:00:00.000Z'),
          },
          { type: 'text-start' as const, id: 'text-recovery' },
          { type: 'text-delta' as const, id: 'text-recovery', delta: '候选已生成。' },
          { type: 'text-end' as const, id: 'text-recovery' },
          { type: 'tool-input-start' as const, id: `call-${operationId}`, toolName: 'write_file' },
          { type: 'tool-input-delta' as const, id: `call-${operationId}`, delta: '{"target":"managed-' },
          { type: 'tool-input-delta' as const, id: `call-${operationId}`, delta: 'artifact.txt","content":"P00 cross-process recovery fixture\\n"}' },
          { type: 'tool-input-end' as const, id: `call-${operationId}` },
          {
            type: 'tool-call' as const,
            toolCallId: `call-${operationId}`,
            toolName: 'write_file',
            input: json(input),
          },
          { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
        ],
      }),
    }),
  });
  const result = streamText({
    model,
    tools: writeTools,
    toolChoice: { type: 'tool', toolName: 'write_file' },
    prompt,
    streamRetries: 0,
  });
  for await (const _part of result.stream) {
    // Draining the actual SDK stream is necessary before its final tool call is available.
  }
  const toolCalls = await result.toolCalls;
  if (toolCalls.length !== 1) {
    throw new Error(`expected exactly one SDK tool call, received ${toolCalls.length}`);
  }
  const call = toolCalls[0] as unknown as {
    invalid?: boolean;
    input?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
  };
  if (call.invalid === true || call.toolName !== 'write_file' || typeof call.toolCallId !== 'string' || !Value.Check(writeInputSchema, call.input)) {
    throw new Error('AI SDK did not yield one valid write_file candidate');
  }
  if (call.input.target !== 'managed-artifact.txt') {
    throw new Error('model target is outside the fixed managed artifact target');
  }
  return {
    input: call.input,
    paramsHash: sha256(stableJson(call.input)),
    contentHash: sha256(call.input.content),
    toolCallId: call.toolCallId,
    modelRequest: {
      prompt,
      toolChoice: 'write_file',
      inputSchema: writeInputSchema,
      provider: model.provider,
      modelId: model.modelId,
      noExecuteRegistered: !('execute' in writeTools.write_file),
    },
    modelResponse: {
      text: await result.text,
      response: await result.response,
      responseMessages: await result.responseMessages,
      toolCalls,
    },
  };
}

async function prepare(operationId: string): Promise<void> {
  const candidate = await generateCandidate(operationId);
  const client = await connect();
  const taskId = `task-${operationId}`;
  const runId = `run-${operationId}`;
  const reviewId = `review-${operationId}`;
  const resourceId = resourceScopeForPrepare(operationId);
  const target = artifactPath(required('RECOVERY_ROOT'), resourceId);
  const baselineHash = existsSync(target) ? sha256(readFileSync(target)) : sha256('<absent>');
  try {
    await inTransaction(client, async () => {
      await client.query(
        `insert into probe_tasks(id, ownership_epoch, owner_run_id, task_status, state_revision)
         values ($1, 1, $2, 'IN_PROGRESS', 0)`,
        [taskId, runId],
      );
      await client.query(
        "insert into managed_resources(id, normalized_target) values ($1, 'managed-artifact.txt') on conflict (id) do nothing",
        [resourceId],
      );
      await client.query(
        `insert into probe_runs(id, task_id, phase, worker_claim_epoch, parameter_hash, baseline_hash, permission_revision, acceptance_revision, step_count, next_step_index)
         values ($1, $2, 'WAITING_APPROVAL', 1, $3, $4, 1, 1, 2, 1)`,
        [runId, taskId, candidate.paramsHash, baselineHash],
      );
      await client.query(
        `insert into probe_steps(id, run_id, step_index, name, status, attempt, finished_at)
         values ($1, $2, 0, 'CAPTURE_CANDIDATE', 'SUCCEEDED', 1, now()),
                ($3, $2, 1, 'APPLY_MANAGED_WRITE', 'PENDING', 0, null)`,
        [`step-${runId}-0`, runId, `step-${runId}-1`],
      );
      await client.query(
        `insert into operations(id, run_id, resource_id, status, logical_action_id, tool_call_id, normalized_params, params_hash, content_hash, baseline_hash, model_request, model_response)
         values ($1, $2, $3, 'CANDIDATE', $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb)`,
        [
          operationId,
          runId,
          resourceId,
          `logical-${operationId}`,
          candidate.toolCallId,
          json(candidate.input),
          candidate.paramsHash,
          candidate.contentHash,
          baselineHash,
          json(candidate.modelRequest),
          json(candidate.modelResponse),
        ],
      );
      await client.query(
        `insert into reviews(id, operation_id, status, params_hash, baseline_hash, permission_revision, acceptance_revision, ownership_epoch)
         values ($1, $2, 'PENDING', $3, $4, 1, 1, 1)`,
        [reviewId, operationId, candidate.paramsHash, baselineHash],
      );
      await event(client, operationId, 'MODEL_CALL', { toolCallId: candidate.toolCallId, paramsHash: candidate.paramsHash });
      await event(client, operationId, 'CANDIDATE_WITH_REVIEW_BINDING', { reviewId, logicalActionId: `logical-${operationId}` });
      await event(client, operationId, 'STEP_ADVANCED', { stepIndex: 0, name: 'CAPTURE_CANDIDATE', status: 'SUCCEEDED', nextStepIndex: 1 });
      await protocolCommit(client, operationId, 'CANDIDATE_CAPTURED');
    });
    print('prepared', { operation_id: operationId, tool_call_id: candidate.toolCallId, no_execute_registered: true, model_rounds_this_process: modelRoundsThisProcess });
  } finally {
    await client.end();
  }
}

async function approve(operationId: string): Promise<void> {
  const client = await connect();
  try {
    const approved = await inTransaction(client, async () => {
      const review = await client.query<{ status: string }>('select status from reviews where operation_id = $1 for update', [operationId]);
      const current = review.rows[0];
      if (current === undefined) throw new Error(`review for operation ${operationId} does not exist`);
      await waitForLockedTransactionBarrier('approval', operationId);
      if (current.status !== 'PENDING') return false;
      const result = await client.query(
        "update reviews set status = 'APPROVED' where operation_id = $1 and status = 'PENDING' returning id",
        [operationId],
      );
      if ((result.rowCount ?? 0) === 1) {
        await event(client, operationId, 'APPROVAL_RECORDED', { approvalTransition: 'PENDING_TO_APPROVED' });
        await protocolCommit(client, operationId, 'APPROVE');
        return true;
      }
      return false;
    });
    print('approval_result', { operation_id: operationId, transitioned: approved });
  } finally {
    await client.end();
  }
}

type LockedOperation = {
  operationId: string;
  taskId: string;
  runId: string;
  resourceId: string;
  operationStatus: string;
  runPhase: string;
  ownershipEpoch: string;
  workerClaimEpoch: string;
  parameterHash: string;
  taskBaselineHash: string;
  permissionRevision: string;
  acceptanceRevision: string;
  operationParamsHash: string;
  operationBaselineHash: string;
  reviewStatus: string;
  reviewParamsHash: string;
  reviewBaselineHash: string;
  reviewPermissionRevision: string;
  reviewAcceptanceRevision: string;
  reviewOwnershipEpoch: string;
  normalizedParams: WriteInput;
  contentHash: string;
  nextStepIndex: string;
  stepCount: string;
};

async function lockOperation(client: Client, operationId: string): Promise<LockedOperation | undefined> {
  const locator = await client.query<{ resource_id: string; run_id: string; task_id: string }>(
    `select o.resource_id, o.run_id, r.task_id
     from operations o join probe_runs r on r.id = o.run_id
     where o.id = $1`,
    [operationId],
  );
  const location = locator.rows[0];
  if (location === undefined) return undefined;
  const task = await client.query('select id from probe_tasks where id = $1 for update', [location.task_id]);
  if (task.rows[0] === undefined) throw new Error(`task for operation ${operationId} does not exist`);
  const run = await client.query('select id from probe_runs where id = $1 and task_id = $2 for update', [location.run_id, location.task_id]);
  if (run.rows[0] === undefined) throw new Error(`run for operation ${operationId} does not match its task`);
  const resource = await client.query('select id from managed_resources where id = $1 for update', [location.resource_id]);
  if (resource.rows[0] === undefined) throw new Error(`resource for operation ${operationId} does not exist`);
  const result = await client.query<LockedOperation>(
    `select
       o.id as "operationId", r0.task_id as "taskId", o.run_id as "runId", o.resource_id as "resourceId", o.status as "operationStatus", r0.phase as "runPhase",
       t.ownership_epoch::text as "ownershipEpoch", r0.worker_claim_epoch::text as "workerClaimEpoch", r0.parameter_hash as "parameterHash", r0.baseline_hash as "taskBaselineHash",
       r0.permission_revision::text as "permissionRevision", r0.acceptance_revision::text as "acceptanceRevision",
       o.params_hash as "operationParamsHash", o.baseline_hash as "operationBaselineHash",
       r.status as "reviewStatus", r.params_hash as "reviewParamsHash", r.baseline_hash as "reviewBaselineHash",
       r.permission_revision::text as "reviewPermissionRevision", r.acceptance_revision::text as "reviewAcceptanceRevision",
       r.ownership_epoch::text as "reviewOwnershipEpoch", o.normalized_params as "normalizedParams", o.content_hash as "contentHash",
       r0.next_step_index::text as "nextStepIndex", r0.step_count::text as "stepCount"
      from operations o
      join probe_runs r0 on r0.id = o.run_id
      join probe_tasks t on t.id = r0.task_id
      join reviews r on r.operation_id = o.id
      where o.id = $1
     for update of o, r0, r`,
    [operationId],
  );
  return result.rows[0];
}

type ActiveResourceClaim = {
  id: string;
  operationId: string;
  runId: string;
  status: string;
  taskId: string;
  workerClaimEpoch: string;
};

async function activeResourceClaim(client: Client, resourceId: string): Promise<ActiveResourceClaim | undefined> {
  const result = await client.query<ActiveResourceClaim>(
    `select id, operation_id as "operationId", run_id as "runId", status, task_id as "taskId", worker_claim_epoch::text as "workerClaimEpoch"
     from resource_claims
     where resource_id = $1 and status in ('HELD', 'QUARANTINED')
     for update`,
    [resourceId],
  );
  return result.rows[0];
}

function claimBelongsToOperation(claim: ActiveResourceClaim, row: LockedOperation): boolean {
  return claim.operationId === row.operationId
    && claim.taskId === row.taskId
    && claim.runId === row.runId
    && claim.workerClaimEpoch === row.workerClaimEpoch
    && claim.status === 'HELD';
}

function bindingsAreCurrent(row: LockedOperation): boolean {
  return row.parameterHash === row.operationParamsHash
    && row.parameterHash === row.reviewParamsHash
    && row.taskBaselineHash === row.operationBaselineHash
    && row.taskBaselineHash === row.reviewBaselineHash
    && row.permissionRevision === row.reviewPermissionRevision
    && row.acceptanceRevision === row.reviewAcceptanceRevision
    && row.ownershipEpoch === row.reviewOwnershipEpoch;
}

async function writeEffect(operationId: string, resourceId: string, input: WriteInput, paramsHash: string, baselineHash: string, effectId: string): Promise<{ afterHash: string; logPath: string }> {
  const root = required('RECOVERY_ROOT');
  const target = artifactPath(root, resourceId);
  const actualBaseline = existsSync(target) ? sha256(readFileSync(target)) : sha256('<absent>');
  if (actualBaseline !== baselineHash) {
    throw new Error('managed target baseline changed before external effect');
  }
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, input.content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new Error('managed target appeared before exclusive create');
    }
    throw error;
  }
  const artifactFd = openSync(target, 'r+');
  try {
    fsyncSync(artifactFd);
  } finally {
    closeSync(artifactFd);
  }
  const afterHash = sha256(readFileSync(target));
  const logPath = effectLogPath(root, operationId);
  mkdirSync(dirname(logPath), { recursive: true });
  const evidence = {
    schemaVersion: 1,
    operationId,
    logicalActionId: `logical-${operationId}`,
    effectId,
    managedScope: resourceId,
    normalizedTarget: input.target,
    paramsHash,
    baselineHash,
    contentHash: sha256(input.content),
    afterHash,
  };
  const fd = openSync(logPath, 'a');
  try {
    appendFileSync(fd, `${json(evidence)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { afterHash, logPath };
}

async function waitForRecoveryBarrier(operationId: string): Promise<void> {
  const directory = process.env.RECOVERY_BARRIER_DIR;
  if (directory === undefined) throw new Error('RECOVERY_BARRIER_DIR is required for hold-after-dispatch');
  const ready = ownedPath(directory, `ready-${operationId}`);
  const release = ownedPath(directory, 'release');
  mkdirSync(directory, { recursive: true });
  writeFileSync(ready, `${process.pid}\n`, { flag: 'wx' });
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if (existsSync(release)) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('recovery barrier release was not received within 30 seconds');
}

async function execute(operationId: string, crashMode: 'after-dispatch' | 'after-external-effect' | 'after-partial-write' | 'after-prepared' | 'hold-after-dispatch' | undefined): Promise<void> {
  const client = await connect();
  let prepared: { input: WriteInput; paramsHash: string; baselineHash: string; resourceId: string } | undefined;
  try {
    prepared = await inTransaction(client, async () => {
      const row = await lockOperation(client, operationId);
      if (row === undefined) {
        throw new Error(`operation ${operationId} does not exist`);
      }
      await waitForLockedTransactionBarrier('dispatch', operationId);
      if (row.operationStatus !== 'CANDIDATE' && row.operationStatus !== 'PREPARED' && row.operationStatus !== 'CONFIRMED_NOT_STARTED') {
        return undefined;
      }
      if (!bindingsAreCurrent(row)) {
        await client.query("update reviews set status = 'INVALID' where operation_id = $1", [operationId]);
        await client.query("update operations set status = 'DENIED' where id = $1", [operationId]);
        await client.query("update probe_runs set phase = 'PAUSED', pause_reason = 'APPROVAL_INVALIDATED' where id = $1", [row.runId]);
        await event(client, operationId, 'APPROVAL_INVALIDATED', { reason: 'binding_changed' });
        await protocolCommit(client, operationId, 'DENY_STALE_APPROVAL');
        return undefined;
      }
      if (row.reviewStatus !== 'APPROVED') {
        return undefined;
      }
      if (row.operationStatus === 'CANDIDATE') {
        await client.query("update operations set status = 'PREPARED' where id = $1", [operationId]);
        await event(client, operationId, 'PREPARED_AFTER_APPROVAL', { ownershipEpoch: row.ownershipEpoch });
        await protocolCommit(client, operationId, 'PREPARE_AFTER_APPROVAL');
      }
      return {
        input: row.normalizedParams,
        paramsHash: row.operationParamsHash,
        baselineHash: row.operationBaselineHash,
        resourceId: row.resourceId,
      };
    });
    if (prepared === undefined) {
      print('execute_skipped', { operation_id: operationId, reason: 'not_candidate_or_not_approved' });
      return;
    }
    if (crashMode === 'after-prepared') {
      await client.end();
      print('hard_exit_after_prepared', { operation_id: operationId, exit_code: 72 });
      process.exit(72);
    }

    const target = artifactPath(required('RECOVERY_ROOT'), prepared.resourceId);
    const actualBaseline = existsSync(target) ? sha256(readFileSync(target)) : sha256('<absent>');
    const dispatch = await inTransaction(client, async () => {
      const row = await lockOperation(client, operationId);
      if (row === undefined || (row.operationStatus !== 'PREPARED' && row.operationStatus !== 'CONFIRMED_NOT_STARTED') || !bindingsAreCurrent(row) || row.reviewStatus !== 'APPROVED') {
        return undefined;
      }
      if (row.runPhase === 'PAUSED' || row.runPhase === 'CANCELLED' || row.runPhase === 'COMPLETED') {
        await event(client, operationId, 'DISPATCH_BLOCKED_BY_RUN_STATE', { runPhase: row.runPhase });
        return undefined;
      }
      const pendingControl = await client.query<{ count: number }>(
        "select count(*)::int as count from control_requests where run_id = $1 and status = 'PENDING'",
        [row.runId],
      );
      if ((pendingControl.rows[0]?.count ?? 0) > 0) {
        await event(client, operationId, 'DISPATCH_BLOCKED_BY_PENDING_CONTROL_REQUEST', { runId: row.runId });
        return undefined;
      }
      const stepIndex = Number.parseInt(row.nextStepIndex, 10);
      const stepCount = Number.parseInt(row.stepCount, 10);
      if (stepIndex >= stepCount) {
        await event(client, operationId, 'STEP_POSITION_ALREADY_COMPLETE', { nextStepIndex: stepIndex, stepCount });
        print('step_position_complete', { operation_id: operationId, next_step_index: stepIndex, step_count: stepCount });
        return undefined;
      }
      print('resume_from_step', {
        operation_id: operationId,
        run_id: row.runId,
        step_index: stepIndex,
        completed_steps: stepIndex,
        step_count: stepCount,
        model_rounds_this_process: modelRoundsThisProcess,
        tool_calls_this_process: toolCallsThisProcess,
      });
      const existingClaim = await activeResourceClaim(client, row.resourceId);
      if (existingClaim !== undefined && (!claimBelongsToOperation(existingClaim, row) || row.operationStatus !== 'CONFIRMED_NOT_STARTED')) {
        await event(client, operationId, 'RESOURCE_CLAIM_UNAVAILABLE', {
          activeClaimStatus: existingClaim.status,
          activeOperationId: existingClaim.operationId,
          resourceId: row.resourceId,
        });
        return undefined;
      }
      if (actualBaseline !== row.operationBaselineHash || actualBaseline !== sha256('<absent>')) {
        await client.query("update reviews set status = 'INVALID' where operation_id = $1", [operationId]);
        await client.query("update operations set status = 'DENIED' where id = $1", [operationId]);
        await client.query("update probe_runs set phase = 'PAUSED', pause_reason = 'BASELINE_CHANGED' where id = $1", [row.runId]);
        await event(client, operationId, 'BASELINE_PRECONDITION_REJECTED', { actualBaseline });
        await protocolCommit(client, operationId, 'DENY_BASELINE_CHANGED');
        return undefined;
      }
      const effectId = `effect-${randomUUID()}`;
      if (row.operationStatus === 'PREPARED') {
        const consumed = await client.query(
          'update reviews set consumed_at = now() where operation_id = $1 and consumed_at is null',
          [operationId],
        );
        if ((consumed.rowCount ?? 0) !== 1) return undefined;
      } else {
        const confirmed = await client.query(
          "select count(*)::int as count from invocations where operation_id = $1 and status = 'CONFIRMED_NOT_STARTED'",
          [operationId],
        );
        if (confirmed.rows[0]?.count !== 1) return undefined;
      }
      if (existingClaim === undefined) {
        await client.query(
          `insert into resource_claims(id, resource_id, task_id, run_id, operation_id, worker_claim_epoch, status)
           values ($1, $2, $3, $4, $5, $6, 'HELD')`,
          [`claim-${operationId}`, row.resourceId, row.taskId, row.runId, operationId, row.workerClaimEpoch],
        );
        await event(client, operationId, 'RESOURCE_CLAIM_HELD', {
          resourceId: row.resourceId,
          workerClaimEpoch: row.workerClaimEpoch,
        });
      }
      const stepStarted = await client.query(
        "update probe_steps set status = 'RUNNING', attempt = attempt + 1 where run_id = $1 and step_index = $2 and status in ('PENDING', 'RUNNING')",
        [row.runId, stepIndex],
      );
      if ((stepStarted.rowCount ?? 0) !== 1) {
        throw new Error(`cannot start step ${stepIndex} for ${operationId}`);
      }
      const invocationId = `invocation-${randomUUID()}`;
      await client.query(
        "insert into invocations(id, operation_id, status, ownership_epoch_snapshot, worker_claim_epoch_snapshot, effect_id, dispatch_worker_pid) values ($1, $2, 'DISPATCHING', $3, $4, $5, $6)",
        [invocationId, operationId, row.ownershipEpoch, row.workerClaimEpoch, effectId, process.pid],
      );
      await client.query("update operations set status = 'DISPATCHING', ownership_epoch_snapshot = $2, worker_claim_epoch_snapshot = $3 where id = $1", [operationId, row.ownershipEpoch, row.workerClaimEpoch]);
      await client.query("update probe_runs set phase = 'RUNNING', pause_reason = null, lease_expires_at = now() + interval '5 minutes' where id = $1", [row.runId]);
      await event(client, operationId, 'DISPATCH_CLAIMED', { effectId, ownershipEpoch: row.ownershipEpoch, workerClaimEpoch: row.workerClaimEpoch });
      await protocolCommit(client, operationId, 'DISPATCH');
      /*
       * The injection point sits after every write of the admission transaction
       * (claim row, Invocation row, DISPATCHING status, run phase, step start,
       * both audit events, protocol commit) and before the commit itself. It can
       * therefore falsify any rollback failure: if the transaction did commit,
       * the claim row, Invocation row, DISPATCHING status and the two events all
       * become visible instead of disappearing together.
       */
      injectOrThrow('admission-rollback');
      if (process.env.RECOVERY_INJECT_FAILURE === 'admission-crash') {
        print('injected_abrupt_exit_inside_admission_transaction', { operation_id: operationId, exit_code: 77 });
        process.exit(77);
      }
      return {
        input: row.normalizedParams,
        paramsHash: row.operationParamsHash,
        baselineHash: row.operationBaselineHash,
        ownershipEpoch: row.ownershipEpoch,
        workerClaimEpoch: row.workerClaimEpoch,
        resourceId: row.resourceId,
        effectId,
        invocationId,
      };
    });
    if (dispatch === undefined) {
      print('execute_skipped', { operation_id: operationId, reason: 'lost_prepared_dispatch_race' });
      return;
    }

    if (crashMode === 'after-dispatch') {
      await client.end();
      print('hard_exit_after_dispatch_before_adapter', { operation_id: operationId, invocation_id: dispatch.invocationId, exit_code: 74 });
      process.exit(74);
    }
    if (crashMode === 'hold-after-dispatch') {
      await waitForRecoveryBarrier(operationId);
    }

    await event(client, operationId, 'TOOL_CALL', { effectId: dispatch.effectId, target: dispatch.input.target });
    toolCallsThisProcess += 1;
    if (crashMode === 'after-partial-write') {
      const target = artifactPath(required('RECOVERY_ROOT'), dispatch.resourceId);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'partial-write-without-action-identity-evidence\n', { encoding: 'utf8', flag: 'wx' });
      const partialFd = openSync(target, 'r+');
      try {
        fsyncSync(partialFd);
      } finally {
        closeSync(partialFd);
      }
      await client.end();
      print('hard_exit_after_partial_write', { operation_id: operationId, exit_code: 75 });
      process.exit(75);
    }
    const effect = await writeEffect(operationId, dispatch.resourceId, dispatch.input, dispatch.paramsHash, dispatch.baselineHash, dispatch.effectId);
    print('external_effect_written', { operation_id: operationId, invocation_id: dispatch.invocationId, effect_id: dispatch.effectId, after_hash: effect.afterHash });
    if (crashMode === 'after-external-effect') {
      await client.end();
      print('hard_exit_after_external_effect', { operation_id: operationId, exit_code: 73 });
      process.exit(73);
    }
    const committed = await recordSuccess(client, operationId, dispatch.invocationId, dispatch.ownershipEpoch, dispatch.workerClaimEpoch, {
      effectId: dispatch.effectId,
      afterHash: effect.afterHash,
      source: 'direct_worker',
    });
    print('execute_result', { operation_id: operationId, result_committed: committed, model_rounds_this_process: modelRoundsThisProcess, tool_calls_this_process: toolCallsThisProcess });
  } finally {
    if (client) {
      await client.end().catch(() => undefined);
    }
  }
}

async function recordSuccess(client: Client, operationId: string, invocationId: string, ownershipEpochSnapshot: string, workerClaimEpochSnapshot: string, evidenceValue: unknown): Promise<boolean> {
  return inTransaction(client, async () => {
    const row = await lockOperation(client, operationId);
    if (row === undefined || row.operationStatus !== 'DISPATCHING') {
      return false;
    }
    const invocationState = await client.query<{ status: string }>(
      'select status from invocations where id = $1 and operation_id = $2 for update',
      [invocationId, operationId],
    );
    if (invocationState.rows[0]?.status !== 'DISPATCHING') return false;
    if (row.ownershipEpoch !== ownershipEpochSnapshot) {
      await event(client, operationId, 'STALE_OWNERSHIP_EPOCH_EVIDENCE_RETAINED', { ownershipEpochSnapshot, invocationId });
      await client.query(
        'insert into reconciliation_evidence(operation_id, evidence) values ($1, $2::jsonb)',
        [operationId, json(evidenceValue)],
      );
      return false;
    }
    if (row.workerClaimEpoch !== workerClaimEpochSnapshot) {
      await event(client, operationId, 'STALE_WORKER_CLAIM_EPOCH_EVIDENCE_RETAINED', { invocationId, workerClaimEpochSnapshot });
      await client.query(
        'insert into reconciliation_evidence(operation_id, evidence) values ($1, $2::jsonb)',
        [operationId, json(evidenceValue)],
      );
      return false;
    }
    const claim = await activeResourceClaim(client, row.resourceId);
    if (claim === undefined || !claimBelongsToOperation(claim, row)) {
      await event(client, operationId, 'RESOURCE_CLAIM_NOT_HELD_EVIDENCE_RETAINED', { invocationId, resourceId: row.resourceId });
      await client.query(
        'insert into reconciliation_evidence(operation_id, evidence) values ($1, $2::jsonb)',
        [operationId, json(evidenceValue)],
      );
      return false;
    }
    const released = await client.query(
      `update resource_claims
       set status = 'RELEASED', released_at = now()
       where id = $1 and status = 'HELD'`,
      [claim.id],
    );
    if ((released.rowCount ?? 0) !== 1) throw new Error(`cannot release held resource claim for ${operationId}`);
    const invocation = await client.query(
      "update invocations set status = 'SUCCEEDED', result_evidence = $2::jsonb where id = $1 and operation_id = $3 and status = 'DISPATCHING'",
      [invocationId, json(evidenceValue), operationId],
    );
    const operation = await client.query(
      "update operations set status = 'SUCCEEDED' where id = $1 and status = 'DISPATCHING'",
      [operationId],
    );
    if ((invocation.rowCount ?? 0) !== 1 || (operation.rowCount ?? 0) !== 1) {
      throw new Error(`cannot record result for ${operationId} after releasing its resource claim`);
    }
    const stepIndex = Number.parseInt(row.nextStepIndex, 10);
    const stepCount = Number.parseInt(row.stepCount, 10);
    if (stepIndex < stepCount) {
      const advanced = await client.query(
        "update probe_steps set status = 'SUCCEEDED', finished_at = now() where run_id = $1 and step_index = $2 and status in ('PENDING', 'RUNNING')",
        [row.runId, stepIndex],
      );
      if ((advanced.rowCount ?? 0) === 1) {
        const position = await client.query(
          'update probe_runs set next_step_index = $2 where id = $1 and next_step_index = $3',
          [row.runId, stepIndex + 1, stepIndex],
        );
        if ((position.rowCount ?? 0) !== 1) {
          throw new Error(`cannot advance step position for ${operationId}`);
        }
        await event(client, operationId, 'STEP_ADVANCED', { stepIndex, status: 'SUCCEEDED', nextStepIndex: stepIndex + 1 });
        await protocolCommit(client, operationId, `STEP_${stepIndex}_SUCCEEDED`);
      }
    }
    await event(client, operationId, 'RESOURCE_CLAIM_RELEASED', { resourceId: row.resourceId });
    await event(client, operationId, 'RESULT_RECORDED', { source: 'same_operation', invocationId });
    await protocolCommit(client, operationId, 'RESULT_SUCCEEDED');
    /*
     * The injection point sits after every write of the result transaction
     * (claim release, Invocation and operation status, step advancement,
     * RESOURCE_CLAIM_RELEASED / RESULT_RECORDED) and before the commit itself.
     * If the transaction committed anyway, the claim would stay RELEASED and
     * both events plus the step position would be visible - exactly what the
     * scenario asserts must not happen.
     */
    injectOrThrow('result-rollback');
    return true;
  });
}

function loadMatchingEvidence(operationId: string, resourceId: string, expected: {
  effectId: string;
  paramsHash: string;
  baselineHash: string;
  contentHash: string;
}): { afterHash: string; effectId: string } | undefined {
  const root = required('RECOVERY_ROOT');
  const logPath = effectLogPath(root, operationId);
  const target = artifactPath(root, resourceId);
  if (!existsSync(logPath) || !existsSync(target)) {
    return undefined;
  }
  let entries: Record<string, unknown>[];
  try {
    entries = readFileSync(logPath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('effect evidence entry is not an object');
        }
        return parsed as Record<string, unknown>;
      });
  } catch {
    return undefined;
  }
  const targetHash = sha256(readFileSync(target));
  const match = entries.find((entry) =>
    entry.operationId === operationId
    && entry.logicalActionId === `logical-${operationId}`
    && entry.effectId === expected.effectId
    && entry.managedScope === resourceId
    && entry.normalizedTarget === 'managed-artifact.txt'
    && entry.paramsHash === expected.paramsHash
    && entry.baselineHash === expected.baselineHash
    && entry.contentHash === expected.contentHash
    && entry.afterHash === expected.contentHash
    && entry.afterHash === targetHash,
  );
  if (match === undefined || typeof match.afterHash !== 'string' || typeof match.effectId !== 'string') {
    return undefined;
  }
  return { afterHash: match.afterHash, effectId: match.effectId };
}

/**
 * The controlled P00 file adapter has one entry point. Only a parent-observed
 * exit receipt bound to the original invocation PID, a dead original process,
 * and no adapter-entry evidence can prove the old attempt did not reach it.
 * Every other DISPATCHING case remains UNKNOWN and uses normal reconciliation.
 */
function exitReceiptPath(invocationId: string): string {
  if (!/^invocation-[0-9a-f-]+$/u.test(invocationId)) {
    throw new Error('invocation id is not safe for an exit receipt filename');
  }
  return ownedPath(required('RECOVERY_ROOT'), 'exit-receipts', `${invocationId}.json`);
}

function readExitReceipt(invocationId: string): { effectId: string; exitCode: number; invocationId: string; operationId: string; pid: number } | undefined {
  const path = exitReceiptPath(invocationId);
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.operationId !== 'string' || typeof record.invocationId !== 'string' || typeof record.effectId !== 'string' || typeof record.pid !== 'number' || typeof record.exitCode !== 'number') return undefined;
    return { operationId: record.operationId, invocationId: record.invocationId, effectId: record.effectId, pid: record.pid, exitCode: record.exitCode };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}

async function confirmNotStarted(operationId: string): Promise<void> {
  const client = await connect();
  try {
    const confirmed = await inTransaction(client, async () => {
      const row = await lockOperation(client, operationId);
      if (row === undefined || row.operationStatus !== 'DISPATCHING') return false;
      const dispatchInvocation = await client.query<{ dispatch_worker_pid: number; effect_id: string; id: string }>(
        "select id, effect_id, dispatch_worker_pid from invocations where operation_id = $1 and status = 'DISPATCHING' for update",
        [operationId],
      );
      const active = dispatchInvocation.rows[0];
      if (active === undefined) return false;
      const receipt = readExitReceipt(active.id);
      if (receipt?.operationId !== operationId || receipt.invocationId !== active.id || receipt.effectId !== active.effect_id || receipt.pid !== active.dispatch_worker_pid || receipt.exitCode !== 74 || processIsAlive(active.dispatch_worker_pid)) return false;
      const toolCalls = await client.query<{ count: number }>(
        "select count(*)::int as count from audit_events where operation_id = $1 and event_type = 'TOOL_CALL'",
        [operationId],
      );
      const targetExists = existsSync(artifactPath(required('RECOVERY_ROOT'), row.resourceId));
      const evidenceExists = existsSync(effectLogPath(required('RECOVERY_ROOT'), operationId));
      if ((toolCalls.rows[0]?.count ?? 0) !== 0 || targetExists || evidenceExists) return false;
      const invocation = await client.query(
        "update invocations set status = 'CONFIRMED_NOT_STARTED' where id = $1 and operation_id = $2 and status = 'DISPATCHING'",
        [active.id, operationId],
      );
      const operation = await client.query(
        "update operations set status = 'CONFIRMED_NOT_STARTED' where id = $1 and status = 'DISPATCHING'",
        [operationId],
      );
      if ((invocation.rowCount ?? 0) !== 1 || (operation.rowCount ?? 0) !== 1) return false;
      await client.query(
        'insert into reconciliation_evidence(operation_id, evidence) values ($1, $2::jsonb)',
        [operationId, json({ source: 'controlled_file_adapter_pre_entry', invocationId: active.id, effectId: active.effect_id, dispatchWorkerPid: active.dispatch_worker_pid, exitCode: receipt.exitCode, toolCallCount: 0, targetExists: false, evidenceExists: false })],
      );
      await event(client, operationId, 'ADAPTER_ENTRY_CONFIRMED_NOT_REACHED', { invocationId: active.id, toolCallCount: 0 });
      await protocolCommit(client, operationId, 'CONFIRMED_NOT_STARTED');
      return true;
    });
    print('confirm_not_started', { operation_id: operationId, confirmed });
  } finally {
    await client.end();
  }
}

async function reconcile(operationId: string): Promise<void> {
  const client = await connect();
  try {
    const result = await client.query<{
      invocation_id: string;
      operation_status: string;
      ownership_epoch_snapshot: string;
      worker_claim_epoch_snapshot: string;
      effect_id: string;
      params_hash: string;
      baseline_hash: string;
      content_hash: string;
      resource_id: string;
    }>(
      `select i.id as invocation_id, o.status as operation_status, i.ownership_epoch_snapshot::text, i.worker_claim_epoch_snapshot::text, i.effect_id, o.params_hash, o.baseline_hash, o.content_hash, o.resource_id
       from operations o
       join invocations i on i.operation_id = o.id and i.status = 'DISPATCHING'
       where o.id = $1 and o.status = 'DISPATCHING'
      `,
      [operationId],
    );
    const current = result.rows[0];
    if (current === undefined) {
      const operation = await client.query<{ status: string }>('select status from operations where id = $1', [operationId]);
      print('reconcile_skipped', { operation_id: operationId, status: operation.rows[0]?.status ?? 'missing' });
      return;
    }
    const evidenceValue = loadMatchingEvidence(operationId, current.resource_id, {
      effectId: current.effect_id,
      paramsHash: current.params_hash,
      baselineHash: current.baseline_hash,
      contentHash: current.content_hash,
    });
    if (evidenceValue === undefined) {
      const markedUnknown = await inTransaction(client, async () => {
        const row = await lockOperation(client, operationId);
        if (row === undefined || row.operationStatus !== 'DISPATCHING') return false;
        const invocationState = await client.query<{
          ownership_epoch_snapshot: string;
          status: string;
          worker_claim_epoch_snapshot: string;
        }>(
          `select status, ownership_epoch_snapshot::text, worker_claim_epoch_snapshot::text
           from invocations where id = $1 and operation_id = $2 for update`,
          [current.invocation_id, operationId],
        );
        const activeInvocation = invocationState.rows[0];
        if (activeInvocation === undefined || activeInvocation.status !== 'DISPATCHING') return false;
        if (row.ownershipEpoch !== activeInvocation.ownership_epoch_snapshot || row.workerClaimEpoch !== activeInvocation.worker_claim_epoch_snapshot) {
          await event(client, operationId, 'STALE_ADMISSION_EPOCH_UNKNOWN_RETAINED', {
            invocationId: current.invocation_id,
            ownershipEpochSnapshot: activeInvocation.ownership_epoch_snapshot,
            workerClaimEpochSnapshot: activeInvocation.worker_claim_epoch_snapshot,
          });
          return false;
        }
        const claim = await activeResourceClaim(client, row.resourceId);
        if (claim === undefined || !claimBelongsToOperation(claim, row)) {
          await event(client, operationId, 'RESOURCE_CLAIM_NOT_HELD_UNKNOWN_RETAINED', {
            invocationId: current.invocation_id,
            resourceId: row.resourceId,
          });
          return false;
        }
        const quarantined = await client.query(
          "update resource_claims set status = 'QUARANTINED', quarantined_at = now() where id = $1 and status = 'HELD'",
          [claim.id],
        );
        if ((quarantined.rowCount ?? 0) !== 1) throw new Error(`cannot quarantine held resource claim for ${operationId}`);
        const invocation = await client.query("update invocations set status = 'UNKNOWN' where id = $1 and operation_id = $2 and status = 'DISPATCHING'", [current.invocation_id, operationId]);
        const operation = await client.query("update operations set status = 'UNKNOWN' where id = $1 and status = 'DISPATCHING'", [operationId]);
        if ((invocation.rowCount ?? 0) !== 1 || (operation.rowCount ?? 0) !== 1) {
          throw new Error(`cannot mark ${operationId} UNKNOWN after quarantining its resource claim`);
        }
        await client.query("update probe_runs set phase = 'PAUSED', pause_reason = 'INSUFFICIENT_EVIDENCE' where id = $1", [row.runId]);
        await event(client, operationId, 'RESOURCE_CLAIM_QUARANTINED', { resourceId: row.resourceId });
        await event(client, operationId, 'INSUFFICIENT_EVIDENCE_UNKNOWN', { reason: 'no_matching_action_identity_evidence' });
        await protocolCommit(client, operationId, 'UNKNOWN_REQUIRES_HUMAN');
        return true;
      });
      print('reconcile_unknown', { operation_id: operationId, human_required: markedUnknown });
      return;
    }
    const committed = await recordSuccess(client, operationId, current.invocation_id, current.ownership_epoch_snapshot, current.worker_claim_epoch_snapshot, {
      effectId: evidenceValue.effectId,
      afterHash: evidenceValue.afterHash,
      source: 'reconciler',
    });
    print('reconcile_result', { operation_id: operationId, result_committed: committed });
  } finally {
    await client.end();
  }
}

async function mutate(operationId: string, field: string): Promise<void> {
  const allowed: Record<string, { assignment: string; table: 'probe_runs' | 'probe_tasks'; targetColumn: 'run_id' | 'task_id' }> = {
    parameter: { assignment: "parameter_hash = 'stale-parameter-hash'", table: 'probe_runs', targetColumn: 'run_id' },
    baseline: { assignment: "baseline_hash = 'stale-baseline-hash'", table: 'probe_runs', targetColumn: 'run_id' },
    permission: { assignment: 'permission_revision = permission_revision + 1', table: 'probe_runs', targetColumn: 'run_id' },
    acceptance: { assignment: 'acceptance_revision = acceptance_revision + 1', table: 'probe_runs', targetColumn: 'run_id' },
    ownership: { assignment: 'ownership_epoch = ownership_epoch + 1', table: 'probe_tasks', targetColumn: 'task_id' },
    claim: { assignment: 'worker_claim_epoch = worker_claim_epoch + 1', table: 'probe_runs', targetColumn: 'run_id' },
  };
  const mutation = allowed[field];
  if (mutation === undefined) {
    throw new Error('mutate field must be parameter, baseline, permission, acceptance, ownership, or claim');
  }
  const client = await connect();
  try {
    await inTransaction(client, async () => {
      const target = mutation.targetColumn === 'task_id'
        ? '(select r.task_id from operations o join probe_runs r on r.id = o.run_id where o.id = $1)'
        : '(select o.run_id from operations o where o.id = $1)';
      const result = await client.query(
        `update ${mutation.table} set ${mutation.assignment} where id = ${target}`,
        [operationId],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(`cannot mutate ${field}; operation does not exist`);
      }
      await event(client, operationId, 'CURRENT_FACT_MUTATED', { field });
      await protocolCommit(client, operationId, `MUTATE_${field.toUpperCase()}`);
    });
    print('fact_mutated', { operation_id: operationId, field });
  } finally {
    await client.end();
  }
}

type CompletionOutcome =
  | {
    committed: true;
    completionRecordId: string;
    projectRevision: string;
    runId: string;
    stateDeltaId: string;
    stateRevision: string;
    taskId: string;
    verificationId: string;
  }
  | { committed: false; reason: string };

function completionCommandPayload(commandId: string, operationId: string): string {
  return sha256(stableJson({ commandId, commandType: 'COMPLETE_TASK', operationId, completionBasis: 'AUTOMATED_VERIFICATION' }));
}

async function refusal(client: Client, operationId: string, reason: string, payload: EventPayload): Promise<CompletionOutcome> {
  await event(client, operationId, reason, payload);
  await protocolCommit(client, operationId, 'COMPLETION_REFUSED');
  return { committed: false, reason };
}

/**
 * The experiment's business completion use case. Verification PASS, the
 * completion record, Task DONE, the deterministic state delta, the command
 * receipt and the Run terminal state are written in one short transaction, so a
 * failure cannot leave a partial delta, a DONE Task without a record, or a
 * receipt without a completion.
 */
async function complete(operationId: string, commandId: string, mode: 'after-completion-commit' | undefined): Promise<void> {
  const client = await connect();
  const payloadHash = completionCommandPayload(commandId, operationId);
  try {
    const existing = await client.query<{ payload_hash: string; result: Record<string, unknown> }>(
      'select payload_hash, result from command_receipts where command_id = $1',
      [commandId],
    );
    const receipt = existing.rows[0];
    if (receipt !== undefined) {
      const samePayload = receipt.payload_hash === payloadHash;
      if (!samePayload) {
        await inTransaction(client, async () => {
          await event(client, operationId, 'COMMAND_RECEIPT_PAYLOAD_CONFLICT_RETAINED', { commandId });
        });
      }
      print('command_receipt_replay', {
        operation_id: operationId,
        command_id: commandId,
        same_payload: samePayload,
        completion_record_id: typeof receipt.result.completionRecordId === 'string' ? receipt.result.completionRecordId : '',
        state_revision: typeof receipt.result.stateRevision === 'string' ? receipt.result.stateRevision : '',
      });
      return;
    }
    const outcome = await inTransaction<CompletionOutcome>(client, async () => {
      const row = await lockOperation(client, operationId);
      if (row === undefined) throw new Error(`operation ${operationId} does not exist`);
      await waitForLockedTransactionBarrier('completion', operationId);
      const task = await client.query<{ owner_run_id: string | null; state_revision: string; task_status: string }>(
        'select task_status, owner_run_id, state_revision::text from probe_tasks where id = $1 for update',
        [row.taskId],
      );
      const currentTask = task.rows[0];
      if (currentTask === undefined) throw new Error(`task for ${operationId} does not exist`);
      if (currentTask.task_status === 'DONE') {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_TASK_ALREADY_DONE', { stateRevision: currentTask.state_revision });
      }
      if (currentTask.task_status === 'CANCELLED' || row.runPhase === 'CANCELLED') {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_CANCELLED_STATE', { runPhase: row.runPhase, taskStatus: currentTask.task_status });
      }
      const unresolved = await client.query<{ count: number }>(
        `select count(*)::int as count from invocations i join operations o on o.id = i.operation_id
         where o.run_id = $1 and i.status in ('DISPATCHING', 'UNKNOWN')`,
        [row.runId],
      );
      const unresolvedCount = unresolved.rows[0]?.count ?? 0;
      if (unresolvedCount > 0) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_UNRESOLVED_ACTION', { unresolvedActions: unresolvedCount });
      }
      const pendingControl = await client.query<{ count: number }>(
        "select count(*)::int as count from control_requests where run_id = $1 and status = 'PENDING'",
        [row.runId],
      );
      if ((pendingControl.rows[0]?.count ?? 0) > 0) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_CONTROL_REQUEST_PENDING', { runId: row.runId });
      }
      if (row.runPhase !== 'RUNNING') {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_RUN_NOT_RUNNING', { runPhase: row.runPhase });
      }
      if (currentTask.owner_run_id !== row.runId) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_OWNERSHIP_TRANSFERRED', { ownerRunId: currentTask.owner_run_id ?? 'none' });
      }
      const claimed = await client.query<{ count: number }>(
        "select count(*)::int as count from resource_claims where run_id = $1 and status in ('HELD', 'QUARANTINED')",
        [row.runId],
      );
      if ((claimed.rows[0]?.count ?? 0) > 0) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_RESOURCE_STILL_CLAIMED', { runId: row.runId });
      }
      const operations = await client.query<{ count: number }>(
        "select count(*)::int as count from operations where run_id = $1 and status <> 'SUCCEEDED'",
        [row.runId],
      );
      if ((operations.rows[0]?.count ?? 0) > 0) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_ARTIFACT_NOT_PERSISTED', { runId: row.runId, operationStatus: row.operationStatus });
      }
      const target = artifactPath(required('RECOVERY_ROOT'), row.resourceId);
      const onDisk = existsSync(target) ? sha256(readFileSync(target)) : sha256('<absent>');
      if (onDisk !== row.contentHash) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_ARTIFACT_NOT_PERSISTED', { onDisk });
      }
      if (row.acceptanceRevision !== row.reviewAcceptanceRevision) {
        return await refusal(client, operationId, 'COMPLETION_REFUSED_VERIFICATION_NOT_APPLICABLE', {
          acceptanceRevision: row.acceptanceRevision,
          reviewAcceptanceRevision: row.reviewAcceptanceRevision,
        });
      }
      const verificationId = `verification-${row.runId}`;
      const completionRecordId = `completion-${row.runId}`;
      await client.query(
        `insert into verifications(id, run_id, task_id, decision, acceptance_revision, artifact_version_id, content_digest, verifier_policy_version)
         values ($1, $2, $3, 'PASS', $4, $5, $6, 'recovery-p00-deterministic-checker-1')`,
        [verificationId, row.runId, row.taskId, row.acceptanceRevision, `artifact-version-${row.runId}`, row.contentHash],
      );
      await client.query(
        `insert into completion_records(id, task_id, run_id, verification_id, acceptance_revision, completion_basis, state_revision)
         values ($1, $2, $3, $4, $5, 'AUTOMATED_VERIFICATION', 0)`,
        [completionRecordId, row.taskId, row.runId, verificationId, row.acceptanceRevision],
      );
      const completedTask = await client.query<{ state_revision: string }>(
        `update probe_tasks
         set task_status = 'DONE', completion_basis = 'AUTOMATED_VERIFICATION', state_revision = state_revision + 1, owner_run_id = null, ownership_epoch = ownership_epoch + 1
         where id = $1 and task_status not in ('DONE', 'CANCELLED')
         returning state_revision::text`,
        [row.taskId],
      );
      const stateRevision = completedTask.rows[0]?.state_revision;
      if ((completedTask.rowCount ?? 0) !== 1 || stateRevision === undefined) {
        throw new Error(`cannot complete task for ${operationId}`);
      }
      await client.query('update completion_records set state_revision = $2 where id = $1', [completionRecordId, stateRevision]);
      const projectState = await client.query<{ revision: string }>(
        "update probe_project_state set revision = revision + 1, done_task_count = done_task_count + 1 where id = 'project-default' returning revision::text",
      );
      const projectRevision = projectState.rows[0]?.revision;
      if ((projectState.rowCount ?? 0) !== 1 || projectRevision === undefined) {
        throw new Error(`cannot apply project state delta for ${operationId}`);
      }
      const stateDelta = await client.query<{ id: string }>(
        `insert into state_deltas(task_id, completion_record_id, state_revision, delta)
         values ($1, $2, $3, $4::jsonb) returning id::text`,
        [row.taskId, completionRecordId, stateRevision, json({ doneTaskCount: 1, projectRevision, stateRevision })],
      );
      const stateDeltaId = stateDelta.rows[0]?.id;
      if (stateDeltaId === undefined) throw new Error(`cannot record state delta for ${operationId}`);
      const completedRun = await client.query(
        "update probe_runs set phase = 'COMPLETED', pause_reason = null where id = $1 and phase = 'RUNNING'",
        [row.runId],
      );
      if ((completedRun.rowCount ?? 0) !== 1) throw new Error(`cannot complete run for ${operationId}`);
      const result = {
        commandId,
        completionRecordId,
        projectRevision,
        runId: row.runId,
        stateDeltaId,
        stateRevision,
        taskId: row.taskId,
        verificationId,
      };
      await client.query(
        'insert into command_receipts(command_id, command_type, payload_hash, result) values ($1, $2, $3, $4::jsonb)',
        [commandId, 'COMPLETE_TASK', payloadHash, json(result)],
      );
      await event(client, operationId, 'VERIFICATION_PASS_RECORDED', { acceptanceRevision: row.acceptanceRevision, verificationId });
      await event(client, operationId, 'BUSINESS_COMPLETION_COMMITTED', { commandId, completionRecordId, stateRevision });
      await protocolCommit(client, operationId, 'BUSINESS_COMPLETION');
      injectOrThrow('completion-rollback');
      return { committed: true, ...result };
    });
    if (mode === 'after-completion-commit') {
      await client.end();
      print('hard_exit_after_completion_commit', { operation_id: operationId, exit_code: 79 });
      process.exit(79);
    }
    if (outcome.committed) {
      print('completion_result', {
        operation_id: operationId,
        command_id: commandId,
        committed: true,
        completion_record_id: outcome.completionRecordId,
        verification_id: outcome.verificationId,
        state_revision: outcome.stateRevision,
        state_delta_id: outcome.stateDeltaId,
      });
      return;
    }
    print('completion_result', { operation_id: operationId, command_id: commandId, committed: false, reason: outcome.reason });
  } finally {
    await client.end().catch(() => undefined);
  }
}

function controlRequestId(type: ControlRequestType, operationId: string): string {
  return `${type.toLowerCase()}-request-${operationId}`;
}

/** Persist a control intent without applying it; the executor applies it at a safe point. */
async function controlRequest(operationId: string, type: ControlRequestType): Promise<void> {
  const client = await connect();
  try {
    const persisted = await inTransaction(client, async () => {
      const row = await lockOperation(client, operationId);
      if (row === undefined) throw new Error(`operation ${operationId} does not exist`);
      const requestId = controlRequestId(type, operationId);
      const inserted = await client.query(
        "insert into control_requests(request_id, run_id, type, status) values ($1, $2, $3, 'PENDING') on conflict (request_id) do nothing",
        [requestId, row.runId, type],
      );
      if ((inserted.rowCount ?? 0) === 1) {
        await event(client, operationId, 'CONTROL_REQUEST_PERSISTED', { requestId, status: 'PENDING', type });
        await protocolCommit(client, operationId, 'CONTROL_REQUEST_PENDING');
      }
      return { requestId, inserted: (inserted.rowCount ?? 0) === 1 };
    });
    print('control_request_result', { operation_id: operationId, control_type: type, request_id: persisted.requestId, persisted: persisted.inserted });
  } finally {
    await client.end();
  }
}

async function controlApply(operationId: string, type: ControlRequestType): Promise<void> {
  const client = await connect();
  try {
    const requestId = controlRequestId(type, operationId);
    const locator = await client.query<{ run_id: string }>('select run_id from operations where id = $1', [operationId]);
    const locatedRun = locator.rows[0];
    if (locatedRun === undefined) throw new Error(`operation ${operationId} does not exist`);
    await inTransaction(client, async () => {
      await client.query(
        "insert into control_requests(request_id, run_id, type, status) values ($1, $2, $3, 'PENDING') on conflict (request_id) do nothing",
        [requestId, locatedRun.run_id, type],
      );
    });
    const outcome = await inTransaction(client, async () => {
      const row = await lockOperation(client, operationId);
      if (row === undefined) throw new Error(`operation ${operationId} does not exist`);
      await waitForLockedTransactionBarrier('control', operationId);
      const task = await client.query<{ task_status: string }>('select task_status from probe_tasks where id = $1 for update', [row.taskId]);
      const taskStatus = task.rows[0]?.task_status ?? 'missing';
      const terminal = row.runPhase === 'COMPLETED' || row.runPhase === 'CANCELLED' || taskStatus === 'DONE' || taskStatus === 'CANCELLED';
      if (terminal) {
        const record = await client.query<{ id: string }>('select id from completion_records where run_id = $1', [row.runId]);
        const resultRef = record.rows[0]?.id;
        await client.query(
          "update control_requests set status = 'REJECTED', applied_at = now(), result_ref = $2 where request_id = $1",
          [requestId, resultRef ?? null],
        );
        await event(client, operationId, 'CONTROL_REJECTED_ALREADY_TERMINAL', { requestId, runPhase: row.runPhase, taskStatus, type });
        await protocolCommit(client, operationId, 'CONTROL_REJECTED');
        return { applied: false, reason: 'already_terminal', resultRef: resultRef ?? '', runPhase: row.runPhase, taskStatus };
      }
      if (type === 'PAUSE') {
        await client.query("update probe_runs set phase = 'PAUSED', pause_reason = 'CONTROL_REQUEST_PAUSE' where id = $1 and phase in ('RUNNING', 'WAITING_APPROVAL')", [row.runId]);
        await client.query("update probe_tasks set task_status = 'WAITING' where id = $1 and task_status not in ('DONE', 'CANCELLED')", [row.taskId]);
      } else {
        await client.query("update probe_runs set phase = 'CANCELLED', pause_reason = null where id = $1 and phase in ('RUNNING', 'WAITING_APPROVAL', 'PAUSED')", [row.runId]);
        await client.query(
          "update probe_tasks set task_status = 'READY', owner_run_id = null, ownership_epoch = ownership_epoch + 1 where id = $1 and task_status not in ('DONE', 'CANCELLED')",
          [row.taskId],
        );
      }
      await client.query(
        "update control_requests set status = 'APPLIED', applied_at = now(), result_ref = $2 where request_id = $1 and status = 'PENDING'",
        [requestId, row.runId],
      );
      await event(client, operationId, 'CONTROL_APPLIED_AT_SAFE_POINT', { requestId, runId: row.runId, type });
      await protocolCommit(client, operationId, 'CONTROL_APPLIED');
      return {
        applied: true,
        reason: 'applied_at_safe_point',
        resultRef: row.runId,
        runPhase: type === 'PAUSE' ? 'PAUSED' : 'CANCELLED',
        taskStatus: type === 'PAUSE' ? 'WAITING' : 'READY',
      };
    });
    print('control_apply_result', {
      operation_id: operationId,
      control_type: type,
      applied: outcome.applied,
      reason: outcome.reason,
      run_phase: outcome.runPhase,
      task_status: outcome.taskStatus,
      result_ref: outcome.resultRef,
    });
  } finally {
    await client.end();
  }
}

/** Force the persisted claim lease to look expired; the live old process is unaffected. */
async function expireLease(operationId: string): Promise<void> {
  const client = await connect();
  try {
    await inTransaction(client, async () => {
      const updated = await client.query(
        "update probe_runs set lease_expires_at = now() - interval '1 second' where id = (select run_id from operations where id = $1) returning id",
        [operationId],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error(`cannot expire the claim lease for ${operationId}`);
      await event(client, operationId, 'CLAIM_LEASE_EXPIRED', { reason: 'experiment_forced' });
      await protocolCommit(client, operationId, 'LEASE_EXPIRED');
    });
    print('lease_expired', { operation_id: operationId });
  } finally {
    await client.end();
  }
}

function parseControlType(value: string | undefined): ControlRequestType {
  if (value !== 'PAUSE' && value !== 'CANCEL') {
    throw new Error('control type must be PAUSE or CANCEL');
  }
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  const operationId = process.argv[3];
  switch (command) {
    case 'setup':
      await setup();
      return;
    case 'prepare':
      if (operationId === undefined) throw new Error('prepare needs an operation id');
      await prepare(operationId);
      return;
    case 'approve':
      if (operationId === undefined) throw new Error('approve needs an operation id');
      await approve(operationId);
      return;
    case 'execute':
      if (operationId === undefined) throw new Error('execute needs an operation id');
      if (process.argv[4] !== undefined && process.argv[4] !== 'after-dispatch' && process.argv[4] !== 'after-external-effect' && process.argv[4] !== 'after-partial-write' && process.argv[4] !== 'after-prepared' && process.argv[4] !== 'hold-after-dispatch') {
        throw new Error('execute optional mode must be after-dispatch, hold-after-dispatch, after-prepared, after-partial-write, or after-external-effect');
      }
      await execute(operationId, process.argv[4] as 'after-dispatch' | 'after-external-effect' | 'after-partial-write' | 'after-prepared' | 'hold-after-dispatch' | undefined);
      return;
    case 'confirm-not-started':
      if (operationId === undefined) throw new Error('confirm-not-started needs an operation id');
      await confirmNotStarted(operationId);
      return;
    case 'reconcile':
      if (operationId === undefined) throw new Error('reconcile needs an operation id');
      await reconcile(operationId);
      return;
    case 'mutate':
      if (operationId === undefined || process.argv[4] === undefined) throw new Error('mutate needs an operation id and a field');
      await mutate(operationId, process.argv[4]);
      return;
    case 'complete':
      if (operationId === undefined || process.argv[4] === undefined) throw new Error('complete needs an operation id and a command id');
      if (process.argv[5] !== undefined && process.argv[5] !== 'after-completion-commit') {
        throw new Error('complete optional mode must be after-completion-commit');
      }
      await complete(operationId, process.argv[4], process.argv[5] as 'after-completion-commit' | undefined);
      return;
    case 'control-request':
      if (operationId === undefined) throw new Error('control-request needs an operation id');
      await controlRequest(operationId, parseControlType(process.argv[4]));
      return;
    case 'control-apply':
      if (operationId === undefined) throw new Error('control-apply needs an operation id');
      await controlApply(operationId, parseControlType(process.argv[4]));
      return;
    case 'expire-lease':
      if (operationId === undefined) throw new Error('expire-lease needs an operation id');
      await expireLease(operationId);
      return;
    default:
      throw new Error('command must be setup, prepare, approve, execute, confirm-not-started, reconcile, mutate, complete, control-request, control-apply, or expire-lease');
  }
}

void main().catch((error: unknown) => {
  if (error instanceof InjectedFault) {
    print('injected_fault_after_rollback', { point: error.point, exit_code: 76 });
    process.exit(76);
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
