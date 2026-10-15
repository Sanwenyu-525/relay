import { test, type Page, type Route } from "@playwright/test";

// 首装空态的出图基线：空工作空间下 /projects 主区与搜索无匹配的实际呈现，
// 供人工比对视觉力度（见 docs/frontend/design-system.md 第 6 节 EmptyState）。
// 与 tests/browser/projects-empty-state.spec.ts 共用同一套空工作空间拦截，不连数据库、不调 Provider。
// 断言在那个 spec 里；这里只负责把状态画出来，落到 test-results/ 供查看。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4174";

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

async function installEmptyWorkspace(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("empty-shot-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.use({ viewport: { width: 1600, height: 1000 } });

test("首装空态出图", async ({ page }) => {
  await installEmptyWorkspace(page);
  await page.goto("/projects");
  await connect(page);
  await page.getByTestId("projects-empty").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: "test-results/projects-empty-1600.png", fullPage: false });
});

// 搜索无匹配只可能在已加载项目存在时出现：空工作空间下搜索框没有可筛的对象。
test("搜索无匹配出图", async ({ page }) => {
  const project = { id: "22222222-2222-4222-8222-222222222222", title: "MyProject",
    project_type: "GENERAL", revision: "1", state_revision: "1",
    archived_at: null, archive_status: "ACTIVE", phase_key: "PLANNING",
    next_action_task_id: null, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z" };
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [project], next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
  await page.goto("/projects");
  await connect(page);
  await page.locator('input[name="live-project-search"]').fill("没有的项目");
  await page.getByTestId("projects-live-no-match").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: "test-results/projects-no-match-1600.png", fullPage: false });
});