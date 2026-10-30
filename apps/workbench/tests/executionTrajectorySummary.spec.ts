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

describe("本次读取结果的呈现", () => {
  it("展开后每个回执是可复制文本块：顶行「工具 · 目标」，正文逐字来自 result_ref", async () => {
    const view = await mount([{ ...call("read-1", "read_file", { content: "第一行\n第二行" }),
      args: { path: "src/a.ts" } }]);
    try {
      await view.wrapper.get('[data-testid="execution-read-results-toggle"]').trigger("click");
      const block = view.wrapper.get('[data-testid="execution-read-read-1"] .msg-code');
      expect(block.find(".msg-code-label").text()).toBe("read_file · src/a.ts");
      // 逐字断言走 textContent：wrapper.text() 会把换行折叠成空格。
      expect((block.get("pre code").element as HTMLElement).textContent).toBe("第一行\n第二行");
      expect(block.get(".msg-code-copy").attributes("aria-label")).toBe("复制这段工具回执");
    } finally { view.unmount(); }
  });

  it("调用统计按类别各占一枚标签，不在一串分隔符里数项", async () => {
    const view = await mount([call("read", "read_file", { content: "source" }),
      call("write", "apply_changeset", { outcome: "COMPLETED" })]);
    try {
      const counts = view.wrapper.get(".execution-counts").findAll(".execution-count").map((chip) => chip.text());
      expect(counts).toEqual(["读取/检索 1 次", "写入 1 次"]);
    } finally { view.unmount(); }
  });
});

describe("长任务读取结果的分组与限高", () => {
  const manyReads = (countOf: number, tool = "read_file") =>
    Array.from({ length: countOf }, (_, index) =>
      // id 带工具名：读取链路按 call.id 去重，不同工具复用同 ID 会被当成重放丢掉。
      call(`${tool}-${index}`, tool, { content: `内容 ${index}` }));

  it("超过 8 项时按工具聚成组行，组行默认收起、展开后逐项回执仍逐字来自 result_ref", async () => {
    const view = await mount([...manyReads(5), ...manyReads(4, "search_text")]);
    try {
      await view.wrapper.get('[data-testid="execution-read-results-toggle"]').trigger("click");
      const list = view.wrapper.get('[data-testid="execution-read-results"]');
      expect(list.attributes("data-grouped")).toBe("true");
      const readGroup = view.wrapper.get('[data-testid="execution-read-group-read_file"]');
      expect(readGroup.find("summary").text()).toBe("read_file · 5 项");
      expect(view.wrapper.get('[data-testid="execution-read-group-search_text"]').find("summary").text())
        .toBe("search_text · 4 项");
      // 组行默认收起（jsdom 里收起的 details 内容仍在 DOM，按 open 属性断言）：
      // 先给「工具 · N 项」的分组概览，展开后才逐项回执。
      expect((readGroup.element as HTMLDetailsElement).open).toBe(false);
      await readGroup.find("summary").trigger("click");
      expect((readGroup.element as HTMLDetailsElement).open).toBe(true);
      const block = view.wrapper.get('[data-testid="execution-read-read_file-0"] .msg-code');
      expect(block.find(".msg-code-label").text()).toBe("read_file · read_file");
      expect((block.get("pre code").element as HTMLElement).textContent).toBe("内容 0");
    } finally { view.unmount(); }
  });

  it("8 项以内保持既有平铺，不加分组与限高标记", async () => {
    const view = await mount(manyReads(8));
    try {
      await view.wrapper.get('[data-testid="execution-read-results-toggle"]').trigger("click");
      const list = view.wrapper.get('[data-testid="execution-read-results"]');
      expect(list.attributes("data-grouped")).toBeUndefined();
      expect(list.attributes("data-capped")).toBeUndefined();
      expect(view.wrapper.findAll('[data-testid^="execution-read-read_file-"]').length).toBe(8);
    } finally { view.unmount(); }
  });

  it("超过 12 项折叠区限高、框内滚动，滚动区可被键盘聚焦", async () => {
    const view = await mount(manyReads(13));
    try {
      await view.wrapper.get('[data-testid="execution-read-results-toggle"]').trigger("click");
      const list = view.wrapper.get('[data-testid="execution-read-results"]');
      expect(list.attributes("data-capped")).toBe("true");
      expect(list.attributes("tabindex")).toBe("0");
    } finally { view.unmount(); }
  });
});

/**
 * 命令输出的统一活动行（2026-10-30 验收整改）。
 *
 * 此前聊天区的执行摘要只有「读取结果」清单与逐文件 diff，命令类工具（run_check 等）
 * 在会话里完全没有出口——stdout 与退出码只存在于右栏轨迹。这里补上同一套行 anatomy，
 * 并钉住两条不能退让的口径：
 *   * 读取与写入不在这个列表里重复出现（它们各有自己的清单/diff）。
 *   * 展开后看到的是服务端回执原文与真实退出码，不是从状态推出来的「通过」。
 */
describe("命令输出", () => {
  it("命令类工具按统一活动行列出，展开后给出真实输出与退出码", async () => {
    const view = await mount([
      call("check", "run_check", { content: "PASS 3 tests", exit_code: 0 }),
      call("read", "read_file", { content: "source" }),
      call("write", "apply_changeset", { outcome: "COMPLETED" })
    ]);
    try {
      const list = view.wrapper.get('[data-testid="execution-activities"]');
      const rows = list.findAll(".activity-item");
      // 只有命令进这个列表：读取走「本次读取结果」，写入走逐文件 diff。
      expect(rows).toHaveLength(1);
      expect(rows[0].text()).toContain("运行检查");
      expect(rows[0].attributes("data-category")).toBe("COMMAND");

      await view.wrapper.get('[data-testid="execution-activity-check-toggle"]').trigger("click");
      const detail = view.wrapper.get('[data-testid="execution-activity-check-detail"]');
      expect(detail.get('[data-testid="activity-detail-result-check"]').text()).toBe("PASS 3 tests");
      expect(detail.get('[data-testid="activity-detail-meta-check"]').text()).toContain("退出码 0");
      // 结算不等于验证通过：界面上不出现由工具状态推出的成功结论。
      expect(detail.text()).not.toContain("验证通过");
    } finally { view.unmount(); }
  });

  it("命令失败时行上标失败，输出仍逐字可见", async () => {
    const view = await mount([call("bad", "run_check", { content: "ERR 1", exit_code: 1,
      outcome: "FAILED" })]);
    try {
      const row = view.wrapper.get('[data-testid="execution-activity-bad"]');
      expect(row.attributes("data-failed")).toBe("true");
      expect(row.text()).toContain("已结算但失败");
      await view.wrapper.get('[data-testid="execution-activity-bad-toggle"]').trigger("click");
      expect(view.wrapper.get('[data-testid="activity-detail-result-bad"]').text()).toBe("ERR 1");
    } finally { view.unmount(); }
  });
});
