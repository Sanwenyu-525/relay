/**
 * 近期工作栏的分组折叠状态。
 *
 * 这是纯展示偏好，不是业务事实：它只记住用户手动折叠了哪几个项目分组，
 * 丢失或写不进去时列表按「全部展开」呈现，不影响任何读取、归属或执行准入。
 * 未归入项目的那一组用固定字面量当键，与真实项目 id 不会相撞。
 */
const STORAGE_KEY = "relay.workbench.recentWorkCollapsedGroups";
const VERSION = 1;

/** 未归入项目分组的稳定键；真实项目 id 是 uuid，不会与它相同。 */
export const UNASSIGNED_GROUP_KEY = "unassigned";

export function railGroupKey(projectId: string | null): string {
  return projectId ?? UNASSIGNED_GROUP_KEY;
}

export function readCollapsedRailGroups(): readonly string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw === null || typeof raw !== "object") return [];
    const value = raw as { version?: unknown; groups?: unknown };
    if (value.version !== VERSION || !Array.isArray(value.groups)) return [];
    return value.groups.filter((item): item is string => typeof item === "string");
  } catch { return []; }
}

export function writeCollapsedRailGroups(groups: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, groups: [...groups] }));
  } catch { /* 偏好写不进去时本次会话仍然生效。 */ }
}
