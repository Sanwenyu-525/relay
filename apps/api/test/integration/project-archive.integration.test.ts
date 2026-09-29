import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { cancelAssistMessage, createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { prepareGatewayAction } from '../../src/application/gateway-actions.js';
import { createFakeConnection, createGatewayPolicy,
  createImportJob } from '../../src/application/gateway-configuration.js';
import { lockWritableProjectInWorkspace } from '../../src/application/guards.js';
import { recordModelInvocation } from '../../src/application/model-call-recorder.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { postgresErrorCode } from '../../src/infrastructure/postgres-error.js';
import { ModelCallRepository, ModelScopeArchivedError } from '../../src/model/model-call-repository.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';
import { createWorkspace, delay, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-project-archive');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const commandId = randomUUID();
  const created = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title: 'Archivable project', project_type: 'GENERAL',
  });
  const result = expectCommandAccepted(created, 201, commandId);
  return { workspaceId, projectId: result.project_id as string,
    revision: result.revision as string };
}

async function createTask(workspaceId: string, projectId: string) {
  const commandId = randomUUID();
  const created = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId, project_id: projectId, title: 'Archive task',
    objective: 'Check archive', criteria: [{ statement: 'Review result' }],
  });
  const result = expectCommandAccepted(created, 201, commandId);
  return { taskId: result.task_id as string, revision: result.revision as string };
}

async function archive(workspaceId: string, projectId: string, revision: string,
  commandId = randomUUID()) {
  return api.post(workspacePath(workspaceId, `/projects/${projectId}/archive`), {
    command_id: commandId, expected_revision: revision,
  });
}

function blockers(response: Awaited<ReturnType<typeof archive>>): string[] {
  const problem = expectProblem(response, 409, 'PROJECT_ARCHIVE_BLOCKED');
  return (problem.conflict as { blocking_reasons: string[] }).blocking_reasons;
}

async function terminalAssistMessage(workspaceId: string, projectId: string): Promise<string> {
  const session = await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Archived call fence' });
  const request = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: 'Old call' });
  const messageId = request.result.assistant_message_id;
  await sql`update assist_messages set status = 'FAILED' where id = ${messageId}`.execute(app.db);
  return messageId;
}

function modelCall(workspaceId: string, messageId: string): Promise<void> {
  return new ModelCallRepository(app.db).begin(randomUUID(), {
    workspaceId, kind: 'ASSIST', assistMessageId: messageId,
  }, { provider: 'archive-test', model: 'archive-test',
    configFingerprint: 'b'.repeat(64), budget: {
      callReservationTokens: 100, scopeCallLimit: 3, scopeTokenLimit: 1000,
    } });
}

async function waitForProjectLock(projectId: string, lock: 'update' | 'key share') {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if (lock === 'update') {
        await sql`select id from projects where id = ${projectId} for update nowait`
          .execute(app.db);
      } else {
        await sql`select id from projects where id = ${projectId} for key share nowait`
          .execute(app.db);
      }
    } catch (error) {
      if (postgresErrorCode(error) === '55P03') return;
      throw error;
    }
    await delay(50);
  }
  assert.fail(`Project ${lock} did not encounter the expected archive gate`);
}

