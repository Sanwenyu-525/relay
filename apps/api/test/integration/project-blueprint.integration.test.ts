import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createGoal } from '../../src/application/create-goal.js';
import { createProject } from '../../src/application/create-project.js';
import { createKnowledge, retireInformation }
  from '../../src/application/information-commands.js';
import { cancelAssistMessage, createAssistSession,
  requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { setViewConfiguration } from '../../src/application/view-configuration-commands.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createWorkspace, expectCommandAccepted, expectProblem,
  createDataRoot, delay, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m05-blueprint');
let dataRoot: string;
let storage: ManagedContentStore;
const modelPort = new FakeModelPort();
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

function newDraft(goalId: string) {
  return { intent: '将研究目标拆为可审查任务', goal_id: goalId,
    phase_key: 'LITERATURE',
    tasks: [{ local_key: 'survey', title: '整理文献', objective: '形成文献列表' },
      { local_key: 'outline', title: '论文提纲', objective: '形成人工审查提纲' }],
    next_action: { kind: 'NEW_TASK', local_key: 'survey' },
    view_kind: 'development', pack_ref: null };
}

test('Blueprint preview, atomic Apply, exact mappings and replay use real owners', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId,
    commandId: randomUUID(), title: '蓝图事务', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const goal = await createGoal(app.db, { workspaceId,
    commandId: randomUUID(), title: '完成论文', description: '' });
  const api = await startTestApi();
  try {
    const path = `${workspacePath(workspaceId)}/projects/${projectId}/blueprint-proposals`;
    const createCommandId = randomUUID();
    const createBody = { command_id: createCommandId,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0', draft: newDraft(goal.result.goal_id) };
    const created = expectCommandAccepted(await api.post(path, createBody), 201,
      createCommandId) as { id: string; status: string; candidate_sha256: string;
        diff: { new_tasks: unknown[]; view_configuration: {
          after: { pages: { page_id: string }[] }; changed: boolean } } };
    assert.equal(created.status, 'PENDING');
    assert.equal(created.diff.new_tasks.length, 2);
    assert.equal(created.diff.view_configuration.changed, true);
    assert.deepEqual(created.diff.view_configuration.after.pages.map((page) => page.page_id),
      ['state', 'tasks', 'runs', 'connections', 'reviews']);
    const replay = await api.post(path, createBody);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.equal((replay.body as { result: { id: string } }).result.id, created.id);
    const read = await api.get(`${path}/${created.id}`);
    assert.equal(read.status, 200);
    assert.equal((read.body as { stale: boolean }).stale, false);
    const otherWorkspace = await createWorkspace(app.db);
    expectProblem(await api.get(`${workspacePath(otherWorkspace)}` +
      `/projects/${projectId}/blueprint-proposals/${created.id}`),
    404, 'RESOURCE_NOT_FOUND');
    const unknown = await api.post(path, { ...createBody,
      command_id: randomUUID(), draft: { ...newDraft(goal.result.goal_id),
        custom_pages: ['arbitrary'] } });
    expectProblem(unknown, 422, 'VALIDATION_FAILED');

    const applyCommandId = randomUUID();
    const applyBody = { command_id: applyCommandId,
      candidate_sha256: created.candidate_sha256,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0' };
    const applied = expectCommandAccepted(await api.post(`${path}/${created.id}/apply`,
      applyBody), 200, applyCommandId) as {
        project_revision: string; state_revision: string; view_revision: string;
        goal_ids: string[]; task_id_map: { local_key: string; task_id: string }[];
        next_action_task_id: string; view_configuration: {
          kind: string; pages: { page_id: string }[] };
      };
    assert.equal(applied.project_revision, '1');
    assert.equal(applied.state_revision, '2');
    assert.equal(applied.view_revision, '1');
    assert.deepEqual(applied.goal_ids, [goal.result.goal_id]);
    assert.deepEqual(applied.task_id_map.map((entry) => entry.local_key),
      ['survey', 'outline']);
    assert.equal(applied.next_action_task_id, applied.task_id_map[0]!.task_id);
    assert.equal(applied.view_configuration.kind, 'development');
    const applyReplay = await api.post(`${path}/${created.id}/apply`, applyBody);
    assert.equal(applyReplay.headers['command-replayed'], 'true');
    const anotherCommand = await api.post(`${path}/${created.id}/apply`,
      { ...applyBody, command_id: randomUUID() });
    assert.equal(anotherCommand.headers['command-replayed'], 'true');
    const rows = await sql<{ status: string; mode: string;
      executor_kind: string }>`select status, mode, executor_kind from tasks
      where project_id = ${projectId} order by title`.execute(app.db);
    assert.equal(rows.rows.length, 2);
    assert(rows.rows.every((row) => row.status === 'INBOX' && row.mode === 'ME' &&
      row.executor_kind === 'HUMAN'));
    const audit = await sql<{ count: string }>`select count(*)::text as count
      from activity_records where command_id = ${applyCommandId}
      and event_type = 'PROJECT_BLUEPRINT_APPLIED'`.execute(app.db);
    assert.equal(audit.rows[0]?.count, '1');
  } finally { await api.stop(); }
});

test('stale View aborts Blueprint effects and cross-workspace Goal is invisible', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId,
    commandId: randomUUID(), title: '蓝图旧基线', projectType: 'THESIS' });
  const projectId = project.result.project_id;
  const otherWorkspace = await createWorkspace(app.db);
  const foreignGoal = await createGoal(app.db, { workspaceId: otherWorkspace,
    commandId: randomUUID(), title: '他域目标', description: '' });
  const goal = await createGoal(app.db, { workspaceId,
    commandId: randomUUID(), title: '本域目标', description: '' });
  const api = await startTestApi();
  try {
    const path = `${workspacePath(workspaceId)}/projects/${projectId}/blueprint-proposals`;
    const base = { expected_project_revision: '0',
      expected_state_revision: '0', expected_view_revision: '0' };
    const noEffect = await api.post(path, { command_id: randomUUID(), ...base,
      draft: { intent: '仅说明意图', goal_id: null, phase_key: null,
        tasks: [], next_action: { kind: 'CLEAR' },
        view_kind: 'thesis', pack_ref: null } });
    expectProblem(noEffect, 409, 'INVALID_TRANSITION');
    expectProblem(await api.post(path, { command_id: randomUUID(), ...base,
      draft: newDraft(foreignGoal.result.goal_id) }), 404, 'RESOURCE_NOT_FOUND');
    const commandId = randomUUID();
    const created = expectCommandAccepted(await api.post(path,
      { command_id: commandId, ...base, draft: newDraft(goal.result.goal_id) }),
    201, commandId) as { id: string; candidate_sha256: string };
    const setView = await api.post(`${workspacePath(workspaceId)}` +
      `/projects/${projectId}/view-configuration`,
    { command_id: randomUUID(), expected_revision: '0', kind: 'development' });
    assert.equal(setView.status, 200);
    const stale = await api.post(`${path}/${created.id}/apply`, {
      command_id: randomUUID(), candidate_sha256: created.candidate_sha256,
      ...base });
    expectProblem(stale, 409, 'REVISION_CONFLICT');
    const tasks = await sql<{ count: string }>`select count(*)::text as count
      from tasks where project_id = ${projectId}`.execute(app.db);
    assert.equal(tasks.rows[0]?.count, '0');
    const links = await sql<{ count: string }>`select count(*)::text as count
      from project_goals where project_id = ${projectId}`.execute(app.db);
    assert.equal(links.rows[0]?.count, '0');
    const detail = await api.get(`${path}/${created.id}`);
    assert.equal((detail.body as { stale: boolean }).stale, true);
  } finally { await api.stop(); }
});

