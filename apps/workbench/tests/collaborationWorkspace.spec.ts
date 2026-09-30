import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, dialogText, flush, mountWorkbench } from "./mountApp";

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
  draft?: () => Response;
  operations?: () => Response;
  workspaceTasks?: () => Response;
  messages?: () => Response | Promise<Response>;
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
    if (path.includes("/artifact-versions/") && path.endsWith("/content")) return json("# 评价方案\n\n正文。");
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
    if (path === `${prefix}/assist-sessions`) return json({ items: [{ id: sessionId, workspace_id: workspaceId,
      project_id: projectId, task_id: taskId, title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
      updated_at: "2026-09-29T03:40:00Z" }] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return routes.messages?.() ?? json({ items: [] });
    if (path === `${prefix}/assist-proposals`) return json({ items: [] });
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

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("协作工作区主路径", () => {
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
    expect(bound).toContain(versionId); expect(bound).toContain("验收版本2"); expect(bound).toContain("验收条件 IDc1");
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

  it("窄窗视图切换保留讨论草稿，返回讨论会关闭工具展示，不提交业务命令", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const fetchMock = router({});
    vi.stubGlobal("fetch", fetchMock);
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    await flush(80);
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("保留这段未发送的讨论");
    await view.wrapper.get('[data-testid="collab-narrow-DOCUMENT"]').trigger("click");
    expect(view.wrapper.get(".collab-columns").attributes("data-narrow-side")).toBe("open");
    await view.wrapper.get('[data-testid="collab-narrow-CHECK"]').trigger("click");
    expect(view.wrapper.get('[data-testid="collab-panel-CHECK"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="collab-devtools-toggle"]').trigger("click");
    await flush(40);
    expect(view.wrapper.get('[data-testid="devtools-panel"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="collab-narrow-DISCUSSION"]').trigger("click");
    expect(view.wrapper.get(".collab-columns").attributes("data-narrow-side")).toBe("closed");
    expect(view.wrapper.find('[data-testid="devtools-panel"]').exists()).toBe(false);
    expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
      .toBe("保留这段未发送的讨论");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    view.unmount();
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
    expect(view.wrapper.get('[data-testid="recent-work"]').text()).toContain("全部任务 · 按最近变更排序");
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
    expect(view.wrapper.get('[data-testid="collab-judgment-empty"]').text()).toContain("不制造待办");
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
