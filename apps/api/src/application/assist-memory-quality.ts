/**
 * MEMORY_SUMMARY_GATE：压缩摘要在发布前做确定性质量检查。
 *
 * 摘要仍然是派生上下文，原始消息才是事实源；这里只拒绝“明显不可靠”的摘要，
 * 不改写内容、不调用模型、不产生新的业务事实。检查失败时调用方必须保留原始
 * 消息并让请求失败，不能静默发布。
 *
 * 分段标题与 `MEMORY_COMPACTION_V1` 提示词保持一致；只按关键词匹配，
 * 允许模型写成 `【当前目标与范围】` 或 `### 当前目标` 等常见形式。
 */

export type MemorySummaryIssueCode =
  | 'MEMORY_SUMMARY_NOT_COMPRESSED'
  | 'MEMORY_SUMMARY_SECTIONS_MISSING'
  | 'MEMORY_SUMMARY_STATUS_LOST'
  | 'MEMORY_SUMMARY_IDENTIFIER_LOST';

/**
 * 与 `MEMORY_COMPACTION_V1` 提示词一一对应的 11 个分段。
 *
 * 门槛仍是「命中至少 2 段」——这里只要求「结构化」而不是「每一段都必须有内容」
 * （无内容的分段本来允许写「无」）。把 项目约束 / 已完成工作与已修改文件 / 当前执行状态
 * 也纳入清单，是为了让「只留目标与来源」这种退化摘要能被识别出来，而不是因为只列了
 * 旧 8 段就默认通过。
 */
export const MEMORY_SUMMARY_SECTIONS: readonly string[] = [
  '当前目标', '有效约束', '项目约束', '已确认决策', '已完成工作', '已验证进展',
  '未完成事项', '未决问题', '当前执行状态', '被替代', '来源',
];

/** 这些状态一旦进入压缩输入，摘要必须保留对应语义，不能当作成功或消失。 */
const STATUS_MARKERS: readonly { token: string; marker: RegExp }[] = [
  { token: 'FAILED', marker: /FAILED|失败|未成功/u },
  { token: 'CANCELLED', marker: /CANCELLED|取消|已取消/u },
  { token: 'WITHDRAWN', marker: /WITHDRAWN|撤回|已撤回/u },
  { token: 'SOURCE_UNAVAILABLE', marker: /SOURCE_UNAVAILABLE|来源不可用|来源失效/u },
];

/** 只认常见文档/代码扩展名，避免把普通句子里的点号当成路径。 */
const PATH_PATTERN = /[A-Za-z0-9_][A-Za-z0-9_.\\/-]*\.(?:ts|tsx|js|jsx|mjs|json|md|py|rs|css|scss|html|yml|yaml|toml|sql|ps1|sh|txt|go|java|csv|db)\b/gu;

/** 过短的历史本来就压不出收益，不能因为摘要模板比输入长就判失败。 */
const NOT_COMPRESSED_MIN_INPUT_BYTES = 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assessMemorySummary(input: { summary: string; previousSummary: string | null; content: string }):
{ ok: true } | { ok: false; code: MemorySummaryIssueCode } {
  const { summary, previousSummary, content } = input;

  if (byteLength(content) >= NOT_COMPRESSED_MIN_INPUT_BYTES && byteLength(summary) >= byteLength(content)) {
    return { ok: false, code: 'MEMORY_SUMMARY_NOT_COMPRESSED' };
  }

  const sections = MEMORY_SUMMARY_SECTIONS.filter((section) => summary.includes(section));
  if (sections.length < 2) return { ok: false, code: 'MEMORY_SUMMARY_SECTIONS_MISSING' };

  // 分段标题本身可能含「失败」「撤回」等词（例如「未决问题、失败与 UNKNOWN」），
  // 判定状态是否保留前先去掉【标题】，避免只有标题、正文为空也算保留。
  const body = summary.replace(/【[^】]*】/gu, ' ');
  for (const { token, marker } of STATUS_MARKERS) {
    const inInput = content.includes(`"status":"${token}"`) ||
      (previousSummary !== null && previousSummary.includes(token));
    if (inInput && !marker.test(body)) return { ok: false, code: 'MEMORY_SUMMARY_STATUS_LOST' };
  }

  const paths = new Set<string>();
  for (const match of content.matchAll(PATH_PATTERN)) paths.add(match[0]);
  if (paths.size >= 3) {
    const retained = [...paths].some((path) => {
      const basename = path.split(/[\\/]/u).pop() ?? path;
      return summary.includes(path) || summary.includes(basename);
    });
    if (!retained) return { ok: false, code: 'MEMORY_SUMMARY_IDENTIFIER_LOST' };
  }

  return { ok: true };
}
