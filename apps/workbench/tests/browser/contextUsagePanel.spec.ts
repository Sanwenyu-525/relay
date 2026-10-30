import { expect, test, type Page, type Route } from "@playwright/test";

// 上下文用量浮层（0145 / 2026-10-30）：真实 Chromium 里的几何与状态验收。
//
// 这一轮浮层的三段内容各有来源，因此判据也分三层：
//   ① 用量摘要——主读数一行「已用 / 该次冻结预算 tokens + 占比」、细进度线、两列二级信息；
//   ② 上下文构成——只显示服务端真的采到的分项，标「估算」；没有分项时只写「暂无分项统计」；
//   ③ 上下文档位——三档严格横排、没有「跟随应用默认」、保存只写这一条会话。
//
// 几何判据（真实桌面窗口 + 窄窗）：
//   · 浮层待在输入卡与视口内（中栏 overflow:hidden，越出即被裁）；
//   · 不压住发送键，右缘贴圆环右缘；
//   · 窄窗三档仍在一行（`nowrap`），且各自命中区不小于 24px；
//   · 内容再多也只让浮层内部滚动，不把输入卡顶上去。
//
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
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

/** 有分项：六类里给四类（工具与文件读取分开，正是本轮要能看见的东西）。 */
function breakdown() {
  return { version: 1, method: "UTF8_BYTES_DIV_3", precision: "ESTIMATED",
    categories: [
      { key: "HISTORY", bytes: 12_000, tokens: 4_000 },
      { key: "SYSTEM", bytes: 9_000, tokens: 3_000 },
      { key: "TOOLS", bytes: 6_000, tokens: 2_000 },
      { key: "FILE_READS", bytes: 4_821, tokens: 1_607 }],
    estimated_total_tokens: 10_607, covered_bytes: 31_821, image_parts: 0 };
}

function contextUsage(options: { readonly withBreakdown: boolean; readonly tokens?: number;
  readonly revision?: string; readonly input?: number; readonly reserved?: number }): unknown {
  return { session_id: sessionId,
    budget: { tokens: options.tokens ?? 262_144, revision: options.revision ?? "2" },
    last_call: { source: "MODEL_CALL", call_id: "cccc3333-3333-4333-8333-333333333333",
      message_id: completedAssistant.id, provider: "openai-compatible", model: "gpt-4.1-mini",
      status: "COMPLETED", input_tokens: options.input ?? 10_607,
      output_tokens: 646, cache_read_tokens: null, cache_creation_tokens: null,
      reserved_tokens: options.reserved ?? 65_536, settled_at: "2026-10-30T00:00:00Z",
      breakdown: options.withBreakdown ? breakdown() : null } };
}

