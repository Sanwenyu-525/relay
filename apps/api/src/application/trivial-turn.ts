/**
 * 纯寒暄/致谢/确认轮（2026-11-10）。
 *
 * 用途只有一个：让**辅助外呼**（会话标题、记忆提取）在「你好」「谢谢」这类轮次上
 * 不做一次真实模型调用。它不参与主流程路由——主 Agent 仍然照常读系统提示词并自行
 * 决定要不要用工具；按文本把寒暄改走另一条生成路径，会让「帮我看看 README」失去
 * 工具能力（见 `conversation-prompts.ts` 里同一段边界）。
 *
 * 判据刻意保守：整条消息只由礼貌用语与标点组成才算。任何具体名词、动作、问题或
 * 否定词都会让它在第一步就返回 false；漏判只多一次辅助外呼，误判会丢用户事实。
 */

/** 超过这个长度就不再是「一句话寒暄」，不做逐段匹配。 */
const MAX_TRIVIAL_CHARS = 24;

/** 单个分段（按标点切开后）允许的整句礼貌用语。 */
const TRIVIAL_PHRASES: ReadonlySet<string> = new Set([
  '你好', '您好', '你好呀', '您好呀', '嗨', '嗨呀', '哈喽', '哈啰', 'hi', 'hello', 'hey',
  '在吗', '在么', '在不在', '早', '早安', '早上好', '中午好', '下午好', '晚上好', '晚安',
  '谢谢', '谢谢你', '谢谢您', '谢谢啦', '多谢', '多谢了', '感谢', '感谢你', '感谢啦',
  '谢了', '辛苦了', '麻烦你了', '辛苦了呀',
  '好的', '好', '好呀', '好哒', '好嘞', '行', '可以', '没问题', '收到', '明白', '明白了',
  '懂了', '了解', '嗯', '嗯嗯', '哦', '哦哦', 'ok', 'okay', '好滴',
  '再见', '拜拜', 'bye', '回见', '回头见', '测试', 'test', 'testing', '1',
]);

/** 中英文标点与空白都当作分段边界：`谢谢，辛苦了！` 与 `谢谢 辛苦了` 等价。 */
const SEGMENT_SEPARATOR = /[\s,.!?;:~，。！？；：、…—–\-（）()【】\[\]"'“”‘’/\\]+/u;

/**
 * 整条消息是否只是寒暄/致谢/确认。
 *
 * 空消息返回 false：空内容不是「寒暄轮」，调用方应当按自己的输入缺失规则处理。
 */
export function isTrivialConversationTurn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (Array.from(trimmed).length > MAX_TRIVIAL_CHARS) return false;
  const segments = trimmed.toLowerCase().split(SEGMENT_SEPARATOR)
    .filter((segment) => segment !== '');
  if (segments.length === 0 || segments.length > 3) return false;
  return segments.every((segment) => TRIVIAL_PHRASES.has(segment));
}
