import type { DbExecutor } from '../infrastructure/database.js';
import { validationFailed } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import { decodeKnowledgeCursor, requireKnowledgeRoot } from '../information/knowledge-repository.js';
import { KNOWLEDGE_SCOPES, KNOWLEDGE_SORTS, KNOWLEDGE_STATUSES, knowledgeBodyTokens,
  knowledgeSummary, knowledgeTitleTokens, type KnowledgeScopeFilter, type KnowledgeSort,
  type KnowledgeStatusFilter } from './knowledge-model.js';

/**
 * 知识库读取用例（0167）。
 *
 * 与旧的 `listInformation` 分开：
 *   * 旧端点保留原语义供其他页面使用（不静默改变已有调用方的数据范围）；
 *   * 本文件提供「概览 / 分页列表 / 组织详情 / 使用记录」的新读取面，
 *     全部落在真实聚合与索引查询上，不生成演示数据，也不整表返回。
 */

export interface KnowledgePageInput {
  readonly workspaceId: string;
  readonly projectId?: string | undefined;
  readonly scope?: string | undefined;
  readonly status?: string | undefined;
  readonly q?: string | undefined;
  readonly collectionId?: string | undefined;
  readonly tagId?: string | undefined;
  readonly sort?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

function scopeFilter(value: string | undefined): KnowledgeScopeFilter {
  const scope = value ?? 'ALL';
  if (!(KNOWLEDGE_SCOPES as readonly string[]).includes(scope)) {
    throw validationFailed([{ field: 'scope', message: 'expected ALL, WORKSPACE or PROJECT' }]);
  }
  return scope as KnowledgeScopeFilter;
}

function statusFilter(value: string | undefined): KnowledgeStatusFilter {
  const status = value ?? 'ACTIVE';
  if (!(KNOWLEDGE_STATUSES as readonly string[]).includes(status)) {
    throw validationFailed([{ field: 'status', message: 'expected ACTIVE, ARCHIVED or ALL' }]);
  }
  return status as KnowledgeStatusFilter;
}

function sortFilter(value: string | undefined): KnowledgeSort {
  const sort = value ?? 'UPDATED_DESC';
  if (!(KNOWLEDGE_SORTS as readonly string[]).includes(sort)) {
    throw validationFailed([{ field: 'sort', message: 'expected UPDATED_DESC, CREATED_DESC or TITLE_ASC' }]);
  }
  return sort as KnowledgeSort;
}

async function requireProject(db: DbExecutor, workspaceId: string, projectId?: string): Promise<void> {
  if (projectId === undefined) return;
  const project = await createRepositories(db).projects.readProject(projectId);
  if (project?.workspace_id !== workspaceId) {
    // 与既有读取一致：跨工作空间的项目按 404 处理，不透露它是否存在。
    throw validationFailed([{ field: 'project_id', message: 'project is not in this workspace' }]);
  }
}

/**
 * 列表：游标绑定「过滤条件 + 排序 + 查询词」，条件变化时旧游标一律拒绝。
 * `projectId` 为空表示工作空间上下文，此时 PROJECT 作用域必然为空（不是「全部」的别名）。
 */
export async function listKnowledgePage(db: DbExecutor, input: KnowledgePageInput) {
  await requireProject(db, input.workspaceId, input.projectId);
  const scope = scopeFilter(input.scope);
  const status = statusFilter(input.status);
  const sort = sortFilter(input.sort);
  const query = (input.q ?? '').trim();
  if (query.length > 200) {
    throw validationFailed([{ field: 'q', message: 'must be 0..200 characters' }]);
  }
  const limit = input.limit ?? 24;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw validationFailed([{ field: 'limit', message: 'must be 1..50' }]);
  }
  const projectId = input.projectId ?? null;
  const collectionId = input.collectionId ?? null;
  const tagId = input.tagId ?? null;
  const expected = { sort, projectId, scope, status, query, collectionId, tagId };
  const cursor = input.cursor === undefined || input.cursor === ''
    ? null : decodeKnowledgeCursor(input.cursor, expected);
  const repository = createRepositories(db).knowledge;
  const page = await repository.listPage({ workspaceId: input.workspaceId, projectId, scope,
    status, query, collectionId, tagId, sort, limit, cursor });
  return {
    items: page.items.map((row) => ({
      id: row.id, title: row.title, project_id: row.project_id, status: row.status,
      revision: row.revision.toString(10), current_version: row.current_version.toString(10),
      summary: row.summary, source_kind: row.source_kind, media_type: row.media_type,
      availability: row.availability, source_uri: row.source_uri,
      tags: row.tags, collections: row.collections,
      matched_fields: row.matched_fields,
      snippet: row.snippet,
      created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    })),
    next_cursor: page.next_cursor,
  };
}

