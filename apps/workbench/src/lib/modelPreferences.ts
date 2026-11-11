/**
 * 模型选择的本机偏好（2026-10-20 引入；2026-11-04 MODEL-SETTINGS-03 曾停用；
 * 2026-11-10 按用户指令恢复「新会话沿用上次选择」）。
 *
 * 语义边界：
 * * 只记录**用户显式点选过**的模型/已登记连接，按工作区分区（不同工作区可能连着
 *   不同 API 与目录，型号未必互通）。没有显式选择时仍按「工作区聊天默认 → 进程默认」
 *   解析，本机偏好不冒充默认。
 * * 新会话草稿用它种下初值，芯片从第一帧就写出具体型号或连接声明的型号——这是
 *   屏上可见的显式选择，不是 2026-11-04 修掉的「历史偏好悄悄覆盖工作区默认」。
 * * 存储不可读/不可写时返回 null 或静默跳过，选择本身与发送不受影响。
 */

const PREFIX = "relay.workbench.lastModel";
const VERSION = 1;

/** 上次显式选择：型号，以及（若选的是已登记连接）连接身份。 */
export interface LastModelChoice {
  readonly model: string;
  readonly connectionId: string | null;
}

function storageKey(workspaceId: string): string {
  return `${PREFIX}:${VERSION}:${workspaceId}`;
}

/** 无效、不可读或本机存储不可用时返回 null，调用方按「没有上次选择」处理。 */
export function readLastModelChoice(workspaceId: string): LastModelChoice | null {
  try {
    const stored = window.localStorage.getItem(storageKey(workspaceId));
    const raw: unknown = JSON.parse(stored ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const model = (raw as { model?: unknown }).model;
    if (typeof model !== "string" || model.trim() === "") return null;
    const connectionId = (raw as { connectionId?: unknown }).connectionId;
    return {
      model,
      connectionId: typeof connectionId === "string" && connectionId.trim() !== "" ? connectionId : null
    };
  } catch { return null; }
}

/** 写入上次显式选择；null 或空型号即删除。存储不可写时不阻止选择本身。 */
export function writeLastModelChoice(workspaceId: string, choice: LastModelChoice | null): void {
  try {
    if (choice === null || choice.model.trim() === "") {
      window.localStorage.removeItem(storageKey(workspaceId));
      return;
    }
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(choice.connectionId === null
      ? { model: choice.model }
      : { model: choice.model, connectionId: choice.connectionId }));
  } catch { /* 本机存储不可写（隐私模式/配额）时选择本身不受影响，只是不跨会话记住。 */ }
}
