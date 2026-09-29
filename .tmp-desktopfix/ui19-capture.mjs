// UI-19 补取证：真实 PAUSED Run 的桌面渲染截图（1280x800 交互轮）。
import pw from 'file://D:/Develop/Relay-Agent/.tmp-uidpi/node_modules/@playwright/test/index.js';
import { mkdirSync } from 'node:fs';
const { chromium } = pw;
const RUN = process.argv[2];
const OUT = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-dpi-2026-09-29/matrix";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith("http://tauri.localhost"));
if (!page) { console.error("no tauri page"); process.exit(1); }
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
console.log("bootstrap:", conn.baseUrl);
// 经真实 API 先核对 Run 确为 PAUSED（不造假状态）
const H = { Authorization: `Bearer ${conn.bearerToken}` };
const run = await (await fetch(`${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}/runs/${RUN}`, { headers: H })).json();
console.log("run status:", run.status, "wait_reason:", run.wait_reason ?? "-", "revision:", run.revision);
if (run.status !== "PAUSED") { console.log("NOT_PAUSED_ABORT"); process.exit(3); }
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`http://tauri.localhost/runs/${RUN}`, { waitUntil: "load" });
await page.waitForTimeout(2500);
const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
const hasPaused = text.includes("已暂停") || text.includes("PAUSED") || text.includes("暂停");
console.log("page shows paused marker:", hasPaused);
console.log("page text head:", JSON.stringify(text.slice(0, 400)));
await page.screenshot({ path: `${OUT}/ui19-paused-补取证-1280x800.png` });
console.log("screenshot saved:", `${OUT}/ui19-paused-补取证-1280x800.png`);
await browser.close();