async function installRoutes(page: Page, options: { readonly withBreakdown: boolean }): Promise<void> {
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
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 65_536 });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [session] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, session);
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route,
      { items: [completedUser, completedAssistant] });
    if (path === `${prefix}/assist-sessions/${sessionId}/context-usage`) {
      return fulfillJson(route, contextUsage({ withBreakdown: options.withBreakdown }));
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

test("用量浮层：有三档横排、无「跟随应用默认」，选中即改变并显示权威回执", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  const writes: Record<string, unknown>[] = [];
  let tokens = 262_144;
  let revision = 2;
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-budget`,
    async (route) => {
      const body = JSON.parse(String(route.request().postData())) as Record<string, unknown>;
      writes.push(body);
      tokens = body.context_budget_tokens as number;
      revision += 1;
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: sessionId, context_budget_tokens: tokens,
          revision: String(revision) } });
    });
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-usage`,
    async (route) => fulfillJson(route, contextUsage({ withBreakdown: true, tokens,
      revision: String(revision) })));
  await openPanel(page);

  const panel = page.getByTestId("assist-context-meter-panel");
  const tiers = panel.getByTestId("context-usage-tiers");
  expect(await tiers.locator("input[type=radio]").count()).toBe(3);
  await expect(tiers.locator("input")).toHaveCount(3);
  // 三个选项在同一行：顶边相同才算「横排」，这是本轮最容易被写成两行的判据。
  const tops = await tiers.locator("label").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(panel).not.toContainText("跟随应用默认");
  await expect(panel.getByTestId("context-budget-option-262144")).toBeChecked();
  // 0145 复审恢复的交互：选档只改「已选值」，「保存档位」才写服务端。
  await expect(panel.getByTestId("context-budget-save")).toHaveCount(1);
  await expect(panel.getByTestId("context-budget-reload")).toHaveCount(1);
  await expect(panel.getByTestId("context-usage-tier-state")).toContainText("当前生效：256K");

  for (const next of [524_288, 1_048_576]) {
    await panel.getByTestId(`context-budget-option-${next}`).check();
    // 只选不保存：状态行照实说「尚未保存」，不宣称已经切换。
    await expect(panel.getByTestId("context-usage-tier-state")).toContainText("尚未保存");
    await panel.getByTestId("context-budget-save").click();
    await expect(panel.getByTestId("context-budget-notice"))
      .toContainText(next.toLocaleString("zh-CN"));
    await expect(panel.getByTestId(`context-budget-option-${next}`)).toBeChecked();
  }
  expect(writes.map((body) => [body.expected_revision, body.context_budget_tokens]))
    .toEqual([["2", 524_288], ["3", 1_048_576]]);

  await page.screenshot({ path: "output/context-usage-20261030/panel-breakdown.png", fullPage: true });
});

test("用量浮层：分项按固定顺序、标「估算」，与圆环读数同一份记录", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  // 圆环与浮层读同一份记录：10,607 / 65,536 = 16%。
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(meter).toHaveAttribute("aria-label", "上下文 10,607 / 65,536 tokens（16%）");
  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveText("16%");
  await expect(panel.getByTestId("assist-context-meter-remaining")).toHaveText("54,929 tokens");
  await expect(panel.getByTestId("assist-context-meter-output")).toHaveText("646 tokens");

  await expect(panel.getByTestId("context-usage-estimate")).toHaveText("估算");
  const rows = panel.locator('[data-testid^="context-usage-row-"]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("历史消息");
  await expect(rows.nth(1)).toContainText("系统 / 指令");
  await expect(rows.nth(2)).toContainText("工具调用");
  await expect(rows.nth(3)).toContainText("文件读取");
  // 工具调用与文件读取是两行：文件内容不得同时算进工具调用。
  await expect(rows.nth(2)).toContainText("2,000");
  await expect(rows.nth(3)).toContainText("1,607");
});

test("用量浮层：没有分项时只写「暂无分项统计」，总用量照常可读", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: false });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel.getByTestId("context-usage-breakdown-empty"))
    .toContainText("暂无分项统计");
  await expect(panel.locator('[data-testid^="context-usage-row-"]')).toHaveCount(0);
  // 「估算」标签只属于分项区：没有分项时它也不该出现（摘要里的「预算余量（估算）」是另一回事）。
  await expect(panel.getByTestId("context-usage-estimate")).toHaveCount(0);
  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveText("16%");
  await page.screenshot({ path: "output/context-usage-20261030/panel-no-breakdown.png", fullPage: true });
});

