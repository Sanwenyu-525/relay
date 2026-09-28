import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const operationId = "55555555-5555-4555-8555-555555555555";
const invocationId = "66666666-6666-4666-8666-666666666666";
const changeSetId = "77777777-7777-4777-8777-777777777777";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const runUrl = `${prefix}/runs/${runId}`;
const dispositionUrl = `${prefix}/operations/${operationId}/file-write-disposition`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function task(failed: boolean) { return {
  id: taskId, project_id: null, title: "文件动作任务", status: failed ? "READY" : "IN_PROGRESS", mode: "DELEGATE_AI",
  revision: failed ? "5" : "4", executor: failed ? { kind: "HUMAN", run_id: null } : { kind: "AI", run_id: runId, ownership_epoch: "1" },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  acceptance: { acceptance_revision: "1", objective: "核对文件", source: "CREATE", criteria: [] }, dependencies: []
}; }
function run(failed: boolean) { return {
  id: runId, task_id: taskId, status: failed ? "FAILED" : "RUNNING", revision: failed ? "4" : "3",
  ownership_epoch: "1", retry_of_run_id: null, current_step_id: null, wait_reason: null,
  created_at: "2026-09-27T00:00:00.000Z", updated_at: "2026-09-27T00:01:00.000Z", terminal_at: null,
  contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1",
    acceptance_revision: "1", contract_hash: "a".repeat(64) },
  current_step: null, steps: [], recent_attempts: [], result_refs: [], blocking_review_ids: [],
  pending_control_request: null, unresolved_operation_ids: failed ? [] : [operationId]
}; }
function preview(canDispose: boolean, disposed = false) { return {
  operation_id: operationId, invocation_id: invocationId, change_set_id: changeSetId, run_id: runId,
  run_revision: disposed ? "4" : "3", task_revision: disposed ? "5" : "4",
  operation_status: disposed ? "MANUALLY_CLOSED" : "UNKNOWN", stop_proof_recorded: canDispose || disposed,
  can_dispose: canDispose && !disposed, blocking_reasons: canDispose || disposed ? [] : ["TRUSTED_STOP_PROOF_REQUIRED"],
  observation_sha256: disposed ? null : "b".repeat(64),
  files: disposed ? [] : [{ relative_path: "a.txt", ledger_status: "APPLIED", ledger_actual_sha256: "c".repeat(64),
    current_sha256: "c".repeat(64), readable: true },
    { relative_path: "b.txt", ledger_status: "CONFLICT", ledger_actual_sha256: null,
      current_sha256: "d".repeat(64), readable: true }],
  disposition: disposed ? { id: "decision-id", decision: "KEEP_CURRENT_AND_FAIL_RUN",
    created_at: "2026-09-27T00:02:00.000Z", observation_sha256: "b".repeat(64),
    observation: { files: [{ path: "a.txt", ledger_status: "APPLIED", ledger_actual_sha256: "c".repeat(64),
      current_sha256: "c".repeat(64) }, { path: "b.txt", ledger_status: "CONFLICT",
      ledger_actual_sha256: null, current_sha256: "d".repeat(64) }] } } : null
}; }
function ledger() { return { operation_id: operationId, change_sets: [{ id: changeSetId, invocation_id: invocationId,
  status: "PARTIAL", files: [{ relative_path: "a.txt", action: "CREATE", status: "APPLIED", error: null },
    { relative_path: "b.txt", action: "MODIFY", status: "CONFLICT", error: "BASELINE_CHANGED" }] }] }; }
function noReceiptPreview(disposed = false) { return {
  ...preview(true, disposed), observation_mode: disposed ? null : "NO_RECEIPT",
  files: disposed ? [] : [{ relative_path: "existing.txt", ledger_status: "UNKNOWN", ledger_actual_sha256: null,
    current_sha256: null, current_target_id: null, readable: true,
    parent_chain: [], residual_candidates: [{ path: ".__relay-file-io-example.tmp",
      id: "0123456789abcdef:0123456789abcdef0123456789abcdef", sha256: "d".repeat(64),
      status: "READABLE", error: null }] }],
  disposition: disposed ? { id: "decision-id", decision: "KEEP_CURRENT_AND_FAIL_RUN",
    created_at: "2026-09-27T00:02:00.000Z", observation_sha256: "b".repeat(64),
    observation: { observation_mode: "NO_RECEIPT", files: [{ path: "existing.txt",
      ledger_status: "UNKNOWN", current_sha256: null, current_target_id: null,
      residual_candidates: [{ path: ".__relay-file-io-example.tmp",
        id: "0123456789abcdef:0123456789abcdef0123456789abcdef",
        sha256: "d".repeat(64), status: "READABLE", error: null }] }] } } : null,
}; }

