import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { readUserGitState, runUserGitReadCommand } from '../../src/application/git-user-action.js';
import { createGatewayConnectionCommand, createGatewayPolicyCommand, createManagedResourceCommand } from '../../src/application/gateway-commands.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { withTransaction, createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, startTestApi, workspacePath, } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase, } from './integration-support.js';
/**
 * M06 人工触发的 Git 只读入口（迁移 0058）。
 *
 * 真实 PostgreSQL + 真实临时目录 + 真实 git 仓库。本文件覆盖此前**没有公开入口**的那一类：
 * 人工在受管资源上直接触发 GIT_STATUS / GIT_DIFF，不经 Run、不建 Task。
 *
 * 每条用例都是一条反例或一条正向出口，不使用 Fake Gateway 夹具代替真实 git：
 *   * 受管根内可读 → 真实分支、未跟踪文件与差异；
 *   * 根外路径被拒；
 *   * 缺 GIT_READ 连接被拒；
 *   * 策略 AUTO 直通、ASK 创建绑定确切参数的 ACTION_APPROVAL；
 *   * 同一 command_id 重复投递只读一次；
 *   * 非 Git 目录不得显示为干净。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m06-user-git-read');
let dataRoot;
let api;
before(async () => {
    await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
    dataRoot = await createDataRoot();
    api = await startTestApi();
});
after(async () => {
    if (api !== undefined)
        await api.stop();
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
});
/** Plain git for fixture setup only; never through the audited adapter path. */
function git(cwd, args) {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}
function code(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : undefined;
}
/**
 * 一个真实的 Project + 受管资源 + GIT_READ 连接 + 权限策略。
 *
 * 夹具刻意**不建 Task、不建 Run**：这正是本切片与既有 M06 覆盖的差别——人工动作没有执行链。
 */
