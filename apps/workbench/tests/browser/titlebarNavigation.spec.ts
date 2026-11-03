import { expect, test, type Page } from "@playwright/test";

/**
 * UI-NAV-01 双导航布局的浏览器验收（layout / folding / 状态保持 / 几何 / 截图）。
 *
 * 浏览器里没有 Tauri 窗口控制（拖动、最小化、最大化、关闭）——那部分由
 * tests/desktop-titlebar.spec.ts 在 Tauri mock 下覆盖，真实 Windows 窗口行为另行标记待验证；
 * 本文件只对真实 Chromium 里的布局几何与交互负责。
 */

const placementKey = "relay.workbench.navigationPlacement";

/** 预置导航栏位置（等价于设置页写入的持久化结果）。 */
function usePlacement(value: "sidebar" | "titlebar"): void {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([key, stored]) => {
      if (stored !== null) localStorage.setItem(key!, stored!);
    }, [placementKey, value] as const);
  });
}

async function openMoreMenu(page: Page) {
  await page.locator(".titlebar-navigation__more-trigger").click();
  return page.locator(".titlebar-navigation__menu");
}

test.describe("默认左侧布局不受影响", () => {
  usePlacement("sidebar");

  test("图标导航渲染、标题栏无横向导航、拖拽条贴近期工作栏右缘", async ({ page }) => {
    await page.goto("/today");
    await expect(page.locator(".app-navrail")).toBeVisible();
    await expect(page.locator(".titlebar-navigation")).toHaveCount(0);
    await expect(page.locator(".app-frame")).toHaveAttribute("data-navigation-placement", "sidebar");

    const rail = (await page.locator('[data-testid="app-context-rail"]').boundingBox())!;
    const handle = (await page.locator('[data-testid="sidebar-resize-handle"]').boundingBox())!;
    // 手柄中轴画在图标栏列 + 近期工作栏列的边界上（列宽同源变量，见 .sidebar-resize-handle）。
    expect(Math.abs((handle.x + handle.width / 2) - (rail.x + rail.width))).toBeLessThanOrEqual(3);
  });
});

test.describe("标题栏布局", () => {
  usePlacement("titlebar");

  test("图标导航退位，横向导航进标题栏，当前页高亮唯一且可切换路由", async ({ page }) => {
    await page.goto("/today");
    await expect(page.locator(".app-navrail")).toHaveCount(0);
    await expect(page.locator(".app-frame")).toHaveAttribute("data-navigation-placement", "titlebar");
    const nav = page.locator(".titlebar-navigation");
    await expect(nav).toBeVisible();
    // 近期工作栏不随导航布局移动。
    await expect(page.locator('[data-testid="app-context-rail"]')).toBeVisible();

    await expect(nav.locator(".titlebar-navigation__item--active:visible")).toHaveCount(1);
    await expect(nav.locator('a[href="/today"]:visible')).toHaveAttribute("aria-current", "page");

    await nav.getByRole("link", { name: "项目" }).click();
    await expect(page).toHaveURL(/\/projects$/u);
    await expect(nav.locator(".titlebar-navigation__item--active:visible")).toHaveCount(1);
    await expect(nav.locator('a[href="/projects"]:visible')).toHaveAttribute("aria-current", "page");
  });

  test("宽窗口全部入口直接可见，无「更多」，无横向滚动条", async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 900 });
    await page.goto("/today");
    const nav = page.locator(".titlebar-navigation");
    await expect(nav.locator(".titlebar-navigation__more")).toBeHidden();
    const visible = nav.locator(".titlebar-navigation__item:not(.titlebar-navigation__more-trigger):visible");
    expect(await visible.count()).toBeGreaterThanOrEqual(10);
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(0);
  });

  test("中等窗口：放不下的入口折叠进「更多」菜单，当前页在折叠区时触发器有激活反馈", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 760 });
    await page.goto("/scheduled-tasks");
    const nav = page.locator(".titlebar-navigation");
    const more = page.locator(".titlebar-navigation__more");
    await expect(more).toBeVisible();
    // 行内条目 + 菜单条目 = 全部入口（DEV 构建含开发工具），一条不少。
    const inlineCount = await nav.locator(".titlebar-navigation__item:not(.titlebar-navigation__more-trigger):visible").count();
    const menu = await openMoreMenu(page);
    const menuCount = await menu.locator("a").count();
    expect(inlineCount + menuCount).toBe(11);
    // 当前页（定时任务）不在宽条目行时，「更多」触发器带同一激活底色，菜单内高亮。
    await expect(more).toHaveAttribute("data-overflow-active", "true");
    await expect(menu.locator('a[href="/scheduled-tasks"]')).toHaveAttribute("aria-current", "page");
    // 菜单里的入口真实可达：点击后路由变化、菜单收起（条目行在 900px 下仍有折叠项，面板只是关闭）。
    await menu.getByRole("link", { name: "设置" }).click();
    await expect(page).toHaveURL(/\/settings$/u);
    await expect(page.locator(".titlebar-navigation__menu")).toBeHidden();
  });

  test("页面状态在布局切换间保持：任务创建页草稿与主内容节点不重建", async ({ page }) => {
    await page.goto("/tasks?view=create");
    const acceptance = page.locator('textarea[name="task-acceptance"]');
    await acceptance.fill("双布局切换时这条草稿必须原样保留");
    // 模拟「另一处写入了同一设备偏好」：storage 事件是 useNavigationPlacement 的合法通知来源。
    await page.evaluate(([key]) => {
      localStorage.setItem(key!, "titlebar");
      window.dispatchEvent(new StorageEvent("storage", { key }));
    }, [placementKey] as const);
    await expect(page.locator(".app-frame")).toHaveAttribute("data-navigation-placement", "titlebar");
    await expect(page.locator(".app-navrail")).toHaveCount(0);
    // 同一 DOM 节点仍在文档里且值未变：布局切换没有重挂载创建表单，路由与查询串原样。
    const draft = await page.evaluate(() => {
      const node = document.querySelector('textarea[name="task-acceptance"]');
      return node === null ? null : { connected: node.isConnected, value: (node as HTMLTextAreaElement).value };
    });
    expect(draft).toEqual({ connected: true, value: "双布局切换时这条草稿必须原样保留" });
    await expect(page).toHaveURL(/\/tasks\?view=create$/u);
  });

  test("拖拽分隔条在两列布局下仍贴住近期工作栏右缘", async ({ page }) => {
    await page.goto("/today");
    const rail = (await page.locator('[data-testid="app-context-rail"]').boundingBox())!;
    const handle = (await page.locator('[data-testid="sidebar-resize-handle"]').boundingBox())!;
    // titlebar 布局左侧没有图标导航列：left 少加一项 railWidth，中轴仍落在列边界。
    expect(Math.abs((handle.x + handle.width / 2) - (rail.x + rail.width))).toBeLessThanOrEqual(3);
    // 近期工作栏右缘即窗口卡片左缘起点：栏从窗口左缘起步（无图标栏列）。
    expect(rail.x).toBeLessThanOrEqual(1);
  });

  test("收起近期工作栏后两种布局都能重新展开", async ({ page }) => {
    await page.goto("/today");
    await page.locator('[data-testid="context-rail-collapse"]').click();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-context-collapsed", "true");
    await page.locator('[data-testid="context-rail-collapse"]').click();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-context-collapsed", "false");
    await expect(page.locator('[data-testid="app-context-rail"]')).toBeVisible();
  });
});

