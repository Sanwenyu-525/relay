import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-work-contexts');
let api: Awaited<ReturnType<typeof startTestApi>>;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function createGoal(workspaceId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/goals'), { command_id: commandId, title, description: '上下文测试' });
  return expectCommandAccepted(response, 201, commandId).goal_id as string;
}
async function createProject(workspaceId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), { command_id: commandId, title, project_type: 'GENERAL' });
  return expectCommandAccepted(response, 201, commandId).project_id as string;
}
async function projectRevision(workspaceId: string, projectId: string): Promise<string> {
  const response = await api.get(workspacePath(workspaceId, `/projects/${projectId}`));
  assert.equal(response.status, 200, response.text);
  return (response.body as { revision: string }).revision;
}
async function linkGoal(workspaceId: string, projectId: string, goalId: string): Promise<void> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/goal-links`), {
    command_id: commandId, expected_revision: await projectRevision(workspaceId, projectId), goal_id: goalId,
  });
  expectCommandAccepted(response, 200, commandId);
}
async function createSession(workspaceId: string, projectId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/assist-sessions'), {
    command_id: commandId, project_id: projectId, title,
  });
  return expectCommandAccepted(response, 201, commandId).session_id as string;
}
async function bindDirectory(workspaceId: string, sessionId: string, resourceId: string): Promise<void> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/working-directory`), {
    command_id: commandId, resource_id: resourceId,
  });
  expectCommandAccepted(response, 200, commandId);
}
async function unlinkGoal(workspaceId: string, projectId: string, goalId: string): Promise<void> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/goal-unlinks`), {
    command_id: commandId, expected_revision: await projectRevision(workspaceId, projectId),
    expected_impacted_task_ids: [], goal_id: goalId,
  });
  expectCommandAccepted(response, 200, commandId);
}
async function archiveSession(workspaceId: string, sessionId: string): Promise<void> {
  const current = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  assert.equal(current.status, 200, current.text);
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/archive`), {
    command_id: commandId, expected_revision: (current.body as { revision: string }).revision,
  });
  expectCommandAccepted(response, 200, commandId);
}

