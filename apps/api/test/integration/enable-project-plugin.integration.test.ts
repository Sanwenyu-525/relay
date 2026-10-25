import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  createGatewayConnectionCommand, createGatewayPolicyCommand, enableProjectPluginCommand,
} from '../../src/application/gateway-commands.js';
import {
  createFakeConnection, createGatewayPolicy, registerManagedResource, revokeGatewayPolicy,
  setFakeConnection,
} from '../../src/application/gateway-configuration.js';
import { DomainError } from '../../src/application/domain-error.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { openDatabase } from './integration-support.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi, workspacePath, type TestApi } from './api-harness.js';

/**
 * 一键启用内置插件（2026-10-25）。
 *
 * 这条链路此前有两处事实缺口：HTTP 建连接的能力白名单不含插件能力（高级表单提交即
 * 400，插件连接没有可用登记入口），浏览器策略会被写成目录前缀（与 browser:// 目标
 * 永远匹配不上）。本文件锁：补齐的数量与决定、幂等重放、停用/撤销不绕过、GitHub
 * 的受管根绑定、以及 HTTP 层的能力白名单与 enable 路由。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-enable-plugin');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

async function createProject(workspaceId: string, title: string): Promise<string> {
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title,
      projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  return projectId;
}

interface PolicyFact { readonly capability: string; readonly action_type: string;
  readonly target_prefix: string; readonly decision: string }

async function projectPolicyFacts(workspaceId: string, projectId: string): Promise<readonly PolicyFact[]> {
  const result = await withTransaction(app.db, async (repositories) =>
    repositories.gateway.listPolicies(workspaceId, projectId));
  const active = await Promise.all(result
    .filter((policy) => policy.status === 'ACTIVE')
    .map(async (policy) => ({ policy,
      version: (await withTransaction(app.db, (repositories) =>
        repositories.gateway.listPolicyVersions(policy.id)))
        .find((row) => row.version === policy.active_version) })));
  return active
    .filter((row) => row.version !== undefined)
    .map((row) => ({ capability: row.version!.capability_key, action_type: row.version!.action_type,
      target_prefix: row.version!.target_prefix, decision: row.version!.decision }));
}

test('电脑操控：空项目一次补齐 1 条连接与 11 条策略（读取 AUTO、输入 ASK）', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId, 'enable-computer');
  const outcome = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'computer' });
  assert.equal(outcome.result.created_connections, '1');
  assert.equal(outcome.result.created_policies, '11');
  assert.equal(outcome.result.blocked_disabled_connections, '0');
  assert.equal(outcome.result.blocked_revoked_policies, '0');
  const facts = await projectPolicyFacts(workspaceId, projectId);
  assert.equal(facts.length, 11);
  assert.equal(facts.filter((fact) => fact.capability === 'COMPUTER_READ').length, 2);
  const input = facts.filter((fact) => fact.capability === 'COMPUTER_INPUT');
  assert.equal(input.length, 9);
  assert.ok(input.every((fact) => fact.decision === 'ASK'), '输入类必须 ASK');
  assert.ok(facts.every((fact) => fact.decision !== 'DENY'));
  assert.ok(facts.every((fact) => fact.target_prefix === 'computer://desktop'),
    '电脑策略目标必须是 computer://desktop');
});

test('幂等：同 command_id 重放原结果，新 command_id 重复执行不再新建', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId, 'enable-idempotent');
  const commandId = randomUUID();
  const first = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId, plugin: 'browser' });
  assert.equal(first.result.created_policies, '12');
  const replay = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId, plugin: 'browser' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  const again = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'browser' });
  assert.equal(again.result.created_connections, '0');
  assert.equal(again.result.created_policies, '0');
  assert.equal(again.result.blocked_revoked_policies, '0');
});

test('停用过的连接不绕过：只上报，不新建第二条连接', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId, 'enable-disabled-block');
  const connection = await createFakeConnection(app.db, { workspaceId, projectId,
    capabilities: ['COMPUTER_READ', 'COMPUTER_INPUT'] });
  await setFakeConnection(app.db, { workspaceId, connectionId: connection.connectionId,
    status: 'DISABLED', config: {} });
  const outcome = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'computer' });
  assert.equal(outcome.result.created_connections, '0');
  assert.equal(outcome.result.blocked_disabled_connections, '2');
});

test('撤销过的策略不自动恢复：逐动作只上报阻断数量', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId, 'enable-revoked-block');
  const first = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'computer' });
  assert.equal(first.result.created_policies, '11');
  const policies = await withTransaction(app.db, (repositories) =>
    repositories.gateway.listPolicies(workspaceId, projectId));
  const revoked = policies.find((policy) => policy.status === 'ACTIVE');
  assert.ok(revoked);
  await revokeGatewayPolicy(app.db, { workspaceId, policyId: revoked.id });
  const second = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'computer' });
  assert.equal(second.result.created_policies, '0');
  assert.equal(second.result.blocked_revoked_policies, '1');
});

test('GitHub：无受管资源只建连接并如实计数；有资源时按根逐目录授权为 AUTO', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId, 'enable-github-no-resource');
  const withoutResource = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'github' });
  assert.equal(withoutResource.result.created_connections, '1');
  assert.equal(withoutResource.result.created_policies, '0');
  assert.equal(withoutResource.result.skipped_no_resource, '5');

  const root = await mkdtemp(join(tmpdir(), 'relay-enable-gh-'));
  const resource = await registerManagedResource(app.db, { workspaceId, projectId, rootPath: root });
  const withResource = await enableProjectPluginCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), plugin: 'github' });
  assert.equal(withResource.result.created_connections, '0');
  assert.equal(withResource.result.created_policies, '5');
  assert.equal(withResource.result.skipped_no_resource, '0');
  const facts = await projectPolicyFacts(workspaceId, projectId);
  assert.equal(facts.length, 5);
  assert.ok(facts.every((fact) => fact.decision === 'AUTO'));
  assert.ok(facts.every((fact) =>
    fact.target_prefix.toLowerCase() === resource.canonicalRoot.toLowerCase()),
    'GitHub 策略必须绑定受管根本身');
});

test('浏览器策略：站点前缀按 browser:// 表达，resource_id 被明确拒绝', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId, 'browser-policy-prefix');
  const all = await createGatewayPolicyCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capability: 'BROWSER_READ', resourceId: null, decision: 'ASK',
    maxPayloadBytes: 64 });
  assert.equal(all.result.status, 'ACTIVE');
  const factsAll = await projectPolicyFacts(workspaceId, projectId);
  assert.equal(factsAll[0]?.target_prefix, 'browser://');

  const scoped = await createGatewayPolicyCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capability: 'BROWSER_ACTION', resourceId: null, decision: 'ASK',
    maxPayloadBytes: 64, host: 'Example.com:8080' });
  assert.equal(scoped.result.status, 'ACTIVE');
  const factsScoped = await projectPolicyFacts(workspaceId, projectId);
  assert.ok(factsScoped.some((fact) => fact.target_prefix === 'browser://example.com:8080'));

  const resource = await registerManagedResource(app.db, { workspaceId, projectId,
    rootPath: await mkdtemp(join(tmpdir(), 'relay-browser-policy-')) });
  await assert.rejects(() => createGatewayPolicyCommand(app.db, { workspaceId, projectId,
    commandId: randomUUID(), capability: 'BROWSER_ACTION', resourceId: resource.resourceId,
    decision: 'ASK', maxPayloadBytes: 64 }), (error: unknown) => error instanceof DomainError);
});

let api: TestApi;
test('HTTP：插件能力已进建连接白名单；enable 路由返回 201 回执并幂等', async (t) => {
  api = await startTestApi();
  t.after(async () => { await api.stop(); });
  const workspaceId = await createWorkspace(app.db);
  const createCommandId = randomUUID();
  const created = await api.post(workspacePath(workspaceId, '/projects'),
    { command_id: createCommandId, title: 'enable-http', project_type: 'GENERAL' });
  const project = expectCommandAccepted(created, 201, createCommandId);
  const projectId = project.project_id as string;

  // 此前这一步是 400：能力不在路由白名单里，高级表单选了插件能力也提交不了。
  const connectionCommandId = randomUUID();
  const connection = await api.post(
    workspacePath(workspaceId, `/projects/${projectId}/connections`),
    { command_id: connectionCommandId, capabilities: ['COMPUTER_READ', 'COMPUTER_INPUT'] });
  expectCommandAccepted(connection, 201, connectionCommandId);

  const commandId = randomUUID();
  const enable = await api.post(
    workspacePath(workspaceId, `/projects/${projectId}/plugins/browser/enable`),
    { command_id: commandId });
  const result = expectCommandAccepted(enable, 201, commandId);
  assert.equal(result.plugin, 'browser');
  assert.equal(result.created_policies, '12');
  const replay = await api.post(
    workspacePath(workspaceId, `/projects/${projectId}/plugins/browser/enable`),
    { command_id: commandId });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers['command-replayed'], 'true');

  const badPlugin = await api.post(
    workspacePath(workspaceId, `/projects/${projectId}/plugins/telegram/enable`),
    { command_id: randomUUID() });
  expectProblem(badPlugin, 422, 'VALIDATION_FAILED');
});
