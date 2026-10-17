import { expect, test, type Page } from "@playwright/test";

// 页面内受控 API；只核对布局与导航，不连接用户数据库或 Provider。
const apiBase = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const reviewId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;
const review = {
  id: reviewId, kind: "CRITERION", status: "OPEN", revision: "1", project_id: projectId,
  task_id: taskId, run_id: null, operation_id: null, reason: "请核对这份有较长名称的项目交付是否满足当前必需验收条件",
  target_hash: "a".repeat(64), target: { artifact_version_id: "55555555-5555-4555-8555-555555555555", acceptance_revision: "1", criterion_id: "c1" },
  evidence: {}, effect: {}, allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
  created_at: "2026-10-16T00:00:00Z", decided_at: null
};

async function connect(page: Page) {
  await page.route(`${apiBase}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { "access-control-allow-origin": "http://127.0.0.1:4173", "access-control-allow-headers": "Authorization, Content-Type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let body: unknown = { items: [], next_cursor: null };
    if (path === "/health/ready") body = { status: "ready" };
    if (path === `${prefix}/reviews`) body = { items: [review] };
    if (path === `${prefix}/reviews/${reviewId}`) body = review;
    if (path === `${prefix}/tasks/${taskId}`) body = { id: taskId, project_id: projectId, title: "核对交付", status: "IN_PROGRESS", mode: "ME", revision: "1", executor: { kind: "HUMAN", run_id: null }, current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [], dependencies: [], updated_at: "2026-10-16T00:00:00Z",
      acceptance: { acceptance_revision: "1", objective: "核对交付", source: "HUMAN", expected_outputs: { document: "MARKDOWN" }, criteria: [{ criterion_id: "c1", statement: "结论有依据", required: true, method: "HUMAN", target_spec: {} }] } };
    if (path === `${prefix}/projects/${projectId}`) body = { id: projectId, title: "Windows 桌面验收与较长项目名称的完整显示", project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null };
    if (path.endsWith("/artifacts")) body = { items: [], next_cursor: null, current_accepted_version_ids: [] };
    await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("frontend-acceptance-fixture");
  await page.getByTestId("relay-connect").click();
  await expect(page.getByTestId("relay-connection-state")).toContainText("已连接");
  await page.keyboard.press("Escape");
}

test("项目、待处理、动态让出会话栏空间，返回工作台仍可打开新对话", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const path of ["/projects", "/reviews", "/activity"]) {
    await page.goto(path);
    await expect(page.getByTestId("app-context-rail")).toBeHidden();
    await expect(page.getByTestId("sidebar-resize-handle")).toBeHidden();
    const width = await page.locator(".app-content").evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(1150);
  }
  await page.getByRole("link", { name: "工作台", exact: true }).click();
  await expect(page.getByTestId("context-new-conversation")).toBeVisible();
  await expect(page.getByTestId("app-context-rail")).toBeVisible();
  await page.getByTestId("context-rail-collapse").click();
  await page.getByRole("link", { name: "项目", exact: true }).click();
  await expect(page.getByTestId("app-context-rail")).toBeHidden();
  expect(await page.locator(".app-content").evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(1150);
  await page.getByRole("link", { name: "工作台", exact: true }).click();
  await expect(page.getByTestId("context-rail-collapse")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("context-rail-collapse").click();
  await expect(page.getByTestId("context-new-conversation")).toBeVisible();
});

// 2026-10-17 用户指令：聊天框左边的分界线悬停时浅一点，拖拽时保持与悬停相同的样式。
// 锁可见关系：静止透明；悬停出现半透明线（比控件边界浅）；抓握后指针离开命中区，线仍保持同款。
test("侧栏拖拽分隔线：悬停变浅，拖拽保持同款", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/today");
  const handle = page.getByTestId("sidebar-resize-handle");
  await expect(handle).toBeVisible();
  const line = () => handle.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return { background: style.backgroundColor, width: style.width };
  });
  const alphaOf = (value: string): number | null => {
    const rgba = /rgba\([^)]*,\s*([\d.]+)\)/u.exec(value);
    if (rgba !== null) return Number.parseFloat(rgba[1]);
    const modern = /\/\s*([\d.]+)\)/u.exec(value);
    if (modern !== null) return Number.parseFloat(modern[1]);
    return value.startsWith("rgb(") ? 1 : null;
  };
  const rest = await line();
  expect(rest.background).toBe("rgba(0, 0, 0, 0)");
  await handle.hover();
  await expect.poll(async () => (await line()).background, { timeout: 3_000 }).not.toBe(rest.background);
  const hover = await line();
  // 半透明混色才是「浅一档」：不透明值会把悬停线重新画回控件边界那一档。
  expect(alphaOf(hover.background)).toBeGreaterThan(0);
  expect(alphaOf(hover.background)).toBeLessThan(1);
  // 抓握后把指针拉出 24px 命中区，:hover 不再成立；拖拽态必须独立画同一条线。
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 40);
  await expect(handle).toHaveClass(/drag-separator--dragging/u);
  const dragged = await line();
  expect(dragged.background).toBe(hover.background);
  expect(dragged.width).toBe(hover.width);
  await page.mouse.up();
  await expect(handle).not.toHaveClass(/drag-separator--dragging/u);
});

for (const width of [390, 900, 1160, 1536]) {
  test(`${width}px：判断请求不嵌套多列表格，窄窗正文与判断不留下隐式空列`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/reviews");
    await connect(page);
    await expect(page.getByTestId("review-bound-reader")).toBeVisible();
    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      return { primary: rect(".review-primary"), reading: rect(".review-reading"), detail: rect(".review-detail"),
        request: rect(".review-list-item"), content: rect(".review-columns"),
        columns: getComputedStyle(document.querySelector(".review-list-item")!).gridTemplateColumns.split(" ").length,
        overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.columns).toBeLessThanOrEqual(2);
    expect(layout.request.width).toBeGreaterThan(width < 768 ? 320 : 450);
    if (width < 1280) {
      expect(Math.abs(layout.reading.x - layout.detail.x)).toBeLessThan(1);
      expect(layout.reading.width).toBeGreaterThan(layout.content.width - 2);
      expect(layout.detail.y).toBeGreaterThanOrEqual(layout.reading.bottom);
    } else {
      expect(layout.primary.width).toBeGreaterThan(layout.content.width - 2);
      expect(layout.reading.width).toBeGreaterThan(650);
      expect(layout.detail.x).toBeGreaterThanOrEqual(layout.reading.right);
    }
    expect(await page.locator(".review-detail .disabled-reason").allTextContents()).toEqual([]);
    await expect(page.getByTestId("review-decision-ACCEPT")).toBeEnabled();
  });
}
