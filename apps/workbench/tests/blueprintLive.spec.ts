import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const basePath = `/projects/${projectId}/blueprint-proposals`;
const proposalId = "33333333-3333-4333-8333-333333333333";
const secondProposalId = "44444444-4444-4444-8444-444444444444";
const taskId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const messageId = "77777777-7777-4777-8777-777777777777";
const created = "2026-09-26T00:00:00.000Z";
type Kind = "general" | "thesis" | "development";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  resetRelayConnectionForTest();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function template(kind: Kind) {
  const ids = kind === "general" ? ["state", "tasks", "artifacts", "reviews"] :
    kind === "thesis" ? ["state", "knowledge", "tasks", "artifacts", "reviews"] :
      ["state", "tasks", "runs", "connections", "reviews"];
  return { kind, template_version: "1", template_sha256: kind === "general" ? "a".repeat(64) : "b".repeat(64),
    pages: ids.map((page_id, position) => ({ page_id, visible: true, position })) };
}
interface ServerState {
  proposal: Record<string, unknown> | null;
  archivedAt: string | null;
  oldProposal?: Record<string, unknown> | null;
  stateRevision: string;
  viewRevision: string;
  viewKind: Kind;
  nextActionTaskId: string | null;
}
function serverState(): ServerState {
  return { proposal: null, archivedAt: null, stateRevision: "1", viewRevision: "1", viewKind: "general", nextActionTaskId: null };
}
function makeProposal(id: string, draft: Record<string, unknown>, options: {
  status?: string; supersedes?: string | null; stale?: boolean; decision?: Record<string, unknown> | null;
  origin?: "USER_DRAFT" | "SKILL"; skillMessageId?: string | null
} = {}) {
  const view = template(draft.view_kind as Kind);
  const tasks = (draft.tasks as Record<string, unknown>[]).map((task) => ({ ...task, mode: "ME",
    status: "INBOX", executor_kind: "HUMAN", required_output_spec: {}, criteria: [] }));
  const candidate = { schema_version: "1", intent: draft.intent, goal_id: draft.goal_id,
    phase_key: draft.phase_key, tasks, next_action: draft.next_action,
    view_configuration: view, follow_up_suggestions: [
      { kind: "RULE", summary: "规则需另行确认。" },
      { kind: "WORKFLOW", summary: "执行配置需另行确认。" }
    ] };
  const baseline = { project_revision: "1", state_revision: "1", view_revision: "1",
    phase_key: "PLANNING", next_action_task_id: null, goal_ids: [],
    goal_ref: null, next_action_task_ref: null, view_configuration: template("general") };
  return { id, workspace_id: workspaceId, project_id: projectId,
    status: options.status ?? "PENDING", origin: options.origin ?? "USER_DRAFT",
    content_availability: "AVAILABLE",
    skill_message_id: options.skillMessageId ?? null,
    supersedes_proposal_id: options.supersedes ?? null, candidate_sha256: "c".repeat(64),
    candidate, baseline, source: options.origin === "SKILL"
      ? { origin: "SKILL", skill_message_id: options.skillMessageId,
        skill: { id: "goal-to-project-blueprint", version: "1.0.0", sha256: "d".repeat(64) },
        skill_output_sha256: "f".repeat(64), basis_facts_sha256: "e".repeat(64), pack: null }
      : { origin: "USER_DRAFT", pack: null },
    stale: options.stale ?? false,
    diff: { goal_link: { before_goal_ids: [], add_goal_id: draft.goal_id },
      state: { phase: { before: "PLANNING", after: draft.phase_key },
        next_action: { before_task_id: null, after: draft.next_action } },
      new_tasks: tasks, view_configuration: { before: template("general"), after: view,
        changed: draft.view_kind !== "general" } },
    follow_up_suggestions: candidate.follow_up_suggestions,
    decision: options.decision ?? null, created_at: created, decided_at: null, updated_at: created };
}
function draft() {
  return { intent: "梳理交付路径", goal_id: null, phase_key: "EXECUTING",
    tasks: [{ local_key: "task1", title: "整理需求", objective: "形成可验收清单" }],
    next_action: { kind: "NEW_TASK", local_key: "task1" }, view_kind: "thesis", pack_ref: null };
}
function applyResult() {
  return { proposal_id: proposalId, candidate_sha256: "c".repeat(64), project_id: projectId,
    project_revision: "1", state_revision: "3", view_revision: "2", goal_ids: [],
    task_id_map: [{ local_key: "task1", task_id: taskId, status: "INBOX", revision: "1" }],
    next_action_task_id: taskId,
    view_configuration: { ...template("thesis"), revision: "2" },
    applied_effects: { goal_linked: false, tasks_created: 1, state_changed: true, view_changed: true } };
}
function standardGet(path: string, state: ServerState): Response | null {
  if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "真实项目",
    project_type: "GENERAL", revision: "1", state_revision: state.stateRevision, archived_at: state.archivedAt });
  if (path === `/projects/${projectId}/state`) return response(200, { project_id: projectId,
    phase_key: state.stateRevision === "1" ? "PLANNING" : "EXECUTING",
    revision: state.stateRevision, next_action_task_id: state.nextActionTaskId,
    selected_artifact_version_refs: [], completed_highlight_refs: [] });
  if (path === `/projects/${projectId}/view-configuration`) return response(200, { project_id: projectId,
    revision: state.viewRevision, ...template(state.viewKind), updated_at: created });
  if (path === `/projects/${projectId}/goals`) return response(200, { items: [] });
  if (path === "/packs") return response(200, { items: [] });
  if (path === `/tasks?project_id=${projectId}`) return response(200, { items: [], next_cursor: null });
  if (path === basePath) return response(200, { items: [state.proposal, state.oldProposal].filter(Boolean) });
  if (path === `${basePath}/${proposalId}`) return state.proposal?.id === proposalId
    ? response(200, state.proposal) : response(200, state.oldProposal);
  if (path === `${basePath}/${secondProposalId}`) return response(200,
    state.proposal?.id === secondProposalId ? state.proposal : state.oldProposal);
  return null;
}