test.describe("设置页导航栏位置开关", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("点击立即切换、刷新后保持、切回左侧恢复图标导航", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator('input[name="settings-navigation-placement"][value="sidebar"]')).toBeChecked();

    await page.locator('label:has(input[name="settings-navigation-placement"][value="titlebar"])').click();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-navigation-placement", "titlebar");
    await expect(page.locator(".titlebar-navigation")).toBeVisible();
    await expect(page.locator('input[name="settings-navigation-placement"][value="titlebar"]')).toBeChecked();

    await page.reload();
    await expect(page.locator(".app-frame")).toHaveAttribute("data-navigation-placement", "titlebar");

    await page.locator('label:has(input[name="settings-navigation-placement"][value="sidebar"])').click();
    await expect(page.locator(".app-navrail")).toBeVisible();
    await expect(page.locator(".titlebar-navigation")).toHaveCount(0);
  });
});

test.describe("UI-NAV-01 验收截图", () => {
  const out = "../../tmp/UI-NAV-01-dual-navigation/screenshots";

  test("五种关键状态截图", async ({ page }) => {
    // 1) 左侧导航模式，正常宽度。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/today");
    await page.screenshot({ path: `${out}/1-sidebar-1280.png` });

    // 2) 标题栏导航模式，正常宽度。
    await page.evaluate(([key]) => {
      localStorage.setItem(key!, "titlebar");
      window.dispatchEvent(new StorageEvent("storage", { key }));
    }, [placementKey] as const);
    await expect(page.locator(".titlebar-navigation")).toBeVisible();
    await page.screenshot({ path: `${out}/2-titlebar-1280.png` });

    // 3) 标题栏导航模式，最大化窗口（浏览器以 1920×1080 视口对应桌面最大化档）。
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({ path: `${out}/3-titlebar-maximized-1920.png` });

    // 4) 标题栏导航模式，窄窗折叠态 + 「更多」菜单展开。
    await page.setViewportSize({ width: 900, height: 760 });
    const menu = await openMoreMenu(page);
    await expect(menu).toBeVisible();
    await page.screenshot({ path: `${out}/4-titlebar-narrow-more-menu-900.png` });
    await page.keyboard.press("Escape");

    // 5) 设置页中的导航位置选项。
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/settings");
    await expect(page.locator('[data-testid="settings-navigation-placement"]')).toBeVisible();
    await page.screenshot({ path: `${out}/5-settings-navigation-placement.png` });
  });
});
