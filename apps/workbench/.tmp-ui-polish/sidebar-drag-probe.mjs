// 一次性视觉验证：侧栏拖拽分隔条（fixture 模式即可，纯外壳交互）。
// 流程：默认截图 → 悬停分隔条截图 → 真实指针拖拽 +72px 截图 → 双击复位截图。
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-live-integration-2026-09-28/page-prompts/";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173/today", { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const handle = page.getByTestId("sidebar-resize-handle");
await handle.hover();
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}sidebar-handle-hover.png`, clip: { x: 0, y: 0, width: 640, height: 560 } });

const box = await handle.boundingBox();
if (box === null) throw new Error("resize handle not visible");
await page.mouse.move(box.x + box.width / 2, box.y + 300);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 72, box.y + 300, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const widthAfterDrag = await page.evaluate(() =>
  document.querySelector(".app-frame").style.getPropertyValue("--relay-sidebar-user-width"));
const stored = await page.evaluate(() => window.localStorage.getItem("relay.workbench.sidebarWidthPx"));
await page.screenshot({ path: `${out}sidebar-handle-dragged.png`, clip: { x: 0, y: 0, width: 640, height: 560 } });

await handle.dblclick();
await page.waitForTimeout(300);
const widthAfterReset = await page.evaluate(() =>
  document.querySelector(".app-frame").style.getPropertyValue("--relay-sidebar-user-width"));
const storedAfterReset = await page.evaluate(() => window.localStorage.getItem("relay.workbench.sidebarWidthPx"));
console.log(`drag: var=${widthAfterDrag} stored=${stored}; reset: var='${widthAfterReset}' stored=${storedAfterReset}`);
await page.close();
await browser.close();