test('Goal 跨项目汇集非 Task 会话，目录入口精确按绑定读取且只读', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspaceId = await createWorkspace(app.db);
  const goalId = await createGoal(workspaceId, '跨目录目标');
  const projectIds = [await createProject(workspaceId, '项目 0'), await createProject(workspaceId, '项目 1')];
  const resourceIds = [randomUUID(), randomUUID()];
  const sessionIds: string[] = ['', '', ''];
  await withTransaction(app.db, async (repositories) => {
    for (let index = 0; index < projectIds.length; index += 1) {
      const projectId = projectIds[index]!;
      await repositories.gateway.insertResource({ id: resourceIds[index]!, workspaceId, projectId,
        canonicalRoot: `D:/work-context-${index}`, identityKey: `work-context-${randomUUID()}`, fileWriteRootId: null });
    }
  });
  await linkGoal(workspaceId, projectIds[0]!, goalId);
  await linkGoal(workspaceId, projectIds[1]!, goalId);
  sessionIds[0] = await createSession(workspaceId, projectIds[0]!, '会话 0');
  sessionIds[1] = await createSession(workspaceId, projectIds[1]!, '会话 1');
  sessionIds[2] = await createSession(workspaceId, projectIds[0]!, '未绑定目录');
  await bindDirectory(workspaceId, sessionIds[0]!, resourceIds[0]!);
  await bindDirectory(workspaceId, sessionIds[1]!, resourceIds[1]!);

  const countsBefore = await sql<{ tasks: string; runs: string; goal_links: string; receipts: string; activity: string }>`
    select (select count(*)::text from tasks where workspace_id = ${workspaceId}) as tasks,
      (select count(*)::text from runs where workspace_id = ${workspaceId}) as runs,
      (select count(*)::text from project_goals where workspace_id = ${workspaceId}) as goal_links,
      (select count(*)::text from command_receipts where scope_key = ${`workspace:${workspaceId}:user:local`}) as receipts,
      (select count(*)::text from activity_records where project_id = any(${projectIds}::uuid[])) as activity
  `.execute(app.db);
  const revisionsBefore = await sql<{ facts: unknown }>`
    select jsonb_build_object(
      'goal', (select jsonb_build_array(id, revision::text) from goals where workspace_id = ${workspaceId} and id = ${goalId}),
      'projects', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from projects where workspace_id = ${workspaceId} and id = any(${projectIds}::uuid[])),
      'directories', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from managed_resources where workspace_id = ${workspaceId} and id = any(${resourceIds}::uuid[])),
      'sessions', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from assist_sessions where workspace_id = ${workspaceId} and id = any(${sessionIds}::uuid[]))
    ) as facts
  `.execute(app.db);
  const goalResponse = await api.get(workspacePath(workspaceId, `/goals/${goalId}/work-context`));
  assert.equal(goalResponse.status, 200, goalResponse.text);
  const goalBody = goalResponse.body as { kind: string; projects: { id: string; directories: { id: string }[] }[];
    sessions: { id: string; working_resource_id: string | null }[] };
  assert.equal(goalBody.kind, 'GOAL');
  assert.deepEqual(new Set(goalBody.projects.map((project) => project.id)), new Set(projectIds));
  assert.deepEqual(goalBody.projects.find((project) => project.id === projectIds[0])?.directories.map((directory) => directory.id), [resourceIds[0]]);
  assert.deepEqual(goalBody.projects.find((project) => project.id === projectIds[1])?.directories.map((directory) => directory.id), [resourceIds[1]]);
  assert.deepEqual(new Set(goalBody.sessions.map((session) => session.id)), new Set(sessionIds));
  assert.equal(goalBody.sessions.find((session) => session.id === sessionIds[2])?.working_resource_id, null);

  const directoryResponse = await api.get(workspacePath(workspaceId, `/working-directories/${resourceIds[0]}/work-context`));
  assert.equal(directoryResponse.status, 200, directoryResponse.text);
  const directoryBody = directoryResponse.body as { sessions: { id: string }[] };
  assert.deepEqual((directoryResponse.body as { linked_goals: { id: string }[] }).linked_goals.map((goal) => goal.id), [goalId]);
  assert.deepEqual(directoryBody.sessions.map((session) => session.id), [sessionIds[0]]);
  assert.equal(goalBody.sessions.find((session) => session.id === sessionIds[0])?.id,
    directoryBody.sessions[0]?.id);

  assert.equal((await api.get(workspacePath(foreignWorkspaceId, `/goals/${goalId}/work-context`))).status, 404);
  assert.equal((await api.get(workspacePath(foreignWorkspaceId, `/working-directories/${resourceIds[0]}/work-context`))).status, 404);
  assert.equal((await api.get(workspacePath(workspaceId, `/goals/${goalId}/work-context?status=BAD`))).status, 422);
  const afterReadCounts = await sql<{ tasks: string; runs: string; goal_links: string; receipts: string; activity: string }>`
    select (select count(*)::text from tasks where workspace_id = ${workspaceId}) as tasks,
      (select count(*)::text from runs where workspace_id = ${workspaceId}) as runs,
      (select count(*)::text from project_goals where workspace_id = ${workspaceId}) as goal_links,
      (select count(*)::text from command_receipts where scope_key = ${`workspace:${workspaceId}:user:local`}) as receipts,
      (select count(*)::text from activity_records where project_id = any(${projectIds}::uuid[])) as activity
  `.execute(app.db);
  const afterReadRevisions = await sql<{ facts: unknown }>`
    select jsonb_build_object(
      'goal', (select jsonb_build_array(id, revision::text) from goals where workspace_id = ${workspaceId} and id = ${goalId}),
      'projects', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from projects where workspace_id = ${workspaceId} and id = any(${projectIds}::uuid[])),
      'directories', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from managed_resources where workspace_id = ${workspaceId} and id = any(${resourceIds}::uuid[])),
      'sessions', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from assist_sessions where workspace_id = ${workspaceId} and id = any(${sessionIds}::uuid[]))
    ) as facts
  `.execute(app.db);
  assert.deepEqual(afterReadCounts.rows, countsBefore.rows);
  assert.deepEqual(afterReadRevisions.rows, revisionsBefore.rows);

  await archiveSession(workspaceId, sessionIds[0]!);
  const active = await api.get(workspacePath(workspaceId, `/working-directories/${resourceIds[0]}/work-context`));
  assert.deepEqual((active.body as { sessions: unknown[] }).sessions, []);
  const archived = await api.get(workspacePath(workspaceId, `/working-directories/${resourceIds[0]}/work-context?status=ARCHIVED`));
  assert.deepEqual((archived.body as { sessions: { id: string }[] }).sessions.map((session) => session.id), [sessionIds[0]]);
  assert.equal((await createRepositories(app.db).assist.readSession(sessionIds[0]!))?.status, 'ARCHIVED');
  const allBeforeUnlink = await api.get(workspacePath(workspaceId, `/goals/${goalId}/work-context?status=ALL`));
  assert.ok((allBeforeUnlink.body as { sessions: { id: string; project_id: string }[] }).sessions.some((session) => session.id === sessionIds[0]));
  await unlinkGoal(workspaceId, projectIds[0]!, goalId);
  const afterUnlink = await api.get(workspacePath(workspaceId, `/goals/${goalId}/work-context?status=ALL`));
  assert.equal(afterUnlink.status, 200);
  assert.deepEqual((afterUnlink.body as { sessions: { id: string }[] }).sessions.map((session) => session.id), [sessionIds[1]]);
  const directoryAfterUnlink = await api.get(workspacePath(workspaceId, `/working-directories/${resourceIds[0]}/work-context?status=ALL`));
  assert.deepEqual((directoryAfterUnlink.body as { linked_goals: unknown[] }).linked_goals, []);
  assert.deepEqual((directoryAfterUnlink.body as { sessions: { id: string }[] }).sessions.map((session) => session.id), [sessionIds[0]]);
  assert.equal((await createRepositories(app.db).assist.readSession(sessionIds[0]!))?.id, sessionIds[0]);
});

