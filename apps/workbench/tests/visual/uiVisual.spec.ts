import { expect, test, type Page } from "@playwright/test";

/**
 * 视觉回归基线（UI-UNIFY-02）。
 *
 * 场景固定：视口 1440×960（另有一张 1024 窄窗）、Asia/Shanghai、浅色、减少动效、
 * Date 固定到 2026-11-12 10:00，禁用动画/过渡/光标闪烁。业务数据来自工作台自带的
 * 示例数据（未连接 API 时）与 `/__dev/ui` 的真实组件，不写任何真实事实。
 *
 * 基线更新规则：只有设计变更被确认后才运行 `npm run test:visual:update`，并在此文件
 * 或验收记录里写明原因；日常验收跑 `npm run test:visual`，不允许无条件更新快照。
 */

const FIXED = new Date("2026-11-12T10:00:00+08:00");

async function open(page: Page, path: string): Promise<void> {
  await page.clock.setFixedTime(FIXED);
  await page.goto(path);
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}" });
  await page.waitForTimeout(200);
}

test.describe("页面级基线", () => {
  test("Agent 空白态（未连接 API 的示例模式）", async ({ page }) => {
    await open(page, "/agent");
    // 示例模式不伪造会话：/agent 明确说明「示例模式没有真实工作」。
    // 真实空会话的首屏由 emptyConversationWelcome.spec.ts 在路由伪造下断言（不产像素基线）。
    await expect(page.getByRole("heading", { name: "示例模式没有真实工作" })).toBeVisible();
    await expect(page).toHaveScreenshot("agent-empty.png");
  });

  // 页面内容在 .app-content 的内部滚动容器里，document 本身只有一屏高；
  // 因此对页面容器做元素截图（Playwright 支持超过视口的元素），而不是 fullPage。
  test("项目列表", async ({ page }) => {
    await open(page, "/projects");
    await expect(page.locator(".pv-page .page-head").first()).toBeVisible();
    await expect(page.locator(".pv-page")).toHaveScreenshot("projects-list.png");
  });

  test("任务列表", async ({ page }) => {
    await open(page, "/tasks");
    await expect(page.getByTestId("tasks-tab-all")).toBeVisible();
    await expect(page.locator(".pv-page")).toHaveScreenshot("tasks-list.png");
  });

  test("今日工作", async ({ page }) => {
    await open(page, "/today");
    await expect(page.locator(".pv-page").first()).toBeVisible();
    await expect(page.locator(".pv-page")).toHaveScreenshot("today.png");
  });

  test("待处理审核", async ({ page }) => {
    await open(page, "/reviews");
    await expect(page.locator(".pv-page").first()).toBeVisible();
    await expect(page.locator(".pv-page")).toHaveScreenshot("reviews.png");
  });

  test("设置页", async ({ page }) => {
    await open(page, "/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("settings-page")).toHaveScreenshot("settings.png");
  });

  test("项目详情", async ({ page }) => {
    await open(page, "/projects");
    const openLink = page.locator('[data-testid^="project-card-open-"]').first();
    await expect(openLink).toBeVisible();
    await openLink.click();
    await expect(page).toHaveURL(/\/projects\/[^/?#]+/);
    await expect(page.locator(".pv-page .page-head").first()).toBeVisible();
    await expect(page.locator(".pv-page")).toHaveScreenshot("project-detail.png");
  });

  test("任务详情", async ({ page }) => {
    await open(page, "/tasks");
    await expect(page.getByTestId("tasks-tab-all")).toBeVisible();
    const taskLink = page.locator('main a[href^="/tasks/"]').filter({ hasNotText: "新建" }).first();
    await expect(taskLink).toBeVisible();
    await taskLink.click();
    await expect(page).toHaveURL(/\/tasks\/[^/?#]+/);
    await expect(page.locator(".pv-page").first()).toBeVisible();
    await expect(page.locator(".pv-page")).toHaveScreenshot("task-detail.png");
  });

  test("窄窗（1024）下的任务列表", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await open(page, "/tasks");
    await expect(page.getByTestId("tasks-tab-all")).toBeVisible();
    await expect(page).toHaveScreenshot("tasks-narrow-1024.png");
  });

  test("浏览器内容缩放 125%", async ({ page }) => {
    await open(page, "/tasks");
    await expect(page.getByTestId("tasks-tab-all")).toBeVisible();
    // CSS zoom 模拟宿主/浏览器内容缩放：媒体查询不随之改变，正好暴露固定 px 布局的溢出。
    await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; });
    await expect(page).toHaveScreenshot("tasks-zoom-125.png");
  });

  test("滚动后的任务列表（吸顶表头）", async ({ page }) => {
    await open(page, "/activity");
    await expect(page.locator(".pv-page").first()).toBeVisible();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("activity-scrolled.png");
  });
});

test.describe("组件与状态基线（/__dev/ui）", () => {
  // Playground 同样在内部滚动容器里；按小节做元素截图，比整页 fullPage 更能看出组件差异。
  for (const [id, name] of [
    ["lab-general", "playground-buttons"],
    ["lab-controls", "playground-controls"],
    ["lab-feedback", "playground-feedback"],
    ["lab-interactive", "playground-interactive"],
    ["lab-containers", "playground-containers"],
    ["lab-overlay", "playground-overlay"],
    ["lab-tokens", "playground-tokens"]
  ] as const) {
    test(name, async ({ page }) => {
      await open(page, "/__dev/ui");
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      await expect(section).toHaveScreenshot(`${name}.png`);
    });
  }

  test("Playground 窄窗", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await open(page, "/__dev/ui");
    await expect(page.getByTestId("ui-lab")).toBeVisible();
    await expect(page).toHaveScreenshot("playground-narrow.png");
  });

  test("Dialog", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.getByRole("button", { name: "打开对话框" }).click();
    await expect(page.getByRole("dialog", { name: "确认删除" })).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-dialog.png");
  });

  test("Drawer", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.getByRole("button", { name: "打开抽屉" }).click();
    await expect(page.getByRole("dialog", { name: "检查器" })).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-drawer.png");
  });

  test("DropdownMenu 打开态", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
    await page.locator("#lab-interactive summary[aria-label='更多操作']").click();
    await expect(page.locator("#lab-interactive [role='menu']")).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-menu.png");
  });

  test("Popover 打开态", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
    await page.locator("#lab-interactive").getByRole("button", { name: "筛选" }).click();
    await expect(page.locator("#lab-interactive [role='dialog']")).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-popover.png");
  });

  test("ContextMenu 打开态", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
    await page.getByText("在这个区域点右键").click({ button: "right" });
    await expect(page.getByRole("menu", { name: "示例行操作" })).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-context-menu.png");
  });

  test("Tooltip 悬停态", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "悬停或 Tab 到我" }).hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-tooltip.png");
  });

  test("Tabs 键盘焦点", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.locator("#lab-interactive").scrollIntoViewIfNeeded();
    const tabs = page.getByRole("tablist", { name: "任务范围" });
    await tabs.getByRole("tab", { name: /全部/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveScreenshot("tabs-keyboard.png");
  });

  test("Toast 反馈", async ({ page }) => {
    await open(page, "/__dev/ui");
    await page.getByRole("button", { name: "触发 Toast" }).click();
    await expect(page.getByTestId("ui-lab-toast")).toBeVisible();
    await expect(page).toHaveScreenshot("overlay-toast.png");
  });
});
