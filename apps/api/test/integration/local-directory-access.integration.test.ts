import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { promisify } from 'node:util';

import { startTestApi, workspacePath } from './api-harness.js';
import { canonicalResourceIdentity, createGatewayPolicy } from '../../src/application/gateway-configuration.js';
import { disableGatewayConnectionCommand, revokeGatewayPolicyCommand } from
  '../../src/application/gateway-commands.js';
import { setLocalDirectoryWriteTier } from '../../src/application/local-directory-access.js';
import { runUserGitReadCommand } from '../../src/application/git-user-action.js';
import { gitGetLog } from '../../src/git/git-adapter.js';
import { openWorkingDirectory, readWorkingDirectoryWriteReadiness } from
  '../../src/application/open-working-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase, APP_DATABASE_URL } from
  './integration-support.js';

const execFileAsync = promisify(execFile);
const app = openDatabase(APP_DATABASE_URL, 'relay-local-directory-access');
const roots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => {
  await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-local-access-'));
  roots.push(root);
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'local-directory-access' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'Local directory access', projectType: 'DEVELOPMENT' });
  });
  return { workspaceId, projectId, root };
}

test('LA-01/02/06/07: HTTP directory selection creates read-only access once; tier updates are atomic and replayable', async () => {
  const api = await startTestApi();
  try {
    const f = await fixture();
    const path = (suffix: string) => workspacePath(f.workspaceId, suffix);
    assert.equal((await createRepositories(app.db).gateway.listConnections(f.workspaceId, f.projectId)).length, 0);
    const opened = await api.post(path('/working-directories/open'), {
      command_id: randomUUID(), root_path: f.root, project_id: f.projectId });
    assert.equal(opened.status, 200, opened.text);
    const association = (opened.body as { result: { association: { project_id: string; resource_id: string };
      write_readiness: { status: string; write_tier: string; access_revision: string } } }).result;
    const { resource_id: resourceId } = association.association;
    assert.equal(association.write_readiness.status, 'READ_ONLY');
    assert.equal(association.write_readiness.write_tier, 'READ_ONLY');
    assert.equal(association.write_readiness.access_revision, '0');

    const repositories = createRepositories(app.db);
    const access = await repositories.gateway.readLocalDirectoryAccess(resourceId);
    assert.ok(access);
    assert.equal(access.write_connection_id, null, 'default read-only selection does not create FILE_WRITE capability');
    const connections = await repositories.gateway.listConnections(f.workspaceId, f.projectId);
    assert.equal(connections.length, 1);
    assert.deepEqual(await repositories.gateway.listConnectionCapabilities(connections[0]!.id),
      ['FILE_QUERY', 'FILE_READ']);
    for (const [capability, actionType] of [['FILE_READ', 'READ_FILE'],
      ['FILE_QUERY', 'LIST_DIRECTORY'], ['FILE_QUERY', 'FIND_PATHS'], ['FILE_QUERY', 'SEARCH_TEXT']] as const) {
      const policies = await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId, capability, actionType);
      assert.ok(policies.some((policy) => policy.target_prefix === connections[0]!.config.root_path &&
        policy.decision === 'AUTO'), `${actionType} is authorized by the explicit directory selection`);
    }

    const readinessPath = path(`/projects/${f.projectId}/managed-resources/${resourceId}/write-readiness`);
    const askCommandId = randomUUID();
    const asked = await api.post(path(`/projects/${f.projectId}/managed-resources/${resourceId}/local-access`), {
      command_id: askCommandId, expected_revision: '0', write_tier: 'ASK' });
    assert.equal(asked.status, 200, asked.text);
    assert.equal((asked.body as { result: { write_tier: string; revision: string } }).result.write_tier, 'ASK');
    const askReadiness = await api.get(readinessPath);
    assert.equal((askReadiness.body as { policy_decision: string }).policy_decision, 'ASK');
    const writeAccess = await repositories.gateway.readLocalDirectoryAccess(resourceId);
    assert.ok(writeAccess?.write_connection_id);
    assert.equal((await repositories.gateway.listConnectionCapabilities(writeAccess.write_connection_id))
      .includes('FILE_WRITE'), true);
    assert.deepEqual(Object.keys(writeAccess.policy_ids).filter((action) =>
      ['WRITE_FILE', 'APPLY_CHANGESET', 'READ_CHANGE_SET'].includes(action)).sort(),
    ['APPLY_CHANGESET', 'READ_CHANGE_SET', 'WRITE_FILE']);

    const beforeReopen = await repositories.gateway.listConnections(f.workspaceId, f.projectId);
    const reopened = await api.post(path('/working-directories/open'), {
      command_id: randomUUID(), root_path: f.root });
    assert.equal(reopened.status, 200, reopened.text);
    const current = await api.get(readinessPath);
    assert.equal((current.body as { write_tier: string; policy_decision: string }).write_tier, 'ASK');
    assert.equal((current.body as { policy_decision: string }).policy_decision, 'ASK');
    assert.equal((await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length,
      beforeReopen.length, 'reopening a configured root reuses its source pointers and does not reset the tier');

    const readOnlyCommandId = randomUUID();
    const readonly = await api.post(path(`/projects/${f.projectId}/managed-resources/${resourceId}/local-access`), {
      command_id: readOnlyCommandId, expected_revision: '1', write_tier: 'READ_ONLY' });
    assert.equal(readonly.status, 200, readonly.text);
    const blocked = await api.get(readinessPath);
    assert.equal((blocked.body as { status: string }).status, 'READ_ONLY');
    for (const actionType of ['WRITE_FILE', 'APPLY_CHANGESET', 'READ_CHANGE_SET']) {
      const actionPolicies = await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
        'FILE_WRITE', actionType);
      assert.ok(actionPolicies.some((policy) => policy.target_prefix === connections[0]!.config.root_path &&
        policy.decision === 'DENY'), `${actionType} has an effective managed deny in read-only mode`);
    }

    const autoCommandId = randomUUID();
    const automatic = await api.post(path(`/projects/${f.projectId}/managed-resources/${resourceId}/local-access`), {
      command_id: autoCommandId, expected_revision: '2', write_tier: 'AUTO' });
    assert.equal(automatic.status, 200, automatic.text);
    const replay = await api.post(path(`/projects/${f.projectId}/managed-resources/${resourceId}/local-access`), {
      command_id: autoCommandId, expected_revision: '2', write_tier: 'AUTO' });
    assert.equal(replay.status, 200, replay.text);
    assert.equal((replay.body as { command_id: string }).command_id, autoCommandId);
    assert.equal((await api.get(readinessPath).then((response) => response.body) as { policy_decision: string })
      .policy_decision, 'AUTO');
  } finally {
    await api.stop();
  }
});

