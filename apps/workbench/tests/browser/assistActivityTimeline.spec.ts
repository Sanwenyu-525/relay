import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";

/**
 * 统一活动时间线的浏览器验收（2026-10-29 AI Response Experience V2 · 阶段 C）。
 *
 * 单测证明 DOM 里有什么；这里量的是**读起来是否成立**：
 *   1. 长轮次（11 次调用 / 3 轮）里每一行的左缘是否对齐——不对齐就不是「同一套骨架」。
 *   2. 运行中全页只有一个主进度动效（`data-current`），其余在途行是静止的空心环。
 *   3. 简洁档只折掉正常完成的行，审批 / 被拒 / 未知 / 失败一律保留。
 *   4. 窄窗口与长路径不产生页面级横向滚动。
 *   5. 关动效后状态信息一个不少。
 *
 * API 全部由 page.route 伪造（SSE 端点返回 502，走权威 GET 轮询回退），
 * 不连数据库、不调 Provider、不写真实业务事实。截图留在 apps/workbench/results/。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const userMessageId = "c1111111-1111-4111-8111-111111111111";
const assistantMessageId = "c2222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
const resultsDir = "D:/Develop/Relay-Agent/apps/workbench/results";

const FINAL = [
  "## 结论",
  "",
  "这一轮读了配置、跑了检查，并把一处依赖顺序改对。",
  "",
  "- 读取 6 个文件",
  "- 运行 1 次检查",
  "- 修改 1 个文件"
].join("\n");

const LONG_PATH = "apps/workbench/src/components/activityPresentation/very/deep/path/ActivityRow.tsx";

type Phase = "running" | "settled";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

const session = { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
  title: "关于Relay-Agent", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
  assistant_profile_id: null, working_resource_id: null,
  context: { project_goals: [], working_directory: null },
  created_at: "2026-10-29T09:00:00Z", updated_at: "2026-10-29T09:00:00Z" };

function message(id: string, seq: string, role: "USER" | "ASSISTANT", status: string,
  content: string | null) {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    steer_requested: false, attachments: [], created_at: "2026-10-29T09:00:00Z",
    updated_at: "2026-10-29T09:00:00Z",
    usage: { input_tokens: 1200, output_tokens: 180, cache_read_tokens: null, cache_creation_tokens: null } };
}

function messages(phase: Phase) {
  return [
    message(userMessageId, "1", "USER", "COMPLETED", "把这次的改动过程说清楚"),
    message(assistantMessageId, "2", "ASSISTANT", phase === "settled" ? "COMPLETED" : "RUNNING",
      phase === "settled" ? FINAL : null)
  ];
}

/**
 * 11 次调用 / 3 轮，覆盖读取、检索、命令、写入，以及三种例外：
 * 被拒、结果未知、以及一条超长路径（用来量折行与横向溢出）。
 */
function toolCalls(phase: Phase) {
  const base = { arguments_sha256: "a".repeat(64), provider_tool_call_id: "call-x",
    operation_id: null, rejection_reason: null, rejection_detail: null, result_digest: null };
  const settledAt = phase === "settled" ? "2026-10-29T09:00:05.000Z" : null;
  const reads = ["package.json", "pnpm-workspace.yaml", "apps/workbench/package.json",
    LONG_PATH, "apps/api/package.json", "tsconfig.json"].map((path, index) => ({
      ...base, id: `d1000000-0000-4000-8000-00000000000${index}`, round: 0, ordinal: index,
      tool_name: "read_file", status: "SETTLED", arguments: { relative_path: path },
      requested_at: `2026-10-29T09:00:0${index}.000Z`, settled_at: "2026-10-29T09:00:01.400Z"
    }));
  const search = { ...base, id: "d2000000-0000-4000-8000-000000000001", round: 1, ordinal: 0,
    tool_name: "search_text", status: "SETTLED", arguments: { query: "activityPresentation" },
    requested_at: "2026-10-29T09:00:02.000Z", settled_at: "2026-10-29T09:00:02.500Z" };
  const checks = { ...base, id: "d2000000-0000-4000-8000-000000000002", round: 1, ordinal: 1,
    tool_name: "run_check", status: "SETTLED", arguments: { check_id: "typecheck" },
    requested_at: "2026-10-29T09:00:03.000Z", settled_at: "2026-10-29T09:00:09.000Z" };
  const write = { ...base, id: "d3000000-0000-4000-8000-000000000001", round: 2, ordinal: 0,
    tool_name: "apply_changeset", status: "SETTLED", arguments: { relative_path: "src/lib/order.ts" },
    requested_at: "2026-10-29T09:00:09.500Z", settled_at: "2026-10-29T09:00:10.000Z" };
  const rejected = { ...base, id: "d3000000-0000-4000-8000-000000000002", round: 2, ordinal: 1,
    tool_name: "apply_changeset", status: "REJECTED", arguments: { relative_path: "../../etc/hosts" },
    rejection_reason: "OUTSIDE_SCOPE", rejection_detail: "目标不在本次绑定的目录内。",
    requested_at: "2026-10-29T09:00:10.500Z", settled_at: "2026-10-29T09:00:10.600Z" };
  const unknown = { ...base, id: "d3000000-0000-4000-8000-000000000003", round: 2, ordinal: 2,
    tool_name: "git_status", status: phase === "settled" ? "UNKNOWN" : "REQUESTED",
    arguments: {}, requested_at: "2026-10-29T09:00:11.000Z", settled_at: settledAt };
  return { session_id: sessionId, message_id: assistantMessageId,
    message_status: phase === "settled" ? "COMPLETED" : "RUNNING",
    rounds: [
      { round: 0, calls: reads },
      { round: 1, calls: [search, checks] },
      { round: 2, calls: [write, rejected, unknown] }
    ] };
}

