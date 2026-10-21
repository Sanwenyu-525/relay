import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import ExecutionSummary from "../src/components/ExecutionSummary";
import type { RelayConversationExecution } from "../src/api/relayClient";
import { mountReact } from "./mountApp";

/**
 * 会话执行摘要（工作台 §43，2026-10-20 第二轮重写）。
 *
 * 这一组断言锁三件事：正常路径**没有**任何确认按钮（推进责任在服务端）；
 * 失败时给一次显式的「继续原请求」并把服务端写回的具体原因呈现出来；
 * 日常界面上不再出现 task_id 这类内部身份。
 */
function execution(overrides: Partial<RelayConversationExecution>): RelayConversationExecution {
  return { requestId: "original-request", decision: "PREPARE", status: "READY",
    candidateStatus: "READY", taskId: null, runId: null, rootPath: "D:\\example",
    questions: [], fileChanges: [] as RelayConversationExecution["fileChanges"],
    ...overrides } as unknown as RelayConversationExecution;
}

describe("执行摘要：服务端推进，不做重复确认", () => {
  it.each(["READY", "TASK_PREPARED", "DELEGATED"])("%s 不提供开始确认按钮", async (status) => {
    const onApply = vi.fn();
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: execution({ status }), busy: false, onApply, onOpenTask: vi.fn(), error: null }));
    try {
      // 没有开始按钮才是重点：正常路径上这条摘要不接受任何点击就开始执行。
      expect(view.wrapper.find('[data-testid="execution-start"]').exists()).toBe(false);
      expect(onApply).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it("可自动推进的候选在投影上标成 auto_start，纯展示不改状态", async () => {
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: execution({ autoStart: true }), busy: false, onApply: vi.fn(),
      onOpenTask: vi.fn(), error: null }));
    try {
      expect(view.wrapper.get('[data-testid="execution-summary"]').attributes("data-auto-start"))
        .toBe("true");
    } finally { view.unmount(); }
  });

  it("失败时按原请求继续，并把服务端写回的具体原因原样显示", async () => {
    const onApply = vi.fn();
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: execution({ status: "FAILED",
        questions: ["本项目还没有绑定该目录的 FILE_WRITE 连接；请在同页补齐后再执行。"] }),
      busy: false, onApply, onOpenTask: vi.fn(), error: null }));
    try {
      expect(view.wrapper.get('[data-testid="execution-summary-stage"]').text())
        .toBe("没有继续执行");
      expect(view.wrapper.get('[data-testid="execution-summary-failure"]').text())
        .toContain("FILE_WRITE 连接");
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      expect(onApply).toHaveBeenCalledWith("original-request");
    } finally { view.unmount(); }
  });

  it("已有执行载体时给出详情入口，但界面不出现内部 ID", async () => {
    const onOpenTask = vi.fn();
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: execution({ status: "DELEGATED", taskId: "9f6c1f0a-0000-4000-8000-000000000000",
        runId: "7a1b2c3d-0000-4000-8000-000000000000" }),
      busy: false, onApply: vi.fn(), onOpenTask, error: null }));
    try {
      const details = view.wrapper.get('[data-testid="execution-open-task"]');
      expect(details.text()).toBe("查看执行详情");
      await details.trigger("click");
      expect(onOpenTask).toHaveBeenCalledWith("9f6c1f0a-0000-4000-8000-000000000000");
      expect(view.wrapper.text()).not.toContain("9f6c1f0a");
      expect(view.wrapper.text()).not.toContain("7a1b2c3d");
    } finally { view.unmount(); }
  });

  it("显示候选声明的文件动作，删除的确认口径写成「执行前」", async () => {
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: execution({ fileChanges: [{ path: "docs/new.md", action: "CREATE" },
        { path: "src/changed.ts", action: "MODIFY" },
        { path: "old.txt", action: "DELETE" }] }),
      busy: false, onApply: vi.fn(), onOpenTask: vi.fn(), error: null }));
    try {
      const files = view.wrapper.get('[data-testid="execution-summary-files"]');
      expect(files.text()).toContain("新建 · docs/new.md");
      expect(files.text()).toContain("修改 · src/changed.ts");
      expect(files.text()).toContain("删除 · old.txt");
      expect(view.wrapper.get('[data-testid="execution-summary-delete-note"]').text())
        .toContain("单独请你确认");
    } finally { view.unmount(); }
  });

  it("旧服务端没有文件动作字段时不渲染列表，也不声称本次不改文件", async () => {
    const view = await mountReact(createElement(ExecutionSummary, {
      execution: execution({ fileChanges: undefined as unknown as RelayConversationExecution["fileChanges"] }),
      busy: false, onApply: vi.fn(), onOpenTask: vi.fn(), error: null }));
    try {
      expect(view.wrapper.find('[data-testid="execution-summary-files"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="execution-summary-delete-note"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
});
