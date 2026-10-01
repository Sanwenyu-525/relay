import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, dialogText, flush, mountWorkbench } from "./mountApp";
import { COLLABORATION_LAYOUT_STORAGE_KEY } from "../src/lib/collaborationLayoutPreferences";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const reviewId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
}

function project(archivedAt: string | null = null) {
  return { id: projectId, title: "人机协作工作流研究", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: archivedAt };
}

function task(over: Record<string, unknown> = {}) {
  return { id: taskId, project_id: projectId, title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME",
    revision: "2", created_at: "2026-09-28T02:00:00Z", updated_at: "2026-09-29T03:42:00Z",
    executor: { kind: "AI", run_id: runId, ownership_epoch: "1" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "2", objective: "补齐基线、评价方法与可复核的验收依据。", source: "CREATE",
      created_at: "2026-09-28T02:00:00Z", criteria: [
        { criterion_id: "c1", statement: "指标定义明确", required: true, method: "HUMAN_REVIEW", target_spec: {} },
        { criterion_id: "c2", statement: "来源可追溯", required: false, method: "HUMAN_REVIEW", target_spec: {} }
      ] },
    dependencies: [], ...over };
}

function run(status = "RUNNING", over: Record<string, unknown> = {}) {
  return { id: runId, task_id: taskId, status, revision: "4", wait_reason: null,
    current_step_id: "step-2", steps: [
      { step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED",
        started_at: "2026-09-29T03:00:00Z", finished_at: "2026-09-29T03:01:00Z" },
      { step_id: "step-2", step_index: 1, step_kind: "DRAFT", status: status === "RUNNING" ? "RUNNING" : "SUCCEEDED",
        started_at: "2026-09-29T03:10:00Z", finished_at: null }
    ], recent_attempts: [], blocking_review_ids: [reviewId], pending_control_request: null,
    unresolved_operation_ids: [], ...over };
}

function artifacts() {
  return { items: [{ id: "88888888-8888-4888-8888-888888888888", task_id: taskId, title: "评价方案.md",
    revision: "3", latest_version_id: versionId, version_count: 1,
    versions: [{ artifact_version_id: versionId, version_number: "2", media_type: "text/markdown",
      sha256: "a".repeat(64), size: "120", source_kind: "HUMAN", created_at: "2026-09-29T03:42:00Z" }] }],
    current_accepted_version_ids: [] };
}

function openReview() {
  return { id: reviewId, kind: "CRITERION", status: "OPEN", revision: "3", project_id: projectId,
    task_id: taskId, run_id: runId, reason: "AWAITING_HUMAN_EVIDENCE",
    target_hash: "b".repeat(64), target: { artifact_version_id: versionId, acceptance_revision: "2", criterion_id: "c1" },
    evidence: { check_result: "自动检查不能代替人工判断" }, effect: { on_accept: "重新核对完成条件" },
    allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
    created_at: "2026-09-29T03:41:00Z", decided_at: null };
}

interface Routes {
  task?: () => Response;
  project?: () => Response;
  run?: () => Response;
  reviews?: () => Response | Promise<Response>;
  artifacts?: () => Response;
  content?: (versionId: string) => Response | Promise<Response>;
  draft?: () => Response;
  operations?: () => Response;
  workspaceTasks?: () => Response;
  messages?: () => Response | Promise<Response>;
  sessions?: () => Response;
  proposals?: () => Response;
  modelPort?: () => Response;
  modelVerification?: () => Response;
}

function router(routes: Routes) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (body: unknown, status = 200) => response(body, status);
    if (path === `${prefix}/tasks` && !init?.method) return routes.workspaceTasks?.() ?? json({ items: [task()], next_cursor: null });
    if (path === `${prefix}/projects`) return json({ items: [{ ...project(), archive_status: "ACTIVE",
      phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-09-28T01:00:00Z",
      updated_at: "2026-09-29T03:42:00Z" }], next_cursor: null });
    if (path === `${prefix}/projects/${projectId}`) return routes.project?.() ?? json(project());
    if (path === `${prefix}/projects/${projectId}/state`) return json({ project_id: projectId, revision: "1",
      phase_key: "GENERAL", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/tasks/${taskId}`) return routes.task?.() ?? json(task());
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return routes.artifacts?.() ?? json(artifacts());
    if (path === `${prefix}/artifact-versions/${versionId}`) return json(artifacts().items[0]);
    if (path.includes("/artifact-versions/") && path.endsWith("/content")) return routes.content?.(path.split("/").at(-2)!) ?? json("# 评价方案\n\n正文。");
    if (path === `${prefix}/runs/${runId}`) return routes.run?.() ?? json(run());
    if (path.startsWith(`${prefix}/runs/${runId}/control-requests/`)) return json({ id: "req-1", run_id: runId,
      task_id: taskId, type: "PAUSE", status: "APPLIED", revision: "1", requested_at: "2026-09-29T04:00:00Z",
      decided_at: "2026-09-29T04:00:05Z", result_ref: null });
    if (path === `${prefix}/runs/${runId}/draft-preview`) return routes.draft?.() ?? json({ run_id: runId, run_status: "RUNNING",
      preview_available: false, preview_text: null, preview_revision: "0", preview_truncated: false,
      step_attempt_id: null, attempt_claim_epoch: null, model_call_id: null });
    if (path === `${prefix}/runs/${runId}/operations`) return routes.operations?.() ?? json([]);
    if (path === `${prefix}/reviews`) return routes.reviews?.() ?? json({ items: [openReview()] });
    if (path === `${prefix}/reviews/${reviewId}`) return json(openReview());
    if (path === `${prefix}/assist-sessions`) return routes.sessions?.() ?? json({ items: [{ id: sessionId, workspace_id: workspaceId,
      project_id: projectId, task_id: taskId, title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
      updated_at: "2026-09-29T03:40:00Z" }] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return routes.messages?.() ?? json({ items: [] });
    if (path === `${prefix}/assist-proposals`) return routes.proposals?.() ?? json({ items: [] });
    if (path === `${prefix}/skill-definitions`) return json({ items: [] });
    if (path === `${prefix}/projects/${projectId}/managed-resources`) return json([{ id: "res-1", project_id: projectId,
      canonical_root: "D:\\repo", status: "ACTIVE", revision: "1", resource_epoch: "0", file_write_identity_bound: true }]);
    if (path.startsWith(`${prefix}/projects/${projectId}/connections`)) return json([]);
    if (path === `${prefix}/model-port`) return json({ provider: "openai-compatible", configured: true,
      model: "gpt-4.1-mini", base_url: null });
    if (path === `${prefix}/model-port/verification`) return json({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/search`)) return json({ items: [], next_cursor: null });
    if (path === `${prefix}/model-port`) return routes.modelPort?.() ?? json({ provider: "fake",
      configured: false, model: null, base_url: null });
    if (path === `${prefix}/model-port/verification`) return routes.modelVerification?.() ?? json({
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
  });
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.removeItem(COLLABORATION_LAYOUT_STORAGE_KEY); });

