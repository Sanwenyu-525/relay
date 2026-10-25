import { expect, test, type Page, type Request, type Route } from "@playwright/test";

// N04/N06 的浏览器边界：页面与 HTTP 客户端走真实 Chromium，API 返回受控合同夹具。
// 不连接数据库、不创建真实 Task/Run；领域写入语义由独立 PostgreSQL 集成测试覆盖。
const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "55555555-5555-4555-8555-555555555555";
const task2Id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const chainId = "66666666-6666-4666-8666-666666666666";
const planId = "77777777-7777-4777-8777-777777777777";
const selectedPlanId = "99999999-9999-4999-8999-999999999999";
const simulationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const itemId = "88888888-8888-4888-8888-888888888888";
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

function taskRow(id: string, title: string): Record<string, unknown> {
  return { ...task, id, title, acceptance: undefined, dependencies: undefined };
}

function planFixture(id: string = planId, revision = "1", itemStatus = "CANDIDATE"): Record<string, unknown> {
  return { plan_id: id, project_id: projectId, revision, item_id: null,
    item_status: null, created_task_id: null, title: "下一段工作", available_ms: "14400000",
    started_at: "2026-10-25T00:00:00.000Z", ends_at: "2026-10-25T04:00:00.000Z", remaining_ms: "14400000",
    expired: false, stale_reasons: [], time_warning: null,
    baseline: { tasks: [
      { task_id: taskId, title: task.title, revision: "4", acceptance_revision: "2", estimate_revision: "1", elapsed_ms: 3600000 },
      { task_id: task2Id, title: "独立收尾", revision: "4", acceptance_revision: "2", estimate_revision: "0", elapsed_ms: null }] },
    items: [{ id: itemId, task_id: taskId, title: task.title,
      kind: "TASK", status: itemStatus, reason: "MAINLINE_OR_PREREQUISITE", budget_ms: 3600000,
      human_ms: 1200000, depends_on_task_ids: [], created_task_id: null, resolution_reason: null, output: null },
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", task_id: task2Id, title: "独立收尾",
      kind: "TASK", status: itemStatus, reason: "REMAINING_CAPACITY", budget_ms: 1800000,
      human_ms: 600000, depends_on_task_ids: [], created_task_id: null, resolution_reason: null, output: null }],
    execution_admission: "NOT_GRANTED", permission_gaps: "CHECK_AT_EXECUTION",
    human_intervention: "SEE_BLOCKERS_AND_TASK_ACCEPTANCE" };
}

function simulationFixture(status: "PROPOSED" | "SELECTED"): Record<string, unknown> {
  const option = (kind: "ALL" | "SHRINK" | "DEFER") => ({ kind, task_ids: [taskId], retained_prerequisite_ids: [],
    excluded_task_ids: kind === "ALL" ? [] : [task2Id], requested_elapsed_ms: 3600000, requested_human_ms: 1200000,
    planned_ms: 3600000, capacity_gap_ms: null, unknown_estimate_task_ids: [], unreliable_task_ids: [],
    feasibility: "WITHIN_CAPACITY", items: [{ id: itemId, task_id: taskId, title: task.title, kind: "TASK",
      status: "CANDIDATE", reason: "MAINLINE_OR_PREREQUISITE", budget_ms: 3600000, human_ms: 1200000,
      depends_on_task_ids: [], created_task_id: null, resolution_reason: null, output: null }], consequences: [] });
  return { simulation_id: simulationId, source_plan_id: planId, project_id: projectId, revision: status === "SELECTED" ? "2" : "1",
    status, selected_option: status === "SELECTED" ? "SHRINK" : null,
    selected_plan_id: status === "SELECTED" ? selectedPlanId : null,
    baseline: {}, options: [option("ALL"), option("SHRINK"), option("DEFER")],
    created_at: "2026-10-25T00:00:00.000Z", selection_reason: status === "SELECTED" ? "保留当前主线" : null,
    stale_reasons: [], selected_plan: null, execution_admission: "NOT_GRANTED",
    permission_gaps: "CHECK_AT_EXECUTION", material_gaps: "CHECK_AT_EXECUTION", completion_date: null };
}

