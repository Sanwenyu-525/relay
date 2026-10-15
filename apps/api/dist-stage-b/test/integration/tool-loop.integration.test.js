import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createGatewayPolicy, registerManagedResource } from '../../src/application/gateway-configuration.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { requestRunControl, applySafeControl, resumeRun } from '../../src/application/control-requests.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { readRunToolCalls } from '../../src/application/run-tool-call-projection.js';
import { buildToolTurns, resolveToolLoopPlan } from '../../src/application/tool-loop.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { RunScopeGrantRepository } from '../../src/application/run-scope-grant.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
/**
 * 模型工具循环的真实 PG 出口（docs/architecture/runtime-context.md 2.3）。
 *
 * A 片：Fake 模型按脚本发出真实的「搜索 / 读取 / Git diff / 回复」序列，每次工具调用都
 * 落到自己的 Gateway 动作身份上；重复派发不产生第二次执行；未授权、未知工具与非法
 * 参数都不派发；断点恢复从已落库行重建而不是重跑模型。
 *
 * B 片：范围授权下的普通修改与已配置检查。未授权不写；删除即使在授权内仍要单动作确认；
 * 撤权、过期、越界与基线冲突都不放行，也不静默覆盖用户的改动。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-tool-loop');
const README_BASELINE = '# Relay\n内部工具循环\n';
let dataRoot;
const roots = [];
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    dataRoot = await createDataRoot();
});
after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
    for (const root of roots)
        await rm(root, { recursive: true, force: true });
});
async function initGitRepository(root) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Relay Test',
        GIT_AUTHOR_EMAIL: 'relay@example.invalid', GIT_COMMITTER_NAME: 'Relay Test',
        GIT_COMMITTER_EMAIL: 'relay@example.invalid' };
    const run = async (...args) => {
        await new Promise((resolveResult, rejectResult) => {
            execFile('git', args, { cwd: root, env }, (error) => {
                if (error === null)
                    resolveResult();
                else
                    rejectResult(new Error(`git ${args.join(' ')}: ${error.message}`));
            });
        });
    };
    await run('init', '-q', '-b', 'main');
    await run('add', 'README.md');
    await run('commit', '-q', '-m', '初始提交');
    await run('add', 'src/index.ts');
    // 只 add 不提交：留下已暂存的新增；随后改写内容又留下未暂存修改；工具文件始终未跟踪。
    await writeFile(join(root, 'src', 'index.ts'), 'export const relay = false;\n', 'utf8');
}
async function fixture(name, options = {}) {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const root = options.sharedRoot ?? await mkdtemp(join(tmpdir(), 'relay-tool-loop-'));
    roots.push(root);
    if (options.sharedRoot === undefined) {
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'README.md'), README_BASELINE, 'utf8');
        await writeFile(join(root, 'src', 'index.ts'), 'export const relay = true;\n', 'utf8');
        await writeFile(join(root, 'src', '工具.ts'), 'export const 名称 = "中文";\n', 'utf8');
        if (options.git === true)
            await initGitRepository(root);
    }
    // 工作区、项目、受管资源、连接与策略必须先于 Task 存在：Gateway 的每一步都核对
    // Workspace authority 与 Project 归属，顺序颠倒会得到与业务无关的 404。
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: workspaceId, name });
        await repositories.workspaces.insertAuthorityRow(workspaceId);
        await repositories.projects.insertProject({ id: projectId, workspaceId, title: name,
            projectType: 'DEVELOPMENT' });
    });
    const { resourceId, canonicalRoot } = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
    const connectionId = await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.lockAuthority(workspaceId, 'update');
        const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
            workspaceId, projectId, config: { root_path: canonicalRoot } });
        for (const capability of ['FILE_QUERY', 'FILE_READ', 'GIT_READ', 'FILE_WRITE',
            'CLI_RUN']) {
            await repositories.gateway.addConnectionCapability(connection.id, capability);
        }
        await repositories.workspaces.bumpAuthority(workspaceId);
        return connection.id;
    });
    const decision = options.auto === false ? 'ASK' : 'AUTO';
    // 记住 LIST_DIRECTORY 的策略身份：撤权反例要精确作用在这一条上。
    let listDirectoryPolicyId = '';
    for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
        ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'],
        ['FILE_READ', 'READ_FILE'], ['GIT_READ', 'GIT_STATUS'], ['GIT_READ', 'GIT_DIFF'],
        ['GIT_READ', 'GIT_LOG'], ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'WRITE_FILE'],
        ['FILE_WRITE', 'READ_CHANGE_SET'], ['CLI_RUN', 'CLI_RUN'], ['CLI_RUN', 'RUN_TEST'],
        ['CLI_RUN', 'RUN_BUILD'], ['CLI_RUN', 'EXECUTE']]) {
        const created = await createGatewayPolicy(app.db, { workspaceId, projectId, capability,
            actionType, targetPrefix: canonicalRoot, decision, maxPayloadBytes: 262144 });
        if (actionType === 'LIST_DIRECTORY')
            listDirectoryPolicyId = created.policyId;
    }
    const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
        title: '按工具结果继续', objective: '依据实际工具结果生成候选',
        expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
        criteria: [{ criterionId: 'c1', statement: '存在候选交付', required: true, method: 'HUMAN' }],
        mode: 'ME' });
    const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
        commandId: randomUUID(), expectedRevision: task.result.revision });
    // 授权与 Run 同批落库，因此不存在「Run 已存在但授权漏写」的中间态。
    const scopeAllowed = options.scopeActions ?? [];
    const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
        commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
        toolLoopAction: { resource_id: resourceId,
            connections: { FILE_QUERY: connectionId, FILE_READ: connectionId, GIT_READ: connectionId,
                FILE_WRITE: connectionId, CLI_RUN: connectionId },
            allowed_tools: options.allowedTools ?? ['list_directory', 'search_text', 'read_file',
                'git_status', 'git_diff'],
            max_rounds: options.maxRounds ?? 6, max_tool_calls: options.maxToolCalls ?? 8 },
        ...(scopeAllowed.length === 0 ? {} : { scopeGrant: { resource_id: resourceId,
                allowed_actions: scopeAllowed, checks: options.checks ?? [],
                ...(options.grantExpiresAt === undefined ? {} :
                    { expires_at: options.grantExpiresAt.toISOString() }) } }) });
    return { workspaceId, projectId, taskId: task.result.task_id, runId: delegated.result.run_id,
        resourceId, canonicalRoot, connectionId, policyId: listDirectoryPolicyId };
}
/** 有界驱动：advance 与工具派发交替，直到 Run 离开这两个状态或达到步数上限。 */
async function drive(fx, script, maxIterations = 20) {
    const storage = new ManagedContentStore(dataRoot);
    const statuses = [];
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const advanced = await advanceRunStep(app.db, { runId: fx.runId,
            workerId: `loop-${randomUUID()}`, storage, fakeToolScript: script });
        statuses.push(advanced.status);
        // STEP_SUCCEEDED/RETRYABLE/REPLAYED 只是「本步完成」，图会继续推进；其余状态本驱动
        // 无法自行处理。
        if (advanced.status === 'STEP_SUCCEEDED' || advanced.status === 'RETRYABLE' ||
            advanced.status === 'REPLAYED')
            continue;
        if (advanced.status !== 'TOOL_LOOP_ACTION_REQUIRED')
            return { statuses, pending: [] };
        const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
                runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
                workerId: `loop-${randomUUID()}`, epoch: 0n },
            toolCallId: advanced.tool_call_id });
        statuses.push(`TOOL_${dispatched.status}`);
        if (dispatched.status === 'WAITING' || dispatched.status === 'UNKNOWN') {
            return { statuses, pending: [dispatched.toolCallId] };
        }
    }
    const pending = await new RunToolCallRepository(app.db).listPending(fx.runId);
    return { statuses, pending: pending.map((row) => row.id) };
}
/**
 * 只推进到「模型已发出工具请求、尚未派发」这一刻并返回该行 id。
 *
 * 停止、预算与重启三类反例都要停在这个窗口里：派发之后的事实已经落盘，
 * 再插入控制意图就只是在验证无关的顺序。
 */