test('archived explicit source makes Skill Blueprint stale and prevents Apply', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId,
    commandId: randomUUID(), title: '来源栅栏', projectType: 'GENERAL' });
  const projectId = project.result.project_id;
  const source = await createKnowledge(app.db, { workspaceId,
    commandId: randomUUID(), projectId, title: '受管来源',
    source: { sourceKind: 'NOTE', text: '确认的项目背景资料' } });
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), projectId, title: '带来源蓝图' });
  await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '根据资料生成候选',
    skillRef: { id: 'goal-to-project-blueprint', version: '1.0.0' },
    skillInput: {}, sourceRefs: [{ kind: 'KNOWLEDGE',
      root_id: source.result.knowledge_id!, version: '1' }] });
  const tick = await runAssistGenerationTick(app.db, { workerId: 'blueprint-source',
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(tick?.status, 'COMPLETED');
  const proposalId = tick.proposalIds[0]!;
  const stored = await sql<{ candidate_sha256: string }>`select candidate_sha256
    from project_blueprint_proposals where id = ${proposalId}`.execute(app.db);
  await retireInformation(app.db, { workspaceId, commandId: randomUUID(),
    kind: 'knowledge', id: source.result.knowledge_id!,
    expectedRevision: '0' });
  const api = await startTestApi();
  try {
    const path = `${workspacePath(workspaceId)}/projects/${projectId}` +
      `/blueprint-proposals/${proposalId}`;
    const preview = await api.get(path);
    const hidden = preview.body as { stale: boolean;
      content_availability: string; candidate: unknown; baseline: unknown;
      diff: unknown };
    assert.equal(hidden.stale, true);
    assert.equal(hidden.content_availability, 'SOURCE_UNAVAILABLE');
    assert.equal(hidden.candidate, null);
    assert.equal(hidden.baseline, null);
    assert.equal(hidden.diff, null);
    const apply = await api.post(`${path}/apply`, { command_id: randomUUID(),
      candidate_sha256: stored.rows[0]!.candidate_sha256,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0' });
    expectProblem(apply, 409, 'INVALID_TRANSITION');
    const tasks = await sql<{ count: string }>`select count(*)::text as count
      from tasks where project_id = ${projectId}`.execute(app.db);
    assert.equal(tasks.rows[0]?.count, '0');
  } finally { await api.stop(); }
});

test('goal-to-project-blueprint Skill freezes source and applies through the same candidate', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Skill 蓝图', projectType: 'THESIS' });
  const goal = await createGoal(app.db, { workspaceId,
    commandId: randomUUID(), title: '研究目标', description: '' });
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), projectId: project.result.project_id,
    title: '生成蓝图' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '为研究目标安排下一步',
    skillRef: { id: 'goal-to-project-blueprint', version: '1.0.0' },
    skillInput: { desired_outcome: '形成研究计划', goal_id: goal.result.goal_id,
      pack_ref: { id: 'thesis-minimal', version: '1.3.0' } } });
  const tick = await runAssistGenerationTick(app.db, { workerId: 'blueprint-skill',
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(tick?.status, 'COMPLETED');
  assert.equal(tick.proposalIds.length, 1);
  const proposalId = tick.proposalIds[0]!;
  const stored = await sql<{ origin: string; skill_message_id: string;
    candidate_sha256: string; source: { pack: { version: string } } }>`
    select origin, skill_message_id, candidate_sha256, source
    from project_blueprint_proposals where id = ${proposalId}`.execute(app.db);
  assert.equal(stored.rows[0]!.origin, 'SKILL');
  assert.equal(stored.rows[0]!.skill_message_id,
    requested.result.assistant_message_id);
  assert.equal(stored.rows[0]!.source.pack.version, '1.3.0');
  const output = await sql<{ status: string; skill_output: { kind: string;
    payload: { effective_blueprint: boolean; draft: { goal_id: string } } } }>`
    select status, skill_output from assist_messages
    where id = ${requested.result.assistant_message_id}`.execute(app.db);
  assert.equal(output.rows[0]!.status, 'COMPLETED');
  assert.equal(output.rows[0]!.skill_output.kind, 'PROJECT_BLUEPRINT_SUGGESTION');
  assert.equal(output.rows[0]!.skill_output.payload.effective_blueprint, false);
  assert.equal(output.rows[0]!.skill_output.payload.draft.goal_id,
    goal.result.goal_id);
  const api = await startTestApi();
  try {
    const path = `${workspacePath(workspaceId)}/projects/` +
      `${project.result.project_id}/blueprint-proposals/${proposalId}`;
    const preview = await api.get(path);
    assert.equal(preview.status, 200);
    assert.equal((preview.body as { stale: boolean }).stale, false);
    const commandId = randomUUID();
    const result = expectCommandAccepted(await api.post(`${path}/apply`, {
      command_id: commandId,
      candidate_sha256: stored.rows[0]!.candidate_sha256,
      expected_project_revision: '0', expected_state_revision: '0',
      expected_view_revision: '0',
    }), 200, commandId) as { task_id_map: unknown[];
      goal_ids: string[] };
    assert.equal(result.task_id_map.length, 1);
    assert.deepEqual(result.goal_ids, [goal.result.goal_id]);
  } finally { await api.stop(); }
});

