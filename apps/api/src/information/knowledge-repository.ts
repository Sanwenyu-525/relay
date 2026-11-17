import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { invalidCursor, resourceNotFound, validationFailed } from '../application/domain-error.js';
import { knowledgeTsQuery, type KnowledgeListCursor, type KnowledgeRelationKind }
  from '../application/knowledge-model.js';

/**
 * 知识库组织与检索的只读/组织写入仓库（0167）。
 *
 * 边界：
 *   * Knowledge 根与版本的写入仍归 `InformationRepository`（单一写入口）；
 *     本仓库只写组织层（集合、标签、关联），它们是指向 knowledge id 的引用，不复制正文。
 *   * 所有读取都显式带 workspace_id，并由 SQL 约束「项目归属」；
 *     无权的行在 SQL 层就不可见，不依赖调用方事后过滤。
 *   * 分页一律 keyset（游标绑定排序键与过滤条件），不做 OFFSET，也不整表返回。
 */

const MAX_PAGE = 50;

export interface KnowledgeCurrentVersionFields {
  readonly source_kind: string;
  readonly media_type: string;
  readonly availability: string;
  readonly source_uri: string | null;
  readonly content_excerpt: string | null;
}

export interface KnowledgeListRow {
  readonly id: string;
  readonly title: string;
  readonly project_id: string | null;
  readonly status: string;
  readonly revision: bigint;
  readonly current_version: bigint;
  readonly summary: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly source_kind: string;
  readonly media_type: string;
  readonly availability: string;
  readonly source_uri: string | null;
  readonly tags: readonly string[];
  readonly collections: readonly { readonly id: string; readonly name: string }[];
  readonly rank: number;
  readonly matched_fields: readonly string[];
  readonly snippet: string | null;
}

export interface KnowledgePage {
  readonly items: readonly KnowledgeListRow[];
  readonly next_cursor: string | null;
  readonly total: number | null;
}

export interface KnowledgeListInput {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly scope: 'ALL' | 'WORKSPACE' | 'PROJECT';
  readonly status: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  readonly query: string;
  readonly collectionId: string | null;
  readonly tagId: string | null;
  readonly sort: 'UPDATED_DESC' | 'CREATED_DESC' | 'TITLE_ASC';
  readonly limit: number;
  readonly cursor: KnowledgeListCursor | null;
}

function scopeClause(projectId: string | null, scope: KnowledgeListInput['scope']) {
  if (projectId === null) {
    // 工作空间上下文里没有「当前项目」：ALL 与 WORKSPACE 都只含工作空间共享知识。
    return scope === 'PROJECT' ? sql`and false` : sql`and k.project_id is null`;
  }
  if (scope === 'WORKSPACE') return sql`and k.project_id is null`;
  if (scope === 'PROJECT') return sql`and k.project_id = ${projectId}`;
  return sql`and (k.project_id is null or k.project_id = ${projectId})`;
}

function statusClause(status: KnowledgeListInput['status']) {
  if (status === 'ACTIVE') return sql`and k.status = 'ACTIVE'`;
  if (status === 'ARCHIVED') return sql`and k.status = 'ARCHIVED'`;
  return sql``;
}

/** 标签/集合过滤条件：用 EXISTS 走成员索引，不改变主查询的排序键。 */
function membershipClauses(input: KnowledgeListInput) {
  const collection = input.collectionId === null ? sql`` :
    sql`and exists (select 1 from knowledge_collection_items ci
      where ci.workspace_id = ${input.workspaceId} and ci.knowledge_id = k.id
        and ci.collection_id = ${input.collectionId})`;
  const tag = input.tagId === null ? sql`` :
    sql`and exists (select 1 from knowledge_tag_links tl
      where tl.workspace_id = ${input.workspaceId} and tl.knowledge_id = k.id
        and tl.tag_id = ${input.tagId})`;
  return sql`${collection} ${tag}`;
}

