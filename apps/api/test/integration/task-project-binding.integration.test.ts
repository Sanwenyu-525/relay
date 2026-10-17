import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { requestAssistMessage } from '../../src/application/assist-commands.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-task-project-binding');
let api: TestApi;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

async function project(workspaceId: string, title = '归入测试项目') {
  const commandId = randomUUID();
  const result = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title, project_type: 'GENERAL',
  }), 201, commandId);
  return { id: result.project_id as string, revision: result.revision as string };
}

async function inboxTask(workspaceId: string, title = 'Inbox 原任务', criteria: readonly { criterion_id?: string; statement: string }[] = []) {
  const commandId = randomUUID();
  const result = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId, title, objective: '保留原目标',
    expected_outputs: {}, criteria,
  }), 201, commandId);
  return { id: result.task_id as string, revision: result.revision as string,
    acceptance_revision: result.acceptance_revision as string };
}

async function assign(workspaceId: string, taskId: string, revision: string, projectId: string,
  commandId = randomUUID()) {
  return api.post(workspacePath(workspaceId, `/tasks/${taskId}/project-binding`), {
    command_id: commandId, expected_revision: revision, project_id: projectId,
  });
}

test('Inbox 原 Task 归入项目后沿既有完成和重开链继续工作', async () => {
  const workspaceId = await createWorkspace(app.db);
  const target = await project(workspaceId);
  const goalCommand = randomUUID();
  const goal = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/goals'), {
    command_id: goalCommand, title: '本周交付', description: '',
  }), 201, goalCommand);
  const linkCommand = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(workspaceId, `/projects/${target.id}/goal-links`), {
    command_id: linkCommand, expected_revision: target.revision, goal_id: goal.goal_id,
  }), 200, linkCommand);
  const task = await inboxTask(workspaceId);
  const beforeTask = await api.get(workspacePath(workspaceId, `/tasks/${task.id}`));
  const acceptanceBefore = (beforeTask.body as { acceptance: unknown }).acceptance;

  const boundCommand = randomUUID();
  const bound = expectCommandAccepted(await assign(workspaceId, task.id, task.revision, target.id, boundCommand), 200, boundCommand) as
    { task_id: string; project_id: string; status: string; revision: string; acceptance_revision: string };
  assert.deepEqual([bound.task_id, bound.project_id, bound.status, bound.acceptance_revision],
    [task.id, target.id, 'INBOX', task.acceptance_revision]);
  const inbox = await api.get(workspacePath(workspaceId, '/tasks?inbox=true'));
  const projectTasks = await api.get(workspacePath(workspaceId, `/tasks?project_id=${target.id}`));
  assert.equal((inbox.body as { items: { id: string }[] }).items.some((row) => row.id === task.id), false);
  assert.equal((projectTasks.body as { items: { id: string }[] }).items.some((row) => row.id === task.id), true);
  const detail = await api.get(workspacePath(workspaceId, `/tasks/${task.id}`));
  assert.equal((detail.body as { project_id: string }).project_id, target.id);
  assert.deepEqual((detail.body as { acceptance: unknown }).acceptance, acceptanceBefore);
  assert.deepEqual((detail.body as { goal_alignment: { effective_goal_ids: string[] } }).goal_alignment.effective_goal_ids,
    [goal.goal_id]);

  const reviseCommand = randomUUID();
  const revisedAcceptance = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${task.id}/acceptance`), {
    command_id: reviseCommand, expected_revision: bound.revision,
    expected_acceptance_revision: task.acceptance_revision,
    criteria: [{ criterion_id: 'c1', statement: '人工检查正文' }],
  }), 200, reviseCommand) as { revision: string; acceptance_revision: string };
  assert.equal(revisedAcceptance.acceptance_revision, '2');

  const readyCommand = randomUUID();
  const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${task.id}/ready`), {
    command_id: readyCommand, expected_revision: revisedAcceptance.revision,
  }), 200, readyCommand);
  const startCommand = randomUUID();
  const started = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${task.id}/start`), {
    command_id: startCommand, expected_revision: ready.revision,
  }), 200, startCommand);
  const savedCommand = randomUUID();
  const saved = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${task.id}/artifacts`), {
    command_id: savedCommand, expected_task_revision: started.revision,
    title: '验收说明', media_type: 'text/markdown', content: '# 结果\n已完成人工核对。\n',
  }), 201, savedCommand);
  const content = await api.get(workspacePath(workspaceId, `/artifact-versions/${saved.version_id}/content`));
  assert.equal(content.status, 200, content.text);
  assert.equal(content.text, '# 结果\n已完成人工核对。\n');

  const completeCommand = randomUUID();
  const completed = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${task.id}/complete`), {
    command_id: completeCommand, expected_revision: saved.task_revision,
    acceptance_revision: revisedAcceptance.acceptance_revision, artifact_version_ids: [saved.version_id],
    acceptance: { statement: '正文已核对', accepted_criterion_ids: ['c1'] },
  }), 200, completeCommand);
  assert.equal(completed.status, 'DONE');
  const state = await api.get(workspacePath(workspaceId, `/projects/${target.id}/state`));
  assert.equal(state.status, 200, state.text);
  const completedRefs = (state.body as { completed_highlight_refs: { completion_id: string; task_id: string }[] }).completed_highlight_refs;
  assert.ok(completedRefs.some((row) => row.completion_id === completed.completion_id && row.task_id === task.id));
  const completion = await api.get(workspacePath(workspaceId, `/completion-records/${completed.completion_id}`));
  assert.equal(completion.status, 200, completion.text);
  assert.equal((completion.body as { is_current: boolean }).is_current, true);
  assert.deepEqual((completion.body as { artifact_versions: { artifact_version_id: string | null }[] }).artifact_versions
    .map((row) => row.artifact_version_id), [saved.version_id]);
  const continuationAfterComplete = await api.get(workspacePath(workspaceId,
    `/projects/${target.id}/daily-continuation`));
  assert.equal((continuationAfterComplete.body as { current: { open_task_ids: string[] } }).current.open_task_ids.includes(task.id), false);

  const reopenCommand = randomUUID();
  const reopened = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${task.id}/reopen`), {
    command_id: reopenCommand, expected_revision: completed.revision, reason: '补充说明后继续',
  }), 200, reopenCommand);
  assert.equal(reopened.status, 'READY');
  assert.equal(reopened.acceptance_revision, String(BigInt(revisedAcceptance.acceptance_revision as string) + 1n));
  const oldCompletion = await api.get(workspacePath(workspaceId, `/completion-records/${completed.completion_id}`));
  assert.equal((oldCompletion.body as { is_current: boolean }).is_current, false);
  const today = await api.get(workspacePath(workspaceId,
    `/today?date=${new Date().toISOString().slice(0, 10)}&timezone=UTC`));
  assert.equal(today.status, 200, today.text);
  assert.ok((today.body as { eligible_items: { task_id: string }[] }).eligible_items
    .some((row) => row.task_id === task.id));
  const reopenedTask = await api.get(workspacePath(workspaceId, `/tasks/${task.id}`));
  assert.equal((reopenedTask.body as { current_completion_id: string | null }).current_completion_id, null);
  const continuationAfterReopen = await api.get(workspacePath(workspaceId,
    `/projects/${target.id}/daily-continuation`));
  assert.ok((continuationAfterReopen.body as { current: { open_task_ids: string[] } }).current.open_task_ids.includes(task.id));
});

