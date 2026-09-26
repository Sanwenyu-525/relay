import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const completionId = "77777777-7777-4777-8777-777777777777";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown): Response { return { ok: true, status: 200, json: async () => body } as Response; }
function task(id: string, project = projectId) { return { id, project_id: project, title: `任务 ${id}`, status: "READY", mode: "ME", revision: "2",
  executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
  blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [] }; }

describe("项目恢复页 live 当前事实", () => {
  it("只读 Project/State/Task/Review/Artifact/Decision，下一步不在首分页时按 ID 单读", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = String(input).slice(root.length); paths.push(path);
      if (path === `/projects/${projectId}`) return response({ id: projectId, title: "真实论文项目", project_type: "THESIS", revision: "3", state_revision: "7", archived_at: null });
      if (path === `/projects/${projectId}/state`) return response({ project_id: projectId, phase_key: "WRITING", revision: "7", next_action_task_id: "task-next",
        selected_artifact_version_refs: [{ artifact_version_id: "version-a", artifact_id: "artifact-a", version_number: "3", source_ref: "task:task-a" }],
        completed_highlight_refs: [{ completion_id: completionId, task_id: "task-a", acceptance_revision: "2" }] });
      if (path === `/tasks?project_id=${projectId}`) return response({ items: [task("task-a")], next_cursor: "next-page" });
      if (path === "/tasks/task-next") return response({ ...task("task-next"), acceptance: { acceptance_revision: "1", objective: "核对", source: "HUMAN", criteria: [] }, dependencies: [] });
      if (path === "/reviews?status=OPEN") return response({ items: [{ id: "review-a", kind: "ACTION_APPROVAL", status: "OPEN", revision: "1", project_id: projectId,
        task_id: "task-a", run_id: null, reason: "审批动作", target_hash: "hash", target: {}, evidence: {}, effect: {}, allowed_decisions: ["APPROVE"],
        expires_at: null, created_at: "2026-09-26T00:00:00Z", decided_at: null }, { id: "review-other", kind: "CRITERION", status: "OPEN", revision: "1",
        project_id: "other", task_id: "other", run_id: null, reason: "其他项目", target_hash: "hash", target: {}, evidence: {}, effect: {},
        allowed_decisions: ["ACCEPT"], expires_at: null, created_at: "2026-09-26T00:00:00Z", decided_at: null }] });
      if (path === `/decisions?project_id=${projectId}`) return response([{ id: "decision-a", project_id: projectId, title: "保留人工核对", status: "ACTIVE", revision: "2",
        current_version: "2", choice: "人工核对", rationale: "理由", alternatives: [], costs: [], superseded_by_id: null,
        created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z" }]);
      if (path === "/artifacts/artifact-a") return response({ id: "artifact-a", task_id: "task-a", title: "草稿", revision: "3", latest_version_id: "version-a",
        version_count: 1, versions: [{ artifact_version_id: "version-a", version_number: "3", media_type: "text/markdown", sha256: "sha", size: "12",
          source_kind: "HUMAN", created_at: "2026-09-26T00:00:00Z" }] });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=resume`); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="project-resume-live"]').text()).toContain("真实论文项目");
    expect(mounted.wrapper.text()).toContain("任务 task-next");
    expect(mounted.wrapper.text()).toContain("已读取本项目任务首分页 1 项；还有后续页");
    expect(mounted.wrapper.text()).toContain("审批动作");
    expect(mounted.wrapper.text()).not.toContain("其他项目");
    expect(mounted.wrapper.text()).toContain("草稿 · v3");
    expect(mounted.wrapper.text()).toContain("保留人工核对");
    expect(mounted.wrapper.find(`a[href="/completion-records/${completionId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.text()).toContain("没有上次查看基线");
    expect(mounted.wrapper.text()).not.toContain("建议的下一步");
    expect(paths).toContain("/tasks/task-next");
  });

  it("旧项目请求不会覆盖新项目事实", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const otherId = "33333333-3333-4333-8333-333333333333";
    const pending: { resolve?: (value: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === `/projects/${projectId}`) return new Promise<Response>((resolve) => { pending.resolve = resolve; });
      if (path === `/projects/${otherId}`) return response({ id: otherId, title: "新项目", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `/projects/${otherId}/state`) return response({ project_id: otherId, phase_key: "PLANNING", revision: "1", next_action_task_id: null,
        selected_artifact_version_refs: [], completed_highlight_refs: [] });
      if (path === `/tasks?project_id=${otherId}`) return response({ items: [], next_cursor: null });
      if (path === `/decisions?project_id=${otherId}`) return response([]);
      if (path === "/reviews?status=OPEN") return response({ items: [] });
      if (path === `/projects/${projectId}/state`) return response({ project_id: projectId, phase_key: "WRITING", revision: "7", next_action_task_id: null,
        selected_artifact_version_refs: [], completed_highlight_refs: [] });
      if (path === `/tasks?project_id=${projectId}`) return response({ items: [], next_cursor: null });
      if (path === `/decisions?project_id=${projectId}`) return response([]);
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=resume`); unmount = mounted.unmount;
    await mounted.router.push(`/projects/${otherId}?skill=resume`); await flush();
    pending.resolve?.(response({ id: projectId, title: "旧项目", project_type: "THESIS", revision: "7", state_revision: "7", archived_at: null })); await flush();
    expect(mounted.wrapper.text()).toContain("新项目");
    expect(mounted.wrapper.text()).not.toContain("旧项目");
  });
});
