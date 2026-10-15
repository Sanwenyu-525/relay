import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase, } from './integration-support.js';
import { createDataRoot, createWorkspace, expectCommandAccepted, expectProblem, startTestApi, workspacePath, } from './api-harness.js';
/**
 * P05：Delegate 的真实 HTTP + 真实 PostgreSQL 验收。
 *
 * 覆盖 A08（无 Project 拒绝 Delegate）、B01（并发 Delegate 至多一个 live Run）、B06（FAILED 后
 * retry_of 新 Run）、重复命令与执行权冲突。所有断言走真实监听端口与真实数据库，不使用 Mock DB。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p05-delegations');
let api;
let workspaceId;
let storageRoot;
before(async () => {
    await runMigrations({
        connectionString: MIGRATION_DATABASE_URL,
        directory: MIGRATIONS_DIRECTORY,
    });
    api = await startTestApi();
    workspaceId = await createWorkspace(app.db);
    storageRoot = await createDataRoot();
});
after(async () => {
    await api?.stop();
    await app.close();
});
async function createProject(title = 'p05-project') {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, '/projects'), {
        command_id: commandId,
        title,
        project_type: 'GENERAL',
    });
    const result = expectCommandAccepted(response, 201, commandId);
    return { project_id: result.project_id, revision: result.revision };
}
async function createTask(input) {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, '/tasks'), {
        command_id: commandId,
        project_id: input.projectId,
        title: input.title ?? 'p05-task',
        objective: '完成 P05 的 Delegate 验证',
        criteria: [{ statement: '人工核对结果与引用' }],
        ...(input.expectedOutputs === undefined ? {} : { expected_outputs: input.expectedOutputs }),
    });
    const result = expectCommandAccepted(response, 201, commandId);
    return {
        task_id: result.task_id,
        revision: result.revision,
        status: result.status,
    };
}
async function markReady(taskId, expectedRevision) {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, `/tasks/${taskId}/ready`), {
        command_id: commandId,
        expected_revision: expectedRevision,
    });
    const result = expectCommandAccepted(response, 200, commandId);
    return result.revision;
}
async function delegate(taskId, expectedTaskRevision, extra = {}) {
    return api.post(workspacePath(workspaceId, `/tasks/${taskId}/delegations`), {
        command_id: randomUUID(),
        expected_task_revision: expectedTaskRevision,
        ...extra,
    });
}
function expectAccepted202(response) {
    assert.equal(response.status, 202, response.text);
    return response.body.result;
}
async function readTask(taskId) {
    const response = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));
    assert.equal(response.status, 200, response.text);
    return response.body;
}
async function liveRunCount(taskId) {
    const result = await sql `
    select count(*) as count
    from runs
    where task_id = ${taskId}
      and status in (
        'CREATED', 'CONTEXT_BUILDING', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL',
        'VERIFYING', 'RETRYING', 'PAUSED'
      )
  `.execute(app.db);
    return result.rows[0]?.count ?? 0n;
}
test('delegates a READY project task and returns the documented 202 envelope', async () => {
    const project = await createProject('delegate-happy');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/delegations`), {
        command_id: commandId,
        expected_task_revision: readyRevision,
    });
    assert.equal(response.status, 202, response.text);
    const body = response.body;
    assert.equal(body.command_id, commandId);
    assert.equal(body.result.task_id, task.task_id);
    assert.equal(body.result.status, 'CREATED');
    assert.equal(body.result.run_revision, '0');
    assert.equal(body.result.retry_of_run_id, null);
    // createTask(revision 0) → ready(revision 1) → delegate(revision 2)。
    assert.equal(body.result.task_revision, '2');
    assert.match(body.links.resource, new RegExp(`/runs/${body.result.run_id}$`, 'u'));
    const detail = await readTask(task.task_id);
    const executor = detail.executor;
    assert.equal(detail.status, 'IN_PROGRESS');
    assert.equal(detail.mode, 'DELEGATE_AI');
    assert.equal(executor.kind, 'AI');
    assert.equal(executor.run_id, body.result.run_id);
    assert.equal(executor.ownership_epoch, '1');
    const run = await api.get(workspacePath(workspaceId, `/runs/${body.result.run_id}`));
    assert.equal(run.status, 200, run.text);
    const runBody = run.body;
    assert.equal(runBody.status, 'CREATED');
    assert.equal(runBody.retry_of_run_id, null);
    assert.equal(runBody.contract.workflow_key, 'markdown-deliverable-v1');
    assert.deepEqual(runBody.steps.map((step) => step.step_kind), ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE', 'VERIFY', 'COMPLETE']);
    assert.ok(runBody.steps.every((step) => step.status === 'PENDING'));
});
test('refuses to delegate a Me Inbox task without a project (A08)', async () => {
    const task = await createTask({ projectId: null, title: '收件箱事项' });
    const readyRevision = await markReady(task.task_id, task.revision);
    const response = await delegate(task.task_id, readyRevision);
    const problem = expectProblem(response, 409, 'INVALID_TRANSITION');
    assert.match(problem.detail, /Project/u);
    assert.equal((await readTask(task.task_id)).status, 'READY');
    assert.equal(await liveRunCount(task.task_id), 0n);
});
test('refuses to delegate a task that is not READY', async () => {
    const project = await createProject('not-ready');
    const task = await createTask({ projectId: project.project_id });
    const response = await delegate(task.task_id, task.revision);
    expectProblem(response, 409, 'INVALID_TRANSITION');
    assert.equal(await liveRunCount(task.task_id), 0n);
});
test('refuses to delegate while a BLOCKS dependency is unfinished', async () => {
    const project = await createProject('blocked-delegate');
    const upstream = await createTask({ projectId: project.project_id, title: '上游' });
    const downstream = await createTask({ projectId: project.project_id, title: '下游' });
    const readyRevision = await markReady(downstream.task_id, downstream.revision);
    const link = await api.post(workspacePath(workspaceId, `/tasks/${downstream.task_id}/dependency-links`), {
        command_id: randomUUID(),
        expected_revision: readyRevision,
        depends_on_task_id: upstream.task_id,
        dependency_kind: 'BLOCKS',
    });
    assert.equal(link.status, 200, link.text);
    const revision = link.body.result.revision;
    const response = await delegate(downstream.task_id, revision);
    const problem = expectProblem(response, 409, 'INVALID_TRANSITION');
    assert.deepEqual(problem.conflict?.blocking_task_ids, [upstream.task_id]);
    assert.equal(await liveRunCount(downstream.task_id), 0n);
});
test('lets exactly one of two concurrent delegations win and keeps a single live run (B01)', async () => {
    const project = await createProject('concurrent-delegate');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const responses = await Promise.all([
        delegate(task.task_id, readyRevision),
        delegate(task.task_id, readyRevision),
    ]);
    const accepted = responses.filter((response) => response.status === 202);
    assert.equal(accepted.length, 1, responses.map((response) => response.text).join('\n'));
    const loser = responses.find((response) => response.status !== 202);
    assert.notEqual(loser, undefined);
    assert.equal(loser?.status, 409, loser?.text);
    assert.ok(['REVISION_CONFLICT', 'EXECUTOR_CONFLICT'].includes((loser?.body).code), loser?.text);
    assert.equal(await liveRunCount(task.task_id), 1n);
    const winnerRunId = (accepted[0]?.body).result.run_id;
    const detail = await readTask(task.task_id);
    const executor = detail.executor;
    assert.equal(executor.run_id, winnerRunId);
    // 执行权只授予一次：ownership_epoch 恰好 +1。
    assert.equal(executor.ownership_epoch, '1');
});
test('replays a delegation command and rejects a reused command_id with a different payload', async () => {
    const project = await createProject('delegate-replay');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const commandId = randomUUID();
    const body = {
        command_id: commandId,
        expected_task_revision: readyRevision,
    };
    const first = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/delegations`), body);
    assert.equal(first.status, 202, first.text);
    assert.equal(first.headers['command-replayed'], undefined);
    const replay = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/delegations`), body);
    assert.equal(replay.status, 202, replay.text);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.equal(replay.body.result.run_id, first.body.result.run_id);
    assert.equal(await liveRunCount(task.task_id), 1n);
    const conflict = await api.post(workspacePath(workspaceId, `/tasks/${task.task_id}/delegations`), {
        command_id: commandId,
        expected_task_revision: '0',
    });
    expectProblem(conflict, 409, 'COMMAND_ID_REUSED');
});
test('refuses a second delegation while a live run exists', async () => {
    const project = await createProject('live-run-guard');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const first = await delegate(task.task_id, readyRevision);
    assert.equal(first.status, 202, first.text);
    const current = await readTask(task.task_id);
    const second = await delegate(task.task_id, current.revision);
    assert.equal(second.status, 409, second.text);
    assert.ok(['INVALID_TRANSITION', 'EXECUTOR_CONFLICT'].includes(second.body.code));
    assert.equal(await liveRunCount(task.task_id), 1n);
});
test('refuses an unknown workflow version selector', async () => {
    const project = await createProject('capability-disabled');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const response = await delegate(task.task_id, readyRevision, {
        workflow_version_id: 'some-other-workflow-v9',
    });
    const problem = expectProblem(response, 409, 'CAPABILITY_DISABLED');
    assert.equal(problem.field_errors?.[0]?.field, 'workflow_version_id');
    assert.equal(await liveRunCount(task.task_id), 0n);
});
test('refuses unsupported or malformed declared output requirements before creating a Run', async () => {
    for (const expectedOutputs of [
        { artifacts: ['MARKDOWN_DOCUMENT', 'TEST_REPORT'] },
        { artifacts: 'MARKDOWN_DOCUMENT' },
    ]) {
        const project = await createProject('invalid-output-requirement');
        const task = await createTask({ projectId: project.project_id, expectedOutputs });
        const readyRevision = await markReady(task.task_id, task.revision);
        const response = await delegate(task.task_id, readyRevision);
        expectProblem(response, 409, 'INVALID_TRANSITION');
        assert.equal(await liveRunCount(task.task_id), 0n);
        assert.equal((await readTask(task.task_id)).status, 'READY');
    }
});
test('re-delegates after a FAILED run with retry_of_run_id while the old run stays FAILED (B06)', async () => {
    const project = await createProject('retry-after-failure');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const first = await delegate(task.task_id, readyRevision);
    const firstRunId = first.body.result.run_id;
    const storage = new ManagedContentStore(storageRoot);
    const workerId = 'worker-p05-retry';
    // 用 Fake 场景把第一个 Run 真正推进到 FAILED：BUILD_CONTEXT 成功，DRAFT 连续两次 schema 失败。
    const build = await advanceRunStep(app.db, {
        runId: firstRunId,
        workerId,
        storage,
        fakeScenario: 'SCHEMA_INVALID',
    });
    assert.equal(build.status, 'STEP_SUCCEEDED');
    const retryable = await advanceRunStep(app.db, {
        runId: firstRunId,
        workerId,
        storage,
        fakeScenario: 'SCHEMA_INVALID',
    });
    assert.equal(retryable.status, 'RETRYABLE');
    const failed = await advanceRunStep(app.db, {
        runId: firstRunId,
        workerId,
        storage,
        fakeScenario: 'SCHEMA_INVALID',
    });
    assert.equal(failed.status, 'RUN_FAILED');
    const afterFailure = await readTask(task.task_id);
    assert.equal(afterFailure.status, 'READY');
    assert.equal(afterFailure.executor.kind, 'HUMAN');
    assert.equal(afterFailure.executor.run_id, null);
    const second = await delegate(task.task_id, afterFailure.revision, {
        retry_of_run_id: firstRunId,
    });
    const result = expectAccepted202(second);
    assert.notEqual(result.run_id, firstRunId);
    assert.equal(result.retry_of_run_id, firstRunId);
    const oldRun = await api.get(workspacePath(workspaceId, `/runs/${firstRunId}`));
    assert.equal(oldRun.status, 200, oldRun.text);
    assert.equal(oldRun.body.status, 'FAILED');
    const newRun = await api.get(workspacePath(workspaceId, `/runs/${result.run_id}`));
    assert.equal(newRun.status, 200, newRun.text);
    assert.equal(newRun.body.retry_of_run_id, firstRunId);
    assert.equal(await liveRunCount(task.task_id), 1n);
});
test('rejects a retry_of_run_id that does not exist or belongs to another task', async () => {
    const project = await createProject('retry-of-guard');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    // 不存在的 Run → 404（按不可见处理）。
    const missing = await delegate(task.task_id, readyRevision, { retry_of_run_id: randomUUID() });
    expectProblem(missing, 404, 'RESOURCE_NOT_FOUND');
    // 其他 Task 的 Run → 404；该 Task 自己仍可正常 Delegate。
    const otherProject = await createProject('retry-of-guard-other');
    const otherTask = await createTask({ projectId: otherProject.project_id });
    const otherReady = await markReady(otherTask.task_id, otherTask.revision);
    const otherRun = await delegate(otherTask.task_id, otherReady);
    const otherRunId = otherRun.body.result.run_id;
    const crossTask = await delegate(task.task_id, readyRevision, { retry_of_run_id: otherRunId });
    expectProblem(crossTask, 404, 'RESOURCE_NOT_FOUND');
    const accepted = await delegate(task.task_id, readyRevision);
    assert.equal(accepted.status, 202, accepted.text);
});
test('keeps runs invisible across workspaces', async () => {
    const project = await createProject('run-scope');
    const task = await createTask({ projectId: project.project_id });
    const readyRevision = await markReady(task.task_id, task.revision);
    const delegated = await delegate(task.task_id, readyRevision);
    const runId = delegated.body.result.run_id;
    const otherWorkspace = await createWorkspace(app.db);
    const foreign = await api.get(workspacePath(otherWorkspace, `/runs/${runId}`));
    expectProblem(foreign, 404, 'RESOURCE_NOT_FOUND');
    const missing = await api.get(workspacePath(workspaceId, `/runs/${randomUUID()}`));
    expectProblem(missing, 404, 'RESOURCE_NOT_FOUND');
});
