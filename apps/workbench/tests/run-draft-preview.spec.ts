import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const otherRunId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const otherTaskId = "55555555-5555-4555-8555-555555555555";
const attemptA = "66666666-6666-4666-8666-666666666666";
const attemptB = "77777777-7777-4777-8777-777777777777";
const modelA = "88888888-8888-4888-8888-888888888888";
const modelB = "99999999-9999-4999-8999-999999999999";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function run(id = runId, linkedTaskId = taskId, status = "RUNNING", revision = "3") {
  return { id, task_id: linkedTaskId, status, revision, current_step_id: "draft-step", wait_reason: null,
    steps: [{ step_id: "draft-step", step_index: 1, step_kind: "DRAFT", status: status === "RUNNING" ? "RUNNING" : "SUCCEEDED",
      started_at: null, finished_at: null }], recent_attempts: [], blocking_review_ids: [],
    pending_control_request: null, unresolved_operation_ids: [] };
}
function task(id = taskId, linkedRunId = runId) {
  return { id, project_id: null, title: id === taskId ? "原任务" : "新任务", status: "IN_PROGRESS",
    mode: "DELEGATE_AI", revision: "4",
    executor: { kind: "AI", run_id: linkedRunId, ownership_epoch: "1" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "结果", source: "CREATE", criteria: [] }, dependencies: [] };
}
function preview(text: string | null, attemptId = attemptA, modelCallId: string | null = modelA,
  status = "RUNNING", revision = "1", id = runId) {
  return { run_id: id, run_status: status, step_attempt_id: status === "RUNNING" ? attemptId : null,
    attempt_claim_epoch: status === "RUNNING" ? "1" : null,
    model_call_id: status === "RUNNING" ? modelCallId : null,
    preview_revision: text === null ? "0" : revision, preview_text: text,
    preview_truncated: false, preview_available: status === "RUNNING" };
}
function activate() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }
function common(path: string, status = "RUNNING", revision = "3"): Response | null {
  if (path === `${prefix}/runs/${runId}`) return response(200, run(runId, taskId, status, revision));
  if (path === `${prefix}/tasks/${taskId}`) return response(200, task());
  if (path === `${prefix}/runs/${runId}/reviews`) return response(200, { items: [] });
  if (path === `${prefix}/runs/${runId}/context-manifests`) return response(200,
    { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
  return null;
}

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("M04 Run DRAFT 生成中草稿", () => {
  it("首片段持久化前不显示草稿，随后纯文本显示；终态清草稿并重读 Run", async () => {
    activate(); let finished = false; let calls = 0;
    let releaseFirst: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      const known = common(path, finished ? "COMPLETED" : "RUNNING");
      if (known) return known;
      if (path === `${prefix}/runs/${runId}/draft-preview`) {
        calls++;
        if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
        return response(200, finished ? preview(null, attemptA, null, "COMPLETED")
          : preview("<script>未发布 Markdown 草稿</script>"));
      }
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/runs/${runId}`); unmount = view.unmount;
    expect(releaseFirst).not.toBeNull();
    expect(view.wrapper.find('[data-testid="run-draft-preview"]').exists()).toBe(false);
    releaseFirst!(response(200, preview(null, attemptA, null))); await flush();
    expect(view.wrapper.find('[data-testid="run-draft-preview"]').exists()).toBe(false);
    await flush(450);
    const draft = view.wrapper.get('[data-testid="run-draft-preview"]');
    expect(draft.text()).toContain("尚非受管产物、验证 PASS 或任务完成");
    expect(draft.text()).toContain("<script>未发布 Markdown 草稿</script>");
    expect(draft.find("script").exists()).toBe(false);
    finished = true;
    await flush(450);
    expect(view.wrapper.find('[data-testid="run-draft-preview"]').exists()).toBe(false);
    expect(view.wrapper.text()).toContain("已完成");
  });

  it("旧 Attempt 迟到响应不能覆盖新轮次，身份变化先清旧片段", async () => {
    activate(); let revision = "3"; let calls = 0;
    let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      const known = common(path, "RUNNING", revision);
      if (known) return known;
      if (path === `${prefix}/runs/${runId}/draft-preview`) {
        calls++;
        if (calls === 1) return response(200, preview("原轮次草稿", attemptA, modelA));
        if (calls === 2) return new Promise<Response>((resolve) => { releaseOld = resolve; });
        return response(200, preview("新轮次草稿", attemptB, modelB));
      }
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/runs/${runId}`); unmount = view.unmount;
    expect(view.wrapper.text()).toContain("原轮次草稿");
    await flush(450);
    expect(releaseOld).not.toBeNull();
    revision = "4";
    await view.wrapper.get('[data-testid="run-refresh"]').trigger("click");
    await flush();
    expect(view.wrapper.text()).not.toContain("原轮次草稿");
    releaseOld!(response(200, preview("迟到的原草稿", attemptA, modelA)));
    await flush();
    expect(view.wrapper.text()).not.toContain("迟到的原草稿");
    await flush(450);
    expect(view.wrapper.text()).toContain("新轮次草稿");
  });

  it("同一 Run 的 Attempt 或 model_call 身份变化时先清旧片段，再展示新片段", async () => {
    activate(); let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      const known = common(path);
      if (known) return known;
      if (path === `${prefix}/runs/${runId}/draft-preview`) {
        calls++;
        return response(200, calls === 1 ? preview("上一轮片段", attemptA, modelA)
          : preview("新轮片段", attemptB, modelB));
      }
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/runs/${runId}`); unmount = view.unmount;
    expect(view.wrapper.text()).toContain("上一轮片段");
    await flush(450);
    expect(view.wrapper.find('[data-testid="run-draft-preview"]').exists()).toBe(false);
    await flush(450);
    expect(view.wrapper.text()).toContain("新轮片段");
    expect(view.wrapper.text()).not.toContain("上一轮片段");
  });

  it("预览失权和当前 Run 失权后清旧片段", async () => {
    activate(); let revoked = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      if (path === `${prefix}/runs/${runId}` && revoked) return response(403, { code: "FORBIDDEN", detail: "revoked" });
      const known = common(path);
      if (known) return known;
      if (path === `${prefix}/runs/${runId}/draft-preview`) return revoked
        ? response(404, { code: "RESOURCE_NOT_FOUND", detail: "revoked" })
        : response(200, preview("只在授权时可见的草稿"));
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/runs/${runId}`); unmount = view.unmount;
    expect(view.wrapper.text()).toContain("只在授权时可见的草稿");
    revoked = true;
    await flush(450);
    expect(view.wrapper.text()).not.toContain("只在授权时可见的草稿");
    expect(view.wrapper.find('[data-testid="run-draft-preview"]').exists()).toBe(false);
  });

  it("Run 路由切换后旧预览响应不能注入新任务", async () => {
    activate(); let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      const known = common(path);
      if (known) return known;
      if (path === `${prefix}/runs/${otherRunId}`) return response(200, run(otherRunId, otherTaskId));
      if (path === `${prefix}/tasks/${otherTaskId}`) return response(200, task(otherTaskId, otherRunId));
      if (path === `${prefix}/runs/${otherRunId}/reviews`) return response(200, { items: [] });
      if (path === `${prefix}/runs/${otherRunId}/context-manifests`) return response(200,
        { items: [], build: { status: "NOT_STARTED", reason_code: null, message: null } });
      if (path === `${prefix}/runs/${runId}/draft-preview`) return new Promise<Response>((resolve) => { releaseOld = resolve; });
      if (path === `${prefix}/runs/${otherRunId}/draft-preview`) return response(200,
        preview("新任务轮次", attemptB, modelB, "RUNNING", "1", otherRunId));
      throw new Error(`unexpected request ${path}`);
    }));
    const view = await mountWorkbench(`/runs/${runId}`); unmount = view.unmount;
    expect(releaseOld).not.toBeNull();
    await view.router.push(`/runs/${otherRunId}`);
    await flush();
    releaseOld!(response(200, preview("旧任务迟到草稿")));
    await flush();
    expect(view.wrapper.text()).toContain("新任务");
    expect(view.wrapper.text()).toContain("新任务轮次");
    expect(view.wrapper.text()).not.toContain("旧任务迟到草稿");
  });
});
