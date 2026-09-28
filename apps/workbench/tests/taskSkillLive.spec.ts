import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureAdapter } from "../src/fixtures/fixtureAdapter";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const otherTaskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function task(id = taskId, withRun = false) { return { id, project_id: null, title: id === taskId ? "真实任务定义" : "另一个真实任务",
  status: withRun ? "IN_PROGRESS" : "READY", mode: withRun ? "DELEGATE_AI" : "ME", revision: "4", executor: { kind: withRun ? "AI" : "HUMAN",
    run_id: withRun ? runId : null, ownership_epoch: "1" }, current_completion_id: null, waiting_reason: null,
  blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  acceptance: { acceptance_revision: "2", objective: "交付可核对结果", expected_outputs: { kind: "MARKDOWN_DOCUMENT" }, source: "CREATE",
    criteria: [{ criterion_id: "criterion-1", statement: "引用可核对", required: true, method: "HUMAN" }] }, dependencies: [] }; }
function trace() { return { run_id: runId, task_id: taskId, project_id: null, status: "COMPLETED",
  steps: [], attempts: [], model_calls: [], manifests: [], reviews: [], operations: [], effects: [],
  verifications: [{ id: "66666666-6666-4666-8666-666666666666", status: "FINALIZED", verdict: "PASS",
    acceptance_revision: "2", check_plan_hash: "a".repeat(64), parent_session_id: null,
    targets: [{ artifact_version_id: versionId, content_sha256: "b".repeat(64) }],
    checks: [{ id: "77777777-7777-4777-8777-777777777777", criterion_id: "criterion-1",
      result: "PASS", severity: "INFO", required: true, created_at: "2026-09-26T00:00:00Z" }],
    created_at: "2026-09-26T00:00:00Z", finalized_at: "2026-09-26T00:00:00Z" }] }; }
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

describe("P12 Task Skill live 当前事实", () => {
  it("定义页只展示 Task/acceptance 当前事实和 Assist 入口，不读取 fixture 或提交提案", async () => {
    connect(); const fixtureRead = vi.spyOn(fixtureAdapter, "loadTask"); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET"); const url = String(input);
      if (url.endsWith("/attention/interventions")) return response({ items: [] });
      calls.push(url);
      if (url === `${root}/tasks/${taskId}`) return response(task());
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}?skill=definition`); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="live-definition"]');
    expect(panel.text()).toContain("真实任务定义");
    expect(panel.text()).toContain("验收版本 v2 · 来源 CREATE");
    expect(panel.text()).toContain("引用可核对");
    expect(panel.text()).toContain("当前没有针对这项已有任务、可在此确认的任务定义 Skill 提案");
    expect(panel.text()).toContain("当前验收预期产物类型：MARKDOWN_DOCUMENT");
    expect(panel.text()).toContain("未提供输入资料绑定");
    expect(panel.find(`a[href="/tasks/${taskId}?skill=assist"]`).exists()).toBe(true);
    expect(panel.find('[data-testid="definition-accept"]').exists()).toBe(false);
    expect(fixtureRead).not.toHaveBeenCalled();
    expect(calls).toEqual([`${root}/tasks/${taskId}`]);
  });

  it("验收页只引用当前验收与确切 Run Trace 的历史验证，未提供应用按钮", async () => {
    connect(); const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === `${root}/tasks/${taskId}`) return response(task(taskId, true));
      if (url === `${root}/tasks/${taskId}/check-plan-preview`) return response({ task_id: taskId,
        status: "AVAILABLE", admission_available: false, reason_codes: ["TASK_NOT_HUMAN_OWNED"],
        sources: { task_revision: "4", acceptance_revision: "2", rule_revision: "3",
          workflow_key: "markdown-deliverable", workflow_version: "1", rule_refs: [] },
        check_plan: { policy_version: "verifier-policy-v1", workflow_key: "markdown-deliverable",
          workflow_version: "1", entries: [{ criterion_id: "criterion-1", statement: "引用可核对",
            required: true, method: "HUMAN", severity: "HARD", checker_id: "human-evidence-v1",
            checker_version: "1", target_spec: {} }] }, check_plan_sha256: "c".repeat(64),
        frozen_run_plan: false, executed: false });
      if (url === `${root}/runs/${runId}/trace`) return response(trace());
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}?skill=verification`); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="live-verification"]');
    expect(calls).toContain(`${root}/runs/${runId}/trace`);
    expect(panel.text()).toContain("此页不直接接受建议");
    expect(panel.text()).toContain("TASK_NOT_HUMAN_OWNED");
    expect(panel.text()).toContain("不是活动 Run 的冻结计划");
    expect(panel.text()).toContain("Verification Session 66666666-6666-4666-8666-666666666666");
    expect(panel.text()).toContain("CheckPlan hash");
    expect(panel.text()).toContain("criterion-1: PASS");
    expect(panel.text()).toContain("版本号或 PASS 不单独证明当前验收仍有效");
    expect(panel.find(`a[href="/runs/${runId}"]`).exists()).toBe(true);
    expect(panel.find(`a[href="/artifact-versions/${versionId}/lineage"]`).exists()).toBe(true);
    expect(panel.find('[data-testid="verification-apply"]').exists()).toBe(false);
  });

  it("Run 证据无权读取时保留任务事实；刷新任务失权时清除旧事实", async () => {
    connect(); let taskReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${root}/tasks/${taskId}`) return ++taskReads === 1 ? response(task(taskId, true))
        : response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
      if (url === `${root}/runs/${runId}/trace`) return response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
      if (url === `${root}/tasks/${taskId}/check-plan-preview`) return response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}?skill=verification`); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="live-verification"]');
    expect(panel.text()).toContain("交付可核对结果");
    expect(panel.text()).toContain("当前 Run 的验证来源不可读取");
    await panel.get("button").trigger("click"); await flush();
    expect(panel.text()).not.toContain("交付可核对结果");
    expect(panel.find('[data-testid="live-task-accepted-facts"]').exists()).toBe(false);
  });

  it("切换任务后迟到的旧任务响应不能覆盖当前目标", async () => {
    connect(); const old: { resolve?: (value: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${root}/tasks/${taskId}`) return new Promise<Response>((resolve) => { old.resolve = resolve; });
      if (url === `${root}/tasks/${otherTaskId}`) return response(task(otherTaskId));
      throw new Error(`Unexpected ${url}`);
    }));
    const mounted = await mountWorkbench(`/tasks/${taskId}?skill=definition`); unmount = mounted.unmount;
    await mounted.router.push(`/tasks/${otherTaskId}?skill=definition`); await flush();
    expect(mounted.wrapper.text()).toContain("另一个真实任务");
    old.resolve?.(response(task())); await flush();
    expect(mounted.wrapper.text()).toContain("另一个真实任务");
    expect(mounted.wrapper.text()).not.toContain("真实任务定义");
  });
});
