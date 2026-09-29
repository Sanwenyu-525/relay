import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { readAssistSession } from '../../src/application/assist-queries.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createTask } from '../../src/application/create-task.js';
import { DomainError } from '../../src/application/domain-error.js';
import { createFakeConnection, createImportJob, setFakeConnection } from '../../src/application/gateway-configuration.js';
import { lockWritableProjectInWorkspace } from '../../src/application/guards.js';
import { addKnowledgeVersion, createKnowledge, createRule } from '../../src/application/information-commands.js';
import { linkProjectGoal } from '../../src/application/project-goal-links.js';
import { runStateCommand } from '../../src/application/state-commands.js';
import { setTaskSelection } from '../../src/application/today-commands.js';
import { setViewConfiguration } from '../../src/application/view-configuration-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';
import { createWorkspace, delay, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-project-archive-gate');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => {
  await api?.stop();
  await app.close();
});

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const created = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: randomUUID(), title: 'Archive gate', project_type: 'GENERAL',
  });
  const projectId = expectCommandAccepted(created, 201,
    (created.body as { command_id: string }).command_id).project_id as string;
  const taskResponse = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: randomUUID(), project_id: projectId, title: 'Existing task',
    objective: 'Verify archive gate', criteria: [{ statement: 'Human check' }],
  });
  const taskId = (taskResponse.body as { result: { task_id: string } }).result.task_id;
  assert.equal(taskResponse.status, 201, taskResponse.text);
  return { workspaceId, projectId, taskId };
}

function archived(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'PROJECT_ARCHIVED';
}

test('archived Project blocks Task, State, Information, Rule, View, Today, Assist and Gateway writes', async () => {
  const { workspaceId, projectId, taskId } = await fixture();
  const oldKnowledge = await createKnowledge(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Historical note',
    source: { sourceKind: 'NOTE', text: 'old content' } });
  const oldConnection = await createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: ['FAKE_PUBLIC_READ'] });
  const oldSession = await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Historical session' });
  await sql`update projects set archived_at = now() where id = ${projectId}`.execute(app.db);

  await assert.rejects(createTask(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Forbidden', objective: 'No write',
    criteria: [{ statement: 'Check' }], expectedOutputs: {}, mode: 'ME' }), archived);
  expectProblem(await api.post(workspacePath(workspaceId, `/tasks/${taskId}/ready`), {
    command_id: randomUUID(), expected_revision: '0',
  }), 409, 'PROJECT_ARCHIVED');
  await assert.rejects(runStateCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), expectedRevision: '0', action: 'SET_NEXT_ACTION',
    params: { next_action_task_id: null } }), archived);
  await assert.rejects(linkProjectGoal(app.db, { workspaceId, projectId,
    commandId: randomUUID(), expectedRevision: '0', goalId: randomUUID() }), archived);
  await assert.rejects(createKnowledge(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Forbidden note',
    source: { sourceKind: 'NOTE', text: 'content' } }), archived);
  await assert.rejects(addKnowledgeVersion(app.db, { workspaceId,
    commandId: randomUUID(), knowledgeId: oldKnowledge.result.knowledge_id!,
    expectedRevision: '0', source: { sourceKind: 'NOTE', text: 'new content' } }), archived);
  const rule = { workspaceId, commandId: randomUUID(), ruleKey: 'archive-check',
    statement: 'Check archive', strength: 'HARD' as const,
    applicability: 'AI_RUN' as const, enforcement: 'HUMAN' as const };
  await assert.rejects(createRule(app.db, { ...rule, scope: 'PROJECT',
    scopeId: projectId }), archived);
  await assert.rejects(createRule(app.db, { ...rule, commandId: randomUUID(),
    scope: 'TASK', scopeId: taskId }), archived);
  await assert.rejects(setViewConfiguration(app.db, { workspaceId, projectId,
    commandId: randomUUID(), expectedRevision: '0', kind: 'general' }), archived);
  await assert.rejects(setTaskSelection(app.db, { workspaceId, taskId,
    commandId: randomUUID(), expectedRevision: '0', pin: true,
    laterLocalDate: null, timezone: null }), archived);
  await assert.rejects(createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Forbidden assist' }), archived);
  await assert.rejects(requestAssistMessage(app.db, { workspaceId,
    sessionId: oldSession.result.session_id, commandId: randomUUID(),
    content: 'Forbidden message' }), archived);
  await assert.rejects(createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: ['FAKE_PUBLIC_READ'] }), archived);
  await assert.rejects(setFakeConnection(app.db, { workspaceId,
    connectionId: oldConnection.connectionId, status: 'DISABLED', config: {} }), archived);
  await assert.rejects(createImportJob(app.db, { workspaceId, projectId,
    actorRef: 'human:test', configVersion: 'test', commandId: randomUUID(),
    sourceUri: 'https://public.example/example' }), archived);

  // Workspace rules do not become Project writes merely because the Workspace
  // also contains an archived Project.
  const workspaceRule = await createRule(app.db, { ...rule,
    commandId: randomUUID(), scope: 'WORKSPACE', scopeId: workspaceId });
  assert.ok(workspaceRule.result.rule_id);
  assert.equal((await readAssistSession(app.db, { workspaceId,
    sessionId: oldSession.result.session_id })).title, 'Historical session');
  assert.equal((await api.get(workspacePath(workspaceId, `/projects/${projectId}`))).status, 200);
  const historicalTask = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));
  assert.equal(historicalTask.status, 200);
  assert.deepEqual((historicalTask.body as { allowed_actions: string[] }).allowed_actions, []);
  const today = await api.get(workspacePath(workspaceId,
    '/today?date=2026-09-26&timezone=Asia%2FShanghai'));
  assert.equal(today.status, 200, today.text);
  assert.equal(JSON.stringify(today.body).includes(taskId), false);
});

