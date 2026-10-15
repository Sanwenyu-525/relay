import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RunControlPanel, { type RunControlState } from "../src/components/RunControlPanel";
import type { RelayRun, RelayTaskDetail } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

/**
 * 结果未知的 Run 控制命令必须跨**整页重读**保留身份。
 *
 * 2026-10-08 真实 API/PG 浏览器验收（`tests/browser/realBusinessAcceptance.spec.ts` 组 3b）先复现：
 * 控制命令响应中断后整页刷新，`原 command_id`、`核对原命令回执` 入口与「核对前不再提交」
 * 一起消失，用户既不能继续核对，也可能直接再发一条命令。修复后按 (连接, 工作空间, Run)
 * 分键持久化命令身份，本组回归守住「重读后仍在」「核对后收口」「换 Run 不串台」三条。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const runId = "33333333-3333-4333-8333-333333333333";
const otherRunId = "35333333-3333-4333-8333-333333333333";
const taskId = "22222222-2222-4222-8222-222222222222";
const controlRequestId = "44444444-4444-4444-8444-444444444444";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

const response = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

const runOf = (id: string, revision: string) =>
  ({ id, revision, status: "RUNNING", pendingControlRequest: null, waitReason: null }) as unknown as RelayRun;
const taskOf = (revision: string) =>
  ({ id: taskId, revision, executor: "AI", status: "IN_PROGRESS" }) as unknown as RelayTaskDetail;

const stateOf = (id: string, runRevision: string, taskRevision: string): RunControlState =>
  ({ run: runOf(id, runRevision), task: taskOf(taskRevision), controlRecord: null,
    activeRun: true, terminal: false, projectWriteBlockedReason: null });

/** 控制命令 POST 挂起（结果未知）；可释放为 202，也可按原 command_id 给出回执。 */
function stubControlEndpoints() {
  let release: (value: Response) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  let postedCommandId = "";
  let receipt: Response | null = null;
  let receiptQueries = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const address = String(url);
    if (address === `${prefix}/runs/${runId}/control-requests` && init?.method === "POST") {
      postedCommandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
      return new Promise<Response>((resolve, reject) => { release = resolve; fail = reject; });
    }
    if (address === `${prefix}/commands/${postedCommandId}` && init?.method === undefined) {
      receiptQueries += 1;
      return receipt ?? response(404, { code: "COMMAND_NOT_FOUND" });
    }
    throw new Error(`unexpected request: ${address}`);
  }));
  return {
    release: (value: Response) => release(value),
    loseResponse: () => fail(new TypeError("network lost")),
    commandId: () => postedCommandId,
    receiptQueries: () => receiptQueries,
    setReceipt: (body: unknown) => { receipt = response(200, body); }
  };
}

const pauseReceipt = (commandId: string) => ({ command_id: commandId, committed_at: "2026-10-08T00:00:00.000Z",
  command_type: "RequestRunControl",
  result: { control_request_id: controlRequestId, run_id: runId, task_id: taskId, type: "PAUSE",
    status: "PENDING", run_revision: "2" } });

let unmount: (() => void) | null = null;
beforeEach(() => {
  window.sessionStorage.clear();
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
});
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("整页重读后仍保留原 command_id、回执核对入口与「核对前不再提交」", async () => {
  const stub = stubControlEndpoints();
  const first = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  await flush(10);
  await first.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  stub.loseResponse();
  await flush(60);
  const commandId = stub.commandId();
  expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
  first.unmount();

  // 整页重读：组件内存状态全丢，只剩本机按 Run 存下的那条命令身份。
  const second = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "2", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  unmount = second.unmount;
  await flush(10);
  expect(second.wrapper.text()).toContain(`原 command_id：${commandId}`);
  expect(second.wrapper.get('[data-testid="run-control-recheck"]').text()).toContain("仍在等原命令回执");
  expect(second.wrapper.find('[data-testid="run-check-receipt"]').exists()).toBe(true);
  // 禁止重复提交：核对完成前不得再出现四个控制入口。
  for (const control of ["run-control-PAUSE", "run-control-CANCEL", "run-control-HANDOFF", "run-control-CANCEL_TASK"]) {
    expect(second.wrapper.find(`[data-testid="${control}"]`).exists()).toBe(false);
  }
  expect(second.wrapper.find('[data-testid="run-control-accepted"]').exists()).toBe(false);

  stub.setReceipt(pauseReceipt(commandId));
  const onControlAccepted = vi.fn();
  await second.rerender(createElement(RunControlPanel,
    { state: stateOf(runId, "3", "1"), onReload: vi.fn(), onControlAccepted }));
  await flush(10);
  await second.wrapper.get('[data-testid="run-check-receipt"]').trigger("click");
  await flush(60);
  expect(onControlAccepted).toHaveBeenCalledWith(controlRequestId);
  expect(stub.receiptQueries()).toBe(1);

  // 核对完成后本机身份收口：再次重读不会把已结算的命令当成待核对。
  second.unmount();
  const third = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "4", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  unmount = third.unmount;
  await flush(10);
  expect(third.wrapper.text()).not.toContain(commandId);
  expect(third.wrapper.find('[data-testid="run-control-recheck"]').exists()).toBe(false);
  expect(third.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(true);
});

it("换一个 Run 只读回那一个 Run 的命令身份，不串台", async () => {
  const stub = stubControlEndpoints();
  const first = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  await flush(10);
  await first.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  await flush(10);
  const commandId = stub.commandId();

  await first.rerender(createElement(RunControlPanel,
    { state: stateOf(otherRunId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  unmount = first.unmount;
  await flush(10);
  expect(first.wrapper.find('[data-testid="run-check-receipt"]').exists()).toBe(false);
  expect(first.wrapper.find('[data-testid="run-control-recheck"]').exists()).toBe(false);
  expect(first.wrapper.text()).not.toContain(commandId);
  expect(first.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(true);
});

it("换一个连接后不把旧连接的命令身份带过来", async () => {
  const stub = stubControlEndpoints();
  const first = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  await flush(10);
  await first.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  await flush(10);
  const commandId = stub.commandId();

  activateRelayConnection({ baseUrl: "http://127.0.0.1:8788", workspaceId, bearerToken: "test-token" });
  await first.rerender(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  unmount = first.unmount;
  await flush(10);
  expect(first.wrapper.text()).not.toContain(commandId);
  expect(first.wrapper.find('[data-testid="run-check-receipt"]').exists()).toBe(false);
});