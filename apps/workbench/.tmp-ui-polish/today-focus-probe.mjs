// 一次性视觉验证：今日页右栏断点 + 焦点卡真实命令路径（设置→截图→清除还原）。
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const envText = readFileSync("D:/Develop/Relay-Agent/apps/api/.env", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const out = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-live-integration-2026-09-28/page-prompts/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173/today", { waitUntil: "networkidle" });
await page.getByTestId("relay-connection-open").click();
await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
await page.getByTestId("relay-connect").click();
await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
await page.keyboard.press("Escape");
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}today-rail-1600-viewport.png` });
await page.screenshot({ path: `${out}today-rail-1600-full.png`, fullPage: true });

// 真实设置今日焦点（第一条可开始任务），核对焦点卡与主按钮后清除还原。
await page.locator(".today-task__actions button", { hasText: "设为今日焦点" }).first().click();
await page.locator(".today-focus__title a").first().waitFor({ timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}today-focus-set-1600-viewport.png` });
await page.screenshot({ path: `${out}today-focus-set-1600-full.png`, fullPage: true });
await page.locator(".today-focus__actions button", { hasText: "清除今日焦点" }).click();
await page.getByText("还未选择今日焦点").waitFor({ timeout: 15000 });
await page.waitForTimeout(400);
const bannerVisible = await page.locator(".today-review-entry").isVisible();
const railVisible = await page.locator(".today-rail").isVisible();
console.log(`focus set+cleared ok; rail=${railVisible} banner=${bannerVisible}`);
await page.close();
await browser.close();
