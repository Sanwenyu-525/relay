import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';

/**
 * 0167 知识组织与中文检索的真实 PostgreSQL + HTTP 契约：
 * 作用域隔离、游标分页、中文多信号命中、集合/标签/关系、归档可见性、重复检测与权限。
 * 所有断言都走真实 API 与真实库，不用 Mock 替换 repository。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-knowledge-organization');
let api: TestApi;
let workspaceId: string;
let otherWorkspaceId: string;
let projectA: string;
let projectB: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(database.db);
  otherWorkspaceId = await createWorkspace(database.db);
  projectA = await createProject('项目甲');
  projectB = await createProject('项目乙');
});
after(async () => { await api?.stop(); await database.close(); });

const path = (suffix: string, workspace = workspaceId) => workspacePath(workspace, suffix);
const command = async (suffix: string, body: Record<string, unknown>,
  status: 200 | 201 = 201, workspace = workspaceId,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST') => {
  const commandId = typeof body.command_id === 'string' ? body.command_id : randomUUID();
  const pathValue = path(suffix, workspace);
  const response = method === 'POST' ? await api.post(pathValue, { ...body, command_id: commandId })
    : method === 'PUT' ? await api.put(pathValue, { ...body, command_id: commandId })
      : method === 'PATCH' ? await api.patch(pathValue, { ...body, command_id: commandId })
        : await api.del(pathValue, { body: { ...body, command_id: commandId } });
  return expectCommandAccepted(response, status, commandId);
};
async function createProject(title: string): Promise<string> {
  const result = await command('/projects', { title, project_type: 'GENERAL' });
  return result.project_id as string;
}
async function seedKnowledge(title: string, text: string, projectId: string | null) {
  return command('/knowledge', { command_id: randomUUID(), project_id: projectId, title,
    source_kind: 'MANAGED_TEXT', media_type: 'text/markdown', text });
}
async function page(query: Record<string, string>, workspace = workspaceId) {
  const search = new URLSearchParams(query).toString();
  const response = await api.get(path(`/knowledge/page?${search}`, workspace));
  assert.equal(response.status, 200, response.text);
  return response;
}
type PageItem = { id: string; title: string; project_id: string | null; tags: string[];
  collections: { id: string; name: string }[]; matched_fields: string[]; snippet: string | null;
  current_version: string; status: string };

test('项目范围包含工作空间共享与当前项目，不泄露其他项目；游标与中文检索稳定', async () => {
  const shared = await seedKnowledge('知识入库规范', '工作空间共享的中文检索基线', null);
  const a = await seedKnowledge('项目甲架构说明', '项目甲专用的部署拓扑与数据库设计', projectA);
  const b = await seedKnowledge('项目乙私有资料', '项目乙只有自己的知识', projectB);
  const sharedId = shared.knowledge_id as string;
  const aId = a.knowledge_id as string;
  const bId = b.knowledge_id as string;

  const projectScope = await page({ project_id: projectA, scope: 'PROJECT', limit: '50' });
  assert.equal(projectScope.status, 200, projectScope.text);
  const projectIds = (projectScope.body as { items: PageItem[] }).items.map((item) => item.id);
  assert.deepEqual(projectIds, [aId]);
  assert.equal(projectIds.includes(bId), false);

  const allScope = await page({ project_id: projectA, scope: 'ALL', limit: '50' });
  const allIds = (allScope.body as { items: PageItem[] }).items.map((item) => item.id);
  assert.deepEqual(new Set(allIds), new Set([sharedId, aId]));

  const workspaceScope = await page({ project_id: projectA, scope: 'WORKSPACE', limit: '50' });
  const workspaceIds = (workspaceScope.body as { items: PageItem[] }).items.map((item) => item.id);
  assert.deepEqual(workspaceIds, [sharedId]);

  const chinese = await page({ project_id: projectA, q: '中文检索', limit: '50' });
  const chineseItem = (chinese.body as { items: PageItem[] }).items[0];
  assert.equal(chineseItem?.id, sharedId);
  assert.equal(chineseItem?.matched_fields.includes('text'), true);
  assert.equal(chineseItem?.snippet?.includes('中文检索'), true);

  const titleHit = await page({ project_id: projectA, q: '架构说明', limit: '50' });
  assert.deepEqual((titleHit.body as { items: PageItem[] }).items.map((item) => item.id), [aId]);
  assert.deepEqual((titleHit.body as { items: PageItem[] }).items[0]?.matched_fields, ['title']);

  const otherProjectLeak = await page({ project_id: projectA, q: '私有资料', limit: '50' });
  assert.deepEqual((otherProjectLeak.body as { items: PageItem[] }).items, []);

  const first = await page({ project_id: projectA, limit: '1', sort: 'TITLE_ASC' });
  const firstBody = first.body as { items: PageItem[]; next_cursor: string | null };
  assert.equal(firstBody.items.length, 1);
  assert.notEqual(firstBody.next_cursor, null);
  const second = await page({ project_id: projectA, limit: '1', sort: 'TITLE_ASC',
    cursor: firstBody.next_cursor! });
  const secondBody = second.body as { items: PageItem[]; next_cursor: string | null };
  assert.equal(secondBody.items.length, 1);
  const all = await page({ project_id: projectA, limit: '50', sort: 'TITLE_ASC' });
  const titles = (all.body as { items: PageItem[] }).items.map((item) => item.title);
  assert.equal(titles.length, 2);
  assert.deepEqual(new Set(titles), new Set(['知识入库规范', '项目甲架构说明']));
  assert.deepEqual(new Set([firstBody.items[0]!.id, secondBody.items[0]!.id]),
    new Set([sharedId, aId]));
});

test('集合与标签按工作空间/项目命名空间隔离，整体替换与删除不改知识正文', async () => {
  const shared = await seedKnowledge('集合标签基线', '集合与标签只做组织', null);
  const sharedId = shared.knowledge_id as string;
  const workspaceCollection = await command('/knowledge-collections',
    { project_id: null, name: '技术架构' });
  const projectCollection = await command('/knowledge-collections',
    { project_id: projectA, name: '技术架构' });
  assert.equal(workspaceCollection.collection_id === projectCollection.collection_id, false);

  const duplicate = await api.post(path('/knowledge-collections'),
    { command_id: randomUUID(), project_id: null, name: '技术架构' });
  expectProblem(duplicate, 422, 'VALIDATION_FAILED');
  assert.equal((duplicate.body as { field_errors?: { field: string }[] }).field_errors?.[0]?.field,
    'name');

  const setCollections = await command(`/knowledge/${sharedId}/collections`,
    { collection_ids: [workspaceCollection.collection_id] }, 200, workspaceId, 'PUT');
  assert.deepEqual(setCollections.collection_ids, [workspaceCollection.collection_id]);
  const crossProject = await api.put(path(`/knowledge/${sharedId}/collections`),
    { command_id: randomUUID(), collection_ids: [projectCollection.collection_id] });
  expectProblem(crossProject, 422, 'VALIDATION_FAILED');

  const tags = await command(`/knowledge/${sharedId}/tags`,
    { tags: ['TypeScript', 'PostgreSQL', ' typescript '] }, 200, workspaceId, 'PUT');
  const tagsResult = tags.tags as { id: string; name: string }[];
  assert.equal(tagsResult.length, 2);
  assert.deepEqual(tagsResult.map((tag) => tag.name.toLowerCase()).sort(),
    ['postgresql', 'typescript']);

  const tagList = await api.get(path('/knowledge-tags'));
  assert.equal(tagList.status, 200);
  const listed = (tagList.body as { items: { name: string; usage_count: number }[] }).items;
  assert.equal(listed.some((tag) => tag.name.toLowerCase() === 'typescript' && tag.usage_count === 1),
    true);

  const row = (await page({ q: '集合标签基线' })).body as { items: PageItem[] };
  assert.equal(row.items[0]?.collections[0]?.name, '技术架构');
  assert.deepEqual(row.items[0]?.tags.map((tag) => tag.toLowerCase()).sort(),
    ['postgresql', 'typescript']);

  const postgresTag = tagsResult.find((tag) => tag.name.toLowerCase() === 'postgresql')!;
  const rename = await api.patch(path(`/knowledge-tags/${postgresTag.id}`),
    { command_id: randomUUID(), name: 'TypeScript' });
  expectProblem(rename, 422, 'VALIDATION_FAILED');

  const deletedTag = await command(`/knowledge-tags/${postgresTag.id}`,
    { command_id: randomUUID() }, 200, workspaceId, 'DELETE');
  assert.equal(deletedTag.status, 'DELETED');
  const afterDelete = (await page({ q: '集合标签基线' })).body as { items: PageItem[] };
  assert.deepEqual(afterDelete.items[0]?.tags.map((tag) => tag.toLowerCase()), ['typescript']);

  const deletedCollection = await command(`/knowledge-collections/${workspaceCollection.collection_id}`,
    { command_id: randomUUID() }, 200, workspaceId, 'DELETE');
  assert.equal(deletedCollection.status, 'DELETED');
  const afterCollection = (await page({ q: '集合标签基线' })).body as { items: PageItem[] };
  assert.deepEqual(afterCollection.items[0]?.collections, []);
});

test('知识关联绑定真实 ID 与版本，自关联、缺版本与跨范围目标被拒绝，删除只解除关系', async () => {
  const from = await seedKnowledge('架构文档', '架构正文', null);
  const to = await seedKnowledge('技术决定', '决定正文', null);
  const fromId = from.knowledge_id as string;
  const toId = to.knowledge_id as string;

  const relation = await command(`/knowledge/${fromId}/relations`, { to_knowledge_id: toId,
    relation_kind: 'REFERENCES', target_version: '1', note: '架构引用决定' });
  assert.equal(relation.relation_kind, 'REFERENCES');

  const organization = await api.get(path(`/knowledge/${fromId}/organization`));
  assert.equal(organization.status, 200);
  const relations = (organization.body as { relations: { other_id: string; direction: string;
    kind: string; target_version: string | null }[] }).relations;
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.other_id, toId);
  assert.equal(relations[0]?.target_version, '1');
  assert.equal(relations[0]?.direction, 'OUT');

  const self = await api.post(path(`/knowledge/${fromId}/relations`),
    { command_id: randomUUID(), to_knowledge_id: fromId, relation_kind: 'RELATES_TO' });
  expectProblem(self, 422, 'VALIDATION_FAILED');
  const missingVersion = await api.post(path(`/knowledge/${fromId}/relations`),
    { command_id: randomUUID(), to_knowledge_id: toId, relation_kind: 'REFERENCES',
      target_version: '99' });
  expectProblem(missingVersion, 404, 'RESOURCE_NOT_FOUND');
  const missingTarget = await api.post(path(`/knowledge/${fromId}/relations`),
    { command_id: randomUUID(), to_knowledge_id: randomUUID(), relation_kind: 'RELATES_TO' });
  expectProblem(missingTarget, 404, 'RESOURCE_NOT_FOUND');

  const removed = await command(`/knowledge-relations/${String(relation.relation_id)}`,
    { command_id: randomUUID() }, 200, workspaceId, 'DELETE');
  assert.equal(removed.status, 'DELETED');
  const empty = await api.get(path(`/knowledge/${fromId}/organization`));
  assert.deepEqual((empty.body as { relations: unknown[] }).relations, []);
  const detail = await api.get(path(`/knowledge/${fromId}`));
  assert.equal(detail.status, 200, detail.text);
});

test('归档知识不进入默认召回，但仍可按 ARCHIVED/ALL 读取；重复检测与健康检查返回真实 ID', async () => {
  const duplicateText = '同文重复检测基线';
  const one = await seedKnowledge('重复资料一', duplicateText, null);
  const two = await seedKnowledge('重复资料二', duplicateText, null);
  const archived = await seedKnowledge('待归档资料', '归档后不应出现在默认列表', null);
  const archivedId = archived.knowledge_id as string;

  const archiveQuery = { q: '归档后不应' };
  const before = (await page(archiveQuery)).body as { items: PageItem[] };
  assert.equal(before.items[0]?.id, archivedId);
  assert.equal(before.items[0]?.status, 'ACTIVE');
  const archive = await command(`/knowledge/${archivedId}/archive`,
    { command_id: randomUUID(), expected_revision: String(archived.revision) }, 200);
  assert.equal(archive.status, 'ARCHIVED');

  assert.deepEqual(((await page(archiveQuery)).body as { items: PageItem[] }).items, []);
  const archivedPage = (await page({ ...archiveQuery, status: 'ARCHIVED' })).body as { items: PageItem[] };
  assert.equal(archivedPage.items[0]?.id, archivedId);
  const allPage = (await page({ ...archiveQuery, status: 'ALL' })).body as { items: PageItem[] };
  assert.equal(allPage.items[0]?.status, 'ARCHIVED');

  const health = await api.get(path('/knowledge/health'));
  assert.equal(health.status, 200, health.text);
  const body = health.body as { duplicates: { content_sha256: string; ids: string[] }[] };
  const group = body.duplicates.find((entry) =>
    entry.ids.includes(one.knowledge_id as string) && entry.ids.includes(two.knowledge_id as string));
  assert.notEqual(group, undefined);

  const overview = await api.get(path(`/knowledge/overview?project_id=${projectA}`));
  assert.equal(overview.status, 200, overview.text);
  const counts = overview.body as { knowledge_total: number; collection_total: number };
  assert.equal(counts.knowledge_total >= 1, true);
  assert.equal(counts.collection_total >= 1, true);
});

test('另一个工作空间看不到知识详情与组织，页面只返回自己的事实', async () => {
  const local = await seedKnowledge('工作空间隔离资料', '只属于当前工作空间', null);
  const localId = local.knowledge_id as string;

  const otherPage = await page({ limit: '50' }, otherWorkspaceId);
  assert.equal(otherPage.status, 200);
  assert.deepEqual((otherPage.body as { items: PageItem[] }).items, []);
  const otherOrganization = await api.get(path(`/knowledge/${localId}/organization`, otherWorkspaceId));
  assert.equal(otherOrganization.status, 404);
  const otherDetail = await api.get(path(`/knowledge/${localId}`, otherWorkspaceId));
  assert.equal(otherDetail.status, 404);

  const localPage = await page({ q: '工作空间隔离' });
  assert.equal(((localPage.body as { items: PageItem[] }).items[0]?.id), localId);
});
