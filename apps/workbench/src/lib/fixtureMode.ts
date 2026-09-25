import { isFixtureMode, type FixtureMode } from "../types";

export const defaultFixtureLatency = 180;

export function fixtureModeFromQuery(query: URLSearchParams): FixtureMode {
  const value = query.get("fixture");
  return isFixtureMode(value) ? value : "normal";
}

/**
 * 仅供开发与自动化测试注入异步延迟；默认页面不依赖该参数。
 */
export function fixtureLatencyFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get("fixtureLatency");
  if (raw === null) {
    return defaultFixtureLatency;
  }
  const latency = Number(raw);
  if (!Number.isFinite(latency) || latency < 0 || latency > 5000) {
    return defaultFixtureLatency;
  }
  return latency;
}