test('绑定会话保留身份并遵守回执、revision、Workspace、归档和在途约束', async () => {
  const workspaceId = await createWorkspace(app.db);
  const foreignWorkspace = await createWorkspace(app.db);
  const target = await project(workspaceId);
  const foreign = await project(foreignWorkspace, '外部项目');
  const task = await inboxTask(workspaceId, '带会话的Inbox任务');
  const sessionCommand = randomUUID();
  const session = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/assist-sessions'), {
    command_id: sessionCommand, task_id: task.id, title: '原讨论',
  }), 201, sessionCommand);
  const sessionId = session.session_id as string;
  const sessionBefore = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  const auditBefore = await sql<{ count: string }>`select count(*)::text as count from activity_records
    where event_type = 'TASK_PROJECT_ASSIGNED' and task_id = ${task.id}`.execute(app.db);
  const commandId = randomUUID();
  const first = expectCommandAccepted(await assign(workspaceId, task.id, task.revision, target.id, commandId), 200, commandId) as { revision: string };
  const replay = await assign(workspaceId, task.id, task.revision, target.id, commandId);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  const sessionAfter = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  assert.equal((sessionAfter.body as { id: string; project_id: string }).id, sessionId);
  assert.equal((sessionAfter.body as { project_id: string }).project_id, target.id);
  assert.equal((sessionAfter.body as { revision: string }).revision,
    String(BigInt((sessionBefore.body as { revision: string }).revision) + 1n));
  const auditAfter = await sql<{ count: string }>`select count(*)::text as count from activity_records
    where event_type = 'TASK_PROJECT_ASSIGNED' and task_id = ${task.id}`.execute(app.db);
  assert.equal(auditAfter.rows[0]?.count, String(BigInt(auditBefore.rows[0]?.count ?? '0') + 1n));
  const taskAfterReplay = await api.get(workspacePath(workspaceId, `/tasks/${task.id}`));
  assert.equal((taskAfterReplay.body as { revision: string }).revision, first.revision);
  const receipt = await api.get(workspacePath(workspaceId, `/commands/${commandId}`));
  assert.equal((receipt.body as { links: { resource: string } }).links.resource,
    `/api/v1/workspaces/${workspaceId}/tasks/${task.id}`);
  assert.equal((await assign(workspaceId, task.id, first.revision, foreign.id, commandId)).status, 409);
  assert.equal((await assign(workspaceId, task.id, task.revision, target.id)).status, 409);
  assert.equal((await assign(workspaceId, task.id, first.revision, foreign.id)).status, 404);

  const archived = await project(workspaceId, '待归入的归档项目');
  const archiveCommand = randomUUID();
  const archivedResponse = await api.post(workspacePath(workspaceId, `/projects/${archived.id}/archive`), {
    command_id: archiveCommand, expected_revision: archived.revision,
  });
  assert.equal(archivedResponse.status, 200, archivedResponse.text);
  const archivedTask = await inboxTask(workspaceId, '归档项目应拒绝');
  assert.equal((await assign(workspaceId, archivedTask.id, archivedTask.revision, archived.id)).status, 409);
  assert.equal((await api.get(workspacePath(workspaceId, `/tasks/${archivedTask.id}`))
    .then((r) => (r.body as { project_id: string | null }).project_id)), null);

  const inFlight = await inboxTask(workspaceId, '带在途消息');
  const pendingSessionCmd = randomUUID();
  const pendingSession = expectCommandAccepted(await api.post(workspacePath(workspaceId, '/assist-sessions'), {
    command_id: pendingSessionCmd, task_id: inFlight.id, title: '正在回复',
  }), 201, pendingSessionCmd);
  await requestAssistMessage(app.db, { workspaceId, sessionId: pendingSession.session_id as string,
    commandId: randomUUID(), content: '还在生成中的消息' });
  const rejected = await assign(workspaceId, inFlight.id, inFlight.revision, target.id);
  assert.equal(rejected.status, 409, rejected.text);
  const unchanged = await api.get(workspacePath(workspaceId, `/tasks/${inFlight.id}`));
  assert.equal((unchanged.body as { project_id: string | null }).project_id, null);
  const unchangedSession = await api.get(workspacePath(workspaceId,
    `/assist-sessions/${pendingSession.session_id as string}`));
  assert.equal((unchangedSession.body as { project_id: string | null }).project_id, null);
});

