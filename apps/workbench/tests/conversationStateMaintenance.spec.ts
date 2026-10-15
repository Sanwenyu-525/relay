import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 自然语言状态维护（总纲 §0.8.1）的前端组件证据：明确维护指令在项目绑定的普通档会话里
 * 随 user 消息发送自动解释、自动生效（无确认门、无「接受」按钮）；带待决承诺只显示影响与问题；
 * DISCUSS 静默；已生效整组两步撤回；助手档零解释请求；迟到响应不回写新会话。
 * 这里只断言客户端行为（请求来源、命令身份、回执呈现），桩数据只是组件证据，
 * 不替代真实 API 与真实 Windows 取证。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const otherSessionId = "88888888-8888-4888-8888-888888888888";
const requestId = "abababab-abab-4bab-8bab-abababababab";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const reviewId = "77777777-7777-4777-8777-777777777777";
const profileId = "99999999-9999-4999-8999-999999999999";
const changeCommandId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const undoCommandId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
}

function project() {
  return { id: projectId, title: "人机协作工作流研究", project_type: "GENERAL", revision: "1",
    state_revision: "1", archived_at: null };
}

function task() {
  return { id: taskId, project_id: projectId, title: "确定实验评价指标", status: "IN_PROGRESS", mode: "ME",
    revision: "2", created_at: "2026-09-28T02:00:00Z", updated_at: "2026-09-29T03:42:00Z",
    executor: { kind: "AI", run_id: runId, ownership_epoch: "1" }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    acceptance: { acceptance_revision: "2", objective: "补齐基线、评价方法与可复核的验收依据。", source: "CREATE",
      created_at: "2026-09-28T02:00:00Z", criteria: [
        { criterion_id: "c1", statement: "指标定义明确", required: true, method: "HUMAN_REVIEW", target_spec: {} }
      ] },
    dependencies: [] };
}

function run() {
  return { id: runId, task_id: taskId, status: "RUNNING", revision: "4", wait_reason: null,
    current_step_id: "step-2", steps: [
      { step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED",
        started_at: "2026-09-29T03:00:00Z", finished_at: "2026-09-29T03:01:00Z" },
      { step_id: "step-2", step_index: 1, step_kind: "DRAFT", status: "RUNNING",
        started_at: "2026-09-29T03:10:00Z", finished_at: null }
    ], recent_attempts: [], blocking_review_ids: [], pending_control_request: null,
    unresolved_operation_ids: [] };
}

function session(over: Record<string, unknown> = {}, id = sessionId) {
  return { id, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
    updated_at: "2026-09-29T03:40:00Z", ...over };
}

function assistantSession() {
  return session({ conversation_mode: "ASSISTANT", assistant_profile_id: profileId,
    assistant_profile_revision: "1", assistant_role: { name: "研究助手" } });
}

function userMessage(sessionIdForMessage = sessionId) {
  return { id: "msg-1", session_id: sessionIdForMessage, seq: "1", role: "USER", status: "COMPLETED",
    intent: "DISCUSS", content: "把项目状态标记为：实验阶段，下一步是补齐基线", sources: [],
    cancel_requested: false, error_code: null, provider_error_kind: null,
    created_at: "2026-09-29T03:40:00Z", updated_at: "2026-09-29T03:40:00Z",
    usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
    skill: null };
}

function stateProjection(over: Record<string, unknown> = {}) {
  return { request_id: requestId, session_id: sessionId, source_message_id: "msg-1",
    project_id: projectId, decision: "MAINTAIN", status: "READY", candidate_status: "READY",
    questions: [], changes: null, decision_required: null, undo_command_id: undoCommandId,
    revision: "1", created_at: "2026-09-29T03:40:00Z", updated_at: "2026-09-29T03:40:00Z", ...over };
}

function stateChange(over: Record<string, unknown> = {}) {
  return { ordinal: 0, change_kind: "CREATE_TASK", command_id: changeCommandId,
    status: "PENDING", before_ref: null, after_ref: null, error: null, ...over };
}

