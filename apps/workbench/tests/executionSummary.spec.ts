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
      rootPath: "D:\\example", questions: [] } as unknown as RelayConversationExecution;
    const view = await mountReact(createElement(ExecutionSummary, {
      execution, busy: false, onApply, onOpenTask: vi.fn(), error: null }));
    try {
      await view.wrapper.get('[data-testid="execution-start"]').trigger("click");
      expect(onApply).toHaveBeenCalledWith("original-request");
    } finally { view.unmount(); }
  });
});
