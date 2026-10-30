import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 首条消息过渡的**真实 Chromium** 布局验收（2026-10-30）。
 *
 * jsdom 只能证明「DOM 里有这条消息」，证明不了「用户看得见、且输入框没跳」。
 * 这条用例在真实排版引擎里逐相位量盒子：
 *   创建中 → 会话已建·发送中 → 202 已回·投影未到 → 投影读回（真实消息行）。
 * 锁三件事：
 *   1. 每个相位都有可读内容，消息区不出现整块空白（过渡行有高度、正文在里面）；
 *   2. 输入框的左右边缘、宽度与底边全程不动（P1-A 的「不先居中、再靠左、再回中间」）；
 *   3. 过渡行与消息列、输入框共用同一条阅读列；短会话里它贴着输入框而不是浮在页面左上角。
 * API 全部由 page.route 伪造，不连数据库、不调 Provider、不产生真实写入。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;
const sessionId = "66666666-6666-4666-8666-666666666662";
const shotDir = "output/first-message-transition-20261030";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "关于Relay-Agent", status: "ACTIVE", revision: "1", working_resource_id: null,
    conversation_mode: "AGENT", chat_mode: "CHAT", pinned_at: null, unread_at: null,
    context: { project_goals: [], working_directory: null },
    created_at: "2026-10-30T01:00:00Z", updated_at: "2026-10-30T01:00:00Z" };
}

function messageRow(id: string, seq: string, role: "USER" | "ASSISTANT", content: string | null,
  status = "COMPLETED"): unknown {
  return { id, session_id: sessionId, seq, role, status, intent: "DISCUSS", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    attachments: [], withdrawn_at: null, withdrawn_by_recall_id: null, recall: null, steer_requested: false,
    created_at: "2026-10-30T01:00:00Z", updated_at: "2026-10-30T01:00:02Z",
    usage: { input_tokens: 120, output_tokens: 64, cache_read_tokens: null, cache_creation_tokens: null } };
}

interface Ctx { created: boolean; messages: unknown[] }

