// 经 CDP 附着桌面窗口，调用 desktop_bootstrap 验证本机服务可用性。
import pw from 'file://D:/Develop/Relay-Agent/.tmp-uidpi/node_modules/@playwright/test/index.js';
const { chromium } = pw;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
if (!page) { console.log("PAGE_NOT_FOUND"); process.exit(2); }
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
console.log("BOOTSTRAP_OK baseUrl=" + conn.baseUrl + " workspace=" + conn.workspaceId);
await browser.close();
