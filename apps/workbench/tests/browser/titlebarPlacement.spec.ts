import { expect, test } from "@playwright/test";

const today = "/today";
const collaboration = "/agent";

test("窄桌面标题栏的窗口控制和常用操作均留在视口内", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(today);
  // 浏览器不提供 Tauri 窗口控制；用与桌面相同的结构检查真实标题栏 CSS 几何。
  await page.locator(".desktop-titlebar").evaluate((bar) => {
    const cluster = bar.querySelector(".desktop-titlebar__cluster")!;
    const notice = document.createElement("button");
    notice.className = "icon-button"; notice.setAttribute("aria-label", "通知与待处理");
    cluster.append(notice);
    const controls = document.createElement("div");
    controls.className = "desktop-titlebar__controls";
    for (const label of ["最小化", "最大化", "关闭窗口"]) {
      const button = document.createElement("button");
      button.className = "desktop-titlebar__button"; button.setAttribute("aria-label", label);
      controls.append(button);
    }
    bar.append(controls);
  });
  for (const button of await page.locator('.desktop-titlebar button, .desktop-titlebar a').all()) {
    const box = await button.boundingBox();
    if (box) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390); }
  }
});

test.describe("常用操作位于标题栏左侧", () => {
  test.use({ viewport: { width: 1487, height: 1058 } });

  test("四个常用操作在标题栏内、位于拖动区左侧，应用顶栏不再重复承载", async ({ page }) => {
    await page.goto(today);
    const bar = page.locator(".desktop-titlebar");
    const drag = page.locator(".desktop-titlebar__drag");
    await expect(bar).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    const dragBox = (await drag.boundingBox())!;

    for (const name of ["titlebar-back", "titlebar-forward", "titlebar-search", "titlebar-create-task"]) {
      const button = page.locator(`.desktop-titlebar [data-testid="${name}"]`);
      await expect(button).toHaveCount(1);
      const box = (await button.boundingBox())!;
      // 按钮与标题带同高，落在拖动区起点之前，才算标题栏左侧而不是浮在内容上。
      expect(box.y).toBeCloseTo(barBox.y, 0);
      expect(Math.round(box.height)).toBe(Math.round(barBox.height));
      expect(box.x + box.width).toBeLessThanOrEqual(dragBox.x + 1);
    }

    await expect(page.locator('.app-topbar [data-testid="titlebar-search"]')).toHaveCount(0);
    await expect(page.locator('.app-topbar [data-testid="titlebar-create-task"]')).toHaveCount(0);
    // 常用操作不属于拖动命中区：点在按钮上不触发宿主拖动。
    await page.locator('[data-testid="titlebar-search"]').dispatchEvent("mousedown", { button: 0, detail: 1 });
  });

  test("搜索仍复用同一个命令面板，前进后退仍是应用内路由历史", async ({ page }) => {
    await page.goto(today);
    await expect(page.locator('[data-testid="titlebar-back"]')).toBeDisabled();
    await expect(page.locator('[data-testid="titlebar-forward"]')).toBeDisabled();
    await page.locator('[data-testid="titlebar-search"]').click();
    await expect(page.locator('[data-testid="command-palette"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="command-palette"]')).toHaveCount(0);
  });

  test("无面包屑页面在宽屏收起应用顶栏，不留空白带", async ({ page }) => {
    await page.goto(collaboration);
    await expect(page.locator(".breadcrumbs")).toHaveCount(0);
    await expect(page.locator(".app-topbar")).toBeHidden();
    // 收起顶栏不影响标题栏这组常用操作。
    await expect(page.locator('.desktop-titlebar [data-testid="titlebar-search"]')).toBeVisible();
  });

  test("有面包屑页面保留应用顶栏那一行", async ({ page }) => {
    await page.goto(today);
    const topbar = page.locator(".app-topbar");
    await expect(topbar).toBeVisible();
    await expect(topbar.locator(".breadcrumbs")).toContainText("工作空间");
    const bar = (await page.locator(".desktop-titlebar").boundingBox())!;
    const top = (await topbar.boundingBox())!;
    // 两条带上下相邻，不重叠。
    expect(top.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  });

  test("折叠档仍保留导航抽屉入口", async ({ page }) => {
    // 折叠点 2026-10-15 由 64rem 下移到 48rem：只有落进折叠档才需要抽屉入口。
    await page.setViewportSize({ width: 743, height: 900 });
    await page.goto(collaboration);
    await expect(page.locator(".breadcrumbs")).toHaveCount(0);
    await expect(page.locator(".app-topbar .mobile-menu-button")).toBeVisible();
    await expect(page.locator('.desktop-titlebar [data-testid="titlebar-search"]')).toBeVisible();
  });

  test("折叠点之上不出现抽屉入口，导航直接可见且顶栏不留空带", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(collaboration);
    // 外壳没折叠：图标导航与近期工作都在屏幕上，抽屉入口不该再占位。
    await expect(page.locator(".app-navrail")).toBeVisible();
    await expect(page.locator(".app-context-rail")).toBeVisible();
    await expect(page.locator(".app-topbar .mobile-menu-button")).toBeHidden();
    // 无面包屑 + ☰ 已隐藏 ⇒ 顶栏整行收起，不留一条点开是空抽屉的空白带。
    await expect(page.locator(".breadcrumbs")).toHaveCount(0);
    await expect(page.locator(".app-topbar")).toBeHidden();
    await expect(page.locator('.desktop-titlebar [data-testid="titlebar-search"]')).toBeVisible();
  });
});
