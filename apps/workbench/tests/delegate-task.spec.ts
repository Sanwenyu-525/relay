import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const taskUrl = `${prefix}/tasks/${taskId}`;
const runUrl = `${prefix}/runs/${runId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function task(delegated = false, project: string | null = projectId, allowedActions: string[] = ["START"]) {
  return {
    id: taskId, project_id: project, title: "待委托任务", status: delegated ? "IN_PROGRESS" : "READY",
    mode: delegated ? "DELEGATE_AI" : "ME", revision: delegated ? "3" : "2",
    executor: { kind: delegated ? "AI" : "HUMAN", run_id: delegated ? runId : null, ownership_epoch: delegated ? "1" : "0" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
    allowed_actions: delegated ? [] : allowedActions,
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] },
    dependencies: []
  };
}

function run() {
  return {
    id: runId, task_id: taskId, status: "CREATED", revision: "0", wait_reason: null,
    current_step_id: null, steps: [], recent_attempts: [], blocking_review_ids: [],
    pending_control_request: null, unresolved_operation_ids: []
  };
}

function result() {
  return { run_id: runId, task_id: taskId, task_revision: "3", run_revision: "0", status: "CREATED", retry_of_run_id: null };
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

function downstream(url: string, delegated: boolean): Response | null {
  if (url === taskUrl) return response(200, task(delegated));
  if (url === runUrl) return response(200, run());
  if (url === `${runUrl}/reviews`) return response(200, { items: [] });
  if (url === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
  return null;
}

describe("M03 首片 Task Delegate", () => {
  it("真实 READY/HUMAN 任务提交原版本命令，202 后进入真实 Run", async () => {
    activate();
    let delegated = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        delegated = true;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, delegated) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush(50);
    expect(posted).toMatchObject({ expected_task_revision: "2" });
    expect(posted).not.toHaveProperty("mock_gateway_action");
    expect(typeof (posted as Record<string, unknown> | null)?.command_id).toBe("string");
    expect(mounted.router.currentRoute.value.path).toBe(`/runs/${runId}`);
    expect(mounted.wrapper.get('[data-testid="run-detail"]').text()).toContain("待委托任务");
  });

  it("可选 Mock 文件动作从本项目配置选择，并随原 Delegate 命令冻结", async () => {
    activate();
    const connectionId = "55555555-5555-4555-8555-555555555555";
    const resourceId = "66666666-6666-4666-8666-666666666666";
    const target = "C:\\relay-mock\\sample.txt";
    let delegated = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${prefix}/projects/${projectId}/connections`) return response(200, [
        { id: connectionId, status: "ACTIVE", capabilities: ["FAKE_WRITE"] },
        { id: "77777777-7777-4777-8777-777777777777", status: "DISABLED", capabilities: ["FAKE_WRITE"] }
      ]);
      if (url === `${prefix}/projects/${projectId}/managed-resources`) return response(200, [
        { id: resourceId, status: "ACTIVE", canonical_root: "C:\\relay-mock" }
      ]);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        delegated = true;
        return response(202, { command_id: posted.command_id, committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, delegated) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-mock-action-toggle"]').setValue(true);
    await flush();
    expect(mounted.wrapper.get('[data-testid="task-mock-connection"]').findAll("option")).toHaveLength(2);
    await mounted.wrapper.get('[data-testid="task-mock-target"]').setValue(target);
    await mounted.wrapper.get('[data-testid="task-mock-content"]').setValue("Mock marker");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush(50);
    expect(posted).toMatchObject({ expected_task_revision: "2", mock_gateway_action: {
      connection_id: connectionId, resource_id: resourceId, target, content: "Mock marker"
    } });
    expect(mounted.router.currentRoute.value.path).toBe(`/runs/${runId}`);
  });

  it("响应丢失与回执暂缺时仅用原 command_id 查询，核对后进入 Run", async () => {
    activate();
    let delegated = false;
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        postCount++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("network lost");
      }
      if (url === `${prefix}/commands/${commandId}`) {
        receiptCount++;
        if (receiptCount === 1) return response(404, { code: "COMMAND_NOT_FOUND", detail: "pending" });
        delegated = true;
        return response(200, { command_id: commandId, command_type: "DelegateTask", committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, delegated) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(commandId);
    expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("结果仍未确定");
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click");
    await flush(50);
    expect(postCount).toBe(1); expect(receiptCount).toBe(2);
    expect(mounted.router.currentRoute.value.path).toBe(`/runs/${runId}`);
  });

  it("成功响应无法核对时保留原 ID，拒绝不匹配的 Delegate 回执", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${taskUrl}/delegations` && init?.method === "POST") {
        postCount++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        return response(202, { command_id: "wrong-command", committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      if (url === `${prefix}/commands/${commandId}`) {
        receiptCount++;
        return response(200, { command_id: commandId, command_type: receiptCount === 1 ? "ResumeRun" : "DelegateTask",
          committed_at: "2026-09-24T00:00:00.000Z", result: result() });
      }
      return downstream(url, false) ?? Promise.reject(new Error(`unexpected request: ${url}`));
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    await mounted.wrapper.get('[data-testid="task-delegate"]').trigger("click");
    await flush();
    await mounted.wrapper.get('[data-testid="delegate-check-receipt"]').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("无法匹配");
    expect(mounted.router.currentRoute.value.path).toBe(`/tasks/${taskId}`);
    expect(mounted.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(commandId);
    expect(postCount).toBe(1);
  });

  it("fixture 不提供 Delegate；无 Project 的 READY 任务也不能委托", async () => {
    let mounted = await mountWorkbench("/tasks/task-evaluation-metrics"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
    mounted.unmount(); unmount = null;
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (String(input) === taskUrl) return response(200, task(false, null));
      throw new Error("unexpected request");
    }));
    mounted = await mountWorkbench(`/tasks/${taskId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="task-detail-tab-runs"]').trigger("click");
    expect(mounted.wrapper.get('[data-testid="task-delegate"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="task-delegate-panel"]').text()).toContain("缺少 AI 执行作用域");
  });
});
