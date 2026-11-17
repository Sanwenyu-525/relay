/**
 * 检索分词（Knowledge 与 Memory 共用）。
 *
 * PostgreSQL 的 `simple` 文本搜索配置不会切分中文：一整段汉字会被当成一个词元，
 * 因此「架构」这类双字查询永远无法命中长正文。这里的口径与 0164 的 Memory 索引一致：
 *   1. 中文连续片段切成相邻双字（`架构`、`构设`、`设计`）；
 *   2. 拉丁/数字词保留完整标识符（文件名、错误码、包名），最长 60 字符；
 *   3. 全文小写化并做 NFKC 归一，只用于索引与查询，不改写存储正文。
 *
 * `limit` 是索引与查询的硬上限：避免把整篇正文变成倒排词表，也避免查询拼出超长 tsquery。
 */
export function tokenizeSearchText(value: string, limit: number): readonly string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string): boolean => {
    if (term === '' || seen.has(term)) return false;
    seen.add(term);
    terms.push(term);
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
    } else if (push(token.slice(0, 60))) {
      return terms;
    }
  }
  return terms;
}

/**
 * 构造 PostgreSQL `to_tsquery('simple', ...)` 的 OR 表达式。
 *
 * 索引写入的是完整标识符（文件路径、错误码、包名），但 PostgreSQL 的 simple 解析器
 * 会把 `.` `/` `:` 等当分隔符。查询侧必须做同样的切分，否则 `src/main.ts` 会被拼成
 * `srcmaints` 而永远匹配不到索引。只保留字母/数字/下划线词，丢弃纯符号片段，
 * 避免把用户输入拼成 tsquery 操作符。没有任何可用 token 时返回 null。
 */
export function buildTsQuery(tokens: readonly string[]): string | null {
  const safe = [...new Set(tokens.flatMap((token) => token.split(/[^\p{L}\p{N}_]+/gu))
    .map((token) => token.trim())
    .filter((token) => /\p{L}|\p{N}/u.test(token)))];
  if (safe.length === 0) return null;
  return safe.join(' | ');
}

/**
 * 规范化标签/集合名：去首尾空白、折叠连续空白、大小写折叠。
 *
 * 只用于唯一性与匹配，不改变展示名；中文不做额外转换。
 */
export function normalizeLabelName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

/** 摘要：按字符截断并折叠空白；不给列表展示去读整段正文。 */
export function excerptText(value: string, limit = 200): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
