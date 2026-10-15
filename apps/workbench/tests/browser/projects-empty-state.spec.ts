import { expect, test, type Page, type Route } from "@playwright/test";

// 2026-10-06 首装空态的真实 Chromium 覆盖。
// 空工作空间（Project 与 Task 列表都为空）不是「什么都没渲染」，而是必须一次说清
// 没有什么、为什么和下一步；API 全部由页面内拦截伪造，不连数据库、不调 Provider。
// 断言的是共享 EmptyState 的契约：真实 heading、装饰图标对读屏隐藏、每个范围只有属于它的入口。

const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const origin = "http://127.0.0.1:4173";
// TaskSummary 的解析按 taskFrom 的必需字段构造；字段不全会在解析处报错并落入读取失败，
// 那样测的就不是空态而是错误态，所以这里逐字段给齐。
// status 与 mode 取 domain 的真实枚举（types.ts 的 TaskStatus 与 InteractionMode），
// 写不在枚举里的值会在 taskFrom 直接抛错，页面落进读取失败态而不是空态。
const task = { id: "33333333-3333-4333-8333-333333333333", title: "MyTask",
  project_id: null, status: "READY", mode: "ME", revision: "1",
  executor: { kind: "HUMAN", run_id: null },
  current_completion_id: null, waiting_reason: null,
  blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
  updated_at: "2026-10-06T00:00:00Z" };

function cors(): Record<string, string> {
  return { "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type" };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: cors(), body: JSON.stringify(body) });
}

