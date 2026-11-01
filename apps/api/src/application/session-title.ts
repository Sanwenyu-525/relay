/**
 * 会话标题规范与规则引擎（2026-11-01 SESSION_AUTO_TITLE）。
 *
 * 分类与拼接格式**只在后端定义**：模型只返回 `{category, subject}`，不能自己拼标题，
 * 也不能发明分类。规则引擎承担三件事——
 *   1. 在没有模型或模型不可用时给出确定性的结构化标题（不是把原始首条消息截断）；
 *   2. 给模型输出兜底：分类不认识、任务名空、格式不合规一律拒绝；
 *   3. 提供后端唯一的格式判定，UI 不复制这一套词表。
 *
 * 这里不读数据库、不调模型，只做文本判定，因此可以用纯单测逐档钉住。
 */

export const SESSION_TITLE_CATEGORIES = [
  'UI',
  'FEATURE',
  'FIX',
  'ARCHITECTURE',
  'TEST',
  'RESEARCH',
  'DOCUMENTATION',
  'OTHER',
] as const;

export type SessionTitleCategory = (typeof SESSION_TITLE_CATEGORIES)[number];

/** 分类的可见标签。标题格式为 `标签-任务名`。 */
export const SESSION_TITLE_CATEGORY_LABELS: Readonly<Record<SessionTitleCategory, string>> = {
  UI: 'UI',
  FEATURE: '功能',
  FIX: '修复',
  ARCHITECTURE: '架构',
  TEST: '测试',
  RESEARCH: '调研',
  DOCUMENTATION: '文档',
  OTHER: '其他',
};

/** 与 `assist_sessions.title` 的既有上限一致（shared/text.ts 的 title）。 */
export const SESSION_TITLE_MAX_LENGTH = 200;
/**
 * 任务名的一般上限。需求要求「一般 12～26 个汉字左右，必要技术标识可使实际长度略长」，
 * 因此规则引擎取 30 个码点、模型输出取 40 个码点；总量仍守 200。
 */
const RULE_SUBJECT_MAX_CHARS = 30;
const MODEL_SUBJECT_MAX_CHARS = 40;

/**
 * 模糊表达：它们不能作为正式标题的任务名。这里只列**整句等于**这些说法的情形——
 * 「修复-模型调用超时」里的「失败」是任务对象，不是执行状态。
 */
const VAGUE_SUBJECTS = new Set([
  '帮我看看',
  '帮忙看看',
  '处理一些问题',
  '处理问题',
  '新的讨论',
  '新讨论',
  '看一下',
  '看看',
  '问题',
  '讨论',
  '聊天',
  '一些事情',
  '待确认',
]);

/** 任务执行状态不能写进标题（它会随时间变化，而标题是任务本身）。 */
const STATE_SUBJECT_PREFIX = /^(已完成|进行中|生成中|已取消|已失败|已验收|未开始|待确认)/u;

/**
 * Markdown 结构性字符、JSON 花括号与换行；`#` 只在行首剥离，保留 C# 这类技术标识。
 * 花括号一并拒绝：标题不是信封，模型把 JSON 片段塞进 subject 说明输出已经越界。
 */
