import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const pathPrefix = `/api/v1/workspaces/${workspaceId}`;
const runPath = `${pathPrefix}/runs/${runId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function sseResponse(): Response {
  return { ok: true, status: 200, headers: { get: () => "text/event-stream; charset=utf-8" },
    body: new ReadableStream<Uint8Array>() } as unknown as Response;
}

function task() {
  return {
    id: taskId, project_id: null, title: "呈现呈现核对任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
    revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] }, dependencies: []
  };
}

function run(status: string) {
  return {
    id: runId, task_id: taskId, status, revision: "4", ownership_epoch: "1", retry_of_run_id: null,
    current_step_id: null, wait_reason: null, created_at: "2026-09-24T00:00:00.000Z",
    updated_at: "2026-09-24T00:01:00.000Z", terminal_at: null,
    contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "1", contract_hash: "a".repeat(64) },
    current_step: null, steps: [], recent_attempts: [], result_refs: [], blocking_review_ids: [],
    pending_control_request: null, unresolved_operation_ids: []
  };
}

const operationId = "55555555-5555-4555-8555-555555555555";
const operations = [{ id: operationId, status: "SUCCEEDED", action_type: "APPLY_CHANGESET",
  normalized_target: "D:\\repo\\out.md", invocations: [{ status: "SUCCEEDED" }, { status: "UNKNOWN" }] }];

function stubRunRoutes(status: string, routeOperations: unknown[] | null = null): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === `${runPath}/events`) return sseResponse();
    if (path === `${runPath}/operations`) return jsonResponse(routeOperations ?? []);
    if (path === runPath) return jsonResponse(run(status));
    if (path === `${pathPrefix}/tasks/${taskId}`) return jsonResponse(task());
    if (path === `${runPath}/reviews`) return jsonResponse({ items: [] });
    if (path === `${runPath}/context-manifests`) return jsonResponse({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
    throw new Error(`unexpected request ${path}`);
  }));
}

describe("Run 页呈现中文化（C1 整改）", () => {
  it("Gateway 动作历史以中文呈现动作与状态，原枚举降级为 small 供核对", async () => {
    stubRunRoutes("RUNNING", operations);
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(60);
    const panel = mounted.wrapper.get('[data-testid="run-gateway-operations"]');
    await panel.get("button").trigger("click");
    await flush(30);
    const text = panel.text();
    expect(text).toContain("应用变更集（APPLY_CHANGESET） · 已成功（SUCCEEDED）");
    expect(text).toContain("调用状态：已成功（SUCCEEDED）、结果未知（UNKNOWN）");
    expect(text).toContain(`原 operation_id：${operationId}`);
  });

  it("Run 状态 chip 只在服务端确认完成时使用成功色调", async () => {
    stubRunRoutes("COMPLETED");
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    const chip = mounted.wrapper.get('[data-testid="run-page-head"] .status-chip');
    expect(chip.attributes("class")).toContain("status-chip--success");
    expect(chip.text()).toBe("已完成");
  });

  it("失败与暂停的 chip 语义不变：失败危险、暂停警告", async () => {
    stubRunRoutes("PAUSED");
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="run-page-head"] .status-chip').attributes("class"))
      .toContain("status-chip--warning");
  });

  it("资源与租约按要点分行：结论在前、限定说明降级为辅文", async () => {
    stubRunRoutes("RUNNING");
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    const points = mounted.wrapper.get('[data-testid="run-resources"]').findAll(".run-resource-points > li");
    expect(points.length).toBeGreaterThan(0);
    const lease = points[points.length - 1]!;
    expect(lease.get("strong").text()).toBe("租约");
    expect(lease.get("p").text()).toContain("租约过期只说明旧 Worker 不再被信任，不能推断旧子进程已经停止");
    expect(lease.get("small").text()).toContain("不能仅凭租约到期启动新的冲突命令");
  });
});
