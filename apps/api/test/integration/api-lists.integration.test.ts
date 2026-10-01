import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m05-lists');
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

async function createProject(workspaceId: string, title: string, projectType = 'GENERAL') {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title, project_type: projectType,
  });
  const result = expectCommandAccepted(response, 201, commandId);
  return result.project_id as string;
}

async function createTask(workspaceId: string, projectId: string | null, title: string) {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId, project_id: projectId, title,
    objective: `完成 ${title}`, criteria: [{ statement: '核对结果' }],
  });
  const result = expectCommandAccepted(response, 201, commandId);
  return result.task_id as string;
}

async function createGoal(workspaceId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/goals'), {
    command_id: commandId, title, description: `${title} 描述`,
  });
  return expectCommandAccepted(response, 201, commandId).goal_id as string;
}

async function readProjectRevision(workspaceId: string, projectId: string): Promise<string> {
  const response = await api.get(workspacePath(workspaceId, `/projects/${projectId}`));
  assert.equal(response.status, 200, response.text);
  return (response.body as { revision: string }).revision;
}

async function linkGoal(workspaceId: string, projectId: string, goalId: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/goal-links`), {
    command_id: commandId, goal_id: goalId,
    expected_revision: await readProjectRevision(workspaceId, projectId),
  });
  expectCommandAccepted(response, 200, commandId);
  return goalId;
}

test('GET /projects pages exact ProjectState and archive facts without crossing Workspace', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const first = await createProject(workspaceId, 'first', 'THESIS');
  const archived = await createProject(workspaceId, 'archived', 'DEVELOPMENT');
  const last = await createProject(workspaceId, 'last');
  const foreign = await createProject(otherWorkspace, 'foreign');
  const nextTask = await createTask(workspaceId, first, 'next action');

  await sql`update project_states set phase_key = 'WRITING',
      next_action_task_id = ${nextTask}, revision = revision + 1
    where project_id = ${first}`.execute(app.db);
  await sql`update projects set created_at = '2026-01-01T00:00:00.123456Z'::timestamptz
    where id = ${first}`.execute(app.db);
  await sql`update projects set archived_at = now(),
      created_at = '2026-01-01T00:00:00.123455Z'::timestamptz
    where id = ${archived}`.execute(app.db);
  await sql`update projects set created_at = '2026-01-01T00:00:00.123454Z'::timestamptz
    where id = ${last}`.execute(app.db);

  const active = await api.get(workspacePath(workspaceId, '/projects'));
  assert.equal(active.status, 200, active.text);
  const activeItems = (active.body as { items: { id: string; phase_key: string;
    next_action_task_id: string | null; state_revision: string;
    archive_status: string; archived_at: string | null }[] }).items;
  assert.deepEqual(activeItems.map((item) => item.id), [first, last]);
  assert.equal(activeItems[0]?.phase_key, 'WRITING');
  assert.equal(activeItems[0]?.next_action_task_id, nextTask);
  assert.equal(activeItems[0]?.state_revision, '1');
  assert.equal(activeItems[0]?.archive_status, 'ACTIVE');
  assert.equal(activeItems[0]?.archived_at, null);

  const archivedPage = await api.get(workspacePath(workspaceId, '/projects?status=archived'));
  assert.equal(archivedPage.status, 200, archivedPage.text);
  const archivedItems = (archivedPage.body as { items: { id: string;
    archived_at: string | null; archive_status: string }[] }).items;
  assert.deepEqual(archivedItems.map((item) => item.id), [archived]);
  assert.equal(archivedItems[0]?.archive_status, 'ARCHIVED');
  assert.notEqual(archivedItems[0]?.archived_at, null);

  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const path = `/projects?status=all&limit=1${cursor === null ? '' : `&cursor=${cursor}`}`;
    const response = await api.get(workspacePath(workspaceId, path));
    assert.equal(response.status, 200, response.text);
    const body = response.body as { items: { id: string }[]; next_cursor: string | null };
    ids.push(...body.items.map((item) => item.id));
    cursor = body.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(ids, [first, archived, last]);
  assert.ok(!ids.includes(foreign));

  const boundPage = await api.get(workspacePath(workspaceId, '/projects?limit=1'));
  const boundCursor = (boundPage.body as { next_cursor: string }).next_cursor;
  expectProblem(await api.get(workspacePath(workspaceId,
    `/projects?status=all&limit=1&cursor=${boundCursor}`)), 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(otherWorkspace,
    `/projects?limit=1&cursor=${boundCursor}`)), 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(workspaceId,
    '/projects?status=all&limit=101')), 422, 'VALIDATION_FAILED');
  expectProblem(await api.get(workspacePath(randomUUID(), '/projects')),
    404, 'RESOURCE_NOT_FOUND');
});

test('GET /tasks?scope=all keeps legacy filters and computes blockers by each Project', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const projectA = await createProject(workspaceId, 'A');
  const projectB = await createProject(workspaceId, 'B');
  const taskA = await createTask(workspaceId, projectA, 'task A');
  const taskB = await createTask(workspaceId, projectB, 'task B');
  const inbox = await createTask(workspaceId, null, 'inbox');
  const cancelled = await createTask(workspaceId, projectB, 'cancelled');
  const cancel = await api.post(workspacePath(workspaceId, `/tasks/${cancelled}/cancel`), {
    command_id: randomUUID(), expected_task_revision: '0',
  });
  assert.equal(cancel.status, 200, cancel.text);
  const foreign = await createTask(otherWorkspace, null, 'foreign');
  // 归档是既有字段事实；本片列表不将它误作 Today 资格或隐式写权限规则。
  await sql`update projects set archived_at = now() where id = ${projectA}`.execute(app.db);
  await sql`insert into project_blockers
      (id, project_id, target_kind, target_id, reason, source_ref)
    values (${randomUUID()}, ${projectA}, 'PROJECT', ${projectA}, 'blocked', 'test')`
    .execute(app.db);
  await sql`update tasks set created_at = '2026-01-01T00:00:00.654323Z'::timestamptz
    where id = ${taskA}`.execute(app.db);
  await sql`update tasks set created_at = '2026-01-01T00:00:00.654322Z'::timestamptz
    where id = ${taskB}`.execute(app.db);
  await sql`update tasks set created_at = '2026-01-01T00:00:00.654321Z'::timestamptz
    where id = ${inbox}`.execute(app.db);
  await sql`update tasks set created_at = '2026-01-01T00:00:00.654320Z'::timestamptz
    where id = ${cancelled}`.execute(app.db);

  const items: { id: string; project_id: string | null;
    status: string; unresolved_blocker_ids: string[]; allowed_actions: string[] }[] = [];
  let cursor: string | null = null;
  do {
    const path = `/tasks?scope=all&limit=1${cursor === null ? '' : `&cursor=${cursor}`}`;
    const response = await api.get(workspacePath(workspaceId, path));
    assert.equal(response.status, 200, response.text);
    const body = response.body as { items: typeof items; next_cursor: string | null };
    items.push(...body.items);
    cursor = body.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(items.map((item) => item.id), [taskA, taskB, inbox, cancelled]);
  assert.ok(!items.some((item) => item.id === foreign));
  assert.equal(items[0]?.project_id, projectA);
  assert.equal(items[0]?.unresolved_blocker_ids.length, 1);
  assert.ok(!items[0]?.allowed_actions.includes('MARK_READY'));
  assert.deepEqual(items[1]?.unresolved_blocker_ids, []);
  assert.ok(items[1]?.allowed_actions.includes('MARK_READY'));
  assert.equal(items[2]?.project_id, null);
  assert.equal(items[3]?.status, 'CANCELLED');

  const projectPage = await api.get(workspacePath(workspaceId,
    `/tasks?project_id=${projectA}&limit=1`));
  assert.deepEqual((projectPage.body as { items: { id: string }[] }).items.map((item) => item.id),
    [taskA]);
  const inboxPage = await api.get(workspacePath(workspaceId, '/tasks?inbox=true'));
  assert.deepEqual((inboxPage.body as { items: { id: string }[] }).items.map((item) => item.id),
    [inbox]);

  const firstAll = await api.get(workspacePath(workspaceId, '/tasks?scope=all&limit=1'));
  const allCursor = (firstAll.body as { next_cursor: string }).next_cursor;
  expectProblem(await api.get(workspacePath(workspaceId,
    `/tasks?inbox=true&cursor=${allCursor}`)), 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(otherWorkspace,
    `/tasks?scope=all&cursor=${allCursor}`)), 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(workspaceId,
    '/tasks?scope=all&inbox=false')), 422, 'VALIDATION_FAILED');
  expectProblem(await api.get(workspacePath(workspaceId,
    `/tasks?scope=all&project_id=${projectA}`)), 422, 'VALIDATION_FAILED');
  expectProblem(await api.get(workspacePath(workspaceId, '/tasks')),
    422, 'REQUIRED_INPUT_MISSING');
  expectProblem(await api.get(workspacePath(randomUUID(), '/tasks?scope=all')),
    404, 'RESOURCE_NOT_FOUND');
});

test('GET /goals pages Workspace 级 Goal 并按 status 过滤，不按 Project 收敛', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const first = await createGoal(workspaceId, 'first');
  const archived = await createGoal(workspaceId, 'archived');
  const last = await createGoal(workspaceId, 'last');
  const foreign = await createGoal(otherWorkspace, 'foreign');

  await sql`update goals set created_at = '2026-01-01T00:00:00.123456Z'::timestamptz
    where id = ${first}`.execute(app.db);
  await sql`update goals set status = 'ARCHIVED', created_at = '2026-01-01T00:00:00.123455Z'::timestamptz
    where id = ${archived}`.execute(app.db);
  await sql`update goals set created_at = '2026-01-01T00:00:00.123454Z'::timestamptz
    where id = ${last}`.execute(app.db);

  const active = await api.get(workspacePath(workspaceId, '/goals'));
  assert.equal(active.status, 200, active.text);
  const activeItems = (active.body as { items: { id: string; title: string;
    status: string; description: string; revision: string }[]; next_cursor: string | null }).items;
  assert.deepEqual(activeItems.map((item) => item.id), [first, last]);
  assert.equal(activeItems[0]?.title, 'first');
  assert.equal(activeItems[0]?.description, 'first 描述');
  assert.equal(activeItems[0]?.status, 'ACTIVE');
  assert.equal(activeItems[0]?.revision, '0');
  assert.equal(active.body !== null ? (active.body as { next_cursor: string | null }).next_cursor : null,
    null);

  const archivedPage = await api.get(workspacePath(workspaceId, '/goals?status=archived'));
  assert.equal(archivedPage.status, 200, archivedPage.text);
  assert.deepEqual((archivedPage.body as { items: { id: string; status: string }[] }).items
    .map((item) => item.id), [archived]);

  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const path = `/goals?status=all&limit=1${cursor === null ? '' : `&cursor=${cursor}`}`;
    const response = await api.get(workspacePath(workspaceId, path));
    assert.equal(response.status, 200, response.text);
    const body = response.body as { items: { id: string }[]; next_cursor: string | null };
    ids.push(...body.items.map((item) => item.id));
    cursor = body.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(ids, [first, archived, last]);
  assert.ok(!ids.includes(foreign));

  const boundPage = await api.get(workspacePath(workspaceId, '/goals?status=all&limit=1'));
  const boundCursor = (boundPage.body as { next_cursor: string }).next_cursor;
  expectProblem(await api.get(workspacePath(workspaceId,
    `/goals?limit=1&cursor=${boundCursor}`)), 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(otherWorkspace,
    `/goals?status=all&limit=1&cursor=${boundCursor}`)), 400, 'INVALID_CURSOR');
  expectProblem(await api.get(workspacePath(workspaceId,
    '/goals?status=all&limit=101')), 422, 'VALIDATION_FAILED');
  expectProblem(await api.get(workspacePath(workspaceId, '/goals?status=unknown')),
    422, 'VALIDATION_FAILED');
  expectProblem(await api.get(workspacePath(randomUUID(), '/goals')),
    404, 'RESOURCE_NOT_FOUND');
});

test('GET /goals/{id}/projects 反向读出跨多个 Project 的关联，含归档 Project', async () => {
  const workspaceId = await createWorkspace(app.db);
  const otherWorkspace = await createWorkspace(app.db);
  const goal = await createGoal(workspaceId, '跨文件夹目标');
  const unlinked = await createGoal(workspaceId, '未关联目标');
  const thesis = await createProject(workspaceId, '论文项目', 'THESIS');
  const development = await createProject(workspaceId, '开发项目', 'DEVELOPMENT');
  const foreignProject = await createProject(otherWorkspace, '外部项目');
  const foreignGoal = await createGoal(otherWorkspace, '外部目标');

  await sql`update projects set created_at = '2026-02-01T00:00:00.000001Z'::timestamptz
    where id = ${thesis}`.execute(app.db);
  await sql`update projects set created_at = '2026-02-01T00:00:00.000003Z'::timestamptz
    where id = ${foreignProject}`.execute(app.db);

  // 先建立关联，再归档：归档后的 Project 不能被写命令关联，但既有关联仍可被只读查询读出。
  await linkGoal(workspaceId, thesis, goal);
  await linkGoal(workspaceId, development, goal);
  await linkGoal(otherWorkspace, foreignProject, foreignGoal);
  await sql`update projects set archived_at = now(),
      created_at = '2026-02-01T00:00:00.000002Z'::timestamptz
    where id = ${development}`.execute(app.db);

  const response = await api.get(workspacePath(workspaceId, `/goals/${goal}/projects`));
  assert.equal(response.status, 200, response.text);
  const items = (response.body as { items: { project_id: string; title: string;
    project_type: string; archived_at: string | null; archive_status: string;
    project_revision: string; linked_at: string }[] }).items;
  assert.deepEqual(items.map((item) => item.project_id), [development, thesis]);
  assert.equal(items[0]?.archive_status, 'ARCHIVED');
  assert.notEqual(items[0]?.archived_at, null);
  assert.equal(items[1]?.archive_status, 'ACTIVE');
  assert.equal(items[1]?.archived_at, null);
  assert.equal(items[1]?.title, '论文项目');
  assert.equal(items[1]?.project_type, 'THESIS');
  assert.ok(items.every((item) => item.project_revision !== '' && item.linked_at !== ''));
  assert.ok(!items.some((item) => item.project_id === foreignProject));

  const empty = await api.get(workspacePath(workspaceId, `/goals/${unlinked}/projects`));
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual((empty.body as { items: unknown[] }).items, []);

  expectProblem(await api.get(workspacePath(otherWorkspace, `/goals/${goal}/projects`)),
    404, 'RESOURCE_NOT_FOUND');
  expectProblem(await api.get(workspacePath(workspaceId, `/goals/${randomUUID()}/projects`)),
    404, 'RESOURCE_NOT_FOUND');
  expectProblem(await api.get(workspacePath(randomUUID(), `/goals/${goal}/projects`)),
    404, 'RESOURCE_NOT_FOUND');
});
