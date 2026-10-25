import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-project-goal-maintenance');
let api: Awaited<ReturnType<typeof startTestApi>>;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function createGoal(workspaceId: string, title = '目标'): Promise<{ id: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/goals'), { command_id: commandId, title, description: '初始说明' });
  const result = expectCommandAccepted(response, 201, commandId);
  return { id: result.goal_id as string, revision: result.revision as string };
}
async function createProject(workspaceId: string, title = '项目'): Promise<{ id: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), { command_id: commandId, title, project_type: 'GENERAL' });
  const result = expectCommandAccepted(response, 201, commandId);
  return { id: result.project_id as string, revision: result.revision as string };
}
async function readProject(workspaceId: string, projectId: string): Promise<{ id: string; title: string; project_type: string; revision: string }> {
  const response = await api.get(workspacePath(workspaceId, `/projects/${projectId}`));
  assert.equal(response.status, 200, response.text);
  return response.body as { id: string; title: string; project_type: string; revision: string };
}
async function readGoal(workspaceId: string, goalId: string): Promise<{ id: string; title: string; description: string; status: string; revision: string }> {
  const response = await api.get(workspacePath(workspaceId, `/goals/${goalId}`));
  assert.equal(response.status, 200, response.text);
  const body = response.body as { id: string; title: string; description: string; status: string; revision: string };
  return { id: body.id, title: body.title, description: body.description, status: body.status, revision: body.revision };
}
async function linkGoal(workspaceId: string, projectId: string, goalId: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/goal-links`), {
    command_id: commandId, expected_revision: (await readProject(workspaceId, projectId)).revision, goal_id: goalId,
  });
  const result = expectCommandAccepted(response, 200, commandId);
  return result.revision as string;
}
async function addDirectory(workspaceId: string, projectId: string, root: string): Promise<string> {
  const resourceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.gateway.insertResource({ id: resourceId, workspaceId, projectId,
      canonicalRoot: root, identityKey: `maintenance-${randomUUID()}`, fileWriteRootId: null });
  });
  return resourceId;
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
async function editGoal(workspaceId: string, goalId: string, expectedRevision: string,
  commandId: string, title: string, description: string) {
  return api.post(workspacePath(workspaceId, `/goals/${goalId}/revisions`), {
    command_id: commandId, expected_revision: expectedRevision, title, description,
  });
}
async function archiveGoal(workspaceId: string, goalId: string, expectedRevision: string, commandId: string) {
  return api.post(workspacePath(workspaceId, `/goals/${goalId}/archive`), {
    command_id: commandId, expected_revision: expectedRevision,
  });
}
async function editProject(workspaceId: string, projectId: string, expectedRevision: string,
  commandId: string, title: string, extra: Record<string, unknown> = {}) {
  return api.patch(workspacePath(workspaceId, `/projects/${projectId}`), {
    command_id: commandId, expected_revision: expectedRevision, title, ...extra,
  });
}

test('Goal 创建关联后可修改，Goal/目录上下文及审计回执读回当前值', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspaceId = await createWorkspace(app.db);
  const goal = await createGoal(workspaceId, '写作目标');
  const project = await createProject(workspaceId, '论文项目');
  const linkedRevision = await linkGoal(workspaceId, project.id, goal.id);
  const resourceId = await addDirectory(workspaceId, project.id, 'D:/goal-edit');
  const sessionId = await createSession(workspaceId, project.id, '讨论');
  await bindDirectory(workspaceId, sessionId, resourceId);

  const baseline = await sql<{ facts: unknown }>`
    select jsonb_build_object(
      'tasks', (select count(*)::text from tasks where workspace_id = ${workspaceId}),
      'runs', (select count(*)::text from runs where workspace_id = ${workspaceId}),
      'sessions', (select jsonb_agg(jsonb_build_array(id, revision::text, working_resource_id) order by id) from assist_sessions where workspace_id = ${workspaceId}),
      'links', (select jsonb_agg(jsonb_build_array(project_id, goal_id) order by project_id, goal_id) from project_goals where workspace_id = ${workspaceId}),
      'project_state', (select jsonb_agg(jsonb_build_array(project_id, phase_key, revision::text) order by project_id) from project_states where project_id = ${project.id})
    ) as facts
  `.execute(app.db);
  const commandId = randomUUID();
  const response = await editGoal(workspaceId, goal.id, goal.revision, commandId, '新目标名称', '新说明');
  const result = expectCommandAccepted(response, 200, commandId);
  const editedRevision = result.revision as string;
  assert.deepEqual(result, { goal_id: goal.id, title: '新目标名称', description: '新说明', status: 'ACTIVE', revision: editedRevision });
  const firstEnvelope = response.body as { links: { resource: string } };
  const expectedGoalLink = `/api/v1/workspaces/${workspaceId}/goals/${goal.id}`;
  assert.equal(firstEnvelope.links.resource, expectedGoalLink);
  const receipt = await api.get(workspacePath(workspaceId, `/commands/${commandId}`));
  assert.equal(receipt.status, 200, receipt.text);
  assert.equal((receipt.body as { links: { resource: string } }).links.resource, expectedGoalLink);

  assert.deepEqual(await readGoal(workspaceId, goal.id), {
    id: goal.id, title: '新目标名称', description: '新说明', status: 'ACTIVE', revision: editedRevision,
  });
  const goals = await api.get(workspacePath(workspaceId, '/goals'));
  const goalItems = (goals.body as { items: { id: string; title: string; revision: string }[] }).items;
  assert.deepEqual(goalItems.filter((item) => item.id === goal.id).map((item) => ({ title: item.title, revision: item.revision })),
    [{ title: '新目标名称', revision: editedRevision }]);
  const goalContext = await api.get(workspacePath(workspaceId, `/goals/${goal.id}/work-context`));
  const goalSessions = (goalContext.body as { goal: { id: string; title: string; revision: string }; sessions: { id: string }[] });
  assert.deepEqual({ id: goalSessions.goal.id, title: goalSessions.goal.title, revision: goalSessions.goal.revision },
    { id: goal.id, title: '新目标名称', revision: editedRevision });
  assert.deepEqual(goalSessions.sessions.map((session) => session.id), [sessionId]);
  const directoryContext = await api.get(workspacePath(workspaceId, `/working-directories/${resourceId}/work-context`));
  assert.deepEqual((directoryContext.body as { linked_goals: { id: string; title: string; revision: string; status: string }[] }).linked_goals
    .map(({ id, title, revision }) => ({ id, title, revision })),
    [{ id: goal.id, title: '新目标名称', revision: editedRevision }]);
  const foreignEdit = await editGoal(foreignWorkspaceId, goal.id, editedRevision, randomUUID(), '跨工作区修改', '');
  assert.equal(foreignEdit.status, 404);

  const replay = await editGoal(workspaceId, goal.id, goal.revision, commandId, '新目标名称', '新说明');
  assert.equal(replay.status, 200);
  assert.deepEqual((replay.body as { result: unknown }).result, result);
  assert.equal((await editGoal(workspaceId, goal.id, editedRevision, commandId, '不同内容', '新说明')).status, 409);
  assert.equal((await editGoal(workspaceId, goal.id, goal.revision, randomUUID(), '旧revision', '新说明')).status, 409);
  assert.equal((await editGoal(workspaceId, goal.id, editedRevision, randomUUID(), '  ', '说明')).status, 422);
  assert.equal((await editGoal(workspaceId, goal.id, editedRevision, randomUUID(), '有效标题', 'x'.repeat(2001))).status, 422);
  const clearCommandId = randomUUID();
  const clear = await editGoal(workspaceId, goal.id, editedRevision, clearCommandId, '新目标名称', '');
  assert.equal(clear.status, 200);
  assert.equal((await readGoal(workspaceId, goal.id)).description, '');
  const after = await sql<{ facts: unknown }>`
    select jsonb_build_object(
      'tasks', (select count(*)::text from tasks where workspace_id = ${workspaceId}),
      'runs', (select count(*)::text from runs where workspace_id = ${workspaceId}),
      'sessions', (select jsonb_agg(jsonb_build_array(id, revision::text, working_resource_id) order by id) from assist_sessions where workspace_id = ${workspaceId}),
      'links', (select jsonb_agg(jsonb_build_array(project_id, goal_id) order by project_id, goal_id) from project_goals where workspace_id = ${workspaceId}),
      'project_state', (select jsonb_agg(jsonb_build_array(project_id, phase_key, revision::text) order by project_id) from project_states where project_id = ${project.id})
    ) as facts
  `.execute(app.db);
  assert.deepEqual(after.rows, baseline.rows);
  const audit = await sql<{ count: string }>`select count(*)::text as count from activity_records where event_type = 'GOAL_UPDATED' and fact_refs->>'goal_id' = ${goal.id}`.execute(app.db);
  assert.equal(audit.rows[0]?.count, '2');
  assert.equal(linkedRevision, '1');
});

test('Goal 归档保留引用，阻止新关联并允许原关联解除', async () => {
  const workspaceId = await createWorkspace(app.db);
  const goal = await createGoal(workspaceId, '待归档目标');
  const project = await createProject(workspaceId, '关联项目');
  const linkedRevision = await linkGoal(workspaceId, project.id, goal.id);
  const resourceId = await addDirectory(workspaceId, project.id, 'D:/goal-archive');
  const sessionId = await createSession(workspaceId, project.id, '历史会话');
  await bindDirectory(workspaceId, sessionId, resourceId);
  const archiveCommandId = randomUUID();
  const archived = await archiveGoal(workspaceId, goal.id, goal.revision, archiveCommandId);
  assert.equal(archived.status, 200, archived.text);
  const archivedResult = (archived.body as { result: { goal_id: string; status: string; revision: string } }).result;
  assert.equal(archivedResult.goal_id, goal.id);
  assert.equal(archivedResult.status, 'ARCHIVED');
  assert.ok(archivedResult.revision !== goal.revision);
  const expectedLink = `/api/v1/workspaces/${workspaceId}/goals/${goal.id}`;
  assert.equal((archived.body as { links: { resource: string } }).links.resource, expectedLink);
  const active = await api.get(workspacePath(workspaceId, '/goals'));
  assert.equal((active.body as { items: { id: string }[] }).items.some((item) => item.id === goal.id), false);
  for (const status of ['archived', 'all']) {
    const list = await api.get(workspacePath(workspaceId, `/goals?status=${status}`));
    assert.equal((list.body as { items: { id: string }[] }).items.some((item) => item.id === goal.id), true);
  }
  assert.equal((await readGoal(workspaceId, goal.id)).status, 'ARCHIVED');
  const context = await api.get(workspacePath(workspaceId, `/goals/${goal.id}/work-context`));
  assert.equal((context.body as { goal: { status: string } }).goal.status, 'ARCHIVED');
  assert.equal((context.body as { sessions: { id: string }[] }).sessions[0]?.id, sessionId);
  assert.equal((await api.get(workspacePath(workspaceId, `/commands/${archiveCommandId}`))).status, 200);

  const newProject = await createProject(workspaceId, '不可关联项目');
  const beforeRejectedLinkRevision = (await readProject(workspaceId, newProject.id)).revision;
  const rejectedCommand = randomUUID();
  const rejected = await api.post(workspacePath(workspaceId, `/projects/${newProject.id}/goal-links`), {
    command_id: rejectedCommand, expected_revision: beforeRejectedLinkRevision, goal_id: goal.id,
  });
  assert.equal(rejected.status, 409);
  assert.equal((await readProject(workspaceId, newProject.id)).revision, beforeRejectedLinkRevision);
  assert.deepEqual((await api.get(workspacePath(workspaceId, `/projects/${newProject.id}/goals`))).body,
    { items: [] });
  assert.equal((await archiveGoal(workspaceId, goal.id, goal.revision, archiveCommandId)).status, 200);
  assert.equal((await archiveGoal(workspaceId, goal.id, archivedResult.revision, randomUUID())).status, 409);
  assert.equal((await editGoal(workspaceId, goal.id, archivedResult.revision, randomUUID(), '归档后编辑', 'x')).status, 409);

  const unlinkCommand = randomUUID();
  const unlinked = await api.post(workspacePath(workspaceId, `/projects/${project.id}/goal-unlinks`), {
    command_id: unlinkCommand, expected_revision: linkedRevision,
    goal_id: goal.id, expected_impacted_task_ids: [],
  });
  assert.equal(unlinked.status, 200, unlinked.text);
  assert.deepEqual((await api.get(workspacePath(workspaceId, `/projects/${project.id}/goals`))).body, { items: [] });
  assert.equal((await createRepositories(app.db).assist.readSession(sessionId))?.id, sessionId);
});

test('Project 改名只更新展示标题并通过各入口读回', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspaceId = await createWorkspace(app.db);
  const goal = await createGoal(workspaceId, '项目目标');
  const project = await createProject(workspaceId, '原项目名');
  await linkGoal(workspaceId, project.id, goal.id);
  const resourceId = await addDirectory(workspaceId, project.id, 'D:/project-rename');
  const sessionId = await createSession(workspaceId, project.id, '项目讨论');
  await bindDirectory(workspaceId, sessionId, resourceId);
  const projectBefore = await readProject(workspaceId, project.id);
  const stateBefore = await sql<{ phase_key: string; revision: string }>`select phase_key, revision::text as revision from project_states where project_id = ${project.id}`.execute(app.db);
  const factsBefore = await sql<{ facts: unknown }>`
    select jsonb_build_object(
      'tasks', (select count(*)::text from tasks where workspace_id = ${workspaceId} and project_id = ${project.id}),
      'runs', (select count(*)::text from runs where workspace_id = ${workspaceId}),
      'links', (select jsonb_agg(jsonb_build_array(project_id, goal_id) order by goal_id) from project_goals where workspace_id = ${workspaceId} and project_id = ${project.id}),
      'directories', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from managed_resources where workspace_id = ${workspaceId} and project_id = ${project.id}),
      'sessions', (select jsonb_agg(jsonb_build_array(id, revision::text, working_resource_id) order by id) from assist_sessions where workspace_id = ${workspaceId} and project_id = ${project.id})
    ) as facts
  `.execute(app.db);

  const commandId = randomUUID();
  const response = await editProject(workspaceId, project.id, projectBefore.revision, commandId, '新项目名');
  const result = expectCommandAccepted(response, 200, commandId);
  const editedRevision = result.revision as string;
  assert.deepEqual(result, { project_id: project.id, title: '新项目名', revision: editedRevision });
  const expectedLink = `/api/v1/workspaces/${workspaceId}/projects/${project.id}`;
  assert.equal((response.body as { links: { resource: string } }).links.resource, expectedLink);
  const receipt = await api.get(workspacePath(workspaceId, `/commands/${commandId}`));
  assert.equal((receipt.body as { links: { resource: string } }).links.resource, expectedLink);
  assert.equal((await readProject(workspaceId, project.id)).title, '新项目名');
  const projectList = await api.get(workspacePath(workspaceId, '/projects'));
  assert.equal((projectList.body as { items: { id: string; title: string }[] }).items.find((item) => item.id === project.id)?.title, '新项目名');
  const goalProjects = await api.get(workspacePath(workspaceId, `/goals/${goal.id}/projects`));
  assert.equal((goalProjects.body as { items: { project_id: string; title: string }[] }).items.find((item) => item.project_id === project.id)?.title, '新项目名');
  const directoryContext = await api.get(workspacePath(workspaceId, `/working-directories/${resourceId}/work-context`));
  assert.equal((directoryContext.body as { directory: { project: { title: string } } }).directory.project.title, '新项目名');
  assert.equal((await editProject(foreignWorkspaceId, project.id, projectBefore.revision, randomUUID(), '跨工作区')).status, 404);
  assert.equal((await editProject(workspaceId, project.id, projectBefore.revision, randomUUID(), '旧revision')).status, 409);
  assert.equal((await editProject(workspaceId, project.id, editedRevision, randomUUID(), '  ')).status, 422);
  assert.equal((await editProject(workspaceId, project.id, editedRevision, randomUUID(), '非法字段', { project_type: 'THESIS' })).status, 422);

  const projectAfter = await readProject(workspaceId, project.id);
  const stateAfter = await sql<{ phase_key: string; revision: string }>`select phase_key, revision::text as revision from project_states where project_id = ${project.id}`.execute(app.db);
  const factsAfter = await sql<{ facts: unknown }>`
    select jsonb_build_object(
      'tasks', (select count(*)::text from tasks where workspace_id = ${workspaceId} and project_id = ${project.id}),
      'runs', (select count(*)::text from runs where workspace_id = ${workspaceId}),
      'links', (select jsonb_agg(jsonb_build_array(project_id, goal_id) order by goal_id) from project_goals where workspace_id = ${workspaceId} and project_id = ${project.id}),
      'directories', (select jsonb_agg(jsonb_build_array(id, revision::text) order by id) from managed_resources where workspace_id = ${workspaceId} and project_id = ${project.id}),
      'sessions', (select jsonb_agg(jsonb_build_array(id, revision::text, working_resource_id) order by id) from assist_sessions where workspace_id = ${workspaceId} and project_id = ${project.id})
    ) as facts
  `.execute(app.db);
  assert.equal(projectAfter.project_type, projectBefore.project_type);
  assert.deepEqual(stateAfter.rows, stateBefore.rows);
  assert.deepEqual(factsAfter.rows, factsBefore.rows);
  const audit = await sql<{ count: string }>`select count(*)::text as count from activity_records where event_type = 'PROJECT_PRESENTATION_UPDATED' and project_id = ${project.id}`.execute(app.db);
  assert.equal(audit.rows[0]?.count, '1');

  const archiveCommand = randomUUID();
  const archived = await api.post(workspacePath(workspaceId, `/projects/${project.id}/archive`), {
    command_id: archiveCommand, expected_revision: projectAfter.revision,
  });
  expectCommandAccepted(archived, 200, archiveCommand);
  const archivedRevision = (archived.body as { result: { revision: string } }).result.revision;
  assert.equal((await editProject(workspaceId, project.id, archivedRevision, randomUUID(), '归档后改名')).status, 409);
  assert.equal((await editProject(workspaceId, project.id, projectBefore.revision, commandId, '新项目名')).status, 200);
});

test('P0 场景：Goal 关联两个项目、编辑、改名、解除一个、归档后仍可读历史', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspaceId = await createWorkspace(app.db);
  const goal = await createGoal(workspaceId, '端到端目标');
  const first = await createProject(workspaceId, '项目一');
  const second = await createProject(workspaceId, '项目二');
  await linkGoal(workspaceId, first.id, goal.id);
  await linkGoal(workspaceId, second.id, goal.id);

  const editCommand = randomUUID();
  const edited = await editGoal(workspaceId, goal.id, goal.revision, editCommand, '端到端目标（修订）', '修订说明');
  expectCommandAccepted(edited, 200, editCommand);
  const goalRevision = (edited.body as { result: { revision: string } }).result.revision;

  const firstBeforeRename = await readProject(workspaceId, first.id);
  const renameCommand = randomUUID();
  const renamed = await editProject(workspaceId, first.id, firstBeforeRename.revision, renameCommand, '项目一（改名）');
  expectCommandAccepted(renamed, 200, renameCommand);
  assert.equal((await readProject(workspaceId, first.id)).title, '项目一（改名）');

  const firstBeforeUnlink = await readProject(workspaceId, first.id);
  const unlinkCommand = randomUUID();
  const unlinked = await api.post(workspacePath(workspaceId, `/projects/${first.id}/goal-unlinks`), {
    command_id: unlinkCommand, expected_revision: firstBeforeUnlink.revision,
    goal_id: goal.id, expected_impacted_task_ids: [],
  });
  expectCommandAccepted(unlinked, 200, unlinkCommand);
  assert.deepEqual((await api.get(workspacePath(workspaceId, `/projects/${first.id}/goals`))).body, { items: [] });

  const archiveCommand = randomUUID();
  const archived = await archiveGoal(workspaceId, goal.id, goalRevision, archiveCommand);
  expectCommandAccepted(archived, 200, archiveCommand);
  const archivedRevision = (archived.body as { result: { revision: string } }).result.revision;

  const goalAfter = await readGoal(workspaceId, goal.id);
  assert.deepEqual(goalAfter, { id: goal.id, title: '端到端目标（修订）', description: '修订说明',
    status: 'ARCHIVED', revision: archivedRevision });
  const projectsAfter = await api.get(workspacePath(workspaceId, `/goals/${goal.id}/projects`));
  assert.deepEqual((projectsAfter.body as { items: { project_id: string }[] }).items.map((item) => item.project_id),
    [second.id]);
  const contextAfter = await api.get(workspacePath(workspaceId, `/goals/${goal.id}/work-context?status=ALL`));
  assert.deepEqual((contextAfter.body as { projects: { id: string }[] }).projects.map((item) => item.id),
    [second.id]);
  assert.equal((await readProject(workspaceId, first.id)).title, '项目一（改名）');
  assert.equal((await readProject(workspaceId, second.id)).id, second.id);
  const archivedList = await api.get(workspacePath(workspaceId, '/goals?status=archived'));
  assert.equal((archivedList.body as { items: { id: string }[] }).items.some((item) => item.id === goal.id), true);
  assert.equal((await api.get(workspacePath(foreignWorkspaceId, `/goals/${goal.id}`))).status, 404);
  assert.equal((await archiveGoal(workspaceId, goal.id, goalRevision, archiveCommand)).status, 200);
  assert.equal((await archiveGoal(workspaceId, goal.id, archivedRevision, randomUUID())).status, 409);
});
