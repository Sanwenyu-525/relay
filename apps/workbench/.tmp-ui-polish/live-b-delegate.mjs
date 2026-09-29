// Live 状态页对照 B：委托创建 Run → 运行控制（UI-18）→ 真实暂停（UI-19）。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/.tmp-ui-replica/live/";
mkdirSync(out, { recursive: true });
const envText = readFileSync("D:/Develop/Relay-Agent/apps/api/.env", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const taskId = process.argv[2] ?? "e55daa91-732e-46fc-b289-4793017538e0";
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

await liveGoto(`/tasks/${taskId}`);
await page.getByRole("button", { name: "执行记录" }).click().catch(() => {});
await page.getByRole("link", { name: "执行记录" }).click().catch(() => {});
await page.waitForTimeout(800);
const delegateButton = page.getByTestId("task-delegate");
await delegateButton.waitFor({ timeout: 15000 });
if ((await delegateButton.getAttribute("disabled")) !== null) throw new Error("delegate button disabled");
await delegateButton.click();
await page.waitForTimeout(1500);
console.log("delegated; page text has 委托命令返回:", await page.getByText("委托命令返回").count());
await page.close();
await browser.close();
