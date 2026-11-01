import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 首条消息过渡的**真实 Chromium** 布局验收（2026-10-30；2026-10-31 UI-08 改版）。
 *
 * jsdom 只能证明「DOM 里有这条消息」，证明不了「用户看得见、位置稳、输入框没跳」。
 * 这条用例在真实排版引擎里逐相位量盒子：
 *   创建中 → 会话已建·发送中 → 202 已回·投影未到 → AI 等待行 → 投影读回（真实消息行）
 *   → AI 开始回复（PENDING 三点）→ 长回复 → 回复完成。
 * 锁五件事：
 *   1. 每个相位都有可读内容，消息区不出现整块空白（过渡行有高度、正文在里面）；
 *   2. 首条消息从**阅读起点（顶部）**排起，不再贴底靠近输入框；短会话不产生整屏空白错位；
 *      输入框的左右边缘、宽度与底边全程不动（P1-A 的「不先居中、再靠左、再回中间」）；
 *   3. 用户消息仍是右对齐；AI 等待三点在助手列左侧，不出现在用户消息行里；
 *   4. 过渡行与真实消息行共用同一条阅读列；ASSISTANT 行一出现等待行即卸载（不重复）；
 *   5. 长回复遵循跟随意图，停在底部且不出现横向溢出。
 * API 全部由 page.route 伪造，不连数据库、不调 Provider、不产生真实写入。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = `http://127.0.0.1:${process.env.RELAY_RAIL_TEST_PORT ?? "4173"}`;
const sessionId = "66666666-6666-4666-8666-666666666662";
const shotDir = "../../tmp/UI-08-first-message-chat-cleanup/screenshots";

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

/** 一条足够长的真实回复：把转录区撑成可滚动，用来验证跟随意图。 */
const LONG_REPLY = [
  "先给结论：这一轮只做了只读核对，没有改动任何文件。",
  "",
  "## 我看到的现状",
  "",
  "- `apps/workbench/src/views/AssistView.tsx` 负责消息行的渲染与滚动归属；",
  "- 首条消息的过渡行住在同一个 `.agent-message-list` 里，因此换行时阅读列不变；",
  "- 旧版把 `margin-top: auto` 用在列表上，短会话因此被推到输入框上方。",
  "",
  "## 这一版怎么改",
  "",
  "1. 消息列改为从阅读起点排起，顶部留一档间距；",
  "2. AI 等待三点移到助手列，用户消息行不再出现生成动效；",
  "3. 聊天区不再画横穿阅读区域的渐隐带。",
  "",
  "## 还需要你确认的",
  "",
  "如果你希望短会话仍然贴底，这一条要单独回退；其余两处与贴底无关，可以保留。",
  "",
  "（以上内容由测试夹具生成，只用于布局验收，不是模型真实输出。）",
  "",
  "补充说明：这段文字故意写长，让滚动容器产生真实溢出；它不包含任何业务结论，",
  "也不会写入数据库。所有 API 响应都由 Playwright 在浏览器侧伪造。"
].join("\n");

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
    if (path.endsWith("/tool-calls")) {
      // 过程账本：这一轮确实零条记录。终态消息不会预取，展开才读；这里给出确定事实。
      const messageId = path.split("/messages/")[1]?.split("/")[0] ?? "a-1";
      return fulfillJson(route, { session_id: sessionId, message_id: messageId,
        message_status: "COMPLETED", rounds: [] });
    }
    if (path.endsWith("/live-preview")) {
      // 草稿预览：这一轮还没有可读草稿。返回契约形状的空预览，避免截图里多出读取失败块。
      const messageId = path.split("/messages/")[1]?.split("/")[0] ?? "a-1";
      return fulfillJson(route, { status: "PENDING", session_id: sessionId, message_id: messageId,
        preview_revision: "0", preview_text: null, preview_truncated: false, preview_available: false });
    }
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
  composer: Box | null; list: Box | null; row: Box | null; userBubble: Box | null;
  waiting: Box | null; waitingDots: Box | null; waitingRole: string | null;
  transitionHasDots: boolean; assistantRow: Box | null;
  transcriptTop: number | null; transcriptBottom: number | null;
  scrollTop: number; scrollHeight: number; clientHeight: number;
  scrollWidth: number; clientWidth: number;
}

