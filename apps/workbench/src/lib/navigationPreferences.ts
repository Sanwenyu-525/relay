import { useSyncExternalStore } from "react";

/**
 * 导航栏位置（UI-NAV-01 双导航布局）：`sidebar` 左侧图标导航栏，`titlebar` 标题栏横向导航。
 *
 * 纯本设备展示偏好，与 relay.workbench.displayPreferences 分键保存——那边是 version 1 的
 * 严格校验结构，为避免改写旧值的解析与回落语义，这里独立一个键；读写入口只有本模块一个，
 * 不存在第二个写入方。非法值与存储不可读一律回落 `sidebar`，保证老用户与异常环境
 * 都落在既有布局上。
 */

export type NavigationPlacement = "sidebar" | "titlebar";

export const NAVIGATION_PLACEMENT_STORAGE_KEY = "relay.workbench.navigationPlacement";
const changeEvent = "relay-navigation-placement-change";
const placements: readonly NavigationPlacement[] = ["sidebar", "titlebar"];

function parsePlacement(value: string | null): NavigationPlacement {
  return placements.includes(value as NavigationPlacement) ? (value as NavigationPlacement) : "sidebar";
}

function readSnapshot(): string | null {
  try { return window.localStorage.getItem(NAVIGATION_PLACEMENT_STORAGE_KEY); }
  catch { return null; }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === NAVIGATION_PLACEMENT_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 导航栏位置的唯一写入入口；写失败向上抛，由调用方反馈，不伪称已保存。 */
export function saveNavigationPlacement(value: NavigationPlacement): void {
  window.localStorage.setItem(NAVIGATION_PLACEMENT_STORAGE_KEY, value);
  window.dispatchEvent(new Event(changeEvent));
}

export function useNavigationPlacement(): NavigationPlacement {
  const raw = useSyncExternalStore(subscribe, readSnapshot, () => null);
  return parsePlacement(raw);
}
