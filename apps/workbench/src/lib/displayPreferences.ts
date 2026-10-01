import { useMemo, useSyncExternalStore } from "react";
import type { RelayViewKind } from "../api/relayClient";

export interface DisplayPreferences {
  readonly timeZone: string;
  /** null 表示本设备尚未保存默认工作台，继续沿用项目初始视图。 */
  readonly defaultWorkbench: RelayViewKind | null;
}

export const DISPLAY_PREFERENCES_STORAGE_KEY = "relay.workbench.displayPreferences";
const changeEvent = "relay-display-preferences-change";
const defaults: DisplayPreferences = { timeZone: "Asia/Shanghai", defaultWorkbench: null };

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { new Intl.DateTimeFormat("zh-CN", { timeZone: value }); return true; }
  catch { return false; }
}

function readSnapshot(): string | null {
  try { return window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY); }
  catch { return null; }
}

function parsePreferences(raw: string | null): DisplayPreferences {
  if (raw === null) return defaults;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return defaults;
    const stored = value as Record<string, unknown>;
    if (stored.version !== 1 || !validTimeZone(stored.timeZone) ||
      typeof stored.defaultWorkbench !== "string" ||
      !["general", "thesis", "development"].includes(stored.defaultWorkbench)) return defaults;
    return { timeZone: stored.timeZone, defaultWorkbench: stored.defaultWorkbench as RelayViewKind };
  } catch { return defaults; }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DISPLAY_PREFERENCES_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 本设备显示偏好的唯一写入入口；不保存项目、任务或执行状态。 */
export function saveDisplayPreferences(preferences: { readonly timeZone: string;
  readonly defaultWorkbench: RelayViewKind }): void {
  if (!validTimeZone(preferences.timeZone) ||
    !["general", "thesis", "development"].includes(preferences.defaultWorkbench)) {
    throw new Error("请选择有效的界面时区和默认工作台。");
  }
  window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ version: 1, ...preferences }));
  window.dispatchEvent(new Event(changeEvent));
}

export function useDisplayPreferences(): DisplayPreferences {
  const raw = useSyncExternalStore(subscribe, readSnapshot, () => null);
  return useMemo(() => parsePreferences(raw), [raw]);
}

/** 只做展示转换：返回本设备显示时区下的可读日期时间，不可解析时原样返回，原始串仍由调用方放进 time.dateTime。 */
export function formatReadableDateTime(value: string, timeZone: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(new Date(at)).replaceAll("/", "-");
}
