import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ExecutionTrajectorySummary from "../src/components/ExecutionTrajectorySummary";
import type { RelayApiClient, RelayRunToolCall, RelayRunToolCalls } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const call = (id: string, toolName: string, resultRef: RelayRunToolCall["resultRef"],
  status: RelayRunToolCall["status"] = "SETTLED"): RelayRunToolCall => ({ id, toolName, resultRef, status,
  round: 0, ordinal: 0, args: {}, argsSha256: "a".repeat(64), providerToolCallId: id,
  operationId: null, adaptationOf: null, adaptedPath: null,
  createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:01Z" });

async function mount(calls: readonly RelayRunToolCall[]) {
  const projection: RelayRunToolCalls = { runId: "run-a", runStatus: "RUNNING", waitReason: null,
    rounds: [{ round: 0, modelCallId: "m", calls }] };
  const client = { getRunToolCalls: vi.fn(async () => projection),
    readRunEvents: vi.fn<RelayApiClient["readRunEvents"]>(async (_runId, _after, _signal, _onEvent, onOpen) => { onOpen?.(); }) } as unknown as RelayApiClient;
  const view = await mountReact(createElement(ExecutionTrajectorySummary, { client, runId: "run-a" }));
  await flush(80);
  return view;
}

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
});
