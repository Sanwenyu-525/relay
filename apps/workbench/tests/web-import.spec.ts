import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const operationId = "66666666-6666-4666-8666-666666666666";
const reviewId = "77777777-7777-4777-8777-777777777777";
const knowledgeId = "88888888-8888-4888-8888-888888888888";
const versionId = "99999999-9999-4999-8999-999999999999";
const url = "https://public.example/article";
const base = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function job(status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED", commandId: string) {
  return { id: jobId, project_id: projectId, actor_ref: "local-user", config_version: "web-import-v1",
    source_uri: url, status, revision: status === "QUEUED" ? "0" : "1", error: status === "FAILED" ? "WEB_TEXT_UNAVAILABLE" : null,
    knowledge_version_id: status === "SUCCEEDED" ? versionId : null, request_command_id: commandId,
    created_at: "2026-09-26T00:00:00.000Z" };
}

function operation(status: string) {
  return { id: operationId, origin: "USER_IMPORT", project_id: projectId, run_id: null, step_id: null,
    import_job_id: jobId, status, action_type: "WEB_FETCH", normalized_target: url,
    params_hash: "abc", connection_id: connectionId, connection_version: "1", policy_id: "policy-1",
    policy_version: "1", created_at: "2026-09-26T00:00:00.000Z", result_ref: null, invocations: [] };
}

function review() {
  return { id: reviewId, kind: "ACTION_APPROVAL", status: "OPEN", revision: "0", project_id: projectId,
    task_id: null, run_id: null, reason: "需要批准", target_hash: "hash",
    target: { operation_id: operationId, import_job_id: jobId }, evidence: {}, effect: {},
    allowed_decisions: ["APPROVE", "DENY"], expires_at: null,
    created_at: "2026-09-26T00:00:00.000Z", decided_at: null };
}