test('Skill baseline change and cancellation settle without creating Blueprint candidates', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId,
    commandId: randomUUID(), title: 'Skill 竞争', projectType: 'GENERAL' });
  const projectId = project.result.project_id;
  const session = await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), projectId, title: '竞争' });
  const request = async (content: string) => requestAssistMessage(app.db, {
    workspaceId, sessionId: session.result.session_id, commandId: randomUUID(),
    content, skillRef: { id: 'goal-to-project-blueprint', version: '1.0.0' },
    skillInput: {} });
  const changed = await request('生成时视图发生变化');
  const raceModel = { identity: modelPort.identity,
    assist: async (input: Parameters<FakeModelPort['assist']>[0]) => {
      await setViewConfiguration(app.db, { workspaceId, projectId,
        commandId: randomUUID(), expectedRevision: '0', kind: 'development' });
      return modelPort.assist(input);
    } };
  const stale = await runAssistGenerationTick(app.db, { workerId: 'blueprint-race',
    storage, modelPort: raceModel, leaseMs: 30_000 });
  assert.equal(stale?.messageId, changed.result.assistant_message_id);
  assert.equal(stale.status, 'FAILED');
  assert.equal(stale.errorCode, 'SKILL_BASELINE_STALE');
  assert.deepEqual(stale.proposalIds, []);
  const aborted = await request('FAKE_ASSIST_ABORT 等待取消');
  const running = runAssistGenerationTick(app.db, { workerId: 'blueprint-cancel',
    storage, modelPort, leaseMs: 30_000 });
  let status = 'PENDING';
  for (let i = 0; i < 100 && status !== 'RUNNING'; i += 1) {
    await delay(10);
    const row = await sql<{ status: string }>`select status from assist_messages
      where id = ${aborted.result.assistant_message_id}`.execute(app.db);
    status = row.rows[0]!.status;
  }
  assert.equal(status, 'RUNNING');
  await cancelAssistMessage(app.db, { workspaceId,
    messageId: aborted.result.assistant_message_id,
    commandId: randomUUID() });
  const cancelled = await running;
  assert.equal(cancelled?.status, 'CANCELLED');
  const count = await sql<{ count: string }>`select count(*)::text as count
    from project_blueprint_proposals where project_id = ${projectId}`.execute(app.db);
  assert.equal(count.rows[0]?.count, '0');
});
