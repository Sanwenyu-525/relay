import { afterEach, expect, it, vi } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("任务校验失败聚焦首个错误，继续输入不跳焦点或提交", async () => {
  const mounted = await mountWorkbench("/tasks?view=create");
  unmount = mounted.unmount;
  const save = mounted.wrapper.get('[data-testid="task-create-save"]');
  (save.element as HTMLButtonElement).focus();
  await save.trigger("click");
  const title = mounted.wrapper.get('input[name="task-title"]');
  expect(document.activeElement).toBe(title.element);
  expect(title.attributes("aria-invalid")).toBe("true");
  await title.setValue("保留正在编辑的标题");
  expect(document.activeElement).toBe(title.element);
  expect(fixtureAdapter.getCallCount("createTask")).toBe(0);
  await save.trigger("click");
  expect(document.activeElement).toBe(mounted.wrapper.get('input[name="task-expected-result"]').element);
  expect((title.element as HTMLInputElement).value).toBe("保留正在编辑的标题");
});

it("任务创建结果接收焦点，避免提交后焦点落回整页", async () => {
  const mounted = await mountWorkbench("/tasks?view=create");
  unmount = mounted.unmount;
  await mounted.wrapper.get('input[name="task-title"]').setValue("可访问的创建结果");
  await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果");
  await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("结果可以核对");
  await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
  await flush(80);
  expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
  expect(document.activeElement).toBe(mounted.wrapper.get('[data-testid="task-created-result"] h2').element);
});

it("创建的迟到结果不抢走已打开命令面板的焦点", async () => {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const createTask = fixtureAdapter.createTask.bind(fixtureAdapter);
  vi.spyOn(fixtureAdapter, "createTask").mockImplementation(async (...args) => {
    await waiting;
    return createTask(...args);
  });
  const mounted = await mountWorkbench("/tasks?view=create");
  unmount = mounted.unmount;
  await mounted.wrapper.get('input[name="task-title"]').setValue("迟到结果");
  await mounted.wrapper.get('input[name="task-expected-result"]').setValue("一份结果");
  await mounted.wrapper.get('textarea[name="task-acceptance"]').setValue("可核对");
  await mounted.wrapper.get('[data-testid="task-create-save"]').trigger("click");
  await mounted.wrapper.get('[data-testid="titlebar-search"]').trigger("click");
  await flush();
  const search = document.querySelector<HTMLInputElement>('[data-testid="command-search"]')!;
  expect(document.activeElement === search).toBe(true);
  release();
  await flush(80);
  expect(mounted.wrapper.find('[data-testid="task-created-result"]').exists()).toBe(true);
  expect(document.activeElement === search).toBe(true);
  expect(fixtureAdapter.getCallCount("createTask")).toBe(1);
});

it("readiness 检查冻结对应输入，失败后恢复编辑并保留输入", async () => {
  let rejectReady: (reason: Error) => void = () => undefined;
  const ready = new Promise<Response>((_resolve, reject) => { rejectReady = reject; });
  const fetchStub = vi.fn(async () => ready);
  vi.stubGlobal("fetch", fetchStub);
  const mounted = await mountWorkbench("/projects");
  unmount = mounted.unmount;
  await mounted.wrapper.get('[data-testid="relay-connection-open"]').trigger("click");
  const page = new DomWrapper(document.body);
  await page.get('input[name="relay-workspace-id"]').setValue("11111111-1111-4111-8111-111111111111");
  await page.get('input[name="relay-bearer-token"]').setValue("test-token");
  await page.get('[data-testid="relay-connect"]').trigger("click");
  for (const name of ["relay-base-url", "relay-workspace-id", "relay-bearer-token"]) {
    expect((page.get(`input[name="${name}"]`).element as HTMLInputElement).disabled).toBe(true);
  }
  expect(page.get('[data-testid="relay-connect"]').attributes("aria-busy")).toBe("true");
  rejectReady(new Error("readiness unavailable"));
  await flush();
  expect(fetchStub).toHaveBeenCalledOnce();
  expect((page.get('input[name="relay-workspace-id"]').element as HTMLInputElement).disabled).toBe(false);
  expect((page.get('input[name="relay-workspace-id"]').element as HTMLInputElement).value).toBe("11111111-1111-4111-8111-111111111111");
  expect(page.get('[data-testid="relay-connection-error"]').text()).not.toBe("");
});

