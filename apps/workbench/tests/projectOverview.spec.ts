import { describe, expect, it, afterEach, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.restoreAllMocks(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe("项目总览（UI-02）", () => {
  it("裸项目路由默认显示总览，按真实 revision/阶段/目标呈现", async () => {
    const mounted = await mountWorkbench("/projects/project-hci");
    unmount = mounted.unmount;
    const text = mounted.wrapper.text();
    expect(mounted.wrapper.find('[data-testid="project-overview-fixture"]').exists()).toBe(true);
    expect(mounted.wrapper.get(".breadcrumbs").text()).toContain("总览");
    expect(text).toContain("项目当前状态");
    expect(text).toContain("状态 v");
    expect(text).toContain("研究可追溯");
    expect(text).toContain("关键产物与摘要");
    expect(text).toContain("下一步");
    expect(text).toContain("AI 提案不会自动改写 State");
  });

  it("确认人/确认时间等缺口明确标注为待接入，不伪造", async () => {
    const mounted = await mountWorkbench("/projects/project-hci");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("服务端接口待接入");
  });

  it("来源不可用时不以摘要当真相", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?fixture=source-unavailable");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("来源不可用");
  });

  it("技能子页仍可达：蓝图标签切换到蓝图预览", async () => {
    const mounted = await mountWorkbench("/projects/project-hci?skill=blueprint");
    unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("本次蓝图变更");
    expect(mounted.wrapper.find('[data-testid="project-overview-fixture"]').exists()).toBe(false);
  });
});

/* ── V43-04 live 总览接续呈现 ─────────────────────────────────────────────
 * 接续摘要卡（真实 DailyContinuationCard）+「继续工作 / 查看动态」两动作；
 * 继续工作只做导航（下一步任务详情或项目工作台），不委托、不建 Task/Run/会话；
 * 阻塞、已确认事实、任务、关键成果全部来自既有真实查询，缺口如实标注。 */
const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const nextTaskId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

function liveResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
function taskJson(id: string, over: Record<string, unknown> = {}) {
  return { id, project_id: projectId, title: `任务 ${id}`, status: "READY", mode: "ME", revision: "1",
    executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
    blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], ...over };
}
function dailyContinuation() {
  return { project_id: projectId,
    current: { state_revision: "7", phase_key: "EXPERIMENT", next_action_task_id: nextTaskId,
      open_task_ids: [nextTaskId], open_task_count: 1, open_task_ids_truncated: false,
      waiting_task_count: 0, blocked_task_count: 0, unresolved_blocker_count: 0 },
    baseline: null, delta: null,
    presentation: { presentation_id: "9d0e1f20-2122-4324-8425-262728292a2b", presentation_seq: "5" },
    revision: "3" };
}

function stubOverview(options: { archived?: boolean; withNextAction?: boolean; blocked?: boolean },
  posts: { path: string }[]) {
  const { archived = false, withNextAction = true, blocked = true } = options;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rel = url.slice(root.length);
    if (init?.method === "POST") {
      posts.push({ path: new URL(url).pathname });
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      if (rel.endsWith("/daily-view-confirmations")) return liveResponse({ command_id: body.command_id,
        committed_at: "2026-10-16T00:00:00Z", result: dailyContinuation(), links: { resource: "" } });
      if (rel.endsWith("/return-reviews")) return liveResponse({ command_id: body.command_id,
        committed_at: "2026-10-16T00:00:01Z", result: { review_id: "7a1c9b22-5566-4738-99aa-bbccddeeff00",
          project_id: projectId, status: "APPLICABLE", fingerprint: "a".repeat(64), reused: false,
          changed_dimensions: [], delta: null, evidence: [], created_at: "2026-10-16T00:00:01Z" },
        links: { resource: "" } });
      throw new Error(`unexpected POST ${rel}`);
    }
    if (rel.endsWith("/attention/interventions")) return liveResponse({ items: [] });
    if (rel === `/projects/${projectId}`) return liveResponse({ id: projectId, title: "接续项目",
      project_type: "GENERAL", revision: "5", state_revision: "7",
      archived_at: archived ? "2026-09-26T00:00:00Z" : null });
    if (rel === `/projects/${projectId}/state`) return liveResponse({ project_id: projectId,
      phase_key: "EXPERIMENT", revision: "7", next_action_task_id: withNextAction ? nextTaskId : null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (rel === `/projects/${projectId}/daily-continuation`) return liveResponse(dailyContinuation());
    if (rel === `/projects/${projectId}/goals`) return liveResponse({ items: [] });
    if (rel === "/reviews?status=OPEN") return liveResponse({ items: [], next_cursor: null });
    if (rel === `/decisions?project_id=${projectId}`) return liveResponse([]);
    if (rel.startsWith(`/tasks?project_id=${projectId}`)) return liveResponse({ items: blocked
      ? [taskJson("task-running", { status: "IN_PROGRESS" }),
        taskJson("task-blocked", { status: "BLOCKED", blocking_task_ids: [nextTaskId] })]
      : [taskJson("task-running", { status: "IN_PROGRESS" })], next_cursor: null });
    if (rel === `/tasks/${nextTaskId}`) return liveResponse({ ...taskJson(nextTaskId, { title: "补齐基线", status: "IN_PROGRESS" }),
      acceptance: { acceptance_revision: "1", objective: "核对", source: "HUMAN", criteria: [] },
      dependencies: [] });
    if (rel === "/activities" || rel.startsWith("/activities?")) return liveResponse({ items: [], next_cursor: null });
    if (rel.startsWith("/projects?")) return liveResponse({ items: [], next_cursor: null });
    throw new Error(`unexpected GET ${rel}`);
  });
}

