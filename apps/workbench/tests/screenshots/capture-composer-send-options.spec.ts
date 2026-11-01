import { expect, test, type Page, type Route } from "@playwright/test";

// 临时截图脚手架（UI-FEAT-01-R2 验收证据）。只连页面内夹具，不连数据库、不调 Provider。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const port = process.env.RELAY_E2E_PORT ?? "4173";
const origin = `http://127.0.0.1:${port}`;
const shotDir = process.env.UI_FEAT_SHOT_DIR ?? "D:/Develop/Relay-Agent/tmp/UI-FEAT-01-conversation-workflow";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}
async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

const skill = (id: string, version: string, title: string, target: string,
  outputKind: string, extra: Record<string, unknown> = {}) => ({
  id, version, title, target, output_kind: outputKind,
  availability: "CALLABLE_READ_ONLY", call_supported: true, accept_supported: false,
  missing_capabilities: [], required_capabilities: [],
  dependencies: [{ kind: "PACK", id: "core-pack", version: "1.0.0", sha256: "b".repeat(64) }],
  sha256: "a".repeat(64), ...extra });

const skills = [
  skill("project-resume", "1.0.0", "项目续接摘要", "PROJECT", "PROJECT_RESUME"),
  skill("task-to-execution-contract", "1.0.0", "任务执行契约", "TASK", "TASK_DEFINITION_SUGGESTION"),
  skill("verification-plan", "1.0.0", "验证计划", "TASK", "VERIFICATION_PLAN_SUGGESTION",
    { call_supported: false, availability: "HISTORICAL_ONLY" })
];