test('ArchiveProject is one scoped CAS command, preserves history, and rejects future writes', async () => {
  const { workspaceId, projectId, revision } = await fixture();
  const task = await createTask(workspaceId, projectId);
  const otherWorkspace = await createWorkspace(app.db);
  const commandId = randomUUID();
  expectProblem(await archive(otherWorkspace, projectId, revision), 404, 'RESOURCE_NOT_FOUND');
  expectProblem(await archive(workspaceId, projectId, '9'), 409, 'REVISION_CONFLICT');
  const first = await archive(workspaceId, projectId, revision, commandId);
  const result = expectCommandAccepted(first, 200, commandId);
  assert.equal(result.archive_status, 'ARCHIVED');
  assert.equal(result.revision, '1');
  assert.equal(typeof result.archived_at, 'string');
  assert.equal((first.body as { links: { resource: string } }).links.resource,
    workspacePath(workspaceId, `/projects/${projectId}`));
  const replay = await archive(workspaceId, projectId, revision, commandId);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual(replay.body, first.body);
  expectProblem(await api.post(workspacePath(workspaceId, `/projects/${projectId}/archive`), {
    command_id: commandId, expected_revision: '1',
  }), 409, 'COMMAND_ID_REUSED');
  expectProblem(await archive(workspaceId, projectId, '1'), 409, 'PROJECT_ARCHIVED');
  const receipt = await api.get(workspacePath(workspaceId, `/commands/${commandId}`));
  assert.equal(receipt.status, 200, receipt.text);
  assert.deepEqual((receipt.body as { result: unknown }).result, result);
  const activity = await sql<{ count: string }>`select count(*)::text as count
    from activity_records where project_id = ${projectId} and event_type = 'PROJECT_ARCHIVED'`
    .execute(app.db);
  assert.equal(activity.rows[0]?.count, '1');
  const activities = await api.get(workspacePath(workspaceId,
    `/activities?project_id=${projectId}`));
  assert.equal(activities.status, 200, activities.text);
  const archiveActivity = (activities.body as { items: { event_type: string;
    summary: string }[] }).items.find((item) => item.event_type === 'PROJECT_ARCHIVED');
  assert.equal(archiveActivity?.summary, '归档项目');
  assert.equal((await api.get(workspacePath(workspaceId,
    `/projects/${projectId}`))).status, 200);
  assert.equal((await api.get(workspacePath(workspaceId,
    `/tasks/${task.taskId}`))).status, 200);
  expectProblem(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: randomUUID(), project_id: projectId, title: 'Late task',
    objective: 'Must fail', criteria: [{ statement: 'Check' }],
  }), 409, 'PROJECT_ARCHIVED');
});

test('HUMAN work and a delegated live Run each block archive without changing Project', async () => {
  const human = await fixture();
  const humanTask = await createTask(human.workspaceId, human.projectId);
  const humanReadyCommand = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(human.workspaceId,
    `/tasks/${humanTask.taskId}/ready`), {
    command_id: humanReadyCommand, expected_revision: humanTask.revision,
  }), 200, humanReadyCommand);
  const humanStartCommand = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(human.workspaceId,
    `/tasks/${humanTask.taskId}/start`), {
    command_id: humanStartCommand, expected_revision: ready.revision,
  }), 200, humanStartCommand);
  assert.deepEqual(blockers(await archive(human.workspaceId, human.projectId,
    human.revision)), ['TASK_ACTIVE']);

  const ai = await fixture();
  const aiTask = await createTask(ai.workspaceId, ai.projectId);
  const aiReadyCommand = randomUUID();
  const aiReady = expectCommandAccepted(await api.post(workspacePath(ai.workspaceId,
    `/tasks/${aiTask.taskId}/ready`), {
    command_id: aiReadyCommand, expected_revision: aiTask.revision,
  }), 200, aiReadyCommand);
  const delegated = await api.post(workspacePath(ai.workspaceId,
    `/tasks/${aiTask.taskId}/delegations`), {
    command_id: randomUUID(), expected_task_revision: aiReady.revision,
  });
  assert.equal(delegated.status, 202, delegated.text);
  const reasons = blockers(await archive(ai.workspaceId, ai.projectId, ai.revision));
  assert.ok(reasons.includes('TASK_ACTIVE'));
  assert.ok(reasons.includes('RUN_UNSETTLED'));
  const archived = await sql<{ archived_at: Date | null }>`select archived_at from projects
    where id = ${ai.projectId}`.execute(app.db);
  assert.equal(archived.rows[0]?.archived_at, null);
});

test('pending Import and Assist generation block archive even before external dispatch', async () => {
  const f = await fixture();
  await createImportJob(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    actorRef: 'human:test', configVersion: 'test', commandId: randomUUID(),
    sourceUri: 'https://public.example/data' });
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: 'Pending assist' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: 'Summarize' });
  assert.deepEqual(blockers(await archive(f.workspaceId, f.projectId, f.revision)),
    ['IMPORT_IN_FLIGHT', 'ASSIST_IN_FLIGHT']);
  // 共享库按 created_at 全局领取 PENDING 助手消息；本用例只为验证归档阻断，
  // 不清理会让后续 project-blueprint 的 tick 先消费这条遗留消息。
  await cancelAssistMessage(app.db, { workspaceId: f.workspaceId,
    messageId: requested.result.assistant_message_id, commandId: randomUUID() });
});

