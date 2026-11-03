import { test, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const OUT = "D:/Develop/Relay-Agent/tmp/UI-CONTENT-DENSITY-01/screenshots";

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

const pages: { name: string; url: string; ready?: string }[] = [
  { name: "settings", url: "/settings", ready: '[data-testid="settings-group-model"]' },
  { name: "chat", url: "/agent" },
  { name: "connections", url: "/connections" },
  { name: "knowledge", url: "/knowledge" },
  { name: "task-create", url: "/tasks?view=create" }
];

for (const size of [{ w: 1440, h: 900, tag: "1440" }, { w: 1100, h: 820, tag: "1100" }]) {
  test.describe(`content density ${size.tag}`, () => {
    test.use({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1 });
    for (const item of pages) {
      test(`${item.name}-${size.tag}`, async ({ page }) => {
        await page.goto(item.url);
        await page.waitForLoadState("networkidle").catch(() => {});
        if (item.ready) {
          const tab = page.locator(item.ready).first();
          if (await tab.count()) { await tab.click().catch(() => {}); }
        }
        await shot(page, `${item.name}-${size.tag}`);
      });
    }
  });
}
