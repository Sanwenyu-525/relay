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


it.each(["PAUSE", "CANCEL", "HANDOFF", "CANCEL_TASK", "RESUME"])("%s 的 503 不是未执行证明，保留原 ID 并禁止新提交", async (kind) => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  let commandId = ""; let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; commandId = JSON.parse(String(init.body)).command_id; }
    return response(503, { code: "DATABASE_UNAVAILABLE", detail: "unavailable" });
  }));
  const state = stateOf(runId, "1", "1");
  const view = await mountReact(createElement(RunControlPanel, { state: kind === "RESUME" ? { ...state, run: { ...state.run, status: "PAUSED" } } : state, onReload: vi.fn() }));
  unmount = view.unmount;
  await view.wrapper.get(kind === "RESUME" ? '[data-testid="run-resume"]' : `[data-testid="run-control-${kind}"]`).trigger("click"); await flush();
  expect(view.wrapper.get('[data-testid="run-check-receipt"]').exists()).toBe(true);
  expect(view.wrapper.text()).toContain(commandId);
  expect(posts).toBe(1);
  expect(sessionStorage.getItem(`relay:run-control-pending:${baseUrl}:${workspaceId}:${runId}`)).toContain(commandId);
  expect(view.wrapper.find('[data-testid="run-control-CANCEL"]').exists()).toBe(false);
});

it.each(["PAUSE", "RESUME"])("%s 的 202 已确认而重读失败时锁住旧修订，更新至回执修订后才解锁", async (kind) => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    posts++;
    const id = JSON.parse(String(init?.body)).command_id;
    return response(202, { command_id: id, committed_at: "2026-11-06T00:00:00Z", result: kind === "RESUME"
      ? { run_id: runId, status: "CREATED", run_revision: "2" }
      : { control_request_id: controlRequestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "2" } });
  }));
  const state = stateOf(runId, "1", "1");
  const initial = kind === "RESUME" ? { ...state, run: { ...state.run, status: "PAUSED" } } : state;
  const onReload = vi.fn().mockRejectedValue(new Error("readback failed"));
  const view = await mountReact(createElement(RunControlPanel, { state: initial, onReload })); unmount = view.unmount;
  await view.wrapper.get(kind === "RESUME" ? '[data-testid="run-resume"]' : '[data-testid="run-control-PAUSE"]').trigger("click"); await flush();
  expect(view.wrapper.get('[data-testid="run-control-CANCEL"]').attributes("disabled")).toBeDefined();
  expect(view.wrapper.get('[data-testid="run-control-readback"]').text()).toContain("重新读取");
  expect(view.wrapper.text()).toContain("原命令回执已确认，但最新执行状态读取失败");
  expect(view.wrapper.text()).not.toContain("是否入库尚未确定");
  expect(posts).toBe(1);
  await view.rerender(createElement(RunControlPanel, { state: stateOf(runId, "2", "1"), onReload: vi.fn() })); await flush();
  expect(view.wrapper.get('[data-testid="run-control-CANCEL"]').attributes("disabled")).toBeUndefined();
  expect(view.wrapper.find('[data-testid="run-control-readback"]').exists()).toBe(false);
});


it("切换工作区后同 Run ID 的旧 202 不能污染新作用域，原身份仍留在旧作用域", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const stub = stubControlEndpoints(); const onControlAccepted = vi.fn();
  const view = await mountReact(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted })); unmount = view.unmount;
  await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  activateRelayConnection({ baseUrl, workspaceId: "other-workspace", bearerToken: "other-token" });
  await view.rerender(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload: vi.fn(), onControlAccepted }));
  stub.release(response(202, { command_id: stub.commandId(), committed_at: "2026-11-06T00:00:00Z", result: {
    control_request_id: controlRequestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "2" } }));
  await flush();
  expect(onControlAccepted).not.toHaveBeenCalled();
  expect(view.wrapper.find('[data-testid="run-control-accepted"]').exists()).toBe(false);
  expect(view.wrapper.text()).not.toContain(stub.commandId());
  expect(sessionStorage.getItem(`relay:run-control-pending:${baseUrl}:${workspaceId}:${runId}`)).toContain(stub.commandId());
});


it.each([false, true])("同 Run 的桌面/抽屉面板共享未知与已确认的命令，不形成第二个写入口（202=%s）", async (confirmed) => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  let commandId = ""; let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    posts++;commandId = JSON.parse(String(init?.body)).command_id;
    return confirmed ? response(202, { command_id: commandId, committed_at: "2026-11-06T00:00:00Z", result: {
      control_request_id: controlRequestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "2" } })
      : response(503, { code: "DATABASE_UNAVAILABLE", detail: "unavailable" });
  }));
  const onReload = vi.fn().mockRejectedValue(new Error("readback failed"));
  const render = (revision: string) => createElement("div", {},
    createElement("div", { "data-testid": "desktop" }, createElement(RunControlPanel, { state: stateOf(runId, revision, "1"), onReload })),
    createElement("div", { "data-testid": "drawer" }, createElement(RunControlPanel, { state: stateOf(runId, revision, "1"), onReload })));
  const view = await mountReact(render("1")); unmount = view.unmount;
  await view.wrapper.get('[data-testid="desktop"] [data-testid="run-control-PAUSE"]').trigger("click"); await flush();
  const drawer = view.wrapper.get('[data-testid="drawer"]');
  expect(drawer.text()).toContain(commandId);
  if (confirmed) {
    expect(drawer.get('[data-testid="run-control-CANCEL"]').attributes("disabled")).toBeDefined();
    expect(drawer.get('[data-testid="run-control-readback"]').exists()).toBe(true);
    await view.rerender(render("2")); await flush();
    expect(view.wrapper.get('[data-testid="drawer"] [data-testid="run-control-CANCEL"]').attributes("disabled")).toBeUndefined();
  } else {
    expect(drawer.get('[data-testid="run-check-receipt"]').exists()).toBe(true);
    expect(drawer.find('[data-testid="run-control-CANCEL"]').exists()).toBe(false);
  }
  expect(posts).toBe(1);
});

