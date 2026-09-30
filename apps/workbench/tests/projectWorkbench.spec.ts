import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const completionId = "77777777-7777-4777-8777-777777777777";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function task(id: string, title: string, status: string, runId: string | null = null) {
  return { id, project_id: projectId, title, status, mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: runId }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] };
}

function artifact() {
  return { id: "artifact-a", task_id: "task-a", title: "研究草稿", revision: "1",
    latest_version_id: "version-a", version_count: 1,
    versions: [{ artifact_version_id: "version-a", version_number: "1", media_type: "text/markdown",
      sha256: "sha-artifact", size: "22", source_kind: "HUMAN", created_at: "2026-09-26T00:00:00.000Z" }] };
}

describe("项目内置工作台", () => {
  it("归档项目工作台深链可读事实，默认视图保存禁用", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (init?.method === "POST") throw new Error(`Unexpected write ${path}`);
      const body = path === `/projects/${projectId}` ? { id: projectId, title: "归档工作台",
        project_type: "GENERAL", revision: "2", state_revision: "1", archived_at: "2026-09-26T00:00:00Z" } :
        path === `/projects/${projectId}/state` ? { project_id: projectId, phase_key: "PLANNING",
          revision: "1", next_action_task_id: null, selected_artifact_version_refs: [],
          completed_highlight_refs: [{ completion_id: completionId, task_id: "33333333-3333-4333-8333-333333333333", acceptance_revision: "2" }] } :
          path === `/tasks?project_id=${projectId}` ? { items: [], next_cursor: null } :
            path === `/projects/${projectId}/view-configuration` ? { project_id: projectId,
              revision: "1", kind: "general", template_version: "1", template_sha256: "a".repeat(64),
              pages: ["state", "tasks", "artifacts", "reviews"].map((page_id, position) =>
                ({ page_id, visible: true, position })), updated_at: "2026-09-26T00:00:00Z" } : null;
      if (body === null) throw new Error(`Unexpected read ${path}`);
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/workbench/general`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("归档工作台");
    expect(mounted.wrapper.find(`a[href="/completion-records/${completionId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="view-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.get('[data-testid="view-save-default"]').attributes("disabled")).toBeDefined();
  });
  it("示例模式可从原项目页切换三种视图，项目类型和阶段不跟着切换", async () => {
    const mounted = await mountWorkbench("/projects/project-hci");
    unmount = mounted.unmount;
    await mounted.wrapper.get(".project-workbench-entry a").trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/projects/project-hci/workbench/general");
    expect(mounted.wrapper.text()).toContain("示例数据预览");
    expect(mounted.wrapper.text()).toContain("项目类型：论文 · 当前阶段：文献研究");
    expect(mounted.wrapper.text()).toContain("确定实验评价指标");
    expect((mounted.wrapper.get('[data-testid="workbench-view-configuration"]').element as HTMLDetailsElement).open).toBe(false);
    await mounted.wrapper.findAll('nav[aria-label="工作台视图"] a').find((link) => link.text() === "开发")!.trigger("click");
    await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/projects/project-hci/workbench/development");
    expect(mounted.wrapper.text()).toContain("项目类型：论文 · 当前阶段：文献研究");
    expect(mounted.wrapper.text()).toContain("示例模式不创建真实 Run 或审批");
    expect((mounted.wrapper.get('[data-testid="workbench-view-configuration"]').element as HTMLDetailsElement).open).toBe(false);
    await mounted.wrapper.findAll('nav[aria-label="工作台视图"] a').find((link) => link.text() === "论文")!.trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("文献综述");
    expect((mounted.wrapper.get('[data-testid="workbench-view-configuration"]').element as HTMLDetailsElement).open).toBe(false);
    expect(mounted.wrapper.findAll('a[href="/projects/project-hci"]').some((link) => link.text() === "返回原项目页")).toBe(true);
  });

  it("真实模式按 State/Task/Artifact/Knowledge/Run/Connection 只读投影并用游标继续加载", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.slice(root.length);
      let body: unknown;
      if (path === `/projects/${projectId}`) body = { id: projectId, title: "真实论文项目", project_type: "THESIS", revision: "3", state_revision: "7", archived_at: null };
      else if (path === `/projects/${projectId}/state`) body = { project_id: projectId, phase_key: "WRITING", revision: "7",
        next_action_task_id: "task-next", selected_artifact_version_refs: [{ artifact_version_id: "version-a", artifact_id: "artifact-a", version_number: "1", source_ref: "task:task-a" }], completed_highlight_refs: [] };
      else if (path === "/tasks?project_id=" + projectId) body = { items: [task("task-a", "撰写草稿", "IN_PROGRESS", "run-a")], next_cursor: "cursor-two" };
      else if (path === "/tasks?project_id=" + projectId + "&cursor=cursor-two") body = { items: [task("task-b", "整理引用", "READY")], next_cursor: null };
      else if (path === "/tasks/task-next") body = { ...task("task-next", "核对论文下一步", "READY"),
        acceptance: { acceptance_revision: "1", objective: "核对", source: "HUMAN", criteria: [] }, dependencies: [] };
      else if (path === "/artifacts/artifact-a") body = artifact();
      else if (path === `/knowledge?project_id=${projectId}`) body = [{ id: "knowledge-a", project_id: projectId,
        title: "研究资料", status: "ACTIVE", revision: "1", current_version: "1",
        created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z" }];
      else if (path === "/knowledge/knowledge-a/versions") body = [{ id: "knowledge-version-a", knowledge_id: "knowledge-a", version: "1",
        source_kind: "NOTE", media_type: "text/plain", content_sha256: "sha-knowledge", availability: "AVAILABLE",
        excerpt: "来源摘录", source_refs: { citation: "paper:7" }, created_at: "2026-09-26T00:00:00.000Z" }];
      else if (path === "/tasks/task-a/artifacts") body = { items: [artifact()], current_accepted_version_ids: [] };
      else if (path === "/tasks/task-next/artifacts") body = { items: [], current_accepted_version_ids: [] };
      else if (path === `/projects/${projectId}/connections`) body = [{ id: "connection-a", status: "ACTIVE", capabilities: ["WEB_FETCH"], allowed_host: "example.org" }];
      else if (path === "/reviews?status=OPEN") body = { items: [
        { id: "review-a", kind: "ACTION_APPROVAL", status: "OPEN", revision: "1", project_id: projectId,
          task_id: "task-a", run_id: "run-a", reason: "需要判断", target_hash: "hash", target: {}, evidence: {}, effect: {},
          allowed_decisions: ["APPROVE", "DENY"], expires_at: null, created_at: "2026-09-26T00:00:00.000Z", decided_at: null },
        { id: "review-other", kind: "CRITERION", status: "OPEN", revision: "1", project_id: "other",
          task_id: "other-task", run_id: null, reason: "其他项目", target_hash: "hash", target: {}, evidence: {}, effect: {},
          allowed_decisions: ["ACCEPT"], expires_at: null, created_at: "2026-09-26T00:00:00.000Z", decided_at: null }
      ] };
      else if (path === "/runs/run-a") body = { id: "run-a", task_id: "task-a", status: "WAITING_APPROVAL", revision: "4",
        wait_reason: "ACTION_APPROVAL", current_step_id: null, steps: [], recent_attempts: [], blocking_review_ids: ["review-a"],
        pending_control_request: null, unresolved_operation_ids: [] };
      else throw new Error(`Unexpected GET ${url}`);
      expect(init?.method ?? "GET").toBe("GET");
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}/workbench/general`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("核对论文下一步");
    expect(mounted.wrapper.text()).toContain("研究草稿");
    expect(mounted.wrapper.text()).toContain("当前已读取 1 条；还有后续页");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "继续加载任务")!.trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("整理引用");
    expect(mounted.wrapper.text()).toContain("当前已读取 2 条；服务端未返回下一页游标");

    await mounted.router.push(`/projects/${projectId}/workbench/thesis`);
    await flush();
    expect(mounted.wrapper.text()).toContain("研究资料");
    expect(mounted.wrapper.text()).toContain("paper:7");
    expect(mounted.wrapper.text()).toContain("研究草稿");

    await mounted.router.push(`/projects/${projectId}/workbench/development`);
    await flush();
    expect(mounted.wrapper.text()).toContain("WEB_FETCH");
    expect(mounted.wrapper.text()).toContain("WAITING_APPROVAL");
    expect(mounted.wrapper.text()).toContain("review-a");
    expect(mounted.wrapper.text()).not.toContain("review-other");
    expect(mounted.wrapper.text()).toContain("真实 Git diff、受控测试和 Coding CLI 尚未接入");
    expect(mounted.wrapper.text()).toContain("项目类型：论文 · 当前阶段：写作");
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
});