const controlBase = "http://127.0.0.1:8787";
const controlWorkspace = "11111111-1111-4111-8111-111111111111";
const controlTask = "22222222-2222-4222-8222-222222222222";
const controlRun = "33333333-3333-4333-8333-333333333333";
const controlRequest = "44444444-4444-4444-8444-444444444444";
const controlPrefix = `${controlBase}/api/v1/workspaces/${controlWorkspace}`;
const controlRunUrl = `${controlPrefix}/runs/${controlRun}`;
const controlResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
const controlTaskBody = () => ({ id: controlTask, project_id: null, title: "运行页任务", status: "IN_PROGRESS",
  mode: "DELEGATE_AI", revision: "4", executor: { kind: "AI", run_id: controlRun, ownership_epoch: "1" },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
  allowed_actions: [], acceptance: { acceptance_revision: "1", objective: "核对", source: "CREATE", criteria: [] },
  dependencies: [] });
const controlRunBody = (status: string) => ({ id: controlRun, task_id: controlTask, status, revision: "3",
  ownership_epoch: "1", retry_of_run_id: null, current_step_id: "step-1", wait_reason: null,
  created_at: "2026-09-23T00:00:00.000Z", updated_at: "2026-09-23T00:01:00.000Z", terminal_at: null,
  contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1",
    acceptance_revision: "1", contract_hash: "a".repeat(64) }, current_step: null,
  steps: [{ step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED",
    started_at: null, finished_at: null }], recent_attempts: [], result_refs: [], blocking_review_ids: [],
  pending_control_request: null, unresolved_operation_ids: [] });

it("暂停在途只显示正在处理，不把 Run 本地改写成已暂停；受理后仍以服务端状态为准", async () => {
  activateRelayConnection({ baseUrl: controlBase, workspaceId: controlWorkspace, bearerToken: "test-token" });
  let release: (value: Response) => void = () => undefined;
  const inFlight = new Promise<Response>((resolve) => { release = resolve; });
  let postedCommandId = "";
  let paused = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const address = String(url);
    if (address === controlRunUrl && init?.method !== "POST") return controlResponse(200, controlRunBody(paused ? "PAUSED" : "RUNNING"));
    if (address === `${controlPrefix}/tasks/${controlTask}`) return controlResponse(200, controlTaskBody());
    if (address === `${controlRunUrl}/reviews`) return controlResponse(200, { items: [] });
    if (address === `${controlRunUrl}/context-manifests`) return controlResponse(200,
      { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
    if (address === `${controlRunUrl}/control-requests` && init?.method === "POST") {
      postedCommandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
      return inFlight;
    }
    if (address === `${controlRunUrl}/control-requests/${controlRequest}`) return controlResponse(200,
      { id: controlRequest, run_id: controlRun, task_id: controlTask, type: "PAUSE", status: "PENDING",
        revision: "1", requested_at: "2026-09-23T00:01:00.000Z", decided_at: null, result_ref: null });
    throw new Error(`unexpected request: ${address}`);
  }));
  const mounted = await mountWorkbench(`/runs/${controlRun}`); unmount = mounted.unmount;
  await flush(30);
  await mounted.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
  // 在途窗口：按钮已受理 ≠ 动作已停止，界面不先把它改写成已暂停。
  const inflight = mounted.wrapper.get('[data-testid="run-control-inflight"]').text();
  expect(inflight).toContain("正在处理");
  expect(inflight).toContain("Run 尚未暂停");
  // 未收到服务端事实前，不出现「已暂停」的摘要面板。
  expect(mounted.wrapper.find('[data-testid="run-paused-summary"]').exists()).toBe(false);
  // 服务端受理后重新查询：状态一律以服务端事实为准。
  paused = true;
  release(controlResponse(202, { command_id: postedCommandId, committed_at: "2026-09-23T00:01:00.000Z",
    result: { control_request_id: controlRequest, run_id: controlRun, task_id: controlTask,
      type: "PAUSE", status: "PENDING", run_revision: "4" } }));
  await flush(60);
  expect(mounted.wrapper.find('[data-testid="run-paused-summary"]').exists()).toBe(true);
});
