import { expect, test, type Page, type Route } from "@playwright/test";

// 上下文用量浮层（0145 / 2026-10-30，UI-CONTEXT-FINAL-POLISH / 2026-11-01 收口）：真实 Chromium 里的几何与状态验收。
//
// 浮层三段内容各有来源，读序按「先看事实 → 再看构成 → 最后才改档位」：
//   ① 最近一次模型调用——主读数一行「已用 / 该次冻结预算 tokens + 占比」、细进度线、两列二级信息；
//   ② 上下文构成——只显示服务端真的采到的分项，标「估算」；没有分项时只写「暂无分项统计」；
//   ③ 当前档位——三档严格横排，落在浮层最底部的**停靠区**（真实布局，不是 sticky 覆盖层）。
//
// 几何判据（真实桌面窗口 + 窄窗）：
//   · 浮层以**圆环**为锚（不再是整张输入卡）：上方放得下就贴在环顶上方 7px，放不下才翻到环下方；
//   · 水平中线对准圆环中心，整块夹进视口；portal 到 body，所以 fixed 坐标就是视口坐标，不被中栏 overflow 裁掉；
//   · 不压住发送键与模型下拉（工具行在浮层之下）；
//   · 窄窗三档仍在一行（`nowrap`），且各自命中区不小于 20px；档位停靠区始终在首屏可点；
//   · 内容再多也只让滚动区内部滚动，不把输入卡顶上去，也不重置滚动位置。
//
// 只连页面内夹具：不连数据库、不调 Provider、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
// 夹具的 CORS 允许源必须跟着实际预览端口走：playwright.config.ts 支持 RELAY_E2E_PORT 覆盖，
// 写死 4173 会让换端口的整轮用例卡在「已连接」之前（响应被浏览器按 CORS 拦掉）。
const origin = `http://127.0.0.1:${process.env.RELAY_E2E_PORT ?? "4173"}`;
// 本轮（UI-CONTEXT-FINAL-POLISH）新增材料只落在这一个目录，不再往 output/ 的既有验收证据里追加。
const shots = "D:/Develop/Relay-Agent/tmp/UI-context-final-polish";

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

/** 六类都给：配色这一轮要看「每一类都有自己的一色，且颜色不是唯一载体」。 */
function breakdownSix() {
  return { version: 1, method: "UTF8_BYTES_DIV_3", precision: "ESTIMATED",
    categories: [
      { key: "HISTORY", bytes: 12_000, tokens: 4_000 },
      { key: "SYSTEM", bytes: 9_000, tokens: 3_000 },
      { key: "TOOLS", bytes: 6_000, tokens: 2_000 },
      { key: "FILE_READS", bytes: 4_821, tokens: 1_607 },
      { key: "MEMORY", bytes: 3_000, tokens: 1_000 },
      { key: "OTHER", bytes: 1_800, tokens: 600 }],
    estimated_total_tokens: 12_207, covered_bytes: 36_621, image_parts: 2 };
}

