import { expect, test, type Page, type Route } from "@playwright/test";

// DEV-0110（2026-10-22 退回项，2026-10-24 修复回归）：缓存命中率文本首次出现时，
// 输入工具栏不得换行、输入卡高度不得变化。修法是让右端一组的命中率文本可收缩
// （ellipsis 先截断），圆环与模型名不缩。本用例在 1280 与 1600 两档宽度下，对
// 「无缓存读数」与「有缓存读数」两个夹具分别量输入卡与底栏的高度，断言相等；
// 同时断言第二档里命中率文本真的在场（条件真的变了，不是两个相同夹具）。
// API 全部由 page.route 伪造，不连数据库、不调 Provider、不产生任何写请求。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "66666666-6666-4666-8666-666666666666";
const prefix = `/api/v1/workspaces/${workspaceId}`;
// 与 playwright.config.ts 的 RELAY_E2E_PORT 同源：4173 被别的预览服务占用时，
// CORS 头必须跟着实际端口走，否则浏览器会把伪造响应拦在跨域检查上。
const port = process.env.RELAY_E2E_PORT ?? "4173";
const origin = `http://127.0.0.1:${port}`;

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function sessionRow(): unknown {
  return { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
    title: "缓存命中率与输入卡稳定", status: "ACTIVE", revision: "1", conversation_mode: "AGENT",
    assistant_profile_id: null, created_at: "2026-10-24T20:00:00Z", updated_at: "2026-10-24T20:10:00Z" };
}

function row(id: string, seq: number, role: "USER" | "ASSISTANT", content: string,
  cacheReadTokens: number | null): unknown {
  return { id, session_id: sessionId, seq: String(seq), role, status: "COMPLETED", intent: "DISCUSS",
    created_at: "2026-10-24T20:05:00Z", updated_at: "2026-10-24T20:06:00Z", content,
    error_code: null, provider_error_kind: null, sources: [], skill: null, cancel_requested: false,
    usage: { input_tokens: 4710, output_tokens: 47, cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: null } };
}

/**
 * 会话用量投影：两次测量只有 cache_read_tokens 一项不同。
 * 命中率现在从 `context-usage.last_call` 读取（不是从消息行自行推导），
 * 所以夹具必须给出这条真实读数，否则两次都会退化成「尚无模型调用」。
 */
function contextUsage(withCache: boolean): unknown {
  return {
    session_id: sessionId,
    budget: { tokens: 262_144, revision: "0" },
    next_call: null,
    last_call: {
      source: "MODEL_CALL", call_id: "call-usage", message_id: "x-2",
      provider: "fake", model: "fake-model", status: "COMPLETED",
      input_tokens: 4710, output_tokens: 47,
      cache_read_tokens: withCache ? 4200 : null,
      cache_creation_tokens: null,
      reserved_tokens: 100_000, settled_at: "2026-10-24T20:06:00Z", breakdown: null
    }
  };
}

