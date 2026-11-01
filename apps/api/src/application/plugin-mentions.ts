/**
 * 服务端识别的内置插件 mention（2026-11-01 COMPUTER-PLUGIN-E2E）。
 *
 * 输入器里的 `@电脑操控` 此前只是展示层芯片，服务端只看到一段普通文本。模型因此可以把
 * 一条明确的电脑操作请求读成普通讨论，或在正文里写「执行请求已交给后台」却什么都没发生。
 *
 * 这里只做**识别**，不产生授权，也不新建执行路径：识别结果作为一条服务端事实拼进本轮
 * system，让模型知道「用户这次明确选了哪个插件」；真正的候选校验、连接准入、Runtime 与
 * 审批仍走 `conversation-execution` / Gateway 原有入口。
 *
 * 标签集合必须与工作台 `apps/workbench/src/lib/pluginMentions.ts` 的展示集合保持一致：
 * 两处是同一份用户可见标签。工作台负责画芯片，这里负责让服务端读懂同一个标签。
 */

export type KnownPluginKey = 'computer' | 'browser' | 'github';

export const KNOWN_PLUGIN_MENTIONS: readonly {
  readonly key: KnownPluginKey;
  readonly label: string;
}[] = [
  { key: 'computer', label: '电脑操控' },
  { key: 'browser', label: '浏览器操控' },
  { key: 'github', label: 'GitHub' },
];

export interface KnownPluginMention {
  readonly key: KnownPluginKey;
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

const MENTION_PATTERN = /@(电脑操控|浏览器操控|GitHub)/gu;
/** 单词/路径字符：出现它们说明 `@` 或标签是更长 token 的一部分。不含 `@` 本身。 */
const TOKEN_CHAR = /[A-Za-z0-9_./\\-]/u;
const CJK_CHAR = /[\u4e00-\u9fff]/u;

export function findKnownPluginMentions(text: string): readonly KnownPluginMention[] {
  const matches: KnownPluginMention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const label = match[1] as string;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = start === 0 ? '' : text[start - 1]!;
    const after = end >= text.length ? '' : text[end]!;
    const followsPrevious = matches.length > 0 && matches[matches.length - 1]!.end === start;
    if (!followsPrevious && before !== '' && TOKEN_CHAR.test(before)) continue;
    if (after !== '' && (TOKEN_CHAR.test(after) || CJK_CHAR.test(after))) continue;
    const entry = KNOWN_PLUGIN_MENTIONS.find((item) => item.label === label);
    if (entry !== undefined) matches.push({ ...entry, start, end });
  }
  return matches;
}