function knowledge() {
  return { id: knowledgeId, project_id: projectId, title: url, status: "ACTIVE", revision: "0",
    current_version: "1", created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z" };
}

function version() {
  return { id: versionId, knowledge_id: knowledgeId, version: "1", source_kind: "WEB_PAGE", media_type: "text/plain",
    content_sha256: "sha256", availability: "AVAILABLE", excerpt: "网页提取的正文", source_refs: { import_job_id: jobId },
    created_at: "2026-09-26T00:00:00.000Z" };
}

function project(id = projectId, archivedAt: string | null = null) {
  return { id, title: "项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: archivedAt };
}

function activate() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("P17 project Knowledge web import", () => {
  it("fixture 项目页不显示导入入口或虚构网页结果", async () => {
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.find('[data-testid="web-import-panel"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="knowledge-fixture-gap"]').exists()).toBe(true);
  });

  it("只列本项目可用 WEB_FETCH 连接，201 后查询真实状态、原 Review 和精确 Knowledge 版本", async () => {
    activate();
    let currentStatus: "QUEUED" | "RUNNING" | "SUCCEEDED" = "QUEUED";
    let commandId = "";
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path === `${base}/projects/${projectId}`) return response(200, project());
      if (path === `${base}/knowledge?project_id=${projectId}`) return response(200, currentStatus === "SUCCEEDED" ? [knowledge()] : []);
      if (path === `${base}/projects/${projectId}/connections`) return response(200, [
        { id: "wrong", status: "ACTIVE", capabilities: ["FILE_READ"], allowed_host: null },
        { id: "disabled", status: "DISABLED", capabilities: ["WEB_FETCH"], allowed_host: "disabled.example" },
        { id: connectionId, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: "public.example" }
      ]);
      if (path === `${base}/projects/${projectId}/import-jobs` && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as Record<string, unknown>;
        commandId = String(posted.command_id);
        return response(201, { command_id: commandId, committed_at: "2026-09-26T00:00:00.000Z",
          result: { import_job_id: jobId, project_id: projectId, connection_id: connectionId, status: "QUEUED" } });
      }
      if (path === `${base}/import-jobs/${jobId}`) return response(200, job(currentStatus, commandId));
      if (path === `${base}/import-jobs/${jobId}/operations`) return response(200,
        currentStatus === "QUEUED" ? [] : [operation(currentStatus === "RUNNING" ? "WAITING_APPROVAL" : "SUCCEEDED")]);
      if (path === `${base}/reviews?status=OPEN`) return response(200, { items: [review()] });
      if (path === `${base}/knowledge/${knowledgeId}/versions`) return response(200, [version()]);
      if (path === `${base}/knowledge/${knowledgeId}`) return response(200, knowledge());
      throw new Error(`unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="web-import-panel"]').exists()).toBe(true);
    expect(mounted.wrapper.findAll('[data-testid="web-import-connection"] option')).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="web-import-connection"] option').text()).toContain(`public.example · ${connectionId}`);
    await mounted.wrapper.get('[data-testid="web-import-url"]').setValue(url);
    await mounted.wrapper.get('[data-testid="web-import-form"]').trigger("submit");
    await flush();
    expect(posted).toMatchObject({ url, connection_id: connectionId });
    expect(mounted.wrapper.get('[data-testid="web-import-status"]').text()).toContain("已排队，尚未抓取");
    expect(mounted.wrapper.text()).not.toContain("导入成功，Knowledge 版本已落库");
    currentStatus = "RUNNING";
    await mounted.wrapper.get('[data-testid="web-import-restore"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="web-import-status"]').text()).toContain("WAITING_APPROVAL");
    expect(mounted.wrapper.get('[data-testid="web-import-status"] a').attributes("href")).toBe(`/reviews?id=${reviewId}`);
    currentStatus = "SUCCEEDED";
    await mounted.wrapper.get('[data-testid="web-import-restore"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="web-import-status"]').text()).toContain(versionId);
    expect(mounted.wrapper.get('[data-testid="web-import-result"]').text()).toContain("网页提取的正文");
    await mounted.wrapper.get('[data-testid="web-import-result"] button').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("不可变资料版本");
    expect(mounted.wrapper.text()).toContain("WEB_PAGE");
  });

  it("提交响应丢失后保留原 command_id，并通过原回执恢复同一 Job", async () => {
    activate();
    let submittedId = "";
    let postCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path === `${base}/projects/${projectId}`) return response(200, project());
      if (path === `${base}/knowledge?project_id=${projectId}`) return response(200, []);
      if (path === `${base}/projects/${projectId}/connections`) return response(200, [{ id: connectionId, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: null }]);
      if (path === `${base}/projects/${projectId}/import-jobs` && init?.method === "POST") {
        postCount++;
        submittedId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("connection lost");
      }
      if (path === `${base}/commands/${submittedId}`) return response(200, {
        command_id: submittedId, command_type: "CreateWebImportJob", committed_at: "2026-09-26T00:00:00.000Z",
        result: { import_job_id: jobId, project_id: projectId, connection_id: connectionId, status: "QUEUED" }
      });
      if (path === `${base}/import-jobs/${jobId}`) return response(200, job("QUEUED", submittedId));
      if (path === `${base}/import-jobs/${jobId}/operations`) return response(200, []);
      throw new Error(`unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="web-import-connection"] option').text()).toBe(connectionId);
    await mounted.wrapper.get('[data-testid="web-import-url"]').setValue(url);
    await mounted.wrapper.get('[data-testid="web-import-form"]').trigger("submit");
    await flush();
    expect(mounted.wrapper.get('[data-testid="web-import-pending"]').text()).toContain(submittedId);
    await mounted.wrapper.get('[data-testid="web-import-check-receipt"]').trigger("click");
    await flush();
    expect(postCount).toBe(1);
    expect(mounted.wrapper.find('[data-testid="web-import-pending"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="web-import-status"]').text()).toContain(jobId);
  });

  it("提交前重读发现归档时零导入命令，历史 Job 仍可按 ID 查询", async () => {
    activate();
    let projectReads = 0;
    let posts = 0;
    let jobVisible = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path === `${base}/projects/${projectId}`) return response(200, project(projectId,
        ++projectReads === 1 ? null : "2026-09-26T00:00:00.000Z"));
      if (path === `${base}/knowledge?project_id=${projectId}`) return response(200, []);
      if (path === `${base}/projects/${projectId}/connections`) return response(200,
        [{ id: connectionId, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: null }]);
      if (path === `${base}/projects/${projectId}/import-jobs` && init?.method === "POST") { posts++; throw new Error("unexpected import"); }
      if (path === `${base}/import-jobs/${jobId}`) return jobVisible
        ? response(200, job("FAILED", "11111111-1111-4111-8111-111111111111"))
        : response(403, { code: "FORBIDDEN", detail: "access revoked" });
      if (path === `${base}/import-jobs/${jobId}/operations`) return response(200, []);
      throw new Error(`unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="web-import-url"]').setValue(url);
    await mounted.wrapper.get('[data-testid="web-import-form"]').trigger("submit");
    await flush();
    expect(posts).toBe(0);
    expect(mounted.wrapper.get('[data-testid="web-import-project-write-blocked"]').text()).toContain("项目已归档");
    await mounted.wrapper.get('[data-testid="web-import-job-id"]').setValue(jobId);
    await mounted.wrapper.get('[data-testid="web-import-restore"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="web-import-status"]').text()).toContain("导入失败");
    jobVisible = false;
    await mounted.wrapper.get('[data-testid="web-import-restore"]').trigger("click");
    await flush();
    expect(mounted.wrapper.find('[data-testid="web-import-status"]').exists()).toBe(false);
  });

  it("原回执尚未出现时仅用同一 command_id 重试，并显示最终失败原因", async () => {
    activate();
    const submittedIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path === `${base}/projects/${projectId}`) return response(200, project());
      if (path === `${base}/knowledge?project_id=${projectId}`) return response(200, []);
      if (path === `${base}/projects/${projectId}/connections`) return response(200, [{ id: connectionId, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: "public.example" }]);
      if (path === `${base}/projects/${projectId}/import-jobs` && init?.method === "POST") {
        const commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        submittedIds.push(commandId);
        if (submittedIds.length === 1) throw new TypeError("connection lost");
        return response(201, { command_id: commandId, committed_at: "2026-09-26T00:00:00.000Z",
          result: { import_job_id: jobId, project_id: projectId, connection_id: connectionId, status: "QUEUED" } });
      }
      if (path.startsWith(`${base}/commands/`)) return response(404, { code: "COMMAND_NOT_FOUND", detail: "尚未提交", retryable: true });
      if (path === `${base}/import-jobs/${jobId}`) return response(200, job("FAILED", submittedIds[0]!));
      if (path === `${base}/import-jobs/${jobId}/operations`) return response(200, [operation("FAILED")]);
      throw new Error(`unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="web-import-url"]').setValue(url);
    await mounted.wrapper.get('[data-testid="web-import-form"]').trigger("submit");
    await flush();
    expect(mounted.wrapper.get('[data-testid="web-import-retry"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="web-import-check-receipt"]').trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="web-import-pending"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="web-import-retry"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="web-import-retry"]').trigger("click");
    await flush();
    expect(submittedIds).toHaveLength(2);
    expect(submittedIds[1]).toBe(submittedIds[0]);
    expect(mounted.wrapper.get('[data-testid="web-import-status"]').text()).toContain("WEB_TEXT_UNAVAILABLE");
  });

  it("项目切换后迟到的旧 Job 响应不能显示在新项目", async () => {
    activate();
    let commandId = "";
    let resolveOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path === `${base}/projects/${projectId}`) return response(200, project());
      if (path === `${base}/projects/${otherProjectId}`) return response(200, project(otherProjectId));
      if (path === `${base}/knowledge?project_id=${projectId}` || path === `${base}/knowledge?project_id=${otherProjectId}`) return response(200, []);
      if (path === `${base}/projects/${projectId}/connections`) return response(200, [{ id: connectionId, status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: "public.example" }]);
      if (path === `${base}/projects/${otherProjectId}/connections`) return response(200, []);
      if (path === `${base}/projects/${projectId}/import-jobs` && init?.method === "POST") {
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        return response(201, { command_id: commandId, committed_at: "2026-09-26T00:00:00.000Z",
          result: { import_job_id: jobId, project_id: projectId, connection_id: connectionId, status: "QUEUED" } });
      }
      if (path === `${base}/import-jobs/${jobId}`) return new Promise<Response>((resolve) => { resolveOld = resolve; });
      throw new Error(`unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="web-import-url"]').setValue(url);
    await mounted.wrapper.get('[data-testid="web-import-form"]').trigger("submit");
    await flush();
    expect(resolveOld).not.toBeNull();
    await mounted.router.push(`/projects/${otherProjectId}/knowledge`);
    await flush();
    resolveOld!(response(200, job("SUCCEEDED", commandId)));
    await flush();
    expect(mounted.wrapper.text()).not.toContain(jobId);
    expect(mounted.wrapper.text()).toContain("没有可用的 ACTIVE WEB_FETCH 连接");
  });
});
