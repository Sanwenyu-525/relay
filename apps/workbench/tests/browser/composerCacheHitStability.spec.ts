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
const origin = "http://127.0.0.1:4173";

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

async function installRoutes(page: Page, withCache: boolean): Promise<void> {
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
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: null });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route, {
      current_config_fingerprint: null, last: null, matches_current_config: false,
      worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [sessionRow()] });
    if (path === `${prefix}/assist-sessions/${sessionId}`) return fulfillJson(route, sessionRow());
    if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return fulfillJson(route, { items: messages });
    if (path === `${prefix}/assist-sessions/${sessionId}/goal`) return fulfillJson(route, { goal: null, rounds: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/plans`) return fulfillJson(route, { latest: null, versions: [] });
    if (path === `${prefix}/assist-sessions/${sessionId}/model-selection`) return fulfillJson(route, { model: null, revision: "0" });
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

async function measure(page: Page, width: number, height: number, withCache: boolean): Promise<{
  composer: number; actions: number; hitVisible: boolean }> {
  await page.setViewportSize({ width, height });
  await installRoutes(page, withCache);
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
for (const [width, height] of [[1162, 782], [1280, 800], [1600, 800]] as const) {
  test(`命中率出现不改变输入卡与底栏高度（${width}×${height}，DEV-0110）`, async ({ page }) => {
    const without = await measure(page, width, height, false);
    expect(without.hitVisible).toBe(false);
    const withHit = await measure(page, width, height, true);
    expect(withHit.hitVisible).toBe(true);
    // 高度逐帧一致：命中率文本出现前后，输入卡与底栏都不换行、不增高。
    expect(Math.abs(withHit.composer - without.composer)).toBeLessThan(0.5);
    expect(Math.abs(withHit.actions - without.actions)).toBeLessThan(0.5);
  });
}
