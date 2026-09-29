// UI-15 补拍：滚动到资料阅读面板与版本切换区，两个视口各一张。
import { chromium } from "@playwright/test";
const OUT = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-dpi-2026-09-29/matrix";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
console.log("conn:", conn.baseUrl);
const K1 = "7bcc828b-6188-4cb5-b327-11a59d97b126"; // 全局资料（工作空间范围，在 /knowledge 列表内）
for (const round of ["1280x800", "960x640"]) {
  const [w, h] = round.split("x").map(Number);
  // 调整窗口由外部脚本处理；这里只导航并滚动
  await page.goto(`http://tauri.localhost/knowledge?item=${K1}`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-service-connecting"]'), { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.getElementById("main-content")?.scrollTo(0, 999999); window.scrollTo(0, 999999); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/UI-15b-reading-${round}.png` });
  console.log(`captured UI-15b-reading-${round}`);
}
await browser.close();
