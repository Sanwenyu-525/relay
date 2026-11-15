import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 0165：普通用户在设置页只配置「自动上下文压缩」和「压缩阈值」。
 *
 * 旧的三档「上下文档位」卡片已经删除；模型上下文窗口由服务端自动识别，在设置页
 * 只读显示，不存在编辑入口。这里用真实 Chromium 核对：
 *   · 默认阈值来自服务端（350,000），不是界面硬编码；
 *   · 自定义 400,000 能保存，回执与修订一起更新；
 *   · 「恢复默认」保存为 null，不把 350,000 写进用户设置；
 *   · 非法输入在本地被挡住，不发出请求。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
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
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

type MemoryState = {
  revision: number;
  threshold: number | null;
  automaticCompaction: boolean;
};

function memorySettings(state: MemoryState): unknown {
  return { workspace_id: workspaceId, revision: String(state.revision),
    recall_enabled: true, automatic_compaction: state.automaticCompaction, auto_capture: true,
    compaction_threshold_tokens: state.threshold,
    compaction_threshold_default_tokens: 350_000,
    compaction_threshold_recommended: { min: 256_000, max: 400_000 } };
}

type Write = { path: string; body: Record<string, unknown> };

async function installRoutes(page: Page, writes: Write[], state: MemoryState): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "openai-compatible",
      configured: true, model: "gpt-4.1-mini", base_url: null, max_call_tokens: 1_000_000 });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/memory-settings` && method === "GET") {
      return fulfillJson(route, memorySettings(state));
    }
    if (path === `${prefix}/memory-settings` && method === "POST") {
      const body = JSON.parse(String(request.postData())) as Record<string, unknown>;
      writes.push({ path, body });
      state.threshold = typeof body.compaction_threshold_tokens === "number"
        ? body.compaction_threshold_tokens : null;
      state.automaticCompaction = body.automatic_compaction === true;
      state.revision += 1;
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-11-15T00:00:00Z",
        result: memorySettings(state) });
    }
    if (path === `${prefix}/default-working-directory`) return fulfillJson(route,
      { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
        default_write_tier: null, context_budget_tokens: null, status: "UNSET", reason: null,
        revision: "0" });
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("context-budget-fake-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

async function openModelSettings(page: Page): Promise<void> {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await connect(page);
  await page.getByTestId("settings-group-model").click();
  await expect(page.getByTestId("memory-settings")).toBeVisible({ timeout: 20_000 });
}

test("压缩阈值默认 350K、可自定义 400K、可恢复默认；没有模型窗口编辑入口", async ({ page }) => {
  const writes: Write[] = [];
  const state: MemoryState = { revision: 4, threshold: null, automaticCompaction: true };
  await installRoutes(page, writes, state);
  await openModelSettings(page);

  const card = page.getByTestId("memory-settings");
  const threshold = card.getByTestId("memory-settings-threshold");
  await expect(threshold).toHaveValue("");
  await expect(threshold).toHaveAttribute("placeholder", "350,000（默认）");
  await expect(card).toContainText("自动上下文压缩");
  await expect(card).toContainText("默认 350,000");
  await expect(card).toContainText("推荐 256,000–400,000");
  // 旧入口必须彻底消失：设置页没有三档卡片，也没有窗口编辑字段。
  await expect(page.getByTestId("context-budget")).toHaveCount(0);
  await expect(card.getByTestId("context-window")).toHaveCount(0);
  await expect(card.getByTestId("context-window-input")).toHaveCount(0);

  await threshold.fill("400000");
  await card.getByTestId("memory-settings-save").click();
  await expect(card.getByTestId("memory-settings-notice"))
    .toContainText("400,000", { timeout: 20_000 });
  await expect(card.getByTestId("memory-settings-revision")).toContainText("v5");
  expect(writes[0]?.body).toMatchObject({ expected_revision: "4",
    recall_enabled: true, automatic_compaction: true, auto_capture: true,
    compaction_threshold_tokens: 400_000 });

  await card.getByTestId("memory-settings-threshold-default").click();
  await expect(threshold).toHaveValue("");
  await card.getByTestId("memory-settings-save").click();
  await expect(card.getByTestId("memory-settings-notice"))
    .toContainText("默认 350,000", { timeout: 20_000 });
  await expect(card.getByTestId("memory-settings-revision")).toContainText("v6");
  expect(writes[1]?.body).toMatchObject({ expected_revision: "5",
    compaction_threshold_tokens: null });

  await page.screenshot({ path: shot("settings-compaction-threshold.png"), fullPage: true });
});

test("非法阈值文本在本地报错并禁用保存，不发出请求", async ({ page }) => {
  const writes: Write[] = [];
  const state: MemoryState = { revision: 2, threshold: 350_000, automaticCompaction: true };
  await installRoutes(page, writes, state);
  await openModelSettings(page);

  const card = page.getByTestId("memory-settings");
  const threshold = card.getByTestId("memory-settings-threshold");
  await threshold.fill("abc");
  await expect(card.getByTestId("memory-settings-threshold-field"))
    .toContainText("请填正整数 tokens");
  await expect(card.getByTestId("memory-settings-save")).toBeDisabled();
  expect(writes).toHaveLength(0);
});