/**
 * LA-04/05/08 的档位词表部分：完全访问是一条可往返的目录档位。
 *
 * 删除是否免确认不在这里证明（那要跑真实准入，见 folder-first 的完全访问用例）；
 * 这一例锁的是「档位本身」——服务端接受 FULL、投影读回 FULL、策略行仍落 AUTO，
 * 因此权限事实与目录档位仍是同一个 Owner，没有第二套授权来源。
 */
test('LA-04/05/08: FULL is a real tier that stores an AUTO policy and round-trips by revision', async () => {
  const api = await startTestApi();
  try {
    const f = await fixture();
    const path = (suffix: string) => workspacePath(f.workspaceId, suffix);
    const opened = await api.post(path('/working-directories/open'), {
      command_id: randomUUID(), root_path: f.root, project_id: f.projectId });
    assert.equal(opened.status, 200, opened.text);
    const association = (opened.body as { result: { association: { resource_id: string };
      write_readiness: { access_revision: string } } }).result;
    const resourceId = association.association.resource_id;
    const localAccessPath = path(`/projects/${f.projectId}/managed-resources/${resourceId}/local-access`);
    const readinessPath = path(`/projects/${f.projectId}/managed-resources/${resourceId}/write-readiness`);

    const full = await api.post(localAccessPath, { command_id: randomUUID(),
      expected_revision: association.write_readiness.access_revision, write_tier: 'FULL' });
    assert.equal(full.status, 200, full.text);
    const fullResult = (full.body as { result: { write_tier: string; revision: string } }).result;
    assert.equal(fullResult.write_tier, 'FULL');
    const projection = await api.get(readinessPath)
      .then((response) => response.body) as { write_tier: string; policy_decision: string;
        status: string; detail: string; access_revision: string };
    assert.equal(projection.write_tier, 'FULL');
    assert.equal(projection.policy_decision, 'AUTO');
    assert.equal(projection.status, 'READY');
    assert.match(projection.detail, /完全访问/u);
    assert.equal(fullResult.revision, projection.access_revision);
    assert.notEqual(projection.access_revision, association.write_readiness.access_revision,
      '改档位仍走同一条带 expected_revision 的版本命令');

    const repositories = createRepositories(app.db);
    const writeConnectionId = (await repositories.gateway
      .readLocalDirectoryAccess(resourceId))?.write_connection_id;
    assert.ok(writeConnectionId, '完全访问同样需要本目录的 FILE_WRITE 连接');
    const writeConnection = (await repositories.gateway.listConnections(f.workspaceId, f.projectId))
      .find((row) => row.id === writeConnectionId);
    assert.ok(writeConnection);
    const policy = (await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
      'FILE_WRITE', 'APPLY_CHANGESET')).find((item) => item.target_prefix === writeConnection.config.root_path);
    assert.equal(policy?.decision, 'AUTO', 'FULL 复用 AUTO 策略行，不新造第四种判定');

    const rejected = await api.post(localAccessPath, { command_id: randomUUID(),
      expected_revision: projection.access_revision, write_tier: 'ALWAYS' });
    assert.equal(rejected.status, 422, rejected.text);

    const downgrade = await api.post(localAccessPath, { command_id: randomUUID(),
      expected_revision: projection.access_revision, write_tier: 'READ_ONLY' });
    assert.equal(downgrade.status, 200, downgrade.text);
    const downgraded = await api.get(readinessPath)
      .then((response) => response.body) as { write_tier: string; policy_decision: string; status: string };
    assert.equal(downgraded.status, 'READ_ONLY');
    assert.equal(downgraded.write_tier, 'READ_ONLY');
    assert.equal(downgraded.policy_decision, 'DENY');
  } finally {
    await api.stop();
  }
});