async function installRoutes(page: Page, ctx: Ctx): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (path === `${prefix}/assist-sessions`) {
        // 建会话请求刻意慢一点：这段等待正是用户此前看到「空白中间态」的窗口。
        await new Promise((resolve) => setTimeout(resolve, 300));
        ctx.created = true;
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-30T01:00:00Z",
          result: { session_id: sessionId, ...sessionRow() as object } }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-30T01:00:02Z",
          result: { session_id: sessionId, user_message_id: "u-1", assistant_message_id: "a-1" } }, 202);
      }
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-30T01:00:00Z", result: {} }, 202);
    }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: ctx.created ? [sessionRow()] : [] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: ctx.messages });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return fulfillJson(route, { model: null, revision: "0" });
    // 目标与计划投影按服务端真实形状返回空值：缺这两个端点时面板会报「读取失败」，
    // 截图里会多出一条与本任务无关的告警。
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/conversation-diff`) {
      return fulfillJson(route, { available: false, reason: "NO_BASELINE" });
    }
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake", configured: false,
      model: null, base_url: null, max_call_tokens: null });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("first-message-transition-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

interface Box { top: number; bottom: number; left: number; right: number; width: number; height: number }
interface Measure {
  composer: Box | null; list: { left: number; right: number } | null;
  row: Box | null; userRow: Box | null; transcriptBottom: number | null;
  scrollWidth: number; clientWidth: number;
}

/** 逐相位量真实盒子：输入卡、消息列、过渡行、真实用户消息行与视口宽度。 */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const rect = (element: Element | null): Box | null => {
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        width: box.width, height: box.height };
    };
    const composer = document.querySelector('[data-testid="assist-first-message"] .agent-chat-composer')
      ?? document.querySelector('[data-testid="assist-composer"]');
    const list = document.querySelector(".agent-message-list");
    const listBox = list?.getBoundingClientRect() ?? null;
    return { composer: rect(composer), row: rect(document.querySelector('[data-testid="assist-first-transition"]')),
      userRow: rect(document.querySelector('.agent-message[data-role="USER"]')),
      list: listBox === null ? null : { left: listBox.left, right: listBox.right },
      transcriptBottom: document.querySelector('[data-testid="assist-transcript"]')
        ?.getBoundingClientRect().bottom ?? null,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth };
  });
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

const viewports = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "narrow-1024x720", width: 1024, height: 720 }
] as const;

for (const viewport of viewports) {
  test(`首条消息过渡在 ${viewport.name} 下不空白、输入卡不跳`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const ctx: Ctx = { created: false, messages: [] };
    await installRoutes(page, ctx);
    await page.goto("/agent?new=transition-layout");
    await connect(page);
    await expect(page.getByTestId("assist-first-draft")).toBeVisible();
    const shoot = async (phase: string): Promise<void> => {
      await page.screenshot({ path: `${shotDir}/${viewport.name}-${phase}.png` });
    };

    const beforeSend = await measure(page);
    await shoot("1-before-send");

    await page.getByTestId("assist-first-draft").fill("在根目录下创建一个aa.md");
    await page.getByTestId("assist-first-send").click();
    // ① 建会话在途：首条输入器还在，原文可读。
    await expect(page.getByTestId("assist-first-draft")).toHaveValue("在根目录下创建一个aa.md");
    const creating = await measure(page);
    await shoot("2-creating");

    // ② 会话已建、消息命令在途：过渡行带正文出现在消息时间线里。
    const transition = page.getByTestId("assist-first-transition");
    await expect(transition).toBeVisible({ timeout: 20_000 });
    await expect(transition).toHaveAttribute("data-phase", "sending");
    await expect(transition).toContainText("在根目录下创建一个aa.md");
    await expect(transition).toContainText("发送中");
    const sending = await measure(page);
    await shoot("3-sending");

    // ③ 202 回执已到、投影未到：过渡行留下，状态改成「已送达」。
    await expect(transition).toHaveAttribute("data-phase", "awaiting", { timeout: 20_000 });
    await expect(transition).toContainText("已送达");
    await expect(transition).toContainText("在根目录下创建一个aa.md");
    const awaiting = await measure(page);
    await shoot("4-after-202");

    // ④ 真实消息读回：过渡行卸载，同一位置换成真实消息行。
    ctx.messages = [messageRow("u-1", "1", "USER", "在根目录下创建一个aa.md"),
      messageRow("a-1", "2", "ASSISTANT", "已经创建 aa.md。")];
    // 面板的刷新键在协作页里是隐藏的（顶栏会话标题已收起），用脚本触发同一个入口。
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="assist-refresh"]')?.click();
    });
    await expect(page.getByText("已经创建 aa.md。")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("assist-first-transition")).toHaveCount(0);
    const projected = await measure(page);
    await shoot("5-projected");

    const phases = { beforeSend, creating, sending, awaiting, projected };
    // 量到的数字留档：三个视口的稳定性靠它们核对，不靠印象。
    console.log("FIRST_MESSAGE_LAYOUT", JSON.stringify({ viewport: viewport.name,
      composer: phases.projected.composer, sendingRow: sending.row, awaitingRow: awaiting.row,
      userRow: projected.userRow, transcriptBottom: sending.transcriptBottom,
      list: sending.list }));
    for (const [name, sample] of Object.entries(phases)) {
      expect(sample.composer, `${viewport.name} ${name}: 没有输入卡`).not.toBeNull();
      expect(sample.composer!.width, `${viewport.name} ${name}: 输入卡宽度为 0`).toBeGreaterThan(0);
      expect(sample.scrollWidth, `${viewport.name} ${name}: 出现横向溢出`)
        .toBeLessThanOrEqual(sample.clientWidth + 1);
    }
    // P1-A：输入卡的左右边缘、宽度与底边全程不动——不出现先居中、再靠左、再回中间。
    for (const key of ["left", "right", "width", "bottom"] as const) {
      const range = spread(Object.values(phases).map((sample) => sample.composer![key]));
      expect(range, `${viewport.name}: 输入卡 ${key} 在过渡中移动了 ${range.toFixed(1)}px`)
        .toBeLessThanOrEqual(1);
    }
    // 过渡行有真实高度，并且与消息列、输入卡共用同一条阅读列。
    expect(sending.row, `${viewport.name}: 发送中没有过渡行`).not.toBeNull();
    expect(sending.row!.height).toBeGreaterThan(20);
    expect(awaiting.row!.height).toBeGreaterThan(20);
    // 过渡行占的正是真实消息行那一格：真实消息读回后，列的左缘、右缘与宽度逐像素不变。
    // （输入卡不在滚动容器里，两者相差半个自绘滚动条——这是既有阅读列口径，见
    //  chatReadingColumn.spec.ts「两边因此差半个滚动条」，所以只对消息列自身做严格比对。）
    expect(projected.userRow, `${viewport.name}: 投影后没有真实用户消息行`).not.toBeNull();
    for (const key of ["left", "right", "width"] as const) {
      expect(Math.abs(sending.row![key] - projected.userRow![key]),
        `${viewport.name}: 过渡行与真实消息行 ${key} 不一致`).toBeLessThanOrEqual(1);
    }
    const rowCenter = (sending.row!.left + sending.row!.right) / 2;
    const composerCenter = (sending.composer!.left + sending.composer!.right) / 2;
    expect(Math.abs(rowCenter - composerCenter),
      `${viewport.name}: 过渡行与输入卡不在同一条中轴（超过半个滚动条）`).toBeLessThanOrEqual(8);
    // 短会话：最新内容贴着输入卡（靠近转录区底边），不漂浮在页面左上角。
    expect(sending.transcriptBottom! - sending.row!.bottom,
      `${viewport.name}: 过渡行没有贴近输入区`).toBeLessThanOrEqual(40);
  });
}