function contextUsage(options: { readonly withBreakdown: boolean; readonly tokens?: number;
  readonly revision?: string; readonly input?: number; readonly reserved?: number }): unknown {
  return { session_id: sessionId,
    budget: { tokens: options.tokens ?? 262_144, revision: options.revision ?? "2" },
    next_call: { reservation_tokens: options.tokens ?? 262_144,
      context_budget_tokens: options.tokens ?? 262_144, provider_window_tokens: null,
      window_source: "UNKNOWN" },
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

type Rect = { left: number; right: number; top: number; bottom: number;
  width: number; height: number };

/**
 * 一次取回浮层几何的全部采样点：圆环、圆环里的 svg、浮层、输入卡、发送键、模型下拉。
 * 浮层 portal 在 body 上且是 `position: fixed`，所以这里的 rect 直接就是视口坐标——
 * 这正是「贴环 7px」能成立的前提，也顺带证明它没有被中栏的 overflow 裁掉。
 */
async function measure(page: Page): Promise<{ panel: Rect | null; ring: Rect | null;
  ringSvg: Rect | null; card: Rect | null; send: Rect | null; model: Rect | null;
  side: string | null; position: string | null; scrollable: boolean; dockVisible: boolean;
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
    const dock = document.querySelector<HTMLElement>(".context-usage-dock");
    const scroll = document.querySelector<HTMLElement>(".context-usage-scroll");
    const dockBox = dock === null ? null : dock.getBoundingClientRect();
    return { panel: rect('[data-testid="assist-context-meter-panel"]'),
      ring: rect('[data-testid="assist-composer"] [data-testid="assist-context-meter"]'),
      ringSvg: rect('[data-testid="assist-composer"] [data-testid="assist-context-meter"] svg'),
      card: rect('[data-testid="assist-composer"]'),
      send: rect('[data-testid="assist-send"]'),
      model: rect('[data-testid="model-selector-open"]'),
      side: menu === null ? null : menu.dataset.side ?? null,
      position: menu === null ? null : getComputedStyle(menu).position,
      scrollable: scroll === null ? false : scroll.scrollHeight > scroll.clientHeight + 1,
      dockVisible: dockBox === null ? false
        : dockBox.top >= 0 && dockBox.bottom <= window.innerHeight && dockBox.height > 0,
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function toRect(box: { x: number; y: number; width: number; height: number }): Rect {
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height,
    width: box.width, height: box.height };
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
  // 2026-10-31 用户指令：档位点击即保存，两枚动作键（保存档位 / 重新读取）已删掉。
  await expect(panel.getByTestId("context-budget-save")).toHaveCount(0);
  await expect(panel.getByTestId("context-budget-reload")).toHaveCount(0);
  // 2026-11-01 用户指令：删掉「当前档位 256K」标题行与状态短标签，当前值只看单选态。
  await expect(panel.getByTestId("context-budget-current")).toHaveCount(0);
  await expect(panel.getByTestId("context-budget-status")).toHaveCount(0);
  // 2026-11-01 用户指令：「下次调用申请 N tokens」一行也删掉——档位选择本身已表达按哪一档申请。
  await expect(panel.getByTestId("context-budget-next")).toHaveCount(0);

  for (const next of [524_288, 1_048_576]) {
    await panel.getByTestId(`context-budget-option-${next}`).check();
    await expect(panel.getByTestId("context-budget-notice"))
      .toContainText(next.toLocaleString("zh-CN"));
    await expect(panel.getByTestId(`context-budget-option-${next}`)).toBeChecked();
  }
  expect(writes.map((body) => [body.expected_revision, body.context_budget_tokens]))
    .toEqual([["2", 524_288], ["3", 1_048_576]]);

  await page.screenshot({ path: `${shots}/panel-breakdown.png`, fullPage: true });
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

test("用量浮层：没有分项时只写「当前记录没有分项统计」，总用量照常可读", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: false });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel.getByTestId("context-usage-breakdown-empty"))
    .toContainText("当前记录没有分项统计");
  await expect(panel.locator('[data-testid^="context-usage-row-"]')).toHaveCount(0);
  // 「估算」标签只属于分项区：没有分项时它也不该出现（摘要里的「预算余量（估算）」是另一回事）。
  await expect(panel.getByTestId("context-usage-estimate")).toHaveCount(0);
  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveText("16%");
  await page.screenshot({ path: `${shots}/panel-no-breakdown.png`, fullPage: true });
});

