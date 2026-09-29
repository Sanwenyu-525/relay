// 逐页 UI 提示词开发的统一截图工具（供并行开发 agent 使用）。
// 用法：node apps/workbench/scripts/ui-page-capture.mjs <证据名> <路由或完整URL> [--live] [--viewport 1280x800]
// 证据写入 docs/testing/evidence/ui-live-integration-2026-09-28/page-prompts/<证据名>-viewport.png / -full.png
// --live 通过连接对话框连接 apps/api/.env 的本机 API（工作空间 11111111…，已有混合测试数据）；
// 缺省为 fixture 示例模式（确定性示例数据，适合数据丰富状态的布局核对）。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const [name, target] = process.argv.slice(2);
const live = process.argv.includes("--live");
const vpIdx = process.argv.indexOf("--viewport");
const [vpW, vpH] = vpIdx > -1 ? process.argv[vpIdx + 1].split("x").map(Number) : [1280, 800];
if (!name || !target) { console.error("usage: ui-page-capture.mjs <name> <route|url> [--live]"); process.exit(2); }

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const envText = readFileSync(`${repoRoot}apps/api/.env`, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const ui = "http://127.0.0.1:5173";
// Git Bash 会把以 / 开头的参数转成 Windows 路径；这里统一归一化，路由可不带前导斜杠。
const url = target.startsWith("http") ? target : `${ui}/${target.replace(/^\/+/, "").replace(/^([A-Za-z]):/, "")}`;
const outDir = `${repoRoot}docs/testing/evidence/ui-live-integration-2026-09-28/page-prompts/`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: vpW, height: vpH }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle" });
if (live) {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
  await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
  await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
} else {
  await page.waitForTimeout(600);
}
await page.screenshot({ path: `${outDir}${name}-viewport.png` });
await page.screenshot({ path: `${outDir}${name}-full.png`, fullPage: true });
const errors = await page.evaluate(() => document.querySelectorAll(".action-error").length);
console.log(`captured ${name}: ${url} live=${live} actionErrors=${errors}`);
await page.close();
await browser.close();