async function advanceToPendingToolAction(fx, script, maxIterations = 10) {
    const storage = new ManagedContentStore(dataRoot);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const advanced = await advanceRunStep(app.db, { runId: fx.runId,
            workerId: `loop-${randomUUID()}`, storage, fakeToolScript: script });
        if (advanced.status === 'TOOL_LOOP_ACTION_REQUIRED') {
            assert.ok(advanced.tool_call_id !== null);
            return advanced.tool_call_id;
        }
        assert.ok(['STEP_SUCCEEDED', 'RETRYABLE', 'REPLAYED'].includes(advanced.status), `推进停在 ${advanced.status}，没有落到待派发的工具请求`);
    }
    throw new Error('推进超过步数上限，仍未出现待派发的工具请求');
}
async function draftAttemptId(runId) {
    return withTransaction(app.db, async (repositories) => {
        const run = await repositories.runs.readRun(runId);
        const steps = await repositories.runs.listSteps(runId);
        const draft = steps.find((step) => step.step_kind === 'DRAFT');
        assert.ok(draft !== undefined);
        const attempts = await repositories.runs.listAttempts(draft.id);
        assert.ok(attempts.length > 0, `no DRAFT attempt; run=${run?.status}`);
        return attempts.at(-1).id;
    });
}
async function toolRows(runId) {
    return new RunToolCallRepository(app.db).listByAttempt(await draftAttemptId(runId));
}
function toolClaim(fx) {
    return { commandId: randomUUID(), runId: fx.runId, workspaceId: fx.workspaceId,
        kind: 'START', reviewDecisionId: null, workerId: `loop-${randomUUID()}`, epoch: 0n };
}
async function latestDecisionId(reviewId) {
    const decision = await withTransaction(app.db, (repositories) => repositories.reviews.readDecision(reviewId));
    assert.ok(decision !== undefined);
    return decision.id;
}
test('a scripted model walks search, read and git diff, then settles the draft', async () => {
    const fx = await fixture('tool-loop-read', { git: true });
    const driven = await drive(fx, [
        [{ name: 'search_text', arguments: { query: '中文' } }],
        [{ name: 'read_file', arguments: { relative_path: 'src/工具.ts' } }],
        [{ name: 'git_status', arguments: {} }],
    ]);
    assert.deepEqual(driven.pending, []);
    assert.ok(driven.statuses.includes('STEP_SUCCEEDED'));
    // 每一轮都是一次真实的模型调用，且不多不少。
    const modelCalls = await new ModelCallRepository(app.db)
        .listForStepAttempt(await draftAttemptId(fx.runId));
    assert.equal(modelCalls.length, 4);
    assert.ok(modelCalls.every((call) => call.status === 'COMPLETED'));
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.tool_name), ['search_text', 'read_file', 'git_status']);
    assert.deepEqual(rows.map((row) => row.round), [0, 1, 2]);
    for (const row of rows) {
        assert.equal(row.status, 'SETTLED');
        // 行 id 就是那个 Operation 的 id，因此重复派发天然命中同一条动作。
        assert.equal(row.operation_id, row.id);
        const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(row.id));
        assert.equal(operation?.run_id, fx.runId);
        assert.equal(operation?.status, 'SUCCEEDED');
        assert.equal(operation?.step_id, rows[0].step_id);
    }
    // 真实读到了合成目录，而不是预制答案。
    const read = rows.find((row) => row.tool_name === 'read_file');
    assert.ok(String(read.result_ref?.content).includes('中文'));
    assert.ok(JSON.stringify(rows[0].result_ref?.matches).includes('工具.ts'));
    // Git 只读读到了真实仓库状态：未暂存与未跟踪都出现，不因 diff 无输出而消失。
    const gitStatus = rows.find((row) => row.tool_name === 'git_status').result_ref?.status;
    assert.ok(Array.isArray(gitStatus.unstaged));
    assert.ok(gitStatus.unstaged.includes('src/index.ts'));
    assert.ok(gitStatus.untracked.includes('src/工具.ts'));
});
test('a Git repository with staged, unstaged and untracked content reports each one', async () => {
    const fx = await fixture('tool-loop-git', { git: true, allowedTools: ['git_status', 'git_diff'] });
    const driven = await drive(fx, [[{ name: 'git_status', arguments: {} }],
        [{ name: 'git_diff', arguments: {} }]]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'SETTLED']);
    const status = rows[0].result_ref.status;
    assert.ok(status.staged.includes('src/index.ts'));
    assert.ok(status.unstaged.includes('src/index.ts'));
    assert.ok(status.untracked.includes('src/工具.ts'));
    assert.equal(typeof status.headCommit, 'string');
    // 未暂存差异里能看到真实内容改动。
    assert.ok(String(rows[1].result_ref?.diff).includes('relay = true'));
});
test('a non-Git directory returns a typed git failure instead of looking clean', async () => {
    const fx = await fixture('tool-loop-nongit', { allowedTools: ['git_status', 'git_diff'] });
    const driven = await drive(fx, [[{ name: 'git_status', arguments: {} }]]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'SETTLED');
    // 动作本身 FAILED，模型在下一轮看到类型化原因并收尾。
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(rows[0].id));
    assert.equal(operation?.status, 'FAILED');
    assert.ok(typeof operation?.result_ref?.reason === 'string');
});
test('the read projection reports what the model actually asked for and got', async () => {
    const fx = await fixture('tool-loop-projection', { git: true });
    const driven = await drive(fx, [
        [{ name: 'search_text', arguments: { query: '中文' } }],
        [{ name: 'read_file', arguments: { relative_path: 'src/工具.ts' } }],
        [{ name: 'git_status', arguments: {} }],
        // 未登记的工具：落库即被拒，不派发，也不连 Operation。
        [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY', path: '../escape' }] } }],
    ]);
    assert.deepEqual(driven.pending, []);
    const projection = await readRunToolCalls(app.db, fx.workspaceId, fx.runId);
    assert.equal(projection.run_id, fx.runId);
    // TC-01：按 (round, ordinal) 升序，不重复。前端因此不需要二次排序。
    const positions = projection.rounds.flatMap((round) => round.calls.map((call) => `${round.round}:${call.ordinal}`));
    assert.deepEqual(positions, ['0:0', '1:0', '2:0', '3:0']);
    assert.equal(new Set(projection.rounds.flatMap((round) => round.calls.map((call) => call.id))).size, positions.length);
    assert.deepEqual(projection.rounds.map((round) => round.round), [0, 1, 2, 3]);
    // TC-02：六个状态里这里出现 SETTLED 与 REJECTED，都原样带出，没有被折叠成「已完成」。
    assert.deepEqual(projection.rounds.flatMap((round) => round.calls.map((call) => call.status)), ['SETTLED', 'SETTLED', 'SETTLED', 'REJECTED']);
    // TC-06：未派发行的 operation_id 为 null，类型化原因与明细都在。
    const rejected = projection.rounds[3]?.calls[0];
    assert.equal(rejected?.operation_id, null);
    assert.equal(typeof rejected?.result_ref?.reason, 'string');
    assert.equal(typeof rejected?.result_ref?.detail, 'string');
    // 已结算行的结果就是模型读到的那一份：读文件真的读到了磁盘正文。
    const read = projection.rounds[1]?.calls[0];
    assert.equal(read?.tool_name, 'read_file');
    assert.equal((read?.arguments).relative_path, 'src/工具.ts');
    assert.ok(String((read?.result_ref).content).includes('中文'));
    // TC-03：每一行有结果的调用都必须真的带内容；断言不能因为「没找到截断的行」而空跑。
    const withResult = projection.rounds.flatMap((round) => round.calls)
        .filter((call) => call.result_ref !== null);
    assert.ok(withResult.length >= 3, `expected settled results, got ${withResult.length}`);
    for (const call of withResult) {
        assert.ok(Object.keys(call.result_ref).length > 0, `result_ref must not be an empty object: ${call.id}`);
        // 截断标记若出现，必须带上被省略的字节数，不能只有一个布尔。
        if (call.result_ref.truncated === true) {
            assert.equal(typeof call.result_ref.omitted_bytes, 'number');
        }
    }
});
test('a Run with no tool request projects empty rounds instead of failing', async () => {
    const fx = await fixture('tool-loop-no-tool', { allowedTools: ['read_file'] });
    // 脚本为空数组：模型这一轮直接给候选，没有发出任何工具请求。
    const driven = await drive(fx, [[]]);
    assert.deepEqual(driven.pending, []);
    const projection = await readRunToolCalls(app.db, fx.workspaceId, fx.runId);
    assert.deepEqual(projection.rounds, []);
    assert.equal(typeof projection.run_status, 'string');
});
test('the projection hides a Run from another workspace and an unknown Run', async () => {
    const fx = await fixture('tool-loop-scope', { allowedTools: ['read_file'] });
    const otherWorkspace = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: otherWorkspace, name: '另一个工作区' });
        await repositories.workspaces.insertAuthorityRow(otherWorkspace);
    });
    // TC-05：跨作用域按不可见处理，不返回别人的轨迹，也不返回空数组冒充「没有工具」。
    await assert.rejects(() => readRunToolCalls(app.db, otherWorkspace, fx.runId), (error) => error.code === 'RESOURCE_NOT_FOUND');
    await assert.rejects(() => readRunToolCalls(app.db, fx.workspaceId, randomUUID()), (error) => error.code === 'RESOURCE_NOT_FOUND');
});
test('a tool call emits exactly one Run event per state advance and none for a bare revision', async () => {
    const fx = await fixture('tool-loop-events', { allowedTools: ['list_directory'] });
    const driven = await drive(fx, [[{ name: 'list_directory', arguments: {} }]]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'SETTLED');
    const events = await sql `
    select seq, kind from run_events where run_id = ${fx.runId} order by seq
  `.execute(app.db);
    // TC-07：一行工具调用真实经历三次状态推进——REQUESTED（插入）、PREPARED（AUTO 策略绑定动作身份）、
    // SETTLED（结算），各一条事件。
    const toolEvents = events.rows.filter((row) => row.kind === 'TOOL_CALL_CHANGED');
    assert.equal(toolEvents.length, 3);
    // seq 与既有事件连续，没有空洞：客户端把 SSE 当丢失历史看待，序号跳号会让它误判。
    assert.deepEqual(events.rows.map((row) => Number(row.seq)), events.rows.map((_row, index) => index + 1));
    // 只推进 revision 不产生新事实，因此不发事件：应用角色确实能改 revision（0054 的列级 GRANT）。
    const before = toolEvents.length;
    await sql `update run_tool_calls set revision = revision + 1 where id = ${rows[0].id}`
        .execute(app.db);
    const after = await sql `
    select count(*)::bigint as count from run_events
    where run_id = ${fx.runId} and kind = 'TOOL_CALL_CHANGED'
  `.execute(app.db);
    assert.equal(Number(after.rows[0]?.count), before);
});
test('the projection shows a revoked policy as a typed rejection, not a stale success', async () => {
    // 撤权必须发生在请求之前：首轮跑完后 DRAFT 步骤已结束，再 drive 不会产生任何新请求，
    // 那样测到的「没有 list_directory」是流程结束而不是撤权。
    const fx = await fixture('tool-loop-revoked-projection');
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.lockAuthority(fx.workspaceId, 'update');
        await repositories.gateway.revokePolicy(fx.policyId);
        await repositories.workspaces.bumpAuthority(fx.workspaceId);
    });
    await drive(fx, [[{ name: 'list_directory', arguments: {} }]]);
    const projection = await readRunToolCalls(app.db, fx.workspaceId, fx.runId);
    const listCall = projection.rounds.flatMap((round) => round.calls)
        .find((call) => call.tool_name === 'list_directory');
    assert.ok(listCall !== undefined, 'the revoked call must still be visible');
    assert.equal(listCall?.operation_id, null);
    assert.ok(typeof listCall?.result_ref?.reason === 'string');
    assert.ok(String(listCall?.result_ref?.detail ?? '').length > 0, '拒绝必须带明细，不能只有一个原因词');
});
test('an unknown tool name and illegal arguments are rejected without any Operation', async () => {
    const fx = await fixture('tool-loop-reject', { allowedTools: ['search_text'] });
    const driven = await drive(fx, [[
            { name: 'apply_changeset', arguments: { path: '../escape' } },
            { name: 'search_text', arguments: { query: 7 } },
            { name: 'search_text', arguments: { query: 'ok' } },
        ]]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.status), ['REJECTED', 'REJECTED', 'SETTLED']);
    for (const row of rows.slice(0, 2)) {
        assert.equal(row.operation_id, null);
        assert.ok(typeof row.result_ref?.reason === 'string');
        // 未派发就不该留下任何动作。
        const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(row.id));
        assert.equal(operation, undefined);
    }
});
test('the loop budget stops dispatch and returns a typed reason to the model', async () => {
    const fx = await fixture('tool-loop-budget', { allowedTools: ['list_directory'],
        maxToolCalls: 1 });
    const driven = await drive(fx, [
        [{ name: 'list_directory', arguments: {} }],
        [{ name: 'list_directory', arguments: {} }],
        [{ name: 'list_directory', arguments: {} }],
    ]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.equal(rows.filter((row) => row.status === 'SETTLED').length, 1);
    assert.ok(rows.some((row) => row.result_ref?.reason === 'TOOL_LOOP_BUDGET_EXHAUSTED'));
});
test('one round cannot exceed the call budget across its own requests', async () => {
    const fx = await fixture('tool-loop-round-budget', { allowedTools: ['list_directory'],
        maxToolCalls: 2 });
    const driven = await drive(fx, [
        [{ name: 'list_directory', arguments: {} }, { name: 'list_directory', arguments: {} },
            { name: 'list_directory', arguments: {} }],
    ]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'SETTLED', 'REJECTED']);
    assert.equal(rows[2].result_ref?.reason, 'TOOL_LOOP_BUDGET_EXHAUSTED');
    assert.equal(rows[2].operation_id, null);
});
test('the round budget stops the loop instead of settling an extra round', async () => {
    const fx = await fixture('tool-loop-round-budget-2', { allowedTools: ['list_directory'],
        maxRounds: 1 });
    const driven = await drive(fx, [
        [{ name: 'list_directory', arguments: {} }],
        [{ name: 'list_directory', arguments: {} }],
    ]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => [row.round, row.status]), [[0, 'SETTLED'], [1, 'REJECTED']]);
    assert.equal(rows[1].result_ref?.reason, 'TOOL_LOOP_ROUNDS_EXHAUSTED');
});
test('a model that keeps asking for tools past the budget waits for the user instead of failing', async () => {
    // 契约 02:49：预算耗尽不无限自动重试，也不该被记成 UNEXPECTED_MODEL_RESULT。
    // 脚本比 maxRounds 长：模型在收尾轮之后仍然只要工具，就必须停在类型化等待点。
    const fx = await fixture('tool-loop-budget-park', { allowedTools: ['list_directory'],
        maxRounds: 1 });
    const driven = await drive(fx, [
        [{ name: 'list_directory', arguments: {} }],
        [{ name: 'list_directory', arguments: {} }],
        [{ name: 'list_directory', arguments: {} }],
        [{ name: 'list_directory', arguments: {} }],
    ]);
    assert.ok(driven.statuses.includes('BUDGET_EXHAUSTED'), `statuses=${JSON.stringify(driven.statuses)}`);
    assert.deepEqual(driven.pending, []);
    const state = await withTransaction(app.db, async (repositories) => ({
        run: await repositories.runs.readRun(fx.runId),
        task: await repositories.tasks.readTask(fx.taskId),
        draft: (await repositories.runs.listSteps(fx.runId)).find((s) => s.step_kind === 'DRAFT'),
    }));
    assert.equal(state.run?.status, 'WAITING_APPROVAL');
    assert.equal(state.run?.wait_reason, 'REPEATED_FAILURE');
    // 等待不等于转移执行权：AI 仍是执行者，用户可接手或停止。
    assert.equal(state.task?.status, 'WAITING');
    assert.equal(state.task?.executor_run_id, fx.runId);
    assert.equal(state.task?.ownership_epoch, state.run?.ownership_epoch);
    assert.equal(state.run?.worker_id, null);
    assert.equal(state.draft?.status, 'FAILED');
    // 只给一次收尾轮：第 0 轮结算，第 1 轮（预算已尽）与收尾轮都被拒，之后不再调用模型。
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => [row.round, row.status]), [[0, 'SETTLED'], [1, 'REJECTED'], [2, 'REJECTED']]);
    assert.equal(rows[1].result_ref?.reason, 'TOOL_LOOP_ROUNDS_EXHAUSTED');
    assert.equal(rows[2].result_ref?.reason, 'TOOL_LOOP_ROUNDS_EXHAUSTED');
    // 被拒的请求不连 Operation，也不伪造「已执行」。
    assert.deepEqual(rows.slice(1).map((row) => row.operation_id), [null, null]);
    const attempts = await withTransaction(app.db, async (repositories) => repositories.runs.listAttempts(state.draft.id));
    const last = attempts.at(-1);
    assert.equal(last.status, 'FAILED');
    assert.equal(last.result_ref?.reason, 'TOOL_LOOP_BUDGET_EXHAUSTED');
    const modelCalls = await new ModelCallRepository(app.db)
        .listForStepAttempt(await draftAttemptId(fx.runId));
    assert.equal(modelCalls.length, 3);
    // 等待点不是死路：执行权仍在 AI 名下且 Run 未终态，用户可以接手或停止。
    const control = await requestRunControl(app.db, { workspaceId: fx.workspaceId,
        runId: fx.runId, commandId: randomUUID(),
        expectedTaskRevision: state.task.revision.toString(),
        expectedRunRevision: state.run.revision.toString(), type: 'HANDOFF' });
    assert.equal(control.result.status, 'PENDING');
    assert.equal(control.result.type, 'HANDOFF');
});
test('an approved tool call resumes and executes instead of waiting forever', async () => {
    const fx = await fixture('tool-loop-approve', { auto: false, allowedTools: ['list_directory'] });
    const storage = new ManagedContentStore(dataRoot);
    const script = [[{ name: 'list_directory', arguments: {} }]];
    await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`, storage,
        fakeToolScript: script });
    const advanced = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
        storage, fakeToolScript: script });
    assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
    const rows = await toolRows(fx.runId);
    const operationId = rows[0].id;
    const firstClaim = toolClaim(fx);
    const waiting = await executeToolLoopStep(app.db, { claim: firstClaim,
        toolCallId: advanced.tool_call_id });
    assert.equal(waiting.status, 'WAITING');
    const reviewId = waiting.reviewId;
    const review = await withTransaction(app.db, (repositories) => repositories.reviews.readRequest(reviewId));
    assert.ok(review !== undefined);
    await resolveReview(app.db, { workspaceId: fx.workspaceId, reviewId, commandId: randomUUID(),
        expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
        decision: 'APPROVE' });
    // 批准后携同一个决定恢复：必须真正执行，不能再报「仍在等待」。
    // 恢复命令必须是 resolveReview 真实排出的那一条，不能凭空造一个 command_id。
    const decisionId = await latestDecisionId(reviewId);
    const commands = await sql `
    select id from run_commands where review_decision_id = ${decisionId}`.execute(app.db);
    assert.equal(commands.rows.length, 1);
    const state = await withTransaction(app.db, async (repositories) => ({
        run: await repositories.runs.readRun(fx.runId),
        task: await repositories.tasks.readTask(fx.taskId),
    }));
    assert.equal(state.task?.ownership_epoch, state.run?.ownership_epoch);
    const beforeResume = await toolRows(fx.runId);
    assert.equal(beforeResume[0].status, 'WAITING_APPROVAL');
    assert.equal(beforeResume[0].operation_id, beforeResume[0].id);
    // 批准本身不占用 Worker：恢复要按既有 RUN 协议重新领取，否则永远领不到。
    assert.equal(state.run?.worker_id, null, `worker=${state.run?.worker_id} status=${state.run?.status}`);
    const resumeClaim = { ...toolClaim(fx), commandId: commands.rows[0].id, kind: 'RESUME',
        reviewDecisionId: decisionId };
    const resumed = await executeToolLoopStep(app.db, {
        claim: resumeClaim, toolCallId: advanced.tool_call_id
    });
    assert.equal(resumed.status, 'SUCCEEDED', JSON.stringify(resumed));
    const settled = await toolRows(fx.runId);
    assert.equal(settled[0].status, 'SETTLED');
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(operationId));
    assert.equal(operation?.status, 'SUCCEEDED');
});
test('an ASK policy parks the tool call at an ACTION_APPROVAL bound to its exact action', async () => {
    const fx = await fixture('tool-loop-ask', { auto: false, allowedTools: ['list_directory'] });
    const storage = new ManagedContentStore(dataRoot);
    // 先让 BUILD_CONTEXT 走完：工具调用只发生在 DRAFT Attempt 内。
    const built = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
        storage, fakeToolScript: [[{ name: 'list_directory', arguments: {} }]] });
    assert.equal(built.status, 'STEP_SUCCEEDED', JSON.stringify(built));
    const advanced = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
        storage, fakeToolScript: [[{ name: 'list_directory', arguments: {} }]] });
    assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
    const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
            runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
            workerId: `loop-${randomUUID()}`, epoch: 0n }, toolCallId: advanced.tool_call_id });
    assert.equal(dispatched.status, 'WAITING');
    assert.ok(dispatched.reviewId !== undefined);
    const rows = await toolRows(fx.runId);
    assert.equal(rows[0].status, 'WAITING_APPROVAL');
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(rows[0].id));
    assert.equal(operation?.status, 'WAITING_APPROVAL');
    // 未批准前没有调用发生，也没有资源被占用。
    const invocations = await withTransaction(app.db, (repositories) => repositories.gateway.listInvocations(rows[0].id));
    assert.equal(invocations.length, 0);
    const run = await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId));
    assert.equal(run?.status, 'WAITING_APPROVAL');
    assert.equal(run?.worker_id, null);
});
test('a repeated delivery of the same request reuses the original Operation', async () => {
    const fx = await fixture('tool-loop-replay', { allowedTools: ['list_directory'] });
    const storage = new ManagedContentStore(dataRoot);
    const script = [[{ name: 'list_directory', arguments: {} }]];
    await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`, storage,
        fakeToolScript: script });
    const advanced = await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`,
        storage, fakeToolScript: script });
    assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
    const claim = { commandId: randomUUID(), runId: fx.runId, workspaceId: fx.workspaceId,
        kind: 'START', reviewDecisionId: null, workerId: `loop-${randomUUID()}`, epoch: 0n };
    const first = await executeToolLoopStep(app.db, { claim, toolCallId: advanced.tool_call_id });
    assert.equal(first.status, 'SUCCEEDED');
    const operationsAfterFirst = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    const second = await executeToolLoopStep(app.db, { claim, toolCallId: advanced.tool_call_id });
    assert.equal(second.status, 'SUCCEEDED');
    const operationsAfterSecond = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    // 同一请求重复投递不产生第二个动作，也不重跑模型生成同一个写动作。
    assert.equal(operationsAfterSecond.length, operationsAfterFirst.length);
    assert.equal(operationsAfterFirst.length, 1);
});
test('a revoked permission blocks the tool call and keeps the reason traceable', async () => {
    const fx = await fixture('tool-loop-revoke', { allowedTools: ['list_directory'] });
    await withTransaction(app.db, async (repositories) => {
        const versions = await repositories.gateway.listPolicyVersions(fx.policyId);
        assert.ok(versions.length > 0);
        await repositories.gateway.revokePolicy(fx.policyId);
    });
    const driven = await drive(fx, [[{ name: 'list_directory', arguments: {} }]]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 1);
    // 撤权后请求根本没有派发：不产生 Operation，只留下类型化原因。
    assert.equal(rows[0].status, 'REJECTED');
    assert.equal(rows[0].operation_id, null);
    assert.equal(rows[0].result_ref?.reason, 'GATEWAY_PERMISSION_DENIED');
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(rows[0].id));
    assert.equal(operation, undefined);
});
// ---------------------------------------------------------------------------
// B 片：范围授权、普通修改与已配置检查。
//
// 判定口径：未授权不写；范围内普通编辑与已配置检查连续执行；删除即使在授权内仍要
// 单动作确认；撤权、过期、越界与基线冲突都不放行，也不静默覆盖用户的新改动。
// ---------------------------------------------------------------------------
async function sha256File(path) {
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    return createHash('sha256').update(await readFile(path)).digest('hex');
}
test('without a scope grant a requested write never touches the disk', async () => {
    const fx = await fixture('scope-none', { scopeActions: [],
        allowedTools: ['apply_changeset'] });
    const driven = await drive(fx, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'README.md',
                            baselineSha256: await sha256File(join(fx.canonicalRoot, 'README.md')),
                            content: '# 被模型改过\n' }
                    ] } }]]);
    assert.ok(driven.statuses.includes('TOOL_WAITING'), JSON.stringify(driven.statuses));
    // 未授权：请求停在等待单动作确认，磁盘一个字节都没动。
    assert.equal(await readFile(join(fx.canonicalRoot, 'README.md'), 'utf8'), README_BASELINE);
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'WAITING_APPROVAL');
    assert.ok(rows[0].operation_id !== null);
});
test('inside the granted scope an ordinary edit lands and the real result is reported', async () => {
    const fx = await fixture('scope-edit', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const baseline = await sha256File(join(fx.canonicalRoot, 'src', 'index.ts'));
    const driven = await drive(fx, [
        [{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'src/index.ts', baselineSha256: baseline,
                            content: 'export const relay = false;\n' }
                    ] } }],
    ]);
    assert.ok(driven.statuses.includes('TOOL_SUCCEEDED'), JSON.stringify(driven.statuses));
    assert.equal(await readFile(join(fx.canonicalRoot, 'src', 'index.ts'), 'utf8'), 'export const relay = false;\n');
    const rows = await toolRows(fx.runId);
    const write = rows.find((row) => row.tool_name === 'apply_changeset');
    assert.equal(write.status, 'SETTLED');
    assert.ok(write.operation_id !== null);
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(write.operation_id));
    assert.equal(operation?.status, 'SUCCEEDED');
    assert.equal(operation?.action_type, 'APPLY_CHANGESET');
    // 变化集账本记录的是实测落盘摘要，不接受模型自报。
    const ledger = await withTransaction(app.db, (repositories) => repositories.changeSets.listByOperation(write.operation_id));
    assert.equal(ledger.length, 1);
    const files = await withTransaction(app.db, (repositories) => repositories.changeSets.listFiles(ledger[0].id));
    assert.equal(files.length, 1);
    assert.equal(files[0].status, 'APPLIED');
    assert.equal(files[0].relative_path, 'src/index.ts');
    assert.equal(files[0].actual_sha256, await sha256File(join(fx.canonicalRoot, 'src', 'index.ts')));
    assert.equal(files[0].baseline_sha256, baseline);
});
test('a configured check runs for real inside the grant, and an unknown check id is refused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-check-'));
    roots.push(root);
    await writeFile(join(root, 'check.mjs'), 'console.log("check-ok"); process.exit(0);\n', 'utf8');
    const check = { id: 'smoke', executable: process.execPath,
        args: [join(root, 'check.mjs')], max_output_bytes: 4096,
        executable_sha256: await sha256File(process.execPath) };
    const fx = await fixture('scope-check', { scopeActions: ['APPLY_CHANGESET', 'CLI_RUN'],
        allowedTools: ['run_check'], checks: [check] });
    // 先用未配置的 check_id 证明模型无法自带命令。
    const refused = await drive(fx, [[{ name: 'run_check', arguments: { check_id: 'rm-rf' } }]]);
    assert.ok(refused.statuses.includes('TOOL_FAILED'), JSON.stringify(refused.statuses));
    const rows = await toolRows(fx.runId);
    assert.equal(rows[0].status, 'REJECTED');
    assert.equal(rows[0].result_ref?.reason, 'TOOL_CHECK_NOT_CONFIGURED');
    // 未配置的检查没有留下动作，更没有启动任何子进程。
    assert.equal(await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId)).then((list) => list.length), 0);
    // 再用已配置的 check_id：真实子进程被执行，退出码与输出如实回来。
    const granted = await fixture('scope-check-ok', { scopeActions: ['APPLY_CHANGESET', 'CLI_RUN'],
        allowedTools: ['run_check'], checks: [check] });
    const driven = await drive(granted, [[{ name: 'run_check', arguments: { check_id: 'smoke' } }]]);
    const checkRows = await toolRows(granted.runId);
    assert.ok(driven.statuses.includes('TOOL_SUCCEEDED'), `${JSON.stringify(driven.statuses)} result=${JSON.stringify(checkRows[0]?.result_ref)}`);
    assert.equal(checkRows[0].status, 'SETTLED');
    assert.equal(checkRows[0].result_ref?.exitCode, 0);
    assert.match(String(checkRows[0].result_ref?.stdout), /check-ok/);
    // 模型只给了 check_id；真实程序与参数来自冻结清单，不由工具参数决定。
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(checkRows[0].operation_id));
    assert.deepEqual(operation?.params, { executable: process.execPath,
        args: [join(root, 'check.mjs')], max_output_bytes: 4096 });
});
test('a failed real check is replayed before repair and a second real check passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-check-repair-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    const target = join(root, 'src', 'value.txt');
    const marker = `expected-${randomUUID()}`;
    const initial = 'incorrect\n';
    const unrelated = 'user work must stay byte-for-byte\r\n';
    await writeFile(target, initial);
    await writeFile(join(root, 'src', 'unrelated.txt'), unrelated);
    const checker = join(root, 'check.mjs');
    const checkerText = `import { readFileSync } from 'node:fs';\n` +
        `const value = readFileSync('src/value.txt', 'utf8').trim();\n` +
        `if (value !== ${JSON.stringify(marker)}) {\n` +
        `  console.error('expected=' + ${JSON.stringify(marker)} + '; actual=' + value);\n` +
        `  process.exitCode = 1;\n` +
        `} else console.log('verified=' + value);\n`;
    await writeFile(checker, checkerText);
    const check = { id: 'tests', executable: process.execPath,
        args: [checker], executable_sha256: await sha256File(process.execPath), max_output_bytes: 4096 };
    const fx = await fixture('check-failure-repair', { sharedRoot: root,
        allowedTools: ['run_check', 'read_file', 'apply_changeset'],
        scopeActions: ['APPLY_CHANGESET', 'CLI_RUN'], checks: [check] });
    const baseline = await sha256File(target);
    const plan = await resolveToolLoopPlan(app.db, fx.runId, fx.workspaceId);
    const checkSpec = plan?.specs.find((spec) => spec.name === 'run_check');
    assert.deepEqual(checkSpec?.parameters.properties, { check_id: { type: 'string', enum: ['tests'], description: '本次 Run 已冻结的检查标识。' } });
    const driven = await drive(fx, [
        [{ name: 'run_check', arguments: { check_id: 'tests' } }],
        [{ name: 'read_file', arguments: { relative_path: 'src/value.txt' } }],
        [{ name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY',
                            path: 'src/value.txt', baselineSha256: baseline, content: `${marker}\n` }] } }],
        [{ name: 'run_check', arguments: { check_id: 'tests' } }],
    ], 40);
    assert.deepEqual(driven.pending, []);
    assert.ok(driven.statuses.includes('TOOL_CHECK_FAILED'), JSON.stringify(driven.statuses));
    assert.ok(!driven.statuses.includes('RUN_FAILED'), JSON.stringify(driven.statuses));
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => [row.round, row.tool_name, row.status]), [
        [0, 'run_check', 'SETTLED'], [1, 'read_file', 'SETTLED'],
        [2, 'apply_changeset', 'SETTLED'], [3, 'run_check', 'SETTLED'],
    ]);
    const operations = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    const results = new Map(operations.flatMap((operation) => operation.result_ref === null
        ? [] : [[operation.id, operation.result_ref]]));
    const turns = buildToolTurns(rows, results);
    const failure = turns[0].results[0];
    assert.equal(failure.isError, true);
    const failedResult = JSON.parse(failure.content);
    assert.equal(failedResult.exitCode, 1);
    assert.match(String(failedResult.stderr), new RegExp(marker));
    assert.match(String(failedResult.stderr), /actual=incorrect/);
    assert.equal(rows[1].result_ref?.sha256, baseline);
    const success = turns[3].results[0];
    assert.equal(success.isError, false);
    assert.equal(JSON.parse(success.content).exitCode, 0);
    assert.match(success.content, new RegExp(`verified=${marker}`));
    assert.equal(await readFile(target, 'utf8'), `${marker}\n`);
    assert.equal(await readFile(join(root, 'src', 'unrelated.txt'), 'utf8'), unrelated);
    assert.equal(await readFile(checker, 'utf8'), checkerText);
    // The final reply remains a candidate; a passing CLI tool cannot accept HUMAN criteria.
    const run = await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId));
    assert.equal(run?.status, 'WAITING_APPROVAL');
    const ids = rows.map((row) => [row.id, row.operation_id]);
    await drive(fx, [], 4);
    assert.deepEqual((await toolRows(fx.runId)).map((row) => [row.id, row.operation_id]), ids);
    assert.equal((await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId))).length, 4);
    assert.equal(await readFile(target, 'utf8'), `${marker}\n`);
});
test('an unknown check outcome stays pending and is never replayed as a settled model result', async () => {
    const checkRoot = await mkdtemp(join(tmpdir(), 'relay-unknown-check-'));
    roots.push(checkRoot);
    const script = join(checkRoot, 'check.mjs');
    await writeFile(script, 'await new Promise(resolve => setTimeout(resolve, 1500));\nconsole.log("closed");\n');
    const check = { id: 'slow', executable: process.execPath, args: [script],
        executable_sha256: await sha256File(process.execPath), max_output_bytes: 4096 };
    const fx = await fixture('check-unknown', { allowedTools: ['run_check'],
        scopeActions: ['CLI_RUN'], checks: [check] });
    const scriptCalls = [[{ name: 'run_check', arguments: { check_id: 'slow' } }]];
    const toolCallId = await advanceToPendingToolAction(fx, scriptCalls);
    // No heartbeat: the real child closes after this Worker lease expires. Its result is
    // stale, so it must remain UNKNOWN even though the adapter observed an exit code.
    const outcome = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId, leaseMs: 1000 });
    assert.equal(outcome.status, 'UNKNOWN');
    const row = await new RunToolCallRepository(app.db).read(toolCallId);
    assert.equal(row?.status, 'PREPARED');
    assert.equal(row?.result_ref, null);
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(outcome.operationId));
    assert.equal(operation?.status, 'UNKNOWN');
    assert.deepEqual(buildToolTurns([row], new Map([[operation.id, operation.result_ref]])), []);
    const resumed = await advanceRunStep(app.db, { runId: fx.runId,
        workerId: `unknown-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
        fakeToolScript: scriptCalls });
    assert.equal(resumed.status, 'TOOL_LOOP_ACTION_REQUIRED');
    assert.equal((await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId })).status, 'UNKNOWN');
    const draft = await withTransaction(app.db, async (repositories) => {
        const step = (await repositories.runs.listSteps(fx.runId)).find((entry) => entry.step_kind === 'DRAFT');
        return step;
    });
    assert.notEqual(draft?.status, 'SUCCEEDED');
    // Compatibility with the old bug: a SETTLED tool row must not override UNKNOWN.
    await new RunToolCallRepository(app.db).settle(toolCallId, operation.result_ref);
    const legacyResume = await advanceRunStep(app.db, { runId: fx.runId,
        workerId: `legacy-unknown-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
        fakeToolScript: scriptCalls });
    assert.equal(legacyResume.status, 'ACTION_UNKNOWN');
    assert.equal((await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId })).status, 'UNKNOWN');
});
test('a timed-out check remains a failure when replayed after settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-timeout-check-'));
    roots.push(root);
    const script = join(root, 'check.mjs');
    await writeFile(script, 'await new Promise(resolve => setTimeout(resolve, 5000));\n');
    const check = { id: 'timeout', executable: process.execPath, args: [script],
        executable_sha256: await sha256File(process.execPath), max_output_bytes: 4096 };
    const fx = await fixture('check-timeout-replay', { allowedTools: ['run_check'],
        scopeActions: ['CLI_RUN'], checks: [check] });
    const id = await advanceToPendingToolAction(fx, [[{ name: 'run_check', arguments: { check_id: 'timeout' } }]]);
    const original = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId: id,
        deadline: new Date(Date.now() + 1000) });
    assert.equal(original.status, 'FAILED');
    const row = await new RunToolCallRepository(app.db).read(id);
    assert.equal(row?.status, 'SETTLED');
    assert.equal(row?.result_ref?.outcome, 'TIMEOUT');
    const replay = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId: id });
    assert.equal(replay.status, 'FAILED');
    assert.equal(replay.operationId, original.operationId);
    const invocations = await withTransaction(app.db, (repositories) => repositories.gateway.listInvocations(original.operationId));
    assert.equal(invocations.length, 1);
    const claim = await withTransaction(app.db, (repositories) => repositories.gateway.readClaim(invocations[0].resource_claim_id));
    assert.equal(claim?.status, 'QUARANTINED');
});
test('a delete inside the granted scope still waits for a single-action approval', async () => {
    const fx = await fixture('scope-delete', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const baseline = await sha256File(join(fx.canonicalRoot, 'src', '工具.ts'));
    const driven = await drive(fx, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'DELETE', path: 'src/工具.ts', baselineSha256: baseline }
                    ] } }]]);
    assert.ok(driven.statuses.includes('TOOL_WAITING'), JSON.stringify(driven.statuses));
    // 一次范围授权不能把删除带走：文件仍在。
    assert.equal(await readFile(join(fx.canonicalRoot, 'src', '工具.ts'), 'utf8'), 'export const 名称 = "中文";\n');
});
test('a revoked or expired grant stops automatic execution again', async () => {
    const revoked = await fixture('scope-revoked', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    assert.equal(await new RunScopeGrantRepository(app.db).revoke(revoked.runId, '用户撤回授权'), true);
    const baseline = await sha256File(join(revoked.canonicalRoot, 'README.md'));
    const driven = await drive(revoked, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'README.md', baselineSha256: baseline, content: '# 撤权后\n' }
                    ] } }]]);
    assert.ok(driven.statuses.includes('TOOL_WAITING'), JSON.stringify(driven.statuses));
    assert.equal(await readFile(join(revoked.canonicalRoot, 'README.md'), 'utf8'), README_BASELINE);
    const expired = await fixture('scope-expired', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'], grantExpiresAt: new Date(Date.now() - 1000) });
    const expiredBaseline = await sha256File(join(expired.canonicalRoot, 'README.md'));
    const expiredDriven = await drive(expired, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'README.md', baselineSha256: expiredBaseline,
                            content: '# 过期后\n' }
                    ] } }]]);
    assert.ok(expiredDriven.statuses.includes('TOOL_WAITING'), JSON.stringify(expiredDriven.statuses));
    assert.equal(await readFile(join(expired.canonicalRoot, 'README.md'), 'utf8'), README_BASELINE);
});
test('a stale baseline keeps the user edit and reports the conflict instead of overwriting', async () => {
    const fx = await fixture('scope-conflict', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const path = join(fx.canonicalRoot, 'src', 'index.ts');
    const staleBaseline = await sha256File(path);
    // 用户在模型读完之后改了同一个文件：写动作的冻结基线已经不成立。
    await writeFile(path, 'export const relay = "user-edit";\n', 'utf8');
    const driven = await drive(fx, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'src/index.ts', baselineSha256: staleBaseline,
                            content: 'export const relay = "model-edit";\n' }
                    ] } }]]);
    // 用户的改动必须原样保留，不能被模型覆盖。
    assert.equal(await readFile(path, 'utf8'), 'export const relay = "user-edit";\n');
    const rows = await toolRows(fx.runId);
    assert.notEqual(rows[0].status, 'SUCCEEDED');
});
test('a conflict is adapted once against a re-read baseline, and a second try stops for the user', async () => {
    const fx = await fixture('scope-adapt', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'], maxRounds: 6, maxToolCalls: 8 });
    const path = join(fx.canonicalRoot, 'src', 'index.ts');
    const stale = await sha256File(path);
    await writeFile(path, 'export const relay = "user-edit";\n', 'utf8');
    const current = await sha256File(path);
    const old = [{ action: 'MODIFY', path: 'src/index.ts', baselineSha256: stale,
            content: 'export const relay = "model-edit";\n' }];
    const driven = await drive(fx, [
        // 0：过期基线 → 真实冲突，用户改动必须原样保留。
        [{ name: 'apply_changeset', arguments: { changes: old } }],
        // 1：原样重试 → 没有重读，不算适配。
        [{ name: 'apply_changeset', arguments: { changes: old } }],
        // 2：新基线 + 旧目标全文 → 冒充适配。
        [{ name: 'apply_changeset', arguments: { changes: [{ ...old[0], baselineSha256: current }] } }],
        // 3：重读后的基线 + 真正的新内容 → 合法的一次适配。
        [{ name: 'apply_changeset', arguments: { changes: [{ ...old[0], baselineSha256: current,
                            content: 'export const relay = "user-edit";\nexport const relay2 = "model-edit";\n' }] } }],
        // 4：同一条冲突再改一次 → 已适配过，必须停下来交给用户。
        [{ name: 'apply_changeset', arguments: { changes: [{ ...old[0], baselineSha256: current,
                            content: '再来一次\n' }] } }],
        [{ name: 'apply_changeset', arguments: { changes: [{ ...old[0], baselineSha256: current,
                            content: '还要再来\n' }] } }],
    ]);
    assert.deepEqual(driven.pending, []);
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'REJECTED', 'REJECTED', 'SETTLED', 'REJECTED', 'REJECTED']);
    assert.deepEqual(rows.map((row) => row.result_ref?.reason ?? null), ['SOME_CHANGES_FAILED_OR_CONFLICTED', 'TOOL_ADAPTATION_STALE_BASELINE',
        'TOOL_ADAPTATION_CONTENT_UNCHANGED', null, 'TOOL_ADAPTATION_REQUIRES_HUMAN',
        'TOOL_ADAPTATION_REQUIRES_HUMAN']);
    // 只有第 3 行是适配，且必须指向原始请求与那一个冲突路径。
    assert.deepEqual(rows.map((row) => row.adaptation_of), [null, null, null, rows[0].id, null, null]);
    assert.deepEqual(rows.map((row) => row.adapted_path), [null, null, null, 'src/index.ts', null, null]);
    // 被拒的请求都不连 Operation，也不写盘。
    assert.deepEqual(rows.filter((row) => row.status === 'REJECTED')
        .map((row) => row.operation_id), [null, null, null, null]);
    // 适配落盘后文件同时含用户改动与模型改动：适配不是覆盖。
    const applied = await readFile(path, 'utf8');
    assert.ok(applied.includes('user-edit'));
    assert.ok(applied.includes('relay2'));
    // 停止点：Run 停在等待人工，而不是继续自动改写或记成执行失败。
    assert.ok(driven.statuses.includes('BUDGET_EXHAUSTED'), `statuses=${JSON.stringify(driven.statuses)}`);
    const state = await withTransaction(app.db, async (repositories) => ({
        run: await repositories.runs.readRun(fx.runId),
        task: await repositories.tasks.readTask(fx.taskId),
    }));
    assert.equal(state.run?.status, 'WAITING_APPROVAL');
    assert.equal(state.run?.wait_reason, 'HUMAN_TOOL');
    assert.equal(state.task?.status, 'WAITING');
    assert.equal(state.task?.executor_run_id, fx.runId);
});
test('a changeset that reaches outside the managed root is denied, not written', async () => {
    const fx = await fixture('scope-escape', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const driven = await drive(fx, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'CREATE', path: '../escaped.md', content: '# 越界\n' }
                    ] } }]]);
    assert.ok(driven.statuses.includes('TOOL_FAILED'), JSON.stringify(driven.statuses));
    const rows = await toolRows(fx.runId);
    assert.equal(rows[0].status, 'REJECTED');
    assert.equal(rows[0].operation_id, null);
});
// ---------------------------------------------------------------------------
// B 片并发与冲突覆盖（2026-10-04）。
//
// 判定口径：写动作不能因为重试、并发或跨 Project 共享同一物理目录而产生第二次效果；
// 单动作批准与范围授权是两个对象，撤销其中一个不改变另一个的事实。
// ---------------------------------------------------------------------------
test('a repeated delivery of the same write request never writes the file twice', async () => {
    const fx = await fixture('scope-write-replay', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const baseline = await sha256File(join(fx.canonicalRoot, 'src', 'index.ts'));
    const storage = new ManagedContentStore(dataRoot);
    const script = [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'src/index.ts', baselineSha256: baseline,
                            content: 'export const relay = "written";\n' }
                    ] } }]];
    await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`, storage,
        fakeToolScript: script });
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
        workerId: `loop-${randomUUID()}`, storage, fakeToolScript: script });
    assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
    const claim = toolClaim(fx);
    const first = await executeToolLoopStep(app.db, { claim, toolCallId: advanced.tool_call_id });
    assert.equal(first.status, 'SUCCEEDED', JSON.stringify(first));
    const operationsAfterFirst = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    const second = await executeToolLoopStep(app.db, { claim, toolCallId: advanced.tool_call_id });
    assert.equal(second.status, 'SUCCEEDED', JSON.stringify(second));
    const operationsAfterSecond = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    // 同一请求重复投递不产生第二个动作，磁盘内容也不被第二次改写。
    assert.equal(operationsAfterFirst.length, 1);
    assert.equal(operationsAfterSecond.length, operationsAfterFirst.length);
    assert.equal(await readFile(join(fx.canonicalRoot, 'src', 'index.ts'), 'utf8'), 'export const relay = "written";\n');
});
test('two Projects sharing one physical directory cannot overwrite each other', async () => {
    const first = await fixture('scope-shared-a', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    // 第二个 Project 注册同一个物理目录：资源行各自独立，但底层是同一批文件。
    const second = await fixture('scope-shared-b', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'], sharedRoot: first.canonicalRoot });
    const target = join(first.canonicalRoot, 'src', 'index.ts');
    const sharedBaseline = await sha256File(target);
    const firstDriven = await drive(first, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'src/index.ts', baselineSha256: sharedBaseline,
                            content: 'export const owner = "first";\n' }
                    ] } }]]);
    assert.ok(firstDriven.statuses.includes('TOOL_SUCCEEDED'), JSON.stringify(firstDriven.statuses));
    assert.equal(await readFile(target, 'utf8'), 'export const owner = "first";\n');
    // 第二个 Run 手里还是同一个过期基线：必须冲突并保留第一个 Run 的内容。
    const secondDriven = await drive(second, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'src/index.ts', baselineSha256: sharedBaseline,
                            content: 'export const owner = "second";\n' }
                    ] } }]]);
    assert.ok(!secondDriven.statuses.includes('TOOL_SUCCEEDED'), JSON.stringify(secondDriven.statuses));
    assert.equal(await readFile(target, 'utf8'), 'export const owner = "first";\n');
    // 冲突如实结算为 FAILED 并带上原因；行仍是 SETTLED——「已结算」不等于「成功」。
    const secondRows = await toolRows(second.runId);
    const conflicted = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(secondRows[0].id));
    assert.equal(conflicted?.status, 'FAILED');
    assert.equal(conflicted?.result_ref?.reason, 'SOME_CHANGES_FAILED_OR_CONFLICTED');
});
test('a single-action approval survives a scope grant revocation because they are separate facts', async () => {
    const fx = await fixture('scope-approve-then-revoke', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const storage = new ManagedContentStore(dataRoot);
    const baseline = await sha256File(join(fx.canonicalRoot, 'src', '工具.ts'));
    const script = [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'DELETE', path: 'src/工具.ts', baselineSha256: baseline }
                    ] } }]];
    await advanceRunStep(app.db, { runId: fx.runId, workerId: `loop-${randomUUID()}`, storage,
        fakeToolScript: script });
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
        workerId: `loop-${randomUUID()}`, storage, fakeToolScript: script });
    assert.equal(advanced.status, 'TOOL_LOOP_ACTION_REQUIRED', JSON.stringify(advanced));
    // 删除在授权内仍要单动作确认。
    const waiting = await executeToolLoopStep(app.db, { claim: toolClaim(fx),
        toolCallId: advanced.tool_call_id });
    assert.equal(waiting.status, 'WAITING', JSON.stringify(waiting));
    assert.equal(await readFile(join(fx.canonicalRoot, 'src', '工具.ts'), 'utf8'), 'export const 名称 = "中文";\n');
    // 撤销范围授权：它不能让已排出的单动作批准失效，两者本来就是两个对象。
    assert.equal(await new RunScopeGrantRepository(app.db)
        .revoke(fx.runId, '撤回自动执行范围'), true);
    const reviewId = waiting.reviewId;
    const review = await withTransaction(app.db, (repositories) => repositories.reviews.readRequest(reviewId));
    assert.ok(review !== undefined);
    await resolveReview(app.db, { workspaceId: fx.workspaceId, reviewId, commandId: randomUUID(),
        expectedRevision: review.revision.toString(), targetHash: review.target_hash.toString('hex'),
        decision: 'APPROVE' });
    const decisionId = await latestDecisionId(reviewId);
    const commands = await sql `
    select id from run_commands where review_decision_id = ${decisionId}`.execute(app.db);
    assert.equal(commands.rows.length, 1);
    const resumed = await executeToolLoopStep(app.db, {
        claim: { ...toolClaim(fx), commandId: commands.rows[0].id, kind: 'RESUME',
            reviewDecisionId: decisionId },
        toolCallId: advanced.tool_call_id
    });
    assert.equal(resumed.status, 'SUCCEEDED', JSON.stringify(resumed));
    const settled = await toolRows(fx.runId);
    assert.equal(settled[0].status, 'SETTLED');
    // 这次删除确实执行了：单动作批准是它自己的事实。
    await assert.rejects(() => readFile(join(fx.canonicalRoot, 'src', '工具.ts'), 'utf8'));
});
// ---------------------------------------------------------------------------
// 一次自动适配的可验证边界。
//
// 判定规则（重新读取的基线、只适配一次、多路径与目标消失时停下）由
// test/unit/tool-loop.test.ts 的 decideToolAdaptation 用例覆盖；这里只固定
// 「冲突回执给出实测摘要、账本不留下任何写入」这一条真实出口。
test('a conflict receipt reports the observed baseline so a re-read can be based on it', async () => {
    const fx = await fixture('scope-adapt', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const target = join(fx.canonicalRoot, 'src', 'index.ts');
    const staleBaseline = await sha256File(target);
    // 用户在模型读取之后改了同一个文件：第一次写必然冲突。
    const userContent = '// user line\nexport const relay = true;\n';
    await writeFile(target, userContent, 'utf8');
    const driven = await drive(fx, [[{ name: 'apply_changeset', arguments: { changes: [
                        { action: 'MODIFY', path: 'src/index.ts', baselineSha256: staleBaseline,
                            content: '// model line\nexport const relay = true;\n' }
                    ] } }]]);
    assert.ok(driven.statuses.includes('TOOL_FAILED'), JSON.stringify(driven.statuses));
    const rows = await toolRows(fx.runId);
    const changes = (rows[0].result_ref?.changes ?? []);
    const conflict = changes.find((change) => change.status === 'CONFLICT');
    assert.ok(conflict !== undefined, JSON.stringify(changes));
    // 冲突回执给出的是实测到的当前摘要，也就是模型重新读取时该拿到的基线。
    assert.equal(conflict.actualBaselineSha256, await sha256File(target));
    assert.equal(conflict.path, 'src/index.ts');
    // 用户的改动没有被覆盖。
    assert.equal(await readFile(target, 'utf8'), userContent);
    // 账本记的是实测到的当前内容，而不是模型声明的目标：据此可核对「冲突时磁盘上是什么」。
    const ledger = await withTransaction(app.db, (repositories) => repositories.changeSets.listByOperation(rows[0].id));
    assert.equal(ledger.length, 1);
    const ledgerFiles = await withTransaction(app.db, (repositories) => repositories.changeSets.listFiles(ledger[0].id));
    assert.equal(ledgerFiles[0].status, 'CONFLICT');
    assert.equal(ledgerFiles[0].actual_sha256, await sha256File(target));
});
test('a pending user pause blocks a requested write before it reaches the disk', async () => {
    const fx = await fixture('scope-stop', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const path = join(fx.canonicalRoot, 'src', 'index.ts');
    const baseline = await sha256File(path);
    const toolCallId = await advanceToPendingToolAction(fx, [[{ name: 'apply_changeset',
                arguments: { changes: [{ action: 'MODIFY', path: 'src/index.ts', baselineSha256: baseline,
                            content: 'export const relay = "model-edit";\n' }] } }]]);
    assert.deepEqual((await toolRows(fx.runId)).map((row) => row.status), ['REQUESTED']);
    // 停止意图先持久化：不能只活在 UI 的 Loading 里，否则进程一退就没人知道要停。
    const before = await withTransaction(app.db, async (repositories) => ({
        task: await repositories.tasks.readTask(fx.taskId),
        run: await repositories.runs.readRun(fx.runId)
    }));
    const control = await requestRunControl(app.db, { workspaceId: fx.workspaceId, runId: fx.runId,
        commandId: randomUUID(), expectedTaskRevision: before.task.revision.toString(),
        expectedRunRevision: before.run.revision.toString(), type: 'PAUSE' });
    assert.equal(control.result.status, 'PENDING');
    // 暂停意图已持久化时再派发同一个写请求：必须是类型化结果，不是未分类异常。
    // Worker 分不清「用户按了暂停」和「工具坏了」，就会把一次人为停止报成执行失败。
    const outcome = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId })
        .then((result) => ({ kind: 'typed', status: result.status }), (error) => ({ kind: 'threw',
        message: error instanceof Error ? error.message : String(error) }));
    assert.deepEqual(outcome, { kind: 'typed', status: 'STOPPED' }, `暂停期间派发写工具的结果=${JSON.stringify(outcome)}`);
    // 一个字节都不能落盘，也没有留下任何动作。
    assert.equal(await readFile(path, 'utf8'), 'export const relay = true;\n');
    const operations = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    assert.deepEqual(operations.map((operation) => operation.status), []);
    // 暂停是可恢复的：请求行保留原身份，恢复后仍走同一个动作，不重新派生第二个写入。
    const rows = await toolRows(fx.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, toolCallId);
    assert.equal(rows[0].status, 'REQUESTED');
    assert.equal(rows[0].operation_id, null);
});
test('a write paused before dispatch resumes under the same identity and writes exactly once', async () => {
    const fx = await fixture('scope-pause-resume-write', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const path = join(fx.canonicalRoot, 'src', 'index.ts');
    const original = await readFile(path, 'utf8');
    const baseline = await sha256File(path);
    const toolCallId = await advanceToPendingToolAction(fx, [[{ name: 'apply_changeset',
                arguments: { changes: [{ action: 'MODIFY', path: 'src/index.ts', baselineSha256: baseline,
                            content: 'export const relay = "resumed-once";\n' }] } }]]);
    assert.deepEqual((await toolRows(fx.runId)).map((row) => row.status), ['REQUESTED']);
    // 暂停先真正应用（而不只是挂一个 PENDING 意图）：磁盘未动、动作未建、行保原身份。
    const before = await withTransaction(app.db, async (repositories) => ({
        task: await repositories.tasks.readTask(fx.taskId), run: await repositories.runs.readRun(fx.runId)
    }));
    await requestRunControl(app.db, { workspaceId: fx.workspaceId, runId: fx.runId,
        commandId: randomUUID(), expectedTaskRevision: before.task.revision.toString(),
        expectedRunRevision: before.run.revision.toString(), type: 'PAUSE' });
    const applied = await applySafeControl(app.db, fx.runId);
    assert.equal(applied?.status, 'APPLIED');
    assert.equal((await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId)))?.status, 'PAUSED');
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal((await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId))).length, 0);
    const paused = await toolRows(fx.runId);
    assert.deepEqual(paused.map((row) => [row.id, row.status, row.operation_id]), [[toolCallId, 'REQUESTED', null]]);
    // 恢复：同一个 Run 回到 RUNNING，同一个请求身份被派发一次。
    const task = await withTransaction(app.db, (repositories) => repositories.tasks.readTask(fx.taskId));
    const run = await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId));
    const resumed = await resumeRun(app.db, { workspaceId: fx.workspaceId, runId: fx.runId,
        commandId: randomUUID(), expectedTaskRevision: task.revision.toString(),
        expectedRunRevision: run.revision.toString() });
    assert.equal(resumed.result.status, 'RUNNING', JSON.stringify(resumed.result));
    const settled = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId });
    assert.equal(settled.status, 'SUCCEEDED', JSON.stringify(settled));
    // 行 id 就是动作身份：恢复后走的仍是同一个 Operation，没有第二次写入。
    assert.equal(settled.operationId, toolCallId);
    assert.equal(await readFile(path, 'utf8'), 'export const relay = "resumed-once";\n');
    assert.deepEqual((await toolRows(fx.runId)).map((row) => [row.id, row.status, row.operation_id]), [[toolCallId, 'SETTLED', toolCallId]]);
    const operations = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    assert.deepEqual(operations.map((operation) => [operation.id, operation.status]), [[toolCallId, 'SUCCEEDED']]);
    // 变化集账本只有一条，且实测摘要与磁盘一致——这是「没有第二次写入」的落盘证据。
    const ledgers = await withTransaction(app.db, (repositories) => repositories.changeSets.listByOperation(toolCallId));
    assert.equal(ledgers.length, 1);
    const files = await withTransaction(app.db, (repositories) => repositories.changeSets.listFiles(ledgers[0].id));
    assert.deepEqual(files.map((file) => [file.relative_path, file.status]), [['src/index.ts', 'APPLIED']]);
    assert.equal(files[0].actual_sha256, await sha256File(path));
});
test('a cancelled Run abandons the leftover write request instead of leaving it dispatchable', async () => {
    const fx = await fixture('scope-cancel-write', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const path = join(fx.canonicalRoot, 'src', 'index.ts');
    const original = await readFile(path, 'utf8');
    const baseline = await sha256File(path);
    const toolCallId = await advanceToPendingToolAction(fx, [[{ name: 'apply_changeset',
                arguments: { changes: [{ action: 'MODIFY', path: 'src/index.ts', baselineSha256: baseline,
                            content: 'export const relay = "cancelled";\n' }] } }]]);
    assert.deepEqual((await toolRows(fx.runId)).map((row) => row.status), ['REQUESTED']);
    // 取消应用：Run 落终态，磁盘仍未动。
    const before = await withTransaction(app.db, async (repositories) => ({
        task: await repositories.tasks.readTask(fx.taskId), run: await repositories.runs.readRun(fx.runId)
    }));
    await requestRunControl(app.db, { workspaceId: fx.workspaceId, runId: fx.runId,
        commandId: randomUUID(), expectedTaskRevision: before.task.revision.toString(),
        expectedRunRevision: before.run.revision.toString(), type: 'CANCEL' });
    const applied = await applySafeControl(app.db, fx.runId);
    assert.equal(applied?.status, 'APPLIED');
    assert.equal((await withTransaction(app.db, (repositories) => repositories.runs.readRun(fx.runId)))?.status, 'CANCELLED');
    // 终态图不会再交回这个请求；旧 Worker 若仍拿着它，必须得到类型化结果而不是抛未分类异常。
    const advanced = await advanceRunStep(app.db, { runId: fx.runId,
        workerId: `cancel-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) });
    assert.equal(advanced.status, 'RUN_TERMINAL', JSON.stringify(advanced));
    const outcome = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId });
    assert.equal(outcome.status, 'STOPPED', JSON.stringify(outcome));
    // 一个字节都没落盘，也没有留下任何动作。
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal((await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId))).length, 0);
    // 遗留请求落定终态归属：不再是看起来仍可完成的 REQUESTED，历史仍可读且带类型化原因。
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => [row.id, row.status, row.operation_id]), [[toolCallId, 'REJECTED', null]]);
    assert.equal(rows[0].result_ref?.reason, 'RUN_TERMINAL');
    assert.ok(String(rows[0].result_ref?.detail ?? '').length > 0);
    const pending = await new RunToolCallRepository(app.db).listPending(fx.runId);
    assert.deepEqual(pending.map((row) => row.id), []);
    const projection = await readRunToolCalls(app.db, fx.workspaceId, fx.runId);
    assert.equal(projection.run_status, 'CANCELLED');
    assert.equal(projection.rounds[0]?.calls[0]?.status, 'REJECTED');
    assert.equal(projection.rounds[0]?.calls[0]?.operation_id, null);
});
test('a write request past the call budget is rejected without an Operation or a disk byte', async () => {
    const fx = await fixture('scope-budget-write', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'], maxToolCalls: 1 });
    const first = join(fx.canonicalRoot, 'src', 'index.ts');
    const second = join(fx.canonicalRoot, 'README.md');
    const firstBaseline = await sha256File(first);
    const secondBaseline = await sha256File(second);
    // 同一轮里模型发出两个写请求。既有预算用例只覆盖过只读工具，写路径必须单独证明：
    // 预算外的那个不能连 Operation，因此不可能在盘上留下任何痕迹。
    const driven = await drive(fx, [[
            { name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY', path: 'src/index.ts',
                            baselineSha256: firstBaseline, content: 'export const relay = "written";\n' }] } },
            { name: 'apply_changeset', arguments: { changes: [{ action: 'MODIFY', path: 'README.md',
                            baselineSha256: secondBaseline, content: '# 预算外的第二次写入\n' }] } },
        ]]);
    assert.deepEqual(driven.pending, [], JSON.stringify(driven.statuses));
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => row.status), ['SETTLED', 'REJECTED']);
    assert.equal(rows[1].result_ref?.reason, 'TOOL_LOOP_BUDGET_EXHAUSTED');
    assert.equal(rows[1].operation_id, null);
    // 预算内的那一次照常落盘；预算外的那一次一个字节都没动。
    assert.equal(await readFile(first, 'utf8'), 'export const relay = "written";\n');
    assert.equal(await readFile(second, 'utf8'), README_BASELINE);
    const changeSets = await withTransaction(app.db, async (repositories) => repositories.changeSets.listFiles((await repositories.changeSets.listByOperation(rows[0].operation_id))[0].id));
    assert.deepEqual(changeSets.map((file) => file.relative_path), ['src/index.ts']);
});
test('a settled write is not re-executed after a restart and the loop resumes from the row', async () => {
    const fx = await fixture('scope-restart', { scopeActions: ['APPLY_CHANGESET'],
        allowedTools: ['apply_changeset'] });
    const path = join(fx.canonicalRoot, 'src', 'index.ts');
    const baseline = await sha256File(path);
    const toolCallId = await advanceToPendingToolAction(fx, [[{ name: 'apply_changeset',
                arguments: { changes: [{ action: 'MODIFY', path: 'src/index.ts', baselineSha256: baseline,
                            content: 'export const relay = "written-once";\n' }] } }]]);
    const settled = await executeToolLoopStep(app.db, { claim: toolClaim(fx), toolCallId });
    assert.equal(settled.status, 'SUCCEEDED');
    assert.ok(settled.operationId !== null);
    const operationId = settled.operationId;
    assert.equal(await readFile(path, 'utf8'), 'export const relay = "written-once";\n');
    // 「重启」：此后只剩数据库这一份事实。脚本也不再提供那一次写入——恢复只能靠已落库行
    // 重建历史。若历史没重建，Fake 模型会从第 0 轮再要一次写入，run_tool_calls 就会多出
    // 第 1 轮的一行；所以下面的行数与轮次是「没有重复执行」的决定性证据。
    const resumed = await drive(fx, []);
    assert.ok(resumed.statuses.includes('STEP_SUCCEEDED'), JSON.stringify(resumed.statuses));
    assert.deepEqual(resumed.pending, []);
    // 同一个动作身份、同一份落盘证据，没有第二个 Operation，也没有第二次变化集账本。
    const rows = await toolRows(fx.runId);
    assert.deepEqual(rows.map((row) => [row.round, row.status, row.operation_id]), [[0, 'SETTLED', operationId]]);
    assert.equal(await readFile(path, 'utf8'), 'export const relay = "written-once";\n');
    const operations = await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId));
    assert.deepEqual(operations.map((operation) => [operation.id, operation.status]), [[operationId, 'SUCCEEDED']]);
    const ledgers = await withTransaction(app.db, (repositories) => repositories.changeSets.listByOperation(operationId));
    assert.equal(ledgers.length, 1);
    const files = await withTransaction(app.db, (repositories) => repositories.changeSets.listFiles(ledgers[0].id));
    assert.deepEqual(files.map((file) => [file.relative_path, file.status]), [['src/index.ts', 'APPLIED']]);
    assert.equal(files[0].actual_sha256, await sha256File(path));
    // 重启后的读取仍然如实呈现那次写入，而不是「读不到工具」或「又跑了一次」。
    const projection = await readRunToolCalls(app.db, fx.workspaceId, fx.runId);
    assert.deepEqual(projection.rounds.map((round) => round.round), [0]);
    assert.equal(projection.rounds[0]?.calls[0]?.status, 'SETTLED');
    assert.equal(projection.rounds[0]?.calls[0]?.operation_id, operationId);
});
test('a check whose program changed after the grant falls back to a single-action approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-check-drift-'));
    roots.push(root);
    const scriptPath = join(root, 'check.mjs');
    await writeFile(scriptPath, 'console.log("drifted");\n', 'utf8');
    const otherPath = join(root, 'other.mjs');
    await writeFile(otherPath, 'console.log("other");\n', 'utf8');
    // 授权时冻结的是另一个文件的摘要：等价于「授权之后脚本被改过」。
    const check = { id: 'smoke', executable: process.execPath,
        args: [scriptPath], max_output_bytes: 4096,
        executable_sha256: await sha256File(otherPath) };
    const fx = await fixture('scope-check-drift', { scopeActions: ['APPLY_CHANGESET', 'CLI_RUN'],
        allowedTools: ['run_check'], checks: [check] });
    const driven = await drive(fx, [[{ name: 'run_check', arguments: { check_id: 'smoke' } }]]);
    const rows = await toolRows(fx.runId);
    assert.ok(driven.statuses.includes('TOOL_WAITING'), `${JSON.stringify(driven.statuses)} result=${JSON.stringify(rows[0]?.result_ref)}`);
    // 信任依据不成立就不自动执行；也没有真的跑起子进程。
    assert.equal(await withTransaction(app.db, (repositories) => repositories.gateway.listRunOperations(fx.runId)).then((list) => list.length), 1);
    const operation = await withTransaction(app.db, (repositories) => repositories.gateway.readOperation(rows[0].id));
    assert.equal(operation?.status, 'WAITING_APPROVAL');
});
