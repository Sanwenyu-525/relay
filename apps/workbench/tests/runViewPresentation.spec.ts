import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";
import { runFrom } from "../src/api/parse/run";

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

function stubRunRoutes(status: string, routeOperations: unknown[] | null = null, activeDraft = false,
  resultRefs: unknown[] = [], taskFields: Record<string, unknown> = {}): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === `${runPath}/events`) return sseResponse();
    if (path === `${runPath}/operations`) return jsonResponse(routeOperations ?? []);
    if (path === runPath) return jsonResponse(activeDraft ? { ...run(status), current_step_id: "draft",
      steps: [{ step_id: "draft", step_index: 1, step_kind: "DRAFT", status: "RUNNING",
        started_at: "2026-11-05T00:00:00Z", finished_at: null }] } : { ...run(status), result_refs: resultRefs });
    if (path === `${pathPrefix}/tasks/${taskId}`) return jsonResponse({ ...task(), ...taskFields });
    if (path === `${runPath}/reviews`) return jsonResponse({ items: [] });
    if (path === `${runPath}/context-manifests`) return jsonResponse({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
    throw new Error(`unexpected request ${path}`);
  }));
}

describe("Run 页呈现中文化（C1 整改）", () => {
  it.each(["CANCELLED", "PAUSED", "RUNNING"])("%s 的当前步骤不将历史 RUNNING 冒充仍在执行", async (status) => {
    stubRunRoutes(status, null, true);
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    const action = mounted.wrapper.get('[data-testid="run-current-action"]');
    if (status === "RUNNING") expect(action.text()).toContain("执行中");
    else {
      expect(action.text()).not.toContain("执行中");
      expect(action.text()).toContain(status === "PAUSED" ? "已暂停" : "已停止");
      expect(mounted.wrapper.get('[data-testid="run-steps"]').find('[data-step-status="RUNNING"]').exists()).toBe(false);
    }
  });
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


describe("原 Run 保存结果导航", () => {
  const versionId = "66666666-6666-4666-8666-666666666666";
  const completionId = "77777777-7777-4777-8777-777777777777";
  const newCompletionId = "88888888-8888-4888-8888-888888888888";
  const persist = { step_kind: "PERSIST", result_ref: { artifact_version_id: versionId } };
  it("历史执行只链接自己的完成凭据与保存版本，不追随任务新周期", async () => {
    stubRunRoutes("COMPLETED", null, false, [persist,
      { step_kind: "COMPLETE", result_ref: { completion_id: completionId } }],
      { status: "DONE", current_completion_id: newCompletionId, executor: { kind: "HUMAN", run_id: null, ownership_epoch: "2" } });
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    const results = mounted.wrapper.get('[data-testid="run-saved-results"]');
    expect(results.get('[data-testid="run-completion-record"]').attributes("href")).toBe(`/completion-records/${completionId}`);
    expect(results.find(`a[href="/artifact-versions/${versionId}/lineage"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/completion-records/${newCompletionId}"]`).exists()).toBe(false);
    expect(results.text()).toContain("候选版本不等于已接受成果");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("已完成但缺原凭据引用时不从当前 Task 补猜", async () => {
    stubRunRoutes("COMPLETED", null, false, [], { status: "DONE", current_completion_id: newCompletionId });
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    const results = mounted.wrapper.get('[data-testid="run-saved-results"]');
    expect(results.text()).toContain("尚未返回完成凭据引用");
    expect(results.find('[data-testid="run-completion-record"]').exists()).toBe(false);
    expect(results.findAll("a")).toHaveLength(0);
  });
  it("暂停后已保存候选可核对来源，不显示正式完成入口", async () => {
    stubRunRoutes("PAUSED", null, false, [persist]);
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.find(`a[href="/artifact-versions/${versionId}/lineage"]`).exists()).toBe(true);
    expect(mounted.wrapper.find('[data-testid="run-completion-record"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="run-paused-summary"]').text()).not.toContain("产物清单接口待接入");
    expect(mounted.wrapper.get('[data-testid="run-paused-summary"]').text()).toContain("保存不代表验收通过");
  });
  it("没有保存引用的普通运行不制造结果面板", async () => {
    stubRunRoutes("RUNNING");
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.find('[data-testid="run-saved-results"]').exists()).toBe(false);
  });
  it("仅解析 PERSIST 的保存引用、去重，不拿草稿或其他步骤冒充产物", () => {
    const parsed = runFrom({ ...run("PAUSED"), result_refs: [persist, persist,
      { step_kind: "DRAFT", result_ref: { artifact_version_id: "draft-not-persisted" } },
      { step_kind: "PERSIST", result_ref: { reason: "STORAGE_FAILED" } }] });
    expect(parsed.savedArtifactVersionIds).toEqual([versionId]);
    expect(parsed.completionId).toBeNull();
    expect(() => runFrom({ ...run("PAUSED"), result_refs: [{ step_kind: "PERSIST", result_ref: { artifact_version_id: 123 } }] })).toThrow();
  });
});
