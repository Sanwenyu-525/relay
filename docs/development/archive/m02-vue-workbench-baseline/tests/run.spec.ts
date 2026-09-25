import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
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

function task(status = "IN_PROGRESS") {
  return {
    id: taskId, project_id: null, title: "真实 AI 任务", status, mode: "DELEGATE_AI",
    revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] }, dependencies: []
  };
}

function run(status = "RUNNING", pending = false, unresolved: readonly string[] = []) {
  return {
    id: runId, task_id: taskId, status, revision: "3", ownership_epoch: "1", retry_of_run_id: null,
    current_step_id: "step-1", wait_reason: null, created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:01:00.000Z", terminal_at: null,
    contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "1", contract_hash: "a".repeat(64) },
    current_step: null,
    steps: [{ step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED", started_at: null, finished_at: null }],
    recent_attempts: [{ attempt_id: "attempt-1", step_id: "step-1", step_kind: "BUILD_CONTEXT", attempt_number: "1", status: "SUCCEEDED", claim_epoch: "1", started_at: null, finished_at: null }],
    result_refs: [], blocking_review_ids: [],
    pending_control_request: pending ? { id: requestId, type: "PAUSE", status: "PENDING", requested_at: "2026-09-23T00:01:00.000Z" } : null,
    unresolved_operation_ids: unresolved
  };
}

function controlRequest(status = "PENDING") {
  return {
    id: requestId, run_id: runId, task_id: taskId, type: "PAUSE", status, revision: "1",
    requested_at: "2026-09-23T00:01:00.000Z", decided_at: null, result_ref: null
  };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

describe("P08 Run 工作台", () => {
  it("示例模式不生成 Run；真实任务只在 executor.run_id 存在时提供入口", async () => {
    let mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("示例模式没有真实 Run");
    expect(mounted.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(false);
    mounted.unmount();
    unmount = null;

    activate();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === `${prefix}/tasks/${taskId}`) return response(200, task());
      throw new Error(`unexpected request: ${url}`);
    }));
    mounted = await mountWorkbench(`/tasks/${taskId}`);
    unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="task-runs"]').text()).toContain(runId);
    expect(mounted.wrapper.get('[data-testid="task-runs"] a').attributes("href")).toBe(`/runs/${runId}`);
  });

  it("真实 Run 显示步骤和 UNKNOWN，控制 202 只显示 PENDING 并绑定双版本", async () => {
    activate();
    let submitted = false;
    const posted: { body?: Record<string, unknown> } = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl && init?.method !== "POST") return response(200, run("RUNNING", submitted, ["operation-1"]));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/control-requests` && init?.method === "POST") {
        posted.body = JSON.parse(String(init.body)) as Record<string, unknown>;
        submitted = true;
        return response(202, { command_id: posted.body.command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { control_request_id: requestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "4" } });
      }
      if (address === `${runUrl}/control-requests/${requestId}`) return response(200, controlRequest());
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="run-steps"]').text()).toContain("构建上下文");
    expect(mounted.wrapper.get('[data-testid="run-unknown"]').text()).toContain("operation-1");
    await mounted.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
    await flush(60);
    expect(posted.body).toMatchObject({ expected_task_revision: "4", expected_run_revision: "3", type: "PAUSE" });
    expect(typeof posted.body?.command_id).toBe("string");
    expect(mounted.wrapper.get('[data-testid="run-control"]').text()).toContain("202 / PENDING");
    expect(mounted.wrapper.get('[data-testid="run-control"]').text()).toContain("等待安全点处理");
    expect(mounted.wrapper.text()).toContain("执行中");
    expect(mounted.wrapper.get('[data-testid="run-control-HANDOFF"]').attributes("disabled")).toBeDefined();
  });

  it("恢复响应丢失后只查原命令回执，再读取实际 Run 状态", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let resumed = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) return response(200, run(resumed ? "CONTEXT_BUILDING" : "PAUSED"));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task(resumed ? "IN_PROGRESS" : "WAITING"));
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/resume` && init?.method === "POST") {
        postCount += 1;
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("connection lost");
      }
      if (address === `${prefix}/commands/${commandId}`) {
        resumed = true;
        return response(200, { command_id: commandId, command_type: "ResumeRun", committed_at: "2026-09-23T00:01:00.000Z",
          result: { run_id: runId, status: "CONTEXT_BUILDING", run_revision: "4" } });
      }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-resume"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("响应丢失或无法核对");
    await mounted.wrapper.get('[data-testid="run-check-receipt"]').trigger("click");
    await flush(40);
    expect(postCount).toBe(1);
    expect(mounted.wrapper.text()).toContain("已找到原命令回执");
    expect(mounted.wrapper.text()).toContain("构建上下文");
  });

  it("控制提交响应丢失后只查原 command_id 回执", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) return response(200, run());
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/control-requests` && init?.method === "POST") {
        postCount += 1;
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("connection lost");
      }
      if (address === `${prefix}/commands/${commandId}`) {
        receiptCount += 1;
        return response(200, { command_id: commandId, command_type: "RequestRunControl", committed_at: "2026-09-23T00:01:00.000Z", result: { control_request_id: requestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "4" } });
      }
      if (address === `${runUrl}/control-requests/${requestId}`) return response(200, controlRequest());
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("响应丢失或无法核对");
    await mounted.wrapper.get('[data-testid="run-check-receipt"]').trigger("click");
    await flush(50);
    expect(postCount).toBe(1);
    expect(receiptCount).toBe(1);
    expect(mounted.wrapper.text()).toContain("已找到原命令回执");
  });

  it("控制响应体读取失败后保留原命令，拒绝不匹配回执并只查询原 ID", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) return response(200, run());
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/control-requests` && init?.method === "POST") {
        postCount += 1;
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        return { ok: true, status: 202, json: async () => { throw new TypeError("body stream lost"); } } as unknown as Response;
      }
      if (address === `${prefix}/commands/${commandId}`) {
        receiptCount += 1;
        return response(200, { command_id: commandId, command_type: "RequestRunControl", committed_at: "2026-09-23T00:01:00.000Z",
          result: { control_request_id: requestId, run_id: receiptCount === 1 ? taskId : runId, task_id: taskId,
            type: "PAUSE", status: "PENDING", run_revision: "4" } });
      }
      if (address === `${runUrl}/control-requests/${requestId}`) return response(200, controlRequest());
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("响应丢失或无法核对");
    await mounted.wrapper.get('[data-testid="run-check-receipt"]').trigger("click");
    await flush(30);
    expect(mounted.wrapper.text()).toContain("回执与当前 Run 或命令类型不匹配");
    expect(mounted.wrapper.text()).toContain(commandId);
    expect(mounted.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="run-check-receipt"]').trigger("click");
    await flush(40);
    expect(postCount).toBe(1);
    expect(receiptCount).toBe(2);
    expect(mounted.wrapper.text()).toContain("已找到原命令回执");
  });

  it("切换连接时丢弃旧 Run 的控制状态和迟到查询", async () => {
    activate();
    const otherWorkspace = "55555555-5555-4555-8555-555555555555";
    const otherPrefix = `${baseUrl}/api/v1/workspaces/${otherWorkspace}`;
    const oldControl: { resolve?: (value: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl || address === `${otherPrefix}/runs/${runId}`) return response(200, run());
      if (address === `${prefix}/tasks/${taskId}` || address === `${otherPrefix}/tasks/${taskId}`) return response(200, task());
      if (address === `${runUrl}/reviews` || address === `${otherPrefix}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/control-requests` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(202, { command_id: body.command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { control_request_id: requestId, run_id: runId, task_id: taskId, type: "PAUSE", status: "PENDING", run_revision: "4" } });
      }
      if (address === `${runUrl}/control-requests/${requestId}`) {
        return new Promise<Response>((resolve) => { oldControl.resolve = resolve; });
      }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
    await flush(30);
    expect(oldControl.resolve).toBeDefined();
    activateRelayConnection({ baseUrl, workspaceId: otherWorkspace, bearerToken: "other-test-token" });
    await flush(40);
    oldControl.resolve?.(response(200, controlRequest("APPLIED")));
    await flush(30);
    expect(mounted.wrapper.find('[data-testid="run-control-status"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).not.toContain("APPLIED");
    expect(mounted.wrapper.find('[data-testid="run-control-PAUSE"]').exists()).toBe(true);
  });

  it("已暂停 Run 的恢复带双版本；202 后以重新读取状态为准", async () => {
    activate();
    let resumed = false;
    let postBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) return response(200, run(resumed ? "CONTEXT_BUILDING" : "PAUSED"));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task(resumed ? "IN_PROGRESS" : "WAITING"));
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/resume` && init?.method === "POST") {
        postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        resumed = true;
        return response(202, { command_id: postBody.command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { run_id: runId, status: "CONTEXT_BUILDING", run_revision: "4" } });
      }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-resume"]').trigger("click");
    await flush(50);
    expect(postBody).toMatchObject({ expected_task_revision: "4", expected_run_revision: "3" });
    expect(mounted.wrapper.text()).toContain("恢复命令已受理（202）");
    expect(mounted.wrapper.text()).toContain("构建上下文");
  });
});