type Variant = "normal" | "empty" | "error";

async function installRoutes(page: Page, state: { phase: () => Phase; variant?: () => Variant }): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Relay-Agent", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
    if (path === `${prefix}/projects/${projectId}/state`) return fulfillJson(route, { project_id: projectId,
      revision: "1", phase_key: "GENERAL", next_action_task_id: null,
      selected_artifact_version_refs: [], completed_highlight_refs: [] });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 200000 });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route, { resource_id: null,
      canonical_root: null, display_name: null, write_tier: null, default_write_tier: null,
      status: "UNSET", reason: null, revision: "0" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`)
      return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`)
      return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`)
      return fulfillJson(route, { items: messages(state.phase()) });
    if (path.endsWith("/live-preview/events")) {
      await route.fulfill({ status: 502, headers: cors(), body: "" });
      return;
    }
    if (path.endsWith("/live-preview")) {
      // 运行中给一段真实草稿：草稿末尾会挂 inline 三点，是「主进度只允许一个」的必检对象。
      const running = state.phase() === "running";
      return fulfillJson(route, { session_id: sessionId, message_id: assistantMessageId,
        status: running ? "RUNNING" : "COMPLETED", preview_revision: running ? "2" : "0",
        preview_text: running ? "正在按顺序读取配置并核对依赖。" : null,
        preview_truncated: false, preview_available: running });
    }
    if (path.includes("conversation-diff")) return fulfillJson(route, { session_id: sessionId, files: [],
      unavailable_files: 0, unverifiable_files: 0, baseline: null, incomplete: false });
    if (path.endsWith("/tool-calls")) {
      const variant = state.variant?.() ?? "normal";
      // 空态与读取失败是两个必须区分的缺口：前者是事实（没有调用工具），后者是读不到。
      if (variant === "empty") return fulfillJson(route, { session_id: sessionId,
        message_id: assistantMessageId, message_status: "COMPLETED", rounds: [] });
      if (variant === "error") return fulfillJson(route, { error: "trace unavailable" }, 500);
      return fulfillJson(route, toolCalls(state.phase()));
    }
    if (/\/assist-messages\/[^/]+\/model-runtime$/u.test(path)) return fulfillJson(route, {
      message_id: assistantMessageId, message_status: "COMPLETED", snapshot_available: false,
      preferred_model: null, candidate_models: [], current_candidate_model: null, actual_model: null,
      max_candidates: null, routing_status: null, failure_scope: null, failure_reason: null,
      retry_after_at: null, free_daily_remaining: null, switches: [], calls: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("activity-timeline-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openTrace(page: Page) {
  const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
  await expect(trace).toBeVisible({ timeout: 20_000 });
  if (!(await trace.evaluate((element: HTMLDetailsElement) => element.open))) {
    await page.getByTestId("session-round-trace-toggle").click();
  }
  await expect(trace).toHaveAttribute("open", "");
}

test.describe("统一活动时间线", () => {
  test("长轮次：行左缘对齐、状态分档、无横向溢出", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await openTrace(page);

    // 11 行都在：分组与密度只改视图，不改事实。
    await expect(page.locator(".activity-item")).toHaveCount(11);
    await expect(page.locator('[data-testid="session-round-0"]')).toBeVisible();
    await expect(page.locator('[data-testid="session-round-2"]')).toBeVisible();

    // 这一轮里有被拒与未知：例外压过「已结束」，相位是 REJECTED、档位是 danger。
    // 界面上永远不出现由「工具结算」推出的成功档（success 没有任何相位使用）。
    await expect(page.getByTestId(`session-round-trace-${assistantMessageId}`))
      .toHaveAttribute("data-phase", "REJECTED");
    await expect(page.locator(".activity-header-icon")).toHaveAttribute("data-tone", "danger");

    // 例外必须有文字状态，不只是颜色。
    const rejected = page.locator('[data-testid="session-round-call-d3000000-0000-4000-8000-000000000002"]');
    await expect(rejected).toContainText("被拒绝，没有执行");
    await expect(rejected).toContainText("目标不在本次绑定的目录内。");
    const unknown = page.locator('[data-testid="session-round-call-d3000000-0000-4000-8000-000000000003"]');
    await expect(unknown).toContainText("结果未知，需核对");
    await expect(unknown).toHaveAttribute("data-tone", "negative");

    // 每一行的动作词都从同一条竖线开始：左缘偏差不超过 1px。
    const lefts = await page.locator(".activity-item-verb").evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);

    // 没有页面级横向滚动：长路径在行内折行，不撑破消息列。
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth
      - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.screenshot({ path: `${resultsDir}/activity-timeline-settled.png`, fullPage: false });
    // 组件自身截图：量间距与对齐时不被整页滚动位置干扰。
    await page.getByTestId(`session-round-trace-${assistantMessageId}`)
      .screenshot({ path: `${resultsDir}/activity-timeline-trace-settled.png` });
  });

  test("运行中只有一个主进度动效，标题行说清在做什么", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "running" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toHaveAttribute("data-state", "active", { timeout: 20_000 });
    // 在途默认展开：那正是用户此刻要看的东西。
    await expect(trace).toHaveAttribute("open", "");
    // 标题行只报「已结算多少 + 正在执行」：总数未知，不报 2/5，也不报预计剩余时间。
    await expect(page.getByTestId("session-round-trace-activity")).toContainText("正在执行");
    await expect(page.getByTestId("session-round-trace-activity")).not.toContainText("预计还需");

    // 主进度动效只有一处：当前活动行的状态图标。
    await expect(page.locator('.activity-item[data-current="true"]')).toHaveCount(1);
    await expect(page.locator(".activity-item-spin")).toHaveCount(1);
    // 有当前行时标题图标不转（它只在「没有当前行」时接手）。
    await expect(page.locator(".activity-header-spin")).toHaveCount(0);

    // 草稿里的 inline 三点必须真实存在——否则「停转」这条断言会在空集合上假通过。
    const inlineDots = page.locator('.assist-inflight-dots[data-inline="true"] > i');
    await expect(inlineDots).toHaveCount(3);
    const dotAnimations = await inlineDots.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).animationName));
    expect(dotAnimations).toEqual(["none", "none", "none"]);

    // 整条消息里「正在动」的元素恰好一个。
    const moving = await page.locator(
      ".activity-item-spin, .activity-header-spin, .assist-inflight-dots > i").evaluateAll((nodes) =>
      nodes.filter((node) => getComputedStyle(node).animationName !== "none").length);
    expect(moving).toBe(1);

    await page.screenshot({ path: `${resultsDir}/activity-timeline-running.png`, fullPage: false });
  });

  test("简洁档只折掉正常完成的行，例外与失败全部保留", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await openTrace(page);
    await expect(page.locator(".activity-item")).toHaveCount(11);

    await page.getByTestId("session-round-trace-density-concise").click();
    // 只剩被拒与未知两行：正常完成与失败的读取都被折掉，但例外一条不少。
    await expect(page.locator(".activity-item")).toHaveCount(2);
    await expect(page.locator(".activity-item[data-tone=\"negative\"]")).toHaveCount(2);
    await page.screenshot({ path: `${resultsDir}/activity-timeline-concise.png`, fullPage: false });

    await page.getByTestId("session-round-trace-density-detailed").click();
    await expect(page.locator(".activity-item")).toHaveCount(11);
    // 详细档把第三层默认展开：参数面板真的在页面上。
    await expect(page.locator(".activity-item-detail").first()).toBeVisible();
    await page.screenshot({ path: `${resultsDir}/activity-timeline-detailed.png`, fullPage: false });

    // 选择要记住：刷新后仍是详细档。
    await page.reload();
    await connect(page);
    await openTrace(page);
    await expect(page.getByTestId("session-round-trace-density-detailed")).toHaveAttribute("aria-pressed", "true");
  });

  test("关动效后状态信息不丢，窄窗口不产生横向滚动", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 900, height: 800 });
    await installRoutes(page, { phase: () => "running" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await page.evaluate(() => { document.documentElement.dataset.motion = "off"; });

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toHaveAttribute("data-state", "active", { timeout: 20_000 });
    // 动效关掉之后，状态仍然由文字与形状表达。
    await expect(page.getByTestId("session-round-trace-activity")).toBeVisible();
    // 先断言目标元素真的存在：空集合上的 every() 永远为真，是典型的假通过。
    const spin = page.locator(".activity-item-spin");
    await expect(spin).toHaveCount(1);
    expect(await spin.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).animationName))).toEqual(["none"]);
    // 关动效后全页不应还有任何元素在跑动画。
    const moving = await page.locator(
      ".activity-item-spin, .activity-header-spin, .assist-inflight-dots > i").evaluateAll((nodes) =>
      nodes.filter((node) => getComputedStyle(node).animationName !== "none").length);
    expect(moving).toBe(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth
      - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${resultsDir}/activity-timeline-narrow-motion-off.png`, fullPage: false });
  });
});

