import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import type { TodayDto } from '../../src/application/today-queries.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem,
  startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-today');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); });

async function project(workspaceId: string): Promise<{ id: string; revision: string;
  stateRevision: string }> {
  const commandId = randomUUID();
  const result = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title: `Today ${commandId}`, project_type: 'GENERAL',
  }), 201, commandId);
  return { id: result.project_id as string, revision: result.revision as string,
    stateRevision: result.state_revision as string };
}

async function task(workspaceId: string, projectId: string | null, title: string,
  ready = true): Promise<{ id: string; revision: string }> {
  const commandId = randomUUID();
  const created = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId, project_id: projectId, title, objective: title,
    criteria: [{ statement: 'Human review' }],
  }), 201, commandId);
  const id = created.task_id as string;
  if (!ready) return { id, revision: created.revision as string };
  const readyId = randomUUID();
  const marked = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${id}/ready`), { command_id: readyId,
    expected_revision: created.revision }), 200, readyId);
  return { id, revision: marked.revision as string };
}

async function today(workspaceId: string, date: string, timezone: string): Promise<TodayDto> {
  const response = await api.get(workspacePath(workspaceId,
    `/today?date=${date}&timezone=${encodeURIComponent(timezone)}`));
  assert.equal(response.status, 200, response.text);
  return response.body as TodayDto;
}

async function selectTask(workspaceId: string, taskId: string, expectedRevision: string,
  pin: boolean, laterDate: string | null = null, timezone: string | null = null,
  commandId = randomUUID()) {
  return api.post(workspacePath(workspaceId, `/task-selections/${taskId}`), {
    command_id: commandId, expected_revision: expectedRevision, pin,
    later_local_date: laterDate, timezone,
  });
}

test('planning metadata changes Task revision but not acceptance revision; projectless ready Task participates', async () => {
  const workspaceId = await createWorkspace(app.db);
  const item = await task(workspaceId, null, 'Projectless today');
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId,
    `/tasks/${item.id}/planning-metadata`), { command_id: commandId,
    expected_revision: item.revision, priority: 'HIGH',
    due_local_date: '2026-09-26', timezone: 'Asia/Shanghai' });
  const changed = expectCommandAccepted(response, 200, commandId);
  assert.equal(changed.revision, String(BigInt(item.revision) + 1n));
  const detail = await api.get(workspacePath(workspaceId, `/tasks/${item.id}`));
  assert.equal(detail.status, 200, detail.text);
  const body = detail.body as { acceptance_revision: string; priority: string;
    due_local_date: string; timezone: string };
  assert.equal(body.acceptance_revision, '1');
  assert.deepEqual([body.priority, body.due_local_date, body.timezone],
    ['HIGH', '2026-09-26', 'Asia/Shanghai']);
  const view = await today(workspaceId, '2026-09-26', 'Asia/Shanghai');
  assert.equal(view.eligible_items[0]?.task_id, item.id);
  assert.ok(view.eligible_items[0]?.reason_codes.includes('DUE_TODAY'));
  assert.ok(view.eligible_items[0]?.reason_codes.includes('PRIORITY_HIGH'));
});

test('Later survives API restart and expires at saved local midnight across timezones', async () => {
  const workspaceId = await createWorkspace(app.db);
  const item = await task(workspaceId, null, 'Later across midnight');
  const commandId = randomUUID();
  const response = await selectTask(workspaceId, item.id, '0', false,
    '2026-01-02', 'Pacific/Kiritimati', commandId);
  assert.equal(expectCommandAccepted(response, 200, commandId).selection_revision, '1');
  const before = await today(workspaceId, '2026-01-01', 'America/Los_Angeles');
  assert.equal(before.eligible_items.length, 0);
  assert.ok(before.waiting_items[0]?.reason_codes.includes('LATER_ACTIVE'));
  await api.stop();
  api = await startTestApi();
  const replay = await selectTask(workspaceId, item.id, '0', false,
    '2026-01-02', 'Pacific/Kiritimati', commandId);
  assert.equal(expectCommandAccepted(replay, 200, commandId).selection_revision, '1');
  assert.equal(replay.headers['command-replayed'], 'true');
  const atDeadline = await today(workspaceId, '2026-01-01', 'Pacific/Honolulu');
  assert.equal(atDeadline.eligible_items[0]?.task_id, item.id);
  const after = await today(workspaceId, '2026-01-02', 'America/Los_Angeles');
  assert.equal(after.eligible_items[0]?.task_id, item.id);
});

test('Later uses the daylight-saving offset at the saved local midnight', async () => {
  const workspaceId = await createWorkspace(app.db);
  const item = await task(workspaceId, null, 'DST boundary');
  const commandId = randomUUID();
  expectCommandAccepted(await selectTask(workspaceId, item.id, '0', false,
    '2026-11-01', 'America/New_York', commandId), 200, commandId);
  assert.ok((await today(workspaceId, '2026-11-01', 'Europe/London'))
    .waiting_items[0]?.reason_codes.includes('LATER_ACTIVE'));
  assert.equal((await today(workspaceId, '2026-11-01', 'America/Puerto_Rico'))
    .eligible_items[0]?.task_id, item.id);
  expectProblem(await selectTask(workspaceId, item.id, '1', false,
    '2026-11-01', 'America/Not_A_Zone'), 422, 'VALIDATION_FAILED');
});

test('Pin cannot override an unmet dependency; AI-held work stays in waiting items', async () => {
  const workspaceId = await createWorkspace(app.db);
  const p = await project(workspaceId);
  const upstream = await task(workspaceId, p.id, 'Unfinished upstream');
  const blocked = await task(workspaceId, p.id, 'Pinned but blocked');
  const dependencyId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${blocked.id}/dependency-links`), {
    command_id: dependencyId, expected_revision: blocked.revision,
    depends_on_task_id: upstream.id, dependency_kind: 'BLOCKS',
  }), 200, dependencyId);
  const pinId = randomUUID();
  assert.equal(expectCommandAccepted(await selectTask(workspaceId, blocked.id, '0', true,
    null, null, pinId), 200, pinId).selection_revision, '1');
  const delegated = await task(workspaceId, p.id, 'AI-held');
  const delegateId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${delegated.id}/delegations`), { command_id: delegateId,
    expected_task_revision: delegated.revision }), 202, delegateId);
  const view = await today(workspaceId, '2026-09-26', 'Asia/Shanghai');
  assert.equal(view.eligible_items.some((row) => row.task_id === blocked.id), false);
  assert.equal(view.blocked_pinned_items[0]?.task_id, blocked.id);
  assert.ok(view.blocked_pinned_items[0]?.reason_codes.includes('DEPENDENCY_UNSATISFIED'));
  assert.equal(view.blocked_pinned_items[0]?.allowed_actions.includes('START'), false);
  assert.ok(view.waiting_items.find((row) => row.task_id === delegated.id)
    ?.reason_codes.includes('AI_OCCUPIED'));
});

test('Focus preserves its timezone, effective inherited Goals and explicit empty alignment', async () => {
  const workspaceId = await createWorkspace(app.db);
  const p = await project(workspaceId);
  const goalId = randomUUID();
  const goal = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/goals'), {
    command_id: goalId, title: 'Today Goal', description: '',
  }), 201, goalId);
  const linkId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/projects/${p.id}/goal-links`), { command_id: linkId,
    expected_revision: p.revision, goal_id: goal.goal_id }), 200, linkId);
  const inherited = await task(workspaceId, p.id, 'Inherited Goal');
  const explicit = await task(workspaceId, p.id, 'Explicit empty');
  const explicitId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${explicit.id}/goal-alignment`), { command_id: explicitId,
    expected_revision: explicit.revision, mode: 'EXPLICIT', goal_ids: [] }), 200, explicitId);
  const focusId = randomUUID();
  const selected = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    '/focus-selections'), { command_id: focusId, expected_revision: '0',
    date: '2026-09-26', timezone: 'Asia/Shanghai',
    target_kind: 'GOAL', target_id: goal.goal_id }), 200, focusId);
  assert.equal(selected.selection_revision, '1');
  const aligned = await today(workspaceId, '2026-09-26', 'Asia/Shanghai');
  assert.equal(aligned.eligible_items[0]?.task_id, inherited.id);
  assert.ok(aligned.eligible_items[0]?.reason_codes.includes('FOCUS_ALIGNED'));
  assert.equal(aligned.eligible_items.find((row) => row.task_id === explicit.id)
    ?.reason_codes.includes('FOCUS_ALIGNED'), false);
  const differentTimezone = await today(workspaceId, '2026-09-26', 'America/New_York');
  assert.equal(differentTimezone.focus?.timezone, 'Asia/Shanghai');
  assert.equal(differentTimezone.focus?.target_id, goal.goal_id);
  assert.equal(differentTimezone.focus?.active_in_query, false);
  assert.equal(differentTimezone.focus_has_eligible_candidate, false);
  const emptyGoalId = randomUUID();
  const emptyGoal = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/goals'), {
    command_id: emptyGoalId, title: 'No eligible Task', description: '',
  }), 201, emptyGoalId);
  const replaceId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId, '/focus-selections'), {
    command_id: replaceId, expected_revision: '1', date: '2026-09-26',
    timezone: 'Asia/Shanghai', target_kind: 'GOAL', target_id: emptyGoal.goal_id,
  }), 200, replaceId);
  const empty = await today(workspaceId, '2026-09-26', 'Asia/Shanghai');
  assert.equal(empty.focus?.target_id, emptyGoal.goal_id);
  assert.equal(empty.focus_has_eligible_candidate, false,
    'query must not rewrite an explicit Focus with no candidate');
});

test('all same-project READY tasks sort stably after qualification; stale revisions and cross-workspace IDs refuse writes', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const p = await project(workspaceId);
  const first = await task(workspaceId, p.id, 'First created');
  const second = await task(workspaceId, p.id, 'Second created');
  const due = await task(workspaceId, p.id, 'Due today');
  const pinned = await task(workspaceId, p.id, 'Pinned');
  const high = await task(workspaceId, p.id, 'High priority');
  const next = await task(workspaceId, p.id, 'Project next action');
  const inProgress = await task(workspaceId, p.id, 'Human in progress');
  const other = await task(otherWorkspace, null, 'Other workspace');
  const dueId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${due.id}/planning-metadata`), { command_id: dueId,
    expected_revision: due.revision, priority: null,
    due_local_date: '2026-09-26', timezone: 'Asia/Shanghai' }), 200, dueId);
  const highId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${high.id}/planning-metadata`), { command_id: highId,
    expected_revision: high.revision, priority: 'HIGH',
    due_local_date: null, timezone: null }), 200, highId);
  const nextId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/projects/${p.id}/state-commands`), { command_id: nextId,
    expected_revision: p.stateRevision, action: 'SET_NEXT_ACTION',
    next_action_task_id: next.id }), 200, nextId);
  const startId = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${inProgress.id}/start`), { command_id: startId,
    expected_revision: inProgress.revision }), 200, startId);
  const pinId = randomUUID();
  expectCommandAccepted(await selectTask(workspaceId, pinned.id, '0', true,
    null, null, pinId), 200, pinId);
  const view = await today(workspaceId, '2026-09-26', 'Asia/Shanghai');
  assert.deepEqual(view.eligible_items.map((row) => row.task_id),
    [pinned.id, due.id, high.id, next.id, inProgress.id, first.id, second.id]);
  assert.deepEqual((await today(workspaceId, '2026-09-26', 'Asia/Shanghai')).eligible_items,
    view.eligible_items);
  expectProblem(await selectTask(workspaceId, first.id, '0', false), 409, 'REVISION_CONFLICT');
  expectProblem(await selectTask(workspaceId, other.id, '1', true), 404, 'RESOURCE_NOT_FOUND');
  const clearId = randomUUID();
  assert.equal(expectCommandAccepted(await selectTask(workspaceId, pinned.id, '1', false,
    null, null, clearId), 200, clearId).selection_revision, '2');
  const cleared = await today(workspaceId, '2026-09-26', 'Asia/Shanghai');
  assert.equal(cleared.eligible_items.find((row) => row.task_id === pinned.id)?.pin, false);
  assert.equal((await today(otherWorkspace, '2026-09-26', 'Asia/Shanghai'))
    .eligible_items[0]?.task_id, other.id);
});