describe("协作工作区主路径", () => {
  it("双栏、对话、成果切换保留原Owner、会话草稿和判断说明，零业务提交", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({}); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const assist = view.wrapper.get('[data-testid="assist-draft"]').element;
      const review = view.wrapper.get('[data-testid="review-decision"]').element;
      const control = view.wrapper.get('[data-testid="run-control"]').element;
      const side = view.wrapper.get('[data-testid="collab-side"]').element;
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("布局切换中保留讨论草稿");
      await view.wrapper.get(`#review-feedback-${reviewId}`).setValue("布局切换中保留判断说明");
      for (const mode of ["chat", "result", "split"]) {
        await view.wrapper.get(`[data-testid="collab-layout-${mode}"]`).trigger("click");
        expect(view.wrapper.get(".collab-columns").attributes("data-layout-mode")).toBe(mode);
        expect((view.wrapper.get('[data-testid="collab-center"]').element as HTMLElement).hidden).toBe(mode === "result");
        expect((view.wrapper.get(".collab-result-pane").element as HTMLElement).hidden).toBe(mode === "chat");
        expect(view.wrapper.get('[data-testid="assist-draft"]').element).toBe(assist);
        expect(view.wrapper.get('[data-testid="review-decision"]').element).toBe(review);
        expect(view.wrapper.get('[data-testid="run-control"]').element).toBe(control);
        expect(view.wrapper.get('[data-testid="collab-side"]').element).toBe(side);
        expect(view.wrapper.findAll('[data-testid="review-decision"]')).toHaveLength(1);
        expect((assist as HTMLTextAreaElement).value).toBe("布局切换中保留讨论草稿");
        expect((view.wrapper.get(`#review-feedback-${reviewId}`).element as HTMLTextAreaElement).value).toBe("布局切换中保留判断说明");
      }
      expect(view.router.currentRoute.value.query.work).toBe(taskId);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it.each(["assist", "review", "control"] as const)("模式切换保护%s响应丢失的原命令身份", async (owner) => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const read = router({}); let commandId = ""; let posts = 0; const receipts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") {
        posts++; commandId = String(JSON.parse(String(init.body)).command_id); throw new TypeError("response lost");
      }
      if (commandId && path === `${prefix}/commands/${commandId}`) {
        receipts.push(path); return response({ code: "COMMAND_NOT_FOUND", detail: "not yet" }, 404);
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const selector = owner === "assist" ? '[data-testid="assist-draft"]' : owner === "review" ? '[data-testid="review-decision"]' : '[data-testid="run-control"]';
      const original = view.wrapper.get(selector).element;
      if (owner === "assist") await view.wrapper.get('[data-testid="assist-draft"]').setValue("保留原讨论命令");
      if (owner === "review") await view.wrapper.get(`#review-feedback-${reviewId}`).setValue("保留原判断命令");
      const action = owner === "assist" ? "assist-send" : owner === "review" ? "review-decision-ACCEPT" : "run-control-PAUSE";
      await view.wrapper.get(`[data-testid="${action}"]`).trigger("click"); await flush();
      expect(commandId).not.toBe("");
      for (const mode of ["result", "chat", "split"]) {
        await view.wrapper.get(`[data-testid="collab-layout-${mode}"]`).trigger("click");
        expect(view.wrapper.get(selector).element).toBe(original);
      }
      const check = owner === "assist" ? view.wrapper.get(".assist-pending").findAll("button")[0]!
        : view.wrapper.get(`[data-testid="${owner === "review" ? "review-check-receipt" : "run-check-receipt"}"]`);
      await check.trigger("click"); await flush();
      expect(receipts).toEqual([`${prefix}/commands/${commandId}`]);
      expect(posts).toBe(1);
    } finally { view.unmount(); }
  });

  it.each(["run", "task"] as const)("%s等待原因与当前步骤常驻，不收进诊断详情", async (source) => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ run: () => response(run("WAITING_APPROVAL", { wait_reason: source === "run" ? "WAITING_FOR_REVIEW" : null })),
      task: () => response(task({ waiting_reason: source === "task" ? "WAITING_FOR_REVIEW" : null })) }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      expect(view.wrapper.get('[data-testid="collab-current-need"]').text()).toContain("等待原因：WAITING_FOR_REVIEW");
      expect(view.wrapper.get('[data-testid="collab-current-need"]').text()).toContain("当前步骤：生成草稿");
      expect(view.wrapper.get(".collab-facts-disclosure").attributes("open")).toBeUndefined();
    } finally { view.unmount(); }
  });

  it.each([true, false])("Review绑定旧版本（版本可读=%s）时阅读与判断保持确切身份，不回退latest", async (available) => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const boundVersionId = "99999999-9999-4999-8999-999999999999";
    const contentPaths: string[] = [];
    const data = artifacts();
    if (available) data.items[0]!.versions.push({ ...data.items[0]!.versions[0]!, artifact_version_id: boundVersionId, version_number: "1" });
    const fetchMock = router({ artifacts: () => response(data), reviews: () => response({ items: [{ ...openReview(),
      target: { artifact_version_id: boundVersionId, acceptance_revision: "2", criterion_id: "c1" } }] }),
      content: (id) => { contentPaths.push(id); return response(id === boundVersionId ? "# 旧版判断依据" : "# 最新版正文"); } });
    vi.stubGlobal("fetch", fetchMock); const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      if (available) {
        expect(view.wrapper.get('[data-testid="collab-reading"]').text()).toContain("旧版判断依据");
        expect(view.wrapper.get('[data-testid="collab-artifact-reader"]').text()).not.toContain("最新版正文");
        expect(contentPaths).toEqual([boundVersionId]);
      } else {
        expect(view.wrapper.get('[data-testid="collab-bound-version-unavailable"]').text()).toContain(boundVersionId);
        expect(contentPaths).toHaveLength(0);
      }
      expect(view.wrapper.get(".review-evidence-details").text()).toContain(boundVersionId);
    } finally { view.unmount(); }
  });

  it("同Task两个会话可返回原记录，草稿切换必须经原离开保护", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const secondSessionId = "99999999-9999-4999-8999-999999999999";
    const sessions = [sessionId, secondSessionId].map((id, index) => ({ id, workspace_id: workspaceId,
      project_id: projectId, task_id: taskId, title: index === 0 ? "指标原讨论" : "评价方法第二讨论",
      status: "ACTIVE", revision: "1", updated_at: "2026-10-01T02:00:00Z" }));
    const read = router({ sessions: () => response({ items: sessions }) });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      for (const id of [sessionId, secondSessionId]) {
        if (path === `${prefix}/assist-sessions/${id}/messages`) return response({ items: [{
          id: `message-${id}`, session_id: id, seq: "1", role: "USER", status: "COMPLETED", intent: "DISCUSS",
          content: id === sessionId ? "原讨论的指标来源" : "第二讨论的方法对照", error_code: null,
          sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false }] });
      }
      return read(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      expect(view.wrapper.get('[data-testid="assist-session-select"]').findAll("option")).toHaveLength(3);
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("原讨论的指标来源");
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("尚未发送的计算要求");
      await view.wrapper.get('[data-testid="assist-session-select"]').setValue(secondSessionId);
      expect(dialogText()).toContain("未发送的内容");
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("原讨论的指标来源");
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("尚未发送的计算要求");
      await new DomWrapper(document.querySelector('[data-testid="collab-discard-draft"]')).trigger("click");
      await flush();
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("第二讨论的方法对照");
      await view.wrapper.get('[data-testid="assist-session-select"]').setValue(sessionId); await flush();
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).toContain("原讨论的指标来源");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it.each([false, true])("恢复旧回执时当前讨论仍有保护（未决命令=%s），先保护会话再切路由", async (pending) => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const oldSessionId = "99999999-9999-4999-8999-999999999999";
    const oldCommandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const key = `relay-agent-chat-pending:http://127.0.0.1:8787:${workspaceId}`;
    const previous = window.sessionStorage.getItem(key);
    window.sessionStorage.setItem(key, JSON.stringify([{ commandId: oldCommandId, commandType: "RequestAssistMessage",
      sessionId: oldSessionId, targetKind: "TASK", targetId: taskId }]));
    const read = router({ sessions: () => response({ items: [sessionId, oldSessionId].map((id, index) => ({ id,
      workspace_id: workspaceId, project_id: projectId, task_id: taskId, title: `讨论${index + 1}`,
      status: "ACTIVE", revision: "1", updated_at: "2026-09-29T03:40:00Z" })) }) });
    let currentCommandId = ""; const posts: Record<string, unknown>[] = []; const receiptPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body); currentCommandId = String(body.command_id); throw new TypeError("response lost");
      }
      if (path === `${prefix}/commands/${oldCommandId}`) {
        receiptPaths.push(path);
        return response({ command_id: oldCommandId, command_type: "RequestAssistMessage", committed_at: "2026-09-30T04:00:00Z",
          result: { session_id: oldSessionId, assistant_message_id: "old-reply", user_message_id: "old-request" } });
      }
      if (currentCommandId && path === `${prefix}/commands/${currentCommandId}`) {
        receiptPaths.push(path); return response({ code: "COMMAND_NOT_FOUND", detail: "not found yet" }, 404);
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const originalInput = view.wrapper.get('[data-testid="assist-draft"]').element;
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("当前会话需要保留的讨论");
      if (pending) { await view.wrapper.get('[data-testid="assist-send"]').trigger("click"); await flush(); }
      await view.wrapper.get(`[data-testid="collab-recovery-${oldCommandId}"]`).trigger("click"); await flush();
      expect(view.wrapper.get('[data-testid="assist-draft"]').element).toBe(originalInput);
      expect((originalInput as HTMLTextAreaElement).value).toBe("当前会话需要保留的讨论");
      expect((view.wrapper.get('[data-testid="assist-session-select"]').element as HTMLSelectElement).value).toBe(sessionId);
      expect(view.router.currentRoute.value.query.work).toBe(taskId);
      if (pending) {
        expect(dialogText()).toContain(currentCommandId);
        expect(document.querySelector('[data-testid="collab-discard-draft"]')).toBeNull();
        await new DomWrapper(document.querySelector('[role="dialog"] button')).trigger("click");
        await view.wrapper.get(".assist-pending").findAll("button")[0]!.trigger("click"); await flush();
        expect(receiptPaths).toEqual([`${prefix}/commands/${oldCommandId}`, `${prefix}/commands/${currentCommandId}`]);
        expect(posts).toHaveLength(1);
      } else {
        expect(dialogText()).toContain("未发送的内容");
        expect(document.querySelector('[data-testid="collab-discard-draft"]')).not.toBeNull();
        expect(posts).toHaveLength(0);
      }
    } finally {
      view.unmount();
      if (previous === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, previous);
    }
  });

  it("非空文档提案先显示摘要，展开后接受仍沿原Assist命令Owner提交", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const proposalId = "99999999-9999-4999-8999-999999999999";
    let accepted = false;
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const read = router({ proposals: () => response({ items: [{ id: proposalId, session_id: sessionId,
      message_id: "candidate-message", kind: "CANDIDATE_MARKDOWN", target_type: "TASK", target_id: taskId,
      base_revision: "2", payload_hash: "c".repeat(64), status: accepted ? "ACCEPTED" : "PENDING",
      payload: { title: "评价口径候选.md", media_type: "text/markdown", markdown: "# 候选指标\n\n计算口径与数据来源。" } }] }) });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push({ path, body }); accepted = true;
        return response({ command_id: body.command_id, committed_at: "2026-10-01T03:00:00Z", result: { proposal_id: proposalId } });
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const panel = view.wrapper.get('[data-testid="assist-transcript"] [data-testid="assist-proposals"]');
      expect(panel.attributes("open")).toBeDefined();
      expect(panel.get("summary").text()).toContain("1 个待确认提议");
      expect(panel.text()).toContain("评价口径候选.md"); expect(panel.text()).toContain("计算口径与数据来源");
      const detail = panel.get(".agent-chat-proposal-details");
      expect(detail.attributes("open")).toBeUndefined();
      expect(detail.get("summary").text()).toBe("查看提议与接受操作");
      await act(async () => { (detail.element as HTMLDetailsElement).open = true; });
      expect(detail.attributes("open")).toBeDefined();
      expect(detail.get("pre").text()).toContain("计算口径与数据来源");
      expect(detail.get("details").attributes("open")).toBeUndefined();
      await panel.get(".assist-proposal .primary-button").trigger("click"); await flush();
      expect(posts).toHaveLength(1); expect(posts[0]!.path).toBe(`${prefix}/assist-proposals/${proposalId}/accept`);
      expect(Object.keys(posts[0]!.body)).toEqual(["command_id"]);
      expect(typeof posts[0]!.body.command_id).toBe("string");
      expect(view.wrapper.get('[data-testid="assist-proposals"]').text()).toContain("ACCEPTED");
    } finally { view.unmount(); }
  });

  it.each([["PROPOSE_CANDIDATE", "请求文档候选"], ["PROPOSE_TASK", "请求任务提案"]])(
    "%s最后按钮与冻结载荷一致，响应丢失保留意图和原命令", async (intent, label) => {
      activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
      const posts: Record<string, unknown>[] = []; const read = router({});
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "POST") { posts.push(JSON.parse(String(init.body)) as Record<string, unknown>); throw new TypeError("response lost"); }
        return read(input, init);
      }));
      const view = await mountWorkbench(`/agent?work=${taskId}`);
      try {
        await view.wrapper.get('[data-testid="assist-intent"]').setValue(intent);
        await view.wrapper.get('[data-testid="assist-draft"]').setValue("请补充计算口径");
        expect(view.wrapper.get('[data-testid="assist-send"]').text()).toBe(label);
        await view.wrapper.get('[data-testid="assist-send"]').trigger("click"); await flush();
        expect(posts[0]).toMatchObject({ intent, content: "请补充计算口径", source_refs: [] });
        expect(view.wrapper.get('[data-testid="assist-send"]').text()).toBe(label);
        expect(view.wrapper.get('[data-testid="assist-session-select"]').attributes("disabled")).toBeDefined();
        await view.wrapper.get(".assist-pending").findAll("button")[1]!.trigger("click"); await flush();
        expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]);
      } finally { view.unmount(); }
    });

  it.each(["TASK_CONTRACT_CHANGE", "VERIFICATION_PLAN_CHANGE"])("%s摘要保留完整提议，展开仍显示原版本与接受保护", async (kind) => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({ proposals: () => response({ items: [{ id: "proposal-summary", session_id: sessionId,
      message_id: "skill-message", kind, target_type: "TASK", target_id: taskId,
      base_revision: "2", base_acceptance_revision: "2", payload_hash: "c".repeat(64),
      payload_available: true, skill_sha256: "d".repeat(64), skill_output_sha256: "e".repeat(64), status: "PENDING",
      payload: { objective: "合并提议的目标", required_output_spec: { description: "可复核的报告" },
        criteria: [{ criterion_id: "c1", statement: "保留条件", required: true, method: "HUMAN_REVIEW", target_spec: {}, source: "PRESERVED" },
          { criterion_id: "c3", statement: "建议追加条件", required: true, method: "HUMAN_REVIEW", target_spec: {}, source: "SUGGESTED" }],
        added_criterion_ids: ["c3"], preserved_criterion_ids: ["c1"], suggested_mode: null } }] }) });
    vi.stubGlobal("fetch", fetchMock); const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const card = view.wrapper.get(".agent-chat-proposal-card");
      expect(card.get(".task-proposal-state").text()).toBe("待确认");
      expect(card.get(".assist-proposal-summary").text()).toBe("合并提议的目标");
      const detail = card.get(".agent-chat-proposal-details");
      expect(detail.attributes("open")).toBeUndefined();
      await act(async () => { (detail.element as HTMLDetailsElement).open = true; });
      expect(detail.get('[data-testid="task-skill-proposal"]').text()).toContain("建议追加条件");
      expect(detail.get('[data-testid="task-skill-proposal-status"]').text()).toContain("基线与当前 Task/验收版本一致");
      expect(detail.text()).toContain("当前由 AI 持有执行权");
      expect(detail.find('[data-testid="task-skill-accept"]').exists()).toBe(false);
      expect(detail.get(".proposal-source").attributes("open")).toBeUndefined();
      await act(async () => { (detail.element as HTMLDetailsElement).open = false; });
      expect(card.get(".assist-proposal-summary").text()).toBe("合并提议的目标");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("成果标签关联面板，方向键自动激活且IME不抢焦点，检查可回确切判断", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({}); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const owner = view.wrapper.get('[data-testid="review-decision"]').element;
      const tablist = view.wrapper.get('[data-testid="collab-side-tabs"]');
      expect(tablist.attributes("role")).toBe("tablist");
      const doc = view.wrapper.get('[data-testid="collab-side-tab-DOCUMENT"]').element as HTMLButtonElement;
      doc.focus();
      const key = async (value: string, composing = false) => {
        await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
          key: value, bubbles: true, cancelable: true, isComposing: composing
        })));
      };
      await key("ArrowRight", true); expect(document.activeElement).toBe(doc);
      await key("ArrowRight");
      const check = view.wrapper.get('[data-testid="collab-side-tab-CHECK"]');
      expect(document.activeElement).toBe(check.element); expect(check.attributes("aria-selected")).toBe("true");
      expect(view.wrapper.get('[data-testid="collab-panel-CHECK"]').attributes("aria-labelledby")).toBe(check.attributes("id"));
      expect(check.attributes("aria-controls")).toBe(view.wrapper.get('[data-testid="collab-panel-CHECK"]').attributes("id"));
      await view.wrapper.get('[data-testid="collab-review-shortcut"] button').trigger("click"); await flush();
      expect(view.wrapper.get('[data-testid="review-decision"]').element).toBe(owner);
      expect(document.activeElement).toBe(view.wrapper.get('[data-testid="collab-judgment"]').element);
      doc.focus(); await key("End");
      expect(view.wrapper.get('[data-testid="collab-side-tab-HISTORY"]').attributes("aria-selected")).toBe("true");
      await key("ArrowLeft"); expect(check.attributes("aria-selected")).toBe("true");
      await key("Home"); expect(doc.getAttribute("aria-selected")).toBe("true");
      expect(tablist.findAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("阅读历史时刷新不抢滚动，回到最新恢复跟随与消息区焦点", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let count = 1;
    const fetchMock = router({ messages: () => response({ items: Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`, session_id: sessionId, seq: String(index + 1), role: "USER", status: "COMPLETED", intent: "DISCUSS",
      content: `已保存消息${index}`, error_code: null, sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false
    })) }) });
    vi.stubGlobal("fetch", fetchMock); const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const transcript = view.wrapper.get('[data-testid="assist-transcript"]').element as HTMLDivElement;
      Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
      transcript.scrollTop = 150; await new DomWrapper(transcript).trigger("scroll");
      count = 2; await view.wrapper.get('[data-testid="assist-refresh"]').trigger("click"); await flush();
      expect(transcript.scrollTop).toBe(150); expect(transcript.textContent).toContain("已保存消息1");
      await view.wrapper.get('[data-testid="assist-latest"]').trigger("click");
      expect(transcript.scrollTop).toBe(1000); expect(document.activeElement).toBe(transcript);
      expect(view.wrapper.find('[data-testid="assist-latest"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("底部跟随正文增高与容器变化，历史阅读和隐藏模式保留原滚动意图，卸载清理观察器", async () => {
    const observers: { observed: Element[]; notify: () => void; disconnected: boolean }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      readonly observed: Element[] = [];
      disconnected = false;
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.observed.push(target); }
      disconnect() { this.disconnected = true; }
      notify() { this.callback([], this as unknown as ResizeObserver); }
    });
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({}));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    let observer: typeof observers[number] | undefined;
    try {
      const transcript = view.wrapper.get('[data-testid="assist-transcript"]').element as HTMLDivElement;
      const content = transcript.querySelector(".agent-chat-content")!;
      observer = observers.find((item) => item.observed.includes(transcript));
      expect(observer?.observed).toContain(content);
      let height = 1000; let viewport = 200;
      Object.defineProperties(transcript, { scrollHeight: { configurable: true, get: () => height }, clientHeight: { configurable: true, get: () => viewport } });
      transcript.scrollTop = 800; await new DomWrapper(transcript).trigger("scroll");
      height = 1250; await act(async () => observer!.notify());
      expect(transcript.scrollTop).toBe(1250);
      viewport = 0; height = 1300; await new DomWrapper(transcript).trigger("scroll");
      await act(async () => observer!.notify()); expect(transcript.scrollTop).toBe(1250);
      viewport = 200; await act(async () => observer!.notify()); expect(transcript.scrollTop).toBe(1300);
      transcript.scrollTop = 150; await new DomWrapper(transcript).trigger("scroll");
      height = 1450; viewport = 160; await act(async () => observer!.notify());
      expect(transcript.scrollTop).toBe(150);
      expect(view.wrapper.find('[data-testid="assist-latest"]').exists()).toBe(true);
    } finally { view.unmount(); }
    expect(observer?.disconnected).toBe(true);
  });

  it("会话选项Escape收起并返回摘要焦点，输入法和组合键保留选项与原草稿", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({}); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      await draft.setValue("保留未发送的消息");
      await view.wrapper.get('[data-testid="assist-open-sources"]').trigger("click"); await flush();
      const options = view.wrapper.get(".agent-chat-options");
      const query = options.get("#assist-source-query");
      await query.setValue("保留检索词");
      const queryOwner = query.element as HTMLInputElement;
      queryOwner.focus();
      const press = async (extra: KeyboardEventInit) => {
        await act(async () => queryOwner.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true, ...extra
        })));
      };
      for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
        await press(extra);
        expect(options.attributes("open")).toBeDefined(); expect(document.activeElement).toBe(queryOwner);
      }
      await press({}); await flush();
      expect(options.attributes("open")).toBeUndefined();
      expect(document.activeElement).toBe(options.get("summary").element);
      expect((draft.element as HTMLTextAreaElement).value).toBe("保留未发送的消息");
      await view.wrapper.get('[data-testid="assist-open-sources"]').trigger("click"); await flush();
      expect(options.get("#assist-source-query").element).toBe(queryOwner);
      expect(queryOwner.value).toBe("保留检索词");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("聊天Enter发送保留输入法与Shift换行保护", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: Record<string, unknown>[] = []; const read = router({});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
        return response({ command_id: body.command_id, committed_at: "2026-10-01T03:00:00Z", result: {
          session_id: sessionId, user_message_id: "user-new", assistant_message_id: "assistant-new" } }, 202);
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]');
      const send = view.wrapper.get('[data-testid="assist-send"]').element as HTMLButtonElement;
      expect(send.form).toBe((draft.element as HTMLTextAreaElement).form);
      expect(view.wrapper.find("form form").exists()).toBe(false);
      await draft.setValue("输入法完成后的内容");
      const press = async (options: KeyboardEventInit) => {
        await act(async () => draft.element!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options })));
      };
      await press({ isComposing: true }); await press({ keyCode: 229 }); await press({ shiftKey: true });
      expect(posts).toHaveLength(0);
      expect((draft.element as HTMLTextAreaElement).value).toBe("输入法完成后的内容");
      await press({}); await flush();
      expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ content: "输入法完成后的内容", intent: "DISCUSS", source_refs: [] });
    } finally { view.unmount(); }
  });

  it("版本历史归属错误就地可见，旧选择迟到的错误不覆盖新版本", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const otherVersionId = "99999999-9999-4999-8999-999999999999";
    const data = artifacts();
    data.items[0]!.versions.push({ ...data.items[0]!.versions[0]!, artifact_version_id: otherVersionId, version_number: "1" });
    const lineage = (id: string) => response({ artifact_version_id: id, artifact_id: data.items[0]!.id,
      version_number: id === otherVersionId ? "1" : "2", sha256: "a".repeat(64), source_kind: "HUMAN",
      content_availability: "UNAVAILABLE", direct_parents: [] });
    let originalReads = 0; let release: ((result: Response) => void) | null = null;
    const paths: string[] = [];
    const read = router({ artifacts: () => response(data) });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/artifact-versions/${versionId}/lineage`) {
        paths.push(path); originalReads++;
        if (originalReads === 1) return lineage(otherVersionId);
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      if (path === `${prefix}/artifact-versions/${otherVersionId}/lineage`) { paths.push(path); return lineage(otherVersionId); }
      return read(input, init);
    });
    vi.stubGlobal("fetch", fetchMock); const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="collab-side-tab-HISTORY"]').trigger("click"); await flush();
      await view.wrapper.get('[data-testid="collab-history-select"]').setValue(versionId); await flush();
      expect(view.wrapper.get('[data-testid="collab-panel-HISTORY"] [role="alert"]').text()).toContain("来源关系与所选版本不匹配");
      expect(view.wrapper.find('[data-testid="collab-history-detail"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="collab-history-select"]').setValue("");
      await view.wrapper.get('[data-testid="collab-history-select"]').setValue(versionId); await flush();
      expect(release).not.toBeNull();
      await view.wrapper.get('[data-testid="collab-history-select"]').setValue(otherVersionId); await flush();
      expect(view.wrapper.get('[data-testid="collab-history-detail"]').text()).toContain("v1");
      await act(async () => { release!(lineage(otherVersionId)); }); await flush();
      expect(view.wrapper.find('[data-testid="collab-panel-HISTORY"] [role="alert"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="collab-history-detail"]').text()).toContain("v1");
      expect(paths).toEqual([`${prefix}/artifact-versions/${versionId}/lineage`, `${prefix}/artifact-versions/${versionId}/lineage`,
        `${prefix}/artifact-versions/${otherVersionId}/lineage`]);
    } finally { view.unmount(); }
  });

  it("输入Enter发送真实讨论，中文IME与Shift+Enter保留草稿且不提交", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: Record<string, unknown>[] = []; const read = router({});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; posts.push(body);
        return response({ command_id: body.command_id, committed_at: "2026-10-01T03:00:00Z",
          result: { session_id: sessionId, assistant_message_id: "assistant-response", user_message_id: "user-request" } }, 202);
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const draft = view.wrapper.get('[data-testid="assist-draft"]'); await draft.setValue("补充实验指标来源");
      for (const properties of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
        await act(async () => draft.element?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...properties })));
      }
      expect(posts).toHaveLength(0); expect((draft.element as HTMLTextAreaElement).value).toBe("补充实验指标来源");
      await act(async () => draft.element?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      await flush(); expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ content: "补充实验指标来源", intent: "DISCUSS", source_refs: [] });
      expect((draft.element as HTMLTextAreaElement).value).toBe("");
    } finally { view.unmount(); }
  });

  it("Review 判定：读取挂起时禁止用旧请求提交，最新响应到达后启用", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let deferred = false;
    const releases: ((value: Response) => void)[] = [];
    const fetchMock = router({ reviews: () => deferred
      ? new Promise<Response>((resolve) => releases.push(resolve)) : response({ items: [openReview()] }) });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    deferred = true;
    await view.wrapper.get('[data-testid="run-refresh"]').trigger("click"); await flush(80);
    expect(releases.length).toBeGreaterThan(0);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    releases.forEach((resolve) => resolve(response({ items: [openReview()] }))); await flush(80);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeUndefined();
    view.unmount();
  });

  it("Review 判定：切换检查、历史和工具保留反馈及响应丢失原命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let commandId = ""; let posts = 0; const receiptPaths: string[] = [];
    const read = router({});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/reviews/${reviewId}/decisions` && init?.method === "POST") {
        posts++; commandId = String(JSON.parse(String(init.body)).command_id); throw new TypeError("response lost");
      }
      if (path === `${prefix}/commands/${commandId}`) {
        receiptPaths.push(path);
        return response({ command_id: commandId, command_type: "ResolveReview", committed_at: "2026-09-30T04:00:00Z",
          result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", effect: {}, revision: "4" } });
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    const cycle = async () => {
      await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
      await view.wrapper.get('[data-testid="collab-side-tab-HISTORY"]').trigger("click"); await flush(40);
      await view.wrapper.get('[data-testid="collab-devtools-toggle"]').trigger("click"); await flush(40);
      await view.wrapper.get('[data-testid="devtools-close"]').trigger("click");
      await view.wrapper.get('[data-testid="collab-side-tab-DOCUMENT"]').trigger("click"); await flush(40);
    };
    await view.wrapper.get(`#review-feedback-${reviewId}`).setValue("保留待判断说明");
    await cycle();
    expect((view.wrapper.get(`#review-feedback-${reviewId}`).element as HTMLTextAreaElement).value).toBe("保留待判断说明");
    await view.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush(60);
    await cycle();
    expect(view.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);
    expect((view.wrapper.get(`#review-feedback-${reviewId}`).element as HTMLTextAreaElement).value).toBe("保留待判断说明");
    await view.wrapper.get('[data-testid="review-check-receipt"]').trigger("click"); await flush(60);
    expect(receiptPaths).toEqual([`${prefix}/commands/${commandId}`]); expect(posts).toBe(1);
    view.unmount();
  });

  it("Review 判定：响应丢失阻止本地换请求和换会话，列表重排及缺席仍核对原ID", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const secondReviewId = "99999999-9999-4999-8999-999999999999";
    const secondSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const second = { ...openReview(), id: secondReviewId, reason: "第二项判断", target_hash: "c".repeat(64) };
    let order = 0; let receiptAvailable = false; let taskReadFails = false;
    let commandId = ""; const posts: { path: string; body: Record<string, unknown> }[] = [];
    const receiptPaths: string[] = [];
    const read = router({ reviews: () => response({ items: order === 0 ? [openReview(), second]
      : order === 1 ? [second, openReview()] : [second] }),
      task: () => taskReadFails ? response({ code: "DATABASE_UNAVAILABLE", detail: "task read unavailable" }, 503) : response(task()),
      sessions: () => response({ items: [sessionId, secondSessionId].map((id, index) => ({ id, workspace_id: workspaceId,
        project_id: projectId, task_id: taskId, title: `讨论${index + 1}`, status: "ACTIVE", revision: "1",
        updated_at: "2026-09-29T03:40:00Z" })) }) });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST" && path.endsWith("/decisions")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body }); commandId = String(body.command_id); throw new TypeError("response lost");
      }
      if (path.startsWith(`${prefix}/commands/`)) {
        receiptPaths.push(path);
        return receiptAvailable
          ? response({ command_id: commandId, command_type: "ResolveReview", committed_at: "2026-09-30T04:00:00Z",
              result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", effect: {}, revision: "4" } })
          : response({ code: "COMMAND_NOT_FOUND", detail: "not found yet" }, 404);
      }
      if (path === `${prefix}/assist-sessions/${secondSessionId}/messages`) return response({ items: [] });
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      const originalOwner = view.wrapper.get('[data-testid="review-decision"]').element;
      expect(view.wrapper.get('[data-testid="collab-review-select"]').text()).toContain("人工验收 · 必需验收条件需要你的判断。");
      expect(view.wrapper.get('[data-testid="collab-review-select"]').text()).not.toContain("CRITERION");
      await view.wrapper.get(`#review-feedback-${reviewId}`).setValue("原请求的判断说明");
      await view.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
      expect(posts).toHaveLength(1);
      await view.wrapper.get('[data-testid="collab-review-select"]').setValue("1"); await flush();
      expect(dialogText()).toContain(commandId);
      expect(document.querySelector('[data-testid="collab-discard-draft"]')).toBeNull();
      expect((view.wrapper.get('[data-testid="collab-review-select"]').element as HTMLSelectElement).value).toBe("0");
      await new DomWrapper(document.querySelector('[role="dialog"] button')).trigger("click");
      await view.wrapper.get('[data-testid="assist-session-select"]').setValue(secondSessionId); await flush();
      expect(dialogText()).toContain(commandId);
      expect((view.wrapper.get('[data-testid="assist-session-select"]').element as HTMLSelectElement).value).toBe(sessionId);
      await new DomWrapper(document.querySelector('[role="dialog"] button')).trigger("click");
      order = 1;
      await view.wrapper.get('[data-testid="run-refresh"]').trigger("click"); await flush();
      expect((view.wrapper.get('[data-testid="collab-review-select"]').element as HTMLSelectElement).value).toBe("1");
      expect(view.wrapper.get('[data-testid="review-decision"]').element).toBe(originalOwner);
      order = 2;
      await view.wrapper.get('[data-testid="run-refresh"]').trigger("click"); await flush();
      expect(view.wrapper.get('[data-testid="review-project-archive-reason"]').text()).toContain("未出现在最新列表");
      expect(view.wrapper.get('[data-testid="review-decision"]').element).toBe(originalOwner);
      expect((view.wrapper.get(`#review-feedback-${reviewId}`).element as HTMLTextAreaElement).value).toBe("原请求的判断说明");
      taskReadFails = true;
      await view.wrapper.get('[data-testid="run-refresh"]').trigger("click"); await flush();
      expect(view.wrapper.get('[data-testid="collab-task-error"]').text()).toContain("数据库不可达");
      expect(view.wrapper.get('[data-testid="review-decision"]').element).toBe(originalOwner);
      expect(view.wrapper.get('[data-testid="assist-send"]').attributes("disabled")).toBeDefined();
      await view.wrapper.get('[data-testid="review-check-receipt"]').trigger("click"); await flush();
      expect(view.wrapper.text()).toContain("尚未找到原命令回执");
      await view.wrapper.get('[data-testid="collab-review-select"]').setValue("0"); await flush();
      expect(dialogText()).toContain(commandId);
      await new DomWrapper(document.querySelector('[role="dialog"] button')).trigger("click");
      taskReadFails = false; receiptAvailable = true;
      await view.wrapper.get('[data-testid="review-check-receipt"]').trigger("click"); await flush(80);
      expect(receiptPaths).toEqual([`${prefix}/commands/${commandId}`, `${prefix}/commands/${commandId}`]);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ path: `${prefix}/reviews/${reviewId}/decisions`,
        body: { command_id: commandId, feedback: "原请求的判断说明", expected_revision: "3", target_hash: "b".repeat(64) } });
      expect(view.wrapper.find(`#review-feedback-${reviewId}`).exists()).toBe(false);
      expect(view.wrapper.get(`#review-feedback-${secondReviewId}`).exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("Review 判定：本地换请求先保护说明，确认丢弃时同步清空组合草稿", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const secondReviewId = "99999999-9999-4999-8999-999999999999";
    const fetchMock = router({ reviews: () => response({ items: [openReview(), { ...openReview(), id: secondReviewId, reason: "第二项判断" }] }) });
    vi.stubGlobal("fetch", fetchMock); const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get(`#review-feedback-${reviewId}`).setValue("不应带到第二条请求");
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("尚未发送的讨论");
      await view.wrapper.get('[data-testid="collab-review-select"]').setValue("1"); await flush();
      expect(dialogText()).toContain("判断说明");
      expect(view.wrapper.find(`#review-feedback-${reviewId}`).exists()).toBe(true);
      await new DomWrapper(document.querySelector('[role="dialog"] button')).trigger("click");
      expect((view.wrapper.get(`#review-feedback-${reviewId}`).element as HTMLTextAreaElement).value).toBe("不应带到第二条请求");
      await view.wrapper.get('[data-testid="collab-review-select"]').setValue("1"); await flush();
      await new DomWrapper(document.querySelector('[data-testid="collab-discard-draft"]')).trigger("click"); await flush();
      expect((view.wrapper.get(`#review-feedback-${secondReviewId}`).element as HTMLTextAreaElement).value).toBe("");
      expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value).toBe("");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("紧凑判断收起说明；请求修改缺说明时展开且不提交新命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: Record<string, unknown>[] = [];
    const read = router({});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    expect(view.wrapper.get('[data-testid="review-feedback-details"]').attributes("open")).toBeUndefined();
    await view.wrapper.get('[data-testid="review-decision-REQUEST_CHANGES"]').trigger("click"); await flush();
    expect(posts).toHaveLength(0);
    expect(view.wrapper.get('[data-testid="review-feedback-details"]').attributes("open")).toBeDefined();
    expect(view.wrapper.text()).toContain("请求修改时请说明需要调整的内容。");
    await view.wrapper.get(`#review-feedback-${reviewId}`).setValue("补充计算口径");
    await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
    await view.wrapper.get('[data-testid="collab-side-tab-DOCUMENT"]').trigger("click");
    expect((view.wrapper.get(`#review-feedback-${reviewId}`).element as HTMLTextAreaElement).value).toBe("补充计算口径");
    expect(view.wrapper.get('[data-testid="review-feedback-details"]').attributes("open")).toBeDefined();
    view.unmount();
  });

  it("Review 判定：核对成功后通过原决定接口提交确切身份", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let decided = false;
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const read = router({ reviews: () => response({ items: decided ? [] : [openReview()] }) });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/reviews/${reviewId}/decisions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body }); decided = true;
        return response({ command_id: body.command_id, committed_at: "2026-09-30T04:00:00Z",
          result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", effect: {}, revision: "4" } });
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await flush(80);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeUndefined();
    const bound = view.wrapper.get('[data-testid="review-bound-summary"]').text();
    expect(view.wrapper.get(".review-evidence-details").text()).toContain(versionId);
    expect(bound).toContain("验收版本2"); expect(bound).toContain("指标定义明确");
    expect(view.wrapper.get(".review-evidence-details").text()).toContain("验收条件 IDc1");
    expect(view.wrapper.get(".review-evidence-details").attributes("open")).toBeUndefined();
    await view.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush(80);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: `${prefix}/reviews/${reviewId}/decisions`,
      body: { decision: "ACCEPT", expected_revision: "3", target_hash: "b".repeat(64) } });
    expect(typeof posts[0]!.body.command_id).toBe("string");
    expect(view.wrapper.find('[data-testid="collab-judgment"]').exists()).toBe(false);
    view.unmount();
  });

  it.each([
    ["项目归档", { project: () => response(project("2026-09-30T03:00:00Z")) }, "已归档"],
    ["项目读取失败", { project: () => response({ code: "DATABASE_UNAVAILABLE", detail: "unavailable" }, 503) }, "读取失败"],
    ["Review项目不匹配", { reviews: () => response({ items: [{ ...openReview(), project_id: "other-project" }] }) }, "归属"],
  ] as const)("Review 判定：%s禁止提交并说明原因", async (_name, routes, reason) => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router(routes); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="review-project-archive-reason"]').text()).toContain(reason);
    await view.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });

  it("Review 判定：另一个Task的请求不显示为当前判断，零提交", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({ reviews: () => response({ items: [{ ...openReview(), task_id: "other-task" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    expect(view.wrapper.find('[data-testid="collab-judgment"]').exists()).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });

  it("Review 判定：重读失败禁止使用旧请求，成功重读清除错误", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let failing = false;
    const fetchMock = router({ reviews: () => failing
      ? response({ code: "DATABASE_UNAVAILABLE", detail: "unavailable" }, 503)
      : response({ items: [openReview()] }) });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    failing = true;
    await view.wrapper.get('[data-testid="run-refresh"]').trigger("click"); await flush(80);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="review-project-archive-reason"]').text()).toContain("Review");
    failing = false;
    await view.wrapper.get('[data-testid="run-refresh"]').trigger("click"); await flush(80);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeUndefined();
    expect(view.wrapper.find('[data-testid="review-project-archive-reason"]').exists()).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });

  it("Review 判定：合法无项目Task与null项目请求匹配可判断", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ task: () => response(task({ project_id: null })),
      reviews: () => response({ items: [{ ...openReview(), project_id: null }] }) }));
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    expect(view.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeUndefined();
    view.unmount();
  });

  it("Review 判定：动作类型与真实目标在证据折叠外常驻", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ reviews: () => response({ items: [{ ...openReview(), kind: "ACTION_APPROVAL",
      target: { action_type: "LOCAL_COMMIT", normalized_target: "D:/repo:local-commit", params_hash: "c".repeat(64) },
      allowed_decisions: ["APPROVE", "DENY"] }] }) }));
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(80);
    const bound = view.wrapper.get('[data-testid="review-bound-summary"]').text();
    expect(bound).toContain("LOCAL_COMMIT"); expect(bound).toContain("D:/repo:local-commit");
    expect(bound).not.toContain("c".repeat(64));
    expect(view.wrapper.get(".review-evidence-details").attributes("open")).toBeUndefined();
    view.unmount();
  });

  it("窄窗视图切换保留讨论草稿，返回讨论隐藏成果层并保留工具Owner，不提交业务命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({});
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await flush(80);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("保留这段未发送的讨论");
    await view.wrapper.get('[data-testid="collab-narrow-DOCUMENT"]').trigger("click");
    expect(view.wrapper.get(".collab-columns").attributes("data-narrow-side")).toBe("open");
    await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
    expect(view.wrapper.get('[data-testid="collab-panel-CHECK"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="collab-devtools-toggle"]').trigger("click");
    await flush(40);
    const toolsOwner = view.wrapper.get('[data-testid="devtools-panel"]').element;
    await view.wrapper.get('[data-testid="collab-narrow-DISCUSSION"]').trigger("click");
    expect(view.wrapper.get(".collab-columns").attributes("data-narrow-side")).toBe("closed");
    expect(view.wrapper.get('[data-testid="devtools-panel"]').element).toBe(toolsOwner);
    expect(view.wrapper.get(".collab-columns").attributes("data-layout-mode")).toBe("split");
    expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
      .toBe("保留这段未发送的讨论");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
  });

  it("近期工作在所有 live 页面常驻，切换页面保留同一列表并可进入确切工作", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({});
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/projects");
    try {
      const rail = view.wrapper.get('[data-testid="recent-work"]').element;
      expect(rail?.textContent).toContain("确定实验评价指标");
      for (const path of ["/tasks", "/knowledge", "/settings", `/tasks/${taskId}`]) {
        await view.router.push(path); await flush();
        expect(view.wrapper.get('[data-testid="recent-work"]').element).toBe(rail);
        expect(view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).text()).toContain("确定实验评价指标");
      }
      await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click"); await flush();
      expect(view.router.currentRoute.value).toMatchObject({ path: "/agent", query: { work: taskId } });
      expect(view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).attributes("aria-current")).toBe("true");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("窄屏导航抽屉也可直接打开近期工作，导航后关闭抽屉且不新建业务对象", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({});
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/projects");
    try {
      await view.wrapper.get('button[aria-label="打开导航"]').trigger("click"); await flush();
      const drawer = new DomWrapper(document.querySelector('[role="dialog"][aria-label="导航"]'));
      expect(drawer.get('[data-testid="recent-work"] [title="全部任务 · 按最近变更排序"]').exists()).toBe(true);
      await drawer.get(`[data-testid="recent-work-${taskId}"]`).trigger("click"); await flush();
      expect(view.router.currentRoute.value).toMatchObject({ path: "/agent", query: { work: taskId } });
      expect(document.querySelector('[role="dialog"][aria-label="导航"]')).toBeNull();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("全局近期工作重读失权后隐藏旧任务，不将读取错误说成写入待核对", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let readable = true;
    const fetchMock = router({ workspaceTasks: () => readable ? response({ items: [task()], next_cursor: null })
      : response({ code: "RESOURCE_NOT_FOUND", detail: "近期工作不可读" }, 403) });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/projects");
    try {
      const rail = view.wrapper.get('[data-testid="recent-work"]');
      expect(rail.find(`[data-testid="recent-work-${taskId}"]`).exists()).toBe(true);
      readable = false;
      await rail.get('[data-testid="recent-work-refresh"]').trigger("click"); await flush();
      expect(rail.find(`[data-testid="recent-work-${taskId}"]`).exists()).toBe(false);
      expect(rail.get('[data-testid="recent-work-error"]').text()).toContain("近期工作不可读");
      expect(rail.text()).not.toContain("命令结果待核对");
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("示例模式明确没有真实工作；live 首次进入只读取，不新建任务也不显示虚构近期工作", async () => {
    const first = await mountWorkbench("/agent");
    await flush();
    expect(first.wrapper.get(".breadcrumbs").text()).toContain("近期工作");
    expect(first.wrapper.get('[data-testid="collab-fixture-gap"]').text()).toContain("示例模式没有真实工作");
    expect(first.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);
    // 示例模式没有真实 Task，左栏不渲染近期工作列表，也不伪造历史。
    expect(first.wrapper.find('[data-testid="recent-work"]').exists()).toBe(false);
    first.unmount();

    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({ workspaceTasks: () => response({ items: [], next_cursor: null }) });
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench("/agent");
    await flush(60);
    expect(view.wrapper.get('[data-testid="collab-empty"]').text()).toContain("这次想推进什么");
    expect(view.wrapper.get('[data-testid="recent-work"]').text()).toContain("还没有任务");
    // 范围与排序常驻可见，避免用户把会话列表误当作全部工作。
    expect(view.wrapper.get('[data-testid="recent-work"] [title="全部任务 · 按最近变更排序"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-draft"]').exists()).toBe(false);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(0);
    view.unmount();
  });

  it("归属未确认时不发送；选定确切任务后恢复目标、Run 事实、草稿与待判断项", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: string[] = [];
    const fetchMock = router({});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(new URL(String(input)).pathname);
      return fetchMock(input, init);
    }));
    const view = await mountWorkbench("/agent");
    await flush(60);
    expect(view.wrapper.find('[data-testid="collab-goal"]').exists()).toBe(false);

    await view.wrapper.get('[data-testid="collab-pick-target"]').trigger("click");
    await flush(60);
    await view.wrapper.get('[data-testid="collab-target-select"]').setValue(taskId);
    expect(view.wrapper.get('[data-testid="collab-target-open"]').attributes("disabled")).toBeUndefined();
    await view.wrapper.get('[data-testid="collab-target-open"]').trigger("click");
    await flush(60);

    const goal = view.wrapper.get('[data-testid="collab-goal"]').text();
    expect(goal).toContain("确定实验评价指标");
    expect(goal).toContain("人机协作工作流研究");
    expect(goal).toContain("补齐基线、评价方法与可复核的验收依据。");
    // 事实条三格：需要什么 / 已绑定什么 / 证据在哪。等待判断不被写成"已暂停"。
    const facts = view.wrapper.get('[data-testid="collab-facts"]').text();
    expect(facts).toContain("等待人工判断");
    expect(facts).toContain("等待判断不等于已暂停");
    expect(facts).toContain("任务 v2 / 验收 v2");
    expect(facts).toContain("证据：检查记录");
    // 面包屑按确切 Project/Task 展开。
    expect(view.wrapper.get(".breadcrumbs").text()).toContain("人机协作工作流研究");
    expect(view.wrapper.get('[data-testid="run-control"]').text()).toContain("控制提交回执表示 PENDING");
    // 判断卡内联在文档页签正文下方。
    expect(view.wrapper.get('[data-testid="collab-judgment"]').text()).toContain("等待你的判断");
    expect(view.wrapper.get('[data-testid="collab-judgment"]').text()).toContain("判断不会暂停执行或转移执行权");
    // 执行进展收在右栏检查页签，不再占据对话主区。
    expect(view.wrapper.find('[data-testid="collab-run-progress"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
    expect(view.wrapper.get('[data-testid="collab-panel-DOCUMENT"]').attributes("hidden")).toBeDefined();
    await flush(40);
    expect(view.wrapper.get('[data-testid="collab-run-progress"]').text()).toContain("生成草稿");
    expect(view.wrapper.get('[data-testid="run-control"]').text()).toContain("控制提交回执表示 PENDING");
    expect(posts).toHaveLength(0);
    view.unmount();
  });

  it("生成中草稿与已保存版本分开表达；接受、暂存、提交、推送分别声明", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ draft: () => response({ run_id: runId, run_status: "RUNNING",
      preview_available: true, preview_text: "生成中的草稿正文", preview_revision: "3", preview_truncated: false,
      step_attempt_id: "attempt-1", attempt_claim_epoch: "1", model_call_id: "call-1" }) }));
    const view = await mountWorkbench("/agent");
    await flush(60);
 await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);

    const reader = view.wrapper.get('[data-testid="collab-artifact-reader"]').text();
    expect(reader).toContain("生成中预览 · 未保存");
    expect(reader).toContain("不是受管产物、不是验证通过，也不是任务完成");
    expect(reader).toContain("评价方案.md");
    expect(view.wrapper.get(".version-row").text()).toContain("最新");
    expect(view.wrapper.get(".version-row").text()).not.toContain("本轮接受");
    expect(view.wrapper.get(".version-row").text()).not.toContain("当前选用");
    expect(reader).toContain("三者分别表达，不互相继承");

    await view.wrapper.get(`[data-testid="collab-read-${versionId}"]`).trigger("click");
    await flush(40);
    expect(view.wrapper.get('[data-testid="collab-reading"]').text()).toContain("评价方案");

    await view.wrapper.get('[data-testid="collab-devtools-toggle"]').trigger("click");
    await flush(40);
    expect(view.wrapper.get('[data-testid="devtools-files"]').text()).toContain("该 Project 已登记的受管目录");
    expect(view.wrapper.get('[data-testid="devtools-files"]').text()).toContain("D:\\repo");
    expect(view.wrapper.get('[data-testid="devtools-files"]').text()).toContain("受管产物是任务产物版本，工作目录文件是受管目录下的普通文件；两者来源不同，不混成同一版本。");
    await view.wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click");
    expect(view.wrapper.get('[data-testid="devtools-git-gap"]').text()).toContain("没有受管目录的只读 Git 状态或 diff 接口");
    expect(view.wrapper.get('[data-testid="devtools-git"]').text()).toContain("非 Git 目录与读取失败都不得显示为“干净”");
    expect(view.wrapper.find('[data-testid="devtools-terminal-gap"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="devtools-tab-TERMINAL"]').trigger("click");
    expect(view.wrapper.get('[data-testid="devtools-terminal-gap"]').text()).toContain("不提供可执行提示符");
    expect(view.wrapper.find('[data-testid="devtools-panel"]').exists()).toBe(true);
    view.unmount();
  });

  it("工具页签键盘首尾循环并忽略输入法，执行输出通过独立开关展开且不执行命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({}); vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="collab-devtools-toggle"]').trigger("click"); await flush();
      const tabs = view.wrapper.get('.devtools-header .devtools-tabs');
      expect(tabs.attributes("role")).toBe("tablist");
      const selected = () => tabs.get('[aria-selected="true"]');
      const press = async (key: string, properties: KeyboardEventInit = {}) => {
        await act(async () => selected().element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...properties })));
      };
      await act(async () => (selected().element as HTMLButtonElement).focus());
      for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
        await press("ArrowRight", properties);
        expect(selected().attributes("data-testid")).toBe("devtools-tab-FILES");
      }
      for (const [key, expected] of [["ArrowLeft", "RUNS"], ["ArrowRight", "FILES"], ["End", "RUNS"], ["Home", "FILES"], ["ArrowRight", "GIT"], ["ArrowRight", "TERMINAL"]]) {
        await press(key!);
        const current = selected();
        expect(current.attributes("data-testid")).toBe(`devtools-tab-${expected}`);
        expect(current.attributes("role")).toBe("tab");
        expect(document.activeElement).toBe(current.element);
        expect(current.attributes("tabindex")).toBe("0"); expect(tabs.findAll('[tabindex="0"]')).toHaveLength(1);
        const panel = document.getElementById(current.attributes("aria-controls")!);
        expect(panel?.getAttribute("role")).toBe("tabpanel");
        expect(panel?.getAttribute("aria-labelledby")).toBe(current.attributes("id"));
      }
      expect(view.wrapper.get('[data-testid="devtools-terminal-gap"]').text()).toContain("不提供可执行提示符");
      const outputToggle = view.wrapper.get('[data-testid="devtools-tab-OUTPUT"]');
      expect(outputToggle.attributes("role")).toBeUndefined();
      expect(outputToggle.attributes("aria-expanded")).toBe("false");
      const outputPanel = document.getElementById(outputToggle.attributes("aria-controls")!);
      expect(outputPanel?.hidden).toBe(true);
      await outputToggle.trigger("click"); await flush();
      expect(outputToggle.attributes("aria-expanded")).toBe("true"); expect(outputPanel?.hidden).toBe(false);
      expect(selected().attributes("data-testid")).toBe("devtools-tab-TERMINAL");
      await outputToggle.trigger("click");
      expect(outputToggle.attributes("aria-expanded")).toBe("false"); expect(outputPanel?.hidden).toBe(true);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    } finally { view.unmount(); }
  });

  it("执行输出只显示服务端保存的真实 stdout，绑定 Run 与 Invocation；Trace 不冒充输出", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ operations: () => response([
      { id: "op-1", status: "SUCCEEDED", action_type: "CLI_RUN", normalized_target: "D:\\repo",
        invocations: [
          { id: "inv-1", status: "SUCCEEDED", created_at: "2026-09-29T03:50:00Z", resolved_at: "2026-09-29T03:50:02Z",
            result_ref: { outcome: "SUCCEEDED", exit_code: 0, stdout: "build ok\n", stderr: "", truncated: false,
              duration_ms: 2100, invocation_id: "inv-1", operation_id: "op-1" } },
          { id: "inv-2", status: "SUCCEEDED", created_at: "2026-09-29T03:51:00Z", resolved_at: null, result_ref: null }
        ] }
    ]) }));
    const view = await mountWorkbench("/agent");
    await flush(60);
 await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    await view.wrapper.get('[data-testid="collab-devtools-toggle"]').trigger("click");
    await flush(40);
    await view.wrapper.get('[data-testid="devtools-tab-OUTPUT"]').trigger("click");
    await flush(60);
    const output = view.wrapper.get('[data-testid="devtools-output"]').text();
    expect(output).toContain("build ok");
    expect(output).toContain("退出码 0");
    expect(output).toContain("原 operation_id：op-1");
    expect(output).toContain("原 Invocation inv-1");
    expect(output).toContain("这次调用没有保存 stdout/stderr；不能据此推断命令成功或失败");
    expect(output).not.toContain("Run Trace");
    view.unmount();
  });

  it("暂停请求中、已暂停与等待安全接手分别表达，且请求受理不显示为已暂停", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let status = "RUNNING";
    let pending: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === `${prefix}/runs/${runId}/control-requests` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        pending = { id: "req-1", type: body.type, status: "PENDING", requested_at: "2026-09-29T04:00:00Z" };
        return response({ command_id: body.command_id, committed_at: "2026-09-29T04:00:00Z", result: {
          control_request_id: "req-1", run_id: runId, task_id: taskId, type: body.type,
          status: "PENDING", run_revision: "5" } }, 202);
      }
      const mocked = router({ run: () => response(run(status, pending ? { pending_control_request: pending } : {})) });
      return mocked(input, init);
    }));
    const view = await mountWorkbench("/agent");
    await flush(60);
 await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);

    await view.wrapper.get('[data-testid="run-control-PAUSE"]').trigger("click");
    await flush(80);
    const control = view.wrapper.get('[data-testid="run-control-pending"]').text();
    expect(control).toContain("请求暂停 Run：PENDING");
    expect(control).toContain("Run 尚未暂停");
    expect(control).toContain("等待安全点处理");
    expect(view.wrapper.get('[data-testid="run-control-PAUSE"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.find('[data-testid="run-resume"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="run-handoff-edit"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="collab-facts"]').text()).toContain("等待人工判断");

    status = "PAUSED";
    pending = { id: "req-2", type: "HANDOFF", status: "PENDING", requested_at: "2026-09-29T04:05:00Z" };
    await view.wrapper.get('[data-testid="run-refresh"]').trigger("click");
    await flush(80);
    expect(view.wrapper.get('[data-testid="collab-facts"]').text()).toContain("已暂停");
    expect(view.wrapper.get('[data-testid="run-control-pending"]').text()).toContain("尚未交接，人工编辑入口未开放");
    expect(view.wrapper.find('[data-testid="run-handoff-edit"]').exists()).toBe(false);
    view.unmount();
  });

  it("协作委托配置折叠保留输入，不可用原因常驻", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ task: () => response(task({ executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" } })),
      reviews: () => response({ items: [] }) }));
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(60);
    expect(view.wrapper.get('[data-testid="delegate-config-body"]').attributes("hidden")).toBeDefined();
    expect(view.wrapper.get('[data-testid="task-delegate-panel"]').text()).toContain("只有 READY 的任务可委托。");
    await view.wrapper.get('[data-testid="delegate-config-toggle"]').trigger("click");
    await view.wrapper.get('[data-testid="task-mock-action-toggle"]').setValue(true); await flush(30);
    await view.wrapper.get('[data-testid="task-mock-content"]').setValue("折叠后保留的配置");
    await view.wrapper.get('[data-testid="delegate-config-toggle"]').trigger("click");
    expect(view.wrapper.get('[data-testid="delegate-config-body"]').attributes("hidden")).toBeDefined();
    await view.wrapper.get('[data-testid="delegate-config-toggle"]').trigger("click");
    expect((view.wrapper.get('[data-testid="task-mock-content"]').element as HTMLTextAreaElement).value).toBe("折叠后保留的配置");
    view.unmount();
  });

  it("协作委托结果未知时不能折叠原命令核对入口或重复提交", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let commandId = ""; let posts = 0;
    const read = router({ task: () => response(task({ status: "READY", allowed_actions: ["START"],
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" } })), reviews: () => response({ items: [] }) });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (new URL(String(input)).pathname === `${prefix}/tasks/${taskId}/delegations` && init?.method === "POST") {
        posts++; commandId = (JSON.parse(String(init.body)) as { command_id: string }).command_id;
        throw new TypeError("connection lost after submission");
      }
      return read(input, init);
    }));
    const view = await mountWorkbench(`/agent?work=${taskId}`); await flush(60);
    await view.wrapper.get('[data-testid="delegate-config-toggle"]').trigger("click");
    await view.wrapper.get('[data-testid="task-delegate"]').trigger("click"); await flush(30);
    expect(view.wrapper.get('[data-testid="delegate-config-body"]').attributes("hidden")).toBeUndefined();
    expect(view.wrapper.get('[data-testid="delegate-config-toggle"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="delegate-command-id"]').text()).toContain(commandId);
    expect(view.wrapper.find('[data-testid="delegate-check-receipt"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="delegate-config-toggle"]').trigger("click");
    expect(view.wrapper.get('[data-testid="delegate-config-body"]').attributes("hidden")).toBeUndefined();
    expect(view.wrapper.find('[data-testid="task-delegate"]').exists()).toBe(false);
    expect(posts).toBe(1);
    view.unmount();
  });

  it("正文失败结束加载且不自动重试，保留确切版本并可显式重读", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    let available = false;
    const content = vi.fn(() => available ? response("# 重试后读到的正文")
      : response({ code: "EVIDENCE_UNAVAILABLE", detail: "Immutable content unavailable" }, 503));
    vi.stubGlobal("fetch", router({ content }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await flush(80);
    const reader = view.wrapper.get('[data-testid="collab-artifact-reader"]');
    expect(reader.text()).not.toContain("完成被拒绝");
    expect(reader.text()).not.toContain("正在读取当前版本正文");
    expect(reader.text()).toContain("评价方案.md");
    expect(reader.attributes("data-document-state")).toBe("error");
    expect(content).toHaveBeenCalledTimes(1);
    available = true;
    await view.wrapper.get('[data-testid="collab-read-retry"]').trigger("click");
    await flush(40);
    expect(content).toHaveBeenCalledTimes(2);
    expect(view.wrapper.get('[data-testid="collab-reading"]').text()).toContain("重试后读到的正文");
    expect(view.wrapper.find('[data-testid="collab-read-error"]').exists()).toBe(false);
    view.unmount();
  });

  it("迟到正文不能覆盖用户刚选定的其他确切版本", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const olderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let resolveLatest!: (value: Response) => void;
    const latestContent = new Promise<Response>((resolve) => { resolveLatest = resolve; });
    const versions = artifacts();
    versions.items[0]!.versions.push({ ...versions.items[0]!.versions[0]!, artifact_version_id: olderId, version_number: "1" });
    vi.stubGlobal("fetch", router({ artifacts: () => response(versions),
      content: (id) => id === versionId ? latestContent : response("# 用户选择的 v1 正文") }));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await flush(50);
    await view.wrapper.get('[data-testid="collab-compare-base"]').setValue(olderId);
    expect(view.wrapper.get('[data-testid="collab-compare-open"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get(`[data-testid="collab-read-${olderId}"]`).trigger("click");
    await flush(30);
    resolveLatest(response("# 迟到的 v2 正文"));
    await flush(30);
    expect(view.wrapper.get('[data-testid="collab-reading"]').text()).toContain("用户选择的 v1 正文");
    expect(view.wrapper.get('[data-testid="collab-artifact-reader"]').text()).not.toContain("迟到的 v2 正文");
    view.unmount();
  });

  it("局部读取失败只影响该区域；普通查询失败不渲染成无数据或外部 UNKNOWN", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ artifacts: () => response({ code: "DATABASE_UNAVAILABLE",
      detail: "database is down", retryable: true }, 503) }));
    const view = await mountWorkbench("/agent");
    await flush(60);
 await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    expect(view.wrapper.get('[data-testid="collab-artifact-error"]').text()).toContain("重新读取产物");
    // 目标、执行事实与判断仍可读；失败不被渲染成"没有产物"
    expect(view.wrapper.get('[data-testid="collab-goal"]').text()).toContain("确定实验评价指标");
    expect(view.wrapper.get('[data-testid="collab-judgment"]').text()).toContain("等待你的判断");
    // 执行事实收在右栏检查页签，读取失败不吞掉它。
    await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
    await flush(40);
    expect(view.wrapper.get('[data-testid="collab-run-progress"]').text()).toContain("执行进展");
    expect(view.wrapper.text()).not.toContain("该任务还没有已保存的产物版本。");
    view.unmount();
  });

  it("执行失败保留可读成果并说明重试走新 Run；外部 UNKNOWN 沿原动作核对", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ run: () => response(run("FAILED", { unresolved_operation_ids: ["op-9"] })) }));
    const view = await mountWorkbench("/agent");
    await flush(60);
    await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    // 外部结果待核对持续显示在事实条，不收进普通日志。
    expect(view.wrapper.get('[data-testid="collab-facts"]').text()).toContain("外部结果待核对");
    expect(view.wrapper.get('[data-testid="collab-facts"]').text()).toContain("沿原 operation_id 核对");
    await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
    await flush(40);
    const progress = view.wrapper.get('[data-testid="collab-run-progress"]').text();
    expect(progress).toContain("失败");
    expect(progress).toContain("op-9");
    expect(progress).toContain("先按原 operation_id 核对，不盲重试、不换身份");
    await view.wrapper.get('[data-testid="collab-side-tab-DOCUMENT"]').trigger("click");
    await flush(40);
    expect(view.wrapper.get('[data-testid="collab-artifact-reader"]').text()).toContain("评价方案.md");
    view.unmount();
  });

  it("切换工作保护未提交输入；迟到响应不注入新目标", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const otherTaskId = "99999999-9999-4999-8999-999999999999";
    const otherSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let releaseOld: ((value: Response) => void) | undefined;
    const mocked = router({});
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/tasks/${otherTaskId}`) return response(task({ id: otherTaskId, title: "另一项工作" }));
      if (path === `${prefix}/tasks/${otherTaskId}/artifacts`) return response({ items: [], current_accepted_version_ids: [] });
      if (path === `${prefix}/tasks`) {
        return response({ items: [task(), task({ id: otherTaskId, title: "另一项工作", status: "READY",
          executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, allowed_actions: ["START"] })], next_cursor: null });
      }
      if (path === `${prefix}/assist-sessions`) {
        return response({ items: [
          { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
            title: "关于确定实验评价指标", status: "ACTIVE", revision: "1", updated_at: "2026-09-29T03:40:00Z" },
          { id: otherSessionId, workspace_id: workspaceId, project_id: projectId, task_id: otherTaskId,
            title: "关于另一项工作", status: "ACTIVE", revision: "1", updated_at: "2026-09-29T03:30:00Z" }
        ] });
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (path === `${prefix}/assist-sessions/${otherSessionId}/messages`) return response({ items: [] });
      return mocked(input, init);
    }));
    const view = await mountWorkbench("/agent");
    await flush(60);
    await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("未发送的草稿");
    expect(releaseOld).not.toBeUndefined();

    await view.wrapper.get(`[data-testid="recent-work-${otherTaskId}"]`).trigger("click");
    await flush();
    // 左栏切换工作走全局未提交修改保护；对话未发送内容不会静默丢失。
    expect(dialogText()).toContain("保留未保存的修改");
    await new DomWrapper(document.querySelector('[data-testid="discard-draft-leave"]')).trigger("click");
    await flush(80);
    expect(view.wrapper.get('[data-testid="collab-goal"]').text()).toContain("另一项工作");
    releaseOld?.(response({ items: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", session_id: sessionId, seq: "1", role: "USER", status: "COMPLETED",
      intent: "DISCUSS", content: "旧目标的消息", error_code: null, sources: [],
      usage: { input_tokens: null, output_tokens: null }, cancel_requested: false }] }));
    await flush(60);
    expect(view.wrapper.text()).not.toContain("旧目标的消息");
    view.unmount();
  });

  it("无模型时的人工路径仍可达：产物、完成与判断入口不依赖生成", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({ reviews: () => response({ items: [] }) }));
    const view = await mountWorkbench("/agent");
    await flush(60);
 await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    expect(view.wrapper.get('[data-testid="collab-judgment-empty"]').text()).toContain("暂无待判断事项");
    expect(view.wrapper.find('[data-testid="review-decision-ACCEPT"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="task-completion"]').text()).toContain("完成是一次短事务");
    expect(view.wrapper.get('[data-testid="criterion-c1"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="task-complete"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.get('[data-testid="task-complete-reason"]').text()).toContain("服务端未投影 COMPLETE");
    expect(view.wrapper.find('a[href="/projects"]').exists()).toBe(true);
    expect(view.wrapper.find('a[href="/tasks"]').exists()).toBe(true);
    expect(view.wrapper.find('a[href="/knowledge"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="command-open"]').exists()).toBe(true);
    view.unmount();
  });

  it("右栏三页签共享同一任务；切换页签不改变 Run 或业务对象", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({}));
    const view = await mountWorkbench("/agent");
    await flush(60);
    await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    expect(view.wrapper.get(".collab-columns").attributes("data-pane")).toBe("DOCUMENT");
    expect(view.wrapper.get('[data-testid="collab-panel-DOCUMENT"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="collab-side-tab-CHECK"]').trigger("click");
    expect(view.wrapper.get(".collab-columns").attributes("data-pane")).toBe("CHECK");
    expect(view.wrapper.get('[data-testid="collab-panel-CHECK"]').text()).toContain("执行进展");
    expect(view.wrapper.get('[data-testid="run-trace"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="collab-side-tab-HISTORY"]').trigger("click");
    expect(view.wrapper.get(".collab-columns").attributes("data-pane")).toBe("HISTORY");
    expect(view.wrapper.get('[data-testid="collab-history-select"]').exists()).toBe(true);
    // 视图切换不改变 Run 或业务对象
    expect(view.wrapper.get('[data-testid="collab-goal"]').text()).toContain("确定实验评价指标");
    expect(view.wrapper.get('[data-testid="collab-facts"]').text()).toContain("等待人工判断");
    view.unmount();
  });

  it("选中工作写入 URL，刷新与深链接恢复同一任务", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({}));
    const view = await mountWorkbench("/agent");
    await flush(60);
    await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    expect(view.router.currentRoute.value.path).toBe("/agent");
    expect(view.router.currentRoute.value.query.work).toBe(taskId);
    expect(view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).attributes("aria-current")).toBe("true");
    view.unmount();

    // 直接带 ?work= 打开：不必先经过左栏点击，也不新建任何对象。
    const deep = await mountWorkbench(`/agent?work=${taskId}`);
    await flush(80);
    expect(deep.wrapper.get('[data-testid="collab-goal"]').text()).toContain("确定实验评价指标");
    const posts = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit | undefined][] } })
      .mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(0);
    deep.unmount();
  });

  it("Run 失败原因原样显示，不推断也不吞掉", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", router({
      run: () => response(run("FAILED", { wait_reason: null, current_step_id: "step-2",
        result_refs: [{ step_kind: "DRAFT", result_ref: { reason: "MODEL_BUDGET_EXHAUSTED" } }] })),
      reviews: () => response({ items: [] })
    }));
    const view = await mountWorkbench("/agent");
    await flush(60);
    await view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).trigger("click");
    await flush(80);
    expect(view.wrapper.get('[data-testid="collab-facts"]').text()).toContain("失败原因：MODEL_BUDGET_EXHAUSTED");
    view.unmount();
  });
});
