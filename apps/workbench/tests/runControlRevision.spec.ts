import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RunControlPanel, { type RunControlState } from "../src/components/RunControlPanel";
import type { RelayRun, RelayTaskDetail } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

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

let unmount: (() => void) | null = null;
// 未确认的控制命令按 Run 持久化在 sessionStorage 里（供整页重读后继续核对）。
// 每条用例都以「全新挂载、没有上一条命令身份」为前提，因此先清掉本机存储再挂载。
beforeEach(() => { window.sessionStorage.clear(); });
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

/** 控制命令 POST 挂起、结果未知；可释放为 202 回执，或以传输错误丢失（UNKNOWN 路径）。 */
function stubControlEndpoints() {
  let release: (value: Response) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  let postedCommandId = "";
  let receipt: Response | null = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const address = String(url);
    if (address === `${prefix}/runs/${runId}/control-requests` && init?.method === "POST") {
      postedCommandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
      return new Promise<Response>((resolve, reject) => { release = resolve; fail = reject; });
    }
    if (address === `${prefix}/commands/${postedCommandId}` && init?.method === undefined) {
      return receipt ?? response(404, { code: "COMMAND_NOT_FOUND" });
    }
    throw new Error(`unexpected request: ${address}`);
  }));
  return {
    release: (value: Response) => release(value),
    loseResponse: () => fail(new TypeError("network lost")),
    commandId: () => postedCommandId,
    setReceipt: (body: unknown) => { receipt = response(200, body); }
  };
}

const pauseReceipt = (commandId: string) => ({ command_id: commandId, committed_at: "2026-10-07T00:00:00.000Z",
  command_type: "RequestRunControl",
  result: { control_request_id: controlRequestId, run_id: runId, task_id: taskId, type: "PAUSE",
    status: "PENDING", run_revision: "2" } });

it("同 Run 事实修订（revision 更新）不丢失未知控制命令 ID、冻结载荷与核对回执入口", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const stub = stubControlEndpoints();
  const view = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  unmount = view.unmount;
  await flush(10);
  await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  expect(view.wrapper.get('[data-testid="run-control-inflight"]').text()).toContain("Run 尚未暂停");
  // 同一 Run：runId 不变，仅事实修订刷新（Run v1→v2）；这不是命令结算，也不是换 Run。
  await view.rerender(createElement(RunControlPanel,
    { state: stateOf(runId, "2", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  await flush(10);
  // 结果未知的原 command_id 身份、在途冻结载荷与「核对原命令回执」入口都必须保留。
  expect(view.wrapper.get('[data-testid="run-control-inflight"]').text()).toContain("Run 尚未暂停");
  expect(view.wrapper.get('[data-testid="run-check-receipt"]').exists()).toBe(true);
  expect(view.wrapper.text()).toContain(`原 command_id：${stub.commandId()}`);
});

it("同 Run 修订更新后，202 回执仍可按原 command_id 结算受理记录", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const stub = stubControlEndpoints();
  const onReload = vi.fn(async () => undefined);
  const view = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload, onControlAccepted: vi.fn() }));
  unmount = view.unmount;
  await flush(10);
  await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  await view.rerender(createElement(RunControlPanel,
    { state: stateOf(runId, "2", "1"), onReload, onControlAccepted: vi.fn() }));
  await flush(10);
  // 回执在修订之后才到达：同 Run 的迟到回执不得被当作「换了界面」丢弃。
  stub.release(response(202, { command_id: stub.commandId(), committed_at: "2026-10-07T00:00:00.000Z",
    result: { control_request_id: controlRequestId, run_id: runId, task_id: taskId,
      type: "PAUSE", status: "PENDING", run_revision: "2" } }));
  await flush(60);
  const accepted = view.wrapper.get('[data-testid="run-control-accepted"]').text();
  expect(accepted).toContain(`原 command_id ${stub.commandId()}`);
  expect(accepted).toContain(controlRequestId);
});

it("同 Run 修订更新后，仍可用原 command_id 核对回执并落账控制请求 ID", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const stub = stubControlEndpoints();
  const onControlAccepted = vi.fn();
  const view = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted }));
  unmount = view.unmount;
  await flush(10);
  await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  // 响应丢失：结果未知（UNKNOWN），错误提示要求保留原 command_id 核对，不能换 ID 重试。
  stub.loseResponse();
  await flush(60);
  expect(view.wrapper.get('[data-testid="run-check-receipt"]').exists()).toBe(true);
  // 修订更新不得清掉这条待核对命令与未知提示。
  await view.rerender(createElement(RunControlPanel,
    { state: stateOf(runId, "2", "1"), onReload: vi.fn(), onControlAccepted }));
  await flush(10);
  expect(view.wrapper.text()).toContain(`原 command_id：${stub.commandId()}`);
  expect(view.wrapper.text()).toContain("请查询原 command_id 回执");
  stub.setReceipt(pauseReceipt(stub.commandId()));
  await view.wrapper.get('[data-testid="run-check-receipt"]').trigger("click");
  await flush(60);
  expect(onControlAccepted).toHaveBeenCalledWith(controlRequestId);
  expect(view.wrapper.get('[data-testid="run-control-accepted"]').text())
    .toContain(`原 command_id ${stub.commandId()}`);
});

it("切换到另一个 Run 仍清空在途命令，不把上一 Run 的命令身份带过去", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const stub = stubControlEndpoints();
  const view = await mountReact(createElement(RunControlPanel,
    { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  unmount = view.unmount;
  await flush(10);
  await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  // 真正换了 Run：命令身份必须清空，防止把上一 Run 的 command_id 核对入口带到新 Run。
  await view.rerender(createElement(RunControlPanel,
    { state: stateOf(otherRunId, "1", "1"), onReload: vi.fn(), onControlAccepted: vi.fn() }));
  await flush(10);
  expect(view.wrapper.find('[data-testid="run-check-receipt"]').exists()).toBe(false);
  expect(view.wrapper.find('[data-testid="run-control-inflight"]').exists()).toBe(false);
  expect(view.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(true);
  expect(view.wrapper.text()).not.toContain(stub.commandId());
});
