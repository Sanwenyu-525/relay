import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ExecutionTrajectorySummary from "../src/components/ExecutionTrajectorySummary";
import type { RelayApiClient, RelayReview, RelayRunToolCall, RelayRunToolCalls } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const call = (id: string, toolName: string, resultRef: RelayRunToolCall["resultRef"],
  status: RelayRunToolCall["status"] = "SETTLED", operationId: string | null = null): RelayRunToolCall =>
  ({ id, toolName, resultRef, status,
    round: 0, ordinal: 0, args: {}, argsSha256: "a".repeat(64), providerToolCallId: id,
    operationId, adaptationOf: null, adaptedPath: null, fileChanges: [],
    createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:01Z" });

async function mount(calls: readonly RelayRunToolCall[], reviews: readonly RelayReview[] | Error = []) {
  const projection: RelayRunToolCalls = { runId: "run-a", runStatus: "RUNNING", waitReason: null,
    rounds: [{ round: 0, modelCallId: "m", calls }] };
  const client = { getRunToolCalls: vi.fn(async () => projection),
    getRunReviews: vi.fn(async () => {
      if (reviews instanceof Error) throw reviews;
      return reviews;
    }),
    readRunEvents: vi.fn<RelayApiClient["readRunEvents"]>(async (_runId, _after, _signal, _onEvent, onOpen) => { onOpen?.(); }) } as unknown as RelayApiClient;
  const view = await mountReact(createElement(ExecutionTrajectorySummary, { client, runId: "run-a" }));
  await flush(80);
  return view;
}

const approval = (id: string, operationId: string | null,
  status = "OPEN"): RelayReview => ({ id, kind: "ACTION_APPROVAL", status, operationId }) as RelayReview;

describe("基础执行结果摘要", () => {
  it("检查失败后修正并复检，失败回执仍可见，失败写入不计为改动", async () => {
    const view = await mount([
      call("first-check", "run_check", { outcome: "FAILED", exitCode: 1 }),
      call("failed-write", "apply_changeset", { outcome: "FAILED" }),
      call("read", "read_file", { content: "source" }),
      call("write", "apply_changeset", { outcome: "COMPLETED" }),
      call("last-check", "run_check", { outcome: "COMPLETED", exitCode: 0 })
    ]);
    try {
      const text = view.wrapper.get('[data-testid="execution-summary"]').text();
      expect(text).toContain("检查 2 次");
      expect(text).toContain("写入 1 次");
      expect(text).not.toContain("写入 2 次");
      expect(text).toContain("2 项失败或未执行");
    } finally { view.unmount(); }
  });
  it("检索和目录浏览按调用计数，已有结果时仍显示在途调用", async () => {
    const view = await mount([call("query", "find_paths", { entries: ["a.ts", "b.ts"] }),
      call("pending", "apply_changeset", null, "PREPARED")]);
    try {
      const text = view.wrapper.get('[data-testid="execution-summary"]').text();
      expect(text).toContain("读取/检索 1 次");
      expect(text).toContain("1 项进行中或结果未决");
      expect(text).not.toContain("写入");
    } finally { view.unmount(); }
  });
  it("已结算但结果未提供时不宣布已改动", async () => {
    const view = await mount([call("missing-result", "apply_changeset", null)]);
    try {
      expect(view.wrapper.get('[data-testid="execution-summary"]').text()).toContain("1 项结果未提供");
      expect(view.wrapper.text()).not.toContain("写入");
    } finally { view.unmount(); }
  });

  it("等待批准时链接到 operation_id 匹配的原 Review", async () => {
    const view = await mount([
      call("waiting", "apply_changeset", null, "WAITING_APPROVAL", "operation-1")],
    [approval("review-1", "operation-1")]);
    try {
      expect(view.wrapper.get('[data-testid="execution-summary"]').text()).toContain("1 项等待你批准");
      expect(view.wrapper.get('[data-testid="execution-waiting-approval-link"]').attributes("href"))
        .toBe("/reviews?id=review-1");
    } finally { view.unmount(); }
  });

  it("找不到精确匹配的 Review 时退回原审批页，不隐藏入口", async () => {
    const view = await mount([
      call("waiting", "apply_changeset", null, "WAITING_APPROVAL", "operation-1")],
    [approval("other-review", "operation-2"), approval("decided", "operation-1", "ACCEPTED")]);
    try {
      expect(view.wrapper.get('[data-testid="execution-waiting-approval-link"]').attributes("href"))
        .toBe("/reviews?kind=ACTION_APPROVAL");
    } finally { view.unmount(); }
  });

  it("审批读取失败时仍保留入口，不把读不到说成没有审批", async () => {
    const view = await mount([
      call("waiting", "apply_changeset", null, "WAITING_APPROVAL", "operation-1")],
    new Error("reviews unavailable"));
    try {
      expect(view.wrapper.get('[data-testid="execution-summary"]').text()).toContain("1 项等待你批准");
      expect(view.wrapper.get('[data-testid="execution-waiting-approval-link"]').attributes("href"))
        .toBe("/reviews?kind=ACTION_APPROVAL");
    } finally { view.unmount(); }
  });
});