function blueprintSkillDefinition() {
  return { id: "goal-to-project-blueprint", version: "1.0.0", sha256: "d".repeat(64),
    title: "生成项目蓝图", target: "PROJECT", output_kind: "PROJECT_BLUEPRINT_SUGGESTION",
    availability: "CALLABLE_SUGGESTION_ONLY", call_supported: true,
    required_capabilities: [], missing_capabilities: [], accept_supported: false,
    dependencies: [] };
}
function assistSession() {
  return { id: sessionId, session_id: sessionId, workspace_id: workspaceId,
    project_id: projectId, task_id: null, title: "项目蓝图建议", status: "ACTIVE",
    revision: "1", created_at: created, updated_at: created };
}
function skillMessage(status: "COMPLETED" | "FAILED", errorCode: string | null = null) {
  return { id: messageId, session_id: sessionId, seq: "2", role: "ASSISTANT", status,
    intent: "DISCUSS", content: status === "COMPLETED" ? "生成的摘要" : null,
    error_code: errorCode, sources: [], skill: { id: "goal-to-project-blueprint",
      version: "1.0.0", sha256: "d".repeat(64), definition_availability: "AVAILABLE",
      output_availability: status === "COMPLETED" ? "HISTORICAL_SNAPSHOT" : "NO_OUTPUT",
      target: "PROJECT", availability: "CALLABLE_SUGGESTION_ONLY", missing_capabilities: [] },
    skill_input: { desired_outcome: "建立可验收交付路径", goal_id: null, pack_ref: null },
    skill_output: status === "COMPLETED" ? { kind: "PROJECT_BLUEPRINT_SUGGESTION",
      status: "SUGGESTED", target_kind: "PROJECT", target_id: projectId, as_of: created,
      baseline: {}, basis_sha256: "e".repeat(64), payload_sha256: "f".repeat(64),
      payload: { summary: "建议先整理需求", draft: draft(), effective_blueprint: false } } : null,
    usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}
function skillServer(status: "COMPLETED" | "FAILED", responseLost = false,
  sourceUnavailable = false) {
  const state = serverState();
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const receipts: string[] = [];
  let requestId: string | null = null;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).slice(root.length);
    if (path === "/skill-definitions") return response(200, { items: [blueprintSkillDefinition()] });
    if (path === `/assist-sessions/${sessionId}`) return response(200, assistSession());
    if (path === `/assist-sessions/${sessionId}/messages?limit=200`) {
      if (status === "COMPLETED") {
        const proposal = makeProposal(proposalId, draft(),
          { origin: "SKILL", skillMessageId: messageId });
        state.proposal = sourceUnavailable ? { ...proposal,
          content_availability: "SOURCE_UNAVAILABLE", candidate: null,
          baseline: null, diff: null, follow_up_suggestions: [], stale: true } : proposal;
      }
      const message = skillMessage(status, status === "FAILED" ? "SKILL_BASELINE_STALE" : null);
      return response(200, { items: [sourceUnavailable ? { ...message, skill_output: null,
        skill: { ...message.skill, output_availability: "UNAVAILABLE" } } : message] });
    }
    if (path.startsWith("/commands/")) {
      receipts.push(path.slice("/commands/".length));
      return response(200, { command_id: requestId, command_type: "RequestAssistMessage",
        committed_at: created, result: { session_id: sessionId,
          user_message_id: taskId, assistant_message_id: messageId } });
    }
    if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/assist-sessions") {
      return response(201, { command_id: body.command_id, committed_at: created,
        result: assistSession() });
    }
    if (path === `/assist-sessions/${sessionId}/messages`) {
      requestId = String(body.command_id);
      if (responseLost) throw new TypeError("response lost");
      return response(202, { command_id: body.command_id, committed_at: created,
        result: { session_id: sessionId, user_message_id: taskId,
          assistant_message_id: messageId } });
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  return { state, posts, receipts, fetcher };
}

