import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { knowledgeQueryTokens, scoreKnowledge, type KnowledgeEffectiveStatus }
  from './knowledge-model.js';

/**
 * Agent 知识检索（0167 Phase 5）。
 *
 * 与旧实现的差别：
 *   * 查询来自完整任务标题（分词），不是标题前 12 个字符的字面 ILIKE；
 *   * 排序是多信号综合分：标题覆盖 > 正文覆盖 > 标签 > 集合 > 来源 > 项目归属；
 *   * 只取当前有效版本；来源不可读、归档、跨项目的知识在 SQL 层就不可见；
 *   * 候选池有上限（`limit * 3`），不会把整个知识库带回应用层再排序。
 *
 * 本模块不写任何状态：检索结果只用于上下文选择，使用记录仍由消息的 sources 冻结。
 */

export interface KnowledgeCandidate {
  readonly id: string;
  readonly title: string;
  readonly version: bigint;
  readonly score: number;
  readonly reasons: readonly KnowledgeReason[];
  readonly projectId: string | null;
}

export type KnowledgeReason = 'TITLE_MATCH' | 'TEXT_MATCH' | 'TAG_MATCH' |
  'COLLECTION_MATCH' | 'SOURCE_MATCH' | 'PROJECT_MATCH';

export interface KnowledgeRetrievalInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskTitle: string;
  /** 当前验收目标；来自 task_acceptances，而不是从标题猜测。 */
  readonly taskObjective?: string | undefined;
  /** 验收条目；只取有界条数与长度，避免把整份契约展开成海量查询词。 */
  readonly acceptanceCriteria?: readonly string[] | undefined;
  /** 项目标题参与查询（项目名通常就是任务主题的一部分），不参与项目归属加权。 */
  readonly projectTitle?: string | undefined;
  readonly limit: number;
}

/**
 * 显式引用不在这里处理：`readContextSources` 在 context-builder 中先按冻结版本
 * 加载显式来源，再进入检索候选。保留两条写入同一份 Context 的路径会制造
 * 优先级与权限校验的分叉，因此本模块不接收 explicitIds。
 */