function cursorClause(cursor: KnowledgeListCursor | null, query: boolean) {
  if (cursor === null) return sql``;
  if (query) {
    return sql`and (m.rank > ${cursor.titleKey}::int
      or (m.rank = ${cursor.titleKey}::int and m.updated_at < ${cursor.timestamp}::timestamptz)
      or (m.rank = ${cursor.titleKey}::int and m.updated_at = ${cursor.timestamp}::timestamptz
        and m.id < ${cursor.id}))`;
  }
  if (cursor.sort === 'TITLE_ASC') {
    return sql`and (lower(m.title) > ${cursor.titleKey}
      or (lower(m.title) = ${cursor.titleKey} and m.id > ${cursor.id}))`;
  }
  if (cursor.sort === 'CREATED_DESC') {
    return sql`and (m.created_at < ${cursor.timestamp}::timestamptz
      or (m.created_at = ${cursor.timestamp}::timestamptz and m.id < ${cursor.id}))`;
  }
  return sql`and (m.updated_at < ${cursor.timestamp}::timestamptz
    or (m.updated_at = ${cursor.timestamp}::timestamptz and m.id < ${cursor.id}))`;
}

function orderClause(sort: KnowledgeListInput['sort']) {
  if (sort === 'TITLE_ASC') return sql`order by lower(title), id`;
  if (sort === 'CREATED_DESC') return sql`order by created_at desc, id desc`;
  return sql`order by updated_at desc, id desc`;
}

/** 每行附带标签与集合：相关子查询只命中该行的成员索引，不做 N+1 应用层拼接。 */
const TAG_AGG = sql`coalesce((select array_agg(t.name order by t.name)
  from knowledge_tag_links tl join knowledge_tags t on t.id = tl.tag_id
  where tl.knowledge_id = k.id and tl.workspace_id = k.workspace_id), '{}'::text[])`;
const COLLECTION_AGG = sql`coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
    order by c.name)
  from knowledge_collection_items ci join knowledge_collections c on c.id = ci.collection_id
  where ci.knowledge_id = k.id and ci.workspace_id = k.workspace_id), '[]'::jsonb)`;

