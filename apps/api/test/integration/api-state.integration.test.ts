import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';
import {
  createWorkspace,
  expectCommandAccepted,
  expectProblem,
  startTestApi,
  workspacePath,
  type TestApi,
} from './api-harness.js';

/**
 * P02：Project State 组合视图与类型化 State 命令的真实 HTTP + 真实 PostgreSQL 验收。
 *
 * 覆盖契约第 5 节的 State 读取与命令、第 6 节的依赖版本、以及 A01（拒绝整对象覆盖）与
 * A02（过期 revision 不覆盖新版本）。Artifact / Blocker 事实在 P02 尚无写入口，
 * 相关命令使用应用中真实的 Repository 播种事实后再经 HTTP 检验（不是 Mock DB）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p02-state');

let api: TestApi;
let workspaceId: string;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });

  api = await startTestApi();
  workspaceId = await createWorkspace(app.db);
});

after(async () => {
  await api?.stop();
  await app.close();
});

async function createProject(
  projectType: 'GENERAL' | 'THESIS' | 'DEVELOPMENT' = 'DEVELOPMENT',
): Promise<{ project_id: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId,
    title: `state-project-${projectType}`,
    project_type: projectType,
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return { project_id: result.project_id as string, revision: result.revision as string };
}

async function createTask(projectId: string | null): Promise<{ task_id: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId,
    project_id: projectId,
    title: 'state-task',
    objective: '为 State 组合视图提供事实',
    criteria: [{ statement: '人工核对' }],
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return { task_id: result.task_id as string, revision: result.revision as string };
}

async function readState(projectId: string): Promise<Record<string, unknown>> {
  const response = await api.get(workspacePath(workspaceId, `/projects/${projectId}/state`));

  assert.equal(response.status, 200, response.text);

  return response.body as Record<string, unknown>;
}

async function stateCommand(
  projectId: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<TestApi['post']>>> {
  return api.post(workspacePath(workspaceId, `/projects/${projectId}/state-commands`), body);
}

test('returns the initial state with its own revision and dependency versions', async () => {
  const project = await createProject();
  const state = await readState(project.project_id);

  assert.equal(state.project_id, project.project_id);
  assert.equal(state.phase_key, 'DISCOVERY');
  assert.equal(state.next_action_task_id, null);
  assert.equal(state.revision, '0');
  assert.match(state.updated_at as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u);
  assert.deepEqual(state.in_progress, []);
  assert.deepEqual(state.blockers, []);
  assert.deepEqual(state.risks, []);
  assert.deepEqual(state.completed_highlight_refs, []);
  assert.deepEqual(state.selected_artifact_version_refs, []);
  assert.deepEqual(state.key_decision_refs, []);
  assert.deepEqual(state.allowed_actions, [
    'SET_PHASE',
    'SET_NEXT_ACTION',
    'SELECT_ARTIFACT_VERSION',
    'ADD_CONFIRMED_RISK',
    'RESOLVE_BLOCKER',
  ]);
  assert.deepEqual(state.dependency_versions, {
    project: '0',
    state: '0',
    workspace_authority: '0',
    project_goals: [],
    tasks: [],
    completion_refs: [],
    artifact_version_refs: [],
  });
});

test('rejects whole-object overwrites and unknown state fields', async () => {
  const project = await createProject();
  const withObjectPayload = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'SET_PHASE',
    phase_key: 'DESIGN',
    project_state: { phase_key: 'RELEASE', revision: '9' },
  });
  const objectProblem = expectProblem(withObjectPayload, 422, 'VALIDATION_FAILED');

  assert.ok((objectProblem.field_errors ?? []).some((error) => error.field.includes('project_state')));

  const unknownAction = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'REPLACE_STATE',
  });

  expectProblem(unknownAction, 422, 'VALIDATION_FAILED');

  const crossActionField = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'SET_PHASE',
    phase_key: 'DESIGN',
    statement: '不属于 SET_PHASE 的参数',
  });
  const crossProblem = expectProblem(crossActionField, 422, 'VALIDATION_FAILED');

  assert.equal(crossProblem.field_errors?.[0]?.field, 'statement');

  // 被拒绝的命令不写任何事实：State 仍停留在 revision 0。
  assert.equal((await readState(project.project_id)).revision, '0');
});

test('applies SET_PHASE with command replay and rejects a stale revision', async () => {
  const project = await createProject();
  const commandId = randomUUID();
  const body = {
    command_id: commandId,
    expected_revision: '0',
    action: 'SET_PHASE',
    phase_key: 'IMPLEMENTATION',
  };
  const accepted = await stateCommand(project.project_id, body);
  const result = expectCommandAccepted(accepted, 200, commandId);

  assert.equal(result.revision, '1');
  assert.equal(result.action, 'SET_PHASE');
  assert.equal((await readState(project.project_id)).phase_key, 'IMPLEMENTATION');

  const replay = await stateCommand(project.project_id, body);

  assert.equal(replay.headers['command-replayed'], 'true');
  assert.equal(replay.status, 200);
  assert.equal((replay.body as { result: { revision: string } }).result.revision, '1');

  // A02：过期 revision 不覆盖已推进的版本，返回当前版本供重新决定。
  const stale = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'SET_PHASE',
    phase_key: 'RELEASE',
  });
  const problem = expectProblem(stale, 409, 'REVISION_CONFLICT');

  assert.deepEqual(problem.conflict, {
    entity_type: 'PROJECT_STATE',
    expected_revision: '0',
    actual_revision: '1',
  });

  const state = await readState(project.project_id);

  assert.equal(state.phase_key, 'IMPLEMENTATION');
  assert.equal(state.revision, '1');
});

test('accepts only the built-in phases of the project type and leaves rejected commands unrecorded', async () => {
  const validCases = [
    { projectType: 'GENERAL' as const, phaseKey: 'EXECUTING' },
    { projectType: 'THESIS' as const, phaseKey: 'METHOD' },
    { projectType: 'DEVELOPMENT' as const, phaseKey: 'VALIDATION' },
  ];

  for (const validCase of validCases) {
    const project = await createProject(validCase.projectType);
    const commandId = randomUUID();
    const accepted = await stateCommand(project.project_id, {
      command_id: commandId,
      expected_revision: '0',
      action: 'SET_PHASE',
      phase_key: validCase.phaseKey,
    });

    assert.equal(expectCommandAccepted(accepted, 200, commandId).revision, '1');
    assert.equal((await readState(project.project_id)).phase_key, validCase.phaseKey);
  }

  const project = await createProject('GENERAL');
  const rejectedCases = ['NOT_A_REAL_PHASE', 'TOPIC', '   '];
  const rejectedCommandIds: string[] = [];

  for (const phaseKey of rejectedCases) {
    const commandId = randomUUID();
    rejectedCommandIds.push(commandId);
    const rejected = await stateCommand(project.project_id, {
      command_id: commandId,
      expected_revision: '0',
      action: 'SET_PHASE',
      phase_key: phaseKey,
    });
    const problem = expectProblem(rejected, 422, 'VALIDATION_FAILED');

    assert.equal(problem.field_errors?.[0]?.field, 'phase_key');
  }

  const state = await readState(project.project_id);

  assert.equal(state.phase_key, 'PLANNING');
  assert.equal(state.revision, '0');

  const rejectedWrites = await sql<{ receipt_count: bigint; activity_count: bigint }>`
    select
      (select count(*) from command_receipts where command_id = any(${rejectedCommandIds}::uuid[]))
        as receipt_count,
      (select count(*) from activity_records where command_id = any(${rejectedCommandIds}::uuid[]))
        as activity_count
  `.execute(app.db);

  assert.equal(rejectedWrites.rows[0]?.receipt_count, 0n);
  assert.equal(rejectedWrites.rows[0]?.activity_count, 0n);
});

test('sets the next action only for tasks of the project and exposes its version', async () => {
  const project = await createProject();
  const task = await createTask(project.project_id);
  const otherProject = await createProject();
  const foreignTask = await createTask(otherProject.project_id);

  const accepted = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'SET_NEXT_ACTION',
    next_action_task_id: task.task_id,
  });

  assert.equal(accepted.status, 200, accepted.text);

  const state = await readState(project.project_id);

  assert.equal(state.next_action_task_id, task.task_id);
  assert.equal(state.revision, '1');
  assert.deepEqual(
    (state.dependency_versions as { tasks: readonly unknown[] }).tasks,
    [{ task_id: task.task_id, revision: task.revision }],
  );

  const clearing = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '1',
    action: 'SET_NEXT_ACTION',
    next_action_task_id: null,
  });

  assert.equal(clearing.status, 200, clearing.text);
  assert.equal((await readState(project.project_id)).next_action_task_id, null);

  const foreign = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '2',
    action: 'SET_NEXT_ACTION',
    next_action_task_id: foreignTask.task_id,
  });
  const problem = expectProblem(foreign, 422, 'VALIDATION_FAILED');

  assert.equal(problem.field_errors?.[0]?.field, 'next_action_task_id');
});

test('selects an artifact version through a typed action and refuses duplicates', async () => {
  const project = await createProject();
  const task = await createTask(project.project_id);
  const versionId = await seedArtifactVersion(workspaceId, project.project_id, task.task_id);

  const accepted = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'SELECT_ARTIFACT_VERSION',
    artifact_version_id: versionId,
    source_ref: 'task:manual-check',
  });

  assert.equal(accepted.status, 200, accepted.text);

  const state = await readState(project.project_id);

  assert.deepEqual(state.selected_artifact_version_refs, [
    {
      artifact_version_id: versionId,
      artifact_id: (state.selected_artifact_version_refs as readonly { artifact_id: string }[])[0]
        ?.artifact_id,
      version_number: '1',
      source_ref: 'task:manual-check',
    },
  ]);

  const duplicate = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '1',
    action: 'SELECT_ARTIFACT_VERSION',
    artifact_version_id: versionId,
    source_ref: 'task:manual-check',
  });

  expectProblem(duplicate, 409, 'INVALID_TRANSITION');
  assert.equal((await readState(project.project_id)).revision, '1');

  const otherProject = await createProject();
  const foreign = await stateCommand(otherProject.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'SELECT_ARTIFACT_VERSION',
    artifact_version_id: versionId,
    source_ref: 'task:manual-check',
  });

  expectProblem(foreign, 404, 'RESOURCE_NOT_FOUND');
});

test('adds a confirmed risk and resolves a blocker with typed actions', async () => {
  const project = await createProject();
  const task = await createTask(project.project_id);
  const blockerId = await seedBlocker(project.project_id, task.task_id);

  const risk = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '0',
    action: 'ADD_CONFIRMED_RISK',
    statement: '样本量可能不足',
    source_ref: 'decision-review',
    confirmation_ref: 'user:confirmed',
  });

  assert.equal(risk.status, 200, risk.text);

  const state = await readState(project.project_id);

  assert.equal((state.risks as readonly unknown[]).length, 1);
  assert.deepEqual(
    (state.blockers as readonly { blocker_id: string; resolved_at: string | null }[]).map(
      (blocker) => [blocker.blocker_id, blocker.resolved_at],
    ),
    [[blockerId, null]],
  );

  const resolved = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '1',
    action: 'RESOLVE_BLOCKER',
    blocker_id: blockerId,
  });

  assert.equal(resolved.status, 200, resolved.text);

  const afterResolve = await readState(project.project_id);

  assert.equal(
    (afterResolve.blockers as readonly { resolved_at: string | null }[])[0]?.resolved_at !== null,
    true,
  );
  assert.equal(afterResolve.revision, '2');

  const again = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '2',
    action: 'RESOLVE_BLOCKER',
    blocker_id: blockerId,
  });

  expectProblem(again, 409, 'INVALID_TRANSITION');

  const unknown = await stateCommand(project.project_id, {
    command_id: randomUUID(),
    expected_revision: '2',
    action: 'RESOLVE_BLOCKER',
    blocker_id: randomUUID(),
  });

  expectProblem(unknown, 404, 'RESOURCE_NOT_FOUND');
});

test('keeps in_progress and project goals in the dependency versions', async () => {
  const project = await createProject();
  const task = await createTask(project.project_id);
  const goalCommandId = randomUUID();
  const goalResponse = await api.post(workspacePath(workspaceId, '/goals'), {
    command_id: goalCommandId,
    title: 'state-goal',
  });
  const goalId = expectCommandAccepted(goalResponse, 201, goalCommandId).goal_id as string;

  assert.equal(
    (
      await api.post(workspacePath(workspaceId, `/projects/${project.project_id}/goal-links`), {
        command_id: randomUUID(),
        expected_revision: project.revision,
        goal_id: goalId,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
        command_id: randomUUID(),
        expected_revision: task.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/start`), {
        command_id: randomUUID(),
        expected_revision: '1',
      })
    ).status,
    200,
  );

  const state = await readState(project.project_id);
  const dependencyVersions = state.dependency_versions as Record<string, unknown>;

  assert.deepEqual(state.in_progress, [
    {
      task_id: task.task_id,
      title: 'state-task',
      status: 'IN_PROGRESS',
      mode: 'ME',
      revision: '2',
    },
  ]);
  assert.equal(dependencyVersions.project, '1');
  assert.equal(dependencyVersions.state, '0');
  assert.deepEqual(dependencyVersions.project_goals, [
    { goal_id: goalId, revision: '0', status: 'ACTIVE' },
  ]);
  assert.deepEqual(dependencyVersions.tasks, [{ task_id: task.task_id, revision: '2' }]);
});

test('lets exactly one concurrent state command win the same revision', async () => {
  const project = await createProject();
  const responses = await Promise.all([
    stateCommand(project.project_id, {
      command_id: randomUUID(),
      expected_revision: '0',
      action: 'SET_PHASE',
      phase_key: 'IMPLEMENTATION',
    }),
    stateCommand(project.project_id, {
      command_id: randomUUID(),
      expected_revision: '0',
      action: 'ADD_CONFIRMED_RISK',
      statement: '并发风险',
      source_ref: 'concurrency-test',
      confirmation_ref: 'user:confirmed',
    }),
  ]);

  assert.equal(responses.filter((response) => response.status === 200).length, 1);

  const loser = responses.find((response) => response.status !== 200);

  if (loser === undefined) {
    throw new Error('one concurrent state command was expected to fail');
  }

  expectProblem(loser, 409, 'REVISION_CONFLICT');
  assert.equal((await readState(project.project_id)).revision, '1');
});

test('requires the local bearer and hides state of other workspaces', async () => {
  const project = await createProject();
  const otherWorkspace = await createWorkspace(app.db);

  const unauthenticated = await api.get(
    workspacePath(workspaceId, `/projects/${project.project_id}/state`),
    { headers: { authorization: '' } },
  );

  expectProblem(unauthenticated, 401, 'AUTH_REQUIRED');

  const foreign = await api.get(
    workspacePath(otherWorkspace, `/projects/${project.project_id}/state`),
  );

  expectProblem(foreign, 404, 'RESOURCE_NOT_FOUND');

  const foreignCommand = await api.post(
    workspacePath(otherWorkspace, `/projects/${project.project_id}/state-commands`),
    {
      command_id: randomUUID(),
      expected_revision: '0',
      action: 'SET_PHASE',
      phase_key: 'DESIGN',
    },
  );

  expectProblem(foreignCommand, 404, 'RESOURCE_NOT_FOUND');
});

/** 用应用角色与真实 Repository 播种 Artifact 版本（P03 之前没有 HTTP 写入口）。 */
async function seedArtifactVersion(
  workspaceId: string,
  projectId: string,
  taskId: string,
): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const artifactId = randomUUID();
    const versionId = randomUUID();

    await repositories.artifacts.insertArtifact({
      id: artifactId,
      workspaceId,
      projectId,
      taskId,
      artifactKind: 'MARKDOWN_DOCUMENT',
      title: 'state-artifact',
    });
    await repositories.artifacts.insertArtifactVersion({
      id: versionId,
      artifactId,
      versionNumber: 1n,
      storageRef: `artifacts/${artifactId}/${versionId}/content.md`,
      contentHash: createHash('sha256').update('body', 'utf8').digest(),
      size: 4n,
      mediaType: 'text/markdown',
      sourceKind: 'HUMAN',
      sourceRef: null,
    });

    return versionId;
  });
}

/** 播种未解除的 blocker（P02 没有创建 blocker 的 HTTP 入口，见实现状态说明）。 */
async function seedBlocker(projectId: string, taskId: string): Promise<string> {
  return withTransaction(app.db, (repositories) =>
    repositories.projects
      .insertBlocker({
        id: randomUUID(),
        projectId,
        targetKind: 'TASK',
        targetId: taskId,
        reason: '上游资料尚未确认',
        sourceRef: 'test:seed',
      })
      .then((blocker) => blocker.id),
  );
}
