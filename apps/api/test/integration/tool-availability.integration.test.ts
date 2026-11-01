import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { openDatabase } from './integration-support.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL } from './integration-support.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi } from './api-harness.js';

/**
 * 项目工具有效性只读投影（PLUGIN-P0-01）的端到端验证。
 *
 * 单测覆盖判定规则；这里验证的是**接线**：路由真的存在、响应真的能过 schema、
 * 以及「连接停用 / 策略撤销后状态跟着变」这条验收要求走的是真实数据库与真实 HTTP。
 * 不启动模型、不派发任何动作——本查询只读。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-tool-availability');
let api: TestApi;
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await mkdtemp(join(tmpdir(), 'relay-tool-availability-'));
  api = await startTestApi();
});
after(async () => {
  await api?.stop();
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

interface ToolRow {
  readonly tool: string;
  readonly state: string;
  readonly detail: string;
  readonly counts: { readonly total: number; readonly auto: number; readonly needs_approval: number };
}

async function createProject(workspaceId: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title: `tool-availability-${commandId.slice(0, 8)}`, project_type: 'GENERAL',
  });
  return expectCommandAccepted(response, 201, commandId).project_id as string;
}

async function readAvailability(workspaceId: string, projectId: string): Promise<readonly ToolRow[]> {
  const response = await api.get(workspacePath(workspaceId,
    `/projects/${projectId}/tool-availability`));
  assert.equal(response.status, 200, response.text);
  const body = response.body as { project_id: string; items: readonly ToolRow[] };
  assert.equal(body.project_id, projectId);
  return body.items;
}

function rowOf(rows: readonly ToolRow[], tool: string): ToolRow {
  const row = rows.find((entry) => entry.tool === tool);
  assert.ok(row !== undefined, `缺少工具行 ${tool}`);
  return row;
}

test('只读投影按真实配置回答，并且连接停用后状态随之变化', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectId = await createProject(workspaceId);

  // 空项目：每一行都是「未配置」，不会因为默认拒绝被写成「已拒绝」而误导用户去查策略。
  const empty = await readAvailability(workspaceId, projectId);
  assert.equal(empty.length, 7);
  for (const row of empty) assert.equal(row.state, 'NOT_CONFIGURED');

  const root = await mkdtemp(join(tmpdir(), 'relay-tool-root-'));
  const resourceId = await (async () => {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/managed-resources`),
      { command_id: commandId, root_path: root });
    return expectCommandAccepted(response, 201, commandId).resource_id as string;
  })();
  const connectionId = await (async () => {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/connections`),
      { command_id: commandId, capabilities: ['FILE_READ'], root_path: root });
    const result = expectCommandAccepted(response, 201, commandId);
    return result.connection_id as string;
  })();

  // 只有连接、没有策略：默认拒绝，因此是「已连接，尚未授权」。
  const connected = await readAvailability(workspaceId, projectId);
  assert.equal(rowOf(connected, 'files').state, 'NOT_AUTHORIZED');

  const policyId = await (async () => {
    const commandId = randomUUID();
    const response = await api.post(workspacePath(workspaceId, `/projects/${projectId}/permission-policies`),
      { command_id: commandId, capability: 'FILE_READ', resource_id: resourceId, decision: 'AUTO',
        max_payload_bytes: 262144, action_type: 'READ_FILE' });
    return expectCommandAccepted(response, 201, commandId).policy_id as string;
  })();

  // 只授权 read_file：整行只能是「只读可用」，不能读作可写。
  const authorized = await readAvailability(workspaceId, projectId);
  const files = rowOf(authorized, 'files');
  assert.equal(files.state, 'READ_ONLY');
  assert.match(files.detail, /只有读取类动作已授权/u);
  assert.equal(files.counts.total, 7);
  assert.equal(files.counts.auto, 1);

  // 停用连接后，授权条目仍在，但整行必须立刻变成「已停用」。
  const disableCommand = randomUUID();
  const disabled = await api.post(workspacePath(workspaceId,
    `/projects/${projectId}/connections/${connectionId}/disable`),
  { command_id: disableCommand, expected_version: '1' });
  expectCommandAccepted(disabled, 200, disableCommand);
  assert.equal(rowOf(await readAvailability(workspaceId, projectId), 'files').state, 'DISABLED');

  // 撤销策略后（连接仍停用）：结论仍由连接状态决定，不会因为策略没了就回到「可用」。
  // 策略创建后修订为 0（只有后续版本变更才递增），因此这里显式给 0 而不是猜 1。
  const revokeCommand = randomUUID();
  const revoked = await api.post(workspacePath(workspaceId,
    `/projects/${projectId}/permission-policies/${policyId}/revoke`),
  { command_id: revokeCommand, expected_revision: '0' });
  expectCommandAccepted(revoked, 200, revokeCommand);
  assert.equal(rowOf(await readAvailability(workspaceId, projectId), 'files').state, 'DISABLED');
  await rm(root, { recursive: true, force: true });
});

test('不存在的项目返回 404，而不是一份「全部未配置」的空结论', async () => {
  const workspaceId = await createWorkspace(app.db);
  const response = await api.get(workspacePath(workspaceId,
    `/projects/${randomUUID()}/tool-availability`));
  assert.equal(response.status, 404, response.text);
});
