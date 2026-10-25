import { expect, test, type Page, type Request, type Route } from "@playwright/test";

// N04/N06 的浏览器边界：页面与 HTTP 客户端走真实 Chromium，API 返回受控合同夹具。
// 不连接数据库、不创建真实 Task/Run；领域写入语义由独立 PostgreSQL 集成测试覆盖。
const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "55555555-5555-4555-8555-555555555555";
const chainId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const appOrigin = "http://127.0.0.1:4173";

const task = { id: taskId, project_id: projectId, title: "整理阶段交付", status: "READY", mode: "ME", revision: "4",
  executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null,
  blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: ["START"], updated_at: "2026-10-24T00:00:00Z",
  acceptance: { acceptance_revision: "2", objective: "交付已审阅的项目成果", expected_outputs: { artifacts: ["MARKDOWN_DOCUMENT"] },
    source: "USER_DECLARED", criteria: [{ criterion_id: "human", statement: "人工核对确切产物", required: true,
      method: "HUMAN", target_spec: {} }] }, dependencies: [] };

function cors(): Record<string, string> {
  return { "access-control-allow-origin": appOrigin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("n04-n06-browser-fixture");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor();
  await page.keyboard.press("Escape");
}

function planFixture(): Record<string, unknown> {
  return { plan_id: "77777777-7777-4777-8777-777777777777", project_id: projectId, revision: "1", item_id: null,
    item_status: null, created_task_id: null, title: "下一段工作", available_ms: "14400000",
    started_at: "2026-10-25T00:00:00.000Z", ends_at: "2026-10-25T04:00:00.000Z", remaining_ms: "14400000",
    expired: false, stale_reasons: [], time_warning: null, baseline: { tasks: [{ task_id: taskId, revision: "4" }] },
    items: [{ id: "88888888-8888-4888-8888-888888888888", task_id: taskId, title: task.title,
      kind: "TASK", status: "CANDIDATE", reason: "MAINLINE_OR_PREREQUISITE", budget_ms: 3600000,
      human_ms: 1200000, depends_on_task_ids: [], created_task_id: null, resolution_reason: null, output: null }],
    execution_admission: "NOT_GRANTED", permission_gaps: "CHECK_AT_EXECUTION",
    human_intervention: "SEE_BLOCKERS_AND_TASK_ACCEPTANCE" };
}

function chainFixture(status: "DRAFT" | "ACTIVE" | "PAUSING"): Record<string, unknown> {
  const revision = status === "DRAFT" ? "1" : status === "ACTIVE" ? "2" : "3";
  return { chain_id: chainId, project_id: projectId, status, revision,
    title: "有限任务链", baseline: { tool_scope: "INTERNAL_MARKDOWN_ARTIFACTS_ONLY" }, max_tasks: 1,
    max_model_calls: 3, task_reservations: 1, calls_started: 0, expires_at: status === "DRAFT" ? null : "2026-10-25T14:00:00Z", reason: null,
    control_request_id: status === "PAUSING" ? "99999999-9999-4999-8999-999999999999" : null, authorization_history: [],
    items: [{ item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ordinal: 0, task_id: taskId, status: "READY",
      baseline: { title: task.title }, execution_spec: {}, task_revision: "4", acceptance_revision: "2", run_id: null,
      completion_id: null, current_task_status: "READY", current_run_status: null }], model_usage: { recorded_calls: 0, uncertain_calls: 0,
      known_input_tokens: null, known_output_tokens: null, total_tokens: null, monetary_cost: null } };
}

async function installFixtures(page: Page, onRequest: (request: Request) => void): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
    if (path === "/health/ready") return json(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return json(route, { id: projectId, title: "真实项目",
      project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return json(route, { project_id: projectId, revision: "0",
      phase_key: "DISCOVERY", next_action_task_id: null, in_progress: [], blockers: [], risks: [],
      selected_artifact_version_refs: [], completed_highlight_refs: [], allowed_actions: [] });
    if (path === `${prefix}/projects/${projectId}/goals`) return json(route, { items: [] });
    if (path === `${prefix}/tasks` && url.searchParams.get("project_id") === projectId) {
      return json(route, { items: [{ ...task, acceptance: undefined, dependencies: undefined }], next_cursor: null });
    }
    if (path === `${prefix}/tasks/${taskId}/time-estimates`) return json(route, { task_id: taskId,
      current: { id: "estimate-1", task_id: taskId, revision: "1", acceptance_revision: "2", elapsed_ms: "3600000",
        execution_ms: null, waiting_ms: null, review_ms: null, human_ms: "1200000", source_note: "用户复盘声明",
        source_kind: "USER_DECLARED", created_at: "2026-10-24T00:00:00Z", applicable: true }, items: [] });
    if (path === `${prefix}/tasks/${taskId}`) return json(route, task);
    if (path === `${prefix}/reviews`) return json(route, { items: [] });
    if (path === `${prefix}/projects/${projectId}/period-plans`) {
      if (request.method() === "GET") return json(route, { project_id: projectId, items: state.plan === null ? [] : [state.plan] });
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.plan = planFixture();
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { plan_id: state.plan.plan_id, project_id: projectId, revision: "1", item_id: null, item_status: null, created_task_id: null } });
    }
    if (path === `${prefix}/period-plans/${String(planFixture().plan_id)}` && request.method() === "GET")
      return json(route, state.plan ?? planFixture());
    if (path === `${prefix}/projects/${projectId}/task-chains`) {
      if (request.method() === "GET") return json(route, { project_id: projectId, items: state.chainStatus === null ? [] : [chainFixture(state.chainStatus)] });
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.chainStatus = "DRAFT";
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { chain_id: chainId, project_id: projectId, status: "DRAFT", revision: "1" } }, 201);
    }
    if (path === `${prefix}/task-chains/${chainId}` && request.method() === "GET")
      return json(route, chainFixture(state.chainStatus ?? "DRAFT"));
    if (path === `${prefix}/task-chains/${chainId}/authorizations`) {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.chainStatus = "ACTIVE";
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { chain_id: chainId, project_id: projectId, status: "ACTIVE", revision: "2" } });
    }
    if (path === `${prefix}/task-chains/${chainId}/controls`) {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.chainStatus = "PAUSING";
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { chain_id: chainId, project_id: projectId, status: "PAUSING", revision: "3" } });
    }
    if (path === `${prefix}/period-plans/${String(planFixture().plan_id)}/scope-simulations`)
      return json(route, { source_plan_id: planFixture().plan_id, items: [] });
    return json(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

const state: { plan: Record<string, unknown> | null; chainStatus: "DRAFT" | "ACTIVE" | "PAUSING" | null } = {
  plan: null, chainStatus: null
};

test.describe("N04/N06 项目页面（真实 Chromium，受控 API）", () => {
  test.beforeEach(() => { state.plan = null; state.chainStatus = null; });

  test("计划提案只写入候选，不调用任务启动或 Delegate", async ({ page }) => {
    const writes: Request[] = [];
    await installFixtures(page, (request) => writes.push(request));
    await page.goto(`/projects/${projectId}/planning`);
    await connect(page);
    await expect(page.getByRole("heading", { name: "下一段工作" })).toBeVisible();
    await page.getByTestId(`planning-task-${taskId}`).locator(".planning-check input").first().check();
    await page.getByTestId(`planning-task-${taskId}`).locator(".planning-mainline input").check();
    await page.getByTestId("period-plan-propose").click();

    await expect(page.getByText("计划命令已核对，已读回并选中对应计划。")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url()).toContain(`/projects/${projectId}/period-plans`);
    expect(JSON.parse(writes[0]!.postData() ?? "{}")).toMatchObject({ task_ids: [taskId], mainline_task_ids: [taskId] });
    expect(writes.some((request) => /\/(runs|delegations)(\/|$)/u.test(new URL(request.url()).pathname))).toBe(false);
    await expect(page.getByText("接受计划不授权执行 · Run 准入未授予 · 每项接受都要独立处理")).toBeVisible();
  });

  test("创建任务链草稿与单独授权是两条命令", async ({ page }) => {
    const writes: Request[] = [];
    await installFixtures(page, (request) => writes.push(request));
    await page.goto(`/projects/${projectId}/task-chains`);
    await connect(page);
    await expect(page.getByRole("heading", { name: "有限任务链" })).toBeVisible();
    await page.locator(".task-chain-task-list input[type=checkbox]").check();
    await expect(page.getByText("验收 v2")).toBeVisible();
    await page.getByTestId("task-chain-create").click();
    await expect(page.getByTestId("task-chain-detail")).toContainText("草稿");
    await expect(page.getByLabel("明确任务链授权").getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByTestId("task-chain-authorize")).toBeDisabled();

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const localExpiry = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel(/授权截止时间/u).fill(localExpiry);
    await page.getByLabel(/我已核对这条固定任务链/u).check();
    await expect(page.getByTestId("task-chain-authorize")).toBeEnabled();
    await page.getByTestId("task-chain-authorize").click();
    await expect(page.getByTestId("task-chain-detail").getByText("已授权执行", { exact: true })).toBeVisible();
    await page.getByLabel(/停止理由/u).fill("用户请求暂停");
    await page.getByRole("button", { name: "请求安全暂停" }).click();
    await expect(page.getByTestId("task-chain-detail").getByText("正在安全停止", { exact: true })).toBeVisible();
    await expect(page.getByText("停止请求正在通过原控制机制安全处理，尚未确认暂停或撤销完成。")).toBeVisible();

    expect(writes).toHaveLength(3);
    expect(writes[0]!.url()).toContain(`/projects/${projectId}/task-chains`);
    expect(JSON.parse(writes[0]!.postData() ?? "{}")).toMatchObject({ confirmed: true,
      tasks: [{ task_id: taskId, expected_revision: "4", expected_acceptance_revision: "2" }] });
    expect(writes[1]!.url()).toContain(`/task-chains/${chainId}/authorizations`);
    expect(JSON.parse(writes[1]!.postData() ?? "{}")).toMatchObject({ confirmed: true, max_tasks: 1, max_model_calls: 3 });
    expect(writes[2]!.url()).toContain(`/task-chains/${chainId}/controls`);
    expect(JSON.parse(writes[2]!.postData() ?? "{}")).toMatchObject({ action: "PAUSE", reason: "用户请求暂停" });
  });
});
