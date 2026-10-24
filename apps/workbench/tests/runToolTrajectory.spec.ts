import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RunToolTrajectoryPanel, { dedupeCalls, headTailCap } from "../src/components/RunToolTrajectoryPanel";
import type { RelayApiClient, RelayReview, RelayRun, RelayRunToolCall, RelayRunToolCalls } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

afterEach(() => vi.restoreAllMocks());

// 折叠算术是导出的纯函数：它决定用户看到哪几行，因此值得单独钉住。
describe("轨迹折叠算术", () => {
  it("超长结果保留头尾两半，并如实给出省略行数", () => {
    const cap = headTailCap(40, 8, false);
    expect(cap).toEqual({ headLines: 4, tailLines: 4, hiddenLines: 32 });
  });

  it("展开时不隐藏任何行", () => {
    expect(headTailCap(40, 8, true)).toEqual({ headLines: 40, tailLines: 0, hiddenLines: 0 });
  });

  it("行数不超过上限时不省略任何行", () => {
    const cap = headTailCap(5, 8, false);
    expect(cap.hiddenLines).toBe(0);
    // 头 4 行 + 尾 4 行在 5 行时会重叠：拼接前必须按去重后的实际行数取尾，
    // 否则第 1~3 行会在界面上各出现两次。
    const lines = Array.from({ length: 5 }, (_unused, index) => index);
    const head = lines.slice(0, Math.min(cap.headLines, lines.length));
    const tail = lines.slice(Math.max(head.length, lines.length - cap.tailLines));
    expect([...new Set([...head, ...tail])]).toEqual(lines);
  });

  it("空结果不产生负的省略行数", () => {
    expect(headTailCap(0, 8, false)).toEqual({ headLines: 0, tailLines: 0, hiddenLines: 0 });
  });
});

// 行身份去重：同一 operation/调用 id 的重复事件或重放只能渲染一行。
describe("轨迹重放去重", () => {
  it("事实一致的重复事件静默取首条，只保留一行", () => {
    const first = call({ id: "dup" });
    const { calls, conflicting } = dedupeCalls([first, { ...first }]);
    expect(calls).toHaveLength(1);
    expect(conflicting.size).toBe(0);
  });

  it("事实不一致的重复事件仍只渲染一行，但标记为无法确认哪条最新", () => {
    const { calls, conflicting } = dedupeCalls([
      call({ id: "dup" }),
      call({ id: "dup", status: "REJECTED", resultRef: { reason: "TOOL_CHECK_NOT_CONFIGURED" } })]);
    expect(calls).toHaveLength(1);
    expect(conflicting.has("dup")).toBe(true);
  });
});

const call = (over: Partial<RelayRunToolCall> & { id: string }): RelayRunToolCall => ({
  round: 0, ordinal: 0, toolName: "read_file", status: "SETTLED",
  args: { relative_path: "a.ts" }, argsSha256: "a".repeat(64), providerToolCallId: "p",
  operationId: null, adaptationOf: null, adaptedPath: null, resultRef: { content: "x" },
  createdAt: "2026-10-05T01:00:00Z", updatedAt: "2026-10-05T01:00:01Z", ...over,
  // 写在展开之后：Partial 会把必需的逐文件账本重新放宽成 undefined。
  fileChanges: over.fileChanges ?? [] });

const projection = (over: Partial<RelayRunToolCalls> = {}): RelayRunToolCalls => ({
  runId: "run-a", runStatus: "RUNNING", waitReason: null,
  rounds: [{ round: 0, modelCallId: "m", calls: [call({ id: "c1" })] }], ...over });

/** 轨迹面板只依赖这三个读取入口；事件流默认立即返回并保持「可订阅」语义。 */
function stubClient(overrides: {
  getRunToolCalls?: (runId: string) => Promise<RelayRunToolCalls>;
  getRunReviews?: (runId: string) => Promise<readonly RelayReview[]>;
  readRunEvents?: (runId: string, after: string) => Promise<void>;
} = {}) {
  const events: { runId: string; after: string }[] = [];
  const client = {
    getRunToolCalls: vi.fn(overrides.getRunToolCalls ?? (async (runId: string) => projection({ runId }))),
    getRunReviews: vi.fn(overrides.getRunReviews ?? (async () => [])),
    readRunEvents: vi.fn(async (runId: string, after: string, _signal: AbortSignal,
      _onEvent: (seq: string) => void, onOpen: () => void) => {
      events.push({ runId, after });
      onOpen();
      await (overrides.readRunEvents?.(runId, after) ?? Promise.resolve());
    })
  } as unknown as RelayApiClient;
  return { client, events };
}

