import { test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * live-only 页面的视觉采集：API 全部由 page.route 伪造（复用各 browser spec 的伪造口径），
 * 覆盖 fixture 模式没有数据的页面（今日/Goal 详情/Run/定时任务/资料/动态/连接）。
 * 截图输出 results/proto-replica-20261026/product-before/，与原型 proto/ 并排对照。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4174"}`;
const outDir = resolve(import.meta.dirname, "../../results/proto-replica-20261026/product-before");

const goalId = "44444444-4444-4444-8444-444444444444";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "55555555-5555-4555-8555-555555555555";
const directoryId = "66666666-6666-4666-8666-666666666666";
const sessionId = "77777777-7777-4777-8777-777777777777";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const goal = { id: goalId, title: "完成毕业论文第二章", description: "整理文献观点并形成可核对章节草稿", status: "ACTIVE", revision: "2", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" };
const now = new Date().toISOString();
const project = { id: projectId, title: "毕业论文", project_type: "THESIS", revision: "2",
  state_revision: "3", archived_at: null, archive_status: "ACTIVE", phase_key: "EXECUTING",
  next_action_task_id: taskId, created_at: "2026-10-01T00:00:00Z", updated_at: now };
const task = { id: taskId, projectId, title: "第二章文献与章节草稿", status: "IN_PROGRESS", mode: "AI_ASSIST", executor: "AI", revision: "3", waitingReason: null, blockedReason: null };

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/goals`) return fulfillJson(route, { items: [goal], next_cursor: null });
    if (path === `${prefix}/goals/${goalId}`) return fulfillJson(route, goal);
    if (path === `${prefix}/goals/${goalId}/projects`) return fulfillJson(route, { items: [
      { project_id: projectId, title: "毕业论文", project_type: "THESIS", archived_at: null,
        archive_status: "ACTIVE", project_revision: "2", linked_at: "2026-10-02T00:00:00Z" }] });
    if (path === `${prefix}/goals/${goalId}/work-context`) return fulfillJson(route, { kind: "GOAL",
      goal, projects: [{ id: projectId, title: "毕业论文", project_type: "THESIS", archive_status: "ACTIVE",
        archived_at: null, revision: "2", directories: [{ id: directoryId, canonical_root: "D:/work/thesis", status: "ACTIVE", revision: "1" }] }],
      sessions: [{ id: sessionId, project_id: projectId, title: "第二章讨论", status: "ACTIVE", revision: "1", working_resource_id: directoryId }] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, project);
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, { project_id: projectId,
      phase_key: "EXECUTING", next_action_task_id: taskId, revision: "3", updated_at: now, in_progress: [],
      blockers: [], risks: [], completed_highlight_refs: [], selected_artifact_version_refs: [],
      key_decision_refs: [], dependency_versions: {}, allowed_actions: [] });
    if (path === `${prefix}/projects/${projectId}/goals`) return fulfillJson(route, { items: [
      { goal_id: goalId, title: goal.title, status: "ACTIVE", revision: "2", explicit_task_ids: [taskId] }] });
    if (path === `${prefix}/projects/${projectId}/tasks`) return fulfillJson(route, { items: [task], next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [project], next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, task);
    if (path.startsWith(`${prefix}/today`)) return fulfillJson(route, { date: "2026-10-26", timezone: "Asia/Shanghai",
      selection_revision: "5", focus: null, focus_has_eligible_candidate: false,
      eligible_items: [{ task_id: taskId, task_revision: "3", project_id: projectId, status: "IN_PROGRESS",
        title: "第二章文献与章节草稿", priority: "HIGH", due_local_date: null, due_timezone: null,
        later_local_date: null, later_timezone: null, timezone: null, pin: false, reason_codes: ["FOCUS_ALIGNED", "HUMAN_IN_PROGRESS"],
        evidence_refs: ["Run 5555"], allowed_actions: ["PIN", "SET_FOCUS", "SET_LATER", "START"] }],
      waiting_items: [{ task_id: "33333333-3333-4333-8333-333333333331", task_revision: "1", project_id: projectId,
        status: "WAITING", title: "等待引用核对的任务", priority: null, due_local_date: null, due_timezone: null,
        later_local_date: null, later_timezone: null, timezone: null, pin: false, reason_codes: ["DEPENDENCY_UNSATISFIED"],
        evidence_refs: [], allowed_actions: ["PIN"] }],
      blocked_pinned_items: [] });
    if (path === `${prefix}/reviews`) return fulfillJson(route, [
      { id: "r-1", kind: "CRITERION", status: "OPEN", revision: "3", projectId, taskId, runId, operationId: null,
        reason: "需要人工确认错误提示是否属于本轮必须验收的范围。", target_hash: "示例摘要",
        target: { artifact_version_id: "av-1", acceptance_revision: "2", criterion_id: "human-1" },
        evidence: { check_result: "自动检查无法代替人工判断" },
        effect: { on_accept: "保存人工判断后重新核对完成条件", on_request_changes: "按原验收契约继续修正" },
        allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null, created_at: now, decided_at: null }]);
    if (path.startsWith(`${prefix}/reviews/r-1`)) return fulfillJson(route, { id: "r-1", kind: "CRITERION",
      status: "OPEN", revision: "3", projectId, taskId, runId, operationId: null,
      reason: "需要人工确认错误提示是否属于本轮必须验收的范围。", target_hash: "示例摘要",
      target: { artifact_version_id: "av-1", acceptance_revision: "2", criterion_id: "human-1" },
      evidence: { check_result: "自动检查无法代替人工判断" },
      effect: { on_accept: "保存人工判断后重新核对完成条件", on_request_changes: "按原验收契约继续修正" },
      allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null, created_at: now, decided_at: null });
    if (path === `${prefix}/scheduled-tasks`) return fulfillJson(route, { items: [schItem("sch-1", "ENABLED", "3", "2026-10-27T01:00:00Z"),
      schItem("sch-2", "PAUSED", "2", null)] });
    if (path === `${prefix}/scheduled-tasks/sch-1`) return fulfillJson(route, schItem("sch-1", "ENABLED", "3", "2026-10-27T01:00:00Z"));
    if (path.startsWith(`${prefix}/knowledge`)) return fulfillJson(route, { items: [
      { id: "k-1", kind: "KNOWLEDGE", status: "ACTIVE", current_version: 2, project_id: projectId, title: "第二章研究现状综述", updated_at: now },
      { id: "m-1", kind: "MEMORY", status: "ACTIVE", current_version: 1, project_id: projectId, title: "引用格式偏好", updated_at: now },
      { id: "d-1", kind: "DECISION", status: "ACTIVE", current_version: 1, project_id: projectId, title: "采用三类方法分类", updated_at: now },
      { id: "r-9", kind: "RULE", status: "ACTIVE", current_version: 1, project_id: projectId, title: "引用必须给出来源", updated_at: now }], next_cursor: null });
    if (path.startsWith(`${prefix}/memories`)) return fulfillJson(route, { items: [], next_cursor: null });
    if (path.startsWith(`${prefix}/decisions`)) return fulfillJson(route, { items: [], next_cursor: null });
    if (path.startsWith(`${prefix}/rules`)) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/activities`) return fulfillJson(route, { items: [
      { id: "a-1", event_type: "RUN_STARTED", actor_kind: "AI", created_at: now, project_id: projectId, task_id: taskId, run_id: runId, payload: {} },
      { id: "a-2", event_type: "TOOL_INVOKED", actor_kind: "AI", created_at: now, project_id: projectId, task_id: taskId, run_id: runId, payload: {} }], next_cursor: null });
    if (path === `${prefix}/gateway-connections`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/runs/${runId}`)) return fulfillJson(route, { id: runId, task_id: taskId,
      project_id: projectId, status: "FINISHED", revision: "4", started_at: now, finished_at: now, steps: [] });
    if (path.startsWith(`${prefix}/assist-sessions`)) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/attention`)) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

