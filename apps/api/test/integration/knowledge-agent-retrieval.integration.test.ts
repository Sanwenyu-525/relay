import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

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
// 测试准备用迁移角色写入来源元数据；应用角色没有直接 UPDATE 权限，避免测试绕过生产权限边界。
const fixtureDatabase = openDatabase(MIGRATION_DATABASE_URL, 'relay-knowledge-agent-retrieval-fixture');
let api: TestApi;
let workspaceId: string;
let projectA: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
  projectA = await createProject('Agent 检索项目');
});
after(async () => { await api?.stop(); await database.close(); await fixtureDatabase.close(); });

const path = (suffix: string) => workspacePath(workspaceId, suffix);
async function command(suffix: string, body: Record<string, unknown>, status: 200 | 201 = 201,
  method: 'POST' | 'PUT' = 'POST') {
  const commandId = String(body.command_id ?? randomUUID());
  const response = method === 'POST'
    ? await api.post(path(suffix), { ...body, command_id: commandId })
    : await api.put(path(suffix), { ...body, command_id: commandId });
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

async function markSource(id: string, sourceUri: string | null, fileName: string | null) {
  await sql`update knowledge_versions
    set source_uri = ${sourceUri},
      source_refs = ${JSON.stringify(fileName === null ? {} : { file_name: fileName })}::jsonb
    where knowledge_id = ${id} and version = 1`.execute(fixtureDatabase.db);
}

test('仅来源 URI 命中也能进入候选集，不再被 WHERE 排除', async () => {
  const suffix = randomUUID().slice(0, 8);
  const created = await seed('普通资料', '无关正文。', projectA);
  const id = created.knowledge_id as string;
  await markSource(id, `https://docs.example/${suffix}/runbook`, null);
  const candidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: suffix, limit: 5
  });
  const hit = candidates.find((candidate) => candidate.id === id);
  assert.equal(hit !== undefined, true);
  assert.equal(hit?.reasons.includes('SOURCE_MATCH'), true);
});

test('仅来源文件名命中也能进入候选集', async () => {
  const suffix = randomUUID().slice(0, 8);
  const created = await seed('普通资料', '无关正文。', projectA);
  const id = created.knowledge_id as string;
  await markSource(id, null, `runbook-${suffix}.docx`);
  const candidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: suffix, limit: 5
  });
  assert.equal(candidates.some((candidate) => candidate.id === id &&
    candidate.reasons.includes('SOURCE_MATCH')), true);
});

test('仅标签命中与仅集合命中都进入候选，且不依赖标题/正文', async () => {
  const tagSuffix = randomUUID().slice(0, 8);
  const tagItem = await seed('普通资料甲', '无关正文甲。', projectA);
  const tagId = tagItem.knowledge_id as string;
  await command(`/knowledge/${tagId}/tags`, { tags: [`zzTag${tagSuffix}`] }, 200, 'PUT');
  const tagCandidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: `zzTag${tagSuffix}`, limit: 5
  });
  const tagHit = tagCandidates.find((candidate) => candidate.id === tagId);
  assert.equal(tagHit?.reasons.includes('TAG_MATCH'), true);
  assert.equal(tagHit?.reasons.includes('TITLE_MATCH'), false);
  assert.equal(tagHit?.reasons.includes('TEXT_MATCH'), false);

  const collectionSuffix = randomUUID().slice(0, 8);
  const collectionItem = await seed('普通资料乙', '无关正文乙。', projectA);
  const collectionId = collectionItem.knowledge_id as string;
  const collection = await command('/knowledge-collections',
    { project_id: projectA, name: `zzColl${collectionSuffix}` });
  await command(`/knowledge/${collectionId}/collections`,
    { collection_ids: [collection.collection_id] }, 200, 'PUT');
  const collectionCandidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: `zzColl${collectionSuffix}`, limit: 5
  });
  const collectionHit = collectionCandidates.find((candidate) => candidate.id === collectionId);
  assert.equal(collectionHit?.reasons.includes('COLLECTION_MATCH'), true);
  assert.equal(collectionHit?.reasons.includes('TITLE_MATCH'), false);
  assert.equal(collectionHit?.reasons.includes('TEXT_MATCH'), false);
});

test('标题与正文同时命中，验收目标也能成为有界检索信号', async () => {
  const suffix = randomUUID().slice(0, 8);
  const created = await seed(`Title${suffix}`, `Body${suffix}。`, projectA);
  const id = created.knowledge_id as string;
  const candidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA,
    taskTitle: `Title${suffix} Body${suffix}`, limit: 5
  });
  const hit = candidates.find((candidate) => candidate.id === id);
  assert.equal(hit?.reasons.includes('TITLE_MATCH'), true);
  assert.equal(hit?.reasons.includes('TEXT_MATCH'), true);

  const objective = `Objective${suffix}`;
  const objectiveItem = await seed('目标资料', `验收目标专用 ${objective}。`, projectA);
  const objectiveId = objectiveItem.knowledge_id as string;
  const objectiveCandidates = await retrieveKnowledge(database.db, {
    workspaceId, projectId: projectA, taskTitle: '与主题无关的任务',
    taskObjective: objective, limit: 5
  });
  assert.equal(objectiveCandidates.some((candidate) => candidate.id === objectiveId), true);
});