const element = (client: RelayApiClient, run: RelayRun | null) =>
  createElement(MemoryRouter, {}, createElement(RunToolTrajectoryPanel, { client, run }));

const runOf = (id: string, revision = "1") => ({ id, revision }) as unknown as RelayRun;

describe("工具轨迹面板：只呈现已落库事实", () => {
  it("检查 FAILED 无 reason 时仍明确显示已结算但失败", async () => {
    const { client } = stubClient({ getRunToolCalls: async (runId) => projection({ runId,
      rounds: [{ round: 0, modelCallId: "m", calls: [call({ id: "failed-check", toolName: "run_check",
        resultRef: { outcome: "FAILED", exitCode: 1, stdout: "check failed" } })] }] }) });
    const view = await mountReact(element(client, runOf("run-a")));
    try {
      await flush(80);
      expect(view.wrapper.get('[data-testid="trajectory-call-failed-check"]').text()).toContain("已结算但失败");
    } finally { view.unmount(); }
  });
  it("重复且不一致的重放只渲染一行并说明无法确认；证据绑定始终写未提供，不补 PASS", async () => {
    const { client } = stubClient({ getRunToolCalls: async (runId) => projection({ runId, rounds: [
      { round: 0, modelCallId: "m", calls: [
        call({ id: "dup", status: "SETTLED" }),
        call({ id: "dup", status: "REJECTED", resultRef: { reason: "X" } })] }] }) });
    const view = await mountReact(element(client, runOf("run-a")));
    try {
      await flush(80);
      expect(view.wrapper.findAll('[data-testid^="trajectory-call-dup"]')).toHaveLength(1);
      expect(view.wrapper.get('[data-testid="trajectory-replay-conflict-dup"]').text()).toContain("无法确认哪一条是最新状态");
      const evidence = view.wrapper.get('[data-testid="trajectory-evidence-note"]').text();
      expect(evidence).toContain("未下发");
      expect(evidence).toContain("无法确认");
      expect(evidence).not.toContain("PASS");
    } finally { view.unmount(); }
  });

  it("终态 Run 下未结算的调用不得被认定执行过或未执行", async () => {
    const { client } = stubClient({ getRunToolCalls: async (runId) => projection({ runId,
      runStatus: "COMPLETED", rounds: [{ round: 0, modelCallId: "m",
        calls: [call({ id: "pending", status: "REQUESTED", resultRef: null })] }] }) });
    const view = await mountReact(element(client, runOf("run-a")));
    try {
      await flush(80);
      const note = view.wrapper.get('[data-testid="trajectory-unsettled-at-terminal-pending"]').text();
      expect(note).toContain("既不能认定它执行过，也不能认定它没执行");
    } finally { view.unmount(); }
  });

  it("退出码、截断与省略量在折叠态即可看到，不改写成完整结果", async () => {
    const { client } = stubClient({ getRunToolCalls: async (runId) => projection({ runId, rounds: [
      { round: 0, modelCallId: "m", calls: [call({ id: "settled",
        resultRef: { content: "line1\nline2", exit_code: 3, truncated: true, omitted_bytes: 42 } })] }] }) });
    const view = await mountReact(element(client, runOf("run-a")));
    try {
      await flush(80);
      const summary = view.wrapper.get('[data-testid="trajectory-exec-summary-settled"]').text();
      expect(summary).toContain("退出码 3");
      expect(summary).toContain("省略 42 字节");
      expect(view.wrapper.get('[data-testid="trajectory-truncated-settled"]').text()).toContain("不是完整内容");
    } finally { view.unmount(); }
  });

  it("轨迹读取失败时不展示任何参数或输出，只如实说明服务端拒绝", async () => {
    const { client } = stubClient({ getRunToolCalls: async () => { throw new Error("服务端拒绝读取"); } });
    const view = await mountReact(element(client, runOf("run-a")));
    try {
      await flush(80);
      expect(view.wrapper.get('[data-testid="trajectory-error"]').text()).toContain("服务端拒绝读取");
      expect(view.wrapper.get('[data-testid="trajectory-source-unavailable"]').text()).toContain("不显示任何调用参数或输出");
      expect(view.wrapper.find('[data-testid^="trajectory-args-"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid^="trajectory-result-"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("切换 Run 时事件游标归零，不用上一 Run 的序号跳过新 Run 的事件", async () => {
    const { client, events } = stubClient();
    const view = await mountReact(element(client, runOf("run-a")));
    try {
      await flush(80);
      expect(events[0]).toEqual({ runId: "run-a", after: "0" });
      // 让 run-a 的事件流推进游标，模拟已经收到过若干事件。
      const onEvent = (client.readRunEvents as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3] as (seq: string) => void;
      onEvent("5");
      await flush(20);
      await view.rerender(element(client, runOf("run-b")));
      await flush(80);
      const forB = events.filter((event) => event.runId === "run-b");
      expect(forB.length).toBeGreaterThan(0);
      // 新 Run 的事件日志是独立的：必须从 0 起，否则会跳过 seq<=5 的事件。
      expect(forB[0]!.after).toBe("0");
    } finally { view.unmount(); }
  });

  it("等待批准按绑定的 ACTION_APPROVAL 记录给出当前有效性，查不到就说无法确认", async () => {
    const review = (over: Partial<RelayReview> = {}): RelayReview => ({
      id: "review-1", kind: "ACTION_APPROVAL", status: "OPEN", revision: "1", projectId: null,
      taskId: null, runId: "run-a", operationId: "op-1", reason: "ACTION_APPROVAL_REQUIRED",
      targetHash: "f".repeat(64), target: {}, evidence: {}, effect: {}, allowedDecisions: ["APPROVE", "DENY"],
      expiresAt: null, createdAt: "2026-10-05T01:00:00Z", decidedAt: null, ...over });
    const waiting = () => projection({ runId: "run-a", runStatus: "WAITING_APPROVAL", rounds: [
      { round: 0, modelCallId: "m", calls: [call({ id: "gate", toolName: "apply_changeset",
        status: "WAITING_APPROVAL", operationId: "op-1", resultRef: null })] }] });

    const open = stubClient({ getRunToolCalls: async () => waiting(), getRunReviews: async () => [review()] });
    const openView = await mountReact(element(open.client, runOf("run-a")));
    try {
      await flush(80);
      expect(openView.wrapper.get('[data-testid="trajectory-approval-gate"]').text()).toContain("等待你批准");
    } finally { openView.unmount(); }

    // 批准已过期：不得沿用「已批准」的旧结论。
    const expired = stubClient({ getRunToolCalls: async () => waiting(),
      getRunReviews: async () => [review({ status: "EXPIRED" })] });
    const expiredView = await mountReact(element(expired.client, runOf("run-a")));
    try {
      await flush(80);
      const text = expiredView.wrapper.get('[data-testid="trajectory-approval-gate"]').text();
      expect(text).toContain("审批已过期，未执行");
      expect(text).not.toContain("已批准");
    } finally { expiredView.unmount(); }

    // 已批准也只说明批准发生过，不等于动作已执行。
    const approved = stubClient({ getRunToolCalls: async () => waiting(),
      getRunReviews: async () => [review({ status: "DECIDED", decidedAt: "2026-10-05T01:02:00Z",
        target: { decision: "APPROVE" } })] });
    const approvedView = await mountReact(element(approved.client, runOf("run-a")));
    try {
      await flush(80);
      expect(approvedView.wrapper.get('[data-testid="trajectory-approval-gate"]').text())
        .toContain("已批准这只动作，不代表它已执行");
    } finally { approvedView.unmount(); }

    // 审批记录读不到：说清是读不到，不能显示成「已批准」。
    const unreadable = stubClient({ getRunToolCalls: async () => waiting(),
      getRunReviews: async () => { throw new Error("读不到审批"); } });
    const unreadableView = await mountReact(element(unreadable.client, runOf("run-a")));
    try {
      await flush(80);
      expect(unreadableView.wrapper.get('[data-testid="trajectory-approval-gate"]').text())
        .toContain("审批记录当前读不到");
      expect(unreadableView.wrapper.get('[data-testid="trajectory-reviews-unreadable"]').text())
        .toContain("无法确认");
      expect(unreadableView.wrapper.get('[data-testid="trajectory-approval-gate"]').text()).not.toContain("已批准");
    } finally { unreadableView.unmount(); }
  });
});
