/**
 * 近期目录只是本设备的展示偏好（领域模型 §12.2）：它不构成资源身份，
 * 也不是授权事实。打开目录时仍由服务端按规范路径与 Windows 物理身份核对。
 */
const KEY = "relay.workbench.recentWorkingDirectories";
const VERSION = 1;
const MAX_ENTRIES = 8;

export interface RecentWorkingDirectory {
  readonly canonicalRoot: string;
  readonly displayName: string;
  readonly openedAt: string;
}

export function readRecentWorkingDirectories(): readonly RecentWorkingDirectory[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== VERSION) return [];
    const items = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is RecentWorkingDirectory => typeof item === "object" && item !== null &&
      typeof (item as RecentWorkingDirectory).canonicalRoot === "string" &&
      typeof (item as RecentWorkingDirectory).displayName === "string" &&
      typeof (item as RecentWorkingDirectory).openedAt === "string").slice(0, MAX_ENTRIES);
  } catch { return []; }
}

export function rememberWorkingDirectory(canonicalRoot: string, displayName: string,
  openedAt: string): readonly RecentWorkingDirectory[] {
  const next = [{ canonicalRoot, displayName, openedAt },
    ...readRecentWorkingDirectories().filter((item) => item.canonicalRoot !== canonicalRoot)]
    .slice(0, MAX_ENTRIES);
  try { window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, entries: next })); }
  catch { /* 偏好写不进去不影响服务端关联。 */ }
  return next;
}

export function forgetWorkingDirectory(canonicalRoot: string): readonly RecentWorkingDirectory[] {
  const next = readRecentWorkingDirectories().filter((item) => item.canonicalRoot !== canonicalRoot);
  try { window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, entries: next })); }
  catch { /* 同上。 */ }
  return next;
}