/**
 * 缺口与默认态（2026-10-29 V3 P0）。
 *
 * 三件事必须同时成立：默认折叠时只剩一行标题；零记录时入口不消失而是给空态；
 * 读取失败时入口也不消失，并给出确切原因与重读。三者都是「点击之后会怎样」的验收，
 * 因此全部走真实点击路径，不靠组件快照。
 */
test.describe("缺口与默认态", () => {
  test("完成态默认折叠：只留一行标题，展开才读", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toBeVisible({ timeout: 20_000 });
    // 终态默认收起，且不预取：还没读到就不报数字，也不预判有没有工具。
    await expect(trace).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("session-round-trace-activity")).toHaveText("展开查看");
    await expect(page.locator(".activity-item")).toHaveCount(0);
    await page.screenshot({ path: `${resultsDir}/activity-collapsed.png`, fullPage: false });
  });

  test("零记录：点击后入口不消失，改为空态说明", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled", variant: () => "empty" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await openTrace(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toHaveAttribute("data-phase", "EMPTY");
    await expect(trace).toBeVisible();
    await expect(page.getByTestId(`session-round-trace-empty-${assistantMessageId}`))
      .toContainText("本轮没有调用工具");
    // 空态不是错误态。
    await expect(page.locator('[data-testid^="session-round-trace-error-"]')).toHaveCount(0);
    await page.screenshot({ path: `${resultsDir}/activity-empty.png`, fullPage: false });
  });

  test("读取失败：入口不消失，给确切原因与重新读取", async ({ page }) => {
    fs.mkdirSync(resultsDir, { recursive: true });
    await page.setViewportSize({ width: 1270, height: 900 });
    await installRoutes(page, { phase: () => "settled", variant: () => "error" });
    await page.goto(`/projects/${projectId}?skill=assist`);
    await connect(page);
    await openTrace(page);

    const trace = page.getByTestId(`session-round-trace-${assistantMessageId}`);
    await expect(trace).toHaveAttribute("data-phase", "ERROR");
    await expect(page.locator(`[data-testid="session-round-trace-error-${assistantMessageId}"]`))
      .toContainText("过程读取失败");
    await expect(page.getByTestId(`session-round-trace-retry-${assistantMessageId}`)).toBeVisible();
    // 读取失败不能说成「本轮没有调用工具」。
    await expect(page.getByTestId(`session-round-trace-empty-${assistantMessageId}`)).toHaveCount(0);
    await page.screenshot({ path: `${resultsDir}/activity-error.png`, fullPage: false });
  });
});
