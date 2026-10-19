import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ExecutionSummary from "../src/components/ExecutionSummary";
import type { RelayConversationExecution } from "../src/api/relayClient";
import { mountReact } from "./mountApp";

describe("执行请求基础接续入口", () => {
  it.each(["READY", "TASK_PREPARED", "FAILED"])("%s 按原请求继续", async (status) => {
    const onApply = vi.fn();
    const execution = { requestId: "original-request", decision: "PREPARE", status,
      candidateStatus: "READY", taskId: status === "READY" ? null : "original-task", runId: null,
      rootPath: "D:\\example", questions: [], fileChanges: [] } as unknown as RelayConversationExecution;
    const view = await mountReact(createElement(ExecutionSummary, {
      execution, busy: false, onApply, onOpenTask: vi.fn(), error: null }));
    try {
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      expect(onApply).toHaveBeenCalledWith("original-request");
    } finally { view.unmount(); }
  });

  it("确认前显示候选声明的文件动作，并说明删除仍会停在审批", async () => {
    const execution = { requestId: "original-request", decision: "PREPARE", status: "READY",
      candidateStatus: "READY", taskId: null, runId: null,
      rootPath: "D:\\example", questions: [],
      fileChanges: [{ path: "docs/new.md", action: "CREATE" },
        { path: "src/changed.ts", action: "MODIFY" },
        { path: "old.txt", action: "DELETE" }] } as unknown as RelayConversationExecution;
    const view = await mountReact(createElement(ExecutionSummary, {
      execution, busy: false, onApply: vi.fn(), onOpenTask: vi.fn(), error: null }));
    try {
      const files = view.wrapper.get('[data-testid="execution-summary-files"]');
      expect(files.text()).toContain("新建 · docs/new.md");
      expect(files.text()).toContain("修改 · src/changed.ts");
      expect(files.text()).toContain("删除 · old.txt");
      expect(view.wrapper.get('[data-testid="execution-summary-delete-note"]').text())
        .toContain("需要确认时会在批准前停住");
    } finally { view.unmount(); }
  });

  it("旧服务端没有文件动作字段时不渲染列表，也不声称本次不改文件", async () => {
    const execution = { requestId: "original-request", decision: "PREPARE", status: "READY",
      candidateStatus: "READY", taskId: null, runId: null,
      rootPath: "D:\\example", questions: [] } as unknown as RelayConversationExecution;
    const view = await mountReact(createElement(ExecutionSummary, {
      execution, busy: false, onApply: vi.fn(), onOpenTask: vi.fn(), error: null }));
    try {
      expect(view.wrapper.find('[data-testid="execution-summary-files"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="execution-summary-delete-note"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
});

describe("计划执行方式偏好", () => {
  const ready = { requestId: "auto-request", decision: "PREPARE", status: "READY",
    candidateStatus: "READY", taskId: null, runId: null, rootPath: "D:\\example",
    questions: [], fileChanges: [], autoStart: true } as unknown as RelayConversationExecution;

  it("本设备选择人工确认时，服务端标记的自动启动让位于这次确认", async () => {
    const onApply = vi.fn();
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: ready, busy: false, onApply, onOpenTask: vi.fn(), error: null, manualConfirm: true }));
    try {
      expect(view.wrapper.get('[data-testid="execution-summary"]').attributes("data-auto-start")).toBe("false");
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      expect(onApply).toHaveBeenCalledWith("auto-request");
    } finally { view.unmount(); }
  });

  it("本设备选择自动执行时不显示确认按钮，自动启动失败才作为恢复入口出现", async () => {
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: ready, busy: false, onApply: vi.fn(), onOpenTask: vi.fn(), error: null }));
    try {
      expect(view.wrapper.get('[data-testid="execution-summary"]').attributes("data-auto-start")).toBe("true");
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
    } finally { view.unmount(); }
    const failed = await mountReact(createElement(ExecutionSummary, {
      execution: ready, busy: false, onApply: vi.fn(), onOpenTask: vi.fn(), error: "自动启动未完成" }));
    try {
      expect(failed.wrapper.get('[data-testid="execution-start"]').exists()).toBe(true);
    } finally { failed.unmount(); }
  });
});