/** 空工作空间：项目与任务两个列表都返回空页，且没有后续页。 */
async function installEmptyWorkspace(page: Page): Promise<void> {
  await page.route(`${apiBase}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
    if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
    if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
    if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
    // 没有被本用例覆盖的端点就如实报错，不用空对象假装读取成功。
    return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("projects-empty-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
}

test.describe("首装空态（真实 Chromium）", () => {
  test("没有项目时说明项目是什么并给出主操作，不留只有一行灰字的空屏", async ({ page }) => {
    await installEmptyWorkspace(page);
    await page.goto("/projects");
    await connect(page);

    const empty = page.getByTestId("projects-empty");
    await empty.waitFor({ timeout: 20_000 });

    // 有什么 / 为什么 / 下一步三件都要在同一个区块里，不拆散到别处。
    await expect(empty.getByRole("heading", { level: 2 })).toHaveText("还没有进行中的项目");
    await expect(empty.locator(".empty-state__description"))
      .toContainText("长期目标的容器");
    await expect(empty.getByRole("button", { name: "新建项目" })).toBeEnabled();
    await expect(empty.getByRole("link", { name: "记录目标" })).toBeVisible();

    // 图标是装饰，含义由标题承担，不进读屏树；否则会多读一个无意义的图形。
    await expect(empty.locator(".empty-state__icon > svg")).toHaveAttribute("aria-hidden", "true");
    await expect(empty.locator(".empty-state__icon")).toHaveAttribute("aria-hidden", "true");

    // 主区空态不该再退回只有一行灰字的旧写法。
    await expect(page.locator(".page-state")).toHaveCount(0);
    await expect(page.getByText("当前没有进行中项目。")).toHaveCount(0);

    // 范围说明仍在：空列表不等于没有范围语义。
    await expect(page.getByTestId("projects-live-count")).toContainText("已加载 0 项");
  });

  test("首装时没有常驻右栏，左栏也不给出无效指引", async ({ page }) => {
    await installEmptyWorkspace(page);
    await page.goto("/projects");
    await connect(page);

    await page.getByTestId("projects-empty").waitFor({ timeout: 20_000 });
    // 2026-10-11 重设计：详情改为按需打开的抽屉，首装不再渲染常驻右栏或空的详情面板。
    await expect(page.locator(".projects-page .desktop-rail")).toHaveCount(0);
    await expect(page.locator(".projects-page .rail-trigger")).toHaveCount(0);
    await expect(page.locator('[role="dialog"][aria-label="项目详情"]')).toHaveCount(0);

    await page.getByTestId("recent-work-empty").waitFor({ timeout: 20_000 });
    // 左栏是定位入口，只给文字动作；新建任务的主决策区在任务页。
    await expect(page.getByTestId("recent-work-empty").locator(".primary-button")).toHaveCount(0);
    await expect(page.getByTestId("recent-work-empty").getByRole("button", { name: "新建任务" })).toBeEnabled();
  });

  test("归档范围为空时不提供无效的新建入口", async ({ page }) => {
    await installEmptyWorkspace(page);
    await page.goto("/projects?archived=1");
    await connect(page);

    const archivedEmpty = page.getByTestId("projects-archived-empty");
    await archivedEmpty.waitFor({ timeout: 20_000 });
    await expect(archivedEmpty).toContainText("归档只改变项目状态");
    await expect(archivedEmpty.getByRole("button", { name: "新建项目" })).toHaveCount(0);
    await expect(archivedEmpty.getByRole("link", { name: "回到进行中" })).toBeVisible();
  });

  test("已加载项目与工作空间为空是不同状态，搜索无匹配不冒充空工作空间", async ({ page }) => {
    const project = { id: "22222222-2222-4222-8222-222222222222", title: "MyProject",
      project_type: "GENERAL", revision: "1", state_revision: "1",
      archived_at: null, archive_status: "ACTIVE", phase_key: "PLANNING",
      next_action_task_id: null,
      created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z" };
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

    await page.locator('input[name="live-project-search"]').fill("不存在的名字");
    const noMatch = page.getByTestId("projects-live-no-match");
    await noMatch.waitFor({ timeout: 20_000 });
    // 只能说明已加载范围内没有命中，不能暗示整个工作空间是空的。
    await expect(noMatch).toContainText("已加载 1 项");
    await expect(noMatch).toContainText("只作用于已加载范围");
    await expect(page.getByTestId("projects-empty")).toHaveCount(0);
    await expect(noMatch.getByRole("button", { name: "清除搜索" })).toBeEnabled();
  });

  // 收件箱是「未归属项目的人工任务」这一范围，它的空必须与整个工作空间的空分开表达。
  test("收件箱为空与工作空间为空不是同一个空态", async ({ page }) => {
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
      if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
      if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
      // scope=all 空、inbox=true 也空：两者同时为空，正好能验证它们不被合并成一句话。
      if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [], next_cursor: null });
      return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
    });
    await page.goto("/tasks");
    await connect(page);

    const allEmpty = page.getByTestId("tasks-empty");
    await allEmpty.waitFor({ timeout: 20_000 });
    await expect(allEmpty.getByRole("heading", { level: 2 })).toHaveText("还没有任务");
    await expect(allEmpty).toContainText("可验收");
    await expect(allEmpty.getByRole("button", { name: "新建任务" })).toBeEnabled();
    await expect(allEmpty.getByRole("link", { name: "打开项目" })).toBeVisible();

    await page.getByTestId("tasks-tab-inbox").click();
    const inboxEmpty = page.getByTestId("inbox-empty");
    await inboxEmpty.waitFor({ timeout: 20_000 });
    // 收件箱为空时不出现「还没有任务」，也不提供打开项目这类与该范围无关的入口。
    await expect(page.getByTestId("tasks-empty")).toHaveCount(0);
    await expect(inboxEmpty).toContainText("未归属项目");
    await expect(inboxEmpty.getByRole("link", { name: "打开项目" })).toHaveCount(0);
  });

  // 筛选/搜索无匹配只说明已加载范围没命中，不能冒充整个工作空间为空。
  test("筛选无匹配不冒充首装空态", async ({ page }) => {
    await page.route(`${apiBase}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors() }); return; }
      if (path === "/health/ready") return fulfillJson(route, { status: "ready" });
      if (path === `${prefix}/projects`) return fulfillJson(route, { items: [], next_cursor: null });
      if (path === `${prefix}/tasks`) return fulfillJson(route, { items: [task], next_cursor: null });
      return fulfillJson(route, { code: "NOT_STUBBED", detail: path }, 404);
    });
    await page.goto("/tasks");
    await connect(page);

    await page.locator('input[name="task-search"]').first().fill("没有的任务");
    const noMatch = page.getByTestId("tasks-live-no-match");
    await noMatch.waitFor({ timeout: 20_000 });
    await expect(noMatch).toContainText("已加载 1 项");
    await expect(page.getByTestId("tasks-empty")).toHaveCount(0);
  });
});