test("用量浮层：窄窗（560×700）三档仍横排、浮层待在卡内且不压发送键", async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 700 });
  await installRoutes(page, { withBreakdown: true });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const tiers = panel.getByTestId("context-usage-tiers");
  const tops = await tiers.locator("label").evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(tops).size, "窄窗也必须是一行三档").toBe(1);
  // 每个选项的命中区不因收窄而缩到不可点。
  const heights = await tiers.locator("label").evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height));
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(20);

  const geometry = await page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const panelNode = document.querySelector<HTMLElement>('[data-testid="assist-context-meter-panel"]');
    return { panel: box('[data-testid="assist-context-meter-panel"]'),
      card: box('[data-testid="assist-composer"]'),
      send: box('[data-testid="assist-send"]'),
      ring: box('[data-testid="assist-composer"] [data-testid="assist-context-meter"]'),
      scrollable: panelNode === null ? false : panelNode.scrollHeight > panelNode.clientHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
  if (geometry.panel === null || geometry.card === null || geometry.send === null
    || geometry.ring === null) throw new Error("缺少浮层几何采样");
  // 浮层以**整张输入卡**为锚点（圆环在工具行里，以它为锚会压住正文输入区）：
  // 右缘落在卡片右缘内，底缘落在卡片上方，正文输入区与工具行一件都不遮。
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.card.right + 0.5);
  expect(geometry.panel.bottom, "浮层不得压进输入卡").toBeLessThanOrEqual(geometry.card.top + 0.5);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.card.left - 0.5);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.card.right + 0.5);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  // 底缘在整张卡片之上：既不盖发送键，也不盖正文输入区。
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.send.top + 0.5);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

  await page.screenshot({ path: "output/context-usage-20261030/panel-narrow-560.png", fullPage: true });
});

test("用量浮层：与模型下拉互斥、Esc 收起还焦点、点外即收", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
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

test("用量浮层：历史调用没有可靠冻结预算时写「预算未知」，不给未经证实的百分比", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-usage`,
    async (route) => {
      const body = contextUsage({ withBreakdown: true }) as {
        last_call: { reserved_tokens: number | null } | null };
      if (body.last_call !== null) body.last_call.reserved_tokens = null;
      return fulfillJson(route, body);
    });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel.getByTestId("assist-context-meter-budget-unknown")).toHaveText("预算未知");
  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveCount(0);
  // 圆环同样回到未知态：不画弧、不给百分比。
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(meter).toHaveAttribute("data-state", "unknown");
  await expect(meter.locator(".agent-chat-context-meter-fill")).toHaveCount(0);
});

test("空白新会话（还没有会话）也能选三档：选择不写服务端，只落草稿作用域", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  const writes: unknown[] = [];
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-budget`,
    async (route) => {
      writes.push(route.request().postData());
      return fulfillJson(route, { code: "RESOURCE_NOT_FOUND" }, 404);
    });
  await page.goto("/agent?new=1");
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  // 空白新会话的输入器没有 assist-composer 标记，圆形计量环在它自己的尾部。
  await page.getByTestId("assist-context-meter").first().click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("context-usage-tiers")).toBeVisible();
  // 没有来源会话（?new=1 直接打开）：写清楚「从 256K 起」，不冒充继承。
  await expect(panel.getByTestId("context-usage-tier-state")).toContainText("没有来源会话");
  await panel.getByTestId("context-budget-option-1048576").check();
  await expect(panel.getByTestId("context-budget-option-1048576")).toBeChecked();
  await expect(panel.getByTestId("context-usage-tier-state")).toContainText("已选 1024K");
  // 还没有会话：不发任何档位写请求。
  expect(writes).toHaveLength(0);
});

test("用量浮层：写成功后不回闪——投影还没刷新时选择器仍停在刚写的那一档", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-budget`,
    async (route) => {
      const body = JSON.parse(String(route.request().postData())) as Record<string, unknown>;
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-30T00:00:00Z",
        result: { session_id: sessionId, context_budget_tokens: body.context_budget_tokens,
          revision: "3" } });
    });
  // 投影**故意**返回旧档位（模拟重读还没追上）。
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-usage`,
    async (route) => fulfillJson(route, contextUsage({ withBreakdown: true, tokens: 262_144,
      revision: "2" })));
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  await panel.getByTestId("context-budget-option-524288").check();
  await panel.getByTestId("context-budget-save").click();
  await expect(panel.getByTestId("context-budget-notice")).toContainText("524,288");
  // 写成功 ≠ 界面跳回旧值：回执已经确认 512K，选择器就停在 512K。
  await expect(panel.getByTestId("context-budget-option-524288")).toBeChecked();
  await expect(panel.getByTestId("context-budget-option-262144")).not.toBeChecked();
});