test('Project FOR UPDATE serializes a concurrent CreateTask before commit', async () => {
  const { workspaceId, projectId } = await fixture();
  let releaseArchive!: () => void;
  let signalLocked!: () => void;
  const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseArchive = resolve; });
  const archiveStandIn = app.db.transaction().execute(async (trx) => {
    await sql`select id from projects where id = ${projectId} for update`.execute(trx);
    signalLocked();
    await release;
    await sql`update projects set archived_at = now() where id = ${projectId}`.execute(trx);
  });
  await locked;
  let completed = false;
  const responsePromise = api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: randomUUID(), project_id: projectId, title: 'Racing task',
    objective: 'Must not commit after archive', criteria: [{ statement: 'Check' }],
  }).then((response) => { completed = true; return response; });
  await delay(150);
  assert.equal(completed, false, 'writer must wait for the Project serial point');
  releaseArchive();
  await archiveStandIn;
  expectProblem(await responsePromise, 409, 'PROJECT_ARCHIVED');
  const rows = await sql<{ count: string }>`select count(*)::text as count from tasks
    where project_id = ${projectId} and title = 'Racing task'`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
});

test('a held writable gate makes the archive row lock wait for the writer commit', async () => {
  const { workspaceId, projectId } = await fixture();
  let releaseWriter!: () => void;
  let signalGate!: () => void;
  const gated = new Promise<void>((resolve) => { signalGate = resolve; });
  const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = app.db.transaction().execute(async (trx) => {
    await lockWritableProjectInWorkspace(createRepositories(trx), workspaceId, projectId);
    signalGate();
    await release;
    await sql`update project_states set phase_key = 'EXECUTION', revision = revision + 1
      where project_id = ${projectId}`.execute(trx);
  });
  await gated;
  let archiveLocked = false;
  const archive = app.db.transaction().execute(async (trx) => {
    await sql`select id from projects where id = ${projectId} for update`.execute(trx);
    archiveLocked = true;
    await sql`update projects set archived_at = now() where id = ${projectId}`.execute(trx);
  });
  await delay(150);
  assert.equal(archiveLocked, false);
  releaseWriter();
  await writer;
  await archive;
  const state = await sql<{ phase_key: string }>`select phase_key from project_states
    where project_id = ${projectId}`.execute(app.db);
  assert.equal(state.rows[0]?.phase_key, 'EXECUTION');
  const archivedProject = await api.get(workspacePath(workspaceId, `/projects/${projectId}`));
  assert.equal((archivedProject.body as { archived_at: string | null }).archived_at !== null, true);
});

test('Artifact publication cannot begin after the Project was archived', async () => {
  const { workspaceId, projectId, taskId } = await fixture();
  const ready = await api.post(workspacePath(workspaceId, `/tasks/${taskId}/ready`), {
    command_id: randomUUID(), expected_revision: '0',
  });
  assert.equal(ready.status, 200, ready.text);
  const readyRevision = (ready.body as { result: { revision: string } }).result.revision;
  const started = await api.post(workspacePath(workspaceId, `/tasks/${taskId}/start`), {
    command_id: randomUUID(), expected_revision: readyRevision,
  });
  assert.equal(started.status, 200, started.text);
  const currentRevision = (started.body as { result: { revision: string } }).result.revision;
  const filesBefore = await readdir(api.dataRoot, { recursive: true });
  await sql`update projects set archived_at = now() where id = ${projectId}`.execute(app.db);
  expectProblem(await api.post(workspacePath(workspaceId, `/tasks/${taskId}/artifacts`), {
    command_id: randomUUID(), expected_task_revision: currentRevision,
    title: 'Forbidden version', media_type: 'text/markdown', content: '# No write',
  }), 409, 'PROJECT_ARCHIVED');
  assert.deepEqual(await readdir(api.dataRoot, { recursive: true }), filesBefore);
  const count = await sql<{ count: string }>`select count(*)::text as count from artifacts
    where task_id = ${taskId}`.execute(app.db);
  assert.equal(count.rows[0]?.count, '0');
});

test('Assist worker does not claim an archived Project message or call the model', async () => {
  const { workspaceId, projectId } = await fixture();
  const session = await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: 'Pending before archive' });
  const message = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: 'Discuss' });
  // The future ArchiveProject command must reject a PENDING message. This
  // direct SQL fixture verifies the Worker gate even for an invalid old row.
  await sql`update projects set archived_at = now() where id = ${projectId}`.execute(app.db);
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'archive-gate-worker',
    storage: new ManagedContentStore(api.dataRoot), modelPort: new FakeModelPort(),
    leaseMs: 30_000 });
  assert.equal(outcome, undefined);
  const row = await sql<{ status: string }>`select status from assist_messages
    where id = ${message.result.assistant_message_id}`.execute(app.db);
  assert.equal(row.rows[0]?.status, 'PENDING');
  const calls = await sql<{ count: string }>`select count(*)::text as count from model_calls
    where assist_message_id = ${message.result.assistant_message_id}`.execute(app.db);
  assert.equal(calls.rows[0]?.count, '0');
});
