import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TaskDelegatePanel, { type DelegateTarget } from "../src/components/TaskDelegatePanel";
import { RelayApiClient, RelayApiError, RelayTransportError } from "../src/api/relayClient";
import { recoveryScope, recoveryStorageKey, resetCommandRecoveryForTest, configureCommandRecoveryForTest } from "../src/lib/commandRecovery";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787", workspaceId = "workspace", taskId = "task", runId = "run";
const key = recoveryStorageKey(recoveryScope({ baseUrl, workspaceId }));
const record = { commandId: "original", commandType: "DelegateTask", sessionId: null, targetKind: "TASK", targetId: taskId };
const submission = { task_id: taskId, run_id: runId, task_revision: "3", run_revision: "0", status: "CREATED", retry_of_run_id: null };
const target: DelegateTarget = { id: taskId, projectId: "project", status: "READY", executor: "HUMAN", revision: "2", executorRunId: null, allowedActions: ["START"] };
let unmount: (() => void) | undefined;
beforeEach(() => { sessionStorage.clear(); resetCommandRecoveryForTest(); configureCommandRecoveryForTest({ maxAttempts: 1 }); });
afterEach(() => { unmount?.(); unmount = undefined; resetCommandRecoveryForTest(); sessionStorage.clear(); vi.restoreAllMocks(); });
function clientOf() {
  return { baseUrl, workspaceId, delegateTask: vi.fn().mockRejectedValue(new RelayTransportError("lost")),
    getCommandReceipt: vi.fn().mockResolvedValue({ commandId: "original", commandType: "DelegateTask", result: submission }),
    getRun: vi.fn().mockResolvedValue({ id: runId, taskId }) };
}
async function render(client: ReturnType<typeof clientOf>, task = target, recoveryOnly = false) {
  const onDelegated = vi.fn();
  const mounted = await mountReact(createElement(TaskDelegatePanel, { client: client as unknown as RelayApiClient, task,
    projectWriteBlockedReason: null, onDelegated, recoveryOnly }));
  unmount = mounted.unmount; await flush();
  return { ...mounted, onDelegated };
}

it("提交前保存原身份，响应丢失后重挂载只查原回执与 Run，不重发委托", async () => {
  const client = clientOf();
  let commandId = "";
  client.delegateTask.mockImplementation(async (input) => {
    commandId = input.commandId;
    expect(JSON.parse(sessionStorage.getItem(key)!)[0].commandId).toBe(commandId);
    throw new RelayTransportError("lost");
  });
  const first = await render(client);
  await first.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
  expect(first.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(commandId);
  first.unmount(); unmount = undefined; resetCommandRecoveryForTest(); configureCommandRecoveryForTest({ maxAttempts: 1 });
  client.getCommandReceipt.mockResolvedValue({ commandId, commandType: "DelegateTask", result: submission });
  const second = await render(client);
  expect(second.onDelegated).toHaveBeenCalledWith(runId);
  expect(client.delegateTask).toHaveBeenCalledTimes(1);
  expect(client.getCommandReceipt).toHaveBeenCalledWith(commandId, expect.any(AbortSignal));
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual([]);
});

it("任务已经由 AI 执行时仍恢复原回执，核实原 Run 后才收口", async () => {
  sessionStorage.setItem(key, JSON.stringify([record]));
  const client = clientOf();
  const mounted = await render(client, { ...target, status: "IN_PROGRESS", executor: "AI", executorRunId: runId, revision: "3", allowedActions: [] }, true);
  expect(mounted.onDelegated).toHaveBeenCalledWith(runId);
  expect(client.delegateTask).not.toHaveBeenCalled();
  expect(client.getRun).toHaveBeenCalledWith(runId);
});

it.each(["wrong-command", "wrong-type", "wrong-task", "wrong-run-task"])("回执或 Run 身份不符时保留原命令：%s", async (kind) => {
  sessionStorage.setItem(key, JSON.stringify([record]));
  const client = clientOf();
  if (kind === "wrong-command") client.getCommandReceipt.mockResolvedValue({ commandId: "other", commandType: "DelegateTask", result: submission });
  if (kind === "wrong-type") client.getCommandReceipt.mockResolvedValue({ commandId: "original", commandType: "ResumeRun", result: submission });
  if (kind === "wrong-task") client.getCommandReceipt.mockResolvedValue({ commandId: "original", commandType: "DelegateTask", result: { ...submission, task_id: "other" } });
  if (kind === "wrong-run-task") client.getRun.mockResolvedValue({ id: runId, taskId: "other" });
  const mounted = await render(client);
  expect(mounted.onDelegated).not.toHaveBeenCalled();
  expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain("original");
  expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
  expect(sessionStorage.getItem(key)).toContain("original");
});

it.each(["other-task", "other-workspace"])("恢复记录不跨作用域：%s", async (kind) => {
  sessionStorage.setItem(key, JSON.stringify([record]));
  const client = clientOf();
  if (kind === "other-workspace") client.workspaceId = "other";
  const mounted = await render(client, kind === "other-task" ? { ...target, id: "other" } : target);
  expect(mounted.wrapper.find('[data-testid="delegate-command-id"]').exists()).toBe(false);
  expect(client.getCommandReceipt).not.toHaveBeenCalled();
});

it.each(["unavailable", "malformed"])("恢复身份不能安全保存时不提交：%s", async (kind) => {
  if (kind === "malformed") sessionStorage.setItem(key, "broken-json");
  else vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  const client = clientOf(); const mounted = await render(client);
  await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
  expect(client.delegateTask).not.toHaveBeenCalled();
  expect(mounted.wrapper.text()).toContain("未提交委托");
  if (kind === "malformed") expect(sessionStorage.getItem(key)).toBe("broken-json");
});


it("委托返回 503 也保留原身份，不把失败响应当作可以换 ID 的证明", async () => {
  const client = clientOf();
  client.delegateTask.mockRejectedValue(new RelayApiError({ status: 503, code: "DATABASE_UNAVAILABLE", detail: "unavailable",
    retryable: true, retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null }));
  const mounted = await render(client);
  await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush();
  expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').exists()).toBe(true);
  expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
  expect(client.delegateTask).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sessionStorage.getItem(key)!)).toHaveLength(1);
});