async function installRoutes(page: Page, withCache: boolean, modelName: string | null = null): Promise<void> {
  const messages = [
    row("u-1", 1, "USER", "帮我把这个目录的说明读一遍。", null),
    row("x-1", 2, "ASSISTANT", "已经读完目录说明，结构与分工如下：文档、测试与运行脚本各自成块。", null),
    row("u-2", 3, "USER", "那缓存命中之后界面会变吗？", null),
    // 最后一条带读数：命中率是否出现由 cache_read_tokens 决定（Provider 上报口径）。
    row("x-2", 4, "ASSISTANT", "命中时左下角会多一段「缓存命中」文本；本轮已按命中口径上报。",
      withCache ? 4200 : null)
  ];
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    const path = new URL(request.url()).pathname;
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    // 长模型名用来核对：缓存读数出现时，先由模型 chip 的省略号让位，不把发送键挤出卡外。
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: modelName !== null, model: modelName, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route, {
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: messages });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return fulfillJson(route, { model: null, revision: "0" });
    if (path === `${prefix}/assist-sessions/${sessionId}/context-usage`) {
      return fulfillJson(route, contextUsage(withCache));
    }
    if (path === `${prefix}/assist-proposals`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/skill-definitions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/chat-commands`) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/conversation-execution-requests`)) return fulfillJson(route, { items: [] });
    if (path.startsWith(`${prefix}/learning`)) return fulfillJson(route, { items: [], epoch: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("cache-hit-stability-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function measure(page: Page, width: number, height: number, withCache: boolean,
  modelName: string | null = null): Promise<{
  composer: number; actions: number; hitVisible: boolean }> {
  await page.setViewportSize({ width, height });
  await installRoutes(page, withCache, modelName);
  await page.goto(`/agent?session=${sessionId}`);
  await connect(page);
  await expect(page.getByTestId("assist-draft")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const hitVisible = await page.getByTestId("assist-cache-hit").isVisible();
  const box = await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>(".agent-chat-composer")!;
    const actions = document.querySelector<HTMLElement>(".agent-chat-composer-actions")!;
    return { composer: composer.getBoundingClientRect().height,
      actions: actions.getBoundingClientRect().height };
  });
  return { composer: box.composer, actions: box.actions, hitVisible };
}

// 1162×782 是 DEV-0110 报障时的真实桌面窗口尺寸（禅道那轮的现场），必须与 1280/1600 同判据跑。
// 860×782 是侧栏展开后中栏的实际宽度：这里工具行已经放满，缓存读数按容器宽度收起
// （信息仍可从上下文圆环详情里读到），因此断言的是「不出现也不增高」。
for (const [width, height] of [[860, 782], [1162, 782], [1280, 800], [1600, 800]] as const) {
  // 工具行容器 600px 以下收起缓存读数（见 AssistView.css 的 @container composer-actions）。
  const cacheVisible = width >= 1000;
  test(`命中率出现不改变输入卡与底栏高度（${width}×${height}，DEV-0110）`, async ({ page }) => {
    const without = await measure(page, width, height, false);
    expect(without.hitVisible).toBe(false);
    const withHit = await measure(page, width, height, true);
    expect(withHit.hitVisible).toBe(cacheVisible);
    // 高度逐帧一致：缓存读数出现（或按窄栏规则收起）前后，输入卡与底栏都不换行、不增高。
    expect(Math.abs(withHit.composer - without.composer)).toBeLessThan(0.5);
    expect(Math.abs(withHit.actions - without.actions)).toBeLessThan(0.5);
  });
}

// 长模型名与缓存读数同时在场：让位的是模型 chip 的省略号，不是发送键或缓存指示器。
const LONG_MODEL = "anthropic/claude-sonnet-4-5-20250929-extended-context-preview";
for (const [width, height] of [[860, 782], [1162, 782], [1280, 800]] as const) {
  const cacheVisible = width >= 1000;
  test(`长模型名不挤走发送键，缓存指标保持单行（${width}×${height}）`, async ({ page }) => {
    const measured = await measure(page, width, height, true, LONG_MODEL);
    expect(measured.hitVisible).toBe(cacheVisible);
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top,
          height: box.height, width: box.width };
      };
      return {
        composer: rect(".agent-chat-composer"),
        send: rect("[data-testid='assist-send']"),
        hit: document.querySelector("[data-testid='assist-cache-hit']") === null
          ? null : rect("[data-testid='assist-cache-hit']"),
        meter: rect("[data-testid='assist-context-meter']")
      };
    });
    // 发送键仍在输入卡内右缘之内（不被长模型名顶出卡外）。
    expect(boxes.send.right).toBeLessThanOrEqual(boxes.composer.right + 0.5);
    expect(boxes.send.left).toBeGreaterThanOrEqual(boxes.composer.left - 0.5);
    if (cacheVisible && boxes.hit !== null) {
      // 缓存指标与上下文圆环同一中线、单行：缓存不是一段会被折行的文字。
      expect(Math.abs((boxes.hit.top + boxes.hit.height / 2) - (boxes.meter.top + boxes.meter.height / 2))
        ).toBeLessThan(1.5);
      expect(boxes.hit.height).toBeLessThan(20);
      // 紧凑宽度：图标 12px + 4px 间距 + 数值，远小于旧的「缓存命中 57%」整段文字。
      expect(boxes.hit.width).toBeLessThan(60);
    }
  });
}
