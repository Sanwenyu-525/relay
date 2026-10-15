import { test, type Page, type Route } from "@playwright/test";

/**
 * V4.2 原型对齐的截图核对（真实 Chromium + 页面内拦截伪造 API）。
 *
 * 只用于人工比对「页壳 + 工作台 + 工作详情面板」与 GPT页面原型/Relay_V4.2 的差异，
 * 不做断言——几何与行为的正式回归在 tests/browser 下。
 * 夹具形状对齐 tests/collaborationWorkspace.spec.ts 里已被解析器接受的那一套；
 * 不连数据库、不调 Provider，未被消费的端点如实 404。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const sessionId = "66666666-6666-4666-8666-666666666666";
const reviewId = "77777777-7777-4777-8777-777777777777";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4174";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const projectSummary = {
  id: projectId, title: "Windows 桌面验收", project_type: "DEVELOPMENT",
  revision: "1", state_revision: "1", archived_at: null, archive_status: "ACTIVE",
  phase_key: "DEVELOPMENT", next_action_task_id: null,
  created_at: "2026-10-01T01:00:00Z", updated_at: "2026-10-14T12:00:00Z"
};

const task = {
  id: taskId, project_id: projectId, title: "桌面端验收 · 中文详情与条件编辑", status: "IN_PROGRESS", mode: "DELEGATE_AI",
  revision: "4", executor: { kind: "AI", run_id: runId, ownership_epoch: "1" },
  current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  dependencies: [], updated_at: "2026-10-14T12:00:00Z",
  acceptance: {
    acceptance_revision: "3", objective: "核对 Windows 桌面端的中文详情、条件编辑与关联工作，形成可复核的验收依据。",
    source: "HUMAN",
    criteria: [
      { criterion_id: "c1", statement: "中文详情页在长文案下不截断、不横向溢出。", required: true, method: "HUMAN", target_spec: {} },
      { criterion_id: "c2", statement: "条件编辑保存失败时给出可执行的错误反馈，并保留原文。", required: true, method: "HUMAN", target_spec: {} },
      { criterion_id: "c3", statement: "切换会话后未发送草稿仍然保留。", required: false, method: "HUMAN", target_spec: {} }
    ]
  }
};

const run = {
  id: runId, task_id: taskId, status: "RUNNING", revision: "6", wait_reason: null,
  current_step_id: "step-3",
  steps: [
    { step_id: "step-1", step_index: 0, step_kind: "BUILD_CONTEXT", status: "SUCCEEDED", started_at: "2026-10-14T11:00:00Z", finished_at: "2026-10-14T11:01:00Z", reason: null },
    { step_id: "step-2", step_index: 1, step_kind: "DRAFT", status: "SUCCEEDED", started_at: "2026-10-14T11:02:00Z", finished_at: "2026-10-14T11:12:00Z", reason: null },
    { step_id: "step-3", step_index: 2, step_kind: "VERIFY", status: "RUNNING", started_at: "2026-10-14T11:13:00Z", finished_at: null, reason: null },
    { step_id: "step-4", step_index: 3, step_kind: "COMPLETE", status: "PENDING", started_at: null, finished_at: null, reason: null }
  ],
  recent_attempts: [], blocking_review_ids: [], pending_control_request: null, unresolved_operation_ids: []
};

const review = {
  id: reviewId, kind: "CRITERION", status: "OPEN", revision: "1", project_id: projectId, task_id: taskId, run_id: runId,
  operation_id: null, reason: "AWAITING_HUMAN_EVIDENCE", target_hash: "b".repeat(64),
  target: { acceptance_revision: "3", criterion_id: "c1" },
  evidence: { check_result: "自动检查不能代替人工判断" }, effect: { on_accept: "重新核对完成条件" },
  allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
  created_at: "2026-10-14T11:14:00Z", decided_at: null
};

const session = {
  id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "桌面端验收工作会话", status: "ACTIVE", revision: "1", updated_at: "2026-10-14T11:00:00Z"
};

function message(id: string, role: "USER" | "ASSISTANT", content: string) {
  return { id, session_id: sessionId, seq: "1", role, status: "COMPLETED",
    intent: role === "USER" ? "DISCUSS" : null, content, error_code: null,
    sources: [], usage: { input_tokens: null, output_tokens: null }, cancel_requested: false };
}

async function installApi(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return json(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return json(route, { items: [task], next_cursor: null });
    if (path === `${prefix}/projects`) return json(route, { items: [projectSummary], next_cursor: null });
    if (path === `${prefix}/projects/${projectId}`) return json(route, projectSummary);
    if (path === `${prefix}/projects/${projectId}/state`) return json(route, { project_id: projectId, revision: "1",
      phase_key: "DEVELOPMENT", next_action_task_id: null, selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/tasks/${taskId}`) return json(route, task);
    if (path === `${prefix}/tasks/${taskId}/artifacts`) return json(route, { items: [], current_accepted_version_ids: [] });
    if (path === `${prefix}/runs/${runId}`) return json(route, run);
    if (path === `${prefix}/runs/${runId}/operations`) return json(route, []);
    if (path === `${prefix}/runs/${runId}/tool-calls`) return json(route, { run_id: runId, run_status: "RUNNING", wait_reason: null, rounds: [] });
    if (path === `${prefix}/runs/${runId}/draft-preview`) return json(route, { run_id: runId, run_status: "RUNNING",
      preview_available: false, preview_text: null, preview_revision: "0", preview_truncated: false,
      step_attempt_id: null, attempt_claim_epoch: null, model_call_id: null });
    if (path.startsWith(`${prefix}/runs/${runId}/events`)) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: cors(), body: "" });
    }
    if (path === `${prefix}/reviews`) return json(route, { items: [review] });
    if (path === `${prefix}/reviews/${reviewId}`) return json(route, review);
    if (path === `${prefix}/assist-sessions`) return json(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return json(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return json(route, { items: [
      message("m1", "USER", "继续检查 Windows 桌面端的中文详情、条件编辑和关联工作，完成后告诉我哪些地方需要调整。"),
      message("m2", "ASSISTANT", "已经完成现有界面和需求分析，正在检查中文详情与交互逻辑。你可以继续补充要求，我会尽量不中断当前工作。")
    ] });
    if (path === `${prefix}/conversation-execution-requests`) return json(route, { items: [] });
    if (path === `${prefix}/assist-proposals`) return json(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return json(route, { items: [] });
    if (path === `${prefix}/projects/${projectId}/managed-resources`) return json(route, [{ id: "res-1", project_id: projectId,
      canonical_root: "D:\\Projects\\Relay", status: "ACTIVE", revision: "1", resource_epoch: "0", file_write_identity_bound: true }]);
    if (path.startsWith(`${prefix}/projects/${projectId}/connections`)) return json(route, []);
    if (path === `${prefix}/model-port`) return json(route, { provider: "openai-compatible", configured: true,
      model: "local-model", base_url: null, max_call_tokens: 65536 });
    if (path === `${prefix}/model-port/verification`) return json(route, { current_config_fingerprint: null, last: null,
      matches_current_config: false, worker_startup_validation: "NOT_CONFIGURED" });
    if (path.startsWith(`${prefix}/search`)) return json(route, { items: [], next_cursor: null });
    await route.fulfill({ status: 404, contentType: "application/json", headers: cors(), body: '{"code":"NOT_FOUND"}' });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ui-refactor-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test("工作台 · 宽窗三栏与工作详情面板", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installApi(page);
  // 连接只活在内存里：必须先落到目标路由再连接，goto 会把连接状态一起刷掉。
  await page.goto(`/agent?work=${taskId}`);
  await connect(page);
  await page.getByTestId("collab-inspector").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: "artifacts/screenshots/v42-agent-progress.png" });
  await page.getByTestId("collab-inspector-tab-RESULTS").click();
  await page.screenshot({ path: "artifacts/screenshots/v42-agent-results.png" });
  await page.getByTestId("collab-inspector-tab-RECORDS").click();
  await page.screenshot({ path: "artifacts/screenshots/v42-agent-records.png" });
});

test("工作台 · 窄窗（工作详情改为浮层）", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 820 });
  await installApi(page);
  await page.goto(`/agent?work=${taskId}`);
  await connect(page);
  await page.getByTestId("collab-inspector").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: "artifacts/screenshots/v42-agent-narrow.png" });
});

test("页壳 · 项目列表（token 换色后的全站基线）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/projects");
  await page.screenshot({ path: "artifacts/screenshots/v42-shell-projects.png" });
});