test("用量浮层：历史 65,536 与当前 1024K 各说各的——不互相冒充", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  // 当前档位是 1024K，但那次历史调用冻结的是 65,536。
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-usage`,
    async (route) => fulfillJson(route, contextUsage({ withBreakdown: true, tokens: 1_048_576,
      revision: "4", reserved: 65_536 })));
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  // 当前档位：1024K（服务端已保存的那一档），只由单选态表达。
  await expect(panel.getByTestId("context-budget-option-1048576")).toBeChecked();
  // 历史读数仍按那次调用冻结的 65,536 解释，不拿 1024K 去除。
  await expect(panel.getByTestId("assist-context-meter-input")).toHaveText("10,607");
  await expect(panel.getByTestId("assist-context-meter-percent")).toHaveText("16%");
  await expect(panel.getByTestId("context-usage-history")).toContainText("最近一次模型调用");
  await expect(panel.getByTestId("context-usage-breakdown")).toBeVisible();
  await page.screenshot({ path: `${shots}/panel-history-vs-current.png`,
    fullPage: true });
});

test("用量浮层：420／560／1024／1366／1920 五档宽度下都贴环、不溢出、三档始终横排", async ({ page }) => {
  await installRoutes(page, { withBreakdown: true });
  for (const width of [420, 560, 1024, 1366, 1920]) {
    await page.setViewportSize({ width, height: 782 });
    await openPanel(page);
    const panel = page.getByTestId("assist-context-meter-panel");
    await expect(panel).toBeVisible();
    const tops = await panel.getByTestId("context-usage-tiers").locator("label").evaluateAll(
      (nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
    expect(new Set(tops).size, `${width}px 下三档必须仍是一行`).toBe(1);
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      `${width}px 下浮层不得横向溢出`).toBe(true);
    const geometry = await measure(page);
    if (geometry.panel === null || geometry.ring === null) throw new Error("缺少浮层几何采样");
    expect(geometry.panel.width, `${width}px 下浮层宽度不应超过 24rem`).toBeLessThanOrEqual(384.5);
    expect(geometry.panel.left, `${width}px 下不得越出视口左缘`).toBeGreaterThanOrEqual(7.5);
    expect(geometry.panel.right, `${width}px 下不得越出视口右缘`).toBeLessThanOrEqual(width - 7.5);
    // 每个宽度都重新贴环：要么底边贴环顶上方 7px，要么翻到环下方 7px；水平中线对准圆环中心。
    const gap = geometry.side === "above"
      ? geometry.ring.top - geometry.panel.bottom
      : geometry.panel.top - geometry.ring.bottom;
    expect(gap, `${width}px 下浮层与圆环的间距（side=${geometry.side}）`).toBeCloseTo(7, 0);
    // 横向：浮层中线对准圆环中心是设计口径；只有被视口边距夹住时（超窄窗里圆环靠近窗口边）才退让，
    // 但无论哪一档，圆环的水平中心都必须落在浮层覆盖的范围内——读数与它所指的那枚环始终连在一起。
    const ringCenter = (geometry.ring.left + geometry.ring.right) / 2;
    const panelCenter = (geometry.panel.left + geometry.panel.right) / 2;
    expect(ringCenter, `${width}px 下浮层必须横向罩住圆环`).toBeGreaterThanOrEqual(geometry.panel.left - 0.5);
    expect(ringCenter, `${width}px 下浮层必须横向罩住圆环`).toBeLessThanOrEqual(geometry.panel.right + 0.5);
    const unclamped = geometry.panel.left > 8.5 && geometry.panel.right < width - 8.5;
    if (unclamped) {
      expect(Math.abs(panelCenter - ringCenter),
        `${width}px 下浮层中线应贴着圆环中心`).toBeLessThanOrEqual(1);
    }
    expect(geometry.dockVisible, `${width}px 下档位区必须在首屏`).toBe(true);
  }
  await page.screenshot({ path: `${shots}/panel-width-1920.png`, fullPage: true });
});

test("用量浮层：圆环被同行控件推走时浮层跟着重算，不留在环已经离开的位置", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  // 模型档位迟到 1.2s：这一行右侧多出一枚「gpt-4.1-mini」下拉，把圆环往左推。
  // 卡片和圆环自己的尺寸都没变——只有打开期间持续比对环的矩形，浮层才不会停在旧位置。
  await page.route(`${apiBase}${prefix}/model-port`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return fulfillJson(route, { provider: "openai-compatible", configured: true,
      model: "gpt-4.1-mini", base_url: null, max_call_tokens: 65_536 });
  });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await page.getByTestId("assist-composer").getByTestId("assist-context-meter").click();
  const panel = page.getByTestId("assist-context-meter-panel");
  await expect(panel).toBeVisible();
  const before = await measure(page);
  if (before.panel === null || before.ring === null) throw new Error("缺少浮层几何采样");
  // 迟到之前先对齐一次，否则「跟着重算」这条判据没有对照。
  const centerOf = (rect: Rect) => (rect.left + rect.right) / 2;
  expect(Math.abs(centerOf(before.panel) - centerOf(before.ring))).toBeLessThanOrEqual(1);

  await page.getByTestId("model-selector-open").getByText("gpt-4.1-mini").waitFor({ timeout: 10_000 });
  await expect.poll(async () => {
    const now = await measure(page);
    if (now.panel === null || now.ring === null) return Number.NaN;
    return Math.abs(centerOf(now.panel) - centerOf(now.ring));
  }, "圆环被推走后浮层必须重新对准环心").toBeLessThanOrEqual(1);
  const after = await measure(page);
  if (after.panel === null || after.ring === null) throw new Error("缺少圆环推走后的浮层几何采样");
  expect(Math.abs(centerOf(after.ring) - centerOf(before.ring)), "对照：圆环确实被同行控件推走了")
    .toBeGreaterThan(4);
  const gap = after.side === "above" ? after.ring.top - after.panel.bottom : after.panel.top - after.ring.bottom;
  expect(gap, "重算后仍保持 7px 贴环间距").toBeCloseTo(7, 0);
  await page.screenshot({ path: `${shots}/panel-retrack-after-model-arrives.png`, fullPage: true });
});

test("用量浮层：窄窗（560×700）三档仍横排、浮层贴环且不压住工具行", async ({ page }) => {
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

  const geometry = await measure(page);
  if (geometry.panel === null || geometry.send === null || geometry.ring === null
    || geometry.model === null) throw new Error("缺少浮层几何采样");
  expect(geometry.position, "浮层必须是视口坐标下的 fixed（portal 到 body），否则会被中栏裁掉")
    .toBe("fixed");
  // 贴环：上方放得下时底边落在环顶上方 7px（用户要的 6–8px 安全间距）。
  expect(geometry.side, "560×700 上方空间足够，不该翻面").toBe("above");
  expect(geometry.ring.top - geometry.panel.bottom, "浮层底边与圆环顶边的间距").toBeCloseTo(7, 0);
  // 水平方向：中线对准环心；窄窗里浮层比剩余空间宽时被视口右缘夹住，此时至少仍罩住环心。
  const ringCenter = (geometry.ring.left + geometry.ring.right) / 2;
  expect(ringCenter).toBeGreaterThanOrEqual(geometry.panel.left - 0.5);
  expect(ringCenter).toBeLessThanOrEqual(geometry.panel.right + 0.5);
  if (geometry.panel.right < geometry.viewport.width - 8.5) {
    expect(Math.abs((geometry.panel.left + geometry.panel.right) / 2 - ringCenter)).toBeLessThanOrEqual(1);
  }
  // 完整落在视口内——portal 后没有任何祖先能裁它。
  expect(geometry.panel.left).toBeGreaterThanOrEqual(7.5);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(7.5);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width - 7.5);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  // 工具行（发送键、模型下拉）一件都不遮：浮层只压正文输入区。
  expect(overlapArea(geometry.panel, geometry.send), "浮层不得盖住发送键").toBe(0);
  expect(overlapArea(geometry.panel, geometry.model), "浮层不得盖住模型下拉").toBe(0);
  // 档位停靠区仍在首屏可点。
  expect(geometry.dockVisible, "窄窗里档位区也必须整块在视口内").toBe(true);
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

  await page.screenshot({ path: `${shots}/panel-narrow-560.png`, fullPage: true });
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
  await expect(panel.getByTestId("context-usage-first-tier-state")).toContainText("没有来源会话");
  await panel.getByTestId("context-budget-option-1048576").check();
  await expect(panel.getByTestId("context-budget-option-1048576")).toBeChecked();
  await expect(panel.getByTestId("context-usage-first-tier-state")).toContainText("已选 1024K");
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
  await expect(panel.getByTestId("context-budget-notice")).toContainText("524,288");
  // 写成功 ≠ 界面跳回旧值：回执已经确认 512K，选择器就停在 512K。
  await expect(panel.getByTestId("context-budget-option-524288")).toBeChecked();
  await expect(panel.getByTestId("context-budget-option-262144")).not.toBeChecked();
});

test("用量浮层：读序是最近一次模型调用 → 上下文构成 → 当前档位，档位落在最底部的停靠区", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");

  // 停靠区是真实布局的第二行，不是 sticky 覆盖层：它是 .context-usage 的最后一个子元素。
  const rows = await panel.locator(".context-usage > *").evaluateAll((nodes) =>
    nodes.map((node) => node.className));
  expect(rows).toEqual(["context-usage-scroll", "context-usage-dock"]);
  await expect(panel.locator(".context-usage-dock [data-testid='context-usage-tiers']")).toHaveCount(1);
  await expect(panel.locator(".context-usage-scroll [data-testid='context-usage-breakdown']")).toHaveCount(1);
  await expect(panel.locator(".context-usage-dock [data-testid='context-usage-breakdown']")).toHaveCount(0);

  // 视觉上也是这个顺序：历史读数在上、分项居中、三档在最下。
  const tops = await panel.evaluate(() => {
    const top = (selector: string) => document.querySelector<HTMLElement>(
      `[data-testid="assist-context-meter-panel"] ${selector}`)!.getBoundingClientRect().top;
    return { history: top('[data-testid="context-usage-history"]'),
      breakdown: top('[data-testid="context-usage-breakdown"]'),
      dock: top(".context-usage-dock"), tiers: top('[data-testid="context-usage-tiers"]') };
  });
  expect(tops.history).toBeLessThan(tops.breakdown);
  expect(tops.breakdown).toBeLessThan(tops.dock);
  expect(tops.dock).toBeLessThanOrEqual(tops.tiers);

  // 短窗口优先保证档位可操作：停靠区整块在首屏内，也不反过来盖住分项。
  await page.setViewportSize({ width: 1162, height: 430 });
  await openPanel(page);
  const geometry = await measure(page);
  expect(geometry.dockVisible, "430px 高的窗口里三档也必须整块可点").toBe(true);
  const dockBox = await panel.locator(".context-usage-dock").boundingBox();
  // 比的是「停靠区 vs 读数滚动区的视口」，不是分项列表那根被裁掉的长内容：
  // 列表在滚动区里本来就比视口高，拿它的 rect 会比出一个并不存在的遮挡。
  const scrollBox = await panel.locator(".context-usage-scroll").boundingBox();
  if (dockBox === null || scrollBox === null) throw new Error("缺少停靠区/读数区几何");
  expect(overlapArea(toRect(dockBox), toRect(scrollBox)),
    "停靠区不得盖住读数区（短窗口里靠收窄滚动区让位，不靠覆盖）").toBe(0);
  expect(await panel.evaluate((node) => node.getBoundingClientRect().bottom),
    "浮层整体不得越出视口").toBeLessThanOrEqual(430 + 0.5);
  await page.screenshot({ path: `${shots}/panel-short-430.png`, fullPage: true });
});

test("用量浮层：慢响应保存期间菜单不关、不跳顶、滚动位置不重置", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 460 });
  await installRoutes(page, { withBreakdown: true });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-budget`, async (route) => {
    const body = JSON.parse(String(route.request().postData())) as Record<string, unknown>;
    await gate;
    return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-11-01T00:00:00Z",
      result: { session_id: sessionId, context_budget_tokens: body.context_budget_tokens,
        revision: "3" } });
  });
  await openPanel(page);
  const panel = page.getByTestId("assist-context-meter-panel");
  const scroll = panel.locator(".context-usage-scroll");
  await expect.poll(async () => scroll.evaluate((node) => node.scrollHeight > node.clientHeight + 1),
    "短窗口下读数区应自带滚动").toBe(true);
  await scroll.evaluate((node) => { node.scrollTop = 40; });
  const before = await scroll.evaluate((node) => node.scrollTop);
  expect(before, "滚动位置必须真的建立了，否则这条判据是空的").toBeGreaterThan(20);

  await panel.getByTestId("context-budget-option-524288").check();
  // 在途 300ms：状态说「保存中」，但界面不许因此变形——菜单还开着、滚动没被重置、读数没跳。
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("context-usage-tier-state"))
    .toContainText("正在保存 512K；确认之前仍按 256K 生效");
  expect(await scroll.evaluate((node) => node.scrollTop), "在途不得跳回顶部").toBeGreaterThan(0);
  expect(await panel.getByTestId("assist-context-meter-percent").textContent()).toBe("16%");

  release();
  await expect(panel.getByTestId("context-budget-notice")).toContainText("524,288");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("context-budget-option-524288")).toBeChecked();
  expect(await scroll.evaluate((node) => node.scrollTop), "回执落地后仍不得跳顶").toBeGreaterThan(0);
  expect(await panel.getByTestId("assist-context-meter-percent").textContent()).toBe("16%");
  await page.screenshot({ path: `${shots}/panel-slow-save.png`, fullPage: true });
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
  // 图标只吃 token：色值来自 `--relay-color-category-*`，不是硬编码——将来挂上暗色主题会一起换。
  for (const row of sampled) {
    expect(row.icon, `${row.category} 的图标色必须来自分类 token`).toBe(row.token);
    // 非文本图形（图标）对底面 ≥3:1。
    expect(row.contrast, `${row.category} 的图标对浮层底面不足 3:1`).toBeGreaterThanOrEqual(3);
    // 上色只到图标为止：文本与数值一律中性（标签走次要文本色，数值走主文本色）。
    expect(row.label, `${row.category} 的标签被上了色`).toBe(row.neutral.secondary);
    expect(row.value, `${row.category} 的数值被上了色`).toBe(row.neutral.primary);
  }
  expect(new Set(sampled.map((row) => row.icon)).size).toBe(6);
  // 颜色不是唯一载体：六行各有文字标签，且图标形状互不相同（色觉差异下仍能区分）。
  expect(new Set(sampled.map((row) => row.glyph)).size).toBe(6);
  const labels = await rows.locator(".context-usage-row-label").allTextContents();
  expect(new Set(labels).size).toBe(6);
  await page.screenshot({ path: `${shots}/panel-categories.png`, fullPage: true });
});

