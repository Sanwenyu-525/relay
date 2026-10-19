/**
 * BrowserSessionManager 的进程级持有者（F26）。
 *
 * 与 `computer/client-holder.ts` 同一形态：Worker 进程内共享一个管理器，
 * 浏览器实例随它启停；测试用 replaceBrowserSessionManagerForTest 注入替身。
 */

import { BrowserSessionManager } from './session-manager.js';

let shared: BrowserSessionManager | null = null;

function dataRoot(): string {
  const value = process.env.RELAY_DATA_ROOT;
  return value !== undefined && value !== '' ? value : process.cwd();
}

export function getBrowserSessionManager(): BrowserSessionManager {
  if (shared === null) shared = new BrowserSessionManager({ dataRoot: dataRoot() });
  return shared;
}

/** 只读访问：不启动后端，仅回答"有没有已经建好的管理器"。 */
export function peekBrowserSessionManager(): BrowserSessionManager | null {
  return shared;
}

/** 仅测试使用：替换共享管理器。 */
export function replaceBrowserSessionManagerForTest(
  manager: BrowserSessionManager | null,
): BrowserSessionManager | null {
  const previous = shared;
  shared = manager;
  return previous;
}

/** 停机：桌面退出或测试收尾时关闭浏览器实例。 */
export async function shutdownBrowserSessionManager(): Promise<void> {
  const manager = shared;
  shared = null;
  if (manager !== null) await manager.dispose();
}
