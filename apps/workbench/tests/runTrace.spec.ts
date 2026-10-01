import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";
import { RelayApiClient } from "../src/api/relayClient";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const stepId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const versionId = "66666666-6666-4666-8666-666666666666";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const runUrl = `${root}/runs/${runId}`;
const at = "2026-09-26T00:00:00Z";
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function task() { return { id: taskId, project_id: null, title: "可追溯任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
  revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" }, current_completion_id: null,
  waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  acceptance: { acceptance_revision: "1", objective: "核对证据", source: "CREATE", criteria: [] }, dependencies: [] }; }
function run() { return { id: runId, task_id: taskId, status: "RUNNING", revision: "3", ownership_epoch: "1",
  retry_of_run_id: null, current_step_id: stepId, wait_reason: null, created_at: at, updated_at: at, terminal_at: null,
  contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1",
    acceptance_revision: "1", contract_hash: "a".repeat(64) }, current_step: null, steps: [], recent_attempts: [],
  result_refs: [], blocking_review_ids: [], pending_control_request: null, unresolved_operation_ids: [] }; }
function trace() { return { run_id: runId, task_id: taskId, project_id: null, status: "RUNNING",
  steps: [{ id: stepId, step_index: 0, kind: "BUILD_CONTEXT", status: "SUCCEEDED", revision: "1",
    result_available: true, started_at: at, finished_at: at }],
  attempts: [{ id: attemptId, step_id: stepId, attempt_number: "1", status: "SUCCEEDED", claim_epoch: "1",
    result_available: true, started_at: at, finished_at: at }],
  model_calls: [{ id: "77777777-7777-4777-8777-777777777777", step_attempt_id: attemptId, manifest_id: null,
    status: "SUCCEEDED", provider: "mock", model: "mock-model", input_sha256: "b".repeat(64),
    read_operation_id: null, read_invocation_id: null, usage_input_tokens: 12, usage_output_tokens: 3,
    started_at: at, settled_at: at }],
  manifests: [{ id: "88888888-8888-4888-8888-888888888888", step_id: stepId, builder_version: "1",
    sha256: "c".repeat(64), created_at: at, sources: [{ kind: "KNOWLEDGE", source_ref: "hidden-source-id",
      version: "hidden-version", sha256: "hidden-hash", source_sha256: "hidden-source-hash", role: "SOURCE",
      trust: "UNTRUSTED", availability: "UNAVAILABLE" }] }],
  verifications: [{ id: "99999999-9999-4999-8999-999999999999", status: "COMPLETED", verdict: "PASS",
    acceptance_revision: "1", check_plan_hash: "d".repeat(64), parent_session_id: null,
    targets: [{ artifact_version_id: versionId, content_sha256: "e".repeat(64) }],
    checks: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", criterion_id: "criterion-1", result: "PASS",
      severity: "INFO", required: true, created_at: at }], created_at: at, finalized_at: at }],
  reviews: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "ACTION_APPROVAL", status: "DECIDED",
    operation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", verification_session_id: null,
    target_hash: "f".repeat(64), decision: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", value: "APPROVE", decided_at: at },
    created_at: at, decided_at: at }],
  operations: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", step_id: stepId, capability: "FAKE_WRITE",
    action_type: "WRITE_MARKER", status: "UNKNOWN", params_sha256: "1".repeat(64), result_available: false,
    invocations: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", attempt_number: "1", status: "UNKNOWN",
      result_available: false, created_at: at, resolved_at: null }], created_at: at, updated_at: at }],
  effects: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", step_id: stepId, status: "UNKNOWN",
    params_sha256: "1".repeat(64), result_available: false, created_at: at, resolved_at: null }] }; }