/** 概览：真实聚合；没有的指标返回 0 而不是编一个「趋势」。 */
export async function readKnowledgeOverview(db: DbExecutor, workspaceId: string,
  projectId?: string) {
  await requireProject(db, workspaceId, projectId);
  const overview = await createRepositories(db).knowledge.overview(workspaceId, projectId ?? null);
  return {
    knowledge_total: overview.knowledgeTotal,
    decision_total: overview.decisionTotal,
    rule_total: overview.ruleTotal,
    recent_new: overview.recentNew,
    recent_updated: overview.recentUpdated,
    unavailable: overview.unavailable,
    stale: overview.stale,
    curation_pending: overview.curationPending,
    collection_total: overview.collectionTotal,
    tag_total: overview.tagTotal,
    unorganized: overview.unorganized,
    latest_created_at: overview.latestCreatedAt,
    latest_updated_at: overview.latestUpdatedAt,
  };
}

/** 一条知识的组织信息：标签、集合、双向关联、使用记录。 */
export async function readKnowledgeOrganization(db: DbExecutor, workspaceId: string,
  knowledgeId: string, usageLimit = 10) {
  const repository = createRepositories(db).knowledge;
  // 组织视图也必须先确认知识属于该工作空间：不能因为只查关联表就把跨空间探测变成 200。
  await requireKnowledgeRoot(db, workspaceId, knowledgeId);
  const organization = await repository.readOrganization(workspaceId, knowledgeId);
  const usage = await repository.usageRecords(workspaceId, knowledgeId, usageLimit);
  return {
    tags: organization.tags,
    collections: organization.collections,
    relations: organization.relations,
    usage,
  };
}

export async function listKnowledgeCollections(db: DbExecutor, workspaceId: string,
  projectId?: string) {
  await requireProject(db, workspaceId, projectId);
  const rows = await createRepositories(db).knowledge.listCollections(workspaceId, projectId ?? null);
  return rows.map((row) => ({ id: row.id, project_id: row.project_id, name: row.name,
    description: row.description, revision: row.revision.toString(10), item_count: row.item_count,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() }));
}

export async function listKnowledgeTags(db: DbExecutor, workspaceId: string,
  projectId?: string) {
  await requireProject(db, workspaceId, projectId);
  return (await createRepositories(db).knowledge.listTags(workspaceId, projectId ?? null))
    .map((row) => ({ id: row.id, name: row.name, usage_count: row.usage_count }));
}

/** 知识健康：全部是确定性判定，不做「AI 判断过期」。 */
export async function readKnowledgeHealth(db: DbExecutor, workspaceId: string,
  projectId?: string) {
  await requireProject(db, workspaceId, projectId);
  const repository = createRepositories(db).knowledge;
  const duplicates = await repository.duplicateGroups(workspaceId, projectId ?? null, 20);
  const overview = await repository.overview(workspaceId, projectId ?? null);
  return {
    duplicates: duplicates.map((group) => ({ content_sha256: group.content_sha256,
      ids: group.ids })),
    unavailable: overview.unavailable,
    stale: overview.stale,
    unorganized: overview.unorganized,
    curation_pending: overview.curationPending,
    // 过期提醒不是删除：界面必须展示原因并让人决定，这里只给可核对的计数与候选。
    stale_after_days: 180,
  };
}

/** 索引回填：一次有界批次，供 CLI 与维护入口调用；返回本批处理条数。 */
export async function backfillKnowledgeIndex(db: DbExecutor, workspaceId: string,
  batchSize = 50): Promise<number> {
  const repository = createRepositories(db).knowledge;
  const rows = await repository.listUnindexed(workspaceId, batchSize);
  for (const row of rows) {
    const text = row.content_text;
    await repository.updateIndex(row.id, {
      summary: knowledgeSummary(text),
      titleTokens: knowledgeTitleTokens(row.title).join(' '),
      bodyTokens: text === null ? '' : knowledgeBodyTokens(text).join(' '),
    });
  }
  return rows.length;
}