test("圆环：视觉 24px 但点击区不小于 32px，右侧独立百分比文本已删，读数仍在 aria-label 与 Tooltip", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  await installRoutes(page, { withBreakdown: true });
  await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
  await connect(page);
  await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("assist-context-meter-panel")).toHaveCount(0);

  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  await expect(meter).toHaveAttribute("aria-label", "上下文 10,607 / 65,536 tokens（16%）");
  // 独立百分比文本删掉了：圆环右侧不再有那枚数字（详情浮层与 Tooltip 才是它的去处）。
  await expect(meter.locator(".agent-chat-context-meter-value")).toHaveCount(0);
  await expect(meter.locator("span")).toHaveCount(0);

  const geometry = await measure(page);
  if (geometry.ring === null || geometry.ringSvg === null) throw new Error("缺少圆环几何");
  expect(geometry.ringSvg.width, "圆环视觉尺寸 24px").toBeCloseTo(24, 0.6);
  expect(geometry.ringSvg.height, "圆环视觉尺寸 24px").toBeCloseTo(24, 0.6);
  expect(geometry.ring.width, "点击区不小于 32px").toBeGreaterThanOrEqual(31.5);
  expect(geometry.ring.height, "点击区不小于 32px").toBeGreaterThanOrEqual(31.5);

  await meter.hover();
  await expect(page.getByTestId("context-meter-tooltip")).toContainText("16%");
  await meter.click();
  await expect(page.getByTestId("assist-context-meter-panel")).toBeVisible();
  await expect(page.getByTestId("context-meter-tooltip")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/ring-24px.png`, fullPage: true });
});

test("圆环：未知／正常／高占用／超额四态各有真实差异，且没有永久动效", async ({ page }) => {
  await page.setViewportSize({ width: 1162, height: 782 });
  const meter = page.getByTestId("assist-composer").getByTestId("assist-context-meter");
  const fill = () => meter.locator(".agent-chat-context-meter-fill");

  async function openWith(options: { readonly input: number; readonly reserved: number | null }) {
    await installRoutes(page, { withBreakdown: true });
    await page.route(`${apiBase}${prefix}/assist-sessions/${sessionId}/context-usage`,
      async (route) => {
        const body = contextUsage({ withBreakdown: true, input: options.input,
          reserved: options.reserved ?? 65_536 }) as {
          last_call: { reserved_tokens: number | null } | null };
        // 夹具里的 `??` 会把 null 吞回 65,536，未知态要真的把这一项写成 null。
        if (body.last_call !== null && options.reserved === null) body.last_call.reserved_tokens = null;
        return fulfillJson(route, body);
      });
    await page.goto(`/agent?work=${taskId}&session=${sessionId}`);
    await connect(page);
    await page.getByTestId("collab-conversation-toolbar").waitFor({ timeout: 20_000 });
    await expect(meter).toBeVisible();
  }

  await openWith({ input: 10_607, reserved: 65_536 });
  await expect(meter).toHaveAttribute("data-state", "normal");
  await expect(meter).not.toHaveAttribute("data-over", "true");
  const normalDash = await fill().getAttribute("stroke-dasharray");
  expect(normalDash).not.toBeNull();
  // 弧长按真实比例算（10,607 / 65,536），不是按四舍五入后的 16%。
  expect(Number(normalDash!.split(" ")[0])).toBeCloseTo(10_607 / 65_536 * 94.25, 1);

  await openWith({ input: 52_429, reserved: 65_536 });
  await expect(meter).toHaveAttribute("data-state", "high");
  expect(await fill().getAttribute("stroke-dasharray")).not.toBe(normalDash);

  await openWith({ input: 70_000, reserved: 65_536 });
  await expect(meter).toHaveAttribute("data-state", "high");
  await expect(meter).toHaveAttribute("data-over", "true");
  // 超额画满一圈，但读数不粉饰：浮层里仍是那 70,000 / 65,536 的比例。
  expect(Number((await fill().getAttribute("stroke-dasharray"))!.split(" ")[0])).toBeCloseTo(94.25, 1);
  await meter.click();
  await expect(page.getByTestId("assist-context-meter-percent")).toHaveText("106.8%");
  await page.screenshot({ path: `${shots}/ring-over.png`, fullPage: true });
  await page.keyboard.press("Escape");

  await openWith({ input: 10_607, reserved: null });
  await expect(meter).toHaveAttribute("data-state", "unknown");
  await expect(fill()).toHaveCount(0);
  // 未知态的轨道是虚线，与「真的 0%」分开；三种状态都不是会转的加载指示。
  expect(await meter.evaluate((node) => {
    const track = node.querySelector<SVGSVGElement>(".agent-chat-context-meter-track");
    return getComputedStyle(track!).strokeDasharray;
  })).not.toBe("none");
  const animation = await meter.evaluate((node) => ["svg", "circle"]
    .flatMap((tag) => Array.from(node.querySelectorAll<SVGSVGElement>(tag))
      .map((el) => getComputedStyle(el).animationName)));
  expect(new Set(animation), "圆环不得带永久动画").toEqual(new Set(["none"]));
});