describe("P15 Run Trace", () => {
  it.each([
    ["AUTH", "认证失败"], ["RATE_LIMIT", "限流"], ["TIMEOUT", "超时"],
    ["STREAM_BROKEN", "流中断"], ["PROTOCOL", "响应结构异常"], ["NETWORK", "网络不可达"]
  ])("确切历史模型调用显示 %s 类别和处理指引，不将调用失败宣称为 Run 失败", async (category, guide) => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const data = trace();
    const failedCall = { ...data.model_calls[0], status: "FAILED", kind: "SEMANTIC_CHECK",
      criterion_id: "quality", check_attempt: 2, provider_error_kind: category,
      provider_request_id: "provider-request-1", usage_input_tokens: null, usage_output_tokens: null };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === runUrl) return response(run());
      if (url === `${root}/tasks/${taskId}`) return response(task());
      if (url === `${runUrl}/reviews`) return response({ items: [] });
      if (url === `${runUrl}/context-manifests`) return response({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (url === `${runUrl}/trace`) return response({ ...data, model_calls: [failedCall] });
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="run-trace-toggle"]').trigger("click"); await flush();
    const panel = mounted.wrapper.get('[data-testid="run-trace"]');
    expect(panel.text()).toContain(`状态 RUNNING`);
    expect(panel.text()).toContain(guide);
    expect(panel.text()).toContain(attemptId);
    expect(panel.text()).toContain("SEMANTIC_CHECK");
    expect(panel.text()).toContain("quality");
    expect(panel.text()).toContain("检查尝试 2");
    expect(panel.text()).toContain("provider-request-1");
    expect(panel.text()).toContain("Token 输入 未知 / 输出 未知");
    expect(panel.text()).toContain("调用失败不等于 Run 失败");
  });

  it("旧服务缺诊断字段时保留未知，不推断 Provider 故障", async () => {
    const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => response(trace())));
    expect((await client.getRunTrace(runId)).modelCalls[0]).toMatchObject({
      kind: null, criterionId: null, checkAttempt: null, providerErrorKind: null, providerRequestId: null,
      firstTextDeltaAt: null, firstPreviewPersistedAt: null
    });
  });

  it("同一步骤不同调用与条件保留独立身份；取消和本地错误仍无 Provider 类别", async () => {
    const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-token" });
    const data = trace();
    const calls = [
      { ...data.model_calls[0], status: "FAILED", kind: "SEMANTIC_CHECK", criterion_id: "first",
        check_attempt: 1, provider_error_kind: "AUTH", provider_request_id: "request-first",
        first_text_delta_at: at, first_preview_persisted_at: "2026-09-26T00:00:01Z" },
      { ...data.model_calls[0], id: "other-call", status: "CANCELLED", kind: "SEMANTIC_CHECK", criterion_id: "second",
        check_attempt: 2, provider_error_kind: null, provider_request_id: "request-second" },
      { ...data.model_calls[0], id: "local-call", status: "FAILED", provider_error_kind: null }
    ];
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...data, model_calls: calls })));
    expect((await client.getRunTrace(runId)).modelCalls).toMatchObject([
      { id: calls[0]!.id, stepAttemptId: attemptId, criterionId: "first", checkAttempt: 1,
        providerErrorKind: "AUTH", providerRequestId: "request-first",
        firstTextDeltaAt: at, firstPreviewPersistedAt: "2026-09-26T00:00:01Z" },
      { id: "other-call", stepAttemptId: attemptId, criterionId: "second", checkAttempt: 2,
        providerErrorKind: null, providerRequestId: "request-second" },
      { id: "local-call", status: "FAILED", providerErrorKind: null }
    ]);
  });

  it.each([
    { status: "CANCELLED", provider_error_kind: "NETWORK" },
    { status: "COMPLETED", provider_error_kind: "AUTH" },
    { status: "STARTED", provider_error_kind: "TIMEOUT" },
    { status: "FAILED", provider_error_kind: "LOCAL_WRITE_ERROR" }
  ])("拒绝非失败状态或词表外的 Provider 类别：%j", async (fields) => {
    const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-token" });
    const data = trace();
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...data,
      model_calls: [{ ...data.model_calls[0], ...fields }] })));
    await expect(client.getRunTrace(runId)).rejects.toThrow("Provider 失败类别无效");
  });

  it("按需读真实证据并分别展示 Review、Gateway 和 Effect，不泄露不可用来源", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === runUrl) return response(run());
      if (url === `${root}/tasks/${taskId}`) return response(task());
      if (url === `${runUrl}/reviews`) return response({ items: [] });
      if (url === `${runUrl}/context-manifests`) return response({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (url === `${runUrl}/trace`) return response(trace());
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    expect(calls).not.toContain(`${runUrl}/trace`);
    await mounted.wrapper.get('[data-testid="run-trace-toggle"]').trigger("click"); await flush();
    const panel = mounted.wrapper.get('[data-testid="run-trace"]');
    expect(calls).toContain(`${runUrl}/trace`);
    expect(panel.text()).toContain("有结果引用（不代表成功）");
    expect(panel.text()).toContain("来源当前不可用或无权读取");
    expect(panel.text()).not.toContain("hidden-source-id");
    expect(panel.text()).not.toContain("hidden-version");
    expect(panel.text()).toContain("决定 APPROVE");
    expect(panel.text()).toContain("Run Effect · 1");
    expect(panel.text()).toContain("UNKNOWN");
    expect(panel.find(`a[href="/artifact-versions/${versionId}/lineage"]`).exists()).toBe(true);
  });

  it("刷新失去读取权限时清除旧 Trace", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let traceReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === runUrl) return response(run());
      if (url === `${root}/tasks/${taskId}`) return response(task());
      if (url === `${runUrl}/reviews`) return response({ items: [] });
      if (url === `${runUrl}/context-manifests`) return response({ items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (url === `${runUrl}/trace`) return ++traceReads === 1 ? response(trace())
        : response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="run-trace-toggle"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="run-trace"]').text()).toContain("决定 APPROVE");
    await mounted.wrapper.get('[data-testid="run-trace"]').get("button").trigger("click"); await flush();
    const panel = mounted.wrapper.get('[data-testid="run-trace"]');
    expect(panel.text()).toContain("当前不可读取或无权查看");
    expect(panel.text()).not.toContain("决定 APPROVE");
  });
});
