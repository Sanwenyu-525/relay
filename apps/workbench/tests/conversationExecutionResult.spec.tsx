import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayApiClient } from "../src/api/relayClient";
import ConversationExecutionResult from "../src/components/ConversationExecutionResult";
import { runFrom } from "../src/api/parse/run";
import { flush, mountReact } from "./mountApp";

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); });

async function render(status: string, completionRun = "run", historical = false, runStatus = "COMPLETED", reviewIds: readonly string[] = []) {
  const client = {
    getRun: vi.fn().mockResolvedValue({ id: "run", taskId: "task", status: runStatus, blockingReviewIds: reviewIds,
      ...(historical ? { completionId: "original-completion" } : {}) }),
    getTask: vi.fn().mockResolvedValue({ id: "task", status,
      currentCompletionId: status === "DONE" ? "completion" : null }),
    getCompletionEvidence: vi.fn().mockImplementation(async (completionId: string) => ({ completionId, taskId: "task",
      isCurrent: !historical, verificationSession: { runId: completionRun } })),
  } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemoryRouter, {},
    createElement(ConversationExecutionResult, { client, taskId: "task", runId: "run" })));
  unmount = mounted.unmount;
  await flush();
  return mounted.wrapper;
}

it("Run ended alone does not announce Task completion", async () => {
  const wrapper = await render("IN_PROGRESS");
  expect(wrapper.text()).toContain("任务完成结果待核对");
  expect(wrapper.text()).not.toContain("任务已完成");
  expect(wrapper.find('[data-completion-id]').exists()).toBe(false);
});

it("exact current completion appears with its artifact and evidence links", async () => {
  const wrapper = await render("DONE");
  expect(wrapper.text()).toContain("任务已完成，成果与完成凭据已保存");
  expect(wrapper.get('[data-completion-id="completion"]').attributes("data-task-id")).toBe("task");
  expect(wrapper.get('a[href="/completion-records/completion"]').text()).toBe("查看完成凭据");
  expect(wrapper.get('a[href="/tasks/task?tab=artifacts"]').text()).toBe("查看成果");
});

it("another Run's completion is rejected and can be reread", async () => {
  const wrapper = await render("DONE", "other-run");
  expect(wrapper.get('[role="alert"]').text()).toContain("完成凭据与这次执行不一致");
  expect(wrapper.text()).not.toContain("任务已完成");
  expect(wrapper.find('[data-completion-id]').exists()).toBe(false);
  expect(wrapper.text()).toContain("重新读取执行结果");
});

it("reopening preserves the original Run's historical completion link", async () => {
  const wrapper = await render("READY", "run", true);
  expect(wrapper.text()).toContain("任务已重开");
  expect(wrapper.get('a[href="/completion-records/original-completion"]').text()).toBe("查看历史完成凭据");
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain("任务已完成，成果与完成凭据已保存");
});

it("a new cycle completing does not replace the old chat's completion identity", async () => {
  const wrapper = await render("DONE", "run", true);
  expect(wrapper.text()).toContain("任务已有新的完成凭据");
  expect(wrapper.get('[data-completion-id="original-completion"]').attributes("data-completion-current")).toBe("false");
  expect(wrapper.find('a[href="/completion-records/completion"]').exists()).toBe(false);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});

it("reads only the COMPLETE result's completion identity and rejects malformed identities", () => {
  const response = { id: "run", task_id: "task", status: "COMPLETED", revision: "1",
    wait_reason: null, current_step_id: null, steps: [], recent_attempts: [],
    blocking_review_ids: [], pending_control_request: null, unresolved_operation_ids: [],
    result_refs: [{ step_kind: "DRAFT", result_ref: { completion_id: "wrong" } },
      { step_kind: "COMPLETE", result_ref: { completion_id: "original" } }] };
  expect(runFrom(response).completionId).toBe("original");
  expect(() => runFrom({ ...response, result_refs: [
    { step_kind: "COMPLETE", result_ref: { completion_id: 42 } }] })).toThrow();
  expect(runFrom({ ...response, result_refs: [] }).completionId).toBeNull();
});


it("等待人工判断时直接定位本次 Run 的每个请求，不让用户从全局队列寻找", async () => {
  const wrapper = await render("IN_PROGRESS", "run", false, "WAITING_APPROVAL", ["review-a", "review-b"]);
  expect(wrapper.get('a[href="/reviews?id=review-a"]').text()).toBe("处理本次待办 1");
  expect(wrapper.get('a[href="/reviews?id=review-b"]').text()).toBe("处理本次待办 2");
  expect(wrapper.find('a[href="/reviews"]').exists()).toBe(false);
});

it("唯一待办不显示序号，未返回确切请求时不猜测其他任务的请求", async () => {
  const single = await render("IN_PROGRESS", "run", false, "WAITING_APPROVAL", ["only-review"]);
  expect(single.get('a[href="/reviews?id=only-review"]').text()).toBe("处理本次待办");
  unmount?.();
  const empty = await render("IN_PROGRESS", "run", false, "WAITING_APPROVAL");
  expect(empty.find('a[href^="/reviews"]').exists()).toBe(false);
  expect(empty.get('a[href="/runs/run"]').exists()).toBe(true);
});

it("非等待状态不暴露历史待办入口", async () => {
  const wrapper = await render("IN_PROGRESS", "run", false, "CANCELLED", ["old-review"]);
  expect(wrapper.find('a[href^="/reviews"]').exists()).toBe(false);
});
