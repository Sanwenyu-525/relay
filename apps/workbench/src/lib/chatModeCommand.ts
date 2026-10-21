/**
 * 0127：`/plan` 与 `/goal` 的输入解析（工作台 §44.1）。
 *
 * 与 `chatControls.ts` 分开维护：那五个系统命令「只发命令」，这两条是**命令 + 正文**——
 * 命令决定模式，正文就是这一轮要说的话。解析结果因此是「模式 + 剩余正文」，
 * 由调用的发送路径一次提交（`chat_mode` 随消息进同一命令）。
 *
 * 只认行首：正文中间、代码块里的 `/plan` 都不是命令。名称后必须紧跟空白或结束，
 * 因此 `/plan-mode` 这类标识不会被误判。
 */
export type ChatModeCommand = {
  readonly mode: "PLAN" | "GOAL";
  /** 命令之后的正文；空串表示只切模式、不发送消息。 */
  readonly rest: string;
};

const NAMES: Record<string, "PLAN" | "GOAL"> = {
  plan: "PLAN", "计划": "PLAN",
  goal: "GOAL", "目标": "GOAL",
};

export function chatModeCommandFromText(text: string): ChatModeCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("```")) return null;
  // 名称后必须是空白或输入结束；用 `/([^\s/]+)(?=\s|$)/` 与 chatControls 同一形状。
  const match = /^\/([^\s/]+)(?=\s|$)/u.exec(trimmed);
  if (match === null) return null;
  const mode = NAMES[match[1]!.toLowerCase()];
  if (mode === undefined) return null;
  return { mode, rest: trimmed.slice(match[0].length).trim() };
}
