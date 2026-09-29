// Live 状态页对照 A：知识登记 → 阅读器（UI-15）。每页重新连接（live 凭据仅内存）。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/.tmp-ui-replica/live/";
mkdirSync(out, { recursive: true });
const envText = readFileSync("D:/Develop/Relay-Agent/apps/api/.env", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
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

await liveGoto("/knowledge?kind=KNOWLEDGE");
const hasRows = await page.locator(".knowledge-row").count();
if (hasRows === 0) {
  await page.getByTestId("knowledge-create").click();
  await page.locator('[data-testid="knowledge-title"]').fill("协作与验收指南");
  await page.locator('[data-testid="knowledge-text"]').fill(
    "在人与 AI 协作的工作流中，AI 主要负责基于已有信息生成候选方案，人类需要结合项目的原始验收条件与实际情况，对 AI 的候选内容进行核验、判断与取舍。\n\n只有通过人类的判断和把关，才能将 AI 的能力转化为可靠的工作成果，确保输出符合项目目标、质量要求与实际约束。\n\n阅读知识，不等于授权 AI 使用。");
  await page.getByTestId("knowledge-save").click();
  await page.locator(".knowledge-row").first().waitFor({ timeout: 15000 });
}
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}UI15-knowledge-list.png` });
const rowActive = await page.locator(".knowledge-row").first();
await rowActive.click();
await page.locator(".knowledge-reader, .knowledge-detail, [data-testid='knowledge-detail-scope']").first().waitFor({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}UI15-knowledge-reading.png` });
console.log("UI15 captured; rows=", await page.locator(".knowledge-row").count());
await page.close();
await browser.close();
