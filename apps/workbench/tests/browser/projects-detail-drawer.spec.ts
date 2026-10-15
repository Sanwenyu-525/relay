import { expect, test, type Page } from "@playwright/test";

// 2026-10-11 项目页重设计后的真实 Chromium 覆盖。
// 项目详情从常驻右栏改为「查看项目」打开的抽屉；这里证明宽屏不再有常驻右栏、
// 抽屉可从卡片打开并关闭，且页头常驻创建入口在推荐/最小客户区都仍然可达。
// API 全部由页面内拦截伪造，不连数据库、不调 Provider。

const origin = "http://127.0.0.1:4173";
const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const prefix = `/api/v1/workspaces/${workspaceId}`;

const project = { id: projectId, title: "MyProject", project_type: "GENERAL", revision: "1",
  state_revision: "1", archived_at: null, archive_status: "ACTIVE", phase_key: "PLANNING",
  next_action_task_id: null, created_at: "2026-10-07T00:00:00Z", updated_at: "2026-10-07T00:00:00Z" };

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function installProjectApi(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") {
      await route.fulfill({ status: 200, contentType: "application/json", headers: cors(), body: JSON.stringify({ status: "ready" }) });
      return;
    }
    // 左栏近期工作读 status=active，项目主区默认读 status=all；两者共用同一份伪造事实。
    const body = path === `${prefix}/projects` ? { items: [project], next_cursor: null }
      : path === `${prefix}/tasks` ? { items: [], next_cursor: null }
        : { code: "NOT_STUBBED", detail: path };
    await route.fulfill({ status: path === `${prefix}/projects` || path === `${prefix}/tasks` ? 200 : 404,
      contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("projects-detail-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId(`project-row-${projectId}`).waitFor({ timeout: 20_000 });
}

test("项目详情改为抽屉：宽屏不再常驻右栏，短窗仍可从卡片打开", async ({ page }) => {
  await installProjectApi(page);
  await page.goto("/projects");
  await connect(page);

  const card = page.getByTestId(`project-row-${projectId}`);
  const drawer = page.getByRole("dialog", { name: "项目详情" });

  // 宽屏不再有常驻右栏，也不再需要单独的「查看摘要」触发按钮。
  await expect(page.locator(".projects-page .desktop-rail")).toHaveCount(0);
  await expect(page.locator(".projects-page .rail-trigger")).toHaveCount(0);

  const cases = [
    { width: 843, height: 782 },
    { width: 1162, height: 782 },
    { width: 2048, height: 1104 },
    { width: 843, height: 600 }
  ];
  for (const viewport of cases) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // 页头常驻入口在任何宽度都必须可达；未打开详情时不应出现抽屉。
    await expect(page.getByTestId("goal-create-open")).toBeVisible();
    await expect(page.getByTestId("project-create-open")).toBeVisible();
    await expect(drawer).toHaveCount(0);

    await card.scrollIntoViewIfNeeded();
    await card.click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("project-open")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  }

  await page.setViewportSize({ width: 843, height: 782 });
  await page.getByTestId("goal-create-open").click();
  await expect(page).toHaveURL(/\/projects\?view=goal$/u);
  await page.goto("/projects");
  await page.getByTestId("project-create-open").click();
  await expect(page).toHaveURL(/\/projects\?view=create$/u);
});
