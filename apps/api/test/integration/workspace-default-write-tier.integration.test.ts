import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { startTestApi, workspacePath } from './api-harness.js';
import { disableGatewayConnectionCommand, revokeGatewayPolicyCommand } from
  '../../src/application/gateway-commands.js';
import { openWorkingDirectory } from '../../src/application/open-working-directory.js';
import { setWorkspaceDefaultWriteTier } from '../../src/application/workspace-default-directory.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { sql } from 'kysely';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase, APP_DATABASE_URL } from
  './integration-support.js';

/**
 * DEV-0115（2026-10-22）：工作区级默认写档位。
 *
 * 用户的诉求是「没有目录的时候也要能选档位」。这一档不是第五种权限：它仍落在同一条
 * `local_directory_access.write_tier` 上，只是**在还没有目录时先记下「以后新开的目录按哪一档起步」**。
 * 因此这里的重点有两半——命令本身是一条带修订的幂等写（与其他 Workspace 默认同规格），
 * 以及继承那一半必须像用户当时显式改档一样建立写连接与三条写策略（只写一列是假的：
 * Gateway 判定照旧读不出这一档）。第三半是防线：改默认不回写已有目录，被停用/被撤销的规则不被复活。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-default-write-tier');
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
  const root = await mkdtemp(join(tmpdir(), 'relay-default-tier-'));
  roots.push(root);
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'default-write-tier' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: 'Default write tier', projectType: 'DEVELOPMENT' });
  });
  return { workspaceId, projectId, root };
}

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'relay-default-tier-'));
  roots.push(root);
  return root;
}

async function setDefaultTier(workspaceId: string, tier: 'READ_ONLY' | 'ASK' | 'AUTO' | 'FULL' | null,
  expectedRevision: string) {
  return setWorkspaceDefaultWriteTier(app.db, { workspaceId, commandId: randomUUID(),
    expectedRevision, tier });
}

test('WT-01: 没有任何目录时也能设默认档位；CAS、重放与词表按同一条 Workspace 命令成立', async () => {
  const api = await startTestApi();
  try {
    const f = await fixture();
    const tierPath = workspacePath(f.workspaceId, '/default-write-tier');
    const projectionPath = workspacePath(f.workspaceId, '/default-working-directory');
    const empty = await api.get(projectionPath);
    assert.equal(empty.status, 200, empty.text);
    assert.equal((empty.body as { default_write_tier: unknown }).default_write_tier, null);
    assert.equal((empty.body as { revision: string }).revision, '0', '没有目录、也没有默认档位时仍是修订 0');

    const commandId = randomUUID();
    const body = { command_id: commandId, expected_revision: '0', default_write_tier: 'ASK' };
    const set = await api.post(tierPath, body);
    assert.equal(set.status, 200, set.text);
    assert.deepEqual((set.body as { result: unknown }).result,
      { workspace_id: f.workspaceId, default_write_tier: 'ASK', revision: '1' });
    assert.deepEqual((await api.post(tierPath, body)).body, set.body, '同一条命令重放返回同一份回执');
    assert.equal((await api.get(projectionPath).then((r) => r.body) as { default_write_tier: string })
      .default_write_tier, 'ASK');
    assert.equal((await api.get(projectionPath).then((r) => r.body) as { status: string }).status, 'UNSET',
      '选了默认档位不代表有默认目录：两件事各自如实投影');

    // 陈旧修订 + 不同的值＝冲突；陈旧修订 + 同一个值＝目标已达成，不是冲突。
    assert.equal((await api.post(tierPath, { command_id: randomUUID(), expected_revision: '0',
      default_write_tier: 'AUTO' })).status, 409);
    const redeclared = await api.post(tierPath, { command_id: randomUUID(), expected_revision: '0',
      default_write_tier: 'ASK' });
    assert.equal(redeclared.status, 200, redeclared.text);
    assert.equal((redeclared.body as { result: { revision: string } }).result.revision, '1');
    assert.equal((await api.post(tierPath, { command_id: randomUUID(), expected_revision: '1',
      default_write_tier: 'ALWAYS' })).status, 422);
    const cleared = await api.post(tierPath, { command_id: randomUUID(), expected_revision: '1',
      default_write_tier: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal((cleared.body as { result: { default_write_tier: string | null } }).result.default_write_tier, null);
    assert.equal((await api.post(tierPath, { command_id: randomUUID(), expected_revision: '0',
      resource_id: f.projectId })).status, 422, '严格请求体：多余的键不是默认档位命令');
  } finally { await api.stop(); }
});

test('WT-02: 默认档位在新开的目录上真的成立——写连接与三条写策略同显式改档一样建立', async () => {
  const f = await fixture();
  await setDefaultTier(f.workspaceId, 'ASK', '0');
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  assert.equal(opened.result.status, 'READY');
  const resourceId = opened.result.association!.resource_id;
  const readiness = opened.result.write_readiness;
  assert.equal(readiness.write_tier, 'ASK');
  assert.equal(readiness.policy_decision, 'ASK', '继承的一档必须读得出，不是只写进一列');

  const repositories = createRepositories(app.db);
  const access = await repositories.gateway.readLocalDirectoryAccess(resourceId);
  assert.ok(access?.write_connection_id, '默认档位不是只读那一列：本目录的 FILE_WRITE 连接随档位建立');
  assert.equal((await repositories.gateway.listConnectionCapabilities(access.write_connection_id!))
    .includes('FILE_WRITE'), true);
  for (const actionType of ['WRITE_FILE', 'APPLY_CHANGESET', 'READ_CHANGE_SET']) {
    const policies = await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
      'FILE_WRITE', actionType);
    assert.ok(policies.some((policy) => policy.target_prefix === opened.result.canonical_root &&
      policy.decision === 'ASK'), `${actionType} 随默认档位建立`);
  }
  // 默认档位只改了这一条 Workspace 默认，不顺手把打开的目录登记成默认目录之外多做别的事。
  assert.equal((await repositories.workspaces.readDefaultDirectory(f.workspaceId))?.resource_id, resourceId,
    '打开目录仍按既有规则登记为默认目录（这一条不在本次改动范围内）');
});

test('WT-03: 完全访问作为默认时策略行仍是 AUTO，差别只在 write_tier 这一列', async () => {
  const f = await fixture();
  await setDefaultTier(f.workspaceId, 'FULL', '0');
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  const readiness = opened.result.write_readiness;
  assert.equal(readiness.write_tier, 'FULL');
  assert.equal(readiness.policy_decision, 'AUTO', 'FULL 复用 AUTO 策略行，不新造第四种判定');

  const repositories = createRepositories(app.db);
  const policy = (await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
    'FILE_WRITE', 'APPLY_CHANGESET')).find((row) => row.target_prefix === opened.result.canonical_root);
  assert.equal(policy?.decision, 'AUTO');
});

test('WT-04: 没有默认档位时与改动前完全一致；改了默认也不回写已有目录', async () => {
  const f = await fixture();
  const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
  const firstId = opened.result.association!.resource_id;
  assert.equal(opened.result.write_readiness.write_tier, 'READ_ONLY');
  const repositories = createRepositories(app.db);
  assert.equal((await repositories.gateway.readLocalDirectoryAccess(firstId))?.write_connection_id, null);
  const connectionsBefore = (await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length;

  await setDefaultTier(f.workspaceId, 'AUTO', '1');
  const reopened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), rootPath: f.root });
  assert.equal((await repositories.gateway.readLocalDirectoryAccess(firstId))?.write_tier, 'READ_ONLY',
    '已有目录的档位不因默认改变而被回写');
  assert.equal((await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length,
    connectionsBefore, '改默认不给已有目录顺带建写连接');

  const secondRoot = await newRoot();
  const second = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), rootPath: secondRoot });
  assert.equal(second.result.write_readiness.write_tier, 'AUTO');
  assert.equal(second.result.write_readiness.policy_decision, 'AUTO');
});

test('WT-05: 被停用的写连接与被撤销过的写规则都不因默认档位而复活', async () => {
  // 这一例要把目录退回「管理指针还不存在」这一刻（默认档位唯一的作用点），只能删那一行；
  // 应用角色对这张表没有 DELETE（这正是它不该自己改权限事实的画法），夹具用建表角色删。
  const ddl = openDatabase(MIGRATION_DATABASE_URL, 'relay-default-write-tier-ddl');
  try {
    const f = await fixture();
    await setDefaultTier(f.workspaceId, 'ASK', '0');
    const opened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
    const resourceId = opened.result.association!.resource_id;
    const repositories = createRepositories(app.db);
    const access = await repositories.gateway.readLocalDirectoryAccess(resourceId);
    assert.ok(access?.write_connection_id);

    // 撤销 APPLY_CHANGESET 那条策略，再停用这条写连接，然后删掉管理指针——
    // 「这一行还不存在」正是默认档位唯一的作用点，此刻它必须两道理都拦住：
    // 不建第二条连接绕过停用，也不复活被人撤掉的规则。
    const policy = (await repositories.gateway.listActivePolicies(f.workspaceId, f.projectId,
      'FILE_WRITE', 'APPLY_CHANGESET')).find((row) => row.target_prefix === opened.result.canonical_root);
    assert.ok(policy);
    await revokeGatewayPolicyCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      policyId: policy.id, commandId: randomUUID(), expectedRevision: policy.revision.toString() });
    const connection = await repositories.gateway.readConnection(access.write_connection_id!);
    assert.ok(connection);
    await disableGatewayConnectionCommand(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
      connectionId: access.write_connection_id!, commandId: randomUUID(),
      expectedVersion: connection.version.toString() });
    await sql`delete from local_directory_access where resource_id = ${resourceId}`.execute(ddl.db);
    const connectionsBefore = (await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length;

    const reopened = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, commandId: randomUUID(), rootPath: f.root });
    assert.equal(reopened.result.status, 'READY', '跳过默认档位不是打开目录失败');
    assert.equal(reopened.result.write_readiness.write_tier, 'READ_ONLY');
    assert.equal((await repositories.gateway.readLocalDirectoryAccess(resourceId))?.write_connection_id, null);
    assert.equal((await repositories.gateway.listConnections(f.workspaceId, f.projectId)).length,
      connectionsBefore, '不建第二条连接绕过停用');

    // 换一个根：那里的写规则从没被撤销过，默认档位照常成立——跳过是按根判定的，不是一刀切。
    const secondRoot = await newRoot();
    const second = await openWorkingDirectory(app.db, { workspaceId: f.workspaceId,
      projectId: f.projectId, commandId: randomUUID(), rootPath: secondRoot });
    assert.equal(second.result.write_readiness.write_tier, 'ASK', '撤销发生在别的根上，不牵连新目录');
    assert.equal(second.result.write_readiness.policy_decision, 'ASK');
  } finally {
    await ddl.close();
  }
});