test('无项目 Goal 与未关联 Goal 的目录返回合法空态，不跨入其他目录会话', async () => {
  const workspaceId = await createWorkspace(app.db);
  const goalId = await createGoal(workspaceId, '空目标');
  const projectId = await createProject(workspaceId, '普通项目');
  const directoryId = randomUUID();
  const otherDirectoryId = randomUUID();
  const emptyDirectoryId = randomUUID();
  let activeSessionId = '';
  await withTransaction(app.db, async (repositories) => {
    await repositories.gateway.insertResource({ id: directoryId, workspaceId, projectId,
      canonicalRoot: 'D:/unlinked-goal', identityKey: `unlinked-${randomUUID()}`, fileWriteRootId: null });
    await repositories.gateway.insertResource({ id: otherDirectoryId, workspaceId, projectId,
      canonicalRoot: 'D:/other-directory', identityKey: `other-${randomUUID()}`, fileWriteRootId: null });
    await repositories.gateway.insertResource({ id: emptyDirectoryId, workspaceId, projectId,
      canonicalRoot: 'D:/empty-directory', identityKey: `empty-${randomUUID()}`, fileWriteRootId: null });
  });
  activeSessionId = await createSession(workspaceId, projectId, '普通目录会话');
  const otherSessionId = await createSession(workspaceId, projectId, '其他目录会话');
  await bindDirectory(workspaceId, activeSessionId, directoryId);
  await bindDirectory(workspaceId, otherSessionId, otherDirectoryId);
  const goalResponse = await api.get(workspacePath(workspaceId, `/goals/${goalId}/work-context`));
  assert.equal(goalResponse.status, 200);
  assert.deepEqual((goalResponse.body as { projects: unknown[]; sessions: unknown[] }).projects, []);
  assert.deepEqual((goalResponse.body as { sessions: unknown[] }).sessions, []);
  const directoryResponse = await api.get(workspacePath(workspaceId, `/working-directories/${directoryId}/work-context`));
  assert.equal(directoryResponse.status, 200, directoryResponse.text);
  assert.deepEqual((directoryResponse.body as { linked_goals: unknown[]; sessions: unknown[] }).linked_goals, []);
  assert.deepEqual((directoryResponse.body as { sessions: { id: string }[] }).sessions.map((session) => session.id), [activeSessionId]);
  const otherDirectoryResponse = await api.get(workspacePath(workspaceId, `/working-directories/${otherDirectoryId}/work-context`));
  assert.deepEqual((otherDirectoryResponse.body as { sessions: { id: string }[] }).sessions.map((session) => session.id), [otherSessionId]);
  const emptyDirectoryResponse = await api.get(workspacePath(workspaceId, `/working-directories/${emptyDirectoryId}/work-context`));
  assert.equal(emptyDirectoryResponse.status, 200);
  assert.deepEqual((emptyDirectoryResponse.body as { sessions: unknown[] }).sessions, []);
  assert.equal((await api.get(workspacePath(workspaceId, `/goals/${randomUUID()}/work-context`))).status, 404);
  assert.equal((await api.get(workspacePath(workspaceId, `/working-directories/${randomUUID()}/work-context`))).status, 404);
});
