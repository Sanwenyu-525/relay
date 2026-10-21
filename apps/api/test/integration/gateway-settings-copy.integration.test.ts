import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { copyGatewaySettingsCommand } from '../../src/application/gateway-commands.js';
import {
  createFakeConnection, createGatewayPolicy, registerManagedResource,
} from '../../src/application/gateway-configuration.js';
import { DomainError } from '../../src/application/domain-error.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { openDatabase } from './integration-support.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-gateway-copy');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await mkdtemp(join(tmpdir(), 'relay-copy-'));
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function createWorkspace(): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `copy-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

/** 来源与目标必须是同一 Workspace 里的两个项目——复制是项目内的授权事实搬移。 */
async function createProject(workspaceId: string, title: string): Promise<string> {
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title,
      projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  return projectId;
}

test('复制：来源项目的资源、连接与 ACTIVE 策略整份落到目标项目', async () => {
  const workspaceId = await createWorkspace();
  const sourceProjectId = await createProject(workspaceId, 'copy-source');
  const targetProjectId = await createProject(workspaceId, 'copy-target');

  const root = await mkdtemp(join(tmpdir(), 'relay-copy-root-'));
  const { resourceId } = await registerManagedResource(app.db, { workspaceId, projectId: sourceProjectId, rootPath: root });
  await createFakeConnection(app.db, { workspaceId, projectId: sourceProjectId,
    capabilities: ['FAKE_WRITE'] });
  await createGatewayPolicy(app.db, { workspaceId, projectId: sourceProjectId,
    capability: 'FAKE_WRITE', actionType: 'WRITE_MARKER', targetPrefix: root,
    decision: 'AUTO', maxPayloadBytes: 1024 });

  const outcome = await copyGatewaySettingsCommand(app.db, { workspaceId,
    sourceProjectId, targetProjectId, commandId: randomUUID() });
  assert.equal(outcome.replayed, false);
  assert.deepEqual(outcome.result, { project_id: targetProjectId, source_project_id: sourceProjectId,
    resources_created: '1', connections_copied: '1', policies_copied: '1', skipped: '0' });

  const targetResources = (await app.db
    .selectFrom('managed_resources').selectAll()
    .where('project_id', '=', targetProjectId).execute());
  assert.equal(targetResources.length, 1);
  assert.equal(targetResources[0]?.identity_key, (await app.db
    .selectFrom('managed_resources').selectAll()
    .where('id', '=', resourceId).execute())[0]?.identity_key);
  assert.equal(targetResources[0]?.canonical_root, root);

  const targetConnections = (await app.db
    .selectFrom('gateway_connections').selectAll()
    .where('project_id', '=', targetProjectId).execute());
  assert.equal(targetConnections.length, 1);
  assert.equal(targetConnections[0]?.status, 'ACTIVE');
  assert.deepEqual(JSON.parse(JSON.stringify(targetConnections[0]?.config)), {});
  const targetCapabilities = (await app.db
    .selectFrom('gateway_connection_capabilities').selectAll()
    .where('connection_id', '=', targetConnections[0]?.id).execute()).map((row) => row.capability_key);
  assert.deepEqual(targetCapabilities, ['FAKE_WRITE']);

  const targetPolicies = (await app.db
    .selectFrom('gateway_permission_policies').selectAll()
    .where('project_id', '=', targetProjectId).execute());
  assert.equal(targetPolicies.length, 1);
  assert.equal(targetPolicies[0]?.status, 'ACTIVE');
  const targetVersion = (await app.db
    .selectFrom('gateway_permission_versions').selectAll()
    .where('policy_id', '=', targetPolicies[0]?.id).execute())[0];
  assert.equal(targetVersion?.capability_key, 'FAKE_WRITE');
  assert.equal(targetVersion?.action_type, 'WRITE_MARKER');
  assert.equal(targetVersion?.target_prefix, root);
  assert.equal(targetVersion?.decision, 'AUTO');
  assert.equal(Number(targetVersion?.max_payload_bytes), 1024);
});

test('判重与幂等：重复提交全部跳过，同 command_id 原样重放', async () => {
  const workspaceId = await createWorkspace();
  const sourceProjectId = await createProject(workspaceId, 'copy-idem-source');
  const targetProjectId = await createProject(workspaceId, 'copy-idem-target');
  const root = await mkdtemp(join(tmpdir(), 'relay-copy-idem-'));
  await registerManagedResource(app.db, { workspaceId, projectId: sourceProjectId, rootPath: root });
  await createFakeConnection(app.db, { workspaceId, projectId: sourceProjectId, capabilities: ['FAKE_WRITE'] });
  await createGatewayPolicy(app.db, { workspaceId, projectId: sourceProjectId,
    capability: 'FAKE_WRITE', actionType: 'WRITE_MARKER', targetPrefix: root,
    decision: 'DENY', maxPayloadBytes: 64 });

  const commandId = randomUUID();
  const first = await copyGatewaySettingsCommand(app.db, { workspaceId,
    sourceProjectId, targetProjectId, commandId });
  assert.deepEqual({ r: first.result.resources_created, c: first.result.connections_copied,
    p: first.result.policies_copied, s: first.result.skipped },
    { r: '1', c: '1', p: '1', s: '0' });

  const replay = await copyGatewaySettingsCommand(app.db, { workspaceId,
    sourceProjectId, targetProjectId, commandId });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);

  const second = await copyGatewaySettingsCommand(app.db, { workspaceId,
    sourceProjectId, targetProjectId, commandId: randomUUID() });
  assert.deepEqual({ r: second.result.resources_created, c: second.result.connections_copied,
    p: second.result.policies_copied, s: second.result.skipped },
    { r: '0', c: '0', p: '0', s: '3' });

  // 判重之后目标项目仍只有第一轮复制的一份事实，不出现第二行。
  const targetConnections = (await app.db
    .selectFrom('gateway_connections').selectAll()
    .where('project_id', '=', targetProjectId).execute());
  assert.equal(targetConnections.length, 1);
});

test('只复制 ACTIVE：停用连接与已撤销策略不进入目标项目', async () => {
  const workspaceId = await createWorkspace();
  const sourceProjectId = await createProject(workspaceId, 'copy-active-source');
  const targetProjectId = await createProject(workspaceId, 'copy-active-target');
  const root = await mkdtemp(join(tmpdir(), 'relay-copy-active-'));
  await registerManagedResource(app.db, { workspaceId, projectId: sourceProjectId, rootPath: root });
  await createFakeConnection(app.db, { workspaceId, projectId: sourceProjectId, capabilities: ['FAKE_WRITE'] });
  await createGatewayPolicy(app.db, { workspaceId, projectId: sourceProjectId,
    capability: 'FAKE_WRITE', actionType: 'WRITE_MARKER', targetPrefix: root,
    decision: 'ASK', maxPayloadBytes: 8 });

  await withTransaction(app.db, async (repositories) => {
    const connections = await repositories.gateway
      .listConnections(workspaceId, sourceProjectId);
    await repositories.gateway.setConnection({ id: connections[0]?.id ?? '', status: 'DISABLED', config: {} });
    const policies = await repositories.gateway.listPolicies(workspaceId, sourceProjectId);
    await repositories.gateway.revokePolicy(policies[0]?.id ?? '');
  });

  const outcome = await copyGatewaySettingsCommand(app.db, { workspaceId,
    sourceProjectId, targetProjectId, commandId: randomUUID() });
  assert.deepEqual({ r: outcome.result.resources_created, c: outcome.result.connections_copied,
    p: outcome.result.policies_copied, s: outcome.result.skipped },
    { r: '1', c: '0', p: '0', s: '0' });
  const targetPolicies = (await app.db
    .selectFrom('gateway_permission_policies').selectAll()
    .where('project_id', '=', targetProjectId).execute());
  assert.equal(targetPolicies.length, 0);
});

test('校验：来源与目标相同被拒绝，跨 Workspace 来源被拒绝', async () => {
  const workspaceId = await createWorkspace();
  const projectId = await createProject(workspaceId, 'copy-same');
  await assert.rejects(
    copyGatewaySettingsCommand(app.db, { workspaceId, sourceProjectId: projectId,
      targetProjectId: projectId, commandId: randomUUID() }),
    (error: unknown) => error instanceof DomainError && error.code === 'VALIDATION_FAILED',
  );

  const otherWorkspaceId = await createWorkspace();
  const otherProjectId = await createProject(otherWorkspaceId, 'copy-other-workspace');
  await assert.rejects(
    copyGatewaySettingsCommand(app.db, { workspaceId, sourceProjectId: otherProjectId,
      targetProjectId: projectId, commandId: randomUUID() }),
    (error: unknown) => error instanceof DomainError && error.code === 'RESOURCE_NOT_FOUND',
  );
});
