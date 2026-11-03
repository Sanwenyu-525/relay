import { test, expect } from "@playwright/test";

const targets = [
  { name: "settings", url: "/settings" },
  { name: "chat", url: "/agent" },
  { name: "connections", url: "/connections" },
  { name: "knowledge", url: "/knowledge" },
  { name: "task-create", url: "/tasks?view=create" }
];

test.use({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1 });

for (const t of targets) {
  test(`no horizontal overflow: ${t.name}`, async ({ page }) => {
    await page.goto(t.url);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${t.name}`).toBeLessThanOrEqual(1);
  });
}

test("settings copy density", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle").catch(() => {});
  expect(await page.locator(".page-head-lede").count(), "settings page lede removed").toBe(0);
  await page.locator('[data-testid="settings-group-model"]').first().click().catch(() => {});
  await page.waitForTimeout(500);
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("聊天默认与 Run 默认分列");
  expect(body).not.toContain("两类默认互不改写");
  expect(body).not.toContain("「连接验证通过」只表示固定短文本调用成功");
  expect(body).not.toContain("每项设置都标明生效范围");
});

test("knowledge detail metadata stays folded", async ({ page }) => {
  await page.goto("/knowledge");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
  const openManage = await page.locator("details.knowledge-management[open]").count();
  expect(openManage, "knowledge management details closed by default").toBe(0);
});

test("details disclosure is keyboard operable", async ({ page }) => {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator('[data-testid="settings-group-model"]').first().click().catch(() => {});
  await page.waitForTimeout(300);
  const details = page.locator("details.settings-advanced").first();
  if (await details.count()) {
    await details.locator("summary").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    expect(await details.evaluate((el) => (el as HTMLDetailsElement).open), "opens with Enter").toBe(true);
  }
});
