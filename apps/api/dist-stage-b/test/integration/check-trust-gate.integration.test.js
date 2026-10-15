import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createGatewayPolicy, registerManagedResource } from '../../src/application/gateway-configuration.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { RunScopeGrantRepository } from '../../src/application/run-scope-grant.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { RunToolCallRepository } from '../../src/run/run-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { executeToolLoopStep } from '../../src/worker/tool-loop-action.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
/**
 * 检查入口信任摘要（Stage A）的真实 PG 出口。
 *
 * 锁的是业务事实而不是内部形状：
 *   - 授权冻结时把「这次检查实际跑的材料」一并落库；
 *   - 同一 check_id、同一路径、同一命令名，入口脚本正文被改后不再 AUTO，退回人工确认，
 *     并把类型化原因写进 Review；
 *   - 只改被检查的源文件不使原信任失效，检查仍按原授权自动执行；
 *   - 内联求值参数在冻结期就被拒绝，不落一份没有依据的授权；
 *   - 历史授权行（只有入口摘要、没有材料依据）同样不自动放行。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-check-trust-gate');
// 授权边界对应用角色不可改写（只有撤销列有 UPDATE），所以「模拟升级前的历史行」必须
// 用迁移角色；这不是绕过产品约束，而是造一条产品已经不可能再写出来的历史数据。
const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-check-trust-gate-migrator');
let dataRoot;
const roots = [];
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    dataRoot = await createDataRoot();
});
after(async () => {
    await app.close();
    await migrator.close();
    await rm(dataRoot, { recursive: true, force: true });
    for (const root of roots)
        await rm(root, { recursive: true, force: true });
});
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
const CHECK_SCRIPT_V1 = 'console.log("check-ok");\n';
/**
 * 建一个带范围授权的最小工作区：受管根里有入口脚本、构建配置与被检查的源文件。
 * 检查入口是 node.exe，第一个位置参数是根内的脚本——这是最常见的检查形态。
 */
