import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * 0135 / P1-A：设置页的上下文长度三档在真实 Chromium 里可读可存。
 *
 * API 全部由 page.route 伪造；这里核对的是界面事实与发出的命令：
 * 初始档位来自投影、保存带读回的修订与所选档位、成功后按回执与重读更新。
 */

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

function projection(tokens: number | null, revision: string): unknown {
  return { resource_id: null, canonical_root: null, display_name: null, write_tier: null,
    default_write_tier: null, context_budget_tokens: tokens, status: "UNSET", reason: null, revision };
}

type Write = { path: string; body: Record<string, unknown> };

async function installRoutes(page: Page, writes: Write[],
  state: { tokens: number | null; revision: string }): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/model-port`) return fulfillJson(route, { provider: "fake",
      configured: false, model: null, base_url: null, max_call_tokens: 65_536 });
    if (path === `${prefix}/model-port/verification`) return fulfillJson(route,
      { current_config_fingerprint: null, last: null, matches_current_config: false,
        worker_startup_validation: "NOT_CONFIGURED" });
    if (path === `${prefix}/memory-settings`) return fulfillJson(route, { workspace_id: workspaceId,
      revision: "0", recall_enabled: true, automatic_compaction: true, auto_capture: true });
    if (path === `${prefix}/context-budget` && method === "POST") {
      const body = JSON.parse(String(request.postData())) as Record<string, unknown>;
      writes.push({ path, body });
      state.tokens = typeof body.context_budget_tokens === "number" ? body.context_budget_tokens : null;
      state.revision = String(Number(state.revision) + 1);
      return fulfillJson(route, { command_id: body.command_id, committed_at: "2026-10-24T00:00:00Z",
        result: { workspace_id: workspaceId, context_budget_tokens: state.tokens,
          revision: state.revision } });
    }
    if (path === `${prefix}/default-working-directory` && method === "GET") {
      return fulfillJson(route, projection(state.tokens, state.revision));
    }
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

test("上下文档位从投影读出，保存提交同一修订与所选档位", async ({ page }) => {
  const writes: Write[] = [];
  const state = { tokens: 262_144 as number | null, revision: "4" };
  await installRoutes(page, writes, state);
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await connect(page);
  await page.getByTestId("settings-group-model").click();

  const card = page.getByTestId("context-budget");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("context-budget-option-262144")).toBeChecked();
  await expect(card.getByTestId("context-budget-revision")).toContainText("v4");

  await card.getByTestId("context-budget-option-524288").check();
  await card.getByTestId("context-budget-save").click();
  await expect(card.getByTestId("context-budget-notice")).toContainText("524,288", { timeout: 20_000 });
  await expect(card.getByTestId("context-budget-revision")).toContainText("v5");
  await expect(card.getByTestId("context-budget-option-524288")).toBeChecked();
  expect(writes.map((write) => write.body)).toEqual([
    { command_id: writes[0]!.body.command_id, expected_revision: "4", context_budget_tokens: 524_288 }]);
});
