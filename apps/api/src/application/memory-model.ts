import { createHash } from 'node:crypto';

/**
 * 长期记忆的纯领域模型（0164）。
 *
 * 这里只做确定性判断：类型/作用域枚举、分词、内容指纹、敏感信息识别、可信度与
 * 有效状态派生。任何需要数据库或模型的裁决都不进本文件，方便用单测覆盖边界。
 */

export const MEMORY_TYPES = ['USER_PREFERENCE', 'PROJECT_FACT', 'EXPERIENCE', 'EPISODIC', 'UNKNOWN'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ['WORKSPACE', 'PROJECT', 'TASK', 'AGENT'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_VERIFICATIONS = ['VERIFIED', 'UNVERIFIED', 'FAILED'] as const;
export type MemoryVerification = (typeof MEMORY_VERIFICATIONS)[number];

export type MemoryEffectiveStatus = 'ACTIVE' | 'EXPIRED' | 'RETIRED' | 'SUPERSEDED' | 'STALE';

export type MemoryOrigin = 'HUMAN_CONFIRMED' | 'AUTO_CAPTURE';
export type MemorySourceKind = 'MANUAL' | 'USER_STATEMENT' | 'MODEL_OBSERVATION' | 'UNKNOWN';

export interface MemoryStateLike {
  readonly status: string;
  readonly superseded_by_id: string | null;
  readonly stale_at: Date | null;
  readonly expires_at: Date | null;
}

/** 有效状态只派生，不写回：RETIRED > SUPERSEDED > EXPIRED > STALE > ACTIVE。 */
export function effectiveMemoryStatus(row: MemoryStateLike, now = new Date()): MemoryEffectiveStatus {
  if (row.status !== 'ACTIVE') return 'RETIRED';
  if (row.superseded_by_id !== null) return 'SUPERSEDED';
  if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.stale_at !== null) return 'STALE';
  return 'ACTIVE';
}

/** 类型标签只给界面与提示词使用，不改变存储枚举。 */
export function memoryTypeLabel(type: MemoryType): string {
  switch (type) {
    case 'USER_PREFERENCE': return '用户偏好';
    case 'PROJECT_FACT': return '项目事实';
    case 'EXPERIENCE': return '经验';
    case 'EPISODIC': return '事件';
    default: return '未分类';
  }
}

export function memoryScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case 'WORKSPACE': return '工作空间';
    case 'PROJECT': return '项目';
    case 'TASK': return '任务';
    default: return 'Agent';
  }
}

export function memoryVerificationLabel(verification: MemoryVerification): string {
  switch (verification) {
    case 'VERIFIED': return '已验证';
    case 'FAILED': return '明确失败';
    default: return '未验证';
  }
}

/** 模型/人工声明的类型：只接受枚举，未知值不猜测成某一类。 */
export function parseMemoryType(value: unknown): MemoryType {
  if (typeof value !== 'string') return 'UNKNOWN';
  const normalized = value.trim().toUpperCase().replace(/-/gu, '_');
  return (MEMORY_TYPES as readonly string[]).includes(normalized)
    ? normalized as MemoryType : 'UNKNOWN';
}

/** 结构化冲突键：小写 slug，长度 1..80；非法值返回 null，由调用方决定报错还是忽略。 */
export function normalizeMemoryKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === '' || key.length > 80) return null;
  return /^[a-z0-9][a-z0-9._:-]*$/u.test(key) ? key : null;
}

/** 只用于去重/内容指纹的比较，不改写入正文。 */
export function normalizeMemoryText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function memoryContentHash(title: string, text: string): string {
  return createHash('sha256')
    .update(`${normalizeMemoryText(title)}\u0000${normalizeMemoryText(text)}`, 'utf8')
    .digest('hex');
}

/**
 * 分词：中文相邻双字 + 拉丁/数字词。
 *
 * 中文按双字切片与原召回逻辑一致；拉丁词保留完整标识符（文件名、错误码、包名）。
 * `limit` 是索引与查询的硬上限，避免把整段正文变成倒排词表。
 */
export function memoryTokens(value: string, limit: number): readonly string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string): boolean => {
    if (term === '' || seen.has(term)) return false;
    seen.add(term); terms.push(term);
    return terms.length >= limit;
  };
  const text = value.slice(0, 4000).normalize('NFKC').toLowerCase();
  for (const token of text.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_./:@-]){2,}/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(token)) {
      if (token.length === 1) {
        if (push(token)) break;
        continue;
      }
      for (let i = 0; i < token.length - 1; i++) {
        if (push(token.slice(i, i + 2))) return terms;
      }
    } else if (push(token.slice(0, 60))) return terms;
  }
  return terms;
}

export const MEMORY_TITLE_TOKEN_LIMIT = 64;
export const MEMORY_BODY_TOKEN_LIMIT = 256;
export const MEMORY_QUERY_TOKEN_LIMIT = 24;

export function memoryTitleTokens(title: string): readonly string[] {
  return memoryTokens(title, MEMORY_TITLE_TOKEN_LIMIT);
}

export function memoryBodyTokens(text: string): readonly string[] {
  return memoryTokens(text, MEMORY_BODY_TOKEN_LIMIT);
}

/** 查询词与索引词使用同一套规则；空查询返回空数组（调用方不得扫全表）。 */
export function memoryQueryTokens(query: string): readonly string[] {
  return memoryTokens(query.slice(0, 500), MEMORY_QUERY_TOKEN_LIMIT);
}

