import type { PluginIconKey } from "../components/PluginIcon";

/**
 * 已知插件 mention 的展示层识别（2026-10-25）。
 *
 * 只识别明确的三个内置插件 mention：`@电脑操控`、`@浏览器操控`、`@GitHub`。
 * 这是**展示层增强**（输入器徽标、消息里的小图标），不是第二份插件状态：
 * 草稿与消息仍以纯文本为准，识别结果不落库、不参与发送载荷。
 *
 * 边界规则保证不误识别：
 * - `@` 前必须是行首、非「单词字符/路径字符」，或恰好紧贴上一个已接受 mention 的结尾
 *   （挡住 `user@GitHub` 邮箱、`src/@x` 路径、`@GitHubX`；放行 `@GitHub@浏览器操控`
 *   这种手动连着输入的相邻 mention——第二个 `@` 前的字母属于上一个 mention，
 *    不是更长词的一部分）；
 * - 标签后必须是结尾或非「单词字符/路径字符」，且不能紧跟汉字
 *   （挡住 `@GitHubX`、`@电脑操控一下` 这类「更长词的一部分」）。`@` 不算单词字符：
 *   相邻 mention 之间只有它。
 */

export const PLUGIN_MENTIONS = [
  { key: "computer", label: "电脑操控" },
  { key: "browser", label: "浏览器操控" },
  { key: "github", label: "GitHub" }
] as const satisfies readonly { key: PluginIconKey; label: string }[];

export interface PluginMentionMatch {
  readonly key: PluginIconKey;
  readonly label: string;
  /** mention 在原文中的起止偏移（含 `@`，不含尾随空格）。 */
  readonly start: number;
  readonly end: number;
}

const MENTION_PATTERN = /@(电脑操控|浏览器操控|GitHub)/gu;
/** 单词/路径字符：出现它们说明 `@` 或标签是更长 token 的一部分。不含 `@` 本身——
 *  相邻 mention（`@GitHub@浏览器操控`）之间只隔一个 `@`，它不是单词的一部分。 */
const TOKEN_CHAR = /[A-Za-z0-9_./\\-]/u;
const CJK_CHAR = /[\u4e00-\u9fff]/u;

export function findPluginMentions(text: string): readonly PluginMentionMatch[] {
  const matches: PluginMentionMatch[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const label = match[1] as string;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = start === 0 ? "" : text[start - 1]!;
    const after = end >= text.length ? "" : text[end]!;
    /* 紧贴上一个已接受 mention 的结尾：那个「前字符」是上一个 mention 的尾字母，
       不是把当前 mention 接进更长词里的字符，放行（@GitHub@浏览器操控）。 */
    const followsPrevious = matches.length > 0 && matches[matches.length - 1]!.end === start;
    if (!followsPrevious && before !== "" && TOKEN_CHAR.test(before)) continue;
    if (after !== "" && (TOKEN_CHAR.test(after) || CJK_CHAR.test(after))) continue;
    const entry = PLUGIN_MENTIONS.find((item) => item.label === label);
    if (entry !== undefined) matches.push({ ...entry, start, end });
  }
  return matches;
}