it.each(["unavailable", "malformed"])("控制命令恢复身份不能保存时不发送请求：%s", async (kind) => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  if (kind === "unavailable") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  else sessionStorage.setItem(`relay:run-control-pending:${baseUrl}:${workspaceId}:${runId}`, "broken-json");
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const view = await mountReact(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload: vi.fn() })); unmount = view.unmount;
  await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click"); await flush();
  expect(request).not.toHaveBeenCalled();
  expect(view.wrapper.text()).toContain("未提交控制命令");
});


it("已确认的控制回执跨重挂载保留最低修订，旧快照不能提前解锁", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => response(202, {
    command_id: JSON.parse(String(init?.body)).command_id, committed_at: "2026-11-06T00:00:00Z", result: {
      control_request_id: controlRequestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "2" } })));
  const first = await mountReact(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload: vi.fn().mockRejectedValue(new Error("read failed")) }));
  unmount = first.unmount;
  await first.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click"); await flush();
  const key = `relay:run-control-pending:${baseUrl}:${workspaceId}:${runId}`;
  expect(JSON.parse(sessionStorage.getItem(key)!).confirmedRevision).toBe("2");
  first.unmount(); unmount = null;
  const next = await mountReact(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload: vi.fn() })); unmount = next.unmount;await flush();
  expect(next.wrapper.get('[data-testid="run-control-CANCEL"]').attributes("disabled")).toBeDefined();
  expect(next.wrapper.get('[data-testid="run-control-readback"]').exists()).toBe(true);
  await next.rerender(createElement(RunControlPanel, { state: stateOf(runId, "2", "1"), onReload: vi.fn() }));await flush();
  expect(next.wrapper.get('[data-testid="run-control-CANCEL"]').attributes("disabled")).toBeUndefined();
  expect(sessionStorage.getItem(key)).toBeNull();
});


it("刷新失败可见且可重试，保留原未决命令而不覆盖控制结果", async () => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  const key = `relay:run-control-pending:${baseUrl}:${workspaceId}:${runId}`;
  const pending = JSON.stringify({ runId, commandId: "original-command", kind: "control", type: "PAUSE" });sessionStorage.setItem(key, pending);
  const onReload = vi.fn().mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValueOnce(undefined);
  const view = await mountReact(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload }));unmount = view.unmount;
  await view.wrapper.get('[data-testid="run-refresh"]').trigger("click");await flush();
  expect(view.wrapper.get('[data-testid="run-refresh-error"]').text()).toContain("refresh failed");
  expect(view.wrapper.get('[data-testid="run-refresh"]').attributes("disabled")).toBeUndefined();
  expect(sessionStorage.getItem(key)).toBe(pending);
  expect(view.wrapper.get('[data-testid="run-check-receipt"]').exists()).toBe(true);
  await view.wrapper.get('[data-testid="run-refresh"]').trigger("click");await flush();
  expect(view.wrapper.find('[data-testid="run-refresh-error"]').exists()).toBe(false);
  expect(sessionStorage.getItem(key)).toBe(pending);expect(onReload).toHaveBeenCalledTimes(2);
});

it.each(["run", "workspace"])("刷新未结束时切换 %s，旧刷新不锁住新入口或写入新错误", async (kind) => {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  let rejectRefresh: ((error: Error) => void) | undefined;
  const onReload = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectRefresh = reject; }));
  const view = await mountReact(createElement(RunControlPanel, { state: stateOf(runId, "1", "1"), onReload }));unmount = view.unmount;
  await view.wrapper.get('[data-testid="run-refresh"]').trigger("click");
  expect(view.wrapper.get('[data-testid="run-refresh"]').attributes("disabled")).toBeDefined();
  if (kind === "workspace") activateRelayConnection({ baseUrl, workspaceId: "other-workspace", bearerToken: "other-token" });
  await view.rerender(createElement(RunControlPanel, { state: stateOf(kind === "run" ? otherRunId : runId, "1", "1"), onReload: vi.fn() }));await flush();
  const disabledBeforeOldSettles = view.wrapper.get('[data-testid="run-refresh"]').attributes("disabled");
  rejectRefresh!(new Error("old scope failed"));await flush();
  expect(disabledBeforeOldSettles).toBeUndefined();
  expect(view.wrapper.find('[data-testid="run-refresh-error"]').exists()).toBe(false);
  expect(view.wrapper.text()).not.toContain("old scope failed");
});
