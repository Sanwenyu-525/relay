/**
 * 模型选择的本机偏好（2026-10-20 引入，2026-11-04 MODEL-SETTINGS-03 起**不再参与发送**）。
 *
 * 旧行为：新会话的首条输入器从这里的值种下初值，发送时提交成一次 SelectSessionModel。
 * 那会让本机历史偏好悄悄覆盖「工作区聊天默认连接」——用户改了默认连接，新会话却仍用
 * 上次的型号。现在优先级统一为「会话显式选择 > 工作区聊天默认 > 进程默认」，首条发送
 * 只提交用户在这一次里真正点选的选择。
 *
 * 模块保留有两个理由：读回旧键的行为仍需要可测试（旧版本的写入不能被新版本读成业务
 * 事实）；以及测试用它证明「本机有历史偏好时，发送路径仍然忽略它」。
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
