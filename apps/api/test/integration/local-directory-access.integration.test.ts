import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { startTestApi, workspacePath } from './api-harness.js';
import { createGatewayPolicy } from '../../src/application/gateway-configuration.js';
import { disableGatewayConnectionCommand } from '../../src/application/gateway-commands.js';
import { setLocalDirectoryWriteTier } from '../../src/application/local-directory-access.js';
import { openWorkingDirectory, readWorkingDirectoryWriteReadiness } from
  '../../src/application/open-working-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase, APP_DATABASE_URL } from
  './integration-support.js';

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