async function fixture(scriptText = CHECK_SCRIPT_V1) {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'relay-check-trust-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Relay\n', 'utf8');
    await writeFile(join(root, 'src', 'value.txt'), 'incorrect\n', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { check: 'node check.mjs' } }), 'utf8');
    const scriptPath = join(root, 'check.mjs');
    await writeFile(scriptPath, scriptText, 'utf8');
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'check-trust' });
        await repositories.workspaces.insertAuthorityRow(workspaceId);
        await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'check-trust',
            projectType: 'DEVELOPMENT' });
    });
    const { resourceId, canonicalRoot } = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
    const connectionId = await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.lockAuthority(workspaceId, 'update');
        const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
            workspaceId, projectId, config: { root_path: canonicalRoot } });
        for (const capability of ['FILE_QUERY', 'FILE_READ', 'FILE_WRITE',
            'CLI_RUN']) {
            await repositories.gateway.addConnectionCapability(connection.id, capability);
        }
        await repositories.workspaces.bumpAuthority(workspaceId);
        return connection.id;
    });
    for (const [capability, actionType] of [['FILE_QUERY', 'LIST_DIRECTORY'],
        ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT'], ['FILE_READ', 'READ_FILE'],
        ['FILE_WRITE', 'APPLY_CHANGESET'], ['FILE_WRITE', 'READ_CHANGE_SET'],
        ['CLI_RUN', 'CLI_RUN']]) {
        await createGatewayPolicy(app.db, { workspaceId, projectId, capability, actionType,
            targetPrefix: canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
    }
    const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
        title: '跑一次已配置检查', objective: '按冻结检查执行一次真实命令',
        expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
        criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
        mode: 'ME' });
    const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
        commandId: randomUUID(), expectedRevision: task.result.revision });
    const check = { id: 'check-1', executable: process.execPath,
        args: [scriptPath], max_output_bytes: 4096,
        executable_sha256: sha256(await readFile(process.execPath)) };
    const delegated = await delegateTask(app.db, { workspaceId, taskId: task.result.task_id,
        commandId: randomUUID(), expectedTaskRevision: ready.result.revision,
        toolLoopAction: { resource_id: resourceId,
            connections: { FILE_QUERY: connectionId, FILE_READ: connectionId,
                FILE_WRITE: connectionId, CLI_RUN: connectionId },
            allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
        scopeGrant: { resource_id: resourceId, allowed_actions: ['CLI_RUN'], checks: [check] } });
    return { workspaceId, projectId, runId: delegated.result.run_id, resourceId, canonicalRoot,
        scriptPath };
}
const CHECK_ROUND = [[{ name: 'run_check', arguments: { check_id: 'check-1' } }]];
/** 有界驱动：推进步骤与派发工具交替，直到 Run 离开工具循环。 */
async function drive(fx) {
    const storage = new ManagedContentStore(dataRoot);
    const statuses = [];
    for (let iteration = 0; iteration < 20; iteration += 1) {
        const advanced = await advanceRunStep(app.db, { runId: fx.runId,
            workerId: `trust-${randomUUID()}`, storage, fakeToolScript: CHECK_ROUND });
        statuses.push(advanced.status);
        if (advanced.status === 'STEP_SUCCEEDED' || advanced.status === 'RETRYABLE' ||
            advanced.status === 'REPLAYED')
            continue;
        if (advanced.status !== 'TOOL_LOOP_ACTION_REQUIRED')
            return { statuses, toolCallId: null };
        const dispatched = await executeToolLoopStep(app.db, { claim: { commandId: randomUUID(),
                runId: fx.runId, workspaceId: fx.workspaceId, kind: 'START', reviewDecisionId: null,
                workerId: `trust-${randomUUID()}`, epoch: 0n }, toolCallId: advanced.tool_call_id });
        statuses.push(`TOOL_${dispatched.status}`);
        return { statuses, toolCallId: dispatched.toolCallId };
    }
    throw new Error('推进超过步数上限');
}
async function frozenChecks(runId) {
    const grant = await withTransaction(app.db, (repositories) => repositories.scopeGrants.readByRun(runId));
    assert.ok(grant !== undefined, '授权行必须存在');
    return grant.checks;
}
test('冻结期把入口脚本与根内构建配置算成信任依据并随授权落库', async () => {
    const fx = await fixture();
    const checks = await frozenChecks(fx.runId);
    assert.equal(checks.length, 1);
    const basis = checks[0].trust_basis;
    assert.ok(basis !== undefined, '冻结检查必须带信任依据');
    assert.equal(basis.version, 'check-trust-v1');
    const roles = new Map(basis.materials.map((material) => [material.role, material.path]));
    assert.ok(roles.has('EXECUTABLE'), '入口程序必须计入材料');
    assert.equal(roles.get('REFERENCED_SCRIPT'), fx.scriptPath.toLowerCase(), '第一个位置脚本参数是真正被执行的检查程序，必须计入材料');
    assert.ok([...roles.keys()].includes('BUILD_CONFIG'), '根内构建/测试配置必须计入材料');
    // 被检查的源文件不是材料。
    assert.ok(!basis.materials.some((material) => material.path.includes('value.txt')), '被检查的源文件不得计入执行材料');
});
test('同一 check_id 在入口脚本正文被改后不再自动放行，退回人工并带类型化原因', async () => {
    const fx = await fixture();
    // 同路径、同命令名，只把正文改成固定成功。
    await writeFile(fx.scriptPath, 'console.log("always ok");\nprocess.exit(0);\n', 'utf8');
    const driven = await drive(fx);
    assert.ok(driven.statuses.includes('TOOL_WAITING'), `入口脚本被改后不得自动执行：${JSON.stringify(driven.statuses)}`);
    assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得沿用旧信任直接放行');
    const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
    const row = rows[0];
    assert.ok(row?.operation_id != null, '退回人工时动作身份仍然保留');
    const review = await withTransaction(app.db, (repositories) => repositories.reviews.readByOperationId(row.operation_id));
    assert.ok(review !== undefined, '退回人工必须产生一条待批准 Review');
    assert.equal(review.evidence.scope_decision_reason, 'SCOPE_GRANT_CHECK_CHANGED', '前端必须能区分「检查材料变了」和「策略本来就要人工」');
});
test('只改被检查的源文件不使原信任失效，检查仍按原授权自动执行', async () => {
    const fx = await fixture();
    // src/value.txt 是这次检查要看的输入，不是检查程序；改它不能把原授权判失效。
    await writeFile(join(fx.canonicalRoot, 'src', 'value.txt'), 'still incorrect\n', 'utf8');
    const driven = await drive(fx);
    assert.ok(driven.statuses.includes('TOOL_SUCCEEDED'), `只改被检查输入不得阻断检查：${JSON.stringify(driven.statuses)}`);
    const rows = await new RunToolCallRepository(app.db).listByRun(fx.runId);
    assert.equal(rows[0]?.status, 'SETTLED');
});
test('内联求值参数在冻结期被拒，不落一份没有依据的授权', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-check-dynamic-'));
    roots.push(root);
    await writeFile(join(root, 'check.mjs'), 'console.log("x");\n', 'utf8');
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'dynamic' });
        await repositories.workspaces.insertAuthorityRow(workspaceId);
        await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'dynamic',
            projectType: 'DEVELOPMENT' });
    });
    const { resourceId, canonicalRoot } = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
    const connectionId = await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.lockAuthority(workspaceId, 'update');
        const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
            workspaceId, projectId, config: { root_path: canonicalRoot } });
        for (const capability of ['FILE_WRITE', 'CLI_RUN']) {
            await repositories.gateway.addConnectionCapability(connection.id, capability);
        }
        await repositories.workspaces.bumpAuthority(workspaceId);
        return connection.id;
    });
    const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
        title: '动态检查', objective: '不应被接受',
        expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
        criteria: [{ criterionId: 'c1', statement: '检查实际执行过', required: true, method: 'HUMAN' }],
        mode: 'ME' });
    const ready = await markTaskReady(app.db, { workspaceId, taskId: task.result.task_id,
        commandId: randomUUID(), expectedRevision: task.result.revision });
    const check = { id: 'check-1', executable: process.execPath,
        args: ['-e', 'process.exit(0)'], executable_sha256: sha256(await readFile(process.execPath)) };
    await assert.rejects(delegateTask(app.db, { workspaceId, taskId: task.result.task_id, commandId: randomUUID(),
        expectedTaskRevision: ready.result.revision,
        toolLoopAction: { resource_id: resourceId,
            connections: { FILE_WRITE: connectionId, CLI_RUN: connectionId },
            allowed_tools: ['run_check'], max_rounds: 6, max_tool_calls: 8 },
        scopeGrant: { resource_id: resourceId, allowed_actions: ['CLI_RUN'], checks: [check] } }), (error) => String(error.message)
        .includes('CHECK_TRUST_DYNAMIC_EXECUTION_UNSUPPORTED'), '内联求值无法证明执行范围，必须在冻结期明确拒绝');
    const remaining = await sql `select count(*)::text as count from run_scope_grants
    where project_id = ${projectId}`.execute(migrator.db);
    assert.equal(remaining.rows[0]?.count, '0', '冻结期被拒的检查不得留下任何授权行');
});
test('历史授权行只有入口摘要、没有材料依据时不自动放行', async () => {
    const fx = await fixture();
    // 模拟升级前的历史行：把信任依据从已落库的授权里去掉，入口摘要保持不变。
    const checks = await frozenChecks(fx.runId);
    const historical = checks.map((check) => {
        const { trust_basis: _dropped, ...rest } = check;
        return rest;
    });
    await sql `update run_scope_grants set checks = ${JSON.stringify(historical)}::jsonb
    where run_id = ${fx.runId}`.execute(migrator.db);
    const driven = await drive(fx);
    assert.ok(driven.statuses.includes('TOOL_WAITING'), `缺材料依据的历史行必须退回人工确认：${JSON.stringify(driven.statuses)}`);
    assert.ok(!driven.statuses.includes('TOOL_SUCCEEDED'), '不得把「没有依据」当成「摘要相同」');
});
test('同一组冻结材料重复核对得到同一摘要（重放不产生新的批准要求）', async () => {
    const fx = await fixture();
    const before = await frozenChecks(fx.runId);
    const repository = new RunScopeGrantRepository(app.db);
    const grant = await withTransaction(app.db, (repositories) => repositories.scopeGrants.readByRun(fx.runId));
    assert.ok(grant !== undefined);
    const again = await repository.readByRun(fx.runId);
    assert.deepEqual(again?.checks, grant.checks);
    assert.equal((again?.checks)[0].trust_basis?.digest, before[0].trust_basis?.digest, '未改动时同一份授权必须读出同一摘要');
});
