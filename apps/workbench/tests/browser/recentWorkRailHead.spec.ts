import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-15 折叠点下移带出的一处排版缺陷：近期工作栏的「已加载 N 项」在 48rem–64rem
// 档首次被渲染（此前该宽度整栏隐藏），`.recent-work-count` 的 flex:1 + 无 nowrap
// 让它被压成逐字竖排。本文件守住栏头不被压坏：计数整块不内部折行。
// API 全部由 page.route 伪造，不连数据库、不写任何真实业务事实。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";

/** 48rem–64rem 档：该宽度保留三列，近期工作栏按 clamp 下限取 176px。 */
const bandViewport = { width: 843, height: 800 };

const railTasks = [
  { id: "task-a", project_id: projectId, title: "人机协作工作流研究", status: "READY", mode: "ME",
    revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    updated_at: "2026-10-15T00:00:00Z" },
  { id: "task-b", project_id: projectId, title: "资料整理", status: "READY", mode: "ME",
    revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null,
    waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
    updated_at: "2026-10-14T00:00:00Z" }
];

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function installRoutes(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: railTasks, next_cursor: null });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/assist-sessions`) return fulfillJson(route, { items: [] });
    if (path === `${prefix}/model-port`) {
      return fulfillJson(route, { provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    }
    return fulfillJson(route, { items: [], next_cursor: null });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("rail-head-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test("48rem–64rem 档：近期工作栏头部的已加载计数不被压成竖排", async ({ page }) => {
  await page.setViewportSize(bandViewport);
  await installRoutes(page);
  await page.goto("/agent?new=seed");
  await connect(page);

  // 前提事实：该档外壳保留三列，栏在屏上且已加载计数真的渲染出来。
  await expect(page.locator(".app-context-rail")).toBeVisible({ timeout: 20_000 });
  const count = page.getByTestId("recent-work-scope");
  await expect(count).toHaveText("已加载 2 项");

  const look = await count.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      whiteSpace: style.whiteSpace,
      lineHeight: Number.parseFloat(style.lineHeight),
      height: node.getBoundingClientRect().height,
      width: node.getBoundingClientRect().width,
      rows: node.getClientRects().length
    };
  });
  // 计数是一个整体：内部不折行，也就不存在「已加 / 载 2 / 项」这种逐字竖排。
  expect(look.whiteSpace).toBe("nowrap");
  expect(look.rows).toBe(1);
  expect(look.height).toBeLessThanOrEqual(look.lineHeight * 1.5);

  // 栏头整行不超过两行（标题一行 + 必要时整块换行的计数一行），
  // 避免高度被计数撑成三四行、把列表挤到首屏之外。
  const heading = await page.locator(".recent-work-heading").evaluate((node) => {
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const compact = Number.parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue("--relay-control-height-compact")) * rootPx;
    return { height: node.getBoundingClientRect().height, compact };
  });
  expect(heading.height).toBeLessThanOrEqual(heading.compact * 2 + 4);
});