/** 撤回事前预检方案：SET_PHASE 可撤、CREATE_GOAL 没有撤销入口（服务端只读投影）。 */
function undoPlanFixture(over: Record<string, unknown> = {}) {
  return { request_id: requestId, undo_command_id: undoCommandId,
    plan_digest: "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
    fully_withdrawable: false, blocked_count: 1, state_revision: "2",
    items: [
      { change_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ordinal: 1,
        change_kind: "CREATE_GOAL", command_id: changeCommandId,
        action: { type: "UNDO_ENTRY_MISSING", missing_kind: "CREATE_GOAL" },
        withdrawable: false, reason_code: "UNDO_ENTRY_MISSING",
        reason: "CREATE_GOAL 没有既有撤销入口",
        impact: "CREATE_GOAL 创建的事实会保留在项目中；不造删除入口，也不假装已撤销。",
        facts: {} },
      { change_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", ordinal: 0,
        change_kind: "SET_PHASE", command_id: undoCommandId,
        action: { type: "SET_PHASE", phase: "DISCOVERY" },
        withdrawable: true, reason_code: null, reason: null, impact: null, facts: {} },
    ], ...over };
}

interface Routes {
  stateMaintenance?: (body: Record<string, unknown>) => Response;
  /** 受控迟到：状态维护解释 POST 返回一个由用例手动 resolve 的承诺。 */
  gateStateMaintenance?: () => Response | Promise<Response>;
  applyState?: () => Response;
  withdrawState?: (body: Record<string, unknown>) => Response;
  decisionReply?: (body: Record<string, unknown>) => Response;
  undoPlan?: () => Response;
  stateItems?: (sessionIdFromQuery: string) => Response;
  sessions?: () => Response;
  messages?: () => Response | Promise<Response>;
}