describe("M06 文件写入人工处置", () => {
  it("无回执 UNKNOWN 展示候选但不归因，人工决定仍绑定原调用与观察摘要", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let disposed = false;
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) return response(200, run(disposed));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task(disposed));
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/context-manifests`) return response(200,
        { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId,
        status: disposed ? "MANUALLY_CLOSED" : "UNKNOWN", action_type: "APPLY_CHANGESET", normalized_target: "C:\\relay\\root",
        invocations: [{ status: "UNKNOWN" }] }]);
      if (address === `${prefix}/operations/${operationId}/change-sets`) return response(200, {
        operation_id: operationId, change_sets: [{ id: changeSetId, invocation_id: invocationId,
          status: "UNKNOWN", files: [{ relative_path: "existing.txt", action: "MODIFY",
            status: "UNKNOWN", error: null }] }] });
      if (address === dispositionUrl && init?.method !== "POST") return response(200, noReceiptPreview(disposed));
      if (address === dispositionUrl && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        disposed = true;
        return response(200, { command_id: posted.command_id, committed_at: "2026-09-27T00:02:00.000Z",
          result: { operation_id: operationId, invocation_id: invocationId, run_id: runId,
            run_status: "FAILED", decision: "KEEP_CURRENT_AND_FAIL_RUN" } });
      }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30); await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30);
    const panel = mounted.wrapper.get('[data-testid="run-file-write-operation"]');
    expect(panel.text()).toContain("逐文件账本：UNKNOWN");
    expect(panel.text()).toContain("不能归因于原调用");
    expect(panel.text()).toContain(".__relay-file-io-example.tmp");
    expect(panel.text()).toContain("0123456789abcdef:0123456789abcdef0123456789abcdef");
    await panel.get('[data-testid="file-write-dispose-open"]').trigger("click");
    expect(document.body.textContent).toContain("确认人工结清无回执文件写入");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="file-write-dispose-confirm"]')?.click(); });
    await flush(50);
    expect(posted).toMatchObject({ invocation_id: invocationId,
      expected_observation_sha256: "b".repeat(64), decision: "KEEP_CURRENT_AND_FAIL_RUN" });
    expect(panel.text()).toContain("当时候选残留（不归因于原调用）");
    expect(panel.text()).toContain(".__relay-file-io-example.tmp");
  });

  it("按需显示冻结计划文本差异，并明确历史基线缺失", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const diffUrl = `${prefix}/operations/${operationId}/file-write-diff`;
    let diffReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const address = String(url);
      if (address === runUrl) return response(200, run(false));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task(false));
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/context-manifests`) return response(200,
        { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId, status: "UNKNOWN",
        action_type: "APPLY_CHANGESET", normalized_target: "C:\\relay\\root", invocations: [{ status: "UNKNOWN" }] }]);
      if (address === `${prefix}/operations/${operationId}/change-sets`) return response(200, {
        operation_id: operationId, change_sets: [{ id: changeSetId, invocation_id: invocationId,
          status: "PARTIAL", files: [
            { relative_path: "a.txt", action: "CREATE", status: "APPLIED", error: null },
            { relative_path: "b.txt", action: "MODIFY", status: "CONFLICT", error: "BASELINE_CHANGED" },
            { relative_path: "legacy.txt", action: "MODIFY", status: "FAILED", error: "OLD_OPERATION" }
          ] }] });
      if (address === dispositionUrl) return response(200, preview(false));
      if (address === diffUrl) {
        diffReads++;
        return response(200, { operation_id: operationId, basis: "FROZEN_INTENT", files: [
          { relative_path: "a.txt", action: "CREATE", baseline_sha256: null,
            target_sha256: "a".repeat(64), availability: "AVAILABLE", unavailable_reason: null,
            before_text: "", after_text: "keep\nnew\nend\n" },
          { relative_path: "b.txt", action: "MODIFY", baseline_sha256: "b".repeat(64),
            target_sha256: "c".repeat(64), availability: "AVAILABLE",
            unavailable_reason: null, before_text: "keep\nold\nend\n", after_text: "keep\nnew\nend\n" },
          { relative_path: "legacy.txt", action: "MODIFY", baseline_sha256: "d".repeat(64),
            target_sha256: "e".repeat(64), availability: "UNAVAILABLE",
            unavailable_reason: "BASELINE_UNAVAILABLE", before_text: null, after_text: null }
        ] });
      }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30);
    expect(diffReads).toBe(0);
    await mounted.wrapper.get('[data-testid="file-write-diff-open"]').trigger("click");
    await flush(30);
    const diff = mounted.wrapper.get('[data-testid="file-write-frozen-diff"]');
    expect(diffReads).toBe(1);
    expect(diff.text()).toContain("仅描述计划，不代表文件已应用");
    expect(diff.findAll(".file-write-frozen-diff__line--add").map((row) => row.text()).join(" ")).toContain("new");
    expect(diff.findAll(".file-write-frozen-diff__line--remove").map((row) => row.text()).join(" ")).toContain("old");
    expect(diff.text()).toContain("历史动作没有保存冻结基线原文");
    expect(diff.text()).toContain("不从当前磁盘补造旧基线");
  });

  it("显示 UNKNOWN/PARTIAL 和当前文件摘要；缺停机证明时无处置入口", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const fetcher = vi.fn(async (url: string) => {
      const address = String(url);
      if (address === runUrl) return response(200, run(false));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task(false));
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId, status: "UNKNOWN",
        action_type: "APPLY_CHANGESET", normalized_target: "C:\\relay\\root", invocations: [{ status: "UNKNOWN" }] }]);
      if (address === `${prefix}/operations/${operationId}/change-sets`) return response(200, ledger());
      if (address === dispositionUrl) return response(200, preview(false));
      throw new Error(`unexpected request: ${address}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30);
    await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30);
    const panel = mounted.wrapper.get('[data-testid="run-file-write-operation"]');
    expect(panel.text()).toContain("FILE_WRITE 原动作 · UNKNOWN");
    expect(panel.text()).toContain("逐文件账本：PARTIAL");
    expect(panel.text()).toContain("a.txt · 账本 APPLIED（账本记录已应用） · 当前");
    expect(panel.text()).toContain("b.txt · 账本 CONFLICT（冲突） · 当前");
    expect(panel.text()).toContain("停机证明：未记录");
    expect(panel.text()).toContain("TRUSTED_STOP_PROOF_REQUIRED");
    expect(panel.find('[data-testid="file-write-dispose-open"]').exists()).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url) === dispositionUrl)).toBe(true);
  });

  it("仅 can_dispose 时二次确认，提交原调用和观察哈希，随后刷新 Run、Task 与证据", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let disposed = false; let posted: Record<string, unknown> = {}; let postCount = 0;
    let runReads = 0; let taskReads = 0; let evidenceReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) { runReads++; return response(200, run(disposed)); }
      if (address === `${prefix}/tasks/${taskId}`) { taskReads++; return response(200, task(disposed)); }
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId,
        status: disposed ? "MANUALLY_CLOSED" : "UNKNOWN", action_type: "APPLY_CHANGESET",
        normalized_target: "C:\\relay\\root", invocations: [{ status: "UNKNOWN" }] }]);
      if (address === `${prefix}/operations/${operationId}/change-sets`) { evidenceReads++; return response(200, ledger()); }
      if (address === dispositionUrl && init?.method !== "POST") { evidenceReads++; return response(200, preview(true, disposed)); }
      if (address === dispositionUrl && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted = body; postCount++; disposed = true;
        return response(200, { command_id: body.command_id, committed_at: "2026-09-27T00:02:00.000Z",
          result: { operation_id: operationId, invocation_id: invocationId, run_id: runId,
            run_status: "FAILED", decision: "KEEP_CURRENT_AND_FAIL_RUN" } });
      }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30); await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30);
    await mounted.wrapper.get('[data-testid="file-write-dispose-open"]').trigger("click");
    expect(postCount).toBe(0);
    expect(document.body.textContent).toContain("确认人工结清部分文件写入");
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="file-write-dispose-confirm"]');
    expect(confirm).not.toBeNull(); await act(async () => { confirm?.click(); });
    await flush(50);
    expect(posted).toMatchObject({ invocation_id: invocationId, decision: "KEEP_CURRENT_AND_FAIL_RUN",
      expected_run_revision: "3", expected_task_revision: "4", expected_observation_sha256: "b".repeat(64) });
    expect(typeof posted.command_id).toBe("string");
    expect(runReads).toBeGreaterThan(1); expect(taskReads).toBeGreaterThan(1); expect(evidenceReads).toBeGreaterThan(2);
    expect(mounted.wrapper.get('[data-testid="run-file-write-operation"]').text()).toContain("MANUALLY_CLOSED");
    expect(mounted.wrapper.get('[data-testid="run-file-write-operation"]').text()).toContain("保留当时文件并结束旧 Run");
    expect(mounted.wrapper.get('[data-testid="run-file-write-operation"]').text()).toContain("b.txt · 当时账本 CONFLICT");
  });

  it("处置遇到 409 后重新读取版本与证据，并撤去过期确认入口", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let conflicted = false; let runReads = 0; let taskReads = 0; let evidenceReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) { runReads++; return response(200, run(false)); }
      if (address === `${prefix}/tasks/${taskId}`) { taskReads++; return response(200, task(false)); }
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId, status: "UNKNOWN",
        action_type: "APPLY_CHANGESET", normalized_target: "C:\\relay\\root", invocations: [{ status: "UNKNOWN" }] }]);
      if (address === `${prefix}/operations/${operationId}/change-sets`) { evidenceReads++; return response(200, ledger()); }
      if (address === dispositionUrl && init?.method !== "POST") { evidenceReads++;
        return response(200, conflicted ? preview(false) : preview(true)); }
      if (address === dispositionUrl && init?.method === "POST") { conflicted = true;
        return response(409, { code: "REVISION_CONFLICT", detail: "观察或版本已变化", retryable: false }); }
      throw new Error(`unexpected request: ${address}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30); await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30); await mounted.wrapper.get('[data-testid="file-write-dispose-open"]').trigger("click");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="file-write-dispose-confirm"]')?.click(); });
    await flush(50);
    expect(runReads).toBeGreaterThan(1); expect(taskReads).toBeGreaterThan(1); expect(evidenceReads).toBeGreaterThan(2);
    const panel = mounted.wrapper.get('[data-testid="run-file-write-operation"]');
    expect(panel.text()).toContain("缺少可信旧 Worker 停机证明");
    expect(panel.find('[data-testid="file-write-dispose-open"]').exists()).toBe(false);
  });

  it("响应丢失后重开页面保留冻结命令；回执明确未找到才以同 ID 原载荷重试", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const posts: string[] = []; let disposed = false; let receiptReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const address = String(url);
      if (address === runUrl) return response(200, run(disposed));
      if (address === `${prefix}/tasks/${taskId}`) return response(200, task(disposed));
      if (address === `${runUrl}/reviews`) return response(200, { items: [] });
      if (address === `${runUrl}/context-manifests`) return response(200, { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (address === `${runUrl}/operations`) return response(200, [{ id: operationId,
        status: disposed ? "MANUALLY_CLOSED" : "UNKNOWN", action_type: "APPLY_CHANGESET",
        normalized_target: "C:\\relay\\root", invocations: [{ status: "UNKNOWN" }] }]);
      if (address === `${prefix}/operations/${operationId}/change-sets`) return response(200, ledger());
      if (address === dispositionUrl && init?.method !== "POST") return response(200, preview(true, disposed));
      if (address === dispositionUrl && init?.method === "POST") {
        posts.push(String(init.body));
        if (posts.length === 1) throw new TypeError("connection lost");
        disposed = true;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response(200, { command_id: body.command_id, committed_at: "2026-09-27T00:02:00.000Z",
          result: { operation_id: operationId, invocation_id: invocationId, run_id: runId,
            run_status: "FAILED", decision: "KEEP_CURRENT_AND_FAIL_RUN" } });
      }
      if (address.startsWith(`${prefix}/commands/`)) { receiptReads++;
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found", retryable: false }); }
      throw new Error(`unexpected request: ${address}`);
    }));
    let mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30); await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30); await mounted.wrapper.get('[data-testid="file-write-dispose-open"]').trigger("click");
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="file-write-dispose-confirm"]')?.click(); });
    await flush(30);
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]) as Record<string, unknown>;
    const key = `relay:file-write-disposition:${baseUrl}:${workspaceId}:${operationId}`;
    expect(JSON.parse(sessionStorage.getItem(key) ?? "null")).toMatchObject({
      commandId: body.command_id, invocationId, expectedRunRevision: "3",
      expectedTaskRevision: "4", expectedObservationSha256: "b".repeat(64) });
    mounted.unmount(); unmount = null;
    mounted = await mountWorkbench(`/runs/${runId}`); unmount = mounted.unmount;
    await flush(30); await mounted.wrapper.get('[data-testid="run-gateway-operations"] button').trigger("click");
    await flush(30);
    const panel = mounted.wrapper.get('[data-testid="run-file-write-operation"]');
    expect(panel.text()).toContain(`原 command_id：${body.command_id}`);
    expect(panel.find('[data-testid="file-write-dispose-retry"]').exists()).toBe(false);
    await panel.findAll("button").find((button) => button.text() === "查询原命令回执")!.trigger("click");
    await flush(20);
    expect(receiptReads).toBe(1);
    expect(panel.get('[data-testid="file-write-dispose-retry"]').text()).toContain("用原 ID 和载荷重试");
    await panel.get('[data-testid="file-write-dispose-retry"]').trigger("click");
    await flush(40);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(posts[0]);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(panel.text()).toContain("保留当时文件并结束旧 Run");
  });
});
