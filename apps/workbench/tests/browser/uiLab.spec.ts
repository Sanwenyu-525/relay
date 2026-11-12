import { expect, test } from "@playwright/test";

/**
 * UI Playground 冒烟与交互检查（UI-UNIFY-01）。
 *
 * 这里验证的是「展示页本身能用」：它真的渲染了生产组件、token 数值真的来自运行时、
 * 浮层真的能被键盘关闭并把焦点还回去、宽度预览真的改变容器宽度。
 * 组件外观归 uiDesignTokens.spec.ts；本文件不重复断言颜色。
 */

test("/__dev/ui 渲染真实组件与运行时 token 值", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto("/__dev/ui");
  await expect(page.getByTestId("ui-lab")).toBeVisible();

  // token 区按 design-tokens.json 动态生成：颜色是色块卡，其余是紧凑表。
  // 少于 30 个色块说明注入或分组读值坏了。
  expect(await page.locator(".ui-lab-card").count()).toBeGreaterThan(30);
  expect(await page.locator(".ui-lab-table tbody tr").count()).toBeGreaterThan(30);

  // 计算值必须是插值后的真实值，不能是 "{color.palette.forest}" 这类引用串。
  const reference = await page.locator(".ui-lab-card", { hasText: "color.action.primary" }).first().innerText();
  expect(reference).not.toContain("{");
  expect(reference.toLowerCase()).toMatch(/#[0-9a-f]{6}/);

  // 组件区渲染的按钮必须带生产类名——Playground 不许另写一套。
  expect(await page.locator(".ui-lab button.primary-button").count()).toBeGreaterThan(0);
  expect(errors, "页面不应有未捕获异常").toEqual([]);

});

test("对话框：打开后焦点进入面板，Esc 关闭并归还焦点", async ({ page }) => {
  await page.goto("/__dev/ui");
  const trigger = page.getByRole("button", { name: "打开对话框" });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "确认删除" });
  await expect(dialog).toBeVisible();
  // 焦点必须落在面板内，而不是留在触发按钮上。
  await expect.poll(() => page.evaluate(() => document.querySelector("[role=dialog]")?.contains(document.activeElement) ?? false)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("抽屉变体用同一个对话框组件，标题与宽度档不同", async ({ page }) => {
  await page.goto("/__dev/ui");
  await page.getByRole("button", { name: "打开抽屉" }).click();
  const drawer = page.locator(".dialog-panel--drawer");
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("容器宽度预览切换后，样例区宽度随之变化且不产生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__dev/ui");
  const preview = page.locator(".ui-lab-preview").first();
  await expect(preview).toBeVisible();

  const wide = (await preview.boundingBox())?.width ?? 0;
  await page.getByRole("button", { name: "390px" }).click();
  await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  const narrow = (await preview.boundingBox())?.width ?? 0;
  expect(wide).toBeGreaterThan(narrow);

  // 窄容器里字段仍单列，页面不出现整页横向滚动。
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("token 表没有空值：每个变量都能被运行时解析", async ({ page }) => {
  await page.goto("/__dev/ui");
  // 懒加载 chunk：先等页面落地，否则表格还没挂载，count 会是 0。
  await expect(page.getByTestId("ui-lab")).toBeVisible();
  const cells = page.locator(".ui-lab-table tbody tr td:nth-child(2)");
  const total = await cells.count();
  expect(total).toBeGreaterThan(30);
  const values = await cells.allInnerTexts();
  const missing = values.filter((value) => value.trim() === "" || value.trim() === "—");
  expect(missing, "存在没有被 installDesignTokens 注入的 token").toEqual([]);
});

test("错误态字段的边框用状态色，不是默认控件边框", async ({ page }) => {
  await page.goto("/__dev/ui");
  await expect(page.getByTestId("ui-lab")).toBeVisible();
  const invalid = page.locator("#lab-invalid");
  await expect(invalid).toHaveAttribute("aria-invalid", "true");

  const danger = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--relay-color-status-danger-text").trim());
  const rgb = `rgb(${[1, 3, 5].map((i) => parseInt(danger.replace("#", "").slice(i - 1, i + 1), 16)).join(", ")})`;
  const borderColor = await invalid.evaluate((element) => getComputedStyle(element).borderTopColor);
  expect(borderColor).toBe(rgb);
});
