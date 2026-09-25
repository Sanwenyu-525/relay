import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest, useFixtureData } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const secondWorkspaceId = "55555555-5555-4555-8555-555555555555";
const taskId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const secondRunId = "66666666-6666-4666-8666-666666666666";
const secondTaskId = "77777777-7777-4777-8777-777777777777";
const manifestId = "44444444-4444-4444-8444-444444444444";
const prefix = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const secondPrefix = `${baseUrl}/api/v1/workspaces/${secondWorkspaceId}`;
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function task() {
  return {
    id: taskId, project_id: null, title: "真实 AI 任务", status: "IN_PROGRESS", mode: "DELEGATE_AI",
    revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "1", objective: "交付可核对结果", source: "CREATE", criteria: [] }, dependencies: []
  };
}

function run() {
  return {
    id: runId, task_id: taskId, status: "RUNNING", revision: "3", ownership_epoch: "1", retry_of_run_id: null,
    current_step_id: "step-1", wait_reason: null, created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:01:00.000Z", terminal_at: null,
    contract: { workflow_key: "markdown-deliverable-v1", workflow_version: "1", execution_config_version: "1", acceptance_revision: "1", contract_hash: "a".repeat(64) },
    current_step: null,
    steps: [{ step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED", started_at: null, finished_at: null }],
    recent_attempts: [], result_refs: [], blocking_review_ids: [], pending_control_request: null, unresolved_operation_ids: []
  };
}

function summary() {
  return { id: manifestId, run_id: runId, step_id: "step-1", created_at: "2026-09-23T00:01:00.000Z",
    builder_version: "context-builder-v1", template_version: "markdown-draft-v1", manifest_hash: "b".repeat(64) };
}

function detail(visible: boolean) {
  return { ...summary(), budget: { limit_tokens: 8192, reserved_tokens: 1536,
    required_tokens: visible ? 700 : null, selected_tokens: visible ? 900 : null,
    estimation: "ESTIMATED_UTF8_BYTES_DIV_3" },
  dependencies: { contract_hash: "a".repeat(64), workflow_version: "1", execution_config_version: "1",
    profile: { id: "run-default", version: "1", digest: "c".repeat(64) }, skill: null },
  sources: visible ? [{ kind: "KNOWLEDGE", source_ref: "knowledge:allowed:v2", version: "2",
    sha256: "d".repeat(64), source_sha256: "e".repeat(64),
    range: { start: 0, end: 18, unit: "UTF8_BYTE" }, content: "敏感旧片段 <script>x</script>",
    role: "RELEVANT", trust: "UNTRUSTED_DATA", selection_reason: "RECENT_SCOPE_FALLBACK" }] : [],
  exclusions: visible ? [{ source_ref: "knowledge:other:v1", reason: "BUDGET_TRIMMED" }] : [] };
}

function list(status: "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED", reasonCode: string | null = null) {
  return { items: status === "SUCCEEDED" ? [summary()] : [],
    build: { status, reason_code: reasonCode,
      message: reasonCode === "CONTEXT_REQUIRED_OVER_BUDGET" ? "必需上下文超过预算。" :
        reasonCode === "CONTEXT_REQUIRED_SOURCE_UNAVAILABLE" ? "必需来源不可用。" : null } };
}

function activate(id = workspaceId): void {
  activateRelayConnection({ baseUrl, workspaceId: id, bearerToken: "test-token" });
}

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("P11 Run Sources View", () => {
  it("示例模式没有真实 Run，也不生成来源", async () => {
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="run-fixture-gap"]').text()).toContain("示例模式没有真实 Run");
    expect(mounted.wrapper.find('[data-testid="run-sources"]').exists()).toBe(false);
  });

  it("按真实构建状态区分尚未构建与必需来源失败", async () => {
    activate();
    let state = list("NOT_STARTED");
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/runs/${runId}`) return response(200, run());
      if (url === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (url === `${prefix}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${runId}/context-manifests`) return response(200, state);
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(40);
    expect(mounted.wrapper.get('[data-testid="run-sources-not-started"]').text()).toContain("尚未开始");
    state = list("FAILED", "CONTEXT_REQUIRED_SOURCE_UNAVAILABLE");
    await mounted.wrapper.get('[data-testid="run-sources-refresh"]').trigger("click");
    await flush(40);
    expect(mounted.wrapper.get('[data-testid="run-sources-build-failed"]').text()).toContain("必需来源不可用");
    state = list("FAILED", "CONTEXT_REQUIRED_OVER_BUDGET");
    await mounted.wrapper.get('[data-testid="run-sources-refresh"]').trigger("click");
    await flush(40);
    expect(mounted.wrapper.get('[data-testid="run-sources-build-failed"]').text()).toContain("超过预算");
    expect(mounted.wrapper.text()).not.toContain("敏感旧片段");
  });

  it("只展示获准的实际片段、版本摘要和合法裁剪，正文按纯文本渲染", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/runs/${runId}`) return response(200, run());
      if (url === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (url === `${prefix}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${runId}/context-manifests`) return response(200, list("SUCCEEDED"));
      if (url === `${prefix}/runs/${runId}/context-manifests/${manifestId}`) return response(200, detail(true));
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(50);
    const panel = mounted.wrapper.get('[data-testid="run-sources"]');
    expect(panel.text()).toContain("knowledge:allowed:v2");
    expect(panel.text()).toContain("UTF-8 字节范围 0–18");
    expect(panel.text()).toContain("来源版本摘要");
    expect(panel.text()).toContain("同范围最近资料补位");
    expect(panel.text()).toContain("可选片段因预算裁剪");
    expect(panel.find("script").exists()).toBe(false);
  });

  it("权限收紧后重读立即清除旧正文，隐藏来源数量相关预算", async () => {
    activate();
    let detailCount = 0;
    let release: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/runs/${runId}`) return response(200, run());
      if (url === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (url === `${prefix}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${runId}/context-manifests`) return response(200, list("SUCCEEDED"));
      if (url === `${prefix}/runs/${runId}/context-manifests/${manifestId}`) {
        detailCount += 1;
        if (detailCount === 1) return response(200, detail(true));
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(50);
    expect(mounted.wrapper.text()).toContain("敏感旧片段");
    await mounted.wrapper.get('[data-testid="run-sources-refresh"]').trigger("click");
    expect(mounted.wrapper.text()).not.toContain("敏感旧片段");
    await flush(30);
    expect(release).not.toBeNull();
    release!(response(200, detail(false)));
    await flush(30);
    const panel = mounted.wrapper.get('[data-testid="run-sources"]');
    expect(panel.text()).toContain("当前没有可展示的片段");
    expect(panel.text()).toContain("部分用量按当前权限隐藏");
    expect(panel.text()).not.toContain("knowledge:allowed:v2");
    expect(panel.text()).not.toContain("knowledge:other:v1");
    expect(panel.text()).not.toContain("实际选入 900");
  });

  it("连接切换后迟到的旧 Manifest 详情不能注入新 Workspace", async () => {
    activate();
    let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      const current = url.startsWith(secondPrefix) ? secondPrefix : prefix;
      if (url === `${current}/runs/${runId}`) return response(200, run());
      if (url === `${current}/tasks/${taskId}`) return response(200, task());
      if (url === `${current}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${runId}/context-manifests`) return response(200, list("SUCCEEDED"));
      if (url === `${prefix}/runs/${runId}/context-manifests/${manifestId}`) {
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (url === `${secondPrefix}/runs/${runId}/context-manifests`) return response(200, list("NOT_STARTED"));
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(40);
    expect(releaseOld).not.toBeNull();
    activate(secondWorkspaceId);
    await flush(40);
    releaseOld!(response(200, detail(true)));
    await flush(30);
    expect(mounted.wrapper.get('[data-testid="run-sources-not-started"]').text()).toContain("尚未开始");
    expect(mounted.wrapper.text()).not.toContain("敏感旧片段");
  });

  it("切换 Run 时立即清除上一 Run 的来源正文", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/runs/${runId}`) return response(200, run());
      if (url === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (url === `${prefix}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${runId}/context-manifests`) return response(200, list("SUCCEEDED"));
      if (url === `${prefix}/runs/${runId}/context-manifests/${manifestId}`) return response(200, detail(true));
      if (url === `${prefix}/runs/${secondRunId}`) return response(200, { ...run(), id: secondRunId, task_id: secondTaskId });
      if (url === `${prefix}/tasks/${secondTaskId}`) return response(200, {
        ...task(), id: secondTaskId, title: "另一项任务", executor: { kind: "AI", run_id: secondRunId, ownership_epoch: "1" }
      });
      if (url === `${prefix}/runs/${secondRunId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${secondRunId}/context-manifests`) return response(200, {
        items: [], build: { status: "NOT_STARTED", reason_code: null, message: null }
      });
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(50);
    expect(mounted.wrapper.text()).toContain("敏感旧片段");
    await mounted.router.push(`/runs/${secondRunId}`);
    expect(mounted.wrapper.text()).not.toContain("敏感旧片段");
    await flush(50);
    expect(mounted.wrapper.get('[data-testid="run-sources-not-started"]').text()).toContain("尚未开始");
  });

  it("断开 live 后清除来源正文并返回示例模式说明", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${prefix}/runs/${runId}`) return response(200, run());
      if (url === `${prefix}/tasks/${taskId}`) return response(200, task());
      if (url === `${prefix}/runs/${runId}/reviews`) return response(200, { items: [] });
      if (url === `${prefix}/runs/${runId}/context-manifests`) return response(200, list("SUCCEEDED"));
      if (url === `${prefix}/runs/${runId}/context-manifests/${manifestId}`) return response(200, detail(true));
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench(`/runs/${runId}`);
    unmount = mounted.unmount;
    await flush(50);
    expect(mounted.wrapper.text()).toContain("敏感旧片段");
    useFixtureData();
    await flush(20);
    expect(mounted.wrapper.get('[data-testid="run-fixture-gap"]').text()).toContain("示例模式没有真实 Run");
    expect(mounted.wrapper.text()).not.toContain("敏感旧片段");
  });
});