test('LA-09/10: explicit DENY and disabled connections cannot be replaced to increase access', async () => {
  const f = await fixture();
  const opened = await openWorkingDirectory(app.db,
    { workspaceId: f.workspaceId, commandId: randomUUID(), rootPath: f.root, projectId: f.projectId });
  const resource = opened.result.association!;
  const first = opened.result.write_readiness;
  const configured = await setLocalDirectoryWriteTier(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: resource.resource_id, commandId: randomUUID(),
    expectedRevision: first.access_revision, tier: 'AUTO' });
  const access = await createRepositories(app.db).gateway.readLocalDirectoryAccess(resource.resource_id);
  assert.ok(access?.write_connection_id);
  const denied = await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'FILE_WRITE', actionType: 'APPLY_CHANGESET', targetPrefix: opened.result.canonical_root,
    decision: 'DENY', maxPayloadBytes: 262144 });
  const updated = await readWorkingDirectoryWriteReadiness(app.db,
    f.workspaceId, f.projectId, resource.resource_id);
  assert.equal(updated.status, 'PERMISSION_DENIED');
  const writeConnection = await createRepositories(app.db).gateway.readConnection(access.write_connection_id);
  assert.ok(writeConnection);
  const disabled = await disableGatewayConnectionCommand(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, connectionId: access.write_connection_id, commandId: randomUUID(),
    expectedVersion: writeConnection.version.toString() });
  assert.equal(disabled.result.status, 'DISABLED');
  const connectionCount = (await createRepositories(app.db).gateway.listConnections(f.workspaceId, f.projectId)).length;
  await assert.rejects(() => setLocalDirectoryWriteTier(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, resourceId: resource.resource_id, commandId: randomUUID(),
    expectedRevision: configured.result.revision as string, tier: 'ASK' }), /已停用/u);
  assert.equal((await createRepositories(app.db).gateway.listConnections(f.workspaceId, f.projectId)).length,
    connectionCount, 'a disabled connection cannot be replaced with a new ID');
  assert.equal((await createRepositories(app.db).gateway.readPolicy(denied.policyId))?.status, 'ACTIVE');
});

/**
 * Git 只读随目录授权（2026-10-20，P1-3）。
 *
 * 这组用例锁的是「不需要用户手工建 GIT_READ 连接与三条策略」这一条：打开仓库根就成立，
 * 重新打开复用同一条连接；子目录不授权（Git 输出不是路径受限的）；显式撤销或停用后
 * 不自动恢复；任何情况下都不顺带开放 stage/commit/push。
 */