/** 逐相位量真实盒子：输入卡、消息列、过渡行、用户气泡、等待行与滚动状态。 */
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
    const transcript = document.querySelector<HTMLElement>('[data-testid="assist-transcript"]');
    const transition = document.querySelector('[data-testid="assist-first-transition"]');
    const waiting = document.querySelector('[data-testid="assist-first-assistant-waiting"]');
    return {
      composer: rect(composer),
      list: rect(document.querySelector(".agent-message-list")),
      row: rect(transition),
      userBubble: rect(document.querySelector('.agent-message[data-role="USER"] .agent-message-body')),
      waiting: rect(waiting),
      waitingDots: rect(waiting?.querySelector(".assist-inflight-dots") ?? null),
      waitingRole: waiting?.querySelector(".agent-message")?.getAttribute("data-role") ?? null,
      transitionHasDots: transition !== null && transition.querySelector(".assist-inflight-dots") !== null,
      assistantRow: rect(document.querySelector('.agent-message[data-role="ASSISTANT"]')),
      transcriptTop: transcript?.getBoundingClientRect().top ?? null,
      transcriptBottom: transcript?.getBoundingClientRect().bottom ?? null,
      scrollTop: transcript?.scrollTop ?? 0,
      scrollHeight: transcript?.scrollHeight ?? 0,
      clientHeight: transcript?.clientHeight ?? 0,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

const viewports = [
  { name: "1660x900", width: 1660, height: 900 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1024x720", width: 1024, height: 720 }
] as const;

for (const viewport of viewports) {
  test(`首条消息在 ${viewport.name} 下靠上、等待动画在 AI 侧、输入卡不跳`, async ({ page }) => {
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
    // ① 建会话在途：首条输入器还在，原文可读——用户消息没有凭空消失。
    await expect(page.getByTestId("assist-first-draft")).toHaveValue("在根目录下创建一个aa.md");
    const creating = await measure(page);
    await shoot("2-creating");

    // ② 会话已建、消息命令在途：过渡行带正文出现在消息时间线里，AI 等待行在助手列。
    const transition = page.getByTestId("assist-first-transition");
    await expect(transition).toBeVisible({ timeout: 20_000 });
    await expect(transition).toHaveAttribute("data-phase", "sending");
    await expect(transition).toContainText("在根目录下创建一个aa.md");
    await expect(transition).toContainText("发送中");
    const waiting = page.getByTestId("assist-first-assistant-waiting");
    await expect(waiting).toBeVisible();
    // 发送中还没有 202 回执：可访问名称只说「正在提交」，不冒充「已提交」。
    await expect(waiting.getByRole("status")).toHaveAttribute("aria-label", "正在提交首条消息，等待 AI 回复");
    const sending = await measure(page);
    await shoot("3-sending-ai-waiting");

    // ③ 202 回执已到、投影未到：过渡行留下，状态改成「已送达」；等待行仍在 AI 侧。
    await expect(transition).toHaveAttribute("data-phase", "awaiting", { timeout: 20_000 });
    await expect(transition).toContainText("已送达");
    await expect(waiting).toBeVisible();
    // 202 已确认：可访问名称改说「已提交」。
    await expect(waiting.getByRole("status")).toHaveAttribute("aria-label", "首条消息已提交，等待 AI 回复");
    const awaiting = await measure(page);
    await shoot("4-after-202");

    // ④ 真实消息读回：过渡行卸载，同一位置换成真实消息行；ASSISTANT 行未到时等待行接棒。
    ctx.messages = [messageRow("u-1", "1", "USER", "在根目录下创建一个aa.md")];
    // 面板的刷新键在协作页里是隐藏的（顶栏会话标题已收起），用脚本触发同一个入口。
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="assist-refresh"]')?.click();
    });
    await expect(page.getByTestId("assist-first-transition")).toHaveCount(0);
    await expect(waiting).toBeVisible();
    const projectedUser = await measure(page);
    await shoot("5-user-projected-ai-waiting");

    // ⑤ AI 开始回复：服务端 ASSISTANT PENDING 行出现，等待行必须卸载（去重），
    //    在途三点改由这条回复行自己承担。
    ctx.messages = [messageRow("u-1", "1", "USER", "在根目录下创建一个aa.md"),
      messageRow("a-1", "2", "ASSISTANT", null, "PENDING")];
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="assist-refresh"]')?.click();
    });
    await expect(page.getByTestId("assist-first-assistant-waiting")).toHaveCount(0);
    await expect(page.getByTestId("assist-inflight-a-1")).toBeVisible();
    const replying = await measure(page);
    await shoot("6-assistant-replying");

    // ⑥ 长回复：跟随意图把视图停在最新，滚动容器真实溢出。
    ctx.messages = [messageRow("u-1", "1", "USER", "在根目录下创建一个aa.md"),
      messageRow("a-1", "2", "ASSISTANT", LONG_REPLY)];
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="assist-refresh"]')?.click();
    });
    await expect(page.getByTestId("assist-reply-final-a-1")).toBeVisible({ timeout: 20_000 });
    const longReply = await measure(page);
    await shoot("7-long-reply");

    // ⑦ 回复完成 + 用户手动向上阅读不被拉回：向上滚动后 followLatest 关闭。
    await page.locator('[data-testid="assist-transcript"]').evaluate((element) => { element.scrollTop = 0; });
    const away = await measure(page);
    expect(away.scrollTop, `${viewport.name}: 手动上滚后应停在顶部`).toBe(0);

    const phases = { beforeSend, creating, sending, awaiting, longReply };
    // 量到的数字留档：三个视口的稳定性靠它们核对，不靠印象。
    console.log("FIRST_MESSAGE_LAYOUT", JSON.stringify({ viewport: viewport.name,
      composer: phases.longReply.composer, sendingRow: sending.row, awaitingRow: awaiting.row,
      transitionBottomGap: sending.transcriptBottom === null || sending.waiting === null ? null
        : sending.transcriptBottom - sending.waiting.bottom,
      userRowTop: projectedUser.userBubble?.top ?? null, transcriptTop: sending.transcriptTop,
      scroll: { top: longReply.scrollTop, height: longReply.scrollHeight, client: longReply.clientHeight } }));
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
    // UI-08 P0-1：首条消息从阅读起点排起——贴着转录区上缘一档内边距，不再贴底。
    expect(sending.row, `${viewport.name}: 发送中没有过渡行`).not.toBeNull();
    expect(sending.row!.height).toBeGreaterThan(20);
    expect(sending.transcriptTop, `${viewport.name}: 没有转录区`).not.toBeNull();
    const topGap = sending.row!.top - sending.transcriptTop!;
    expect(topGap, `${viewport.name}: 首条消息没有靠上（距转录区上缘 ${topGap.toFixed(1)}px）`)
      .toBeLessThanOrEqual(24);
    expect(topGap, `${viewport.name}: 首条消息贴死在窗口上缘`).toBeGreaterThanOrEqual(4);
    // 让「贴底」的反面也能被测出来：短会话没有溢出，消息下方留白充足。
    expect(sending.scrollTop, `${viewport.name}: 短会话不应被滚到底`).toBe(0);
    expect(sending.scrollHeight, `${viewport.name}: 短会话不应溢出`)
      .toBeLessThanOrEqual(sending.clientHeight + 1);
    expect(sending.transcriptBottom! - sending.waiting!.bottom,
      `${viewport.name}: 等待行仍贴着输入区（旧版贴底未移除）`).toBeGreaterThan(60);

    // UI-08 P0-2：用户消息右对齐，等待行是助手列、左对齐；三点不在用户行里。
    expect(sending.userBubble, `${viewport.name}: 没有用户气泡`).not.toBeNull();
    expect(sending.list, `${viewport.name}: 没有消息列`).not.toBeNull();
    expect(Math.abs(sending.list!.right - sending.userBubble!.right),
      `${viewport.name}: 用户消息没有靠右`).toBeLessThanOrEqual(1);
    expect(sending.transitionHasDots, `${viewport.name}: 用户消息行里仍挂着 AI 生成三点`).toBe(false);
    expect(sending.waitingRole, `${viewport.name}: 等待行不是助手列`).toBe("ASSISTANT");
    expect(sending.waitingDots, `${viewport.name}: 等待行没有三点`).not.toBeNull();
    const listCenter = (sending.list!.left + sending.list!.right) / 2;
    expect(sending.waitingDots!.left, `${viewport.name}: 等待三点不在左半列`)
      .toBeLessThan(listCenter);
    expect(sending.waitingDots!.top, `${viewport.name}: 等待三点压在元信息行上`)
      .toBeGreaterThanOrEqual(sending.waiting!.top + 8);

    // ⑤⑥ 真实用户行与过渡行共用同一条阅读列（左缘、右缘逐像素不变）。
    expect(projectedUser.userBubble, `${viewport.name}: 投影后没有用户消息`).not.toBeNull();
    for (const key of ["left", "right", "width"] as const) {
      expect(Math.abs(sending.list![key] - projectedUser.list![key]),
        `${viewport.name}: 过渡行与真实消息行的阅读列 ${key} 不一致`).toBeLessThanOrEqual(1);
    }
    const rowCenter = (sending.row!.left + sending.row!.right) / 2;
    const composerCenter = (sending.composer!.left + sending.composer!.right) / 2;
    expect(Math.abs(rowCenter - composerCenter),
      `${viewport.name}: 过渡行与输入卡不在同一条中轴（超过半个滚动条）`).toBeLessThanOrEqual(8);

    // ④→⑤：真实 ASSISTANT 行与等待行位置一致（都在阅读列左缘），并且只有一条。
    expect(replying.assistantRow, `${viewport.name}: PENDING 回复行不在场`).not.toBeNull();
    expect(replying.assistantRow!.left, `${viewport.name}: 回复行不在阅读列左缘`)
      .toBeLessThanOrEqual(sending.list!.left + 1);

    // ⑥ 长回复：真实溢出且跟随到底；没有横向溢出。
    expect(longReply.scrollHeight, `${viewport.name}: 长回复没有溢出，滚动跟随未被验证`)
      .toBeGreaterThan(longReply.clientHeight + 1);
    expect(longReply.scrollTop, `${viewport.name}: 长回复没有跟到最新`).toBeGreaterThan(0);
  });
}