export class KnowledgeRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 列表页：无查询词走索引排序，有查询词走「标题 > 正文」的整数相关度 + 稳定键。 */
  async listPage(input: KnowledgeListInput): Promise<KnowledgePage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE) {
      throw validationFailed([{ field: 'limit', message: `must be 1..${MAX_PAGE}` }]);
    }
    const query = input.query.trim();
    const scope = scopeClause(input.projectId, input.scope);
    const status = statusClause(input.status);
    const membership = membershipClauses(input);
    const limit = input.limit;
    if (query === '') {
      const rows = (await sql<KnowledgeListRow>`with page as (
        select k.id, k.title, k.project_id, k.status, k.revision, k.current_version,
          k.summary, k.created_at, k.updated_at,
          v.source_kind, v.media_type, v.availability, v.source_uri,
          ${TAG_AGG} as tags, ${COLLECTION_AGG} as collections,
          0::int as rank, '{}'::text[] as matched_fields, null::text as snippet
        from knowledge_items k
        join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
        where k.workspace_id = ${input.workspaceId} ${scope} ${status} ${membership}
      ) select m.* from page m where true
      ${cursorClause(input.cursor, false)}
      ${orderClause(input.sort)}
      limit ${limit + 1}`.execute(this.db)).rows;
      return this.finish(rows, limit, input, false);
    }
    const tokens = knowledgeTsQuery(query);
    const tsMatch = tokens === null ? sql`false`
      : sql`(setweight(to_tsvector('simple', k.search_title_tokens), 'A')
          || setweight(to_tsvector('simple', k.search_body_tokens), 'B'))
        @@ to_tsquery('simple', ${tokens})`;
    const titleTs = tokens === null ? sql`false`
      : sql`to_tsvector('simple', k.search_title_tokens) @@ to_tsquery('simple', ${tokens})`;
    const bodyTs = tokens === null ? sql`false`
      : sql`to_tsvector('simple', k.search_body_tokens) @@ to_tsquery('simple', ${tokens})`;
    const literal = sql`position(lower(${query}) in lower(k.title)) > 0`;
    // 旧行（0167 之前写入）没有分词：只在「未索引」行上退回字面匹配，
    // 读完一次回填后这个集合为空，不会长期让检索依赖 TOAST 扫描。
    const legacy = sql`(k.search_title_tokens = '' and k.search_body_tokens = ''
      and (position(lower(${query}) in lower(k.title)) > 0
        or position(lower(${query}) in lower(coalesce(v.content_text, ''))) > 0))`;
    const matched = sql`(${literal} or ${tsMatch} or ${legacy})`;
    const rank = sql`case
      when lower(k.title) = lower(${query}) then 0
      when position(lower(${query}) in lower(k.title)) > 0 then 1
      when ${titleTs} then 2
      when ${bodyTs} then 3
      else 4 end`;
    const fields = sql`array_remove(array[
      case when position(lower(${query}) in lower(k.title)) > 0 then 'title' end,
      case when position(lower(${query}) in lower(coalesce(v.content_text, ''))) > 0
        or ${bodyTs} then 'text' end,
      case when exists (select 1 from knowledge_tag_links tl join knowledge_tags t on t.id = tl.tag_id
        where tl.knowledge_id = k.id and position(lower(${query}) in lower(t.name)) > 0)
        then 'tag' end,
      case when exists (select 1 from knowledge_collection_items ci
        join knowledge_collections c on c.id = ci.collection_id
        where ci.knowledge_id = k.id and position(lower(${query}) in lower(c.name)) > 0)
        then 'collection' end
    ]::text[], null)`;
    const snippet = sql`case
      when position(lower(${query}) in lower(coalesce(v.content_text, ''))) > 0
        then substring(coalesce(v.content_text, '') from greatest(1,
          position(lower(${query}) in lower(coalesce(v.content_text, ''))) - 40) for 180)
      when position(lower(${query}) in lower(k.title)) > 0 then k.title
      else coalesce(k.summary, k.title) end`;
    const rows = (await sql<KnowledgeListRow>`with page as (
      select k.id, k.title, k.project_id, k.status, k.revision, k.current_version,
        k.summary, k.created_at, k.updated_at,
        v.source_kind, v.media_type, v.availability, v.source_uri,
        ${TAG_AGG} as tags, ${COLLECTION_AGG} as collections,
        ${rank} as rank, ${fields} as matched_fields, ${snippet} as snippet
      from knowledge_items k
      join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
      where k.workspace_id = ${input.workspaceId} ${scope} ${status} ${membership}
        and ${matched}
    ) select m.* from page m where true
    ${cursorClause(input.cursor, true)}
    order by m.rank, m.updated_at desc, m.id desc
    limit ${limit + 1}`.execute(this.db)).rows;
    return this.finish(rows, limit, input, true);
  }

  private finish(rows: readonly KnowledgeListRow[], limit: number,
    input: KnowledgeListInput, query: boolean): KnowledgePage {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const next = rows.length > limit && last !== undefined
      ? encodeCursor(input, last, query) : null;
    return { items: page, next_cursor: next, total: null };
  }

  /** 概览：全部是数据库聚合，不扫正文，也不生成演示数字。 */
  async overview(workspaceId: string, projectId: string | null) {
    const knowledgeScope = scopeClause(projectId, 'ALL');
    const decisionScope = projectId === null ? sql`and project_id is null`
      : sql`and (project_id is null or project_id = ${projectId})`;
    const ruleScope = projectId === null
      ? sql`and r.scope = 'WORKSPACE'`
      : sql`and ((r.scope = 'WORKSPACE') or (r.scope = 'PROJECT' and r.project_id = ${projectId})
          or (r.scope = 'TASK' and r.project_id = ${projectId}))`;
    const collectionScope = projectId === null ? sql`and project_id is null`
      : sql`and (project_id is null or project_id = ${projectId})`;
    const row = (await sql<{
      knowledge_total: number; decision_total: number; rule_total: number;
      recent_new: number; recent_updated: number; unavailable: number; stale: number;
      curation_pending: number; collection_total: number; tag_total: number;
      unorganized: number; latest_created: Date | null; latest_updated: Date | null;
    }>`select
      (select count(*) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope})::int as knowledge_total,
      (select count(*) from decisions d where d.workspace_id = ${workspaceId}
        and d.status = 'ACTIVE' ${decisionScope})::int as decision_total,
      (select count(*) from rules r where r.workspace_id = ${workspaceId}
        and r.status = 'ACTIVE' ${ruleScope})::int as rule_total,
      (select count(*) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope}
        and k.created_at >= now() - interval '7 days')::int as recent_new,
      (select count(*) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope}
        and k.updated_at >= now() - interval '7 days'
        and k.created_at < now() - interval '7 days')::int as recent_updated,
      (select count(*) from knowledge_items k
        join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
        where k.workspace_id = ${workspaceId} and k.status = 'ACTIVE' ${knowledgeScope}
        and v.availability <> 'AVAILABLE')::int as unavailable,
      (select count(*) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope}
        and k.updated_at < now() - interval '180 days')::int as stale,
      (select count(*) from knowledge_curation_candidates c
        where c.workspace_id = ${workspaceId}
        and c.accepted_knowledge_version_id is null and c.rejected_at is null)::int
        as curation_pending,
      (select count(*) from knowledge_collections c where c.workspace_id = ${workspaceId}
        ${collectionScope})::int as collection_total,
      (select count(*) from knowledge_tags t where t.workspace_id = ${workspaceId})::int as tag_total,
      (select count(*) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope}
        and not exists (select 1 from knowledge_tag_links tl where tl.knowledge_id = k.id)
        and not exists (select 1 from knowledge_collection_items ci where ci.knowledge_id = k.id)
      )::int as unorganized,
      (select max(k.created_at) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope}) as latest_created,
      (select max(k.updated_at) from knowledge_items k where k.workspace_id = ${workspaceId}
        and k.status = 'ACTIVE' ${knowledgeScope}) as latest_updated
    `.execute(this.db)).rows[0];
    if (row === undefined) throw new Error('knowledge overview aggregate missing');
    return {
      knowledgeTotal: row.knowledge_total, decisionTotal: row.decision_total,
      ruleTotal: row.rule_total, recentNew: row.recent_new, recentUpdated: row.recent_updated,
      unavailable: row.unavailable, stale: row.stale, curationPending: row.curation_pending,
      collectionTotal: row.collection_total, tagTotal: row.tag_total,
      unorganized: row.unorganized,
      latestCreatedAt: row.latest_created?.toISOString() ?? null,
      latestUpdatedAt: row.latest_updated?.toISOString() ?? null,
    };
  }

  /** 一条知识的组织信息：标签、集合、关联、来源使用记录。 */
  async readOrganization(workspaceId: string, knowledgeId: string) {
    const tags = (await sql<{ id: string; name: string }>`select t.id, t.name
      from knowledge_tag_links tl join knowledge_tags t on t.id = tl.tag_id
      where tl.workspace_id = ${workspaceId} and tl.knowledge_id = ${knowledgeId}
      order by t.name`.execute(this.db)).rows;
    const collections = (await sql<{ id: string; name: string; description: string | null }>`
      select c.id, c.name, c.description from knowledge_collection_items ci
      join knowledge_collections c on c.id = ci.collection_id
      where ci.workspace_id = ${workspaceId} and ci.knowledge_id = ${knowledgeId}
      order by c.name`.execute(this.db)).rows;
    const relations = await this.listRelations(workspaceId, knowledgeId);
    return { tags, collections, relations };
  }

  /** Agent 使用记录：来自消息里冻结的来源数组，不是估算或展示用的计数。 */
  async usageRecords(workspaceId: string, knowledgeId: string, limit: number) {
    const probe = JSON.stringify([{ kind: 'KNOWLEDGE', root_id: knowledgeId }]);
    const rows = (await sql<{ message_id: string; session_id: string; session_title: string;
      seq: bigint; role: string; created_at: Date; version: string | null; status: string | null }>`
      select m.id as message_id, m.session_id, s.title as session_title, m.seq, m.role,
        m.created_at, elem ->> 'version' as version, elem ->> 'status' as status
      from assist_messages m
      join assist_sessions s on s.id = m.session_id
      cross join lateral jsonb_array_elements(m.sources) elem
      where s.workspace_id = ${workspaceId}
        and m.sources @> ${probe}::jsonb
        and elem ->> 'kind' = 'KNOWLEDGE' and elem ->> 'root_id' = ${knowledgeId}
      order by m.created_at desc, m.id desc
      limit ${Math.min(Math.max(limit, 1), 50)}`.execute(this.db)).rows;
    return rows.map((row) => ({ message_id: row.message_id, session_id: row.session_id,
      session_title: row.session_title, seq: row.seq.toString(), role: row.role,
      created_at: row.created_at.toISOString(), version: row.version,
      status: row.status }));
  }

  // ---- 知识集合 ---------------------------------------------------------

  async listCollections(workspaceId: string, projectId: string | null) {
    const scope = projectId === null ? sql`and c.project_id is null`
      : sql`and (c.project_id is null or c.project_id = ${projectId})`;
    return (await sql<{ id: string; project_id: string | null; name: string;
      description: string | null; revision: bigint; item_count: number;
      created_at: Date; updated_at: Date }>`select c.id, c.project_id, c.name, c.description,
      c.revision, c.created_at, c.updated_at,
      (select count(*) from knowledge_collection_items ci
        where ci.collection_id = c.id)::int as item_count
      from knowledge_collections c
      where c.workspace_id = ${workspaceId} ${scope}
      order by c.project_id nulls first, c.name`.execute(this.db)).rows;
  }

  async readCollection(workspaceId: string, id: string) {
    const row = (await sql<{ id: string; workspace_id: string; project_id: string | null;
      name: string; description: string | null; revision: bigint }>`
      select id, workspace_id, project_id, name, description, revision
      from knowledge_collections where workspace_id = ${workspaceId} and id = ${id}`
      .execute(this.db)).rows[0];
    return row;
  }

  async insertCollection(input: { id: string; workspaceId: string; projectId: string | null;
    name: string; normName: string; description: string | null }): Promise<void> {
    await sql`insert into knowledge_collections
      (id, workspace_id, project_id, name, norm_name, description)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.name},
        ${input.normName}, ${input.description})`.execute(this.db);
  }

  async updateCollection(input: { id: string; workspaceId: string; name: string;
    normName: string; description: string | null; expectedRevision: bigint }): Promise<bigint> {
    const result = (await sql<{ revision: bigint }>`update knowledge_collections
      set name = ${input.name}, norm_name = ${input.normName},
        description = ${input.description}, revision = revision + 1, updated_at = now()
      where id = ${input.id} and workspace_id = ${input.workspaceId}
        and revision = ${input.expectedRevision}
      returning revision`.execute(this.db)).rows[0];
    return result?.revision ?? -1n;
  }

  async deleteCollection(workspaceId: string, id: string): Promise<boolean> {
    const rows = (await sql<{ id: string }>`delete from knowledge_collections
      where id = ${id} and workspace_id = ${workspaceId} returning id`.execute(this.db)).rows;
    return rows.length > 0;
  }

  /** 集合成员替换：先删后插，同一个命令内完成；知识本身不受影响。 */
  async replaceCollectionItems(workspaceId: string, knowledgeId: string,
    collectionIds: readonly string[]): Promise<void> {
    await sql`delete from knowledge_collection_items
      where workspace_id = ${workspaceId} and knowledge_id = ${knowledgeId}`.execute(this.db);
    if (collectionIds.length === 0) return;
    await sql`insert into knowledge_collection_items (collection_id, knowledge_id, workspace_id)
      select c.id, ${knowledgeId}, ${workspaceId} from knowledge_collections c
      where c.workspace_id = ${workspaceId} and c.id = any(${[...collectionIds]}::uuid[])`
      .execute(this.db);
  }

  async collectionKnowledgeIds(workspaceId: string, collectionId: string): Promise<readonly string[]> {
    return (await sql<{ knowledge_id: string }>`select knowledge_id
      from knowledge_collection_items
      where workspace_id = ${workspaceId} and collection_id = ${collectionId}
      order by knowledge_id`.execute(this.db)).rows.map((row) => row.knowledge_id);
  }

  // ---- 标签 -------------------------------------------------------------

  /**
   * 标签可见性：只返回「有链接到当前可见知识」或「尚无任何链接」的标签。
   * 只在某个私有项目里用过的标签不会出现在工作空间页面上，避免标签名泄漏项目内容。
   */
  async listTags(workspaceId: string, projectId: string | null) {
    const scope = projectId === null ? sql`k.project_id is null`
      : sql`(k.project_id is null or k.project_id = ${projectId})`;
    return (await sql<{ id: string; name: string; usage_count: number }>`select t.id, t.name,
      (select count(*) from knowledge_tag_links tl where tl.tag_id = t.id)::int as usage_count
      from knowledge_tags t
      where t.workspace_id = ${workspaceId}
        and (not exists (select 1 from knowledge_tag_links tl where tl.tag_id = t.id)
          or exists (select 1 from knowledge_tag_links tl join knowledge_items k on k.id = tl.knowledge_id
            where tl.tag_id = t.id and k.workspace_id = ${workspaceId} and ${scope}))
      order by t.norm_name`.execute(this.db)).rows;
  }

  /** 批量确保标签存在：大小写/空白规范化后唯一；已存在的保留原名。 */
  async ensureTags(workspaceId: string, tags: readonly { name: string; norm: string }[]):
  Promise<readonly { id: string; name: string; norm: string }[]> {
    if (tags.length === 0) return [];
    const rows = (await sql<{ id: string; name: string; norm_name: string }>`
      insert into knowledge_tags (id, workspace_id, name, norm_name)
      select gen_random_uuid(), ${workspaceId}, t.name, t.norm
      from jsonb_to_recordset(${JSON.stringify(tags.map((tag) => ({ name: tag.name,
        norm: tag.norm })))}::jsonb) as t(name text, norm text)
      on conflict (workspace_id, norm_name) do update set updated_at = now()
      returning id, name, norm_name`.execute(this.db)).rows;
    return rows.map((row) => ({ id: row.id, name: row.name, norm: row.norm_name }));
  }

  async replaceKnowledgeTags(workspaceId: string, knowledgeId: string,
    tagIds: readonly string[]): Promise<void> {
    await sql`delete from knowledge_tag_links
      where workspace_id = ${workspaceId} and knowledge_id = ${knowledgeId}`
      .execute(this.db);
    if (tagIds.length === 0) return;
    await sql`insert into knowledge_tag_links (tag_id, knowledge_id, workspace_id)
      select t.id, ${knowledgeId}, ${workspaceId} from knowledge_tags t
      where t.workspace_id = ${workspaceId} and t.id = any(${[...tagIds]}::uuid[])`
      .execute(this.db);
  }

  async readKnowledgeTags(workspaceId: string, knowledgeId: string) {
    return (await sql<{ id: string; name: string }>`select t.id, t.name
      from knowledge_tag_links tl join knowledge_tags t on t.id = tl.tag_id
      where tl.workspace_id = ${workspaceId} and tl.knowledge_id = ${knowledgeId}
      order by t.name`.execute(this.db)).rows;
  }

  async renameTag(workspaceId: string, id: string, name: string, normName: string): Promise<boolean> {
    const rows = (await sql<{ id: string }>`update knowledge_tags set name = ${name},
      norm_name = ${normName}, updated_at = now()
      where id = ${id} and workspace_id = ${workspaceId} returning id`.execute(this.db)).rows;
    return rows.length > 0;
  }

  async deleteTag(workspaceId: string, id: string): Promise<boolean> {
    const rows = (await sql<{ id: string }>`delete from knowledge_tags
      where id = ${id} and workspace_id = ${workspaceId} returning id`.execute(this.db)).rows;
    return rows.length > 0;
  }

  // ---- 关联 -------------------------------------------------------------

  async listRelations(workspaceId: string, knowledgeId: string) {
    const rows = (await sql<{ id: string; direction: 'OUT' | 'IN'; kind: string;
      other_id: string; other_title: string; other_status: string;
      target_version: bigint | null; note: string | null; created_at: Date }>`
      select r.id, 'OUT'::text as direction, r.relation_kind as kind,
        r.to_knowledge_id as other_id, k.title as other_title, k.status as other_status,
        r.target_version, r.note, r.created_at
      from knowledge_relations r join knowledge_items k on k.id = r.to_knowledge_id
      where r.workspace_id = ${workspaceId} and r.from_knowledge_id = ${knowledgeId}
      union all
      select r.id, 'IN'::text, r.relation_kind, r.from_knowledge_id, k.title, k.status,
        r.target_version, r.note, r.created_at
      from knowledge_relations r join knowledge_items k on k.id = r.from_knowledge_id
      where r.workspace_id = ${workspaceId} and r.to_knowledge_id = ${knowledgeId}
      order by created_at desc, id`.execute(this.db)).rows;
    return rows.map((row) => ({ id: row.id, direction: row.direction, kind: row.kind,
      other_id: row.other_id, other_title: row.other_title, other_status: row.other_status,
      target_version: row.target_version?.toString(10) ?? null, note: row.note,
      created_at: row.created_at.toISOString() }));
  }

  async insertRelation(input: { id: string; workspaceId: string; fromId: string; toId: string;
    kind: KnowledgeRelationKind; targetVersion: bigint | null; note: string | null }): Promise<void> {
    await sql`insert into knowledge_relations
      (id, workspace_id, from_knowledge_id, to_knowledge_id, relation_kind,
        target_version, note)
      values (${input.id}, ${input.workspaceId}, ${input.fromId}, ${input.toId}, ${input.kind},
        ${input.targetVersion}, ${input.note})`.execute(this.db);
  }

  async readRelation(workspaceId: string, id: string) {
    return (await sql<{ id: string; from_knowledge_id: string; to_knowledge_id: string;
      relation_kind: string }>`select id, from_knowledge_id, to_knowledge_id, relation_kind
      from knowledge_relations where workspace_id = ${workspaceId} and id = ${id}`
      .execute(this.db)).rows[0];
  }

  async deleteRelation(workspaceId: string, id: string): Promise<boolean> {
    const rows = (await sql<{ id: string }>`delete from knowledge_relations
      where id = ${id} and workspace_id = ${workspaceId} returning id`.execute(this.db)).rows;
    return rows.length > 0;
  }

  // ---- 去重与索引维护 ---------------------------------------------------

  /** 内容指纹重复：只含当前有效版本，返回组内 id（按更新时间新→旧）。 */
  async duplicateGroups(workspaceId: string, projectId: string | null, limit: number) {
    const scope = projectId === null ? sql`and k.project_id is null`
      : sql`and (k.project_id is null or k.project_id = ${projectId})`;
    return (await sql<{ content_sha256: string; ids: string[] }>`
      select encode(v.content_sha256, 'hex') as content_sha256,
        array_agg(k.id order by k.updated_at desc, k.id) as ids
      from knowledge_items k
      join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
      where k.workspace_id = ${workspaceId} and k.status = 'ACTIVE' ${scope}
      group by v.content_sha256 having count(*) > 1
      order by count(*) desc, encode(v.content_sha256, 'hex')
      limit ${Math.min(Math.max(limit, 1), 100)}`.execute(this.db)).rows;
  }

  async findByContentHash(workspaceId: string, hashHex: string,
    projectId: string | null): Promise<readonly { id: string; title: string; project_id: string | null }[]> {
    const scope = projectId === null ? sql`and k.project_id is null`
      : sql`and (k.project_id is null or k.project_id = ${projectId})`;
    return (await sql<{ id: string; title: string; project_id: string | null }>`
      select k.id, k.title, k.project_id from knowledge_items k
      join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
      where k.workspace_id = ${workspaceId} and k.status = 'ACTIVE' ${scope}
        and v.content_sha256 = ${Buffer.from(hashHex, 'hex')}
      order by k.updated_at desc limit 5`.execute(this.db)).rows;
  }

  async readRootMeta(workspaceId: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return (await sql<{ id: string; title: string; project_id: string | null;
      revision: bigint; current_version: bigint; status: string }>`
      select id, title, project_id, revision, current_version, status
      from knowledge_items where workspace_id = ${workspaceId}
        and id = any(${[...ids]}::uuid[])`.execute(this.db)).rows;
  }

  /** 标题相似提示：只做有界候选（标题倒排 + 前缀），不因同名自动合并。 */
  async findSimilarTitles(workspaceId: string, projectId: string | null, title: string,
    limit: number): Promise<readonly { id: string; title: string; project_id: string | null }[]> {
    const scope = projectId === null ? sql`and k.project_id is null`
      : sql`and (k.project_id is null or k.project_id = ${projectId})`;
    const tokens = knowledgeTsQuery(title);
    const tsMatch = tokens === null ? sql`false`
      : sql`to_tsvector('simple', k.search_title_tokens) @@ to_tsquery('simple', ${tokens})`;
    return (await sql<{ id: string; title: string; project_id: string | null }>`
      select k.id, k.title, k.project_id from knowledge_items k
      where k.workspace_id = ${workspaceId} and k.status = 'ACTIVE' ${scope}
        and (${tsMatch} or position(lower(${title}) in lower(k.title)) > 0
          or position(lower(k.title) in lower(${title})) > 0)
      order by k.updated_at desc, k.id limit ${Math.min(Math.max(limit, 1), 10)}`
      .execute(this.db)).rows;
  }

  async listUnindexed(workspaceId: string, limit: number) {
    return (await sql<{ id: string; title: string; content_text: string | null }>`
      select k.id, k.title, v.content_text
      from knowledge_items k
      join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
      where k.workspace_id = ${workspaceId}
        and (k.search_title_tokens = '' or k.search_body_tokens = ''
          or (k.summary is null and v.content_text is not null))
      order by k.id limit ${Math.min(Math.max(limit, 1), 500)}`.execute(this.db)).rows;
  }

  async updateIndex(id: string, input: { summary: string | null; titleTokens: string;
    bodyTokens: string }): Promise<void> {
    await sql`update knowledge_items set summary = ${input.summary},
      search_title_tokens = ${input.titleTokens}, search_body_tokens = ${input.bodyTokens}
      where id = ${id}`.execute(this.db);
  }
}

