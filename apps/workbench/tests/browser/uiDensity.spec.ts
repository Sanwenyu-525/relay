import { expect, test, type Page } from "@playwright/test";

/**
 * 密度契约（UI-UNIFY-02）。
 *
 * 密度由页面角色决定，而不是由散落的页面 CSS 偶然决定：
 * - 页面档（`.pv-page`）= compact：控件 34px、正文 13px；
 * - 工作台（/agent 等）= comfortable：控件 40px（prominent 48px）、正文 16px；
 * - `Density` 作用域可以在同一页内切换，且只重绑变量、不换组件。
 *
 * 三条都直接量 computed style 与元素高度，不读实现里的 CSS 类名。
 */

const height = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((element) => element.getBoundingClientRect().height);

const exact = (locator: ReturnType<Page["locator"]>, property: string) =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name).trim(), property);

const minHeight = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((element) => getComputedStyle(element).minHeight);

test("页面档：pv 页面重绑控件高与正文字号，按钮最小高度 34px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tasks");
  await expect(page.getByTestId("tasks-tab-all")).toBeVisible();

  const container = page.locator(".pv-page").first();
  expect(await exact(container, "--relay-control-height")).toBe("2.125rem");
  expect(await exact(container, "--relay-font-size-body")).toBe("0.8125rem");

  const button = page.locator(".pv-page .primary-button").first();
  await expect(button).toBeVisible();
  // min-height 是契约；实际盒高还会被内边距与行高撑开（38.39px），不能用它判断档位。
  expect(await minHeight(button)).toBe("34px");
  expect(await height(button)).toBeGreaterThanOrEqual(34);
});

test("工作台档：/agent 保持 40px 控件高，不被页面档影响", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "示例模式没有真实工作" })).toBeVisible();

  const shell = page.locator("main").first();
  expect(await exact(shell, "--relay-control-height")).toBe("2.5rem");

  const iconButton = page.getByTestId("context-rail-collapse");
  const control = await height(iconButton);
  // 图标按钮是 40×40 的正方形（control.height），不是页面档的 34。
  expect(control).toBe(40);
});

test("Density 作用域：同一页内可切换，且只改尺寸变量", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/__dev/ui");
  await expect(page.getByTestId("ui-lab")).toBeVisible();

  const comfortable = page.locator('[data-density="comfortable"]').getByRole("button", { name: "工作台档" });
  const compact = page.locator('[data-density="compact"]').getByRole("button", { name: "页面档" });
  await comfortable.scrollIntoViewIfNeeded();

  // Button md 取 prominent（48）；compact 把 prominent 也重绑到页面档 34。
  expect(await minHeight(comfortable)).toBe("48px");
  expect(await minHeight(compact)).toBe("34px");

  // 组件没有换：两处都是同一个 primary-button 类，密度只重绑了变量。
  expect(await comfortable.getAttribute("class")).toContain("primary-button");
  expect(await compact.getAttribute("class")).toContain("primary-button");
  expect(await exact(compact, "--relay-control-height")).toBe("2.125rem");
});