function bounded(value: string | undefined, maxChars: number): string {
  if (value === undefined) return '';
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function retrievalQueryText(input: KnowledgeRetrievalInput): string {
  // 标题、验收目标、最多 6 条验收条目依次进入；项目标题最后且单独限长。
  // knowledgeQueryTokens 仍会截断到 500 字符、24 个词元，保证请求规模有界。
  const criteria = (input.acceptanceCriteria ?? []).slice(0, 6)
    .map((statement) => bounded(statement, 120)).filter((statement) => statement !== '');
  return [bounded(input.taskTitle, 240), bounded(input.taskObjective, 300), ...criteria,
    bounded(input.projectTitle, 120)].join(' ').trim();
}

interface ScoredRow {
  readonly id: string;
  readonly title: string;
  readonly version: bigint;
  readonly project_id: string | null;
  readonly status: string;
  readonly availability: KnowledgeEffectiveStatus;
  readonly title_hits: number | string;
  readonly body_hits: number | string;
  readonly tag_hits: number | string;
  readonly collection_hits: number | string;
  readonly source_hit: boolean;
  readonly project_match: boolean;
}

export async function retrieveKnowledge(db: DbExecutor,
  input: KnowledgeRetrievalInput): Promise<readonly KnowledgeCandidate[]> {
  const queryText = retrievalQueryText(input);
  const tokens = knowledgeQueryTokens(queryText);
  if (tokens.length === 0) return [];
  const limit = Math.min(Math.max(input.limit, 1), 20);
  const pool = Math.min(limit * 3, 60);
  // 直接把词元数组作为参数传给 unnest；避免 CTE 别名在相关子查询里被 PostgreSQL
  // 解析成缺失 FROM 的表引用（真实集成测试曾复现 42P01）。
  const tokenArray = sql`${tokens}::text[]`;
  // 来源命中也必须进入候选资格；只把 source_hit 算进 select/score，会在 WHERE
  // 阶段把“仅来源 URI/文件名命中”的合法候选排除，形成无法解释的漏检。
  const sourceHit = sql`exists (select 1 from unnest(${tokenArray}) tok
    where position(tok in lower(coalesce(v.source_uri, '') || ' '
      || coalesce(v.source_refs ->> 'file_name', ''))) > 0)`;
  const rows = (await sql<ScoredRow>`
    with matched as (
      select k.id, k.title, k.project_id, k.status, v.version,
        case when v.availability = 'AVAILABLE' then 'ACTIVE' else 'UNAVAILABLE' end as availability,
        (select count(*) from unnest(${tokenArray}) tok
          where position(tok in k.search_title_tokens) > 0)::int as title_hits,
        (select count(*) from unnest(${tokenArray}) tok
          where position(tok in k.search_body_tokens) > 0)::int as body_hits,
        (select count(distinct tg.id) from knowledge_tag_links tl
          join knowledge_tags tg on tg.id = tl.tag_id
          where tl.knowledge_id = k.id
            and exists (select 1 from unnest(${tokenArray}) tok
              where position(tok in tg.norm_name) > 0))::int as tag_hits,
        (select count(distinct c.id) from knowledge_collection_items ci
          join knowledge_collections c on c.id = ci.collection_id
          where ci.knowledge_id = k.id
            and exists (select 1 from unnest(${tokenArray}) tok
              where position(tok in lower(c.name)) > 0))::int as collection_hits,
        ${sourceHit} as source_hit,
        (k.project_id = ${input.projectId}) as project_match
      from knowledge_items k
      join knowledge_versions v on v.knowledge_id = k.id and v.version = k.current_version
      where k.workspace_id = ${input.workspaceId}
        and k.status = 'ACTIVE'
        and (k.project_id is null or k.project_id = ${input.projectId})
        and (
          exists (select 1 from unnest(${tokenArray}) tok where position(tok in k.search_title_tokens) > 0)
          or exists (select 1 from unnest(${tokenArray}) tok where position(tok in k.search_body_tokens) > 0)
          or exists (select 1 from knowledge_tag_links tl join knowledge_tags tg on tg.id = tl.tag_id
               where tl.knowledge_id = k.id
                 and exists (select 1 from unnest(${tokenArray}) tok where position(tok in tg.norm_name) > 0))
          or exists (select 1 from knowledge_collection_items ci
               join knowledge_collections c on c.id = ci.collection_id
               where ci.knowledge_id = k.id
                 and exists (select 1 from unnest(${tokenArray}) tok where position(tok in lower(c.name)) > 0))
          or ${sourceHit}
        )
    )
    select * from matched
    order by (title_hits * 3 + body_hits + tag_hits * 2 + collection_hits
      + case when source_hit then 1 else 0 end) desc,
      case when project_match then 0 else 1 end, version desc, id
    limit ${pool}`.execute(db)).rows;
  if (rows.length === 0) return [];
  const candidates: KnowledgeCandidate[] = [];
  for (const row of rows) {
    const titleOverlap = Number(row.title_hits) / tokens.length;
    const bodyOverlap = Number(row.body_hits) / tokens.length;
    const tagHits = Number(row.tag_hits);
    const collectionHits = Number(row.collection_hits);
    const reasons: KnowledgeReason[] = [];
    if (titleOverlap > 0) reasons.push('TITLE_MATCH');
    if (bodyOverlap > 0) reasons.push('TEXT_MATCH');
    if (tagHits > 0) reasons.push('TAG_MATCH');
    if (collectionHits > 0) reasons.push('COLLECTION_MATCH');
    if (row.source_hit) reasons.push('SOURCE_MATCH');
    if (row.project_match) reasons.push('PROJECT_MATCH');
    const score = scoreKnowledge({ titleOverlap, bodyOverlap, tagHits, collectionHits,
      sourceHit: row.source_hit, projectMatch: row.project_match, explicit: false,
      effective: row.availability });
    if (score <= 0) continue;
    candidates.push({ id: row.id, title: row.title, version: BigInt(row.version),
      score, reasons, projectId: row.project_id });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return candidates.slice(0, limit);
}
