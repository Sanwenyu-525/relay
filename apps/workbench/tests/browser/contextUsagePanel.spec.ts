import { expect, test, type Page, type Route } from "@playwright/test";
import { contextCompactionWireFixture } from "../contextUsageFixture";

/**
 * 0165：上下文用量浮层只读展示「模型真实窗口 / 用户阈值 / 生效阈值 / 距离」，
 * 不再有三档窗口选择；手动压缩仍可用。
 *
 * 这里用真实 Chromium 核对界面事实：模型窗口只读、未知窗口不伪造 1M、用户设置与
 * 生效值分开说、分项读序稳定、浮层不压住发送键；API 全部由 page.route 伪造。
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

function breakdown() {
  return { version: 1, method: "UTF8_BYTES_DIV_3", precision: "ESTIMATED",
    categories: [
      { key: "HISTORY", bytes: 12_000, tokens: 4_000 },
      { key: "SYSTEM", bytes: 9_000, tokens: 3_000 },
      { key: "TOOLS", bytes: 6_000, tokens: 2_000 },
      { key: "FILE_READS", bytes: 4_821, tokens: 1_607 }],
    estimated_total_tokens: 10_607, covered_bytes: 31_821, image_parts: 0 };
}

function breakdownSix() {
  return { ...breakdown(), categories: [
    { key: "HISTORY", bytes: 12_000, tokens: 4_000 },
    { key: "SYSTEM", bytes: 9_000, tokens: 3_000 },
    { key: "TOOLS", bytes: 6_000, tokens: 2_000 },
    { key: "FILE_READS", bytes: 4_821, tokens: 1_607 },
    { key: "MEMORY", bytes: 3_000, tokens: 1_000 },
    { key: "OTHER", bytes: 1_800, tokens: 600 }],
    estimated_total_tokens: 12_207, covered_bytes: 36_621, image_parts: 2 };
}

function contextUsage(options: {
  readonly withBreakdown?: boolean;
  readonly input?: number;
  readonly reserved?: number | null;
  readonly compaction?: Record<string, unknown>;
} = {}): unknown {
  return { session_id: sessionId,
    next_call: { reservation_tokens: 1_000_000, effective_window_tokens: 1_000_000,
      model_window_tokens: 1_000_000, provider_call_cap_tokens: 1_000_000,
      window_source: "MODEL_CATALOG", fallback_applied: false },
    last_call: { source: "MODEL_CALL", call_id: "cccc3333-3333-4333-8333-333333333333",
      message_id: completedAssistant.id, provider: "openai-compatible", model: "gpt-4.1-mini",
      status: "COMPLETED", input_tokens: options.input ?? 10_607,
      output_tokens: 646, cache_read_tokens: null, cache_creation_tokens: null,
      reserved_tokens: options.reserved === undefined ? 1_000_000 : options.reserved,
      settled_at: "2026-10-30T00:00:00Z",
      breakdown: options.withBreakdown === false ? null : breakdown() },
    compaction: contextCompactionWireFixture(options.compaction ?? {}) };
}

async function installRoutes(page: Page, options: Parameters<typeof contextUsage>[0] = {}): Promise<void> {
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

async function openPanel(page: Page): Promise<void> {
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await page.getByTestId("assist-composer").getByTestId("assist-context-meter").click();
  await expect(page.getByTestId("assist-context-meter-panel")).toBeVisible();
}

type Rect = { left: number; right: number; top: number; bottom: number;
  width: number; height: number };

async function measure(page: Page): Promise<{ panel: Rect | null; ring: Rect | null;
  send: Rect | null; model: Rect | null; position: string | null;
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
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

test("用量浮层：展示模型窗口、用户阈值、实际生效阈值与距离；没有三档入口", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  await expect(panel.getByTestId("context-budget-option-262144")).toHaveCount(0);
  await expect(panel.getByTestId("context-budget-option-524288")).toHaveCount(0);
  await expect(panel.getByTestId("context-budget-option-1048576")).toHaveCount(0);
  await expect(panel.locator("input[type=radio]")).toHaveCount(0);
  await expect(panel.getByTestId("context-compaction-window-row")).toContainText("1,000,000");
  await expect(panel.getByTestId("context-compaction-window-source"))
    .toContainText("自动识别 · 模型目录 · 不可在此修改");
  await expect(panel.getByTestId("context-compaction-configured-row")).toContainText("350,000");
  await expect(panel.getByTestId("context-compaction-threshold-row")).toContainText("350,000");
  await expect(panel.getByTestId("context-compaction-distance"))
    .toHaveText("距离自动压缩还有 70,000 tokens。");
  await expect(panel.getByTestId("context-compaction-now")).toBeEnabled();

  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(meter).toHaveAttribute("aria-label", "上下文 10,607 / 1,000,000 tokens（1%）");
  await expect(panel.getByTestId("context-compaction-current")).toHaveText("280,000");
  await expect(panel.getByTestId("context-compaction-threshold")).toHaveText("350,000");
  await page.screenshot({ path: shot("panel-default-1m.png"), fullPage: true });
});

test("用量浮层：分项按固定顺序、标「估算」，与圆环读同一份记录", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveText("1%");
  await expect(panel.getByTestId("assist-context-meter-remaining")).toHaveText("989,393 tokens");
  await expect(panel.getByTestId("context-usage-estimate")).toHaveText("估算");
  const rows = panel.locator('[data-testid^="context-usage-row-"]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("历史消息");
  await expect(rows.nth(1)).toContainText("系统 / 指令");
  await expect(rows.nth(2)).toContainText("工具调用");
  await expect(rows.nth(3)).toContainText("文件读取");
});

test("用量浮层：模型窗口未知时按安全回退显示，不伪造 1M", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { compaction: { model_window_tokens: null,
    window_source: "UNKNOWN_FALLBACK", provider_call_cap_tokens: null,
    effective_window_tokens: 262_144, safe_input_tokens: 240_000,
    requested_threshold_tokens: 350_000, effective_threshold_tokens: 216_000,
    threshold_clamped: true, context_tokens: 100_000, distance_tokens: 116_000 } });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  await expect(panel.getByTestId("context-compaction-window-row"))
    .toContainText("未知（按安全回退 262,144 tokens）");
  await expect(panel.getByTestId("context-compaction-window-source"))
    .toContainText("未知 · 安全回退 · 不可在此修改");
  await expect(panel.getByTestId("context-compaction-clamped"))
    .toContainText("用户设置 350,000 tokens / 实际生效 216,000 tokens");
  await expect(panel.getByTestId("context-compaction-clamped")).toContainText("当前模型上下文容量不足");
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(meter).toHaveAttribute("aria-label", "上下文 10,607 / 262,144 tokens（4%）");
});

test("用量浮层：560px 窄窗仍贴环、不横向溢出、不盖住发送键与模型下拉", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 700 });
  await installRoutes(page);
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const geometry = await measure(page);
  if (geometry.panel === null || geometry.ring === null || geometry.send === null
    || geometry.model === null) throw new Error("缺少浮层几何采样");

  expect(geometry.position).toBe("fixed");
  expect(geometry.panel.width).toBeLessThanOrEqual(384.5);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(7.5);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width - 7.5);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(7.5);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  const ringCenter = (geometry.ring.left + geometry.ring.right) / 2;
  expect(ringCenter).toBeGreaterThanOrEqual(geometry.panel.left - 0.5);
  expect(ringCenter).toBeLessThanOrEqual(geometry.panel.right + 0.5);
  expect(overlapArea(geometry.panel, geometry.send), "浮层不得盖住发送键").toBe(0);
  expect(overlapArea(geometry.panel, geometry.model), "浮层不得盖住模型下拉").toBe(0);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: shot("panel-narrow-560.png"), fullPage: true });
});

test("用量浮层：与模型下拉互斥、Esc 收起还焦点、点外即收", async ({ page }) => {
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

test("用量浮层：手动压缩显示受理状态，禁止重复点击", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/memory/compact`,
    async (route) => {
      writes += 1;
      const body = JSON.parse(String(route.request().postData())) as Record<string, unknown>;
      await gate;
      return fulfillJson(route, { command_id: body.command_id,
        committed_at: "2026-11-15T00:00:00Z", result: { session_id: sessionId,
          status: "PENDING", request_id: "dddd4444-4444-4444-8444-444444444444" } }, 202);
    });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const button = panel.getByTestId("context-compaction-now");
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toContainText("正在提交");
  await page.waitForTimeout(150);
  expect(writes).toBe(1);
  release();
  await expect(panel.getByTestId("context-compaction-notice"))
    .toContainText("已受理压缩请求", { timeout: 20_000 });
});

test("空白新会话（还没有会话）不显示上下文圆环，也没有窗口入口", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page);
  await page.goto("/agent?new=1");
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("assist-first-draft")).toBeVisible();
  await expect(page.getByTestId("assist-context-meter")).toHaveCount(0);
  await expect(page.getByTestId("assist-context-meter-panel")).toHaveCount(0);
});

test("用量浮层：六类分项各上一色，文本与数值保持中性，颜色不是唯一载体", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-usage`, async (route) => {
    const body = contextUsage({ withBreakdown: true }) as {
      last_call: { breakdown: unknown } | null };
    if (body.last_call !== null) body.last_call.breakdown = breakdownSix();
    return fulfillJson(route, body);
  });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const rows = panel.locator('[data-testid^="context-usage-row-"]');
  await expect(rows).toHaveCount(6);

  const sampled = await rows.evaluateAll((nodes) => {
    const menu = document.querySelector<HTMLElement>('[data-testid="assist-context-meter-panel"]');
    if (menu === null) throw new Error("缺少浮层");
    const resolve = (expression: string) => {
      const probe = document.createElement("span");
      probe.style.color = expression;
      menu.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const neutral = { secondary: resolve("var(--relay-color-text-secondary)"),
      primary: resolve("var(--relay-color-text-primary)") };
    const tokens = { HISTORY: resolve("var(--relay-color-category-history)"),
      SYSTEM: resolve("var(--relay-color-category-system)"),
      TOOLS: resolve("var(--relay-color-category-tools)"),
      FILE_READS: resolve("var(--relay-color-category-fileReads)"),
      MEMORY: resolve("var(--relay-color-category-memory)"),
      OTHER: resolve("var(--relay-color-category-other)") };
    const surface = getComputedStyle(menu).backgroundColor;
    const rgb = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
    const luminance = (value: string) => rgb(value).map((channel) => channel / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (fg: string, bg: string) => {
      const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => x - y);
      return (b + 0.05) / (a + 0.05);
    };
    return nodes.map((node) => {
      const category = (node as HTMLElement).dataset.category as keyof typeof tokens;
      const icon = node.querySelector<SVGSVGElement>(".context-usage-row-icon");
      const label = node.querySelector<HTMLElement>(".context-usage-row-label");
      const value = node.querySelector<HTMLElement>(".context-usage-row-value");
      if (icon === null || label === null || value === null) throw new Error("缺少分项行结构");
      return { category, icon: getComputedStyle(icon).color, token: tokens[category],
        label: getComputedStyle(label).color, value: getComputedStyle(value).color,
        neutral, surface, contrast: contrast(getComputedStyle(icon).color, surface),
        glyph: icon.innerHTML };
    });
  });

  expect(sampled.map((row) => row.category))
    .toEqual(["HISTORY", "SYSTEM", "TOOLS", "FILE_READS", "MEMORY", "OTHER"]);
  for (const row of sampled) {
    expect(row.icon, `${row.category} 的图标色必须来自分类 token`).toBe(row.token);
    expect(row.contrast, `${row.category} 的图标对浮层底面不足 3:1`).toBeGreaterThanOrEqual(3);
    expect(row.label, `${row.category} 的标签被上了色`).toBe(row.neutral.secondary);
    expect(row.value, `${row.category} 的数值被上了色`).toBe(row.neutral.primary);
  }
  expect(new Set(sampled.map((row) => row.glyph)).size).toBe(6);
  await page.screenshot({ path: shot("panel-categories.png"), fullPage: true });
});
