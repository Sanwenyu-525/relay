import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * AI 活动区的阅读密度（2026-10-29 P2）。
 *
 * 三个档只改**视图**，不改事实：不隐藏失败、不隐藏审批、不改任何计数，也不影响
 * 服务端的运行逻辑。因此这里的取舍是「先看什么」，不是「看不看得到什么」：
 *
 *   * concise  —— 只留活动摘要、必要异常与最终回复。正常完成的工具行不逐条展开。
 *   * standard —— 摘要 + 关键工具与文件变化（默认）。
 *   * detailed —— 所有可用活动逐条列出，第三层技术详情默认展开。
 *
 * 关键风险信息（审批、被拒、未知、读取失效）在三个档里都必须可见，
 * 这条由 `mustShowActivity()` 一处判定，界面不得在 concise 档里自己再过滤一次。
 */

export type ActivityDensity = "concise" | "standard" | "detailed";

export const ACTIVITY_DENSITY_STORAGE_KEY = "relay.workbench.activityDensity";
const changeEvent = "relay-activity-density-change";
const densities: readonly ActivityDensity[] = ["concise", "standard", "detailed"];
const fallback: ActivityDensity = "standard";

export const ACTIVITY_DENSITY_LABEL: Readonly<Record<ActivityDensity, string>> = {
  concise: "简洁",
  standard: "标准",
  detailed: "详细",
};

function isDensity(value: unknown): value is ActivityDensity {
  return typeof value === "string" && (densities as readonly string[]).includes(value);
}

function readSnapshot(): string | null {
  try { return window.localStorage.getItem(ACTIVITY_DENSITY_STORAGE_KEY); }
  catch { return null; }
}

function parse(raw: string | null): ActivityDensity {
  return isDensity(raw) ? raw : fallback;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACTIVITY_DENSITY_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 本设备活动密度的唯一写入入口；不保存项目、任务或执行状态。 */
export function saveActivityDensity(next: ActivityDensity): void {
  if (!isDensity(next)) throw new Error("请选择有效的活动阅读密度。");
  try {
    window.localStorage.setItem(ACTIVITY_DENSITY_STORAGE_KEY, next);
  } catch { /* 存储不可用时只是不记住选择，视图照旧生效在内存里 */ }
  window.dispatchEvent(new Event(changeEvent));
}

export function useActivityDensity(): {
  readonly density: ActivityDensity;
  readonly setDensity: (next: ActivityDensity) => void;
} {
  const raw = useSyncExternalStore(subscribe, readSnapshot, () => null);
  const density = useMemo(() => parse(raw), [raw]);
  const setDensity = useCallback((next: ActivityDensity) => saveActivityDensity(next), []);
  return { density, setDensity };
}

/**
 * 这一行在**任何**密度下都必须显示吗？
 *
 * 审批待决、被拒/放弃、结果未知、以及「已结算但回执失败」都属于风险信息：
 * 简洁档把它们折起来会让用户以为一切顺利，所以它们无条件保留。
 * 这条判定放在模型层，视图只消费结果——避免两个组件各自写一份过滤条件。
 */
export function mustShowActivity(tone: "active" | "attention" | "negative" | "neutral",
  failed: boolean): boolean {
  return tone === "attention" || tone === "negative" || failed;
}

/** 第三层技术详情在某个密度下是否默认展开。用户手动开合永远优先于这个默认值。 */
export function detailOpenByDefault(density: ActivityDensity): boolean {
  return density === "detailed";
}