test('prepared Gateway identity and UNKNOWN remain blockers after Import is terminal', async () => {
  const f = await fixture();
  const sourceUri = 'https://public.example/archive-gate';
  const job = await createImportJob(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, actorRef: 'human:test', configVersion: 'fixture',
    commandId: randomUUID(), sourceUri });
  const connection = await createFakeConnection(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capabilities: ['FAKE_PUBLIC_READ'] });
  await createGatewayPolicy(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, capability: 'FAKE_PUBLIC_READ',
    actionType: 'READ_PUBLIC', targetPrefix: 'https://public.example/',
    decision: 'AUTO', maxPayloadBytes: 1024 });
  const operationId = randomUUID();
  const prepared = await prepareGatewayAction(app.db, { workspaceId: f.workspaceId,
    operationId, intentKey: 'read', connectionId: connection.connectionId,
    origin: { kind: 'USER_IMPORT', importJobId: job.importJobId,
      actorRef: 'human:test', configVersion: 'fixture' },
    actionType: 'READ_PUBLIC', target: sourceUri, params: {} });
  assert.equal(prepared.status, 'PREPARED');
  await sql`update import_jobs set status = 'SUCCEEDED' where id = ${job.importJobId}`
    .execute(app.db);
  assert.deepEqual(blockers(await archive(f.workspaceId, f.projectId, f.revision)),
    ['GATEWAY_UNSETTLED']);
  await sql`update logical_operations set status = 'UNKNOWN'
    where id = ${operationId}`.execute(app.db);
  await sql`update invocation_attempts set status = 'UNKNOWN'
    where operation_id = ${operationId}`.execute(app.db);
  assert.deepEqual(blockers(await archive(f.workspaceId, f.projectId, f.revision)),
    ['UNKNOWN_EFFECT']);
});

test('a quarantined resource claim blocks archive even if its lease would have expired', async () => {
  const f = await fixture();
  const task = await createTask(f.workspaceId, f.projectId);
  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(f.workspaceId,
    `/tasks/${task.taskId}/ready`), {
    command_id: readyCommand, expected_revision: task.revision,
  }), 200, readyCommand);
  const delegated = await api.post(workspacePath(f.workspaceId,
    `/tasks/${task.taskId}/delegations`), {
    command_id: randomUUID(), expected_task_revision: ready.revision,
  });
  assert.equal(delegated.status, 202, delegated.text);
  const runId = (delegated.body as { result: { run_id: string } }).result.run_id;
  const resourceId = randomUUID();
  await sql`insert into managed_resources (id, workspace_id, project_id,
      canonical_root, identity_key, status) values
    (${resourceId}, ${f.workspaceId}, ${f.projectId},
      ${`archive-fixture-${resourceId}`}, ${`archive-fixture-${resourceId}`}, 'ACTIVE')`
    .execute(app.db);
  await sql`insert into resource_claims (id, workspace_id, project_id, resource_id,
      task_id, run_id, worker_id, worker_epoch, claim_epoch, claim_token, status)
    values (${randomUUID()}, ${f.workspaceId}, ${f.projectId}, ${resourceId},
      ${task.taskId}, ${runId}, 'stopped-worker', 1, 1, ${randomUUID()}, 'QUARANTINED')`
    .execute(app.db);
  const reasons = blockers(await archive(f.workspaceId, f.projectId, f.revision));
  assert.ok(reasons.includes('RESOURCE_CLAIM_UNSETTLED'));
});

test('STARTED model call and OPEN Project Review remain explicit blockers after owner statuses settle', async () => {
  const f = await fixture();
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: 'Model evidence' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: 'Summarize' });
  const messageId = requested.result.assistant_message_id;
  await sql`update assist_messages set status = 'FAILED' where id = ${messageId}`.execute(app.db);
  await sql`insert into model_calls (id, workspace_id, kind, assist_message_id,
      provider, model, config_fingerprint, status, budget_reserved_tokens)
    values (${randomUUID()}, ${f.workspaceId}, 'ASSIST', ${messageId},
      'fake', 'fake', ${'a'.repeat(64)}, 'STARTED', 100)` .execute(app.db);
  assert.deepEqual(blockers(await archive(f.workspaceId, f.projectId, f.revision)),
    ['MODEL_CALL_STARTED']);
  await sql`update model_calls set status = 'FAILED', error_kind = 'test',
      settled_at = now() where assist_message_id = ${messageId}`.execute(app.db);
  await sql`insert into review_requests (id, workspace_id, project_id, kind, reason,
      status, target_hash, target, evidence, effect, allowed_decisions)
    values (${randomUUID()}, ${f.workspaceId}, ${f.projectId}, 'STATE_PROPOSAL',
      'Project decision', 'OPEN', ${Buffer.alloc(32)}, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, array['ACCEPT']::text[])`.execute(app.db);
  assert.deepEqual(blockers(await archive(f.workspaceId, f.projectId, f.revision)),
    ['REVIEW_OPEN']);
});

