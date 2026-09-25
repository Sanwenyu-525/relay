import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

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
  type HttpResponse,
  type TestApi,
} from './api-harness.js';

/**
 * P02：Project / Goal / Task 的真实 HTTP + 真实 PostgreSQL 验收。
 *
 * 覆盖契约第 2、3、6、7 节与 A01/A02（命令身份与版本）、A08（无 Project 的 Me Inbox）、
 * A09（Project Goal 关联与显式对齐）。所有断言走真实监听端口，不使用 Mock DB。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p02-tasks');

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
  await api.stop();
  await app.close();
});

interface ProjectFixture {
  readonly project_id: string;
  readonly revision: string;
}

interface TaskFixture {
  readonly task_id: string;
  readonly revision: string;
  readonly acceptance_revision: string;
  readonly status: string;
  readonly mode: string;
}

async function createProject(title = 'p02-project'): Promise<ProjectFixture> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId,
    title,
    project_type: 'GENERAL',
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return { project_id: result.project_id as string, revision: result.revision as string };
}

async function createTask(input: {
  readonly projectId?: string | null;
  readonly title?: string;
  readonly objective?: string;
  readonly criteria?: readonly { readonly statement: string; readonly criterion_id?: string }[];
  readonly mode?: string;
}): Promise<TaskFixture> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId,
    project_id: input.projectId ?? null,
    title: input.title ?? 'p02-task',
    objective: input.objective ?? '完成 P02 的人工闭环验证',
    mode: input.mode,
    criteria: input.criteria ?? [{ statement: '人工核对结果与引用' }],
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return {
    task_id: result.task_id as string,
    revision: result.revision as string,
    acceptance_revision: result.acceptance_revision as string,
    status: result.status as string,
    mode: result.mode as string,
  };
}

async function createGoal(title = 'p02-goal'): Promise<{ goal_id: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/goals'), {
    command_id: commandId,
    title,
    description: 'P02 Goal',
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return { goal_id: result.goal_id as string, revision: result.revision as string };
}

async function readTask(taskId: string): Promise<Record<string, unknown>> {
  const response = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));

  assert.equal(response.status, 200, response.text);

  return response.body as Record<string, unknown>;
}

async function readProjectGoals(projectId: string): Promise<readonly Record<string, unknown>[]> {
  const response = await api.get(workspacePath(workspaceId, `/projects/${projectId}/goals`));

  assert.equal(response.status, 200, response.text);

  return (response.body as { items: readonly Record<string, unknown>[] }).items;
}

async function linkGoal(projectId: string, goalId: string, expectedRevision: string): Promise<HttpResponse> {
  return api.post(workspacePath(workspaceId, `/projects/${projectId}/goal-links`), {
    command_id: randomUUID(),
    expected_revision: expectedRevision,
    goal_id: goalId,
  });
}

test('creates a project with its state and returns the documented envelope', async () => {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId,
    title: '论文项目',
    project_type: 'THESIS',
  });
  const result = expectCommandAccepted(response, 201, commandId);

  assert.equal(typeof result.project_id, 'string');
  assert.equal(result.revision, '0');
  assert.equal(result.phase_key, 'TOPIC');
  assert.equal(result.state_revision, '0');

  const read = await api.get(workspacePath(workspaceId, `/projects/${result.project_id}`));

  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    id: result.project_id,
    title: '论文项目',
    project_type: 'THESIS',
    archived_at: null,
    revision: '0',
    state_revision: '0',
    created_at: (read.body as { created_at: string }).created_at,
    updated_at: (read.body as { updated_at: string }).updated_at,
  });
  assert.match(
    (read.body as { created_at: string }).created_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u,
  );
});

test('creates an INBOX task with an immutable acceptance v1 and HUMAN execution', async () => {
  const project = await createProject('task-detail-project');
  const task = await createTask({
    projectId: project.project_id,
    criteria: [
      { criterion_id: 'summary-reviewed', statement: '核对摘要与引用' },
      { statement: '核对结论' },
    ],
  });

  assert.equal(task.status, 'INBOX');
  assert.equal(task.mode, 'ME');
  assert.equal(task.acceptance_revision, '1');

  const detail = await readTask(task.task_id);

  assert.equal(detail.id, task.task_id);
  assert.equal(detail.project_id, project.project_id);
  assert.equal(detail.status, 'INBOX');
  assert.equal(detail.mode, 'ME');
  assert.equal(detail.revision, '0');
  assert.equal(detail.acceptance_revision, '1');
  assert.deepEqual(detail.executor, { kind: 'HUMAN', run_id: null, ownership_epoch: '0' });
  assert.equal(detail.current_completion_id, null);
  assert.equal(detail.waiting_reason, null);
  assert.deepEqual(detail.blocking_task_ids, []);
  assert.deepEqual(detail.unresolved_blocker_ids, []);
  assert.deepEqual(detail.allowed_actions, ['EDIT_PRESENTATION', 'MARK_READY', 'CANCEL']);

  const acceptance = detail.acceptance as Record<string, unknown>;

  assert.equal(acceptance.acceptance_revision, '1');
  assert.equal(acceptance.objective, '完成 P02 的人工闭环验证');
  assert.equal(acceptance.source, 'CREATE');
  assert.deepEqual(acceptance.expected_outputs, {});

  const criteria = acceptance.criteria as readonly Record<string, unknown>[];

  assert.deepEqual(
    criteria.map((criterion) => criterion.criterion_id),
    ['c2', 'summary-reviewed'],
  );
  assert.equal(criteria[0]?.required, true);
  assert.equal(criteria[0]?.method, 'HUMAN');
  assert.deepEqual(detail.goal_alignment, {
    mode: 'INHERIT',
    goal_ids: [],
    effective_goal_ids: [],
  });
  assert.deepEqual(detail.dependencies, []);
});

test('moves INBOX to READY to IN_PROGRESS only through explicit commands', async () => {
  const project = await createProject('transition-project');
  const task = await createTask({ projectId: project.project_id });

  const rejected = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/start`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });

  assert.equal(expectProblem(rejected, 409, 'INVALID_TRANSITION').conflict?.task_id, task.task_id);

  const readyCommand = randomUUID();
  const ready = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: readyCommand,
    expected_revision: task.revision,
  });
  const readyResult = expectCommandAccepted(ready, 200, readyCommand);

  assert.equal(readyResult.status, 'READY');
  assert.equal(readyResult.revision, '1');

  const started = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/start`), {
    command_id: randomUUID(),
    expected_revision: '1',
  });
  const startResult = expectCommandAccepted(started, 200, (started.body as { command_id: string }).command_id);

  assert.equal(startResult.status, 'IN_PROGRESS');
  assert.equal(startResult.revision, '2');

  const cancelled = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/cancel`), {
    command_id: randomUUID(),
    expected_task_revision: '2',
  });
  const cancelResult = expectCommandAccepted(cancelled, 200, (cancelled.body as { command_id: string }).command_id);

  assert.equal(cancelResult.status, 'CANCELLED');
  assert.equal(cancelResult.revision, '3');

  const again = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/cancel`), {
    command_id: randomUUID(),
    expected_task_revision: '3',
  });

  expectProblem(again, 409, 'INVALID_TRANSITION');

  const reReady = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: '3',
  });

  expectProblem(reReady, 409, 'INVALID_TRANSITION');
});

test('refuses to mark a task ready without any required criterion', async () => {
  const project = await createProject('no-criteria-project');
  const task = await createTask({ projectId: project.project_id, criteria: [] });
  const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });
  const problem = expectProblem(response, 409, 'INVALID_TRANSITION');

  assert.match(problem.detail, /必需 criterion/u);

  const detail = await readTask(task.task_id);

  assert.equal(detail.status, 'INBOX');
  assert.deepEqual(detail.allowed_actions, ['EDIT_PRESENTATION', 'CANCEL']);
});

test('edits only presentation fields and rejects status or acceptance changes', async () => {
  const project = await createProject('presentation-project');
  const task = await createTask({ projectId: project.project_id });

  const forbidden = await api.patch(workspacePath(workspaceId, `/tasks/${task.task_id}`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
    title: '新标题',
    status: 'DONE',
  });
  const problem = expectProblem(forbidden, 422, 'VALIDATION_FAILED');

  assert.ok((problem.field_errors ?? []).some((error) => error.field.includes('status')));

  const commandId = randomUUID();
  const accepted = await api.patch(workspacePath(workspaceId, `/tasks/${task.task_id}`), {
    command_id: commandId,
    expected_revision: task.revision,
    title: '  新标题  ',
  });
  const result = expectCommandAccepted(accepted, 200, commandId);

  assert.equal(result.revision, '1');

  const detail = await readTask(task.task_id);

  assert.equal(detail.title, '新标题');
  assert.equal(detail.status, 'INBOX');
  assert.equal(detail.acceptance_revision, '1');
});

test('replays a command with the same payload and rejects a reused command_id', async () => {
  const project = await createProject('replay-project');
  const commandId = randomUUID();
  const body = {
    command_id: commandId,
    title: '重放项目',
    project_type: 'GENERAL' as const,
  };
  const first = await api.post(workspacePath(workspaceId, '/projects'), body);
  const result = expectCommandAccepted(first, 201, commandId);

  assert.equal(first.headers['command-replayed'], undefined);

  const replay = await api.post(workspacePath(workspaceId, '/projects'), body);
  const replayResult = expectCommandAccepted(replay, 201, commandId);

  assert.equal(replayResult.project_id, result.project_id);
  assert.equal(replay.headers['command-replayed'], 'true');

  const conflict = await api.post(workspacePath(workspaceId, '/projects'), {
    ...body,
    title: '不同标题',
  });
  const problem = expectProblem(conflict, 409, 'COMMAND_ID_REUSED');

  assert.equal(problem.command_id, commandId);
  assert.equal(problem.retry_action, 'NONE');

  const receipt = await api.get(workspacePath(workspaceId, `/commands/${commandId}`));

  assert.equal(receipt.status, 200);

  const receiptBody = receipt.body as Record<string, unknown>;

  assert.equal(receiptBody.command_id, commandId);
  assert.equal(receiptBody.command_type, 'CreateProject');
  assert.deepEqual(receiptBody.result, result);
  assert.equal(
    (receiptBody.links as { resource: string }).resource,
    workspacePath(workspaceId, `/projects/${result.project_id as string}`),
  );

  const missing = await api.get(workspacePath(workspaceId, `/commands/${randomUUID()}`));

  expectProblem(missing, 404, 'COMMAND_NOT_FOUND');
});

test('rejects a stale revision and reports the current one', async () => {
  const project = await createProject('revision-project');
  const task = await createTask({ projectId: project.project_id });

  const ready = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });

  assert.equal(ready.status, 200);

  const stale = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/start`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });
  const problem = expectProblem(stale, 409, 'REVISION_CONFLICT');

  assert.deepEqual(problem.conflict, {
    entity_type: 'TASK',
    expected_revision: '0',
    actual_revision: '1',
  });
  assert.equal(problem.retry_action, 'REFRESH_AND_REDECIDE');
});

test('lets exactly one of two concurrent clients win the same revision', async () => {
  const project = await createProject('concurrent-project');
  const task = await createTask({ projectId: project.project_id });
  const target = workspacePath(workspaceId, `/tasks/${task.task_id}`);

  const responses = await Promise.all([
    api.patch(target, {
      command_id: randomUUID(),
      expected_revision: task.revision,
      title: 'client A',
    }),
    api.patch(target, {
      command_id: randomUUID(),
      expected_revision: task.revision,
      title: 'client B',
    }),
  ]);
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [200, 409]);

  const loser = responses.find((response) => response.status === 409);

  if (loser === undefined) {
    throw new Error('one concurrent command was expected to fail');
  }

  const problem = expectProblem(loser, 409, 'REVISION_CONFLICT');

  assert.equal(problem.conflict?.actual_revision, '1');

  const detail = await readTask(task.task_id);

  assert.equal(detail.revision, '1');
  assert.ok(['client A', 'client B'].includes(detail.title as string));
});

test('missing required revision input is rejected as a field error', async () => {
  const project = await createProject('missing-revision-project');
  const task = await createTask({ projectId: project.project_id });
  const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: randomUUID(),
  });
  const problem = expectProblem(response, 422, 'VALIDATION_FAILED');

  assert.ok((problem.field_errors ?? []).some((error) => error.field.includes('expected_revision')));
});

test('handles a Me Inbox task without a project and refuses Delegate mode', async () => {
  const task = await createTask({ title: '收件箱小事', criteria: [{ statement: '人工确认' }] });

  assert.equal((await readTask(task.task_id)).project_id, null);

  const list = await api.get(workspacePath(workspaceId, '/tasks?inbox=true'));

  assert.equal(list.status, 200);

  const items = (list.body as { items: readonly Record<string, unknown>[] }).items;

  assert.ok(items.some((item) => item.id === task.task_id));

  const ready = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: task.revision,
  });

  assert.equal(ready.status, 200, ready.text);
  assert.equal((ready.body as { result: { status: string } }).result.status, 'READY');

  const delegate = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: randomUUID(),
    project_id: null,
    title: '委托任务',
    objective: '不允许在本阶段委托',
    mode: 'DELEGATE_AI',
  });
  const problem = expectProblem(delegate, 409, 'CAPABILITY_DISABLED');

  assert.equal(problem.field_errors?.[0]?.field, 'mode');
});

test('rejects self dependencies, cycles, cross-project and cross-workspace references', async () => {
  const first = await createProject('dependency-project');
  const second = await createProject('dependency-project-2');
  const upstream = await createTask({ projectId: first.project_id });
  const downstream = await createTask({ projectId: first.project_id });
  const otherProjectTask = await createTask({ projectId: second.project_id });

  const self = await api.post(
    workspacePath(workspaceId, `/tasks/${upstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: upstream.revision,
      depends_on_task_id: upstream.task_id,
      dependency_kind: 'BLOCKS',
    },
  );

  assert.equal(expectProblem(self, 409, 'DEPENDENCY_CYCLE').conflict?.depends_on_task_id, upstream.task_id);

  const link = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: downstream.revision,
      depends_on_task_id: upstream.task_id,
      dependency_kind: 'BLOCKS',
    },
  );

  assert.equal(link.status, 200, link.text);
  assert.equal((link.body as { result: { revision: string } }).result.revision, '1');

  const cycle = await api.post(
    workspacePath(workspaceId, `/tasks/${upstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: upstream.revision,
      depends_on_task_id: downstream.task_id,
      dependency_kind: 'BLOCKS',
    },
  );
  const cycleProblem = expectProblem(cycle, 409, 'DEPENDENCY_CYCLE');

  assert.equal(cycleProblem.conflict?.task_id, upstream.task_id);

  const duplicate = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      depends_on_task_id: upstream.task_id,
      dependency_kind: 'INFORMS',
    },
  );

  expectProblem(duplicate, 409, 'INVALID_TRANSITION');

  const crossProject = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      depends_on_task_id: otherProjectTask.task_id,
      dependency_kind: 'BLOCKS',
    },
  );
  const crossProjectProblem = expectProblem(crossProject, 422, 'VALIDATION_FAILED');

  assert.equal(crossProjectProblem.field_errors?.[0]?.field, 'depends_on_task_id');

  const otherWorkspace = await createWorkspace(app.db);
  const foreignCommand = randomUUID();
  const foreignTaskResponse = await api.post(workspacePath(otherWorkspace, '/tasks'), {
    command_id: foreignCommand,
    project_id: null,
    title: '其他作用域任务',
    objective: '不应被当前作用域引用',
  });
  const foreignTaskId = expectCommandAccepted(
    foreignTaskResponse,
    201,
    foreignCommand,
  ).task_id as string;
  const crossWorkspace = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      depends_on_task_id: foreignTaskId,
      dependency_kind: 'BLOCKS',
    },
  );

  expectProblem(crossWorkspace, 404, 'RESOURCE_NOT_FOUND');

  const foreignTask = await api.get(
    workspacePath(otherWorkspace, `/tasks/${downstream.task_id}`),
  );

  expectProblem(foreignTask, 404, 'RESOURCE_NOT_FOUND');
});

test('blocks ready while a BLOCKS dependency is unfinished and allows it after removal', async () => {
  const project = await createProject('blocking-project');
  const upstream = await createTask({ projectId: project.project_id });
  const downstream = await createTask({ projectId: project.project_id });

  const link = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-links`),
    {
      command_id: randomUUID(),
      expected_revision: downstream.revision,
      depends_on_task_id: upstream.task_id,
      dependency_kind: 'BLOCKS',
    },
  );

  assert.equal(link.status, 200);
  assert.equal((link.body as { result: { revision: string } }).result.revision, '1');

  const blocked = await api.post(workspacePath(workspaceId, `/tasks/${downstream.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: '1',
  });
  const problem = expectProblem(blocked, 409, 'INVALID_TRANSITION');

  assert.deepEqual(problem.conflict?.blocking_task_ids, [upstream.task_id]);

  const detail = await readTask(downstream.task_id);

  assert.deepEqual(detail.blocking_task_ids, [upstream.task_id]);
  assert.deepEqual(detail.allowed_actions, ['EDIT_PRESENTATION', 'CANCEL']);
  assert.deepEqual(detail.dependencies, [
    {
      task_id: upstream.task_id,
      dependency_kind: 'BLOCKS',
      status: 'INBOX',
      title: 'p02-task',
    },
  ]);

  const unlink = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-unlinks`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      depends_on_task_id: upstream.task_id,
    },
  );

  assert.equal(unlink.status, 200, unlink.text);
  assert.equal((unlink.body as { result: { revision: string } }).result.revision, '2');

  const ready = await api.post(workspacePath(workspaceId, `/tasks/${downstream.task_id}/ready`), {
    command_id: randomUUID(),
    expected_revision: '2',
  });

  assert.equal(ready.status, 200, ready.text);

  const missing = await api.post(
    workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-unlinks`),
    {
      command_id: randomUUID(),
      expected_revision: '3',
      depends_on_task_id: upstream.task_id,
    },
  );

  expectProblem(missing, 404, 'RESOURCE_NOT_FOUND');
});

test('paginates project and inbox task lists with a bound cursor', async () => {
  const project = await createProject('pagination-project');
  const created: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    const task = await createTask({ projectId: project.project_id, title: `列表任务 ${index}` });

    created.push(task.task_id);
  }

  const firstPage = await api.get(
    workspacePath(workspaceId, `/tasks?project_id=${project.project_id}&limit=2`),
  );

  assert.equal(firstPage.status, 200);

  const firstBody = firstPage.body as {
    items: readonly { id: string }[];
    next_cursor: string | null;
  };

  assert.equal(firstBody.items.length, 2);
  assert.equal(typeof firstBody.next_cursor, 'string');
  assert.ok(created.includes(firstBody.items[0]?.id ?? ''));

  const secondPage = await api.get(
    workspacePath(workspaceId, `/tasks?project_id=${project.project_id}&limit=2&cursor=${firstBody.next_cursor}`),
  );
  const secondBody = secondPage.body as {
    items: readonly { id: string }[];
    next_cursor: string | null;
  };

  assert.equal(secondBody.items.length, 1);
  assert.equal(secondBody.next_cursor, null);

  const allIds = new Set([
    ...firstBody.items.map((item) => item.id),
    ...secondBody.items.map((item) => item.id),
  ]);

  assert.equal(allIds.size, 3);

  const illegal = await api.get(
    workspacePath(workspaceId, `/tasks?project_id=${project.project_id}&cursor=not-a-cursor`),
  );

  expectProblem(illegal, 400, 'INVALID_CURSOR');

  const mismatched = await api.get(
    workspacePath(workspaceId, `/tasks?inbox=true&cursor=${firstBody.next_cursor}`),
  );

  expectProblem(mismatched, 400, 'INVALID_CURSOR');

  const noFilter = await api.get(workspacePath(workspaceId, '/tasks'));
  const noFilterProblem = expectProblem(noFilter, 422, 'REQUIRED_INPUT_MISSING');

  assert.equal(noFilterProblem.field_errors?.[0]?.field, 'project_id');

  const emptyProjectId = await api.get(workspacePath(workspaceId, '/tasks?project_id='));

  expectProblem(emptyProjectId, 422, 'VALIDATION_FAILED');

  const tooLarge = await api.get(
    workspacePath(workspaceId, `/tasks?inbox=true&limit=101`),
  );
  const limitProblem = expectProblem(tooLarge, 422, 'VALIDATION_FAILED');

  assert.equal(limitProblem.field_errors?.[0]?.field, 'limit');
});

test('keeps cross-workspace resources invisible and requires the local bearer', async () => {
  const project = await createProject('scope-project');
  const task = await createTask({ projectId: project.project_id });
  const otherWorkspace = await createWorkspace(app.db);

  const foreignProject = await api.get(
    workspacePath(otherWorkspace, `/projects/${project.project_id}`),
  );

  expectProblem(foreignProject, 404, 'RESOURCE_NOT_FOUND');

  const foreignTask = await api.get(workspacePath(otherWorkspace, `/tasks/${task.task_id}`));

  expectProblem(foreignTask, 404, 'RESOURCE_NOT_FOUND');

  const foreignList = await api.get(
    workspacePath(otherWorkspace, `/tasks?project_id=${project.project_id}`),
  );

  assert.equal(foreignList.status, 404);

  const unknownWorkspace = await api.get(workspacePath(randomUUID(), '/tasks?inbox=true'));

  expectProblem(unknownWorkspace, 404, 'RESOURCE_NOT_FOUND');

  const unauthenticated = await api.get(workspacePath(workspaceId, `/tasks/${task.task_id}`), {
    headers: { authorization: '' },
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(expectProblem(unauthenticated, 401, 'AUTH_REQUIRED').retryable, false);

  const writeWithoutAuth = await api.post(
    workspacePath(workspaceId, '/projects'),
    { command_id: randomUUID(), title: 'x', project_type: 'GENERAL' },
    { headers: { authorization: '' } },
  );

  assert.equal(writeWithoutAuth.status, 401);
});

test('links and unlinks project goals with explicit inheritance semantics', async () => {
  const project = await createProject('goal-project');
  const goal = await createGoal('A09 目标');
  const inheritedTask = await createTask({ projectId: project.project_id });
  const explicitTask = await createTask({ projectId: project.project_id });

  const link = await linkGoal(project.project_id, goal.goal_id, project.revision);

  assert.equal(link.status, 200, link.text);

  const linked = (link.body as { result: { revision: string; goal_ids: readonly string[] } }).result;

  assert.equal(linked.revision, '1');
  assert.deepEqual(linked.goal_ids, [goal.goal_id]);

  const goals = await readProjectGoals(project.project_id);

  assert.deepEqual(goals, [
    {
      goal_id: goal.goal_id,
      title: 'A09 目标',
      status: 'ACTIVE',
      revision: goal.revision,
      explicit_task_ids: [],
    },
  ]);

  // 默认继承：无显式对齐的 Task 读取时继承 Project 当前 Goals。
  assert.deepEqual((await readTask(inheritedTask.task_id)).goal_alignment, {
    mode: 'INHERIT',
    goal_ids: [],
    effective_goal_ids: [goal.goal_id],
  });

  const duplicate = await linkGoal(project.project_id, goal.goal_id, '1');

  expectProblem(duplicate, 409, 'INVALID_TRANSITION');

  const staleLink = await linkGoal(project.project_id, goal.goal_id, project.revision);

  expectProblem(staleLink, 409, 'REVISION_CONFLICT');

  const inheritWithGoals = await api.post(
    workspacePath(workspaceId, `/tasks/${inheritedTask.task_id}/goal-alignment`),
    {
      command_id: randomUUID(),
      expected_revision: inheritedTask.revision,
      mode: 'INHERIT',
      goal_ids: [goal.goal_id],
    },
  );

  expectProblem(inheritWithGoals, 422, 'VALIDATION_FAILED');

  const explicit = await api.post(
    workspacePath(workspaceId, `/tasks/${explicitTask.task_id}/goal-alignment`),
    {
      command_id: randomUUID(),
      expected_revision: explicitTask.revision,
      mode: 'EXPLICIT',
      goal_ids: [goal.goal_id],
    },
  );

  assert.equal(explicit.status, 200, explicit.text);

  const explicitResult = (explicit.body as { result: Record<string, unknown> }).result;

  assert.equal(explicitResult.goal_alignment_mode, 'EXPLICIT');
  assert.deepEqual(explicitResult.goal_ids, [goal.goal_id]);

  const outsideGoal = await createGoal('未关联目标');
  const invalidSubset = await api.post(
    workspacePath(workspaceId, `/tasks/${explicitTask.task_id}/goal-alignment`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      mode: 'EXPLICIT',
      goal_ids: [outsideGoal.goal_id],
    },
  );
  const subsetProblem = expectProblem(invalidSubset, 409, 'GOAL_ALIGNMENT_INVALID');

  assert.deepEqual(subsetProblem.conflict?.goal_ids, [outsideGoal.goal_id]);

  const inboxTask = await createTask({ title: '无项目事项', criteria: [{ statement: '确认' }] });
  const inboxAlignment = await api.post(
    workspacePath(workspaceId, `/tasks/${inboxTask.task_id}/goal-alignment`),
    {
      command_id: randomUUID(),
      expected_revision: inboxTask.revision,
      mode: 'EXPLICIT',
      goal_ids: [],
    },
  );

  expectProblem(inboxAlignment, 409, 'GOAL_ALIGNMENT_INVALID');

  // 解除关联时清单不一致：返回 409 与当前实际清单，不静默清理。
  const staleUnlink = await api.post(
    workspacePath(workspaceId, `/projects/${project.project_id}/goal-unlinks`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      goal_id: goal.goal_id,
      expected_impacted_task_ids: [],
    },
  );
  const unlinkProblem = expectProblem(staleUnlink, 409, 'GOAL_LINK_IN_USE');

  assert.deepEqual(unlinkProblem.conflict?.impacted_task_ids, [explicitTask.task_id]);

  const unlink = await api.post(
    workspacePath(workspaceId, `/projects/${project.project_id}/goal-unlinks`),
    {
      command_id: randomUUID(),
      expected_revision: '1',
      goal_id: goal.goal_id,
      expected_impacted_task_ids: [explicitTask.task_id],
    },
  );

  assert.equal(unlink.status, 200, unlink.text);

  const unlinkResult = (unlink.body as { result: Record<string, unknown> }).result;

  assert.equal(unlinkResult.revision, '2');
  assert.deepEqual(unlinkResult.impacted_tasks, [{ task_id: explicitTask.task_id, revision: '2' }]);
  assert.deepEqual(await readProjectGoals(project.project_id), []);
  assert.deepEqual((await readTask(inheritedTask.task_id)).goal_alignment, {
    mode: 'INHERIT',
    goal_ids: [],
    effective_goal_ids: [],
  });

  // 显式空集与继承是两种事实：清理后仍是 EXPLICIT，但不再对齐任何 Goal。
  assert.deepEqual((await readTask(explicitTask.task_id)).goal_alignment, {
    mode: 'EXPLICIT',
    goal_ids: [],
    effective_goal_ids: [],
  });

  const missingLink = await api.post(
    workspacePath(workspaceId, `/projects/${project.project_id}/goal-unlinks`),
    {
      command_id: randomUUID(),
      expected_revision: '2',
      goal_id: goal.goal_id,
      expected_impacted_task_ids: [],
    },
  );

  expectProblem(missingLink, 404, 'RESOURCE_NOT_FOUND');
});

test('resolves concurrent goal changes deterministically', async () => {
  const project = await createProject('goal-concurrency-project');
  const goal = await createGoal('并发目标');
  const aligned = await createTask({ projectId: project.project_id });
  const linked = await linkGoal(project.project_id, goal.goal_id, project.revision);

  assert.equal(linked.status, 200);

  const alignment = await api.post(
    workspacePath(workspaceId, `/tasks/${aligned.task_id}/goal-alignment`),
    {
      command_id: randomUUID(),
      expected_revision: aligned.revision,
      mode: 'EXPLICIT',
      goal_ids: [goal.goal_id],
    },
  );

  assert.equal(alignment.status, 200, alignment.text);

  // 两个客户端用同一 Project revision 同时解除关联：只有一个成功。
  const races = await Promise.all([
    api.post(workspacePath(workspaceId, `/projects/${project.project_id}/goal-unlinks`), {
      command_id: randomUUID(),
      expected_revision: '1',
      goal_id: goal.goal_id,
      expected_impacted_task_ids: [aligned.task_id],
    }),
    api.post(workspacePath(workspaceId, `/projects/${project.project_id}/goal-unlinks`), {
      command_id: randomUUID(),
      expected_revision: '1',
      goal_id: goal.goal_id,
      expected_impacted_task_ids: [aligned.task_id],
    }),
  ]);

  assert.equal(races.filter((response) => response.status === 200).length, 1);

  for (const response of races) {
    if (response.status !== 200) {
      assert.equal(response.status, 409, response.text);
      assert.ok(['REVISION_CONFLICT', 'RESOURCE_NOT_FOUND', 'GOAL_LINK_IN_USE'].includes(
        (response.body as { code: string }).code,
      ));
    }
  }

  // 清单过期的解除与显式对齐并发：结果确定，且不留下指向已解除 Goal 的显式对齐。
  const staleProject = await createProject('goal-concurrency-project-2');
  const staleGoal = await createGoal('并发目标 2');
  const task = await createTask({ projectId: staleProject.project_id });

  assert.equal((await linkGoal(staleProject.project_id, staleGoal.goal_id, staleProject.revision)).status, 200);
  assert.equal(
    (
      await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/goal-alignment`), {
        command_id: randomUUID(),
        expected_revision: task.revision,
        mode: 'EXPLICIT',
        goal_ids: [staleGoal.goal_id],
      })
    ).status,
    200,
  );

  const outcomes = await Promise.all([
    api.post(workspacePath(workspaceId, `/projects/${staleProject.project_id}/goal-unlinks`), {
      command_id: randomUUID(),
      expected_revision: '1',
      goal_id: staleGoal.goal_id,
      expected_impacted_task_ids: [task.task_id],
    }),
    api.post(workspacePath(workspaceId, `/projects/${staleProject.project_id}/goal-unlinks`), {
      command_id: randomUUID(),
      expected_revision: '1',
      goal_id: staleGoal.goal_id,
      expected_impacted_task_ids: [],
    }),
  ]);

  assert.equal(outcomes.filter((response) => response.status === 200).length, 1);
  assert.deepEqual((await readTask(task.task_id)).goal_alignment, {
    mode: 'EXPLICIT',
    goal_ids: [],
    effective_goal_ids: [],
  });
  assert.deepEqual(await readProjectGoals(staleProject.project_id), []);
});