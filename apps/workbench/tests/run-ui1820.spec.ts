import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const runUrl = `${prefix}/runs/${runId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function task(executorKind: "AI" | "HUMAN" = "AI") {
  return {
    id: taskId, project_id: null, title: "运行页任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
    revision: "4", executor: { kind: executorKind, run_id: executorKind === "AI" ? runId : null, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] }, dependencies: []
  };
}

function run(status: string, options: { pending?: { type: string } | null; unresolved?: readonly string[] } = {}) {
  return {
    id: runId, task_id: taskId, status, revision: "3", ownership_epoch: "1", retry_of_run_id: null,
    current_step_id: "step-1", wait_reason: null, created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:01:00.000Z", terminal_at: null,
    contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "1", contract_hash: "a".repeat(64) },
    current_step: null,
    steps: [
      { step_id: "step-0", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED", started_at: "2026-09-23T00:00:00.000Z", finished_at: "2026-09-23T00:00:05.000Z" },
      { step_id: "step-1", step_index: 1, step_kind: "DRAFT", status: "RUNNING", started_at: "2026-09-23T00:00:06.000Z", finished_at: null }
    ],
    recent_attempts: [{ attempt_id: "attempt-1", step_id: "step-1", step_kind: "DRAFT", attempt_number: "1", status: "RUNNING", claim_epoch: "1", started_at: null, finished_at: null }],
    result_refs: [], blocking_review_ids: [],
    pending_control_request: options.pending ? { id: requestId, type: options.pending.type, status: "PENDING", requested_at: "2026-09-23T00:01:00.000Z" } : null,
    unresolved_operation_ids: options.unresolved ?? []
  };
}

function controlRequest(type: string, status: string) {
  return {
    id: requestId, run_id: runId, task_id: taskId, type, status, revision: "1",
    requested_at: "2026-09-23T00:01:00.000Z", decided_at: status === "PENDING" ? null : "2026-09-23T00:02:00.000Z", result_ref: null
  };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

function baseRoutes(runBody: unknown, taskBody: unknown) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const address = String(url);
    if (address === runUrl && init?.method !== "POST") return response(200, runBody);
    if (address === `${prefix}/tasks/${taskId}`) return response(200, taskBody);
    if (address === `${runUrl}/reviews`) return response(200, { items: [] });
    if (address === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
    if (address === `${runUrl}/control-requests/${requestId}`) {
      const pending = (runBody as { pending_control_request?: { type?: string } }).pending_control_request;
      return response(200, controlRequest(pending?.type ?? "PAUSE", "PENDING"));
    }
    throw new Error(`unexpected request: ${address}`);
  };
}

describe("UI-18/19/20 Run 状态补全", () => {
  it("PENDING 暂停请求：不显示已暂停，说明尚未暂停且执行者不变；时间线与资源面板如实显示", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(baseRoutes(run("RUNNING", { pending: { type: "PAUSE" } }), task("AI"))));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    expect(mounted.wrapper.text()).toContain("执行中");
    expect(mounted.wrapper.text()).not.toContain("已暂停");
    const pending = mounted.wrapper.get('[data-testid="run-control-pending"]').text();
    expect(pending).toContain("Run 尚未暂停");
    expect(pending).toContain("当前执行者仍为 AI");
    const steps = mounted.wrapper.get('[data-testid="run-steps"]').text();
    expect(steps).toContain("2026-09-23T00:00:00.000Z → 2026-09-23T00:00:05.000Z");
    expect(mounted.wrapper.get('[data-testid="run-current-action"]').text()).toContain("当前动作：生成草稿 · 执行中");
    expect(mounted.wrapper.get('[data-testid="run-current-action"]').text()).toContain("控制请求将在安全点处理");
    const resources = mounted.wrapper.get('[data-testid="run-resources"]').text();
    expect(resources).toContain("待接入");
    expect(resources).toContain("不能宣称资源已释放");
    expect(resources).toContain("租约过期只说明旧 Worker 不再被信任，不能推断旧子进程已经停止");
  });

  it("PAUSED 摘要：恢复点、产物核对指引、执行权不转移与资源仍占用如实显示", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(baseRoutes(run("PAUSED"), task("AI"))));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    const summary = mounted.wrapper.get('[data-testid="run-paused-summary"]').text();
    expect(summary).toContain("已在安全边界内暂停");
    expect(summary).toContain("暂停不自动转移执行权");
    expect(summary).toContain("最后完成步骤：构建上下文");
    expect(summary).toContain("Run 级产物清单接口待接入");
    expect(mounted.wrapper.get('[data-testid="run-resources"]').text()).toContain("资源可能仍被占有");
    expect(mounted.wrapper.get('[data-testid="run-resources"]').text()).toContain("Resume 须重新获得资源");
    expect(mounted.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="run-resume"]').exists()).toBe(true);
  });

  it("HANDOFF PENDING 不开放编辑入口；APPLIED 后才呈现人工编辑入口", async () => {
    activate();
    let phase = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === `${runUrl}/control-requests` && init?.method === "POST") {
        phase = 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: body.command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { control_request_id: requestId, run_id: runId, task_id: taskId, type: "HANDOFF", status: "PENDING", run_revision: "4" } });
      }
      if (address === `${runUrl}/control-requests/${requestId}`) return response(200, controlRequest("HANDOFF", phase >= 2 ? "APPLIED" : "PENDING"));
      const runBody = phase === 0 ? run("RUNNING") : phase === 1 ? run("RUNNING", { pending: { type: "HANDOFF" } }) : run("CANCELLED");
      return baseRoutes(runBody, task(phase >= 2 ? "HUMAN" : "AI"))(url, init);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    expect(mounted.wrapper.find('[data-testid="run-handoff-edit"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="run-control-HANDOFF"]').trigger("click");
    await flush(60);
    expect(phase).toBe(1);
    expect(mounted.wrapper.get('[data-testid="run-control-pending"]').text()).toContain("尚未交接，人工编辑入口未开放");
    expect(mounted.wrapper.find('[data-testid="run-handoff-edit"]').exists()).toBe(false);
    phase = 2;
    await mounted.wrapper.get('[data-testid="run-refresh"]').trigger("click");
    await flush(60);
    const edit = mounted.wrapper.get('[data-testid="run-handoff-edit"]');
    expect(edit.text()).toContain("已交接，可编辑");
    expect(edit.find("a").attributes("href")).toBe(`/tasks/${taskId}`);
  });

  it("FAILED：保留产物证据并指引新 Run 重试，本页无重试或改成功按钮", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(baseRoutes(run("FAILED"), task("HUMAN"))));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    const failed = mounted.wrapper.get('[data-testid="run-failed"]').text();
    expect(failed).toContain("重试会创建新的 Run");
    expect(failed).toContain("任务详情");
    expect(mounted.wrapper.find('[data-testid="run-retry"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("标记成功");
  });

  it("UNKNOWN：核对执行结果文案、核对与重试区别、资源保护与只读证据入口", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId, status: "UNKNOWN", action_type: "WRITE_FILE", normalized_target: "C:\\relay-mock\\target.md", invocations: [{ status: "UNKNOWN" }] }]);
      return baseRoutes(run("RUNNING", { unresolved: [operationId] }), task("AI"))(url, init);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    const unknown = mounted.wrapper.get('[data-testid="run-unknown"]');
    expect(unknown.text()).toContain("等待核对执行结果");
    expect(unknown.text()).toContain("不换动作 ID、不换 Adapter、不重复执行");
    expect(unknown.text()).toContain("待接入");
    expect(unknown.text()).toContain("相关资源保持隔离");
    expect(unknown.find('[data-testid="run-success"]').exists()).toBe(false);
    await unknown.get('[data-testid="run-unknown-open-gateway"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="run-gateway-operations"]').text()).toContain(`原 operation_id：${operationId}`);
    expect(mounted.wrapper.get('[data-testid="run-resources"]').text()).toContain("未结清动作");
    expect(mounted.wrapper.get('[data-testid="run-resources"]').text()).toContain("在途或未知动作");
  });

  it("停止与完成竞争：Run 已按服务端结果 COMPLETED 时控制仍 PENDING 以服务端为准", async () => {
    activate();
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === `${runUrl}/control-requests` && init?.method === "POST") {
        cancelled = true;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: body.command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { control_request_id: requestId, run_id: runId, task_id: taskId, type: "CANCEL", status: "PENDING", run_revision: "4" } });
      }
      if (address === `${runUrl}/control-requests/${requestId}`) return response(200, controlRequest("CANCEL", "PENDING"));
      return baseRoutes(run(cancelled ? "COMPLETED" : "RUNNING"), task(cancelled ? "HUMAN" : "AI"))(url, init);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-control-CANCEL"]').trigger("click");
    await flush(60);
    const race = mounted.wrapper.get('[data-testid="run-terminal-race"]').text();
    expect(race).toContain("Run 已按服务端结果进入「已完成」终态");
    expect(race).toContain("以服务端查询结果为准");
  });
});
