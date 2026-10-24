import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import RunToolTrajectoryPanel from "../../src/components/RunToolTrajectoryPanel";
import { RelayApiError, type RelayApiClient, type RelayRun } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("同一Run工具轨迹503后刷新成功必须清除旧错误和不可读声明", async () => {
  const runId = "run-recovery-probe";
  const reads = vi.fn(async () => {
    if (reads.mock.calls.length === 1) throw new RelayApiError({ status: 503, code: "DATABASE_UNAVAILABLE", detail: "temporary trajectory read failure", retryable: true, retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null });
    return { runId, runStatus: "RUNNING", waitReason: null, rounds: [] };
  });
  const client = { getRunToolCalls: reads, getRunReviews: vi.fn(async () => []), readRunEvents: vi.fn(async (_runId: string, _cursor: string, signal: AbortSignal) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }) } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(RunToolTrajectoryPanel, { client, run: { id: runId, revision: "1" } as RelayRun }))); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.find('[data-testid="trajectory-error"]').exists()).toBe(true);
  await mounted.wrapper.get('[data-testid="trajectory-refresh"]').trigger("click"); await flush();
  const errorVisible = mounted.wrapper.find('[data-testid="trajectory-error"]').exists();
  const unavailableVisible = mounted.wrapper.find('[data-testid="trajectory-source-unavailable"]').exists();
  const successfulProjectionVisible = mounted.wrapper.find('[data-testid="trajectory-empty"]').exists();
  console.log("TRIAGE_RUN_TRAJECTORY_RECOVERY", JSON.stringify({ reads: reads.mock.calls.length, errorVisible, unavailableVisible, successfulProjectionVisible, text: mounted.wrapper.text() }));
  expect(reads).toHaveBeenCalledTimes(2); expect(successfulProjectionVisible).toBe(true);
  expect(errorVisible).toBe(false); expect(unavailableVisible).toBe(false);
});
