import { expect, test } from "@playwright/test";

test.describe("收件箱路径与导航当前页", () => {
  test("别名、创建子页、普通列表与窄屏抽屉保持唯一选中项", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page).toHaveURL(/\/tasks\?tab=inbox(?:&|$)/u);

    const secondary = page.getByRole("navigation", { name: "次级导航" });
    const allTasks = secondary.locator('a[href="/tasks"]');
    const inbox = secondary.locator('a[href="/inbox"]');
    await expect(inbox).toHaveAttribute("aria-current", "page");
    await expect(inbox).toHaveClass(/navigation-item--active/u);
    await expect(allTasks).not.toHaveAttribute("aria-current", "page");
    await expect(allTasks).not.toHaveClass(/navigation-item--active/u);

    await page.goto("/tasks?tab=inbox&view=create");
    await expect(inbox).toHaveAttribute("aria-current", "page");
    await expect(allTasks).not.toHaveAttribute("aria-current", "page");
    await page.goto("/tasks");
    await expect(allTasks).toHaveAttribute("aria-current", "page");
    await expect(allTasks).toHaveClass(/navigation-item--active/u);
    await expect(inbox).not.toHaveAttribute("aria-current", "page");

    // 折叠档（<48rem）：导航只走抽屉，抽屉里保持唯一选中项。
    await page.setViewportSize({ width: 743, height: 782 });
    await page.goto("/tasks?tab=inbox");
    await page.getByRole("button", { name: "打开导航" }).click();
    const drawer = page.getByRole("navigation", { name: "完整导航" });
    const drawerInbox = drawer.locator('a[href="/inbox"]');
    const drawerAll = drawer.locator('a[href="/tasks"]');
    await expect(drawerInbox).toHaveAttribute("aria-current", "page");
    await expect(drawerInbox).toHaveClass(/mobile-navigation-item--active/u);
    await expect(drawerAll).not.toHaveAttribute("aria-current", "page");
    await drawerAll.click();
    await expect(page).toHaveURL(/\/tasks$/u);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "打开导航" }).click();
    const reopenedDrawer = page.getByRole("navigation", { name: "完整导航" });
    await expect(reopenedDrawer.locator('a[href="/tasks"]')).toHaveAttribute("aria-current", "page");
    await expect(reopenedDrawer.locator('a[href="/inbox"]')).not.toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");

    // 折叠点之上（48rem–64rem）：外壳保留常驻次级导航，选中项仍唯一，且抽屉入口不出现。
    await page.setViewportSize({ width: 900, height: 782 });
    await page.goto("/tasks?tab=inbox");
    const midSecondary = page.getByRole("navigation", { name: "次级导航" });
    await expect(midSecondary.locator('a[href="/inbox"]')).toHaveAttribute("aria-current", "page");
    await expect(midSecondary.locator('a[href="/tasks"]')).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "打开导航" })).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 782 });
    // 回到 /tasks：上一段停在收件箱，否则宽窗段断言的当前页前提被换掉。
    await page.goto("/tasks");
    const wideSecondary = page.getByRole("navigation", { name: "次级导航" });
    await expect(wideSecondary.locator('a[href="/tasks"]')).toHaveAttribute("aria-current", "page");
    await expect(wideSecondary.locator('a[href="/inbox"]')).not.toHaveAttribute("aria-current", "page");

    await page.goto("/today");
    const onOtherPage = page.getByRole("navigation", { name: "次级导航" });
    await expect(onOtherPage.locator('a[href="/tasks"]')).not.toHaveAttribute("aria-current", "page");
    await expect(onOtherPage.locator('a[href="/inbox"]')).not.toHaveAttribute("aria-current", "page");
  });
});
