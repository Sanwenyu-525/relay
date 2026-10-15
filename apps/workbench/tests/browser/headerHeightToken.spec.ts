import { expect, test } from "@playwright/test";

// 2026-10-10 layout.header.height 语义澄清（design-system §9.6 收尾项）。
// 规则：该 token 描述「应用上下文顶栏 .app-topbar 的实际高度」，其值必须与真实渲染一致；
// 桌面上方的固定区总高 = 原生标题栏 control.nav.height + 本 token。
// 旧值 3.5rem 是更早布局的遗留，与实际顶栏（control.height.comfort + 下边框）不符，
// 会让锚点滚动预留偏大；本用例把「token 值 == 实测高度」锁成回归。

const page800 = "/today";

test.describe("layout.header.height 与真实顶栏一致", () => {
  test("token 值等于 .app-topbar 实测高度（rem 按根字号换算）", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(page800);
    await expect(page.locator(".app-topbar")).toBeVisible();

    const measured = await page.evaluate(() => {
      const topbar = document.querySelector(".app-topbar")!;
      const root = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(root.fontSize);
      const token = root.getPropertyValue("--relay-layout-header-height").trim();
      const toPx = (rem: string) => Number.parseFloat(rem) * rootPx;
      return { height: topbar.getBoundingClientRect().height,
        tokenPx: token.endsWith("rem") ? toPx(token) : Number.parseFloat(token),
        rootPx, token };
    });

    // 预留 1px 容差：顶栏 min-height 与 1px 下边框的合成允许亚像素误差。
    expect(Math.abs(measured.height - measured.tokenPx), `token ${measured.token} ≈ ${measured.tokenPx}px，实测 ${measured.height}px`)
      .toBeLessThanOrEqual(1);
  });

  test("桌面壳滚动预留 = 原生标题栏 control.nav.height + 顶栏 token", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(page800);
    await expect(page.locator(".app-topbar")).toBeVisible();

    const reserved = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(root.fontSize);
      const rem = (name: string) => Number.parseFloat(root.getPropertyValue(name)) * rootPx;
      document.documentElement.classList.add("app-desktop");
      const padding = Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
      document.documentElement.classList.remove("app-desktop");
      return { padding, navHeight: rem("--relay-control-nav-height"), header: rem("--relay-layout-header-height") };
    });

    expect(Math.abs(reserved.padding - (reserved.navHeight + reserved.header)))
      .toBeLessThanOrEqual(1);
  });
});
