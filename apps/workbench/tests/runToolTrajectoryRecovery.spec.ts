import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RunToolTrajectoryPanel from "../src/components/RunToolTrajectoryPanel";
import { RelayApiError, type RelayApiClient, type RelayRun } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 工具轨迹读取失败的恢复语义（禅道 #115）。
 *
 * 锁三件事：
 *   * 同一 Run 读取失败后刷新成功：错误与「当前不可读」声明必须结清，新快照单独呈现；
 *   * 成功后再失败（403）：旧快照撤下，不残留已失权的调用行；
 *   * A 失败切 B：A 的迟到回包不清 B 的错误，也不把 A 的数据写进 B。
 */
afterEach(() => { vi.restoreAllMocks(); });

const apiError = (status: number, code: string, detail: string) =>
  new RelayApiError({ status, code, detail, retryable: status >= 500, retryAction: null,
    fieldErrors: [], expectedRevision: null, actualRevision: null });

function clientOf(getRunToolCalls: (runId: string) => Promise<unknown>): RelayApiClient {
  return {
    getRunToolCalls,
    getRunReviews: vi.fn(async () => []),
    readRunEvents: vi.fn(async (_runId: string, _cursor: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }));
    })
  } as unknown as RelayApiClient;
}

const element = (client: RelayApiClient, run: RelayRun | null) =>
  createElement(MemoryRouter, null, createElement(RunToolTrajectoryPanel, { client, run }));

const runOf = (id: string) => ({ id, revision: "1" }) as unknown as RelayRun;

describe("工具轨迹读取失败恢复", () => {
  it("同 Run 503 后刷新成功：旧错误与不可读声明结清，新快照独立呈现", async () => {
    const reads = vi.fn(async () => {
      if (reads.mock.calls.length === 1)
        throw apiError(503, "DATABASE_UNAVAILABLE", "temporary trajectory read failure");
      return { runId: "run-recovery", runStatus: "RUNNING", waitReason: null, rounds: [] };
    });
    const mounted = await mountReact(element(clientOf(reads as never), runOf("run-recovery")));
    try {
      await flush();
      expect(mounted.wrapper.get('[data-testid="trajectory-error"]').text()).toContain("数据库不可达");
      await mounted.wrapper.get('[data-testid="trajectory-refresh"]').trigger("click");
      await flush();
      expect(reads).toHaveBeenCalledTimes(2);
      expect(mounted.wrapper.find('[data-testid="trajectory-error"]').exists()).toBe(false);
      expect(mounted.wrapper.find('[data-testid="trajectory-source-unavailable"]').exists()).toBe(false);
      expect(mounted.wrapper.get('[data-testid="trajectory-empty"]').text()).toContain("没有工具请求");
    } finally { mounted.unmount(); }
  });

  it("成功读取后再 403：旧快照撤下，不残留已失权的调用行", async () => {
    const reads = vi.fn(async () => {
      if (reads.mock.calls.length === 1)
        return { runId: "run-revoke", runStatus: "RUNNING", waitReason: null,
          rounds: [{ round: 0, modelCallId: "m", calls: [{ id: "c1", round: 0, ordinal: 0,
            toolName: "read_file", status: "SETTLED", args: {}, argsSha256: "a".repeat(64),
            providerToolCallId: "p", operationId: null, adaptationOf: null, adaptedPath: null,
            resultRef: { content: "x" }, createdAt: "2026-10-25T00:00:00Z",
            updatedAt: "2026-10-25T00:00:01Z", fileChanges: [] }] }] };
      throw apiError(403, "RUN_ACCESS_REVOKED", "run access revoked");
    });
    const mounted = await mountReact(element(clientOf(reads as never), runOf("run-revoke")));
    try {
      await flush();
      expect(mounted.wrapper.find('[data-testid="trajectory-call-c1"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="trajectory-refresh"]').trigger("click");
      await flush();
      expect(mounted.wrapper.get('[data-testid="trajectory-error"]').text()).toContain("run access revoked");
      expect(mounted.wrapper.find('[data-testid="trajectory-call-c1"]').exists()).toBe(false);
      expect(mounted.wrapper.find('[data-testid="trajectory-source-unavailable"]').exists()).toBe(true);
    } finally { mounted.unmount(); }
  });

  it("A 失败切 B：A 的迟到回包不清 B 的错误，也不把 A 的数据写进 B", async () => {
    let settleA: ((value: unknown) => void) | undefined;
    const reads = vi.fn(async (runId: string) => {
      if (runId === "run-a" && reads.mock.calls.filter((call) => call[0] === "run-a").length === 1)
        return new Promise((resolve) => { settleA = resolve; });
      if (runId === "run-b") throw apiError(403, "RUN_ACCESS_REVOKED", "run b access revoked");
      return { runId, runStatus: "RUNNING", waitReason: null, rounds: [] };
    });
    const mounted = await mountReact(element(clientOf(reads as never), runOf("run-a")));
    try {
      await flush();
      expect(settleA).toBeDefined();
      await mounted.rerender(element(clientOf(reads as never), runOf("run-b")));
      await flush();
      expect(mounted.wrapper.get('[data-testid="trajectory-error"]').text())
        .toContain("run b access revoked");
      // A 的成功回包此刻才迟到：版本守卫必须丢弃它，B 的错误与空白都不被改写。
      settleA!({ runId: "run-a", runStatus: "COMPLETED", waitReason: null,
        rounds: [{ round: 0, modelCallId: "m", calls: [] }] });
      await flush();
      expect(mounted.wrapper.get('[data-testid="trajectory-error"]').text())
        .toContain("run b access revoked");
      expect(mounted.wrapper.find('[data-testid^="trajectory-call-"]').exists()).toBe(false);
    } finally { mounted.unmount(); }
  });
});