test('依赖、执行状态和重复归入均被拒绝，移除依赖后可首次归入', async () => {
  const workspaceId = await createWorkspace(app.db);
  const target = await project(workspaceId);
  const upstream = await inboxTask(workspaceId, '上游依赖');
  const downstream = await inboxTask(workspaceId, '待归入下游');
  const dependent = await inboxTask(workspaceId, '下游引用任务');
  // 上游也保持 Inbox，先通过 HTTP 命令建立依赖。
  const depCommand = randomUUID();
  const dep = await api.post(workspacePath(workspaceId, `/tasks/${downstream.id}/dependency-links`), {
    command_id: depCommand, expected_revision: downstream.revision,
    depends_on_task_id: upstream.id, dependency_kind: 'BLOCKS',
  });
  assert.equal(dep.status, 200, dep.text);
  const outgoingCommand = randomUUID();
  const outgoing = await api.post(workspacePath(workspaceId, `/tasks/${dependent.id}/dependency-links`), {
    command_id: outgoingCommand, expected_revision: dependent.revision,
    depends_on_task_id: downstream.id, dependency_kind: 'BLOCKS',
  });
  assert.equal(outgoing.status, 200, outgoing.text);
  const blocked = await assign(workspaceId, downstream.id,
    (dep.body as { result: { revision: string } }).result.revision, target.id);
  assert.equal(blocked.status, 409, blocked.text);
  const removeCommand = randomUUID();
  const removeOutgoing = await api.post(workspacePath(workspaceId, `/tasks/${dependent.id}/dependency-unlinks`), {
    command_id: removeCommand, expected_revision: (outgoing.body as { result: { revision: string } }).result.revision,
    depends_on_task_id: downstream.id,
  });
  assert.equal(removeOutgoing.status, 200, removeOutgoing.text);
  const removeIncomingCommand = randomUUID();
  const removed = await api.post(workspacePath(workspaceId,
    `/tasks/${downstream.id}/dependency-unlinks`), {
    command_id: removeIncomingCommand,
    expected_revision: (dep.body as { result: { revision: string } }).result.revision,
    depends_on_task_id: upstream.id,
  });
  assert.equal(removed.status, 200, removed.text);
  const readyCommand = randomUUID();
  const reviseCommand = randomUUID();
  const revised = expectCommandAccepted(await api.post(workspacePath(workspaceId,
    `/tasks/${downstream.id}/acceptance`), {
    command_id: reviseCommand, expected_revision: (removed.body as { result: { revision: string } }).result.revision,
    expected_acceptance_revision: '1', criteria: [{ criterion_id: 'c1', statement: '确认依赖任务结果' }],
  }), 200, reviseCommand) as { revision: string };
  const ready = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${downstream.id}/ready`), {
    command_id: readyCommand, expected_revision: revised.revision,
  }), 200, readyCommand) as { revision: string };
  const assignCommand = randomUUID();
  const assigned = expectCommandAccepted(await assign(workspaceId, downstream.id, ready.revision, target.id, assignCommand), 200, assignCommand) as { status: string; revision: string };
  assert.equal(assigned.status, 'READY');
  assert.equal((await assign(workspaceId, downstream.id, assigned.revision, target.id)).status, 409);

  const active = await inboxTask(workspaceId, '执行中任务', [{ criterion_id: 'c1', statement: '继续执行' }]);
  const activeReadyId = randomUUID();
  const activeReady = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${active.id}/ready`), {
    command_id: activeReadyId, expected_revision: active.revision,
  }), 200, activeReadyId) as { revision: string };
  const activeStartId = randomUUID();
  const started = expectCommandAccepted(await api.post(workspacePath(workspaceId, `/tasks/${active.id}/start`), {
    command_id: activeStartId, expected_revision: activeReady.revision,
  }), 200, activeStartId) as { revision: string };
  assert.equal((await assign(workspaceId, active.id, started.revision, target.id)).status, 409);

  const concurrentTask = await inboxTask(workspaceId, '会话并发任务');
  let createSessionResponse: ReturnType<TestApi['post']> | undefined;
  await app.db.transaction().execute(async (transaction) => {
    await sql`select id from tasks where id = ${concurrentTask.id} for update`.execute(transaction);
    createSessionResponse = api.post(workspacePath(workspaceId, '/assist-sessions'), {
      command_id: randomUUID(), task_id: concurrentTask.id, title: '锁后创建',
    });
    let waiting = false;
    for (let attempt = 0; attempt < 250 && !waiting; attempt += 1) {
      const state = await sql<{ waiting: boolean }>`select exists (
        select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike '%from tasks%' and query ilike '%for share%'
      ) as waiting`.execute(app.db);
      waiting = state.rows[0]?.waiting === true;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'Task 会话创建必须等待 Task FOR SHARE 锁');
    await sql`update tasks set project_id = ${target.id}, revision = revision + 1
      where id = ${concurrentTask.id}`.execute(transaction);
  });
  assert.ok(createSessionResponse);
  const createdSession = await createSessionResponse;
  assert.equal(createdSession.status, 201, createdSession.text);
  assert.equal((createdSession.body as { result: { project_id: string } }).result.project_id, target.id);
});
