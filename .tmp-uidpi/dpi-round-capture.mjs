// DPI 轮九页导航（桌面窗口 CDP，页面级导航，真实系统 DPI 下 PrintWindow 由外部脚本截取）。
// 用法：node dpi-round-capture.mjs navigate <route> —— 导航并等待就绪即退出。
import { chromium } from "@playwright/test";
const raw = String(process.argv[3] ?? "").replace(/^([A-Za-z]):/, "");
const route = "/" + raw.replace(/^\/+/, "");
if (!route) { console.error("usage: dpi-round-capture.mjs navigate <route>"); process.exit(2); }
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = b.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
await page.goto(`http://tauri.localhost${route}`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-service-connecting"]') && !document.querySelector('[data-testid="desktop-service-unavailable"]'), { timeout: 20000 });
await page.waitForTimeout(1500);
const m = await page.evaluate(() => ({
  dpr: window.devicePixelRatio, inner: `${window.innerWidth}x${window.innerHeight}`,
  h1: document.querySelector("h1")?.textContent?.trim() ?? "",
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
}));
console.log(JSON.stringify(m));
await b.close();
