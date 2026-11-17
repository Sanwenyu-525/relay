import { expect, test, type Page, type Route } from "@playwright/test";
import { contextCompactionWireFixture, unknownWindowCompactionWireFixture } from "../contextUsageFixture";

/**
 * CONTEXT-USAGE-MINIMAL（2026-11-15）的真实 Chromium 验收。
 *
 * 默认浮层只保留：标题/异常状态、当前 Token / 生效阈值、占比、进度条、
 * 余量、自动压缩开关、阈值被模型容量收敛时的一行原因。
 * 构成、容量、最近调用、成功记录、时间戳、来源与手动压缩按钮都不再渲染；
 * 手动压缩仍可从 `/compact` 命令入口执行。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;

function shot(name: string): string {
  const override = process.env.RELAY_ACCEPTANCE_SHOTS_DIR;
  return override === undefined ? test.info().outputPath(name) : `${override}/${name}`;
}

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
  working_resource_id: "99999999-9999-4999-8999-999999999999",
  context: { project_goals: [], working_directory: {
    resource_id: "99999999-9999-4999-8999-999999999999", canonical_root: "D:\\Work\\Research" } },
  created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z" };

const completedUser = { id: "aaaa1111-1111-4111-8111-111111111111", session_id: sessionId,
  role: "USER", status: "COMPLETED", seq: "1", intent: "DISCUSS", content: "帮我看看上下文用量",
  error_code: null, provider_error_kind: null, cancel_requested: false, steer_requested: false,
  usage: { input_tokens: null, output_tokens: null, cache_read_tokens: null,
    cache_creation_tokens: null }, sources: [], skill: null, skill_input: null, skill_output: null,
  attachments: [], created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z",
  revision: "1" };

const completedAssistant = { ...completedUser, id: "bbbb2222-2222-4222-8222-222222222222",
  role: "ASSISTANT", seq: "2", content: "读数如下",
  usage: { input_tokens: 10_607, output_tokens: 646, cache_read_tokens: null,
    cache_creation_tokens: null } };

const compactCommand = { kind: "SYSTEM", name: "compact", aliases: ["压缩"],
  title: "压缩上下文", summary: "在安全边界手动整理当前会话上下文。",
  usage: "/compact", system_id: "compact" };

function contextUsage(options: { readonly compaction?: Record<string, unknown>;
  readonly input?: number } = {}): unknown {
  const compaction = contextCompactionWireFixture(options.compaction ?? {});
  return { session_id: sessionId,
    next_call: { reservation_tokens: compaction.effective_window_tokens,
      effective_window_tokens: compaction.effective_window_tokens,
      model_window_tokens: compaction.model_window_tokens,
      provider_call_cap_tokens: compaction.provider_call_cap_tokens,
      window_source: compaction.window_source,
      fallback_applied: compaction.fallback_applied },
    last_call: { source: "MODEL_CALL", call_id: "cccc3333-3333-4333-8333-333333333333",
      message_id: completedAssistant.id, provider: "openai-compatible", model: "gpt-4.1-mini",
      status: "COMPLETED", input_tokens: options.input ?? 10_607,
      output_tokens: 646, cache_read_tokens: null, cache_creation_tokens: null,
      reserved_tokens: compaction.effective_window_tokens,
      settled_at: "2026-10-30T00:00:00Z", breakdown: null },
    compaction };
}

async function installRoutes(page: Page, options: Parameters<typeof contextUsage>[0] = {}): Promise<{
  readonly compactBodies: readonly Record<string, unknown>[] }> {
  const compactBodies: Record<string, unknown>[] = [];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks/${taskId}`) return fulfillJson(route, { id: taskId,
      project_id: projectId, title: "整理实验评价指标", status: "IN_PROGRESS", mode: "ME",
      revision: "2", created_at: "2026-10-16T00:00:00Z", updated_at: "2026-10-16T00:00:00Z",
      executor: { kind: "HUMAN", run_id: null, ownership_epoch: "1" },
      current_completion_id: null, waiting_reason: null, blocking_task_ids: [],
      unresolved_blocker_ids: [], allowed_actions: [],
      acceptance: { acceptance_revision: "2", objective: "补齐基线与验收依据。", source: "CREATE",
        created_at: "2026-10-16T00:00:00Z", criteria: [] }, dependencies: [] });
    if (path === `${prefix}/projects/${projectId}`) return fulfillJson(route, { id: projectId,
      title: "Windows 桌面验收（测试）", project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null });
    if (path === `${prefix}/search`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: null, status: "UNSET", reason: null,
        revision: "0" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "openai-compatible",
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 1_000_000 });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [compactCommand] });
    if (path === `${prefix}/assist-sessions/${sessionId}/chat-commands` &&
      request.method() === "POST") {
      const body = JSON.parse(String(request.postData())) as Record<string, unknown>;
      compactBodies.push(body);
      return fulfillJson(route, { command_id: body.command_id,
        committed_at: "2026-11-15T00:00:00Z", result: { kind: "MEMORY_COMPACTION",
          system: "compact", session_id: sessionId, status: "PENDING",
          request_id: "dddd4444-4444-4444-8444-444444444444" } }, 202);
    }
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route,
      { items: [completedUser, completedAssistant] });
    if (path === `${prefix}/assist-sessions/${sessionId}/context-usage`) {
      return fulfillJson(route, contextUsage(options));
    }
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
  return { compactBodies };
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("context-usage-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openChat(page: Page): Promise<void> {
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
}

async function openPanel(page: Page): Promise<void> {
  await openChat(page);
  await page.getByTestId("assist-composer").getByTestId("assist-context-meter").click();
  await expect(page.getByTestId("assist-context-meter-panel")).toBeVisible();
}

type Rect = { left: number; right: number; top: number; bottom: number;
  width: number; height: number };

async function measure(page: Page): Promise<{ panel: Rect | null; ring: Rect | null;
  send: Rect | null; model: Rect | null; position: string | null; side: string | null;
  viewport: { width: number; height: number } }> {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: r.width, height: r.height };
    };
    const menu = document.querySelector<HTMLElement>('[data-testid="assist-context-meter-panel"]');
    return { panel: rect('[data-testid="assist-context-meter-panel"]'),
      ring: rect('[data-testid="assist-composer"] [data-testid="assist-context-meter"]'),
      send: rect('[data-testid="assist-send"]'), model: rect('[data-testid="model-selector-open"]'),
      position: menu === null ? null : getComputedStyle(menu).position,
      side: menu?.dataset.side ?? null,
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
}

async function facts(page: Page): Promise<{ width: number; height: number;
  overflow: number; overflowY: string; scrollers: number; text: string }> {
  return page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-testid="assist-context-meter-panel"]');
    if (menu === null) throw new Error("缺少浮层");
    const scrollers = Array.from(menu.querySelectorAll<HTMLElement>("*")).filter((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === "auto" || style.overflowY === "scroll")
        && el.scrollHeight > el.clientHeight + 1;
    }).length;
    const box = menu.getBoundingClientRect();
    return { width: box.width, height: box.height,
      overflow: menu.scrollHeight - menu.clientHeight,
      overflowY: getComputedStyle(menu).overflowY, scrollers,
      text: menu.textContent?.replace(/\s+/g, " ").trim() ?? "" };
  });
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

const removedTestIds = ["context-usage-breakdown-section", "context-usage-breakdown",
  "context-usage-composition-bar", "context-usage-capacity", "context-usage-capacity-formula",
  "context-usage-window", "context-usage-window-used", "context-usage-window-value",
  "context-usage-window-percent", "context-usage-window-meta", "context-usage-frozen-note",
  "context-usage-estimate", "context-compaction-now", "context-compaction-last-result",
  "context-compaction-window-row", "context-compaction-window-source",
  "context-compaction-configured-row", "context-compaction-threshold-row",
  "context-compaction-post-target-row", "context-usage-status-time",
  "assist-context-meter-info"];

test("1162×782：默认只保留核心读数与自动压缩，无滚动且不盖控件", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  await expect(panel.locator(".agent-chat-context-meter-heading")).toHaveText("上下文用量");
  await expect(panel.getByTestId("context-usage-status-label")).toHaveText("接近压缩阈值");
  await expect(panel.getByTestId("context-usage-current-tokens")).toHaveText("280,000");
  await expect(panel.getByTestId("context-usage-current-threshold")).toHaveText("350,000");
  await expect(panel.getByTestId("context-usage-current-percent")).toHaveText("80%");
  await expect(panel.getByTestId("context-usage-current-remaining"))
    .toHaveText("距离自动压缩还剩 70,000 tokens。");
  await expect(panel.getByTestId("context-compaction-state")).toHaveText("已开启");
  await expect(panel.getByTestId("context-compaction-clamped")).toHaveCount(0);
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(meter).toHaveAttribute("data-state", "normal");
  await expect(meter).toHaveAttribute("aria-label",
    "上下文 10,607 / 1,000,000 tokens（1%）");
  await meter.screenshot({ path: shot("ring-known-1m-1162x782.png") });

  for (const testId of removedTestIds) {
    await expect(panel.getByTestId(testId), testId).toHaveCount(0);
  }
  const panelFacts = await facts(page);
  expect(panelFacts.text).not.toContain("上下文构成");
  expect(panelFacts.text).not.toContain("容量限制");
  expect(panelFacts.text).not.toContain("最近一次调用");
  expect(panelFacts.text).not.toContain("最近压缩");
  expect(panelFacts.text).not.toContain("真实 + 估算");
  expect(panelFacts.text).not.toContain("立即压缩");
  expect(panelFacts.text).not.toContain("最近一次记录");
  expect(panelFacts.scrollers, "默认不应有内部滚动容器").toBe(0);
  expect(panelFacts.overflow, "默认不应出现滚动条").toBeLessThanOrEqual(1);
  expect(panelFacts.width).toBeGreaterThanOrEqual(339);
  expect(panelFacts.width).toBeLessThanOrEqual(380.5);
  expect(panelFacts.height).toBeGreaterThanOrEqual(150);
  expect(panelFacts.height).toBeLessThanOrEqual(230);

  const layout = await measure(page);
  if (layout.panel === null || layout.ring === null || layout.send === null
    || layout.model === null) throw new Error("缺少常规窗口几何采样");
  expect(layout.position).toBe("fixed");
  expect(overlapArea(layout.panel, layout.ring), "浮层不得盖住上下文圆环").toBe(0);
  expect(overlapArea(layout.panel, layout.send), "浮层不得盖住发送键").toBe(0);
  expect(overlapArea(layout.panel, layout.model), "浮层不得盖住模型选择器").toBe(0);

  await page.screenshot({ path: shot("panel-default-1162x782.png"), fullPage: false });
  await panel.screenshot({ path: shot("panel-default-element-1162x782.png") });
});

test("1162×782：阈值被模型容量限制时只留一行原因", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { compaction: {
    threshold_tokens: 500_000, requested_threshold_tokens: 500_000,
    threshold_clamped: true, effective_threshold_tokens: 209_386,
    model_window_tokens: 262_144, effective_window_tokens: 262_144,
    safety_reserve_tokens: 13_108, safe_input_tokens: 232_652,
    context_tokens: 100_000, distance_tokens: 109_386 } });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  await expect(panel.getByTestId("context-usage-current-threshold")).toHaveText("209,386");
  const clamp = panel.getByTestId("context-compaction-clamped");
  await expect(clamp).toHaveCount(1);
  await expect(clamp).toContainText("用户设置 500,000");
  await expect(clamp).toContainText("容量受限，按 209,386 生效");
  await expect(panel.getByTestId("context-compaction-threshold-row")).toHaveCount(0);
  await expect(panel.getByTestId("context-usage-capacity")).toHaveCount(0);
  const panelFacts = await facts(page);
  expect(panelFacts.overflow, "收敛说明也不应引入滚动").toBeLessThanOrEqual(1);
  expect(panelFacts.scrollers).toBe(0);
  await panel.screenshot({ path: shot("panel-clamped-element-1162x782.png") });
});

test("1162×782：模型窗口未知时圆环诚实显示估算，不泄露回退分母", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { input: 200_000, compaction: unknownWindowCompactionWireFixture() });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");

  await expect(panel.getByTestId("context-usage-current-threshold")).toHaveText("209,386");
  await expect(panel.getByTestId("context-usage-current-percent")).toHaveText("48%");
  const clamp = panel.getByTestId("context-compaction-clamped");
  await expect(clamp).toHaveCount(1);
  await expect(clamp).toContainText("当前阈值 350,000");
  await expect(clamp).toContainText("模型窗口未知，按 209,386 生效");
  await expect(panel.getByTestId("context-compaction-window-unknown")).toHaveCount(0);
  await expect(panel.getByTestId("context-usage-capacity")).toHaveCount(0);
  const panelFacts = await facts(page);
  expect(panelFacts.overflow).toBeLessThanOrEqual(1);
  expect(panelFacts.text).not.toContain("262,144");

  await expect(meter).toHaveAttribute("data-state", "unknown");
  await expect(meter).toHaveAttribute("aria-label",
    "上下文 200,000 tokens · 模型窗口未知，按安全回退估算");
  await expect(meter).not.toHaveAttribute("data-over", "true");
  await meter.screenshot({ path: shot("ring-window-unknown-1162x782.png") });
  await panel.screenshot({ path: shot("panel-window-unknown-element-1162x782.png") });
});

test("1162×782：自动压缩关闭时只剩一次状态，不宣称会先整理", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { compaction: { enabled: false, context_tokens: 420_000,
    distance_tokens: -70_000 } });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  await expect(panel.getByTestId("context-compaction-state")).toHaveText("已关闭");
  await expect(panel.getByTestId("context-usage-current-percent")).toHaveText("120%");
  await expect(panel.getByTestId("context-usage-current-remaining"))
    .toHaveText("已超过压缩阈值 70,000 tokens。");
  await expect(panel.getByTestId("context-usage-status")).toHaveCount(0);
  const panelFacts = await facts(page);
  expect(panelFacts.text.split("自动压缩已关闭").length - 1, "状态只出现一次").toBe(1);
  expect(panelFacts.text).not.toContain("下一次请求前会先整理");
  await panel.screenshot({ path: shot("panel-disabled-element-1162x782.png") });
});

test("560×700：窄窗不横向溢出、不盖发送键与模型下拉", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 700 });
  await installRoutes(page);
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const layout = await measure(page);
  if (layout.panel === null || layout.ring === null || layout.send === null
    || layout.model === null) throw new Error("缺少浮层几何采样");

  expect(layout.position).toBe("fixed");
  expect(layout.panel.width).toBeLessThanOrEqual(380.5);
  expect(layout.panel.left).toBeGreaterThanOrEqual(7.5);
  expect(layout.panel.right).toBeLessThanOrEqual(layout.viewport.width - 7.5);
  expect(layout.panel.top).toBeGreaterThanOrEqual(7.5);
  expect(layout.panel.bottom).toBeLessThanOrEqual(layout.viewport.height + 0.5);
  const ringCenter = (layout.ring.left + layout.ring.right) / 2;
  expect(ringCenter).toBeGreaterThanOrEqual(layout.panel.left - 0.5);
  expect(ringCenter).toBeLessThanOrEqual(layout.panel.right + 0.5);
  expect(overlapArea(layout.panel, layout.send)).toBe(0);
  expect(overlapArea(layout.panel, layout.model)).toBe(0);
  const panelFacts = await facts(page);
  expect(panelFacts.scrollers, "窄窗默认也不应有内部滚动").toBe(0);
  expect(panelFacts.overflow, "窄窗默认不滚动").toBeLessThanOrEqual(1);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: shot("panel-narrow-560x700.png"), fullPage: true });
});

test("560×430：低高度自然缩短、不双重滚动、不盖控件", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 430 });
  await installRoutes(page);
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const layout = await measure(page);
  if (layout.panel === null || layout.ring === null || layout.send === null
    || layout.model === null) throw new Error("缺少低高度几何采样");

  expect(layout.position).toBe("fixed");
  expect(layout.side).toMatch(/above|below/);
  expect(layout.panel.top).toBeGreaterThanOrEqual(7.5);
  expect(layout.panel.bottom).toBeLessThanOrEqual(layout.viewport.height + 0.5);
  expect(overlapArea(layout.panel, layout.ring)).toBe(0);
  expect(overlapArea(layout.panel, layout.send)).toBe(0);
  expect(overlapArea(layout.panel, layout.model)).toBe(0);
  const panelFacts = await facts(page);
  expect(panelFacts.scrollers, "低高度也不叠加内层滚动").toBe(0);
  expect(panelFacts.overflow, "紧凑内容在低高度下也应一次展示").toBeLessThanOrEqual(1);
  expect(panelFacts.overflowY, "浮层自身只在真实溢出时兜底").toBe("auto");
  await page.screenshot({ path: shot("panel-low-560x430-page.png"), fullPage: false });
  await panel.screenshot({ path: shot("panel-low-560x430-element.png") });
});

test("浮层与模型下拉互斥、Esc 收起还焦点、点外即收", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(panel).toBeFocused();

  await page.getByTestId("model-selector-open").click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("model-selector-menu")).toBeVisible();
  await meter.click();
  await expect(page.getByTestId("model-selector-menu")).toBeHidden();
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(meter).toBeFocused();

  await meter.click();
  await expect(panel).toBeVisible();
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await expect(panel).toBeHidden();
});

test("手动压缩仍可从 /compact 命令入口执行", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  const server = await installRoutes(page);
  await openChat(page);
  const draft = page.getByTestId("assist-draft");
  await draft.fill("/");
  await expect(page.getByTestId("chat-command-compact")).toBeVisible();
  await page.screenshot({ path: shot("command-compact-menu.png"), fullPage: false });
  await page.keyboard.press("Escape");
  await draft.fill("/compact");
  await page.getByTestId("assist-send").click();
  // 这套夹具没有完整必读文件审计；发送前的风险检查会礼貌地要求确认一次。
  const confirm = page.getByRole("button", { name: "仍然发送" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect.poll(() => server.compactBodies.length, { timeout: 10_000 }).toBe(1);
  expect(server.compactBodies[0]?.text).toBe("/compact");
  await expect(page.getByText(/已受理整理请求（PENDING）/)).toBeVisible();
  // 浮层按钮已删，但底层 chat-commands Owner 与 202 受理仍然真实走通。
  await expect(page.getByTestId("context-compaction-now")).toHaveCount(0);
});