describe("项目总览接续呈现（V43-04，live）", () => {
  it("State 命令成功后重新读取接续摘要，不能把旧阶段当作当前事实", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const posts: { path: string }[] = [];
    const fallback = stubOverview({ withNextAction: false }, posts);
    let revision = "7";
    const daily = () => ({ ...dailyContinuation(), current: { ...dailyContinuation().current,
      state_revision: revision, phase_key: revision === "7" ? "PLANNING" : "EXECUTING", next_action_task_id: null } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rel = String(input).slice(root.length);
      if (init?.method === "POST" && rel.endsWith("/state-commands")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        revision = "8";
        return liveResponse({ command_id: body.command_id, committed_at: "2026-10-27T00:00:00Z",
          result: { project_id: projectId, action: body.action, revision } });
      }
      if (init?.method !== "POST" && rel === `/projects/${projectId}/state`) {
        return liveResponse({ project_id: projectId, phase_key: revision === "7" ? "PLANNING" : "EXECUTING",
          revision, next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
      }
      if (init?.method !== "POST" && rel.endsWith("/daily-continuation")) return liveResponse(daily());
      if (init?.method === "POST" && rel.endsWith("/daily-view-confirmations")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return liveResponse({ command_id: body.command_id, committed_at: "2026-10-27T00:00:00Z", result: daily() });
      }
      return fallback(input, init);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}`);
    unmount = mounted.unmount;
    await flush(); await flush();
    expect(mounted.wrapper.get('[data-testid="daily-continuation-facts"]').text()).toContain("阶段 规划");
    await mounted.wrapper.get('[data-testid="state-phase"]').setValue("EXECUTING");
    await mounted.wrapper.get('[data-testid="state-phase-submit"]').trigger("click");
    await flush(); await flush(); await flush();
    expect(mounted.wrapper.get('[data-testid="project-overview-facts"]').text()).toContain("State v8");
    expect(mounted.wrapper.get('[data-testid="daily-continuation-facts"]').text()).toContain("阶段 执行");
  });

  it("接续摘要卡提供继续工作与查看动态；查看动态带项目过滤，继续工作零新增业务写入", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const posts: { path: string }[] = [];
    vi.stubGlobal("fetch", stubOverview({}, posts));
    const mounted = await mountWorkbench(`/projects/${projectId}`);
    unmount = mounted.unmount;
    await flush(); await flush();
    const overview = mounted.wrapper.get('[data-testid="project-overview-live"]');
    expect(overview.text()).toContain("接续摘要");
    // 继续工作 → State 下一步任务详情（纯导航链接）。
    expect(mounted.wrapper.get('[data-testid="project-resume-continue"]').attributes("href"))
      .toBe(`/tasks/${nextTaskId}`);
    // 查看动态 → /activity?project_id=…。
    expect(mounted.wrapper.get('[data-testid="project-resume-activity"]').attributes("href"))
      .toBe(`/activity?project_id=${projectId}`);
    // 阻塞、已确认事实、任务、关键成果按原型顺序呈现，内容来自真实查询。
    expect(overview.text()).toContain("不可开始原因");
    expect(overview.text()).toContain("已确认事实");
    expect(overview.text()).toContain("State v7");
    expect(overview.text()).toContain("任务");
    expect(overview.text()).toContain("关键成果");
    // 点击查看动态：进入动态页，project_id 过滤生效（出现「已应用范围」）。
    await mounted.wrapper.get('[data-testid="project-resume-activity"]').trigger("click");
    await flush(); await flush();
    expect(mounted.router.currentRoute.value.path).toBe("/activity");
    expect(mounted.router.currentRoute.value.query.project_id).toBe(projectId);
    expect(mounted.wrapper.text()).toContain("已应用范围");
    // 零新增业务写入：打开项目只有既有的查看确认与返回核对，没有任何 Task/Run/会话创建。
    expect(posts.some((post) => post.path.endsWith("/daily-view-confirmations"))).toBe(true);
    expect(posts.every((post) => post.path.endsWith("/daily-view-confirmations") ||
      post.path.endsWith("/return-reviews"))).toBe(true);
  });

  it("无下一步时继续工作回项目工作台，不制造下一步", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const posts: { path: string }[] = [];
    vi.stubGlobal("fetch", stubOverview({ withNextAction: false, blocked: false }, posts));
    const mounted = await mountWorkbench(`/projects/${projectId}`);
    unmount = mounted.unmount;
    await flush(); await flush();
    expect(mounted.wrapper.get('[data-testid="project-resume-continue"]').attributes("href"))
      .toBe(`/projects/${projectId}/workbench`);
    expect(mounted.wrapper.get('[data-testid="project-overview-live"]').text()).toContain("尚未指定");
  });

  it("归档项目：继续工作禁用并说明原因，查看动态与历史事实仍可读", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
    const posts: { path: string }[] = [];
    vi.stubGlobal("fetch", stubOverview({ archived: true }, posts));
    const mounted = await mountWorkbench(`/projects/${projectId}`);
    unmount = mounted.unmount;
    await flush(); await flush();
    const overview = mounted.wrapper.get('[data-testid="project-overview-live"]');
    const continueButton = mounted.wrapper.get('[data-testid="project-resume-continue"]');
    expect(continueButton.attributes("disabled")).toBeDefined();
    expect(overview.text()).toContain("项目已归档：只能阅读历史，恢复归档后才能继续。");
    // 历史仍只读可看：任务与成果区照常呈现，动态入口保留。
    expect(overview.text()).toContain("任务");
    expect(mounted.wrapper.get('[data-testid="project-resume-activity"]').attributes("href"))
      .toBe(`/activity?project_id=${projectId}`);
  });
});