async function gitRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('LA-11: 打开仓库根自动获得 Git 只读，重新打开复用同一条连接且不开放写', async () => {
  const f = await fixture();
  const root = await gitRepository('relay-git-root-');
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: root, projectId: f.projectId });
  assert.equal(opened.result.status, 'READY');
  assert.equal(opened.result.git_read.state, 'READY');
  assert.equal(canonicalResourceIdentity(opened.result.git_read.repo_root ?? ''),
    canonicalResourceIdentity(opened.result.canonical_root));

  const repositories = createRepositories(app.db);
  const resourceId = opened.result.association!.resource_id;
  const access = await repositories.gateway.readLocalDirectoryAccess(resourceId);
  assert.ok(access?.git_connection_id, '打开目录时记录了应用自己的 GIT_READ 连接');
  assert.deepEqual(await repositories.gateway.listConnectionCapabilities(access.git_connection_id!),
    ['GIT_READ']);
  for (const actionType of ['GIT_STATUS', 'GIT_DIFF', 'GIT_LOG']) {
    const policies = await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
      'GIT_READ', actionType);
    assert.ok(policies.some((policy) => policy.target_prefix === opened.result.canonical_root &&
      policy.decision === 'AUTO'), `${actionType} 随目录选择获得自动准入`);
  }
  const capabilities = (await Promise.all((await repositories.gateway.listConnections(f.workspaceId, f.projectId))
    .map(async (connection) => repositories.gateway.listConnectionCapabilities(connection.id)))).flat();
  assert.equal(capabilities.includes('GIT_WRITE'), false, 'Git 只读不顺带开放 stage/commit/push');

  const connectionsBefore = (await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length;
  const reopened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: root });
  assert.equal(reopened.result.git_read.state, 'READY');
  assert.equal((await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length,
    connectionsBefore, '重新打开不新建第二条 Git 连接');
  assert.equal((await repositories.gateway.readLocalDirectoryAccess(resourceId))?.git_connection_id,
    access.git_connection_id);
});

test('LA-12: 仓库子目录不按子目录授权，只报出仓库根', async () => {
  const f = await fixture();
  const root = await gitRepository('relay-git-subdir-');
  const sub = join(root, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: sub, projectId: f.projectId });
  assert.equal(opened.result.status, 'READY', '子目录本身仍是可用的工作目录');
  assert.equal(opened.result.git_read.state, 'REPO_ROOT_REQUIRED');
  assert.equal(canonicalResourceIdentity(opened.result.git_read.repo_root ?? ''),
    canonicalResourceIdentity(root), '报出的是仓库根，不是被打开的子目录');
  assert.notEqual(canonicalResourceIdentity(opened.result.canonical_root),
    canonicalResourceIdentity(root), '子目录仍是自己的工作目录');
  assert.match(opened.result.git_read.detail, /仓库根/u);

  const repositories = createRepositories(app.db);
  const access = await repositories.gateway.readLocalDirectoryAccess(opened.result.association!.resource_id);
  assert.equal(access?.git_connection_id, null, '子目录不自动建立 GIT_READ 连接');
  assert.equal((await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'GIT_READ', 'GIT_LOG')).length, 0);
});

test('LA-13: 普通目录如实报告不是仓库，不影响文件读取', async () => {
  const f = await fixture();
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: f.root, projectId: f.projectId });
  assert.equal(opened.result.status, 'READY');
  assert.equal(opened.result.git_read.state, 'NOT_A_REPOSITORY');
  assert.equal(opened.result.git_read.repo_root, null);
  const repositories = createRepositories(app.db);
  const access = await repositories.gateway.readLocalDirectoryAccess(opened.result.association!.resource_id);
  assert.equal(access?.git_connection_id, null);
  assert.ok(access, '文件读取的基础配置照旧成立');
});

test('LA-14/15: 撤销 Git 只读策略或停用连接后，重新打开不会自动恢复', async () => {
  const f = await fixture();
  const root = await gitRepository('relay-git-revoke-');
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: root, projectId: f.projectId });
  const resourceId = opened.result.association!.resource_id;
  const repositories = createRepositories(app.db);
  const access = await repositories.gateway.readLocalDirectoryAccess(resourceId);
  assert.ok(access?.git_connection_id);

  const policy = (await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'GIT_READ', 'GIT_STATUS')).find((row) => row.target_prefix === opened.result.canonical_root);
  assert.ok(policy);
  await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    policyId: policy.id, commandId: randomUUID(), expectedRevision: policy.revision.toString() });
  const afterRevoke = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: root });
  assert.equal(afterRevoke.result.git_read.state, 'REVIEW_REQUIRED');
  assert.equal((await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'GIT_READ', 'GIT_STATUS')).filter((row) => row.target_prefix === opened.result.canonical_root).length,
    0, '撤销过的规则不会被重新打开悄悄补回');

  const connection = await repositories.gateway.readConnection(access.git_connection_id!);
  assert.ok(connection);
  await disableGatewayConnectionCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    connectionId: access.git_connection_id!, commandId: randomUUID(),
    expectedVersion: connection.version.toString() });
  const afterDisable = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: root });
  assert.equal(afterDisable.result.git_read.state, 'DISABLED');
  assert.equal((await repositories.gateway.readLocalDirectoryAccess(resourceId))?.git_connection_id,
    access.git_connection_id, '停用后不换新 ID 绕过');
});

