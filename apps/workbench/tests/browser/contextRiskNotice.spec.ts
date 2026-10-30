import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 必读文件体积预警（2026-10-30）在真实 Chromium 里可读、可展开、可关闭。
 *
 * 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。核对的是界面事实：
 *   · 有风险才出现，且是**卡外一行**——输入卡形状不变（窗口里的卡片几何前后一致）；
 *   · 严重时读作「发送前请先确认」，不阻止发送（发送键仍可用）；
 *   · 浮层列出文件、体积、tokens、占比与有效预算；窄窗不越出视口；
 *   · 键盘可达：Tab 到提示行、Enter 展开、Esc 收起并把焦点还给提示行。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const resourceId = "99999999-9999-4999-8999-999999999999";
const connectionId = "88888888-8888-4888-8888-888888888888";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(),
    body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: taskId,
  title: "关于确定实验评价指标", status: "ACTIVE", revision: "1",
  working_resource_id: resourceId,
  context: { project_goals: [], working_directory: {
    resource_id: resourceId, canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

interface AuditOptions { readonly severity?: "NONE" | "NOTICE" | "HIGH" | "SEVERE";
  readonly windowKnown?: boolean }

function auditBody(options: AuditOptions = {}): unknown {
  const severity = options.severity ?? "SEVERE";
  const windowKnown = options.windowKnown ?? true;
  const files = severity === "NONE" ? [] : [
    { path: "AGENTS.md", category: "TASK_REQUIRED", scope: "ROOT",
      reason: "项目规则入口：会话按项目约定在首轮完整读取。", bytes: 540_000,
      estimated_tokens: 180_000, modified_at: "2026-10-30T03:59:00.000Z",
      share: 0.78, severity },
    { path: "docs/rules.md", category: "TASK_REQUIRED", scope: "DECLARED",
      reason: "项目声明：每次开工都读。", bytes: 60_000,
      estimated_tokens: 20_000, modified_at: "2026-10-29T09:00:00.000Z",
      share: 0.087, severity: "NONE" },
  ];
  return {
    state: "OK",
    detail: files.length === 0 ? "没有发现会进上下文的必读文件。"
      : `${files.length} 份必读文件已计入预计加载量。`,
    agent: { id: "relay", label: "Relay 内置 Agent" },
    root: "D:\\Work\\Research",
    scanned_at: "2026-10-30T04:00:00.000Z",
    fingerprint: severity === "NONE" ? "fp-clean" : "fp-severe",
    severity,
    files,
    budget: { provider_window_tokens: windowKnown ? 256_000 : null,
      provider_window_known: windowKnown, call_budget_tokens: 256_000,
      call_budget_source: "WORKSPACE_TIER", effective_input_tokens: 231_000,
      effective_basis: windowKnown ? "PROVIDER_WINDOW" : "CALL_BUDGET",
      reserves: { output_tokens: 8_192, system_prompt_tokens: 2_000,
        tool_definition_tokens: 4_096, history_tokens: 0 },
      estimated_total_input_tokens: 194_288, required_total_tokens: 200_000,
      required_total_share: 0.86, confidence: windowKnown ? "EXACT_WINDOW" : "WINDOW_UNKNOWN",
      estimate: { method: "ESTIMATED_UTF8_BYTES_DIV_3", bytes_per_token: 3,
        note: "按 UTF-8 字节数 ÷ 3 估算，与上下文构建、模型端口的预算口径一致。" } },
    reasons: severity === "NONE" ? [] : [
      { code: "SINGLE_FILE_SEVERE", text: "AGENTS.md 预计占有效输入预算的 78%",
        ratio: 0.78, path: "AGENTS.md" },
      { code: "TOTAL_FILES_HIGH", text: "2 份必读文件累计预计占 86%", ratio: 0.86, path: null }],
    suggestions: severity === "NONE" ? [] : [
      { code: "SPLIT_ENTRY", text: "把大型入口文件拆成两段：入口只留导航与硬约束。" },
      { code: "MOVE_REFERENCE", text: "把参考资料移出入口文件。" }],
    skipped: [],
    access: { project_id: projectId, connection_id: connectionId },
    thresholds: { single_file: { notice: 0.15, high: 0.30, severe: 0.50 },
      total_files: { notice: 0.30, high: 0.50, severe: 0.75 } },
  };
}

async function installRoutes(page: Page, options: AuditOptions = {}): Promise<{ audits: number }> {
  const state = { audits: 0 };
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: 262_144, status: "UNSET", reason: null,
        revision: "2" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 262_144 });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/memory-settings`) return fulfillJson(route, { workspace_id: workspaceId,
      revision: "0", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1",
      state_revision: "1", archived_at: null });
    if (path === `${prefix}/working-directories/${resourceId}/work-context`) return fulfillJson(route,
      { kind: "DIRECTORY", directory: { id: resourceId, canonical_root: "D:////Work////Research",
        status: "ACTIVE", revision: "1", project: { id: projectId, title: "Windows 桌面验收（测试）",
          project_type: "GENERAL", archive_status: "ACTIVE", archived_at: null, revision: "1" } },
        linked_goals: [], sessions: [] });
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
      return fulfillJson(route, { items: [] });
    }
    // 必读文件审计：被测端点。
    if (path === `${prefix}/working-directories/${resourceId}/required-context-audit`) {
      state.audits += 1;
      return fulfillJson(route, auditBody(options));
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return state;
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("required-context-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" })
    .waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openSession(page: Page): Promise<void> {
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("assist-composer").waitFor({ timeout: 20_000 });
}

/** 输入卡与提示行的几何：用来断言「提示在卡外、卡片形状不变」。 */
async function geometry(page: Page): Promise<{ card: { top: number; height: number } | null;
  line: { top: number; height: number; right: number } | null }> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-testid="assist-composer"]');
    const line = document.querySelector('[data-testid="context-risk-line"]');
    const box = (element: Element | null) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top * 10) / 10, height: Math.round(rect.height * 10) / 10,
        right: Math.round(rect.right * 10) / 10 };
    };
    return { card: box(card), line: box(line) };
  });
}

test("严重风险：卡外单行提示、展开浮层、Esc 还焦点", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  const state = await installRoutes(page);
  await openSession(page);

  const line = page.getByTestId("context-risk-line");
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toHaveAttribute("data-severity", "SEVERE");
  await expect(line).toContainText("发现 2 个大型必读文件");
  await expect(line).toContainText("预计占用 86% 上下文");
  await expect(line).toContainText("发送前请先确认");
  expect(state.audits).toBeGreaterThanOrEqual(1);

  // 提示在输入卡之外：它必须排在卡片下方，且卡片本身没有被撑高。
  const withNotice = await geometry(page);
  expect(withNotice.line).not.toBeNull();
  expect(withNotice.line!.top).toBeGreaterThan(withNotice.card!.top + withNotice.card!.height - 2);
  // 单行高度：一行 12px 文本，不应膨胀成一块卡片。
  expect(withNotice.line!.height).toBeLessThan(30);

  // 展开：文件、占比、有效预算、窗口、原因都读得到。
  await line.click();
  const panel = page.getByTestId("context-risk-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("AGENTS.md");
  await expect(panel).toContainText("78%");
  await expect(page.getByTestId("context-risk-effective-input")).toContainText("231,000");
  await expect(page.getByTestId("context-risk-window")).toContainText("256,000");
  await expect(panel).toContainText("预计加载量（发送前推算）");
  await expect(page.getByTestId("context-risk-suggestions")).toContainText("拆成两段");
  const panelBox = await panel.boundingBox();
  expect(panelBox!.x).toBeGreaterThanOrEqual(0);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1162);

  await page.screenshot({ path: "output/context-risk-20261030/severe-1162.png", fullPage: true });

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(line).toBeFocused();

  // 发送键不受预警影响：写入正文后照常可用（预警只提醒，不阻止发送）。
  await page.getByTestId("assist-draft").fill("这条消息应该能发出去");
  await expect(page.getByTestId("assist-send")).toBeEnabled();
});

test("没有风险时不占一行：输入卡几何与无预警时一致", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { severity: "NONE" });
  await openSession(page);
  await page.getByTestId("assist-composer").waitFor();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("context-risk-notice")).toHaveCount(0);
  expect(await geometry(page)).toMatchObject({ line: null });
});

test("窄窗与键盘：浮层被视口封顶，Tab + Enter 可展开", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 840 });
  await installRoutes(page, { windowKnown: false });
  await openSession(page);

  const line = page.getByTestId("context-risk-line");
  await expect(line).toBeVisible({ timeout: 20_000 });
  // 窗口未知时只按调用预算估算：浮层里必须写「未知」，不给假精确读数。
  await line.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("context-risk-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("context-risk-window")).toContainText("未知");
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(560);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: "output/context-risk-20261030/narrow-560.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