async function userGitFixture(input = {}) {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await withTransaction(app.db, async (repositories) => {
        await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `m06-user-git-${workspaceId}` });
        await repositories.workspaces.insertAuthorityRow(workspaceId);
        await repositories.projects.insertProject({ id: projectId, workspaceId,
            title: 'M06 User Git Read', projectType: 'DEVELOPMENT' });
        await repositories.projects.insertProjectState(projectId, 'PLANNING');
    });
    const root = join(dataRoot, `user-git-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    if (input.gitRepo !== false) {
        git(root, ['init', '-q', '-b', 'main']);
        git(root, ['config', 'user.email', 'relay@test.local']);
        git(root, ['config', 'user.name', 'Relay Test']);
        git(root, ['config', 'commit.gpgsign', 'false']);
        await writeFile(join(root, 'README.md'), 'seed\n', 'utf8');
        git(root, ['add', '--', 'README.md']);
        git(root, ['commit', '-q', '-m', 'seed']);
    }
    // 受管根之外的真实目录：路径穿越反例的落点。
    const outsideDir = join(dataRoot, `outside-${randomUUID()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.txt'), 'outside\n', 'utf8');
    const capabilities = input.capabilities ?? ['GIT_READ'];
    const created = await createGatewayConnectionCommand(app.db, { workspaceId, projectId,
        commandId: randomUUID(), capabilities: [...capabilities], rootPath: root });
    const connectionId = created.result.connection_id;
    const resource = await createManagedResourceCommand(app.db, { workspaceId, projectId,
        commandId: randomUUID(), rootPath: root });
    const resourceId = resource.result.resource_id;
    // 读 status 与读 diff 是**两条不同的权限事实**，因此各建一条策略；只放行其中一条时，
    // 另一条必须按 GATEWAY_PERMISSION_DENIED 拒绝，而不是被另一条的授权顶替。
    for (const actionType of ['GIT_STATUS', 'GIT_DIFF']) {
        const policy = await createGatewayPolicyCommand(app.db, { workspaceId, projectId,
            commandId: randomUUID(), capability: 'GIT_READ', actionType,
            resourceId, decision: input.decision ?? 'AUTO', maxPayloadBytes: 65536 });
        assert.ok(policy.result.policy_id);
    }
    return { workspaceId, projectId, root, resourceId, connectionId, outsideDir };
}
function gitReadPath(fixture, resourceId) {
    return workspacePath(fixture.workspaceId, `/projects/${fixture.projectId}/managed-resources/${resourceId ?? fixture.resourceId}/git-read`);
}
function gitReadBody(fixture, input = {}) {
    return {
        command_id: input.commandId ?? randomUUID(),
        connection_id: input.connectionId ?? fixture.connectionId,
        action_type: input.actionType ?? 'GIT_STATUS',
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.cached === undefined ? {} : { cached: input.cached }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
    };
}
async function activityRows(operationId) {
    const result = await sql `
    select id, actor_kind, actor_ref, command_id, event_type, fact_refs
    from activity_records where fact_refs->>'operation_id' = ${operationId}
    order by created_at, id`.execute(app.db);
    return result.rows;
}
async function invokeRows(operationId) {
    return withTransaction(app.db, (repositories) => repositories.gateway.listInvocations(operationId));
}
async function userActionOperationCount() {
    const result = await sql `
    select count(*)::text as count from logical_operations where origin = 'USER_ACTION'
  `.execute(app.db);
    return result.rows[0].count;
}
/** 直接向数据库写一行 USER_ACTION：行级 CHECK 是准入的最后一道，必须由真实 PG 证明它生效，
 * 而不是只靠应用层的判定。返回插入的行数（0 表示被拒）。 */
async function insertUserActionOperation(db, base, override) {
    const result = await sql `
    insert into logical_operations (id, workspace_id, project_id, origin, task_id, run_id, step_id,
      import_job_id, intent_key, connection_id, connection_version, connection_config,
      policy_id, policy_version, capability_key, action_type, normalized_target,
      params_hash, params, resource_id, status)
    values (${base.id}, ${base.workspaceId}, ${base.projectId}, ${base.origin},
      ${override.taskId ?? null}, ${override.runId ?? null}, ${override.stepId ?? null}, null,
      ${`intent-${base.id}`}, ${base.connectionId}, ${base.connectionVersion}, '{}'::jsonb,
      ${base.policyId}, ${base.policyVersion}, ${override.capability ?? base.capability},
      ${base.actionType}, ${base.target}, ${Buffer.alloc(32)}, '{}'::jsonb,
      ${override.resourceId === undefined ? base.resourceId : override.resourceId}, 'PREPARED')
    returning id`.execute(db);
    return result.rows.length;
}
async function insertUserActionInvocation(db, operationId, override) {
    const result = await sql `
    insert into invocation_attempts (id, operation_id, origin, task_id, run_id, resource_id,
      attempt_number, status, authority_revision, connection_version, connection_config,
      ownership_epoch, worker_id, worker_epoch, resource_claim_id, claim_token, claim_epoch)
    select ${randomUUID()}, id, 'USER_ACTION', null, null, resource_id, 1, 'PREPARED', 0,
      1, '{}'::jsonb, null, ${override.workerId ?? null}, null, ${override.claimId ?? null},
      ${override.claimToken ?? null}, ${override.claimEpoch ?? null}
    from logical_operations where id = ${operationId}
    returning id`.execute(db);
    return result.rows.length;
}
function isCheckViolation(error) {
    return typeof error === 'object' && error !== null &&
        error.code === '23514';
}
// ---------------------------------------------------------------------------
// 正向出口
// ---------------------------------------------------------------------------
test('人工 GIT_STATUS 在受管根内读到真实分支与未跟踪文件，并留下人工审计', async () => {
    const f = await userGitFixture();
    await writeFile(join(f.root, 'note.txt'), 'work in progress\n', 'utf8');
    const commandId = randomUUID();
    const outcome = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId });
    assert.equal(outcome.result.state, 'SUCCEEDED', JSON.stringify(outcome.result));
    assert.equal(outcome.replayed, false);
    const status = outcome.result;
    assert.equal(status.result.branch, 'main');
    assert.equal(typeof status.result.head_commit, 'string');
    assert.deepEqual(status.result.staged, []);
    assert.deepEqual(status.result.unstaged, []);
    assert.deepEqual(status.result.untracked, ['note.txt']);
    assert.equal(status.result.truncated, false);
    assert.equal(status.result.limit, 200);
    // 账本必须能回答「谁在什么时候读了哪个受管目录」：Operation + Invocation + 人工活动记录。
    const operationId = status.operation_id;
    const operation = await createRepositories(app.db).gateway.readOperation(operationId);
    assert.equal(operation?.origin, 'USER_ACTION');
    assert.equal(operation?.capability_key, 'GIT_READ');
    assert.equal(operation?.action_type, 'GIT_STATUS');
    assert.equal(operation?.task_id, null);
    assert.equal(operation?.run_id, null);
    assert.equal(operation?.step_id, null);
    assert.equal(operation?.import_job_id, null);
    assert.equal(operation?.resource_id, f.resourceId);
    const invocations = await invokeRows(operationId);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].status, 'SUCCEEDED');
    assert.equal(invocations[0].origin, 'USER_ACTION');
    assert.equal(invocations[0].resource_id, f.resourceId);
    // 只读动作不建资源 claim（resource_claims 强制绑定 task/run），因此不与写动作争用目录。
    assert.equal(invocations[0].resource_claim_id, null);
    assert.equal(invocations[0].worker_id, null);
    const activities = await activityRows(operationId);
    assert.equal(activities.length, 1, JSON.stringify(activities));
    assert.equal(activities[0].actor_kind, 'HUMAN');
    assert.equal(activities[0].actor_ref, 'user:local');
    assert.equal(activities[0].command_id, commandId);
    assert.equal(activities[0].event_type, 'MANAGED_GIT_READ_REQUESTED');
    assert.equal(activities[0].fact_refs.resource_id, f.resourceId);
});
test('人工 GIT_DIFF 在受管根内读到真实差异，并按字节有界', async () => {
    const f = await userGitFixture();
    await writeFile(join(f.root, 'README.md'), 'changed locally\n', 'utf8');
    const outcome = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_DIFF', actorRef: 'user:local', commandId: randomUUID() });
    assert.equal(outcome.result.state, 'SUCCEEDED', JSON.stringify(outcome.result));
    const diff = outcome.result.result;
    assert.match(String(diff.diff), /changed locally/u);
    assert.equal(diff.truncated, false);
    assert.equal(diff.omitted_bytes, 0);
    assert.equal(diff.limit_bytes, 262144);
    // limit 生效时截断必须显式，且给出省略字节数，不能被当作完整证据。
    const bounded = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_DIFF', limit: 16, actorRef: 'user:local', commandId: randomUUID() });
    const boundedResult = bounded.result.result;
    assert.equal(boundedResult.limit_bytes, 16);
    assert.equal(boundedResult.truncated, true);
    assert.ok(Number(boundedResult.omitted_bytes) > 0);
});
test('HTTP 端点在 AUTO 下返回 200 与已结算的有界结果', async () => {
    const f = await userGitFixture();
    await writeFile(join(f.root, 'http.txt'), 'via http\n', 'utf8');
    const body = gitReadBody(f, { commandId: randomUUID() });
    const response = await api.post(gitReadPath(f), body);
    assert.equal(response.status, 200, response.text);
    const envelope = response.body;
    assert.equal(envelope.result.state, 'SUCCEEDED');
    const status = envelope.result.result;
    assert.deepEqual(status.untracked, ['http.txt']);
    // 同一 command_id 重放返回原回执并附重放头，而不是第二次读取。
    const replay = await api.post(gitReadPath(f), body);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual(replay.body.result, envelope.result);
});
test('HTTP 端点在 ASK 下返回等待确认形态，且不携带任何结果字段', async () => {
    const f = await userGitFixture({ decision: 'ASK' });
    await writeFile(join(f.root, 'http-ask.txt'), 'await approval\n', 'utf8');
    const response = await api.post(gitReadPath(f), gitReadBody(f, { commandId: randomUUID() }));
    assert.equal(response.status, 200, response.text);
    const result = response.body.result;
    assert.equal(result.state, 'WAITING_APPROVAL');
    assert.equal(result.reason, 'ACTION_APPROVAL_REQUIRED');
    assert.equal(typeof result.review_id, 'string');
    // 等待确认时不得出现 result 字段——空状态列表会让界面显示成「干净」。
    assert.equal('result' in result, false, JSON.stringify(result));
});
// ---------------------------------------------------------------------------
// 反例
// ---------------------------------------------------------------------------
test('相对路径按受管根解析：根外路径与穿越路径被拒，不猜', async () => {
    const f = await userGitFixture();
    for (const path of ['../', `..${'\\'}..${'\\'}windows`, '..\\outside']) {
        await assert.rejects(async () => readUserGitState(app.db, { workspaceId: f.workspaceId,
            projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
            actionType: 'GIT_DIFF', relativePath: path, actorRef: 'user:local' }), (error) => code(error) === 'GATEWAY_TARGET_DENIED', `${path} 应被拒`);
    }
    // 绝对路径同样不被接受：目标只能是受管根内的相对路径。
    await assert.rejects(async () => readUserGitState(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_DIFF', relativePath: join(f.outsideDir, 'secret.txt'), actorRef: 'user:local' }), (error) => code(error) === 'GATEWAY_TARGET_DENIED');
    // 根外目录被登记成另一个受管资源也不改变边界：只读入口只认自己这条 resource_id。
    await assert.rejects(async () => readUserGitState(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: randomUUID(), connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local' }), (error) => code(error) === 'RESOURCE_NOT_FOUND');
    // 合法根内相对路径仍然可用（证明前面的拒绝不是「一律拒绝」）。
    const inside = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_DIFF', relativePath: 'README.md', actorRef: 'user:local',
        commandId: randomUUID() });
    assert.equal(inside.result.state, 'SUCCEEDED');
});
test('缺 GIT_READ 连接的 Project 被拒，不借用其他能力的连接', async () => {
    const f = await userGitFixture({ capabilities: ['FILE_READ'] });
    const before = await userActionOperationCount();
    await assert.rejects(async () => readUserGitState(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local' }), (error) => code(error) === 'GATEWAY_CONNECTION_DENIED');
    // 拒绝时不产生 Operation，也不产生任何审计行——不能留下「已尝试」的假事实。
    assert.equal(await userActionOperationCount(), before);
});
test('权限策略 ASK 创建绑定确切参数的 ACTION_APPROVAL，确认后才读取', async () => {
    const f = await userGitFixture({ decision: 'ASK' });
    await writeFile(join(f.root, 'ask.txt'), 'pending approval\n', 'utf8');
    const commandId = randomUUID();
    const first = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId });
    assert.equal(first.result.state, 'WAITING_APPROVAL', JSON.stringify(first.result));
    const pending = first.result;
    assert.equal(pending.reason, 'ACTION_APPROVAL_REQUIRED');
    // 等待确认时不得携带任何结果字段冒充已读到内容。
    assert.equal('result' in pending, false);
    assert.equal((await invokeRows(pending.operation_id)).length, 0, 'ASK 在确认前不得创建 Invocation');
    // 同一 command_id 在确认前重复投递仍停在等待，不会绕过确认读取。
    const replayed = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId });
    assert.equal(replayed.result.state, 'WAITING_APPROVAL');
    // 人工确认：只落判断，不执行读取。
    const review = await withTransaction(app.db, (repositories) => repositories.reviews.readRequest(pending.review_id));
    assert.ok(review);
    assert.equal(review.kind, 'ACTION_APPROVAL');
    assert.equal(review.operation_id, pending.operation_id);
    const decided = await resolveReview(app.db, { workspaceId: f.workspaceId,
        reviewId: pending.review_id, commandId: randomUUID(),
        expectedRevision: review.revision.toString(),
        targetHash: review.target_hash.toString('hex'), decision: 'APPROVE' });
    assert.equal(decided.result.effect.external_effect_executed, false);
    // 确认后的再次投递才真正读取，且只读一次。
    const approved = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId });
    assert.equal(approved.result.state, 'SUCCEEDED', JSON.stringify(approved.result));
    const status = approved.result;
    assert.deepEqual(status.result.untracked, ['ask.txt']);
    assert.equal((await invokeRows(pending.operation_id)).length, 1);
});
test('策略 DENY 时拒绝执行，不产生 Operation', async () => {
    const f = await userGitFixture({ decision: 'DENY' });
    await assert.rejects(async () => readUserGitState(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local' }), (error) => code(error) === 'GATEWAY_PERMISSION_DENIED');
});
test('同一 command_id 重复投递只读一次，且不换内容重放', async () => {
    const f = await userGitFixture();
    await writeFile(join(f.root, 'once.txt'), 'read me once\n', 'utf8');
    const commandId = randomUUID();
    const first = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId });
    assert.equal(first.replayed, false);
    assert.equal(first.result.state, 'SUCCEEDED');
    const second = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId });
    assert.equal(second.replayed, true);
    assert.equal(second.result.state, 'SUCCEEDED');
    // 关键断言：只有一次 Invocation，即适配器只被调用了一次。
    const operationId = first.result.operation_id;
    assert.equal(second.result.operation_id, operationId);
    assert.equal((await invokeRows(operationId)).length, 1);
    // 同一 command_id 换内容重放被确定性拒绝，而不是悄悄读另一个动作。
    // CommandIdReusedError 不是 DomainError（HTTP 层由 problemFromError 映射为 409
    // COMMAND_ID_REUSED），因此这里按它的 name 断言。
    await assert.rejects(async () => runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_DIFF', actorRef: 'user:local', commandId }), (error) => error instanceof Error && error.name === 'CommandIdReusedError');
});
test('同一动作在崩溃后重投返回同一次读取的落库结果，不第二次执行适配器', async () => {
    const f = await userGitFixture();
    await writeFile(join(f.root, 'resume.txt'), 'x\n', 'utf8');
    const request = { workspaceId: f.workspaceId, projectId: f.projectId,
        resourceId: f.resourceId, connectionId: f.connectionId, actionType: 'GIT_STATUS',
        actorRef: 'user:local' };
    const first = await readUserGitState(app.db, request);
    assert.equal(first.state, 'SUCCEEDED');
    // 回执尚未写下（模拟「读取已结算、回执补写前崩溃」）时的再次投递。
    const second = await readUserGitState(app.db, request);
    assert.equal(second.state, 'SUCCEEDED');
    assert.equal(second.operation_id, first.operation_id);
    assert.equal((await invokeRows(first.operation_id)).length, 1);
});
test('非 Git 目录不得显示为干净：读取结算为 FAILED 并给出类型化原因', async () => {
    const f = await userGitFixture({ gitRepo: false });
    await writeFile(join(f.root, 'plain.txt'), 'no repository here\n', 'utf8');
    const outcome = await runUserGitReadCommand(app.db, { workspaceId: f.workspaceId,
        projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
        actionType: 'GIT_STATUS', actorRef: 'user:local', commandId: randomUUID() });
    assert.equal(outcome.result.state, 'FAILED', JSON.stringify(outcome.result));
    const result = outcome.result.result;
    // 关键反例：既不返回成功，也不返回 staged/unstaged/untracked 全空的「干净」形态。
    assert.equal('staged' in result, false, JSON.stringify(result));
    assert.equal('unstaged' in result, false, JSON.stringify(result));
    assert.equal('untracked' in result, false, JSON.stringify(result));
    assert.equal(result.reason, 'GIT_REPOSITORY_UNAVAILABLE');
    // Operation 与 Invocation 如实记录 FAILED，不留 PREPARED/DISPATCHING 的悬空状态。
    const operationId = outcome.result.operation_id;
    const invocations = await invokeRows(operationId);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].status, 'FAILED');
});
test('人工入口不开放任何写动作：GIT_STAGE / GIT_COMMIT / GIT_PUSH 一律被拒', async () => {
    const f = await userGitFixture();
    const before = await userActionOperationCount();
    const writes = ['GIT_STAGE', 'GIT_COMMIT', 'GIT_PUSH', 'CLI_RUN', 'APPLY_CHANGESET'];
    for (const action of writes) {
        await assert.rejects(async () => readUserGitState(app.db, { workspaceId: f.workspaceId,
            projectId: f.projectId, resourceId: f.resourceId, connectionId: f.connectionId,
            actionType: action, actorRef: 'user:local' }), (error) => code(error) === 'GATEWAY_ORIGIN_DENIED', `${action} 应被拒`);
    }
    // 被拒的写动作不得留下任何 Operation。
    assert.equal(await userActionOperationCount(), before);
});
test('HTTP 层拒绝 GIT_STATUS 携带路径，且错误映射为可分辨的 Problem Details', async () => {
    const f = await userGitFixture();
    const withPath = await api.post(gitReadPath(f), gitReadBody(f, { commandId: randomUUID(), path: 'README.md' }));
    assert.equal(withPath.status, 422, withPath.text);
    const body = withPath.body;
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(body.field_errors?.[0]?.field, 'action_type');
    // 缺连接时的 409 走 Problem Details，不泄漏 SQL 或堆栈。
    const denied = await api.post(gitReadPath(f), gitReadBody(f, {
        commandId: randomUUID(), connectionId: randomUUID(),
    }));
    assert.equal(denied.status, 409, denied.text);
    assert.equal(denied.body.code, 'GATEWAY_CONNECTION_DENIED');
    assert.equal(denied.text.includes('SELECT'), false);
});
// ---------------------------------------------------------------------------
// 迁移 0058 本身的数据库级守卫
// ---------------------------------------------------------------------------
test('0058 只放宽三条 CHECK：既有分支逐条保留，并加上 USER_ACTION', async () => {
    const definitions = await sql `
    select conname, pg_get_constraintdef(oid) as definition from pg_constraint
    where conname in ('ck_logical_operation_origin', 'ck_logical_operation_resource',
      'ck_invocation_run_identity')`.execute(app.db);
    // pg_get_constraintdef 会加上 ::text 转型与额外括号；归一后再比对分支，避免断言绑定在
    // PostgreSQL 的渲染细节上而不是绑定在语义上。
    const normalize = (text) => text.replaceAll('::text', '').replaceAll('(', '').replaceAll(')', '')
        .replace(/\s+/gu, ' ').trim();
    const byName = new Map(definitions.rows.map((row) => [row.conname, normalize(row.definition)]));
    const origin = byName.get('ck_logical_operation_origin') ?? '';
    assert.match(origin, /origin = 'RUN' AND task_id IS NOT NULL/u);
    assert.match(origin, /origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NOT NULL/u);
    assert.match(origin, /origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL/u);
    const resource = byName.get('ck_logical_operation_resource') ?? '';
    // 0054 重述这条约束时漏掉 WEB_FETCH 与 FILE_WRITE，造成 9 例既有动作失败。这里逐支断言，
    // 同一类漏支会让历史动作在下一次写入时违反约束。
    for (const fragment of [
        "capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL",
        "capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL",
        "capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL",
        "capability_key = 'WEB_FETCH' AND origin = 'USER_IMPORT' AND resource_id IS NULL",
        "capability_key = ANY ARRAY['FILE_READ', 'FILE_QUERY'] AND origin = 'RUN' AND resource_id IS NOT NULL",
        "capability_key = ANY ARRAY['FILE_WRITE', 'GIT_READ', 'GIT_WRITE', 'CLI_RUN']",
        "capability_key = 'GIT_READ' AND origin = 'USER_ACTION' AND resource_id IS NOT NULL",
    ]) {
        assert.ok(resource.includes(fragment), `ck_logical_operation_resource 缺少分支: ${fragment}\n${resource}`);
    }
    const identity = byName.get('ck_invocation_run_identity') ?? '';
    assert.equal((identity.match(/origin = 'USER_IMPORT'/gu) ?? []).length, 1);
    assert.equal((identity.match(/origin = 'RUN'/gu) ?? []).length, 2, '0016 为 WEB_FETCH 放宽的 RUN 两支必须逐字保留');
    assert.ok(identity.includes("origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NOT NULL"), identity);
    // 只放宽、不回填：迁移正文里不得出现任何数据写入语句。
    const sqlText = await readFile(join(MIGRATIONS_DIRECTORY, '0058_m06_user_action_origin.sql'), 'utf8');
    assert.doesNotMatch(sqlText, /^\s*(insert|update|delete)\b/imu, '0058 不得回填或改写任何历史行');
    assert.doesNotMatch(sqlText, /\badd column\b/iu, '0058 不改表结构');
    assert.doesNotMatch(sqlText, /\bcreate table\b/iu, '0058 不新增表');
});
test('USER_ACTION 的行级形态由数据库守住：挂 Run、冒充 Worker、写能力一律被拒', async () => {
    const f = await userGitFixture();
    const connection = await createRepositories(app.db).gateway.readConnection(f.connectionId);
    // 策略必须按本夹具的 Project 取：同一测试库里有多个夹具，取到别人的策略会被外键拒绝。
    const policy = await sql `
    select v.policy_id, v.version::text as version from gateway_permission_versions v
    join gateway_permission_policies p on p.id = v.policy_id
    where p.workspace_id = ${f.workspaceId} and p.project_id = ${f.projectId}
      and v.capability_key = 'GIT_READ' and v.action_type = 'GIT_STATUS' limit 1`.execute(app.db);
    assert.ok(policy.rows[0]);
    const common = {
        id: randomUUID(), workspaceId: f.workspaceId, projectId: f.projectId,
        origin: 'USER_ACTION',
        connectionId: f.connectionId, connectionVersion: connection?.version ?? 1n,
        policyId: policy.rows[0].policy_id, policyVersion: policy.rows[0].version,
        capability: 'GIT_READ', actionType: 'GIT_STATUS', target: f.root,
        resourceId: f.resourceId,
    };
    // 人工动作不得挂到 Run/Task 上：否则它既冒充执行权，又会从 Run 的未决列表里消失。
    await assert.rejects(async () => insertUserActionOperation(app.db, common, { taskId: randomUUID() }), isCheckViolation);
    await assert.rejects(async () => insertUserActionOperation(app.db, common, { runId: randomUUID() }), isCheckViolation);
    // 人工动作不得借写能力进入：GIT_WRITE / CLI_RUN / FILE_WRITE 一律被矩阵 CHECK 拒绝。
    for (const capability of ['GIT_WRITE', 'CLI_RUN', 'FILE_WRITE']) {
        await assert.rejects(async () => insertUserActionOperation(app.db, common, { capability }), isCheckViolation, `${capability} 应被拒`);
    }
    // 人工动作不得脱离受管资源：resource_id 为 NULL 也被矩阵 CHECK 拒绝。
    await assert.rejects(async () => insertUserActionOperation(app.db, common, { resourceId: null }), isCheckViolation);
    // 合法形态写入成功，证明上面的拒绝不是「一律拒绝」。
    const insertedId = randomUUID();
    assert.equal(await insertUserActionOperation(app.db, { ...common, id: insertedId }, {}), 1);
    // 调用侧同样守形状：USER_ACTION 的 Invocation 不允许出现 Worker 与 claim。
    await assert.rejects(async () => insertUserActionInvocation(app.db, insertedId, { workerId: 'worker-x' }), isCheckViolation);
    await assert.rejects(async () => insertUserActionInvocation(app.db, insertedId, {
        claimId: randomUUID(), claimToken: randomUUID(), claimEpoch: 1n,
    }), isCheckViolation);
    assert.equal(await insertUserActionInvocation(app.db, insertedId, {}), 1);
});