/**
 * LA-16：从「打开目录」到「真的读到 git 内容」的端到端证据。
 *
 * 前面 LA-11..15 只证明配置成立（连接、策略、状态词）。这一例走真实准入链：
 * `runUserGitReadCommand` 会经过 Gateway 的 prepare/decision，不是直接调适配器，
 * 所以它同时证明「随目录建立的 AUTO 策略确实放行了读取」与「读出来的是真内容」。
 * 撤销之后再读必须被拒——否则前面那些策略只是摆设。
 */
test('LA-16: 打开仓库根后 GIT_STATUS/GIT_DIFF 经真实准入读到真实内容，撤销后同一读取被拒', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'relay-git-e2e-'));
  roots.push(root);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await writeFile(join(root, 'README.md'), 'seed\n', 'utf8');
  await execFileAsync('git', ['add', '--', 'README.md'], { cwd: root });
  await execFileAsync('git', ['-c', 'user.name=Relay Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'seed commit'], { cwd: root });
  // 一个已跟踪文件的修改 + 一个未跟踪文件：让 status 与 diff 都有非空内容。
  await writeFile(join(root, 'README.md'), 'seed\nchanged line\n', 'utf8');
  await writeFile(join(root, 'note.txt'), 'work in progress\n', 'utf8');

  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: root, projectId: f.projectId });
  assert.equal(opened.result.git_read.state, 'READY');
  const resourceId = opened.result.association!.resource_id;
  const repositories = createRepositories(app.db);
  const connectionId = (await repositories.gateway.readLocalDirectoryAccess(resourceId))!.git_connection_id!;

  // 人工入口的动作身份是确定性的（Workspace+资源+动作+path+cached → 同一个 Operation，
  // `limit` 故意不参与，它只决定投影返回多少）。所以「撤销后再读」必须换 path 让身份不同，
  // 否则拿到的是上一次已结算的结果，测的就不是授权而是重放。
  const read = (actionType: 'GIT_STATUS' | 'GIT_DIFF', path?: string) =>
    runUserGitReadCommand(app.db, {
      workspaceId: f.workspaceId, projectId: f.projectId, resourceId, connectionId,
      actionType, actorRef: 'user:local', commandId: randomUUID(),
      ...(path === undefined ? {} : { relativePath: path }) });

  const status = await read('GIT_STATUS');
  assert.equal(status.result.state, 'SUCCEEDED', JSON.stringify(status.result));
  const statusBody = (status.result as unknown as { result: { branch: string; untracked: string[];
    unstaged: string[] } }).result;
  assert.equal(statusBody.branch, 'main', '读到的是真实分支，不是夹具');
  assert.deepEqual(statusBody.untracked, ['note.txt']);
  assert.ok(statusBody.unstaged.includes('README.md'), '已跟踪文件的修改出现在 unstaged');

  const diff = await read('GIT_DIFF', 'README.md');
  assert.equal(diff.result.state, 'SUCCEEDED', JSON.stringify(diff.result));
  assert.match(JSON.stringify(diff.result), /changed line/u, 'diff 里是真实改动内容');

  // GIT_LOG 走模型工具链（人工入口只放行 status/diff），这里直接验适配器在同一个根上读得到提交。
  const log = await gitGetLog({ cwd: opened.result.canonical_root });
  assert.equal(log[0]?.message, 'seed commit');

  // 只读没有顺带开放写：三条写动作一条策略都不该存在。
  for (const actionType of ['GIT_STAGE', 'GIT_COMMIT', 'GIT_PUSH']) {
    assert.equal((await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
      'GIT_WRITE', actionType)).length, 0, `${actionType} 不该随目录选择获得授权`);
  }

  // 撤销 GIT_DIFF 策略后换一个 path 再读：必须被拒。这证明上面的成功来自那条策略，
  // 而不是「人工入口天然放行」。
  const policy = (await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'GIT_READ', 'GIT_DIFF')).find((row) => row.target_prefix === opened.result.canonical_root);
  assert.ok(policy);
  await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    policyId: policy.id, commandId: randomUUID(), expectedRevision: policy.revision.toString() });
  await assert.rejects(read('GIT_DIFF', 'note.txt'), (error: unknown) => {
    const code = (error as { code?: string }).code ?? '';
    assert.match(code, /DENIED|PERMISSION/u, `撤销后应以权限类错误拒绝，实际 ${code}`);
    return true;
  });
});
