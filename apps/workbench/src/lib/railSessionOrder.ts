/**
 * 近期工作栏里会话行的手动顺序（拖拽落位的结果）。
 *
 * 与分组折叠状态同类，是**本机导航偏好**，不是业务事实：服务端的列表读回来仍按它自己的
 * 排序键（置顶时刻、创建时间），这里只决定这一列把已经排过的行显示成什么次序。
 * 读不到、值不合法或写不进去时回到服务端顺序，不影响读取、归属、权限或执行准入。
 *
 * 只存未归档会话的 id；归档、重开或改名都不动这一份顺序。换设备或清本机存储即丢失，
 * 丢失的代价是「回到服务端排序」，不丢任何会话、消息或回执。
 */
const STORAGE_KEY = "relay.workbench.recentWorkSessionOrder";
const VERSION = 1;

export function readRailSessionOrder(): readonly string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw === null || typeof raw !== "object") return [];
    const value = raw as { version?: unknown; sessions?: unknown };
    if (value.version !== VERSION || !Array.isArray(value.sessions)) return [];
    return value.sessions.filter((item): item is string => typeof item === "string");
  } catch { return []; }
}

export function writeRailSessionOrder(sessions: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, sessions: [...sessions] }));
  } catch { /* 偏好写不进去时本次会话仍然生效。 */ }
}