function chainFixture(status: "DRAFT" | "ACTIVE" | "PAUSING"): Record<string, unknown> {
  const revision = status === "DRAFT" ? "1" : status === "ACTIVE" ? "2" : "3";
  return { chain_id: chainId, project_id: projectId, status, revision,
    title: "有限任务链", baseline: { tool_scope: "INTERNAL_MARKDOWN_ARTIFACTS_ONLY" }, max_tasks: 1,
    max_model_calls: 3, task_reservations: 1, calls_started: 0, expires_at: status === "DRAFT" ? null : "2026-10-25T14:00:00Z", reason: null,
    control_request_id: status === "PAUSING" ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd" : null,
    authorization_history: state.authorizationHistory,
    items: [{ item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ordinal: 0, task_id: taskId, status: "READY",
      baseline: { title: task.title }, execution_spec: {}, task_revision: "4", acceptance_revision: "2", run_id: null,
      completion_id: null, current_task_status: "READY", current_run_status: null }], model_usage: { recorded_calls: 0, uncertain_calls: 0,
      known_input_tokens: null, known_output_tokens: null, total_tokens: null, monetary_cost: null } };
}

const state: { plans: Record<string, unknown>[]; simulations: Record<string, unknown>[];
  chainStatus: "DRAFT" | "ACTIVE" | "PAUSING" | null; authorizationHistory: Record<string, unknown>[];
  estimateCurrent: Record<string, unknown> | null; estimateItems: Record<string, unknown>[];
  taskPages: Record<string, unknown>[][]; receipts: Map<string, { command_type: string; result: Record<string, unknown> }>;
  failNextPlanPropose: boolean; failNextChainCreate: boolean } = {
  plans: [], simulations: [], chainStatus: null, authorizationHistory: [], estimateCurrent: null,
  estimateItems: [], taskPages: [], receipts: new Map(), failNextPlanPropose: false, failNextChainCreate: false };

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
      const pages = state.taskPages.length > 0 ? state.taskPages : [[{ ...task, acceptance: undefined, dependencies: undefined }]];
      const cursor = url.searchParams.get("cursor");
      const index = cursor === null ? 0 : Number(cursor);
      const items = pages[index] ?? [];
      return json(route, { items, next_cursor: index + 1 < pages.length ? String(index + 1) : null });
    }
    if (path === `${prefix}/tasks/${taskId}/time-estimates` && request.method() === "GET")
      return json(route, { task_id: taskId, current: state.estimateCurrent, items: state.estimateItems });
    if (path === `${prefix}/tasks/${taskId}/time-estimates` && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      const saved = { id: "estimate-browser-1", task_id: taskId, revision: "1", acceptance_revision: "2",
        elapsed_ms: String(body.elapsed_ms ?? "0"), execution_ms: body.execution_ms === null ? null : String(body.execution_ms),
        waiting_ms: body.waiting_ms === null ? null : String(body.waiting_ms), review_ms: body.review_ms === null ? null : String(body.review_ms),
        human_ms: body.human_ms === null ? null : String(body.human_ms), source_note: body.source_note,
        source_kind: "USER_DECLARED", created_at: "2026-10-26T00:00:00.000Z", applicable: true };
      state.estimateCurrent = saved;
      state.estimateItems = [saved];
      return json(route, { command_id: body.command_id, committed_at: "2026-10-26T00:00:00.000Z",
        result: { task_id: taskId, estimate_id: saved.id, revision: saved.revision } });
    }
    if (path === `${prefix}/tasks/${taskId}`) return json(route, task);
    if (path === `${prefix}/reviews`) return json(route, { items: [] });
    if (path === `${prefix}/projects/${projectId}/period-plans` && request.method() === "GET")
      return json(route, { project_id: projectId, items: state.plans });
    if (path === `${prefix}/projects/${projectId}/period-plans` && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      const plan = planFixture();
      state.plans = [plan];
      state.receipts.set(String(body.command_id), { command_type: "ProposePeriodPlan",
        result: { plan_id: plan.plan_id, project_id: projectId, revision: plan.revision,
          item_id: null, item_status: null, created_task_id: null } });
      if (state.failNextPlanPropose) return route.abort("connectionreset");
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { plan_id: plan.plan_id, project_id: projectId, revision: "1", item_id: null, item_status: null, created_task_id: null } });
    }
    if (/\/period-plans\/[^/]+\/items\/[^/]+\/resolutions$/u.test(path) && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      const found = state.plans.find((plan) => path.startsWith(`${prefix}/period-plans/${String(plan.plan_id)}/`));
      if (found !== undefined) {
        found.revision = String(Number(found.revision) + 1);
        const items = found.items as Record<string, unknown>[];
        const itemIdInPath = path.split("/").at(-2);
        const item = items.find((row) => String(row.id) === itemIdInPath);
        if (item !== undefined) { item.status = body.action === "ACCEPT" ? "ACCEPTED" : "REJECTED"; item.resolution_reason = body.reason; }
      }
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { plan_id: found?.plan_id ?? planId, project_id: projectId, revision: found?.revision ?? "1",
          item_id: path.split("/").at(-2), item_status: body.action === "ACCEPT" ? "ACCEPTED" : "REJECTED",
          created_task_id: null } });
    }
    if (path.startsWith(`${prefix}/period-plans/`) && path.endsWith("/scope-simulations") && request.method() === "GET")
      return json(route, { source_plan_id: planId, items: state.simulations });
    if (path.startsWith(`${prefix}/period-plans/`) && path.endsWith("/scope-simulations") && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      const simulation = simulationFixture("PROPOSED");
      state.simulations = [simulation];
      state.receipts.set(String(body.command_id), { command_type: "ProposeScopeSimulation",
        result: { simulation_id: simulationId, source_plan_id: planId, project_id: projectId,
          revision: "1", status: "PROPOSED", selected_option: null, selected_plan_id: null } });
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { simulation_id: simulationId, source_plan_id: planId, project_id: projectId,
          revision: "1", status: "PROPOSED", selected_option: null, selected_plan_id: null } });
    }
    if (/\/scope-simulations\/[^/]+\/selections$/u.test(path) && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      const simulation = state.simulations.find((row) => row.simulation_id === simulationId);
      if (simulation !== undefined) { simulation.status = "SELECTED"; simulation.selected_option = body.option;
        simulation.selected_plan_id = selectedPlanId; simulation.revision = "2"; simulation.selection_reason = body.reason; }
      if (!state.plans.some((plan) => plan.plan_id === selectedPlanId)) state.plans = [...state.plans, planFixture(selectedPlanId)];
      state.receipts.set(String(body.command_id), { command_type: "SelectScopeSimulation",
        result: { simulation_id: simulationId, source_plan_id: planId, project_id: projectId,
          revision: "2", status: "SELECTED", selected_option: body.option, selected_plan_id: selectedPlanId } });
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { simulation_id: simulationId, source_plan_id: planId, project_id: projectId,
          revision: "2", status: "SELECTED", selected_option: body.option, selected_plan_id: selectedPlanId } });
    }
    if (path.startsWith(`${prefix}/period-plans/`) && request.method() === "GET") {
      const id = path.split("/").at(-1);
      const plan = state.plans.find((row) => row.plan_id === id);
      if (plan === undefined) return json(route, { code: "NOT_FOUND", detail: "plan" }, 404);
      return json(route, plan);
    }
    if (/\/scope-simulations\/[^/]+$/u.test(path) && request.method() === "GET") {
      const simulation = state.simulations.find((row) => row.simulation_id === path.split("/").at(-1));
      if (simulation === undefined) return json(route, { code: "NOT_FOUND", detail: "simulation" }, 404);
      return json(route, simulation);
    }
    if (path === `${prefix}/projects/${projectId}/task-chains` && request.method() === "GET")
      return json(route, { project_id: projectId, items: state.chainStatus === null ? [] : [chainFixture(state.chainStatus)] });
    if (path === `${prefix}/projects/${projectId}/task-chains` && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.chainStatus = "DRAFT";
      state.receipts.set(String(body.command_id), { command_type: "CreateTaskChain",
        result: { chain_id: chainId, project_id: projectId, status: "DRAFT", revision: "1" } });
      if (state.failNextChainCreate) return route.abort("connectionreset");
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { chain_id: chainId, project_id: projectId, status: "DRAFT", revision: "1" } }, 201);
    }
    if (path === `${prefix}/task-chains/${chainId}` && request.method() === "GET")
      return json(route, chainFixture(state.chainStatus ?? "DRAFT"));
    if (path === `${prefix}/task-chains/${chainId}/authorizations` && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.authorizationHistory.push({ command_id: body.command_id, max_tasks: body.max_tasks,
        max_model_calls: body.max_model_calls, expires_at: body.expires_at });
      state.chainStatus = "ACTIVE";
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { chain_id: chainId, project_id: projectId, status: "ACTIVE", revision: "2" } });
    }
    if (path === `${prefix}/task-chains/${chainId}/controls` && request.method() === "POST") {
      onRequest(request);
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      state.chainStatus = "PAUSING";
      return json(route, { command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: { chain_id: chainId, project_id: projectId, status: "PAUSING", revision: "3" } });
    }
    if (path.startsWith(`${prefix}/commands/`) && request.method() === "GET") {
      const commandId = decodeURIComponent(path.split("/").at(-1) ?? "");
      const receipt = state.receipts.get(commandId);
      if (receipt === undefined) return json(route, { code: "NOT_FOUND", detail: "command receipt" }, 404);
      // 回执查询期间另一页面把链从 DRAFT 合法授权至 ACTIVE（带独立 command_id 的授权历史）。
      if (receipt.command_type === "CreateTaskChain" && state.chainStatus === "DRAFT") {
        state.chainStatus = "ACTIVE";
        state.authorizationHistory.push({ command_id: "other-page-command", max_tasks: 1, max_model_calls: 3,
          expires_at: "2026-10-26T00:00:00Z" });
      }
      return json(route, { command_id: commandId, command_type: receipt.command_type,
        committed_at: "2026-10-25T00:00:00.000Z", result: receipt.result });
    }
    return json(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

test.describe("N04/N06 项目页面（真实 Chromium，受控 API）", () => {
  test.beforeEach(() => { state.plans = []; state.simulations = []; state.chainStatus = null; state.authorizationHistory = [];
    state.estimateCurrent = null; state.estimateItems = []; state.taskPages = []; state.receipts = new Map();
    state.failNextPlanPropose = false; state.failNextChainCreate = false; });

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

  test("范围推演三方案与选择后的逐项决策都是独立命令", async ({ page }) => {
    const writes: Request[] = [];
    state.plans = [planFixture()];
    state.taskPages = [[taskRow(taskId, task.title), taskRow(task2Id, "独立收尾")]];
    await installFixtures(page, (request) => writes.push(request));
    await page.goto(`/projects/${projectId}/planning`);
    await connect(page);
    await expect(page.getByRole("heading", { name: "下一段工作" })).toBeVisible();

    const scopeRows = page.locator(".planning-scope-row");
    await scopeRows.nth(0).locator('input[type="checkbox"]').first().check();
    await scopeRows.nth(1).locator('input[type="checkbox"]').nth(1).check();
    await page.locator(".planning-scope button", { hasText: "生成 ALL / SHRINK / DEFER 推演" }).click();
    await expect(page.getByText("范围推演命令已核对，已读回并选中对应推演。")).toBeVisible();
    for (const option of ["ALL", "SHRINK", "DEFER"]) {
      await expect(page.getByTestId(`scope-option-${option}`)).toBeVisible();
    }
    await expect(page.getByTestId("scope-option-ALL")).toContainText("全部候选");
    await expect(page.getByTestId("scope-option-SHRINK")).toContainText("保留主线与必要前置");
    await expect(page.getByTestId("scope-option-DEFER")).toContainText("延后指定范围");

    await page.locator('input[placeholder="说明为什么采用此范围"]').fill("保留当前主线");
    await page.getByTestId("scope-option-SHRINK").getByRole("button").click();
    await expect(page.getByText("范围选择命令已核对，已读回并选中新计划与推演。")).toBeVisible();
    await expect(page.getByLabel("选择计划版本")).toHaveValue(selectedPlanId);

    await page.locator('input[placeholder="说明接受或拒绝的依据"]').fill("按推演结果接受");
    await page.getByTestId(`period-plan-item-${itemId}`).getByRole("button", { name: "接受此项" }).click();
    await expect(page.getByText("计划项命令已核对，已读回对应计划和处理状态。")).toBeVisible();
    await expect(page.getByTestId(`period-plan-item-${itemId}`)).toContainText("已接受");

    expect(writes).toHaveLength(3);
    expect(writes[0]!.url()).toContain(`/period-plans/${planId}/scope-simulations`);
    expect(JSON.parse(writes[0]!.postData() ?? "{}")).toMatchObject({ keep_task_ids: [taskId], defer_task_ids: [task2Id] });
    expect(writes[1]!.url()).toContain(`/scope-simulations/${simulationId}/selections`);
    expect(JSON.parse(writes[1]!.postData() ?? "{}")).toMatchObject({ option: "SHRINK", confirmed: true });
    expect(JSON.parse(writes[2]!.postData() ?? "{}")).toMatchObject({ action: "ACCEPT", reason: "按推演结果接受" });
    expect(writes.some((request) => /\/(runs|delegations)(\/|$)/u.test(new URL(request.url()).pathname))).toBe(false);
  });

  test("用户估时写入读回，旧验收估时明确标为失效", async ({ page }) => {
    const writes: Request[] = [];
    state.estimateCurrent = { id: "estimate-old", task_id: taskId, revision: "1", acceptance_revision: "1",
      elapsed_ms: "600000", execution_ms: null, waiting_ms: "120000", review_ms: null, human_ms: null,
      source_note: "旧验收阶段复盘", source_kind: "USER_DECLARED", created_at: "2026-10-20T00:00:00.000Z", applicable: false };
    state.estimateItems = [state.estimateCurrent];
    await installFixtures(page, (request) => writes.push(request));
    await page.goto(`/projects/${projectId}/planning`);
    await connect(page);
    const estimate = page.getByTestId(`planning-task-${taskId}`).locator(".planning-estimate");
    await expect(estimate).toContainText("旧估时失效：来自验收 v1");
    await expect(estimate).toContainText("当前验收不适用");

    await page.getByTestId(`planning-task-${taskId}`).locator(".planning-estimate-editor summary").click();
    const inputs = page.getByTestId(`planning-task-${taskId}`).locator(".planning-estimate-editor input");
    await inputs.nth(0).fill("12");
    await inputs.nth(5).fill("基于最近三次复盘");
    await page.getByTestId(`planning-task-${taskId}`).getByRole("button", { name: "保存用户声明估时" }).click();

    await expect(page.getByText("用户声明估时已记录并读回，适用于当前验收版本。")).toBeVisible();
    await expect(estimate).toContainText("当前验收适用 · 总时长 12 分钟 · 执行 未知 · 等待 未知 · 复核 未知 · 人工 未知");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url()).toContain(`/tasks/${taskId}/time-estimates`);
    expect(JSON.parse(writes[0]!.postData() ?? "{}")).toMatchObject({ confirmed: true,
      expected_task_revision: "4", expected_estimate_revision: "1", elapsed_ms: 720000, source_note: "基于最近三次复盘" });
  });

  test("计划命令响应丢失后保留原命令，并用原回执恢复", async ({ page }) => {
    const writes: Request[] = [];
    state.failNextPlanPropose = true;
    await installFixtures(page, (request) => writes.push(request));
    await page.goto(`/projects/${projectId}/planning`);
    await connect(page);
    await page.getByTestId(`planning-task-${taskId}`).locator(".planning-check input").first().check();
    await page.getByTestId("period-plan-propose").click();

    const pending = page.getByTestId("planning-pending-command");
    await expect(pending).toBeVisible();
    await expect(page.getByRole("heading", { name: "命令结果待核对" })).toBeVisible();

    await pending.getByRole("button", { name: "查询原命令回执" }).click();
    await expect(page.getByText("已使用原回执恢复，没有重新提交")).toBeVisible();
    await expect(page.getByLabel("选择计划版本")).toHaveValue(planId);
    expect(writes).toHaveLength(1);
  });

  test("任务链创建、授权和暂停是三条独立命令", async ({ page }) => {
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

  test("任务链创建响应丢失后被另一页面授权，原命令按当前 ACTIVE 恢复", async ({ page }) => {
    const writes: Request[] = [];
    state.failNextChainCreate = true;
    await installFixtures(page, (request) => writes.push(request));
    await page.goto(`/projects/${projectId}/task-chains`);
    await connect(page);
    await page.locator(".task-chain-task-list input[type=checkbox]").check();
    await page.getByTestId("task-chain-create").click();

    const pending = page.getByTestId("task-chain-pending");
    await expect(pending).toBeVisible();
    await expect(page.getByRole("heading", { name: "命令结果待核对" })).toBeVisible();

    // 回执查询期间另一页面把链授权至 ACTIVE（回执处理器内推进状态）。
    await pending.getByRole("button", { name: "查询原命令回执" }).click();
    await expect(page.getByText("已使用原回执恢复，没有再次提交")).toBeVisible();
    await expect(page.getByTestId("task-chain-detail")).toContainText("已授权执行");
    expect(writes).toHaveLength(1);
    expect(writes.every((request) => request.url().endsWith(`/projects/${projectId}/task-chains`))).toBe(true);
  });

  test("390px 窄窗下计划页无横向溢出，长列表分页加载不丢失", async ({ page }) => {
    state.taskPages = [
      Array.from({ length: 20 }, (_, index) => taskRow(`${String(taskId).slice(0, -2)}${String(index).padStart(2, "0")}`, `任务 ${index + 1}`)),
      Array.from({ length: 5 }, (_, index) => taskRow(`${String(taskId).slice(0, -2)}${String(20 + index).padStart(2, "0")}`, `任务 ${21 + index}`))];
    await installFixtures(page, () => {});
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/projects/${projectId}/planning`);
    await connect(page);
    await expect(page.getByRole("heading", { name: "下一段工作" })).toBeVisible();
    await expect(page.locator(".planning-task-row")).toHaveCount(20);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "加载更多任务" }).click();
    await expect(page.locator(".planning-task-row")).toHaveCount(25);
    expect(await overflow()).toBeLessThanOrEqual(1);
  });

  test("估时草稿离开被拦截，保留后焦点回到估时输入", async ({ page }) => {
    await installFixtures(page, () => {});
    await page.goto(`/projects/${projectId}/planning`);
    await connect(page);
    const editor = page.getByTestId(`planning-task-${taskId}`).locator(".planning-estimate-editor");
    await editor.locator("summary").click();
    await editor.locator("input").nth(0).fill("12");
    await editor.locator("input").nth(5).fill("键盘恢复检查");

    await page.getByRole("link", { name: "任务链" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("即将离开的页面还有未保存的修改");
    await expect(editor.locator("input").nth(0)).toHaveValue("12");

    await dialog.getByRole("button", { name: "保留并继续编辑" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "下一段工作" })).toBeVisible();
    const focusInside = await page.evaluate((selector) =>
      Boolean(document.activeElement instanceof HTMLElement &&
        document.activeElement.closest(selector)), `#planning-estimate-editor-${taskId}`);
    expect(focusInside).toBe(true);
    await expect(editor.locator("input").nth(0)).toHaveValue("12");
  });
});