/**
 * 构造 PostgreSQL `to_tsquery('simple', ...)` 的 OR 表达式。
 *
 * 索引写入的是完整标识符（文件路径、错误码、包名），但 PostgreSQL 的 simple 解析器
 * 会把 `.` `/` `:` 等当分隔符。查询侧必须做同样的切分，否则 `src/main.ts` 会被拼成
 * `srcmaints` 而永远匹配不到索引。只保留字母/数字/下划线词，丢弃纯符号片段，
 * 避免把用户输入拼成 tsquery 操作符。没有任何可用 token 时返回 null。
 */
export function memoryTsQuery(tokens: readonly string[]): string | null {
  const safe = [...new Set(tokens.flatMap((token) => token.split(/[^\p{L}\p{N}_]+/gu))
    .map((token) => token.trim())
    .filter((token) => /\p{L}|\p{N}/u.test(token)))];
  if (safe.length === 0) return null;
  return safe.join(' | ');
}

export interface MemoryTypeHint {
  readonly preferred: readonly MemoryType[];
  readonly reason: string | null;
}

/**
 * 任务感知的类型提示：只影响排序，不把「用户提到错误」当成必须召回经验记忆。
 * 命中多个维度时全部保留，由排序加权而不是二选一。
 */
export function memoryTypeHint(query: string): MemoryTypeHint {
  const text = query.toLowerCase();
  const preferred: MemoryType[] = [];
  const add = (type: MemoryType): void => { if (!preferred.includes(type)) preferred.push(type); };
  if (/偏好|习惯|以后|默认|一律|通常|风格|prefer|always|default|style/u.test(text)) add('USER_PREFERENCE');
  if (/上次|之前|以前|当时|曾经|历史|那次|last time|previously|earlier/u.test(text)) add('EPISODIC');
  if (/报错|错误|失败|修复|解决|根因|经验|踩坑|bug|error|fail|fix|root cause|workaround/u.test(text)) add('EXPERIENCE');
  if (/项目|架构|规范|依赖|构建|模块|仓库|数据库|project|architecture|convention|build|module|repo|database/u.test(text)) add('PROJECT_FACT');
  return { preferred, reason: preferred.length === 0 ? null : preferred.join(',') };
}

/** 来源可信度：人工确认 > 用户原话 > 未标注 > 模型观察。 */
export function memoryTrustRank(origin: MemoryOrigin, sourceKind: MemorySourceKind): number {
  if (origin === 'HUMAN_CONFIRMED') return 4;
  if (sourceKind === 'USER_STATEMENT') return 3;
  if (sourceKind === 'UNKNOWN') return 2;
  return 1;
}

/**
 * 置信度是确定性函数，不是模型自评分。
 *
 * - 人工保存/确认：90；被人工标记已验证：95。
 * - 自动捕获的用户原话：65；模型观察：35；旧数据未标注：50。
 * - 任何 FAILED 经验：10，禁止被当成有效解决方法。
 */
export function computeMemoryConfidence(input: {
  readonly origin: MemoryOrigin; readonly sourceKind: MemorySourceKind;
  readonly verification: MemoryVerification;
}): number {
  if (input.verification === 'FAILED') return 10;
  if (input.origin === 'HUMAN_CONFIRMED') {
    return input.verification === 'VERIFIED' ? 95 : 90;
  }
  const base = input.sourceKind === 'USER_STATEMENT' ? 65
    : input.sourceKind === 'MODEL_OBSERVATION' ? 35 : 50;
  return input.verification === 'VERIFIED' ? Math.max(base, 85) : base;
}

/** 结构化冲突/近似重复：token 集合 Jaccard。短文本不判近似，避免误合并。 */
export function memoryOverlap(left: readonly string[], right: readonly string[]): number {
  if (left.length < 4 || right.length < 4) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.8;

export interface SensitiveFinding {
  readonly kind: string;
  readonly index: number;
}

const SENSITIVE_PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { kind: 'OPENAI_KEY', pattern: /\bsk-[A-Za-z0-9]{20,}/u },
  { kind: 'ANTHROPIC_KEY', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/u },
  { kind: 'GITHUB_TOKEN', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/u },
  { kind: 'GITHUB_PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/u },
  { kind: 'AWS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { kind: 'SLACK_TOKEN', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/u },
  { kind: 'BEARER_TOKEN', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/iu },
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
  { kind: 'CREDENTIAL_ASSIGNMENT',
    pattern: /\b(?:password|passwd|api[_-]?key|secret|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*['"]?[^\s'"]{8,}/iu },
  { kind: 'CHINESE_CREDENTIAL', pattern: /(?:密码|口令|密钥|令牌|凭证)\s*[:：=]\s*\S{6,}/u },
];

/**
 * 敏感凭证识别（强制拒绝自动长期保存）。
 *
 * 只做高置信匹配：宁可漏掉一段普通文本，也不把「token 这个词」当成凭证。
 */
export function detectSensitiveContent(text: string): readonly SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const { kind, pattern } of SENSITIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) findings.push({ kind, index: match.index });
  }
  return findings;
}

/** 记忆正文里不能出现的权限/指令改写句式（仅标记，不改变内容）。 */
export function containsInstructionOverride(text: string): boolean {
  return /(忽略|无视|绕过|override|ignore).{0,24}(规则|指令|权限|安全|instruction|rule|permission|safety)/iu.test(text)
    || /system prompt|系统提示词|开发者消息/u.test(text);
}
