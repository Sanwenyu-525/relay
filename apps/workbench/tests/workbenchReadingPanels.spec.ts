import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { WorkbenchDocumentReader, WorkbenchRunEvidence, WorkbenchTaskFacts,
  type WorkbenchReadingTarget } from "../src/components/WorkbenchReadingPanels";
import { activateRelayConnection, liveClient, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const projectId = "project-a";
const apiRoot = "http://127.0.0.1:8787/api/v1/workspaces/workspace-a";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function activate() { activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace-a", bearerToken: "test-only" }); return liveClient()!; }
function response(body: unknown, status = 200): Response { return { ok: status < 400, status, json: async () => body, text: async () => String(body) } as Response; }
function task() { return { id: "task-a", project_id: projectId, title: "核对研究目标", status: "IN_PROGRESS", mode: "AI_ASSIST", revision: "2",
  executor: { kind: "HUMAN", run_id: "run-a" }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  acceptance: { acceptance_revision: "1", objective: "确切 Task 目标正文", source: "HUMAN", criteria: [] }, dependencies: [] }; }
function artifact() { return { id: "artifact-a", task_id: "task-a", title: "研究正文", revision: "2", latest_version_id: "version-2", version_count: 2,
  versions: ["1", "2"].map((version) => ({ artifact_version_id: `version-${version}`, version_number: version, media_type: "text/markdown", sha256: `sha-${version}`, size: "20", source_kind: "HUMAN", created_at: "2026-09-30T00:00:00Z" })) }; }
function target(version: string): WorkbenchReadingTarget { return { kind: "artifact", id: `version-${version}`, artifactId: "artifact-a", taskId: "task-a", title: "研究正文", version, sha256: `sha-${version}` }; }

describe("工作台确切版本阅读与运行证据", () => {
  it("切换历史版本会清空正文并隔离迟到响应，不把旧请求写回新选择", async () => {
    const client = activate();
    let finishOld: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = String(input).slice(apiRoot.length);
      if (path === "/tasks/task-a") return response(task());
      if (path === "/artifacts/artifact-a") return response(artifact());
      if (path === "/artifact-versions/version-1/content") return new Promise<Response>((resolve) => { finishOld = resolve; });
      if (path === "/artifact-versions/version-2/content") return response("# 当前第二版\n第二版确切正文");
      throw new Error(`Unexpected read ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(WorkbenchDocumentReader, { client, projectId, target: target("1") }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.find('[data-testid="workbench-document-body"]').exists()).toBe(false);
    await mounted.rerender(createElement(MemoryRouter, null, createElement(WorkbenchDocumentReader, { client, projectId, target: target("2") })));
    await flush();
    expect(mounted.wrapper.get('[data-testid="workbench-document-body"]').text()).toContain("第二版确切正文");
    finishOld!(response("# 迟到旧稿\n第一版迟到正文")); await flush();
    expect(mounted.wrapper.text()).not.toContain("第一版迟到正文");
    expect(mounted.wrapper.get('[data-testid="workbench-document-body"]').text()).toContain("第二版确切正文");
  });

  it("显式版本缺失或正文403时清旧内容，不回退最新版本", async () => {
    const client = activate();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(apiRoot.length);
      if (path === "/tasks/task-a") return response(task());
      if (path === "/artifacts/artifact-a") return response(artifact());
      if (path === "/artifact-versions/version-2/content") return response("已经加载的第二版");
      if (path === "/artifact-versions/version-1/content") return response({ code: "EVIDENCE_UNAVAILABLE", detail: "所选版本权限已失效", retryable: false }, 403);
      throw new Error(`Unexpected read ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(WorkbenchDocumentReader, { client, projectId, target: target("2") }))); unmount = mounted.unmount;
    await flush(); expect(mounted.wrapper.text()).toContain("已经加载的第二版");
    await mounted.rerender(createElement(MemoryRouter, null, createElement(WorkbenchDocumentReader, { client, projectId, target: target("1") }))); await flush();
    expect(mounted.wrapper.text()).not.toContain("已经加载的第二版");
    expect(mounted.wrapper.text()).toContain("正文暂时不可读");
    await mounted.rerender(createElement(MemoryRouter, null, createElement(WorkbenchDocumentReader, { client, projectId, target: target("9") }))); await flush();
    expect(mounted.wrapper.text()).toContain("确切版本不一致");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("version-9/content"))).toBe(false);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("version-2/content"))).toHaveLength(1);
  });

  it("资料正文必须匹配所选版本与允许的项目范围，读取不会自动选入Assist", async () => {
    const client = activate();
    const readingTarget: WorkbenchReadingTarget = { kind: "knowledge", id: "knowledge-a", title: "资料A", version: "1", sha256: "known-sha", sourceProjectId: projectId };
    vi.stubGlobal("fetch", vi.fn(async () => response({ id: "knowledge-version-1", knowledge_id: "knowledge-a", version: "1", source_kind: "NOTE", media_type: "text/markdown",
      content_sha256: "known-sha", availability: "AVAILABLE", source_refs: {}, created_at: "2026-09-30T00:00:00Z", title: "其他项目正文",
      project_id: "other-project", current_version: "2", source_uri: null, content_status: "FULL", content: "禁止泄漏的其他项目正文" })));
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(WorkbenchDocumentReader, { client, projectId, target: readingTarget }))); unmount = mounted.unmount;
    await flush(); expect(mounted.wrapper.text()).toContain("所选项目、版本或摘要不一致");
    expect(mounted.wrapper.text()).not.toContain("禁止泄漏的其他项目正文");
    expect(mounted.wrapper.find('[data-testid="workbench-document-body"]').exists()).toBe(false);
  });

  it("通用工作台目标和步骤只来自确切Task与关联Run，不写业务事实", async () => {
    const client = activate();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = String(input).slice(apiRoot.length);
      if (path === "/tasks/task-a") return response(task());
      if (path === "/tasks/task-a/artifacts") return response({ items: [artifact()], current_accepted_version_ids: [] });
      if (path === "/runs/run-a") return response({ id: "run-a", task_id: "task-a", status: "RUNNING", revision: "3", wait_reason: null, current_step_id: "step-a",
        steps: [{ step_id: "step-a", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED", started_at: null, finished_at: null }],
        recent_attempts: [], blocking_review_ids: [], pending_control_request: null, unresolved_operation_ids: [] });
      throw new Error(`Unexpected read ${path}`);
    }));
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(WorkbenchTaskFacts, { client, projectId, taskId: "task-a" }))); unmount = mounted.unmount;
    await flush(); expect(mounted.wrapper.text()).toContain("确切 Task 目标正文");
    expect(mounted.wrapper.text()).toContain("构建上下文");
    expect(mounted.wrapper.get('strong[title="BUILD_CONTEXT"]').text()).toBe("构建上下文");
    expect(mounted.wrapper.text()).toContain("AI 辅助");
    expect(mounted.wrapper.get('a[href="/tasks/task-a?tab=artifacts"]').text()).toContain("查看版本历史");
  });

  it("Run证据身份不匹配时不泄漏检查结果", async () => {
    const client = activate();
    vi.stubGlobal("fetch", vi.fn(async () => response({ run_id: "run-a", task_id: "other-task", project_id: "other-project", status: "SUCCEEDED", steps: [], attempts: [],
      model_calls: [], manifests: [], verifications: [], reviews: [], operations: [], effects: [] })));
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(WorkbenchRunEvidence, { client, projectId, taskId: "task-a", runId: "run-a", selectedVersion: null }))); unmount = mounted.unmount;
    await flush(); expect(mounted.wrapper.text()).toContain("执行证据不属于当前项目与任务");
    expect(mounted.wrapper.text()).not.toContain("SUCCEEDED");
  });
});
