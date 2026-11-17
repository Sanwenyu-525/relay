import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { retrieveKnowledge } from '../../src/application/knowledge-retrieval.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

/**
 * Agent 知识检索的真实 PostgreSQL 场景：
 * 项目/共享范围、跨项目不泄露、归档不召回、低相关不返回、同名版本只引用当前版本。
 * 端到端注入、预算与来源冻结由 context.integration.test.ts 覆盖，这里不重复造第二套。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-knowledge-agent-retrieval');
let api: TestApi;
let workspaceId: string;
let projectA: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
  projectA = await createProject('Agent 检索项目');
});
after(async () => { await api?.stop(); await database.close(); });

const path = (suffix: string) => workspacePath(workspaceId, suffix);
async function command(suffix: string, body: Record<string, unknown>, status: 200 | 201 = 201) {
  const commandId = String(body.command_id ?? randomUUID());
  const response = await api.post(path(suffix), { ...body, command_id: commandId });
  return expectCommandAccepted(response, status, commandId);
}
async function createProject(title: string): Promise<string> {
  const result = await command('/projects', { title, project_type: 'GENERAL' });
  return result.project_id as string;
}
async function seed(title: string, text: string, projectId: string | null) {
  return command('/knowledge', { project_id: projectId, title, source_kind: 'MANAGED_TEXT',
    media_type: 'text/markdown', text });
}

test('Agent 能找到项目架构文档与共享规范，跨项目私有知识不进入候选', async () => {
  const architecture = await seed('项目架构说明', '服务边界、数据库设计与部署拓扑。', projectA);
  const shared = await seed('共享检索规范', '中文查询和来源引用的统一规范。', null);
  // 同一工作空间内另建项目，确保“其他项目”是真实跨项目行而不是共享行。
  const otherProject = await createProject('另一个项目');
  const otherPrivate = await seed('另一个项目私有资料', '跨项目部署密钥与私有拓扑。', otherProject);

  const candidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: '项目架构说明评审', limit: 5
  });
  const ids = candidates.map((candidate) => candidate.id);
  assert.equal(ids.includes(architecture.knowledge_id as string), true);
  assert.equal(ids.includes(shared.knowledge_id as string), false);
  assert.equal(ids.includes(otherPrivate.knowledge_id as string), false);
  assert.equal(candidates[0]?.reasons.includes('TITLE_MATCH'), true);
});

test('归档知识不会被 Agent 召回，低相关查询不返回噪音', async () => {
  const archived = await seed('需要归档的临时资料', '临时结论，归档后不应继续召回。', null);
  const archiveId = archived.knowledge_id as string;
  const before = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: '需要归档的临时资料', limit: 5
  });
  assert.equal(before.some((candidate) => candidate.id === archiveId), true);

  await command(`/knowledge/${archiveId}/archive`,
    { command_id: randomUUID(), expected_revision: String(archived.revision) }, 200);
  const afterArchive = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: '需要归档的临时资料', limit: 5
  });
  assert.equal(afterArchive.some((candidate) => candidate.id === archiveId), false);

  const irrelevant = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: '量子纠缠', limit: 5
  });
  assert.deepEqual(irrelevant, []);
});

test('同名知识产生新版本后，检索只返回当前版本而不是旧版本', async () => {
  const created = await seed('同名部署手册', 'v1 旧部署步骤。', null);
  const id = created.knowledge_id as string;
  const version = await command(`/knowledge/${id}/versions`, {
    command_id: randomUUID(), expected_revision: String(created.revision),
    source_kind: 'MANAGED_TEXT', media_type: 'text/markdown', text: 'v2 新部署步骤，已替换旧步骤。'
  }, 200);
  assert.equal(version.version, '2');

  const candidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: '同名部署手册', limit: 5
  });
  const hit = candidates.find((candidate) => candidate.id === id);
  assert.equal(hit?.version, 2n);
  assert.equal(candidates.filter((candidate) => candidate.id === id).length, 1);
});
