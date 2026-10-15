import { currentBuiltinMethod, type BuiltinMethodId, type MethodActionKind,
  type MethodActionScope } from '../skills/builtin-methods.js';

/**
 * 自然语言方法识别（docs/architecture/relay-skills.md §9.2，测试计划 BC-02/BC-03）。
 *
 * 这是**确定性规则**，不是模型调用：只回答「这句话在谈哪个方法、是讨论还是执行、范围多大」。
 * 它刻意保守——识别不出方法就返回 null，交给既有意图解释；识别出「讨论」时明确标为
 * DISCUSS，避免把「谈谈如何修复」当成写文件授权。
 *
 * 与授权的关系：这里只产出**候选方法与本次行动**，不产生任何权限。实际写入仍走原
 * Task/Run/Gateway 与领域 Owner；`MODIFY` 只是「用户本次明确要求修改」，不是绕过准入。
 */

export interface MethodIntent {
  readonly method_id: BuiltinMethodId;
  readonly action: MethodActionKind;
  readonly scope: MethodActionScope;
  /** 作用范围是否由用户显式声明（"全项目"）；否则取方法默认范围。 */
  readonly explicit_scope: boolean;
  /** 本次只是在讨论该工作方法：不执行、不修改，也不构成任何授权。 */
  readonly discussion: boolean;
  /** 命中的触发词，供回执显示"本次采用的方法及范围"的依据。 */
  readonly matched: readonly string[];
}

const DISCUSS_MARKERS = ['讨论', '聊聊', '谈谈', '介绍', '讲解', '什么是', '是什么',
  '怎么理解', '如何理解', '原理', '区别', '科普', '想知道', '评价'];

const MODIFY_MARKERS = ['修好', '修复', '改好', '修一下', '帮我修', '直接改', '改一下',
  '更新文档', '维护文档', '整理文档', '同步文档', '补文档', '更新一下文档'];

const PROJECT_SCOPE_MARKERS = ['全项目', '整个项目', '全仓', '整个仓库', '全部文件',
  '所有文件', '全站', '整个代码库', '整个代码仓'];

/** 通用"文档"一词只有与检查/维护动作同现时才认作文档维护，避免"写个文档"被误判。 */
const DOCS_GENERIC = '文档';
const DOCS_ACTION_MARKERS = ['检查', '核对', '看看', '查看', '审查', '评审', '更新',
  '维护', '整理', '同步', '过期', '不一致', '没更新', '没同步', '对不上'];

const TRIGGERS: Readonly<Record<BuiltinMethodId, readonly string[]>> = {
  'code-review': ['代码审查', '代码评审', '代码检查', '检查代码', '看看代码', '审一下',
    '审查', '评审', 'review'],
  'fault-diagnosis': ['故障诊断', '诊断', '排查', '定位问题', '故障', '报错', '崩溃',
    '异常', 'bug', '启动失败', '运行失败', '构建失败', '一直失败', '失败原因'],
  'docs-maintenance': ['文档维护', '更新文档', '维护文档', '整理文档', '同步文档',
    '文档同步', '文档过期', '文档不一致', '文档没更新', '检查文档', '核对文档', 'readme'],
};

/** 方法优先级只在命中位置相同（例如同一句里同时出现两个词）时用于稳定排序。 */
const METHOD_ORDER: readonly BuiltinMethodId[] =
  ['code-review', 'fault-diagnosis', 'docs-maintenance'];

function firstIndex(text: string, phrases: readonly string[]): { index: number;
  phrase: string } | null {
  let best: { index: number; phrase: string } | null = null;
  for (const phrase of phrases) {
    const index = text.indexOf(phrase);
    if (index === -1) continue;
    if (best === null || index < best.index ||
        index === best.index && phrase.length > best.phrase.length) {
      best = { index, phrase };
    }
  }
  return best;
}

function matchedMarkers(text: string, markers: readonly string[]): readonly string[] {
  return markers.filter((marker) => text.includes(marker));
}

/**
 * 识别本次输入涉及的方法与行动。
 *
 * * 只命中"讨论"标记 → DISCUSS（不执行）。
 * * 命中"修好/修复/更新文档"等明确请求 → MODIFY。
 * * 其余命中 → INSPECT（默认：复现/定位/报告）。
 * * 未命中任何方法触发词 → null。
 */
export function detectMethodIntent(rawText: string): MethodIntent | null {
  const text = rawText.toLowerCase();
  const hits: { method: BuiltinMethodId; index: number; phrase: string }[] = [];
  for (const method of METHOD_ORDER) {
    const hit = firstIndex(text, TRIGGERS[method]);
    if (hit !== null) hits.push({ method, index: hit.index, phrase: hit.phrase });
  }
  if (text.includes(DOCS_GENERIC) &&
      DOCS_ACTION_MARKERS.some((marker) => text.includes(marker)) &&
      !hits.some((hit) => hit.method === 'docs-maintenance')) {
    hits.push({ method: 'docs-maintenance', index: text.indexOf(DOCS_GENERIC), phrase: DOCS_GENERIC });
  }
  if (hits.length === 0) return null;
  hits.sort((left, right) => left.index - right.index ||
    METHOD_ORDER.indexOf(left.method) - METHOD_ORDER.indexOf(right.method));
  const winner = hits[0]!;
  const definition = currentBuiltinMethod(winner.method)!.definition;

  const discuss = matchedMarkers(text, DISCUSS_MARKERS);
  const modify = matchedMarkers(text, MODIFY_MARKERS);
  // "讨论"优先于"修好"：谈方法不构成执行授权，因此讨论时一律落在只读的 INSPECT。
  const discussion = discuss.length > 0;
  const action: MethodActionKind = discussion ? 'INSPECT'
    : modify.length > 0 && definition.modify_when_requested ? 'MODIFY' : 'INSPECT';
  const projectScope = matchedMarkers(text, PROJECT_SCOPE_MARKERS);
  const explicitScope = projectScope.length > 0;
  const matched = [winner.phrase, ...(discussion ? discuss : modify), ...projectScope];
  return { method_id: winner.method, action, discussion,
    scope: explicitScope ? 'PROJECT' : definition.default_scope,
    explicit_scope: explicitScope,
    matched: [...new Set(matched)] };
}

/** 本次识别是否只是"讨论方法"（供回执区分：讨论不执行，也不插入菜单动作）。 */
export function isMethodDiscussion(rawText: string): boolean {
  return matchedMarkers(rawText.toLowerCase(), DISCUSS_MARKERS).length > 0;
}

/** 方法命令已给出身份，参数只决定本次是否明确要求修改。 */
export function methodActionForArgument(rawText: string): MethodActionKind {
  const text = rawText.toLowerCase();
  return !isMethodDiscussion(text) && matchedMarkers(text, MODIFY_MARKERS).length > 0
    ? 'MODIFY' : 'INSPECT';
}
