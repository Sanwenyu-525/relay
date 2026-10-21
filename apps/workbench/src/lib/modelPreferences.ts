/**
 * 模型选择的本机偏好（2026-10-20 用户指令「记住上一次选择的模型，不要每个新会话都先显示
 * 「模型」两个字」）。
 *
 * 只记住「上一次选的是哪个型号」，供新对话的首条输入器做初始显示，并在首条发送时随
 * createAssistSession 的 modelSelection 绑定给新会话。它**不是**业务事实：
 * - 会话自己的首选仍以服务端 model-selection 为唯一事实；没有选择的会话不会拿这里的值
 *   冒充当前生效模型（服务端对无选择会话沿用应用默认）。
 * - 目录、资料、Skill 选择不在这里持久化——那些是「本次请求的候选输入」，发送时服务端
 *   重新复核（与 composerDrafts 同一条边界）。
 * 按 workspace 分开存：不同工作区可能连着不同 API 与目录，型号未必互通。
 */

const PREFIX = "relay.workbench.lastModel";
const VERSION = 1;

function storageKey(workspaceId: string): string {
  return `${PREFIX}:${VERSION}:${workspaceId}`;
}

/** 无效、不可读或本机存储不可用时返回 null，调用方按「没有上次选择」处理。 */
export function readLastModel(workspaceId: string): string | null {
  try {
    const stored = window.localStorage.getItem(storageKey(workspaceId));
    const raw: unknown = JSON.parse(stored ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const model = (raw as { model?: unknown }).model;
    return typeof model === "string" && model.trim() !== "" ? model : null;
  } catch { return null; }
}

/** 写入上次选择；空值即删除。存储不可写时不阻止选择本身，只是不跨会话记住。 */
export function writeLastModel(workspaceId: string, model: string): void {
  try {
    if (model.trim() === "") { window.localStorage.removeItem(storageKey(workspaceId)); return; }
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify({ model }));
  } catch { /* 本机存储不可写（隐私模式/配额）时选择本身不受影响，只是不跨会话记住。 */ }
}
