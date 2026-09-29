// Live 状态页对照 C：/runs/:id 控制页（UI-18）→ 请求暂停 → 已暂停（UI-19）。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/.tmp-ui-replica/live/";
mkdirSync(out, { recursive: true });
const envText = readFileSync("D:/Develop/Relay-Agent/apps/api/.env", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const runId = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1487, height: 1058 }, deviceScaleFactor: 1 });

async function liveGoto(path) {
  await page.goto(`http://127.0.0.1:5173${path}`, { waitUntil: "networkidle" });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
  await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
  await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
}

await liveGoto(`/runs/${runId}`);
await page.getByTestId("run-detail").waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
const statusText = await page.locator(".page-lede").first().textContent();
await page.screenshot({ path: `${out}UI18-run-control.png` });
console.log("run page status:", statusText?.trim());

const pauseButton = page.getByTestId("run-control-PAUSE");
if (await pauseButton.count() && (await pauseButton.getAttribute("disabled")) === null) {
  await pauseButton.click();
  await page.getByTestId("run-paused-summary").waitFor({ timeout: 20000 }).catch(() => {});
  await page.getByTestId("run-refresh").click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}UI19-run-paused.png` });
  console.log("paused captured:", await page.getByTestId("run-paused-summary").count() > 0);
} else {
  console.log("PAUSE not available (run likely terminal)");
}
await page.close();
await browser.close();
