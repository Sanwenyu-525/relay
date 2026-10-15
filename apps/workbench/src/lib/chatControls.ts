/** 只分流系统命令；方法、参数与动作准入仍由后端决定。 */
export function chatControlFromText(text: string): "clear" | "new" | "undo" | "model" | "compact" | null {
  const token = /^\/([^\s/]+)(?=\s|$)/u.exec(text.trim())?.[1]?.toLowerCase();
  switch (token) {
    case "clear": case "新会话": case "清空": return "clear";
    case "new": case "新对话": return "new";
    case "undo": case "撤回": return "undo";
    case "model": case "模型": return "model";
    case "compact": case "压缩": return "compact";
    default: return null;
  }
}
