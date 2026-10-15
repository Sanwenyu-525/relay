import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase, } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi, workspacePath, } from './api-harness.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { reviewTargetHash } from '../../src/application/review-requests.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
/**
 * 人工补验收条件命令（ReviseTaskAcceptance）的真实 PostgreSQL + 真实 HTTP 出口。
 *
 * 本文件固定的是产品出口「Task 创建之后可以补验收条件」的服务端性质：
 *  1. 零 criterion、停在 INBOX 的轻量 Task 补上必需条件后，按 MarkTaskReady 的既有前置条件
 *     可以进 READY（前置只有三条：至少一条必需 criterion、BLOCKS 前置已完成、无未解除
 *     blocker，见 task-readiness.ts），且修订本身不偷偷改变状态；
 *  2. 同 command_id 同载荷返回原回执（附 Command-Replayed），异载荷明确 409 COMMAND_ID_REUSED；
 *  3. 重复投递只写一次：验收版本、Task 修订与审计各只有一次效果；
 *  4. Task revision 与 acceptance_revision 双向 CAS：旧版本明确冲突；
 *  5. 历史验收版本不可改写；旧 acceptance_revision 上已绑定的验证结论与待处理 Review
 *     按契约 03 第 5 节失效（撤销适用性 + Review 过期），而不是被静默沿用；
 *  6. 已被完成凭据绑定的终态 Task 不能直接改验收契约（要先重开）。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-task-acceptance');
let api;
let workspaceId;
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    api = await startTestApi();
    workspaceId = await createWorkspace(app.db);
});
after(async () => {
    await api?.stop();
    await app.close();
});
async function createTask(input) {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, '/tasks'), {
        command_id: commandId,
        project_id: null,
        title: input.title,
        objective: '只用一句话表达要完成的事，不预先填写验收条件',
        criteria: input.criteria ?? [],
        ...(input.expectedOutputs === undefined ? {} : { expected_outputs: input.expectedOutputs }),
    });
    const result = expectCommandAccepted(response, 201, commandId);
    return {
        taskId: result.task_id,
        revision: result.revision,
        acceptanceRevision: result.acceptance_revision,
    };
}
function reviseBody(task, overrides = {}) {
    return {
        command_id: randomUUID(),
        expected_revision: task.revision,
        expected_acceptance_revision: task.acceptanceRevision,
        criteria: [{ criterion_id: 'run-log', statement: '报告里必须有可复现的运行步骤',
                required: true, method: 'HUMAN' }],
        ...overrides,
    };
}
async function revise(task, body) {
    const response = await api.post(workspacePath(workspaceId, `/tasks/${task.taskId}/acceptance`), body);
    return {
        response,
        result: response.status === 200
            ? expectCommandAccepted(response, 200, String(body.command_id))
            : {},
    };
}
async function readTask(taskId) {
    const response = await api.get(workspacePath(workspaceId, `/tasks/${taskId}`));
    assert.equal(response.status, 200, response.text);
    return response.body;
}
async function countAcceptanceVersions(taskId) {
    const result = await sql `
    select count(*)::text as count from task_acceptances where task_id = ${taskId}
  `.execute(app.db);
    return Number(result.rows[0].count);
}
async function countActivity(commandId) {
    const result = await sql `
    select count(*)::text as count from activity_records where command_id = ${commandId}
  `.execute(app.db);
    return Number(result.rows[0].count);
}
async function readAcceptanceActivity(commandId) {
    return (await sql `
    select event_type, fact_refs from activity_records where command_id = ${commandId}
  `.execute(app.db)).rows;
}
test('轻量零 criterion Task 补上必需条件后，按既有前置条件可以进 READY', async () => {
    const task = await createTask({ title: '轻量起步：跑通实验并整理初稿' });
    const before = await readTask(task.taskId);
    assert.equal(before.status, 'INBOX');
    assert.equal(before.acceptance.criteria.length, 0);
    assert.equal(before.acceptance.source, 'CREATE');
    assert.deepEqual(before.allowed_actions, ['EDIT_PRESENTATION', 'CANCEL']);
    const commandId = randomUUID();
    const { result } = await revise(task, reviseBody(task, { command_id: commandId,
        objective: '跑通实验并产出可评审的报告' }));
    assert.equal(result.previous_acceptance_revision, '1');
    assert.equal(result.acceptance_revision, '2');
    assert.equal(result.status, 'INBOX', '修订验收契约不改变任务状态：状态迁移仍是显式命令');
    assert.deepEqual(result.added_criterion_ids, ['run-log']);
    assert.equal(result.objective, '跑通实验并产出可评审的报告');
    const revised = await readTask(task.taskId);
    assert.equal(revised.acceptance_revision, '2');
    assert.equal(revised.acceptance.objective, '跑通实验并产出可评审的报告');
    assert.equal(revised.acceptance.source, 'CONTRACT_CHANGE');
    assert.deepEqual(revised.acceptance.criteria.map((item) => item.criterion_id), ['run-log']);
    assert.ok(revised.allowed_actions.includes('MARK_READY'), `补完必需条件后应允许进入 READY：${JSON.stringify(revised.allowed_actions)}`);
    const readyCommandId = randomUUID();
    const ready = await api.post(workspacePath(workspaceId, `/tasks/${task.taskId}/ready`), {
        command_id: readyCommandId, expected_revision: revised.revision,
    });
    const readyResult = expectCommandAccepted(ready, 200, readyCommandId);
    assert.equal(readyResult.status, 'READY');
    assert.equal(await countActivity(commandId), 1);
    assert.equal(await countAcceptanceVersions(task.taskId), 2, '只应追加一个新验收版本，历史版本不原地改写');
    const activity = await readAcceptanceActivity(commandId);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].event_type, 'TASK_ACCEPTANCE_CHANGED');
    assert.deepEqual(activity[0].fact_refs, {
        change_source: 'HUMAN_COMMAND',
        previous_acceptance_revision: '1',
        acceptance_revision: '2',
        added_criterion_ids: ['run-log'],
        criteria_count: 1,
        required_criteria_count: 1,
    });
});
test('历史验收版本在修订后仍按原样可读，必需产物声明不被改写', async () => {
    const task = await createTask({ title: '带初始条件的 Task',
        criteria: [{ criterion_id: 'draft', statement: '初稿能读', required: true, method: 'HUMAN' }],
        expectedOutputs: { artifacts: ['MARKDOWN_DOCUMENT'] } });
    const { result } = await revise(task, reviseBody(task, {
        criteria: [
            { criterion_id: 'draft', statement: '初稿能读', required: true, method: 'HUMAN' },
            { criterion_id: 'citation', statement: '每条结论都要有可定位的引用', required: true,
                method: 'CITATION_EXISTS', target_spec: {} },
        ],
    }));
    assert.deepEqual(result.added_criterion_ids, ['citation']);
    assert.deepEqual(result.required_output_spec, { artifacts: ['MARKDOWN_DOCUMENT'] }, '必需产物声明不是本入口的改写对象');
    const prior = await sql `
    select acceptance_revision::text, objective, required_output_spec, source
    from task_acceptances where task_id = ${task.taskId} and acceptance_revision = 1
  `.execute(app.db);
    assert.equal(prior.rows.length, 1, '旧验收版本必须仍然存在');
    assert.equal(prior.rows[0].source, 'CREATE');
    assert.deepEqual(prior.rows[0].required_output_spec, { artifacts: ['MARKDOWN_DOCUMENT'] });
    const priorCriteria = await sql `
    select criterion_id, statement, required from acceptance_criteria
    where task_id = ${task.taskId} and acceptance_revision = 1
  `.execute(app.db);
    assert.deepEqual(priorCriteria.rows.map((row) => [row.criterion_id, row.statement, row.required]), [['draft', '初稿能读', true]]);
    const current = await sql `
    select criterion_id from acceptance_criteria
    where task_id = ${task.taskId} and acceptance_revision = 2 order by criterion_id
  `.execute(app.db);
    assert.deepEqual(current.rows.map((row) => row.criterion_id), ['citation', 'draft']);
});
test('同 command_id 同载荷重放返回原回执，异载荷明确拒绝', async () => {
    const task = await createTask({ title: '幂等：补条件' });
    const body = reviseBody(task);
    const commandId = String(body.command_id);
    const first = await revise(task, body);
    assert.equal(first.response.status, 200);
    assert.equal(first.response.headers['command-replayed'], undefined);
    const replay = await revise(task, body);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers['command-replayed'], 'true');
    assert.deepEqual(replay.result, first.result);
    assert.equal(await countAcceptanceVersions(task.taskId), 2, '重放不得追加第二个验收版本');
    assert.equal(await countActivity(commandId), 1, '重放不得写第二条审计');
    const conflicting = await revise(task, { ...body,
        criteria: [{ criterion_id: 'other', statement: '换一个条件', required: true, method: 'HUMAN' }] });
    expectProblem(conflicting.response, 409, 'COMMAND_ID_REUSED');
    assert.equal(await countAcceptanceVersions(task.taskId), 2);
    assert.equal(await countActivity(commandId), 1);
});
test('并发同修订只写一次，后到者拿到明确冲突', async () => {
    const task = await createTask({ title: '并发：补条件' });
    const [first, second] = await Promise.all([
        revise(task, reviseBody(task, { criteria: [
                { criterion_id: 'a', statement: '条件 A', required: true, method: 'HUMAN' }
            ] })),
        revise(task, reviseBody(task, { criteria: [
                { criterion_id: 'b', statement: '条件 B', required: true, method: 'HUMAN' }
            ] })),
    ]);
    const accepted = [first, second].filter((item) => item.response.status === 200);
    const rejected = [first, second].filter((item) => item.response.status !== 200);
    assert.equal(accepted.length, 1, '同一 revision 上两个不同命令只能有一个生效');
    assert.equal(rejected.length, 1);
    expectProblem(rejected[0].response, 409, 'REVISION_CONFLICT');
    assert.equal(await countAcceptanceVersions(task.taskId), 2, '并发失败方不得留下半个验收版本');
    const observed = await readTask(task.taskId);
    assert.equal(observed.acceptance_revision, '2');
    assert.equal(observed.revision, accepted[0].result.revision, '只有胜出的命令推进了 Task 修订');
});
test('旧 Task revision 与旧 acceptance_revision 都明确冲突', async () => {
    const task = await createTask({ title: 'CAS：补条件' });
    const staleTaskRevision = await revise(task, reviseBody(task, {
        expected_revision: '999', criteria: [
            { criterion_id: 'x', statement: '条件 X', required: true, method: 'HUMAN' }
        ]
    }));
    const taskConflict = expectProblem(staleTaskRevision.response, 409, 'REVISION_CONFLICT');
    assert.equal(taskConflict.conflict?.entity_type, 'TASK');
    assert.equal(taskConflict.conflict?.actual_revision, task.revision);
    assert.equal(taskConflict.conflict?.expected_revision, '999');
    const current = await readTask(task.taskId);
    const staleAcceptance = await revise(task, reviseBody(task, {
        expected_revision: current.revision,
        expected_acceptance_revision: '999',
        criteria: [{ criterion_id: 'x', statement: '条件 X', required: true, method: 'HUMAN' }]
    }));
    const acceptanceConflict = expectProblem(staleAcceptance.response, 409, 'REVISION_CONFLICT');
    assert.equal(acceptanceConflict.conflict?.entity_type, 'TASK_ACCEPTANCE');
    assert.equal(acceptanceConflict.conflict?.actual_revision, task.acceptanceRevision);
    const unchanged = await readTask(task.taskId);
    assert.equal(unchanged.revision, current.revision);
    assert.equal(unchanged.acceptance_revision, task.acceptanceRevision);
    assert.equal(await countAcceptanceVersions(task.taskId), 1);
});
test('旧 acceptance_revision 上已绑定的验证结论与待处理 Review 不会被静默沿用', async () => {
    const task = await createTask({ title: '失效：旧验收周期证据' });
    const sessionId = randomUUID();
    const reviewId = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.verifications.insertSession({ id: sessionId, taskId: task.taskId,
            acceptanceRevision: 1n, runId: null, executionContractId: null,
            verifierPolicyVersion: 'test-v1', checkPlanHash: Buffer.alloc(32, 7),
            checkPlan: { kind: 'fixture' } });
        const target = { task_id: task.taskId, acceptance_revision: '1' };
        await repositories.reviews.insertRequest({ id: reviewId, workspaceId,
            projectId: null, taskId: task.taskId, runId: null,
            verificationSessionId: null, criterionId: null, operationId: null,
            importJobId: null, kind: 'STATE_PROPOSAL', reason: 'fixture',
            targetHash: reviewTargetHash(target), target, evidence: {}, effect: {},
            allowedDecisions: ['ACCEPT'], expiresAt: null });
    });
    const commandId = randomUUID();
    const { result } = await revise(task, reviseBody(task, { command_id: commandId }));
    assert.equal(result.acceptance_revision, '2');
    const applicability = await createRepositories(app.db).verifications.readApplicability(sessionId);
    assert.equal(applicability?.reason, 'ACCEPTANCE_CONTRACT_CHANGED');
    assert.equal(applicability?.source_ref, 'task_acceptance_revision:2');
    const session = await createRepositories(app.db).verifications.readSession(sessionId);
    assert.equal(session?.acceptance_revision.toString(), '1', '旧验证 session 仍绑定旧验收版本，历史不被改写');
    assert.equal((await createRepositories(app.db).reviews.readRequest(reviewId))?.status, 'EXPIRED');
    const activity = await readAcceptanceActivity(commandId);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].fact_refs.previous_acceptance_revision, '1');
    assert.equal(activity[0].fact_refs.acceptance_revision, '2');
});
test('验收条件必须至少保留一条必需条件，也不接受删除或降级已确认的必需条件', async () => {
    const task = await createTask({ title: '不可放宽：补条件',
        criteria: [{ criterion_id: 'must', statement: '必须有可复现运行步骤', required: true,
                method: 'HUMAN' }] });
    const downgraded = await revise(task, reviseBody(task, { criteria: [
            { criterion_id: 'must', statement: '必须有可复现运行步骤', required: false, method: 'HUMAN' }
        ] }));
    const downgradeProblem = expectProblem(downgraded.response, 409, 'INVALID_TRANSITION');
    assert.deepEqual(downgradeProblem.conflict?.criterion_ids, ['must']);
    const restated = await revise(task, reviseBody(task, { criteria: [
            { criterion_id: 'must', statement: '大概跑一下就行', required: true, method: 'HUMAN' }
        ] }));
    expectProblem(restated.response, 409, 'INVALID_TRANSITION');
    const dropped = await revise(task, reviseBody(task, { criteria: [
            { criterion_id: 'other', statement: '换一个条件', required: true, method: 'HUMAN' }
        ] }));
    expectProblem(dropped.response, 409, 'INVALID_TRANSITION');
    // 守卫顺序：已有必需条件时，先报「必需条件被删除」，而不是笼统的「没有必需条件」。
    const droppedAndOptional = await revise(task, reviseBody(task, { criteria: [
            { criterion_id: 'polish', statement: '排版清晰', required: false, method: 'HUMAN' }
        ] }));
    const droppedProblem = expectProblem(droppedAndOptional.response, 409, 'INVALID_TRANSITION');
    assert.deepEqual(droppedProblem.conflict?.criterion_ids, ['must']);
    const empty = await revise(task, reviseBody(task, { criteria: [] }));
    expectProblem(empty.response, 422, 'VALIDATION_FAILED');
    const unchanged = await readTask(task.taskId);
    assert.equal(unchanged.acceptance_revision, '1');
    assert.equal(unchanged.revision, task.revision);
    assert.deepEqual(unchanged.acceptance.criteria.map((item) => item.criterion_id), ['must']);
    assert.equal(await countAcceptanceVersions(task.taskId), 1, '被拒的修订不得留下验收版本');
    // 零 criterion 的 Task 上「至少一条必需条件」这条守卫才可达：否则先把「删除」当成原因。
    const blank = await createTask({ title: '不可放宽：零条件' });
    const onlyOptional = await revise(blank, reviseBody(blank, { criteria: [
            { criterion_id: 'polish', statement: '排版清晰', required: false, method: 'HUMAN' }
        ] }));
    const optionalProblem = expectProblem(onlyOptional.response, 422, 'VALIDATION_FAILED');
    assert.equal(optionalProblem.field_errors?.[0]?.field, 'criteria');
    assert.equal(await countAcceptanceVersions(blank.taskId), 1);
});
test('可选条件可以被加严或丢弃，必需条件不动', async () => {
    const task = await createTask({ title: '收紧：补条件', criteria: [
            { criterion_id: 'must', statement: '必须有可复现运行步骤', required: true, method: 'HUMAN' },
            { criterion_id: 'polish', statement: '排版 nicer', required: false, method: 'HUMAN',
                target_spec: { severity: 'PREFERENCE' } },
        ] });
    const { result } = await revise(task, reviseBody(task, { criteria: [
            { criterion_id: 'must', statement: '必须有可复现运行步骤', required: true, method: 'HUMAN' },
        ] }));
    assert.deepEqual(result.added_criterion_ids, []);
    assert.deepEqual(result.criteria.map((item) => item.criterion_id), ['must']);
    const revised = await readTask(task.taskId);
    assert.deepEqual(revised.acceptance.criteria.map((item) => item.criterion_id), ['must'], '可选条件从新版本消失是收紧，不是放宽完成依据');
});
test('已被完成凭据绑定的终态 Task 不能直接改验收契约：先重开，再修订新周期', async () => {
    const task = await createTask({ title: '终态：补条件', criteria: [
            { criterion_id: 'must', statement: '必须有可复现运行步骤', required: true, method: 'HUMAN' }
        ] });
    const readyCommandId = randomUUID();
    const ready = await api.post(workspacePath(workspaceId, `/tasks/${task.taskId}/ready`), {
        command_id: readyCommandId, expected_revision: task.revision
    });
    const readyResult = expectCommandAccepted(ready, 200, readyCommandId);
    const startCommandId = randomUUID();
    const started = await api.post(workspacePath(workspaceId, `/tasks/${task.taskId}/start`), {
        command_id: startCommandId, expected_revision: readyResult.revision
    });
    const startedResult = expectCommandAccepted(started, 200, startCommandId);
    assert.equal(startedResult.status, 'IN_PROGRESS');
    const completeCommandId = randomUUID();
    const completed = await api.post(workspacePath(workspaceId, `/tasks/${task.taskId}/complete`), {
        command_id: completeCommandId,
        expected_revision: startedResult.revision,
        acceptance_revision: task.acceptanceRevision,
        acceptance: { statement: '人工确认本轮完成', accepted_criterion_ids: ['must'] },
    });
    const completedResult = expectCommandAccepted(completed, 200, completeCommandId);
    assert.equal(completedResult.status, 'DONE');
    assert.equal(completedResult.acceptance_revision, task.acceptanceRevision);
    // 提交里原样保留既有必需条件：这样拒绝只可能来自执行权/状态闸门，
    // 而不是「必需条件被删除」这条更早的守卫。
    const rejected = await revise(task, reviseBody(task, {
        expected_revision: completedResult.revision,
        criteria: [
            { criterion_id: 'must', statement: '必须有可复现运行步骤', required: true, method: 'HUMAN' },
            { criterion_id: 'review', statement: '至少一位同门读过并签字', required: true, method: 'HUMAN' },
        ],
    }));
    expectProblem(rejected.response, 409, 'EXECUTOR_CONFLICT');
    const stillDone = await readTask(task.taskId);
    assert.equal(stillDone.status, 'DONE');
    assert.equal(stillDone.acceptance_revision, task.acceptanceRevision, '终态 Task 的验收版本指针不被这个入口改动');
    assert.ok(stillDone.current_completion_id);
    assert.equal(await countAcceptanceVersions(task.taskId), 1);
    // 重开是既有出口：它自己建新验收版本，之后人工修订在新周期上可用。
    const reopenCommandId = randomUUID();
    const reopened = await api.post(workspacePath(workspaceId, `/tasks/${task.taskId}/reopen`), {
        command_id: reopenCommandId, expected_revision: stillDone.revision, reason: '补一条验收条件'
    });
    const reopenedResult = expectCommandAccepted(reopened, 200, reopenCommandId);
    assert.equal(reopenedResult.status, 'READY');
    assert.equal(reopenedResult.acceptance_revision, '2');
    const afterReopen = await revise(task, reviseBody(task, {
        expected_revision: reopenedResult.revision,
        expected_acceptance_revision: reopenedResult.acceptance_revision,
        criteria: [
            { criterion_id: 'must', statement: '必须有可复现运行步骤', required: true, method: 'HUMAN' },
            { criterion_id: 'review', statement: '至少一位同门读过并签字', required: true,
                method: 'HUMAN' },
        ],
    }));
    assert.equal(afterReopen.response.status, 200, afterReopen.response.text);
    assert.equal(afterReopen.result.acceptance_revision, '3');
});
