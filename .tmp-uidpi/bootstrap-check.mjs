import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
console.log("page url:", page.url());
try {
  const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
  console.log("bootstrap OK; baseUrl=" + conn.baseUrl);
} catch (e) {
  console.log("bootstrap FAILED: " + String(e).slice(0, 200));
}
await browser.close();