/** 查询分词：与索引同一套中文双字规则；空查询返回 null（调用方不得退化全表扫描）。 */
function encodeCursor(input: KnowledgeListInput, row: KnowledgeListRow, query: boolean): string {
  const payload: KnowledgeListCursor = {
    sort: input.sort,
    projectId: input.projectId,
    scope: input.scope,
    status: input.status,
    titleKey: query ? String(row.rank) : input.sort === 'TITLE_ASC' ? row.title.toLocaleLowerCase()
      : '',
    timestamp: input.sort === 'CREATED_DESC' && !query ? row.created_at.toISOString()
      : row.updated_at.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify({ ...payload, q: input.query.trim(),
    collectionId: input.collectionId, tagId: input.tagId }), 'utf8').toString('base64url');
}

export function decodeKnowledgeCursor(raw: string, expected: {
  readonly sort: KnowledgeListInput['sort']; readonly projectId: string | null;
  readonly scope: KnowledgeListInput['scope']; readonly status: KnowledgeListInput['status'];
  readonly query: string; readonly collectionId: string | null; readonly tagId: string | null;
}): KnowledgeListCursor {
  if (raw.length > 1000) throw invalidCursor('cursor', '游标过长。');
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.sort !== expected.sort || parsed.projectId !== expected.projectId ||
        parsed.scope !== expected.scope || parsed.status !== expected.status ||
        parsed.q !== expected.query.trim() || parsed.collectionId !== expected.collectionId ||
        parsed.tagId !== expected.tagId || typeof parsed.id !== 'string' ||
        !/^[0-9a-f-]{36}$/iu.test(parsed.id) || typeof parsed.titleKey !== 'string' ||
        typeof parsed.timestamp !== 'string' || parsed.timestamp.length > 60 ||
        !Number.isFinite(new Date(parsed.timestamp).getTime())) throw new Error('mismatch');
    return parsed as unknown as KnowledgeListCursor;
  } catch {
    throw invalidCursor('cursor', '游标不可解析或与当前过滤条件不一致。');
  }
}

/** 集合/标签 id 必须属于同一工作空间；不存在时按 404，避免跨空间探测。 */
export async function requireCollection(db: DbExecutor, workspaceId: string,
  id: string): Promise<{ id: string; project_id: string | null; revision: bigint }> {
  const row = (await sql<{ id: string; project_id: string | null; revision: bigint }>`
    select id, project_id, revision from knowledge_collections
    where workspace_id = ${workspaceId} and id = ${id}`.execute(db)).rows[0];
  if (row === undefined) throw resourceNotFound('KnowledgeCollection');
  return row;
}

export async function requireKnowledgeRoot(db: DbExecutor, workspaceId: string,
  id: string): Promise<{ id: string; project_id: string | null; status: string; title: string }> {
  const row = (await sql<{ id: string; project_id: string | null; status: string; title: string }>`
    select id, project_id, status, title from knowledge_items
    where workspace_id = ${workspaceId} and id = ${id}`.execute(db)).rows[0];
  if (row === undefined) throw resourceNotFound('knowledge');
  return row;
}