/** 按客户端 parser 的确切字段名构造定时任务条目（schema 见 api/resources/scheduledTasks.ts）。 */
function schItem(id: string, status: string, revision: string, nextDueAt: string | null) {
  const weekly = id === "sch-2";
  return { scheduled_task_id: id, project_id: projectId, title: weekly ? "每周项目复盘" : "每日工作区质量回顾",
    status, revision, schedule_generation: "2", next_due_at: nextDueAt,
    repeat_rule: weekly ? { kind: "WEEKLY", weekdays: [1, 5] } : { kind: "DAILY", interval_days: 1 },
    timezone: "Asia/Shanghai", local_time: weekly ? "17:30" : "09:00", first_run_at: "2026-10-20T01:00:00Z",
    max_runs: 10, runs_started: 3, authorization_expires_at: "2026-12-01T23:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    template: { task_title: weekly ? "形成复盘报告" : "分析昨日运行与遗留事项",
      objective: weekly ? "整理阶段产物和验收依据" : "形成可审阅的错误清单",
      criteria: ["列出关键失败与来源"], mode: "AI_ASSIST" },
    project: { title: "毕业论文", revision: "2", archived: false },
    ...(id === "sch-1" ? { occurrences: [occItem()] } : { occurrences: [] }) };
}

/** 按 occurrenceFrom 的字段名构造一条受阻触发记录（detail 页「触发记录」区块）。 */
function occItem() {
  return { occurrence_id: "occ-1", scheduled_task_id: "sch-1", project_id: projectId,
    sequence: "1", due_at: "2026-10-25T01:00:00Z", timezone: "Asia/Shanghai", missed: true,
    status: "BLOCKED", task_id: null, run_id: null, reason: "PREVIOUS_TASK_NOT_ACCEPTED",
    revision: "1", created_at: "2026-10-25T01:00:00Z" };
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("visual-mock-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/**
 * 连接状态只存在内存里，整页 goto 会退回 fixture 模式；
 * 因此连接后统一走应用内导航（导航栏链接 → 页内链接），保持 SPA 状态。
 */
const shots: readonly { name: string; settle: string; nav: (page: Page) => Promise<void> }[] = [
  { name: "today-live", settle: '[data-testid="today-query"]',
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "今日" }).click(); } },
  { name: "goal-detail-live", settle: '[data-testid="goal-detail-live"]',
    nav: async (page) => {
      await page.locator(".app-navrail").getByRole("link", { name: "项目" }).click();
      await page.getByTestId("goal-list-open").click();
      await page.locator('[data-testid^="goal-open-"]').first().click();
    } },
  { name: "reviews-live", settle: '[data-testid="review-inbox"]',
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "待处理" }).click(); } },
  { name: "scheduled-tasks-live", settle: '[data-testid="scheduled-tasks-stats"]',
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "定时任务" }).click(); } },
  { name: "scheduled-detail-live", settle: '[data-testid="scheduled-task-detail-head"]',
    nav: async (page) => {
      await page.locator(".app-navrail").getByRole("link", { name: "定时任务" }).click();
      await page.locator('[data-testid^="scheduled-task-row-"]').first().waitFor({ timeout: 15_000 });
      await page.locator('[data-testid^="scheduled-task-row-"] a').first().click();
    } },
  { name: "knowledge-live", settle: ".knowledge-columns",
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "资料" }).click(); } },
  { name: "activity-live", settle: ".activity-layout",
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "动态" }).click(); } },
  { name: "connections-live", settle: '[data-testid="connections-page-head"]',
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "连接与同步" }).click(); } },
  { name: "settings-live", settle: '[data-testid="settings-page"]',
    nav: async (page) => { await page.locator(".app-navrail").getByRole("link", { name: "设置" }).click(); } }
];

test.describe("live 页面视觉采集", () => {
  for (const shot of shots) {
    test(`capture ${shot.name}`, async ({ page }) => {
      mkdirSync(outDir, { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await installRoutes(page);
      await page.goto("/");
      await connect(page);
      await shot.nav(page);
      await page.locator(shot.settle).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      await page.screenshot({ path: resolve(outDir, `${shot.name}.png`), fullPage: true });
    });
  }
});