const message = { id: "77777777-7777-4777-8777-777777777777", session_id: sessionId,
  role: "USER", status: "COMPLETED", seq: "1", intent: "DISCUSS", content: "先帮我把实验评价指标的基线补齐。",
  error_code: null, provider_error_kind: null, cancel_requested: false, steer_requested: false,
  usage: { input_tokens: 0, output_tokens: 0 }, sources: [], skill: null, skill_input: null, skill_output: null,
  attachments: [], created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z", revision: "1" };

const reply = { ...message, id: "88888888-8888-4888-8888-888888888888", role: "ASSISTANT", seq: "2",
  content: "好的。先把基线拆成三条：数据集版本、切分方式、评价脚本版本。\n\n这三条任一变动，指标就不可比。"
    + "建议先把当前基线写成一份可核对的快照，再谈指标口径。" };

function searchResults() {
  return { items: Array.from({ length: 8 }, (_unused, index) => {
    const id = `bbbbbbbb${index}-0000-4000-8000-000000000000`;
    return { type: "KNOWLEDGE", id, version: "1", title: `基线资料 ${index + 1}`,
      snippet: `第 ${index + 1} 条命中片段。`, matched_fields: ["title"],
      source_ref: `knowledge:${id}:v1`, status: "ACTIVE", project_id: projectId };
  }), next_cursor: null };
}

/** 必读文件审计：state=OK 且 severity=NONE 时组件不渲染任何横幅，截图里就没有夹具噪声。 */
const auditNone = {
  state: "OK", detail: "已扫描", root: "D:\\Work\\Research",
  agent: { id: "claude-code", label: "本机助手" },
  scanned_at: "2026-11-01T00:00:00Z", fingerprint: "fixture-none", severity: "NONE",
  files: [], reasons: [], suggestions: [], skipped: [], access: null,
  budget: { call_budget_source: "APPLICATION_DEFAULT", effective_basis: "CALL_BUDGET",
    confidence: "EXACT_WINDOW", provider_window_tokens: 128000, provider_window_known: true,
    call_budget_tokens: 32000, effective_input_tokens: 28000,
    reserves: { output_tokens: 4000, system_prompt_tokens: 2000, tool_definition_tokens: 1000,
      history_tokens: 0 },
    estimated_total_input_tokens: 0, required_total_tokens: 0, required_total_share: 0,
    estimate: { method: "BYTES_PER_TOKEN", bytes_per_token: 4, note: "夹具" } },
  thresholds: { single_file: { notice: 0.2, high: 0.4, severe: 0.6 },
    total_files: { notice: 0.2, high: 0.4, severe: 0.6 } }
};

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path.endsWith("/required-context-audit")) return fulfillJson(route, auditNone);
    if (path.endsWith("/plans")) return fulfillJson(route, { latest: null, versions: [] });
    if (path.endsWith("/goal")) return fulfillJson(route, { goal: null, rounds: [] });
    if (path.endsWith("/activity")) return fulfillJson(route, { schema_version: 1,
      session: { id: sessionId, workspace_id: workspaceId },
      generated_at: "2026-11-01T00:00:00Z", snapshot_at: "2026-11-01T00:00:00Z",
      messages: [], next_before_seq: null, has_more: false });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId, project_id: projectId,
      title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME", revision: "2",
      created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
      allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/search`) return fulfillJson(route, searchResults());
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: null, status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return fulfillJson(route, { items: [message, reply] });
    }
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: skills });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ui-feat-01-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openSession(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await installRoutes(page);
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
}

async function measurePanel(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="assist-composer"]');
    const panel = root?.querySelector(".agent-chat-send-options > .agent-chat-options-panel") ?? null;
    const chip = root?.querySelector(".agent-chat-send-options > summary") ?? null;
    const send = root?.querySelector('[data-testid="assist-send"]') ?? null;
    if (panel === null || chip === null) return null;
    const rect = panel.getBoundingClientRect();
    const sendRect = send?.getBoundingClientRect() ?? null;
    const overlap = sendRect === null ? 0
      : Math.max(0, Math.min(rect.right, sendRect.right) - Math.max(rect.left, sendRect.left)) *
        Math.max(0, Math.min(rect.bottom, sendRect.bottom) - Math.max(rect.top, sendRect.top));
    return { width: Math.round(rect.width), height: Math.round(rect.height),
      scrollHeight: panel.scrollHeight, top: Math.round(rect.top),
      viewportHeight: window.innerHeight, textLength: (panel.textContent ?? "").replace(/\s+/gu, " ").trim().length,
      chipLabel: (chip.textContent ?? "").trim(), sendOverlap: Math.round(overlap),
      scrolls: panel.scrollHeight > panel.clientHeight + 1,
      hasNativeSelect: panel.querySelector("select") !== null,
      radioCount: panel.querySelectorAll('input[type="radio"]').length,
      radioChecked: panel.querySelectorAll('input[type="radio"]:checked').length };
  });
}

test("evidence", async ({ page }) => {
  await openSession(page, { width: 1162, height: 782 });
  const composer = page.getByTestId("assist-composer");
  await composer.waitFor({ timeout: 20_000 });

  // 1. 默认态：只有发送方式与一行资料，资料检索表单不在默认展开状态。
  await page.getByTestId("assist-open-sources").click();
  await page.waitForTimeout(350);
  const collapsed = await measurePanel(page);
  await page.screenshot({ path: `${shotDir}/01-default-dialog.png` });
  await page.locator(".agent-chat-send-options > .agent-chat-options-panel")
    .screenshot({ path: `${shotDir}/01-default-panel.png` });
  expect(await composer.getByTestId("assist-source-picker").isVisible()).toBe(false);

  // 2. 工作方式：选中「任务提案」，入口芯片同步改名。
  await composer.getByTestId("assist-send-mode-PROPOSE_TASK").check();
  await page.waitForTimeout(200);
  const taskMode = await measurePanel(page);
  await page.locator(".agent-chat-send-options > .agent-chat-options-panel")
    .screenshot({ path: `${shotDir}/02-work-mode-selected.png` });

  // 3. Skill 选中：入口显示 Skill 名，详情默认收起。
  await composer.getByTestId("assist-send-skill-0").check();
  await page.waitForTimeout(200);
  const skillSelected = await measurePanel(page);
  await page.locator(".agent-chat-send-options > .agent-chat-options-panel")
    .screenshot({ path: `${shotDir}/03-skill-selected.png` });
  await composer.getByTestId("assist-skill-detail").locator("summary").click();
  await page.waitForTimeout(200);
  await page.locator(".agent-chat-send-options > .agent-chat-options-panel")
    .screenshot({ path: `${shotDir}/03b-skill-detail-expanded.png` });

  // 4. 展开资料：同一片浮层里出现检索表单。
  await composer.getByTestId("assist-send-sources-toggle").click();
  await page.waitForTimeout(300);
  const sourcesOpen = await measurePanel(page);
  await page.screenshot({ path: `${shotDir}/04-sources-expanded.png` });
  await composer.locator("#assist-source-query").fill("基线");
  await composer.getByRole("button", { name: "查找来源" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shotDir}/04b-sources-results.png` });

  // 5. 窄窗口。
  await page.setViewportSize({ width: 860, height: 800 });
  await page.waitForTimeout(400);
  const narrow = await measurePanel(page);
  await page.screenshot({ path: `${shotDir}/05-narrow-window.png` });

  console.log(JSON.stringify({ collapsed, taskMode, skillSelected, sourcesOpen, narrow }, null, 1));
});

test("narrow-only", async ({ page }) => {
  await openSession(page, { width: 860, height: 800 });
  await page.getByTestId("assist-open-sources").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shotDir}/05b-narrow-default.png` });
  await page.getByTestId("assist-composer").getByTestId("assist-send-skill-0").check();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shotDir}/05c-narrow-skill.png` });
});

// 产品没有主题系统（见 src/dev/ScenarioLabView.tsx:42），这里只记录系统偏好为暗色时的真实渲染，
// 不伪造一套暗色 token：截图用途是证明新样式没有依赖硬编码颜色，因而不会在将来接主题时失效。
test("dark-preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openSession(page, { width: 1162, height: 782 });
  await page.getByTestId("assist-open-sources").click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shotDir}/06-dark-preference.png` });
  await page.locator(".agent-chat-send-options > .agent-chat-options-panel")
    .screenshot({ path: `${shotDir}/06-dark-preference-panel.png` });
});

test("first-message", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await page.goto(`/agent?work=${taskId}&new=1`);
  await connect(page);
  const chip = page.getByTestId("assist-first-send-options");
  await chip.locator("> summary").waitFor({ state: "visible", timeout: 20_000 });
  await chip.locator("> summary").click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shotDir}/07-first-message-dialog.png` });
  await page.locator('[data-testid="assist-first-send-options"] > .agent-chat-options-panel')
    .screenshot({ path: `${shotDir}/07-first-message-panel.png` });
});