function router(routes: Routes, posts: { path: string; body: unknown }[]) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (body: unknown, status = 200) => response(body, status);
    const envelope = (result: unknown, status: number, commandId: string) =>
      json({ command_id: commandId, committed_at: "2026-09-29T03:41:00Z", result,
        links: { resource: "" } }, status);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      const messageMatch = /\/assist-sessions\/([^/]+)\/messages$/u.exec(path);
      if (messageMatch) {
        return envelope({ session_id: messageMatch[1], user_message_id: "msg-1",
          assistant_message_id: "msg-2" }, 202, String(body.command_id));
      }
      const executionMatch = /\/assist-sessions\/([^/]+)\/execution-requests$/u.exec(path);
      if (executionMatch) {
        return envelope({ request_id: requestId, session_id: executionMatch[1],
          source_message_id: "msg-1", resource_id: "res-1", root_path: "D:\\repo", decision: "DISCUSS",
          status: "DISCUSSED", candidate_status: "UNAVAILABLE", questions: [], candidate: null,
          task_id: null, run_id: null, revision: "1" }, 202, String(body.command_id));
      }
      const maintenanceMatch = /\/assist-sessions\/([^/]+)\/state-maintenance-requests$/u.exec(path);
      if (maintenanceMatch) {
        if (routes.gateStateMaintenance) return routes.gateStateMaintenance();
        return routes.stateMaintenance?.(body) ??
          envelope(stateProjection(), 202, String(body.command_id));
      }
      if (path === `${prefix}/conversation-state-requests/${requestId}/applications`) {
        return routes.applyState?.() ??
          envelope({ request_id: requestId, status: "APPLIED", revision: "2",
            undo_command_id: undoCommandId,
            changes: [stateChange({ status: "APPLIED",
              after_ref: { kind: "task", id: "task-new", title: "补齐基线" } })] }, 200, "apply-fixed");
      }
      if (path === `${prefix}/conversation-state-requests/${requestId}/decision-replies`) {
        return routes.decisionReply?.(body) ?? envelope({ request_id: requestId,
          status: "READY", revision: "5", undo_command_id: undoCommandId,
          changes: [stateChange({ status: "PENDING" })] }, 200, String(body.command_id));
      }
      if (path === `${prefix}/conversation-state-requests/${requestId}/withdrawals`) {
        return routes.withdrawState?.(body) ??
          envelope({ request_id: requestId, status: "UNDONE", revision: "3",
            undo_command_id: undoCommandId,
            changes: [stateChange({ status: "COMPENSATED" })] }, 200, String(body.command_id));
      }
      throw new Error(`unexpected POST ${path}`);
    }
    const receipt = /\/commands\/([^/]+)$/u.exec(path);
    if (receipt) return json({ code: "NOT_FOUND", detail: "命令回执不存在" }, 404);
    if (path === `${prefix}/projects`) return json({ items: [{ ...project(), archive_status: "ACTIVE",
      phase_key: "GENERAL", next_action_task_id: null, created_at: "2026-09-28T01:00:00Z",
      updated_at: "2026-09-29T03:42:00Z" }], next_cursor: null });
    if (path === `${prefix}/projects/${projectId}`) return json(project());
    if (path === `${prefix}/projects/${projectId}/state`) return json({ project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/tasks`) return json({ items: [], next_cursor: null });
    if (path === `${prefix}/tasks/${taskId}`) return json(task());
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return json({ items: [], current_accepted_version_ids: [] });
    if (path === `${prefix}/runs/${runId}`) return json(run());
    if (path === `${prefix}/runs/${runId}/draft-preview`) return json({ run_id: runId,
      run_status: "RUNNING", preview_available: false, preview_text: null, preview_revision: "0",
      preview_truncated: false, step_attempt_id: null, attempt_claim_epoch: null,
      model_call_id: null });
    if (path === `${prefix}/runs/${runId}/operations`) return json([]);
    if (path === `${prefix}/runs/${runId}/tool-calls`) return json({ run_id: runId,
      run_status: "RUNNING", wait_reason: null, rounds: [] });
    if (path.startsWith(`${prefix}/runs/${runId}/events`)) {
      return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
        body: null } as unknown as Response;
    }
    if (path === `${prefix}/reviews`) return json({ items: [] });
    if (path === `${prefix}/reviews/${reviewId}`) return json({ id: reviewId, kind: "CRITERION",
      status: "OPEN", revision: "3" });
    if (path === `${prefix}/assist-sessions`) {
      return routes.sessions?.() ?? json({ items: [session()] });
    }
    const messagesMatch = /\/assist-sessions\/([^/]+)\/messages$/u.exec(path);
    if (messagesMatch) {
      return routes.messages?.() ?? json({ items: [userMessage(messagesMatch[1])] });
    }
    if (path === `${prefix}/assist-proposals`) return json({ items: [] });
    if (path === `${prefix}/skill-definitions`) return json({ items: [] });
    if (path === `${prefix}/assistant-profiles`) return json({ items: [
      { id: profileId, name: "研究助手", role_description: "只读回答研究问题", tone: null,
        read_scope: {}, status: "ACTIVE", revision: "1" }] });
    if (path === `${prefix}/conversation-execution-requests`) return json({ items: [] });
    if (path === `${prefix}/conversation-state-requests`) {
      const fromQuery = url.searchParams.get("session_id") ?? "";
      return routes.stateItems?.(fromQuery) ?? json({ items: [] });
    }
    if (path === `${prefix}/conversation-state-requests/${requestId}/undo-plan`) {
      return routes.undoPlan?.() ?? json(undoPlanFixture());
    }
    if (path === `${prefix}/model-port`) return json({ provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return json({ current_config_fingerprint: null,
      last: null, matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/projects/${projectId}/managed-resources`)) return json([]);
    if (path.startsWith(`${prefix}/projects/${projectId}/connections`)) return json([]);
    if (path.startsWith(`${prefix}/search`)) return json({ items: [], next_cursor: null });
    throw new Error(`unexpected request GET ${path}`);
  });
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("对话状态维护回执", () => {
  it("MAINTAIN 明确指令自动生效：逐条「已生效」摘要与展开内容，全程没有「接受」按钮", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({}, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("把项目状态标记为：实验阶段");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      // 解释命令只带原消息身份与本机时区，不带 resource_id：状态维护不依赖目录作用域。
      const statePost = posts.find((post) => post.path.endsWith("/state-maintenance-requests"));
      expect(statePost).toBeDefined();
      const stateBody = statePost!.body as { command_id: string; source_message_id: string;
        timezone?: unknown };
      expect(statePost?.body).toEqual({ command_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        source_message_id: "msg-1",
        ...(typeof stateBody.timezone === "string" ? { timezone: stateBody.timezone } : {}) });
      // 明确指令自动沿 applications 生效：未点击任何按钮。
      const applyPost = posts.find((post) => post.path.endsWith("/applications"));
      expect(applyPost).toBeDefined();
      expect(applyPost?.body).toEqual({});
      // 执行解释链没有目录作用域时不触发；两条解释链互不冒充。
      expect(posts.some((post) => post.path.endsWith("/execution-requests"))).toBe(false);

      const receipt = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(receipt.attributes("data-status")).toBe("APPLIED");
      expect(receipt.text()).toContain("新建任务");
      expect(receipt.text()).toContain("已全部生效");
      expect(receipt.text()).toContain("可整组撤回本次调整");
      // 展开区：逐条结算与命令身份在 DOM 中可核对。
      const item = view.wrapper.get('[data-testid="state-maintenance-item-0"]');
      expect(item.text()).toContain("已生效");
      expect(item.text()).toContain("补齐基线");
      expect(item.text()).toContain(changeCommandId);
      // 明确指令不再要求填表或点击接受：回执里没有「接受」入口。
      expect(receipt.text()).not.toContain("接受");
      expect(view.wrapper.find('[data-testid="state-maintenance-decision"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("PARTIAL 折叠态可见失败条数与原因；失败行不在 details 展开区里", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ applyState: () => response({ command_id: "apply-fixed",
      committed_at: "2026-09-29T03:41:00Z", result: { request_id: requestId, status: "PARTIAL",
        revision: "2", undo_command_id: undoCommandId, changes: [
          stateChange({ ordinal: 0, status: "APPLIED", after_ref: { kind: "phase", value: "实验" } }),
          stateChange({ ordinal: 1, change_kind: "SET_NEXT_ACTION", status: "FAILED",
            error: { code: "VALIDATION_FAILED", detail: "缺少下一步内容" } })
        ] }, links: { resource: "" } }, 200) }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("标记实验阶段并设置下一步");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      const receipt = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(receipt.attributes("data-status")).toBe("PARTIAL");
      // 从未展开 details：失败计数与原因必须已经在折叠态可见。
      expect(receipt.text()).toContain("已生效 1 条 · 失败 1 条");
      const failure = view.wrapper.get('[data-testid="state-maintenance-failure-1"]');
      expect(failure.text()).toContain("设置下一步");
      expect(failure.text()).toContain("缺少下一步内容");
      expect(failure.element?.closest("details") ?? null).toBeNull();
      // 生效的条目同样如实呈现。
      expect(receipt.text()).toContain("已生效 1 条");
      expect(view.wrapper.get('[data-testid="state-maintenance-item-0"]').text()).toContain("已生效");
      // 部分生效仍可整组撤回。
      expect(view.wrapper.get('[data-testid="state-maintenance-withdraw"]').exists()).toBe(true);
    } finally { view.unmount(); }
  });

  it("DECISION_REQUIRED 显示影响与具体问题：不自动应用，只提供一句话续答入口", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ stateMaintenance: (body) => response({ command_id: body.command_id,
      committed_at: "2026-09-29T03:41:00Z", result: stateProjection({ status: "DECISION_REQUIRED",
        decision_required: { summary: "会新建一个任务并把阶段改为实验", question: "任务标题用哪个？",
          affected: ["tasks", "project_states"] } }), links: { resource: "" } }, 202) }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("新建任务推进实验阶段");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      // 解释发生了，但带待决承诺的请求没有任何应用调用。
      expect(posts.some((post) => post.path.endsWith("/state-maintenance-requests"))).toBe(true);
      expect(posts.some((post) => post.path.endsWith("/applications"))).toBe(false);
      const decision = view.wrapper.get('[data-testid="state-maintenance-decision"]');
      expect(decision.text()).toContain("会新建一个任务并把阶段改为实验");
      expect(decision.text()).toContain("任务标题用哪个？");
      expect(decision.text()).toContain("涉及：tasks、project_states");
      // 没有待生效状态，也就没有撤回入口。
      expect(view.wrapper.find('[data-testid="state-maintenance-withdraw"]').exists()).toBe(false);
      // 没有「自动回答」：回答由用户输入，空回答时提交入口不可用。
      const answerBox = view.wrapper.get('[data-testid="state-maintenance-decision-input"]');
      expect(answerBox.exists()).toBe(true);
      expect(view.wrapper.get('[data-testid="state-maintenance-decision-accept"]')
        .attributes("disabled")).toBeDefined();
      expect(posts.some((post) => post.path.endsWith("/decision-replies"))).toBe(false);
    } finally { view.unmount(); }
  });

  it("DISCUSS 静默：解释完成后不渲染任何回执", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ stateMaintenance: (body) => response({ command_id: body.command_id,
      committed_at: "2026-09-29T03:41:00Z", result: stateProjection({ decision: "DISCUSS",
        status: "DISCUSSED", candidate_status: "UNAVAILABLE" }),
      links: { resource: "" } }, 202) }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("先聊聊评价指标怎么定");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      expect(posts.some((post) => post.path.endsWith("/state-maintenance-requests"))).toBe(true);
      // 正向守卫：解释成功落为 DISCUSS，而不是解释失败。
      expect(view.wrapper.find('[data-testid="state-maintenance-failed"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-receipt"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-pending"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-decision"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("撤回是两次点击：先内联展开清单，确认后才 POST；UNDO_PARTIAL 逐条呈现且失败条目保留", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({
      stateItems: () => response({ items: [stateProjection({ status: "APPLIED",
        changes: [stateChange({ ordinal: 0, status: "APPLIED", after_ref: { kind: "phase", value: "实验" } }),
          stateChange({ ordinal: 1, change_kind: "SET_PHASE", status: "APPLIED",
            after_ref: { kind: "phase", value: "实验" } })] })] }),
      withdrawState: (body) => response({ command_id: body.command_id,
        committed_at: "2026-09-29T03:42:00Z", result: { request_id: requestId, status: "UNDO_PARTIAL",
          revision: "3", undo_command_id: undoCommandId, changes: [
            stateChange({ ordinal: 0, status: "COMPENSATED" }),
            stateChange({ ordinal: 1, change_kind: "SET_PHASE", status: "COMPENSATION_FAILED",
              error: { code: "UNDO_BLOCKED", detail: "该阶段已有后续记录" } })
          ] }, links: { resource: "" } }, 200) }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await flush();
      // 既有已生效回执直接出现在原 user 消息下。
      const receipt = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(receipt.attributes("data-status")).toBe("APPLIED");

      // 第一次点击只展开确认清单，不发生任何撤回命令。
      await view.wrapper.get('[data-testid="state-maintenance-withdraw"]').trigger("click");
      await flush();
      const confirm = view.wrapper.get('[data-testid="state-maintenance-undo-confirm"]');
      expect(confirm.text()).toContain("将撤回：2 条变更");
      expect(confirm.text()).toContain("已推进的部分可能撤回失败并逐条显示");
      expect(posts.some((post) => post.path.endsWith("/withdrawals"))).toBe(false);

      // 先不撤回可以退出；再次点击才进入确认。
      await view.wrapper.get('[data-testid="state-maintenance-undo-cancel"]').trigger("click");
      await flush();
      expect(view.wrapper.find('[data-testid="state-maintenance-undo-confirm"]').exists()).toBe(false);
      await view.wrapper.get('[data-testid="state-maintenance-withdraw"]').trigger("click");
      await flush();

      // 第二次点击确认才真正 POST；命令身份是请求行固化的 undo_command_id，不是新造命令。
      await view.wrapper.get('[data-testid="state-maintenance-withdraw-confirm"]').trigger("click");
      await flush(); await flush();
      const withdrawPost = posts.find((post) => post.path.endsWith("/withdrawals"));
      expect(withdrawPost).toBeDefined();
      expect((withdrawPost?.body as { command_id?: string }).command_id).toBe(undoCommandId);

      const undone = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(undone.attributes("data-status")).toBe("UNDO_PARTIAL");
      expect(undone.text()).toContain("已撤回 1 条 · 撤回失败 1 条");
      // 失败条目保留可见，不在 details 里。
      const failure = view.wrapper.get('[data-testid="state-maintenance-failure-1"]');
      expect(failure.text()).toContain("撤回失败");
      expect(failure.text()).toContain("该阶段已有后续记录");
      expect(failure.element?.closest("details") ?? null).toBeNull();
      // 逐条明细：已撤回与撤回失败各占一行。
      expect(view.wrapper.get('[data-testid="state-maintenance-item-0"]').text()).toContain("已撤回");
      expect(view.wrapper.get('[data-testid="state-maintenance-item-1"]').text()).toContain("撤回失败");
      // 撤回后的状态收敛：不再提供第二个撤回入口。
      expect(view.wrapper.find('[data-testid="state-maintenance-withdraw"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-undo-confirm"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("整组有不可撤回项：服务端一项都不执行，展示具体方案后按勾选范围撤回", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let withdrawCalls = 0;
    vi.stubGlobal("fetch", router({
      stateItems: () => response({ items: [stateProjection({ status: "APPLIED",
        changes: [stateChange({ ordinal: 0, change_kind: "SET_PHASE", status: "APPLIED",
            after_ref: { phase: "IMPLEMENTATION", state_revision: "1" } }),
          stateChange({ ordinal: 1, change_kind: "CREATE_GOAL", status: "APPLIED",
            after_ref: { goal_id: projectId } })] })] }),
      withdrawState: (body) => {
        withdrawCalls += 1;
        if (withdrawCalls === 1) {
          // 事前预检发现不可撤回项：服务端拒绝并明确「没有执行任何补偿」。
          return response({ code: "UNDO_SCOPE_REQUIRED",
            detail: "原范围中有 1 项不能按原样撤回；没有执行任何补偿。" }, 409);
        }
        return response({ command_id: body.command_id,
          committed_at: "2026-09-29T03:42:00Z", result: { request_id: requestId,
            status: "UNDO_PARTIAL", revision: "3", undo_command_id: undoCommandId, changes: [
              stateChange({ ordinal: 0, change_kind: "SET_PHASE", status: "COMPENSATED" }),
              stateChange({ ordinal: 1, change_kind: "CREATE_GOAL", status: "APPLIED" }),
            ] }, links: { resource: "" } }, 200);
      },
    }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await flush();
      await view.wrapper.get('[data-testid="state-maintenance-withdraw"]').trigger("click");
      await flush();
      await view.wrapper.get('[data-testid="state-maintenance-withdraw-confirm"]').trigger("click");
      await flush(); await flush();

      // 方案面板：不可撤回项的原因与影响都可见，且明确「没有执行任何补偿」。
      const plan = view.wrapper.get('[data-testid="state-maintenance-undo-plan"]');
      expect(plan.exists()).toBe(true);
      expect(plan.text()).toContain("不能按原样撤回");
      expect(plan.text()).toContain("CREATE_GOAL 没有既有撤销入口");
      expect(plan.text()).toContain("会保留在项目中");
      // 方案面板本身只能来自 GET .../undo-plan（客户端不本地编造方案）。
      // 方案读回来之前/没勾范围时，提交入口不可用。
      expect(view.wrapper.get('[data-testid="state-maintenance-withdraw-scope"]')
        .attributes("disabled")).toBeDefined();

      // 通用「确认整组撤回」此时已不再出现：不能用它自动授权后来缩小的方案。
      expect(view.wrapper.find('[data-testid="state-maintenance-withdraw-confirm"]').exists()).toBe(false);

      // 勾选具体范围后提交：载荷必须带 plan_digest 与确认的 change_id。
      await view.wrapper.get('[data-testid="undo-plan-option-0"]').trigger("click");
      await flush();
      await view.wrapper.get('[data-testid="state-maintenance-withdraw-scope"]').trigger("click");
      await flush(); await flush();

      const withdrawPosts = posts.filter((post) => post.path.endsWith("/withdrawals"));
      expect(withdrawPosts).toHaveLength(2);
      const scoped = withdrawPosts[1]!.body as { command_id: string; plan_digest: string;
        confirmed_change_ids: string[] };
      expect(scoped.command_id).toBe(undoCommandId);
      expect(scoped.plan_digest).toBe(undoPlanFixture().plan_digest);
      expect(scoped.confirmed_change_ids).toEqual(["ffffffff-ffff-4fff-8fff-ffffffffffff"]);

      const undone = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(undone.attributes("data-status")).toBe("UNDO_PARTIAL");
      expect(undone.text()).toContain("已撤回 1 条");
      // 未确认范围内的事实保持生效，UI 不显示成「已整组撤回」。
      expect(undone.text()).not.toContain("已整组撤回");
      expect(view.wrapper.find('[data-testid="state-maintenance-undo-plan"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("与后续修改冲突：按冲突表达且保留当前事实，不显示「全部生效」", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({
      stateItems: () => response({ items: [stateProjection({ status: "FAILED",
        changes: [stateChange({ ordinal: 0, change_kind: "SET_PHASE", status: "FAILED",
          error: { code: "STATE_VERSION_CONFLICT",
            message: "确认时点的项目状态版本为 0，当前已是 1（阶段 RELEASE）；本次保留当前事实。" } })] })] }),
    }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await flush();
      const receipt = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(receipt.attributes("data-status")).toBe("FAILED");
      expect(receipt.text()).not.toContain("已全部生效");
      expect(receipt.text()).toContain("与后续修改冲突");
      const conflict = view.wrapper.get('[data-testid="state-maintenance-conflict-0"]');
      expect(conflict.exists()).toBe(true);
      expect(conflict.text()).toContain("本次没有覆盖当前事实");
      expect(conflict.text()).toContain("阶段 RELEASE");
      // 冲突行在折叠态可见，不在 details 展开区里。
      expect(conflict.element?.closest("details") ?? null).toBeNull();
    } finally { view.unmount(); }
  });

  it("一句话续答绑定展示版本，决定落库后自动继续原请求（§5 场景 3）", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let applied = 0;
    vi.stubGlobal("fetch", router({
      stateItems: () => response({ items: [stateProjection({ status: "DECISION_REQUIRED",
        decision_required: { summary: "本周发布依赖导出", question: "本周发布是否先不包含导出？",
          affected: ["本周发布"], blocked_changes: [1] },
        changes: [stateChange({ ordinal: 0, change_kind: "SET_NEXT_ACTION",
            status: "APPLIED", after_ref: { task_id: taskId } }),
          stateChange({ ordinal: 1, change_kind: "SET_PHASE", status: "PENDING" })] })] }),
      stateMaintenance: (body) => response({ command_id: body.command_id,
        committed_at: "2026-09-29T03:41:00Z",
        result: stateProjection({ status: "DECISION_REQUIRED",
          decision_required: { summary: "本周发布依赖导出",
            question: "本周发布是否先不包含导出？", affected: ["本周发布"],
            blocked_changes: [1] },
          changes: [stateChange({ ordinal: 0, change_kind: "SET_NEXT_ACTION",
              status: "APPLIED", after_ref: { task_id: taskId } }),
            stateChange({ ordinal: 1, change_kind: "SET_PHASE", status: "PENDING" })] }),
        links: { resource: "" } }, 202),
      decisionReply: (body) => response({ command_id: body.command_id,
        committed_at: "2026-09-29T03:43:00Z",
        result: { request_id: requestId, status: "READY", revision: "5",
          undo_command_id: undoCommandId,
          changes: [stateChange({ ordinal: 0, change_kind: "SET_NEXT_ACTION",
              status: "APPLIED", after_ref: { task_id: taskId } }),
            stateChange({ ordinal: 1, change_kind: "SET_PHASE", status: "PENDING" })] },
        links: { resource: "" } }, 200),
      applyState: () => { applied += 1;
        return response({ command_id: "apply-fixed", committed_at: "2026-09-29T03:44:00Z",
          result: { request_id: requestId, status: "APPLIED", revision: "6",
            undo_command_id: undoCommandId,
            changes: [stateChange({ ordinal: 0, change_kind: "SET_NEXT_ACTION",
                status: "APPLIED", after_ref: { task_id: taskId } }),
              stateChange({ ordinal: 1, change_kind: "SET_PHASE", status: "APPLIED",
                after_ref: { phase: "IMPLEMENTATION" } })] },
          links: { resource: "" } }, 200); },
    }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await flush(); await flush();
      // 只有一条被挡住的变更：独立修改已生效，绝不再发一次无效的整组应用。
      expect(posts.filter((post) => post.path.endsWith("/applications")).length).toBeLessThanOrEqual(1);
      const decision = view.wrapper.get('[data-testid="state-maintenance-decision"]');
      expect(decision.text()).toContain("本周发布是否先不包含导出？");

      await view.wrapper.get('[data-testid="state-maintenance-decision-input"]')
        .setValue("同意调整发布承诺");
      await flush();
      await view.wrapper.get('[data-testid="state-maintenance-decision-accept"]').trigger("click");
      await flush(); await flush();

      const replyPost = posts.find((post) => post.path.endsWith("/decision-replies"));
      expect(replyPost).toBeDefined();
      expect(replyPost!.body).toEqual({ command_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        resolution: "ACCEPT", answer: "同意调整发布承诺",
        // 绑定用户看到答案时的版本：不重算新方案冒充已确认。
        expected_revision: "1" });

      // 决定之后由原 applications 入口继续原请求，直到整组生效。
      const applyPosts = posts.filter((post) => post.path.endsWith("/applications"));
      expect(applyPosts.length).toBeGreaterThanOrEqual(1);
      expect(applied).toBeGreaterThanOrEqual(1);
      await flush(); await flush();
      const receipt = view.wrapper.get('[data-testid="state-maintenance-receipt"]');
      expect(receipt.attributes("data-status")).toBe("APPLIED");
      expect(receipt.text()).toContain("已全部生效");
      expect(view.wrapper.find('[data-testid="state-maintenance-decision-answer"]').exists())
        .toBe(false);
    } finally { view.unmount(); }
  });

  it("助手档会话零解释请求：发送完成后不发状态维护解释", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", router({ sessions: () => response({ items: [assistantSession()] }) }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await flush();
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("帮我看这个指标怎么定");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush(); await flush();

      // 消息本身已发出（助手档分支），但解释链完全不触发。
      expect(posts.some((post) => /\/assist-sessions\/[^/]+\/messages$/u.test(post.path))).toBe(true);
      expect(posts.some((post) => post.path.endsWith("/state-maintenance-requests"))).toBe(false);
      expect(posts.some((post) => post.path.endsWith("/execution-requests"))).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-receipt"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-pending"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });

  it("迟到响应不回写：会话切换后旧解释才 resolve，新会话不出现旧回执", async () => {
    activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "test-token" });
    const posts: { path: string; body: unknown }[] = [];
    let release: ((value: Response) => void) | null = null;
    const gated = new Promise<Response>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", router({
      gateStateMaintenance: () => gated,
      sessions: () => response({ items: [session(), session({}, otherSessionId)] }) }, posts));
    const view = await mountWorkbench(`/agent?work=${taskId}`);
    try {
      await view.wrapper.get('[data-testid="assist-draft"]').setValue("标记实验阶段");
      await flush();
      await view.wrapper.get('[data-testid="assist-send"]').trigger("click");
      await flush(); await flush();
      // 解释命令已发出但响应被扣住。
      expect(posts.some((post) => post.path.endsWith("/state-maintenance-requests"))).toBe(true);

      // 切换到另一个会话：旧面板卸载，迟到响应失去归属。
      await view.wrapper.get('[data-testid="assist-session-select"]').setValue(otherSessionId);
      await flush(); await flush();
      release!(response({ command_id: "late-fixed", committed_at: "2026-09-29T03:45:00Z",
        result: stateProjection({ decision: "MAINTAIN", status: "READY" }),
        links: { resource: "" } }, 202));
      await flush(); await flush(); await flush();

      // 新会话没有旧回执，也没有挂在途状态。
      expect(view.wrapper.find('[data-testid="state-maintenance-receipt"]').exists()).toBe(false);
      expect(view.wrapper.find('[data-testid="state-maintenance-pending"]').exists()).toBe(false);
      expect(view.wrapper.get('[data-testid="assist-transcript"]').text()).not.toContain("已全部生效");
      // 新会话自己的读取已经发生（按 session_id 查询），不会把旧请求并进来。
      expect(view.wrapper.find('[data-testid="state-maintenance-item-0"]').exists()).toBe(false);
    } finally { view.unmount(); }
  });
});