test('a real ArchiveProject waits for an earlier writable gate and then sees its commit', async () => {
  const f = await fixture();
  let releaseWriter!: () => void;
  let writerLocked!: () => void;
  const locked = new Promise<void>((resolve) => { writerLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = app.db.transaction().execute(async (trx) => {
    await lockWritableProjectInWorkspace(createRepositories(trx), f.workspaceId, f.projectId);
    writerLocked();
    await release;
    await sql`update project_states set phase_key = 'EXECUTING', revision = revision + 1
      where project_id = ${f.projectId}`.execute(trx);
  });
  await locked;
  let finished = false;
  const pending = archive(f.workspaceId, f.projectId, f.revision).then((response) => {
    finished = true;
    return response;
  });
  await delay(150);
  assert.equal(finished, false);
  releaseWriter();
  await writer;
  const archived = await pending;
  assert.equal(archived.status, 200, archived.text);
  const state = await sql<{ phase_key: string }>`select phase_key from project_states
    where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(state.rows[0]?.phase_key, 'EXECUTING');
});

test('ArchiveProject holding Project FOR UPDATE makes a later Task write fail after commit', async () => {
  const f = await fixture();
  const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-archive-audit-barrier');
  let releaseAudit!: () => void;
  let signalAudit!: () => void;
  const auditLocked = new Promise<void>((resolve) => { signalAudit = resolve; });
  const release = new Promise<void>((resolve) => { releaseAudit = resolve; });
  const auditBarrier = migrator.db.transaction().execute(async (trx) => {
    // Pause only the final audit insert, after ArchiveProject has taken the
    // Project lock and passed its blocker checks. No production hook is added.
    await sql`lock table activity_records in access exclusive mode`.execute(trx);
    signalAudit();
    await release;
  });
  try {
    await auditLocked;
    const pendingArchive = archive(f.workspaceId, f.projectId, f.revision);
    await waitForProjectLock(f.projectId, 'key share');
    let writerFinished = false;
    const pendingWriter = api.post(workspacePath(f.workspaceId, '/tasks'), {
      command_id: randomUUID(), project_id: f.projectId, title: 'Raced after archive',
      objective: 'Must not commit', criteria: [{ statement: 'Check' }],
    }).then((response) => { writerFinished = true; return response; });
    await delay(150);
    assert.equal(writerFinished, false, 'Task write must wait for the archive decision');
    releaseAudit();
    await auditBarrier;
    const archived = await pendingArchive;
    assert.equal(archived.status, 200, archived.text);
    expectProblem(await pendingWriter, 409, 'PROJECT_ARCHIVED');
    const late = await sql<{ count: string }>`select count(*)::text as count from tasks
      where project_id = ${f.projectId} and title = 'Raced after archive'`.execute(app.db);
    assert.equal(late.rows[0]?.count, '0');
  } finally {
    releaseAudit();
    await auditBarrier;
    await migrator.close();
  }
});

test('model STARTED reservation before Archive blocks the later archive decision', async () => {
  const f = await fixture();
  const messageId = await terminalAssistMessage(f.workspaceId, f.projectId);
  const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-model-call-barrier');
  let releaseCalls!: () => void;
  let signalCalls!: () => void;
  const callsLocked = new Promise<void>((resolve) => { signalCalls = resolve; });
  const release = new Promise<void>((resolve) => { releaseCalls = resolve; });
  const barrier = migrator.db.transaction().execute(async (trx) => {
    await sql`lock table model_calls in access exclusive mode`.execute(trx);
    signalCalls();
    await release;
  });
  try {
    await callsLocked;
    const pendingCall = modelCall(f.workspaceId, messageId);
    await waitForProjectLock(f.projectId, 'update');
    let archiveFinished = false;
    const pendingArchive = archive(f.workspaceId, f.projectId, f.revision)
      .then((response) => { archiveFinished = true; return response; });
    await delay(150);
    assert.equal(archiveFinished, false);
    releaseCalls();
    await barrier;
    await pendingCall;
    assert.deepEqual(blockers(await pendingArchive), ['MODEL_CALL_STARTED']);
  } finally {
    releaseCalls();
    await barrier;
    await migrator.close();
  }
});

test('Archive row lock before model reservation rejects the old call without Provider work', async () => {
  const f = await fixture();
  const messageId = await terminalAssistMessage(f.workspaceId, f.projectId);
  const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-archive-before-call');
  let releaseAudit!: () => void;
  let signalAudit!: () => void;
  const auditLocked = new Promise<void>((resolve) => { signalAudit = resolve; });
  const release = new Promise<void>((resolve) => { releaseAudit = resolve; });
  const barrier = migrator.db.transaction().execute(async (trx) => {
    await sql`lock table activity_records in access exclusive mode`.execute(trx);
    signalAudit();
    await release;
  });
  try {
    await auditLocked;
    const pendingArchive = archive(f.workspaceId, f.projectId, f.revision);
    await waitForProjectLock(f.projectId, 'key share');
    let callSettled = false;
    const pendingCall = modelCall(f.workspaceId, messageId)
      .then(() => { callSettled = true; return { error: null }; },
        (error: unknown) => { callSettled = true; return { error }; });
    await delay(150);
    assert.equal(callSettled, false);
    releaseAudit();
    await barrier;
    assert.equal((await pendingArchive).status, 200);
    assert.ok((await pendingCall).error instanceof ModelScopeArchivedError);
    const calls = await sql<{ count: string }>`select count(*)::text as count from model_calls
      where assist_message_id = ${messageId}`.execute(app.db);
    assert.equal(calls.rows[0]?.count, '0');
  } finally {
    releaseAudit();
    await barrier;
    await migrator.close();
  }
});

test('a terminal Run with an old running Step blocks archive, and its stale model path cannot call Provider after archive', async () => {
  const f = await fixture();
  const task = await createTask(f.workspaceId, f.projectId);
  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(f.workspaceId,
    `/tasks/${task.taskId}/ready`), {
    command_id: readyCommand, expected_revision: task.revision,
  }), 200, readyCommand);
  const delegated = await api.post(workspacePath(f.workspaceId,
    `/tasks/${task.taskId}/delegations`), {
    command_id: randomUUID(), expected_task_revision: ready.revision,
  });
  assert.equal(delegated.status, 202, delegated.text);
  const runId = (delegated.body as { result: { run_id: string } }).result.run_id;
  const step = (await sql<{ id: string }>`select id from run_steps
    where run_id = ${runId} and step_kind = 'VERIFY'`.execute(app.db)).rows[0]!;
  const attemptId = randomUUID();
  await sql`insert into step_attempts (id, step_id, attempt_number, attempt_key,
      status, finished_at) values
    (${attemptId}, ${step.id}, 1, 'old-terminal-run', 'SUCCEEDED', now())`
    .execute(app.db);
  await app.db.transaction().execute(async (trx) => {
    await sql`update runs set status = 'FAILED', terminal_at = now()
      where id = ${runId}`.execute(trx);
    await sql`update tasks set status = 'READY', executor_kind = 'HUMAN',
      executor_run_id = null, ownership_epoch = ownership_epoch + 1,
      revision = revision + 1 where id = ${task.taskId}`.execute(trx);
    await sql`update run_command_outbox set status = 'DONE', settled_at = now()
      where command_id in (select id from run_commands where run_id = ${runId})`
      .execute(trx);
    await sql`update run_steps set status = 'RUNNING', started_at = now()
      where id = ${step.id}`.execute(trx);
  });
  assert.deepEqual(blockers(await archive(f.workspaceId, f.projectId, f.revision)),
    ['RUN_UNSETTLED']);
  await sql`update run_steps set status = 'SUCCEEDED', finished_at = now()
    where id = ${step.id}`.execute(app.db);
  assert.equal((await archive(f.workspaceId, f.projectId, f.revision)).status, 200);
  let invoked = false;
  await assert.rejects(() => recordModelInvocation(app.db, {
    origin: { workspaceId: f.workspaceId, kind: 'SEMANTIC_CHECK',
      stepAttemptId: attemptId, criterionId: 'old-check', checkAttempt: 1 },
    identity: { provider: 'archive-test', model: 'archive-test',
      configFingerprint: 'b'.repeat(64), budget: {
        callReservationTokens: 100, scopeCallLimit: 3, scopeTokenLimit: 1000,
      } },
    invoke: async () => { invoked = true; return 'unexpected'; },
    settle: () => ({ status: 'COMPLETED' }),
  }), ModelScopeArchivedError);
  assert.equal(invoked, false);
  const calls = await sql<{ count: string }>`select count(*)::text as count from model_calls
    where step_attempt_id = ${attemptId}`.execute(app.db);
  assert.equal(calls.rows[0]?.count, '0');
});