const MARKDOWN_STRUCTURE = /[`*[\]{}\n\r]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const CONTROL = /\p{Cc}/u;

/** 用户显式换任务的保守标记：没有这些词时一律保持原标题，不做「猜目标变了」的重命名。 */
const NEW_TASK_MARKERS = [
  '新任务',
  '换个任务',
  '换一个任务',
  '另一个任务',
  '另一个问题',
  '接下来做',
  '现在开始做',
  '重新做一个',
  '另外做一个',
  '改做',
  '/newtask',
] as const;

interface CategorySignal {
  readonly category: SessionTitleCategory;
  readonly pattern: RegExp;
}

/**
 * 规则分类的信号表。按得分取最高，得分相同按数组顺序——靠前的类别更具体，
 * 例如「修复登录页布局错乱」同时命中 FIX 与 UI，应当归修复。
 */
const CATEGORY_SIGNALS: readonly CategorySignal[] = [
  { category: 'FIX', pattern: /(bug|报错|异常|崩溃|闪退|不生效|失效|错误|失败|修复|回归|坏掉|不对|错乱|超时)/giu },
  { category: 'TEST', pattern: /(测试|验收|用例|回归测试|质量验证|自检)/giu },
  { category: 'RESEARCH', pattern: /(调研|研究|方案对比|比较|可行性|选型|技术评估)/giu },
  { category: 'DOCUMENTATION', pattern: /(文档|说明书|规范|readme|注释|整理资料)/giu },
  { category: 'ARCHITECTURE', pattern: /(架构|重构|模块|依赖|数据结构|表结构|迁移|接口设计|抽象|分层|执行链)/giu },
  { category: 'UI', pattern: /(界面|布局|样式|配色|视觉|动效|动画|按钮|弹窗|侧栏|字体|图标|主题|间距|ui|ux|css)/giu },
  { category: 'FEATURE', pattern: /(新增|添加|增加|支持|接入|实现|功能|工具|能力|命令|自动化|集成)/giu },
];

/** 一句里最多统计多少个匹配；只是分类用的相对权重，不追求精确。 */
function signalScore(text: string, pattern: RegExp): number {
  const matched = text.match(pattern);
  return matched === null ? 0 : matched.length;
}

export function classifySessionTitleCategory(text: string): SessionTitleCategory {
  const source = text.normalize('NFKC');
  let best: SessionTitleCategory = 'OTHER';
  let bestScore = 0;
  for (const signal of CATEGORY_SIGNALS) {
    const score = signalScore(source, signal.pattern);
    if (score > bestScore) { best = signal.category; bestScore = score; }
  }
  return best;
}

/**
 * 规则任务名：保留有信息量的原文，去掉寒暄、Markdown、链接、Emoji、尾部语气词，
 * 再按码点截断。它不追求像模型那样提炼出「幅度与布局优化」，但必须可读、可核对。
 */
export function ruleTitleSubject(raw: string): string {
  let text = raw.normalize('NFKC');
  // 代码围栏与链接先去掉：它们的正文通常不是任务描述，直接留在标题里会显得又长又乱。
  text = text.replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/\[([^\]]*)\]\(\S*\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, ' ');
  text = text.replace(EMOJI, '').replace(CONTROL, ' ');
  text = text.replace(/\s+/gu, ' ').trim();
  // 行首 Markdown 标记（标题井号、引用、列表项）不进入任务名。
  text = text.replace(/^[#>*-]+\s*/u, '');
  for (let index = 0; index < 3; index += 1) {
    const stripped = text.replace(
      /^(你好|您好|嗨|请|麻烦|帮我|帮忙|能不能|能否|可以|我想|想要|我需要|需要)[\s，,、:：]*/u, '');
    if (stripped === text) break;
    text = stripped;
  }
  text = text.replace(/一下/gu, '');
  text = text.replace(/[。！？!?，,、；;：:…]+$/u, '').trim();
  text = text.replace(/(吧|呢|吗|啊|啦|呀|哈|哦)$/u, '').trim();
  if (text === '') return '';
  return truncateCodepoints(text, RULE_SUBJECT_MAX_CHARS);
}

export function truncateCodepoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * 规则任务名的可用形态：清掉寒暄与结构字符后仍要过格式检查。
 * 只剩「新讨论」「看一下」这类模糊表达时给 `新会话`，不把空话强行拼成正式标题。
 */
export function safeRuleSubject(raw: string): string {
  const subject = ruleTitleSubject(raw);
  return subject !== '' && subjectProblem(subject, MODEL_SUBJECT_MAX_CHARS) === null
    ? subject : '新会话';
}

/**
 * 创建会话时的临时标题。
 *
 * 关联了项目/任务的讨论沿用既有 `关于<目标>`（它是这段讨论的作用域，不是任务判断）；
 * 没有关联目标时，标题只能来自首条消息——这里**必须**给出结构化临时标题，
 * 不再把前 30 个字符原样当标题。
 */
export function provisionalSessionTitle(input: {
  readonly submittedTitle: string;
  readonly scoped: boolean;
}): { readonly title: string; readonly category: SessionTitleCategory | null } {
  const submitted = input.submittedTitle.replace(/\s+/gu, ' ').trim()
    .slice(0, SESSION_TITLE_MAX_LENGTH);
  if (input.scoped) {
    return { title: submitted === '' ? '其他-新会话' : submitted, category: null };
  }
  const category = classifySessionTitleCategory(submitted);
  return { title: buildSessionTitle(category, safeRuleSubject(submitted)), category };
}

export function buildSessionTitle(category: SessionTitleCategory, subject: string): string {
  return `${SESSION_TITLE_CATEGORY_LABELS[category]}-${subject}`;
}

/**
 * 解析一个已经保存的标题。只用于读取与规则判定，不用来「修复」历史标题。
 * 返回 null 表示不是结构化格式（用户手动命名、`关于…` 临时标题或历史标题都属这一类）。
 */
export function parseSessionTitle(title: string): {
  readonly category: SessionTitleCategory;
  readonly subject: string;
} | null {
  const separator = title.indexOf('-');
  if (separator <= 0) return null;
  const label = title.slice(0, separator);
  const category = SESSION_TITLE_CATEGORIES.find((item) =>
    SESSION_TITLE_CATEGORY_LABELS[item] === label);
  if (category === undefined) return null;
  return { category, subject: title.slice(separator + 1) };
}

/**
 * 任务名的格式判定。返回 null 表示通过；否则是给日志与降级用的原因码。
 *
 * 这里不用中文语法判断，只检查**可观察的约定**：有实质内容、不是模糊表达、不写执行状态、
 * 不含结构字符与 Emoji、至少含一个汉字。技术标识随任务名一起保留。
 */
export function subjectProblem(subject: string, maxChars: number): string | null {
  const trimmed = subject.trim();
  if (trimmed === '' || trimmed !== subject) return 'SUBJECT_NOT_TRIMMED';
  if (Array.from(subject).length > maxChars) return 'SUBJECT_TOO_LONG';
  if (VAGUE_SUBJECTS.has(subject)) return 'SUBJECT_VAGUE';
  if (STATE_SUBJECT_PREFIX.test(subject)) return 'SUBJECT_IS_STATE';
  if (MARKDOWN_STRUCTURE.test(subject)) return 'SUBJECT_MARKDOWN';
  if (EMOJI.test(subject)) return 'SUBJECT_EMOJI';
  if (!/\p{Script=Han}/u.test(subject)) return 'SUBJECT_NOT_CHINESE';
  const meaningful = subject.match(/[\p{L}\p{N}]/gu) ?? [];
  if (meaningful.length < 2) return 'SUBJECT_TOO_SHORT';
  return null;
}

/**
 * 模型输出的完整校验：先认分类与任务名，再按同一套格式判定。
 * 返回 null 表示这一条不能落库，调用方改用规则降级。
 */
export function validatedModelTitle(candidate: {
  readonly category: unknown;
  readonly subject: unknown;
}): { readonly title: string; readonly category: SessionTitleCategory } | null {
  if (typeof candidate.category !== 'string') return null;
  if (typeof candidate.subject !== 'string') return null;
  const category = SESSION_TITLE_CATEGORIES.find((item) => item === candidate.category);
  if (category === undefined) return null;
  const subject = candidate.subject.replace(/\s+/gu, ' ').trim();
  if (subjectProblem(subject, MODEL_SUBJECT_MAX_CHARS) !== null) return null;
  const title = buildSessionTitle(category, subject);
  return isStructuredSessionTitle(title) ? { title, category } : null;
}

/** 已保存标题是否满足 `分类-任务名` 与任务名要求。 */
export function isStructuredSessionTitle(title: string): boolean {
  if (title.length > SESSION_TITLE_MAX_LENGTH) return false;
  const parsed = parseSessionTitle(title);
  if (parsed === null) return false;
  return subjectProblem(parsed.subject, MODEL_SUBJECT_MAX_CHARS) === null;
}

/** 用户消息是否明确切换到新任务；只有明确标记才允许自动重新命名。 */
export function hasExplicitNewTaskMarker(text: string): boolean {
  return NEW_TASK_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 解析模型 JSON 输出。接受标准 JSON 与无语言标注的代码围栏；
 * 其它形状（数组、多段、带额外字段）一律拒绝，不让「差不多」进入标题。
 */
export function parseModelTitleOutput(content: string): {
  readonly category: string;
  readonly subject: string;
} | null {
  let text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  if (fenced !== null) text = fenced[1]!.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('category') || !keys.includes('subject')) return null;
  const record = parsed as { category?: unknown; subject?: unknown };
  if (typeof record.category !== 'string' || typeof record.subject !== 'string') return null;
  return { category: record.category, subject: record.subject };
}
