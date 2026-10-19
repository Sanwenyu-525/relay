import { useSyncExternalStore } from "react";

/**
 * 对话执行候选（服务端从原用户消息整理出的「计划」）生成后的执行方式。
 *
 * 这只是**本设备**的界面偏好：不改变服务端准入、本次任务范围授权或 DELETE 确切确认，
 * 也不把候选本身变成写权限；授权来源始终是最初那条用户消息。选「人工确认」时界面
 * 保留「按这个目标执行」按钮，点击后才沿原 request_id 进入 Task/Run 应用入口。
 */
export type PlanExecutionMode = "AUTO" | "CONFIRM";

export const PLAN_EXECUTION_STORAGE_KEY = "relay.workbench.planExecution";
const changeEvent = "relay-plan-execution-preference-change";
/** 没有本设备选择时维持既有行为：服务端标记就绪的候选直接沿原入口启动。 */
const DEFAULT_MODE: PlanExecutionMode = "AUTO";

function parseMode(value: unknown): PlanExecutionMode | null {
  return value === "AUTO" || value === "CONFIRM" ? value : null;
}

function readSnapshot(): PlanExecutionMode {
  try {
    // 没有本设备选择或本地值无法识别时都回落默认：不把无法解析的旧内容猜成某一种方式。
    return parseMode(window.localStorage.getItem(PLAN_EXECUTION_STORAGE_KEY)) ?? DEFAULT_MODE;
  } catch {
    // 隐私模式或存储不可读时按默认方式走，不因此让对话页起不来。
    return DEFAULT_MODE;
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === PLAN_EXECUTION_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener(changeEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 唯一写入入口；存储不可写时抛错，由设置页保留旧值并说明，不静默吞掉。 */
export function savePlanExecutionMode(mode: PlanExecutionMode): void {
  if (parseMode(mode) === null) throw new Error("请选择有效的计划执行方式。");
  window.localStorage.setItem(PLAN_EXECUTION_STORAGE_KEY, mode);
  window.dispatchEvent(new Event(changeEvent));
}

export function usePlanExecutionMode(): PlanExecutionMode {
  return useSyncExternalStore(subscribe, readSnapshot, () => DEFAULT_MODE);
}
