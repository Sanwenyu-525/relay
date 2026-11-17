import { buildTsQuery, excerptText, normalizeLabelName, tokenizeSearchText }
  from '../shared/search-tokens.js';

/**
 * 知识库的纯领域模型（0167）。
 *
 * 这里只放确定性规则：分词、摘要、标签/集合名规范化、作用域与排序枚举、
 * 关联类型与综合相关性打分。任何需要数据库或模型的裁决都不进本文件，
 * 便于用单测固定边界，也保证检索排序可解释。
 */

export const KNOWLEDGE_SCOPES = ['ALL', 'WORKSPACE', 'PROJECT'] as const;
export type KnowledgeScopeFilter = (typeof KNOWLEDGE_SCOPES)[number];

export const KNOWLEDGE_STATUSES = ['ACTIVE', 'ARCHIVED', 'ALL'] as const;
export type KnowledgeStatusFilter = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_SORTS = ['UPDATED_DESC', 'CREATED_DESC', 'TITLE_ASC'] as const;
export type KnowledgeSort = (typeof KNOWLEDGE_SORTS)[number];

export const KNOWLEDGE_RELATION_KINDS = ['RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM',
  'CONSTRAINS', 'REFERENCES'] as const;
export type KnowledgeRelationKind = (typeof KNOWLEDGE_RELATION_KINDS)[number];

export const KNOWLEDGE_TITLE_TOKEN_LIMIT = 64;
export const KNOWLEDGE_BODY_TOKEN_LIMIT = 256;
export const KNOWLEDGE_QUERY_TOKEN_LIMIT = 24;
export const KNOWLEDGE_SUMMARY_LIMIT = 200;
export const KNOWLEDGE_TAG_LIMIT = 12;
export const KNOWLEDGE_TAG_NAME_MAX = 48;
export const KNOWLEDGE_COLLECTION_NAME_MAX = 120;

/** 标签名：规范化后非空、长度受限；返回 null 表示拒绝，由用例给出字段错误。 */
export function normalizeKnowledgeTagName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  if (trimmed === '' || [...trimmed].length > KNOWLEDGE_TAG_NAME_MAX) return null;
  // 纯符号标签无法检索也无法阅读，直接拒绝而不是静默保存。
  if (!/\p{L}|\p{N}/u.test(trimmed)) return null;
  return trimmed;
}

/** 标签/集合的匹配键：与唯一索引同一口径（大小写与空白折叠）。 */
export function knowledgeLabelKey(value: string): string {
  return normalizeLabelName(value);
}

export function isValidTagKey(value: string): boolean {
  return value !== '' && value.length <= KNOWLEDGE_TAG_NAME_MAX * 2;
}

export function knowledgeTitleTokens(title: string): readonly string[] {
  return tokenizeSearchText(title, KNOWLEDGE_TITLE_TOKEN_LIMIT);
}

export function knowledgeBodyTokens(text: string): readonly string[] {
  return tokenizeSearchText(text, KNOWLEDGE_BODY_TOKEN_LIMIT);
}

/** 查询分词与索引同一套规则；空查询返回空数组（调用方不得退化成全表扫描）。 */
export function knowledgeQueryTokens(query: string): readonly string[] {
  return tokenizeSearchText(query.slice(0, 500), KNOWLEDGE_QUERY_TOKEN_LIMIT);
}

export function knowledgeTsQuery(query: string): string | null {
  return buildTsQuery(knowledgeQueryTokens(query));
}

/** 摘要：写入时生成并落在 knowledge_items.summary，列表不为展示去读正文。 */
export function knowledgeSummary(text: string | null): string | null {
  if (text === null) return null;
  const excerpt = excerptText(text, KNOWLEDGE_SUMMARY_LIMIT);
  // 纯空白正文没有可展示的摘要；保持 null，避免列表出现空摘要行。
  return excerpt === '' ? null : excerpt;
}

export function relationKindLabel(kind: KnowledgeRelationKind): string {
  switch (kind) {
    case 'SUPERSEDES': return '替代';
    case 'DERIVED_FROM': return '衍生自';
    case 'CONSTRAINS': return '约束';
    case 'REFERENCES': return '引用';
    default: return '相关';
  }
}