describe("真实项目蓝图", () => {
  it("归档深链保留服务端候选只读预览，禁新候选、Skill 与 Apply/Reject", async () => {
    connect(); const state = serverState(); state.archivedAt = created;
    state.proposal = makeProposal(proposalId, draft());
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/skill-definitions") return response(200, { items: [blueprintSkillDefinition()] });
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      throw new Error(`Unexpected write ${path}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="blueprint-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    expect(mounted.wrapper.get('[data-testid="blueprint-skill-generator"] fieldset').attributes("disabled")).toBeDefined();
    for (const id of ["blueprint-preview", "live-blueprint-apply", "live-blueprint-reject"]) {
      expect(mounted.wrapper.get(`[data-testid="${id}"]`).attributes("disabled")).toBeDefined();
    }
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("刷新时 Project 失权清除旧蓝图正文和写入口", async () => {
    connect(); const state = serverState(); state.proposal = makeProposal(proposalId, draft());
    let forbidden = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === `/projects/${projectId}` && forbidden) return response(403,
        { code: "FORBIDDEN", detail: "Project access revoked" });
      if (path === "/skill-definitions") return response(200, { items: [blueprintSkillDefinition()] });
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      throw new Error(`Unexpected write ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    forbidden = true;
    await mounted.wrapper.findAll("button").find((button) => button.text().includes("刷新事实与候选"))!.trigger("click");
    await flush();
    expect(mounted.wrapper.text()).not.toContain("本次蓝图变更");
    expect(mounted.wrapper.find('[data-testid="live-blueprint-apply"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("Project access revoked");
  });
  it("人工草稿生成服务端候选后才可显式应用，展示真实 Diff、模板顺序与实际效果", async () => {
    connect(); const state = serverState();
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (path === basePath) {
        state.proposal = makeProposal(proposalId, body.draft as Record<string, unknown>);
        return response(201, { command_id: body.command_id, committed_at: created, result: state.proposal });
      }
      if (path === `${basePath}/${proposalId}/apply`) {
        state.proposal = { ...state.proposal, status: "ACCEPTED", decision: { result: applyResult() } };
        state.stateRevision = "3"; state.viewRevision = "2"; state.viewKind = "thesis";
        state.nextActionTaskId = taskId;
        return response(200, { command_id: body.command_id, committed_at: created, result: applyResult() });
      }
      throw new Error(`Unexpected POST ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("人工草稿先生成不可变候选");
    expect(mounted.wrapper.text()).toContain("不会自动成为已确认 Goal");
    expect(mounted.wrapper.text()).toContain("当前项目没有可读取的蓝图候选");
    expect(posts).toHaveLength(0);
    await mounted.wrapper.get('[data-testid="blueprint-intent"]').setValue("梳理交付路径");
    await mounted.wrapper.get('[data-testid="blueprint-task-title-0"]').setValue("整理需求");
    await mounted.wrapper.get('[data-testid="blueprint-task-objective-0"]').setValue("形成可验收清单");
    await mounted.wrapper.get('[data-testid="blueprint-phase"]').setValue("EXECUTING");
    await mounted.wrapper.get('[data-testid="blueprint-view-kind"]').setValue("thesis");
    await mounted.wrapper.get('[data-testid="blueprint-next-kind"]').setValue("NEW_TASK");
    await mounted.wrapper.get('[data-testid="blueprint-next-new"]').setValue("task1");
    await mounted.wrapper.get('[data-testid="live-blueprint-form"]').trigger("submit");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(basePath);
    expect(posts[0].body).toMatchObject({ expected_project_revision: "1", expected_state_revision: "1",
      expected_view_revision: "1", draft: draft() });
    expect(posts[0].body).not.toHaveProperty("supersedes_proposal_id");
    expect(mounted.wrapper.text()).toContain("人工草稿 USER_DRAFT");
    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    expect(mounted.wrapper.text()).toContain("资料 (knowledge, 显示)");
    expect(mounted.wrapper.text()).toContain("以下来自服务端候选，需在各自入口单独确认");
    expect(mounted.wrapper.get('[data-testid="live-blueprint-apply"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="live-blueprint-apply"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ path: `${basePath}/${proposalId}/apply`,
      body: { candidate_sha256: "c".repeat(64), expected_project_revision: "1",
        expected_state_revision: "1", expected_view_revision: "1" } });
    expect(mounted.wrapper.text()).toContain("已应用的实际效果");
    expect(mounted.wrapper.text()).toContain("新任务：1");
    expect(mounted.wrapper.find(`a[href="/tasks/${taskId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="live-blueprint-apply"]').attributes("disabled")).toBeDefined();
  });

  it("编辑待确认候选用 supersedes 新建不可变候选，历史仍可见", async () => {
    connect(); const state = serverState(); state.proposal = makeProposal(proposalId, draft());
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      if (path === basePath) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posts.push(body);
        state.oldProposal = { ...state.proposal, status: "SUPERSEDED" };
        state.proposal = makeProposal(secondProposalId, body.draft as Record<string, unknown>,
          { supersedes: proposalId });
        return response(201, { command_id: body.command_id, committed_at: created, result: state.proposal });
      }
      throw new Error(`Unexpected POST ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("整理需求");
    await mounted.wrapper.get('[data-testid="blueprint-task-title-0"]').setValue("整理验收需求");
    expect(mounted.wrapper.get('[data-testid="live-blueprint-apply"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="live-blueprint-form"]').trigger("submit");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ supersedes_proposal_id: proposalId,
      draft: { tasks: [{ local_key: "task1", title: "整理验收需求", objective: "形成可验收清单" }] } });
    expect(mounted.wrapper.text()).toContain(`替代旧候选：${proposalId}`);
    expect(mounted.wrapper.text()).toContain("已被新候选替代");
  });

  it("Apply 响应不明先用原 command_id 查回执，恢复服务端实际效果", async () => {
    connect(); const state = serverState(); state.proposal = makeProposal(proposalId, draft());
    let appliedId: string | null = null;
    const receipts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path.startsWith("/commands/")) {
        receipts.push(path.slice("/commands/".length));
        return response(200, { command_id: appliedId, command_type: "ApplyProjectBlueprint",
          committed_at: created, result: applyResult() });
      }
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      if (path === `${basePath}/${proposalId}/apply`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        appliedId = String(body.command_id);
        state.proposal = { ...state.proposal, status: "ACCEPTED", decision: { result: applyResult() } };
        state.stateRevision = "3"; state.viewRevision = "2"; state.viewKind = "thesis";
        state.nextActionTaskId = taskId;
        throw new TypeError("response lost");
      }
      throw new Error(`Unexpected POST ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="live-blueprint-apply"]').trigger("click");
    await flush();
    expect(receipts).toEqual([appliedId]);
    expect(mounted.wrapper.text()).toContain("蓝图应用回执已确认");
    expect(mounted.wrapper.text()).toContain("已应用的实际效果");
    expect(mounted.wrapper.find('[data-testid="blueprint-pending"]').exists()).toBe(false);
  });

  it("暂不采用只决定当前候选，不写 Project/State/View", async () => {
    connect(); const state = serverState(); state.proposal = makeProposal(proposalId, draft());
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ path, body });
      state.proposal = { ...state.proposal, status: "REJECTED" };
      return response(200, { command_id: body.command_id, committed_at: created,
        result: { proposal_id: proposalId, status: "REJECTED" } });
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="live-blueprint-reject"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: `${basePath}/${proposalId}/reject`,
      body: { candidate_sha256: "c".repeat(64) } });
    expect(mounted.wrapper.text()).toContain("服务端已记录暂不采用");
    expect(mounted.wrapper.text()).toContain("Project v1 / State v1 / View v1");
  });

  it("人工候选 409 后查原回执并保留草稿，明确重新确认才换命令 ID", async () => {
    connect(); const state = serverState();
    const commandIds: string[] = [];
    const receipts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path.startsWith("/commands/")) {
        receipts.push(path.slice("/commands/".length));
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found" });
      }
      if ((init?.method ?? "GET") === "GET") return standardGet(path, state) ?? response(404, {});
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      commandIds.push(String(body.command_id));
      return response(409, { code: "REVISION_CONFLICT", detail: "stale" });
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="blueprint-intent"]').setValue("保留的人工草稿");
    await mounted.wrapper.get('[data-testid="live-blueprint-form"]').trigger("submit");
    await flush();
    expect(receipts).toEqual([commandIds[0]]);
    expect(mounted.wrapper.get('[data-testid="blueprint-pending"]').text()).toContain(commandIds[0]);
    expect(mounted.wrapper.text()).toContain("保留的人工草稿");
    expect(commandIds).toHaveLength(1);
    await mounted.wrapper.get('[data-testid="blueprint-pending"] button:last-child').trigger("click");
    await mounted.wrapper.get('[data-testid="live-blueprint-form"]').trigger("submit");
    await flush();
    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).not.toBe(commandIds[0]);
  });

  it("切换到来源不可用的 Skill 提案会清除旧正文和 Diff，并禁用确认", async () => {
    connect(); const state = serverState();
    state.proposal = makeProposal(proposalId, draft(), { origin: "SKILL", skillMessageId: messageId });
    state.oldProposal = { ...makeProposal(secondProposalId, draft(),
      { origin: "SKILL", skillMessageId: taskId, stale: true }),
      content_availability: "SOURCE_UNAVAILABLE", candidate: null, baseline: null,
      diff: null, follow_up_suggestions: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === "/skill-definitions") return response(200, { items: [blueprintSkillDefinition()] });
      return standardGet(path, state) ?? response(404, {});
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("梳理交付路径");
    await mounted.wrapper.findAll(".live-blueprint-history button")[1].trigger("click");
    await flush();
    expect(mounted.wrapper.get('[data-testid="blueprint-source-unavailable"]').text())
      .toContain("来源不可用");
    expect(mounted.wrapper.text()).not.toContain("梳理交付路径");
    expect(mounted.wrapper.text()).not.toContain("整理需求");
    expect(mounted.wrapper.text()).not.toContain("本次蓝图变更");
    expect(mounted.wrapper.get('[data-testid="live-blueprint-apply"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.get('[data-testid="live-blueprint-reject"]').attributes("disabled")).toBeDefined();
  });

  it("跨项目读取失败时停留在真实错误页，不回退 fixture", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async () => response(404, { code: "RESOURCE_NOT_FOUND", detail: "not found" })));
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("暂时无法读取项目蓝图");
    expect(mounted.wrapper.text()).not.toContain("本次演示");
  });

  it("Skill 通过 Project Assist 消息生成，只选择精确消息关联的服务端候选", async () => {
    connect(); const server = skillServer("COMPLETED");
    server.state.oldProposal = makeProposal(secondProposalId, draft(),
      { origin: "SKILL", skillMessageId: taskId });
    vi.stubGlobal("fetch", server.fetcher);
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="blueprint-skill-outcome"]').setValue("建立可验收交付路径");
    await mounted.wrapper.get('[data-testid="blueprint-skill-generator"] form').trigger("submit");
    await flush();
    expect(server.posts.map((item) => item.path)).toEqual([
      "/assist-sessions", `/assist-sessions/${sessionId}/messages`]);
    expect(server.posts[1].body).toMatchObject({ content: "请根据当前项目事实生成项目蓝图建议：建立可验收交付路径",
      skill_ref: { id: "goal-to-project-blueprint", version: "1.0.0" },
      skill_input: { desired_outcome: "建立可验收交付路径", goal_id: null, pack_ref: null },
      source_refs: [] });
    expect(server.posts[1].body).not.toHaveProperty("intent");
    expect(server.posts.some((item) => item.path === basePath)).toBe(false);
    expect(mounted.wrapper.text()).toContain(`来源 Assist 消息：${messageId}`);
    expect(mounted.wrapper.text()).toContain(`候选 ${proposalId}`);
    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    expect(mounted.wrapper.text()).toContain("尚未应用");
  });

  it("Skill 失败时显示原 error_code 且没有蓝图候选", async () => {
    connect(); const server = skillServer("FAILED"); vi.stubGlobal("fetch", server.fetcher);
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="blueprint-skill-outcome"]').setValue("建立可验收交付路径");
    await mounted.wrapper.get('[data-testid="blueprint-skill-generator"] form').trigger("submit");
    await flush();
    expect(mounted.wrapper.text()).toContain("SKILL_BASELINE_STALE");
    expect(mounted.wrapper.text()).toContain("没有可应用的蓝图提案");
    expect(server.state.proposal).toBeNull();
    expect(server.posts.some((item) => item.path === basePath)).toBe(false);
  });

  it("Skill 消息响应丢失时查原命令回执并接续消息，不重复发送", async () => {
    connect(); const server = skillServer("COMPLETED", true); vi.stubGlobal("fetch", server.fetcher);
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="blueprint-skill-outcome"]').setValue("建立可验收交付路径");
    await mounted.wrapper.get('[data-testid="blueprint-skill-generator"] form').trigger("submit");
    await flush();
    expect(server.receipts).toEqual([server.posts[1].body.command_id]);
    expect(server.posts).toHaveLength(2);
    expect(mounted.wrapper.text()).toContain(`来源 Assist 消息：${messageId}`);
  });

  it("Skill 消息正文失权后仅按消息 ID 找到隐藏的服务端候选元数据", async () => {
    connect(); const server = skillServer("COMPLETED", false, true); vi.stubGlobal("fetch", server.fetcher);
    const mounted = await mountWorkbench(`/projects/${projectId}?skill=blueprint`);
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="blueprint-skill-outcome"]').setValue("建立可验收交付路径");
    await mounted.wrapper.get('[data-testid="blueprint-skill-generator"] form').trigger("submit");
    await flush();
    expect(mounted.wrapper.get('[data-testid="blueprint-source-unavailable"]').text())
      .toContain(`候选 ${proposalId}`);
    expect(mounted.wrapper.text()).not.toContain("建议先整理需求");
    expect(mounted.wrapper.text()).not.toContain("梳理交付路径");
    expect(mounted.wrapper.get('[data-testid="live-blueprint-apply"]').attributes("disabled")).toBeDefined();
  });
});
