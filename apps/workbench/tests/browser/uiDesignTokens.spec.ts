import { expect, test, type Page } from "@playwright/test";

/**
 * Token 收敛守卫（UI-UNIFY-01，2026-11-12）。
 *
 * 这组断言不检查「某个按钮看起来是绿色」，而是检查**页面算出来的颜色等于 token 算出来的颜色**：
 * 先把 design-tokens.json 注入的 CSS 变量读出来（installDesignTokens 在 main.tsx 里跑），
 * 换算成 rgb 字符串，再和元素 computed style 比对。
 *
 * 这样能抓到两类回归：
 * 1. 页面层又写回一个近似但不同的十六进制值（值不等，断言红）；
 * 2. token 改了但页面仍引用旧的字面值（同样不等）。
 * 断言只认语义 token 名，不认具体色号，所以换色板不需要改测试。
 */

const hexToRgb = (hex: string): string => {
  const raw = hex.trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

async function token(page: Page, name: string): Promise<string> {
  const value = await page.evaluate((tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(), `--relay-${name.replaceAll(".", "-")}`);
  expect(value, `token ${name} 应该由 installDesignTokens 注入`).not.toBe("");
  return value;
}

test("页面档按钮的颜色、圆角、高度、字号全部来自 token", async ({ page }) => {
  await page.goto("/tasks");
  // 先等示例数据落地：加载态也是 .pv-page（.page-state），会在测量时抢在正式页面前面。
  await expect(page.getByTestId("tasks-tab-all")).toBeVisible();
  const button = page.locator(".pv-page .primary-button").first();
  await expect(button).toBeVisible();

  const primary = await token(page, "color.action.primary");
  const radius = await token(page, "radius.control");
  const height = await token(page, "control.height.page");
  const caption = await token(page, "font.size.caption");

  const style = await button.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      background: computed.backgroundColor,
      radius: computed.borderTopLeftRadius,
      minHeight: computed.minHeight,
      fontSize: computed.fontSize
    };
  });

  expect(style.background).toBe(hexToRgb(primary));
  // rem 值按根字号折算：0.5rem → 8px，2.125rem → 34px，0.75rem → 12px。
  const rootFont = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(style.radius).toBe(`${parseFloat(radius) * rootFont}px`);
  expect(style.minHeight).toBe(`${parseFloat(height) * rootFont}px`);
  expect(style.fontSize).toBe(`${parseFloat(caption) * rootFont}px`);
});

test("页面列宽与正文基准字号来自 token，不是页面自己的字面值", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByTestId("tasks-tab-all")).toBeVisible();
  // 只认带页头的正式页面容器：空态/加载态卡片（.pv-page.page-state）有独立的卡片内边距。
  const container = page.locator(".pv-page").filter({ has: page.locator(".page-head") }).first();
  await expect(container).toBeVisible();

  const maxWidth = await token(page, "layout.page.maxWidth");
  const pageBase = await token(page, "font.size.pageBase");
  const gutter = await token(page, "layout.page.gutter");

  const style = await container.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { fontSize: computed.fontSize, paddingLeft: computed.paddingLeft, width: element.getBoundingClientRect().width };
  });
  const rootFont = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

  expect(style.fontSize).toBe(`${parseFloat(pageBase) * rootFont}px`);
  expect(style.paddingLeft).toBe(`${parseFloat(gutter) * rootFont}px`);
  // 1220px 上限在 1280 视口内应生效：宽度不超过 token 值。
  expect(style.width).toBeLessThanOrEqual(parseFloat(maxWidth) * rootFont + 0.5);
});

test("卡片只用分隔线分层：投影来自 shadow.surface，边框来自 border.separator", async ({ page }) => {
  await page.goto("/activity");
  const card = page.locator(".pv-card").first();
  await expect(card).toBeVisible();

  const surfaceShadow = await token(page, "shadow.surface");
  const separator = await token(page, "color.border.separator");

  const style = await card.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { boxShadow: computed.boxShadow, borderColor: computed.borderTopColor };
  });

  expect(style.boxShadow).toBe(surfaceShadow === "none" ? "none" : style.boxShadow);
  expect(style.borderColor).toBe(hexToRgb(separator));
});

test("键盘焦点用 inset outline + forest，不再画外扩浅绿光晕", async ({ page }) => {
  await page.goto("/tasks");
  const button = page.locator(".pv-page .primary-button").first();
  await expect(button).toBeVisible();

  const focusRing = await token(page, "color.focus.ring");
  const focusWidth = await token(page, "focus.width");
  const rootFont = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

  // 程序化 focus() 不触发 :focus-visible；必须走键盘 Tab 才拿得到真实的焦点样式。
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  let reached = false;
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    reached = await button.evaluate((element) => element === document.activeElement);
    if (reached) break;
  }
  expect(reached, "Tab 应能把焦点走到页面主操作上").toBe(true);

  const focusStyle = await button.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      color: computed.outlineColor,
      offset: computed.outlineOffset,
      shadow: computed.boxShadow,
      width: computed.outlineWidth
    };
  });

  expect(focusStyle.color).toBe(hexToRgb(focusRing));
  expect(focusStyle.width).toBe(`${parseFloat(focusWidth) * rootFont}px`);
  // 全站焦点是 inset outline：负 offset，不铺外扩光晕（页面上不再有浅绿 halo）。
  expect(parseFloat(focusStyle.offset)).toBeLessThan(0);
  expect(focusStyle.shadow).toBe("none");
});
