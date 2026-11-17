/**
 * 0167：用户“明确要求记住”的确定性识别。
 *
 * 这条路径与自动提取分开，因为两者的可信含义不同：
 *   · 用户明确要求记住 → HUMAN_CONFIRMED + USER_STATEMENT，正文就是用户原话；
 *   · 用户只是随口提及   → 由自动提取判断，最多 AUTO_CAPTURE + UNVERIFIED；
 *   · 模型推断出来的事实 → 只能是 MODEL_OBSERVATION，且不得升级成用户陈述。
 *
 * 这里只做**模式匹配**，不调用模型：识别失败就不写，绝不把“普通对话”全量持久化。
 * 真正决定能否落库的仍是 `createMemoryRecord` 的敏感信息检查、去重与冲突裁决。
 */

export interface ExplicitRememberIntent {
  /** 用户要求保存的内容（已去掉“请记住/以后都”等触发词与尾部客套）。 */
  readonly content: string;
  /** 命中的触发短语，用于回执与审计，不写进记忆正文。 */
  readonly trigger: string;
  /** 从整句推导的记忆类型；UNKNOWN 表示不猜。 */
  readonly memoryType: 'USER_PREFERENCE' | 'PROJECT_FACT' | 'EXPERIENCE' | 'EPISODIC' | 'UNKNOWN';
}

/** 内容太短没有保存价值；太长通常是一段任务说明，应交给自动提取而不是硬存。 */
const MIN_CONTENT_CHARS = 4;
const MAX_CONTENT_CHARS = 500;

const TRAILING_POLITE = /[。.!！?？~～\s]*(谢谢|thanks|thank you|拜托了|麻烦了)?[。.!！?？~～\s]*$/iu;

/** 去掉句尾客套与标点，但不改正文内部措辞。 */
function trimContent(value: string): string {
  return value.replace(TRAILING_POLITE, '').trim();
}

function inferType(content: string): ExplicitRememberIntent['memoryType'] {
  if (/偏好|习惯|喜欢|不喜欢|以后都|今后都|一律|总是|不要再|别再用|always|prefer|never/iu.test(content)) {
    return 'USER_PREFERENCE';
  }
  if (/项目|仓库|代码|构建|部署|数据库|迁移|接口|脚本|路径|依赖|测试|版本|pnpm|npm|git|api|repo/iu
    .test(content)) {
    return 'PROJECT_FACT';
  }
  if (/经验|教训|下次|以后遇到|踩坑|修复方法|workaround/iu.test(content)) return 'EXPERIENCE';
  if (/今天|昨天|这次|这一次|刚才|会议|决定|任务/iu.test(content)) return 'EPISODIC';
  return 'UNKNOWN';
}

/**
 * 识别一个“明确的记住请求”。返回 null 表示这条消息不是记忆指令。
 *
 * 支持的形态（中英文）：
 *   - 请记住：这个仓库用 pnpm 构建
 *   - 记一下，我的默认分支是 main
 *   - 以后都用中文回答
 *   - 别忘记每周五要发周报
 *   - remember that the build uses pnpm
 */
export function detectExplicitRemember(raw: string): ExplicitRememberIntent | null {
  const text = raw.trim();
  if (text === '') return null;

  // 1) 触发词在句首，后面跟冒号/逗号或空格。
  const leading = text.match(
    /^(?:请|帮我|麻烦|你能不能|可以)?\s*(记住|记一下|记下|牢记|别忘了|别忘记|不要忘记|remember)\s*(?:[:：,，]|\s+)\s*(.+)$/isu);
  if (leading !== null && leading[2] !== undefined) {
    const content = trimContent(leading[2]);
    if (content.length >= MIN_CONTENT_CHARS && content.length <= MAX_CONTENT_CHARS) {
      return { content, trigger: leading[1] ?? '记住', memoryType: inferType(content) };
    }
    return null;
  }

  // 2) 触发词在句中（“请记住，……”已被 1 覆盖；这里处理“我想让你记住……”）。
  const embedded = text.match(/记住\s*(?:[:：,，]|\s+)\s*(.+)$/isu);
  if (embedded !== null && embedded[1] !== undefined) {
    const content = trimContent(embedded[1]);
    if (content.length >= MIN_CONTENT_CHARS && content.length <= MAX_CONTENT_CHARS) {
      return { content, trigger: '记住', memoryType: inferType(content) };
    }
    return null;
  }

  // 3) “以后/今后都……”是用户对未来行为的明确要求，本身就是可保存的偏好。
  const future = text.match(/^(?:以后|今后|后续|从现在开始)\s*(?:都|请|一律|要|必须|只)?\s*(.+)$/isu);
  if (future !== null && future[1] !== undefined) {
    // 避免把“以后再说”“以后有空”这类含糊语句当成偏好。
    if (!/再说|有空|看情况|到时候|再说吧/iu.test(future[1])) {
      const content = trimContent(text);
      if (content.length <= MAX_CONTENT_CHARS) {
        return { content, trigger: '以后都', memoryType: 'USER_PREFERENCE' };
      }
    }
  }

  // 4) 英文 remember 开头（前面已处理冒号/空格形式），允许 "remember to ..."。
  const english = text.match(/^(?:please\s+)?remember\s+(?:that\s+|to\s+)?(.+)$/iu);
  if (english !== null && english[1] !== undefined) {
    const content = trimContent(english[1]);
    if (content.length >= MIN_CONTENT_CHARS && content.length <= MAX_CONTENT_CHARS) {
      return { content, trigger: 'remember', memoryType: inferType(content) };
    }
  }
  return null;
}

/** 记忆标题：取内容首句/前 32 字符，去换行；不是模型生成的摘要。 */
export function explicitMemoryTitle(content: string): string {
  const first = content.split(/[。！？!?\n]/u)[0]?.trim() ?? content;
  const clipped = first.length > 32 ? `${first.slice(0, 31)}…` : first;
  return clipped === '' ? '用户要求记住的事项' : clipped;
}