/**
 * 知识有效性：只派生，不写回。
 *
 * `ARCHIVED` 的根永远无效；来源不可读（`availability !== AVAILABLE`）的知识
 * 可以被阅读（读取端点会明确说明状态）但不得进入 Agent 上下文。
 */
export type KnowledgeEffectiveStatus = 'ACTIVE' | 'ARCHIVED' | 'UNAVAILABLE';

export function effectiveKnowledgeStatus(input: {
  readonly status: string; readonly availability: string | null;
}): KnowledgeEffectiveStatus {
  if (input.status !== 'ACTIVE') return 'ARCHIVED';
  if (input.availability !== null && input.availability !== 'AVAILABLE') return 'UNAVAILABLE';
  return 'ACTIVE';
}

/**
 * 多信号相关性打分（纯函数，Agent 检索与页面搜索共用口径）。
 *
 * 每个信号都来自可核对的事实：标题命中、正文命中、标签命中、
 * 集合命中、来源命中、项目归属、人工显式选择、作用域精确度。
 * 分数只用于排序，不改写任何存储状态，也不生成「使用次数」这类无法追溯的数字。
 */
export interface KnowledgeScoreSignals {
  /** 0..1：标题词元覆盖查询词元的比例。 */
  readonly titleOverlap: number;
  /** 0..1：正文词元覆盖查询词元的比例。 */
  readonly bodyOverlap: number;
  /** 命中标签数（0..N）。 */
  readonly tagHits: number;
  /** 命中集合数。 */
  readonly collectionHits: number;
  /** 来源名称/URI 命中。 */
  readonly sourceHit: boolean;
  /** 与当前项目精确匹配（工作空间共享知识得较低权重，但不为零）。 */
  readonly projectMatch: boolean;
  /** 用户本轮显式选择。 */
  readonly explicit: boolean;
  /** 当前有效状态。 */
  readonly effective: KnowledgeEffectiveStatus;
}

export const KNOWLEDGE_SCORE_WEIGHTS = Object.freeze({
  explicit: 100, title: 30, body: 18, tag: 6, collection: 4, source: 3, project: 2,
});

/** 综合分：显式选择 > 标题 > 正文 > 标签 > 集合 > 来源 > 项目；归档/不可读置零。 */
export function scoreKnowledge(signals: KnowledgeScoreSignals): number {
  if (signals.effective !== 'ACTIVE') return 0;
  const w = KNOWLEDGE_SCORE_WEIGHTS;
  return (signals.explicit ? w.explicit : 0) + signals.titleOverlap * w.title +
    signals.bodyOverlap * w.body + Math.min(signals.tagHits, 3) * w.tag +
    Math.min(signals.collectionHits, 3) * w.collection + (signals.sourceHit ? w.source : 0) +
    (signals.projectMatch ? w.project : 0);
}

/** 词元覆盖率：查询词元里有多少比例出现在目标词元集合中；空查询为 0。 */
export function tokenCoverage(queryTokens: readonly string[],
  targetTokens: readonly string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  const target = new Set(targetTokens);
  let hits = 0;
  for (const token of queryTokens) if (target.has(token)) hits += 1;
  return hits / queryTokens.length;
}

/**
 * 版本引用：Agent 上下文与历史记录必须绑定确切版本，不能只记 id。
 * 这里只做格式化的单一来源，避免三处各拼一套 `kind:id:vN`。
 */
export function knowledgeSourceRef(knowledgeId: string, version: bigint | string): string {
  return `knowledge:${knowledgeId}:v${typeof version === 'bigint' ? version.toString(10) : version}`;
}

/** 分页游标载荷的稳定形状（按排序键区分，解码方按同一 key 校验）。 */
export interface KnowledgeListCursor {
  readonly sort: KnowledgeSort;
  readonly projectId: string | null;
  readonly scope: KnowledgeScopeFilter;
  readonly status: KnowledgeStatusFilter;
  readonly titleKey: string;
  readonly timestamp: string;
  readonly id: string;
}
