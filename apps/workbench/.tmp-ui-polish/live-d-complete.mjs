// Live 状态页对照 D：真实完成 READY 任务 → 完成凭据（UI-27）。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/.tmp-ui-replica/live/";
mkdirSync(out, { recursive: true });
const envText = readFileSync("D:/Develop/Relay-Agent/apps/api/.env", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const taskId = process.argv[2] ?? "c9295c55-0e29-4c0d-b737-1d57b8582998";
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

const projectId = "00033165-1fe8-44db-bc8d-5d04b2292aea";
await liveGoto(`/projects/${projectId}/tasks`);
await page.getByTestId(`project-task-row-${taskId}`).click();
await page.waitForTimeout(600);
const startButton = page.getByTestId("project-task-start");
if ((await startButton.getAttribute("disabled")) === null) {
  await startButton.click();
  await page.getByText("已开始").first().waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  console.log("task started");
} else {
  console.log("start disabled:", await page.getByTestId("project-task-start-reason").textContent().catch(() => "n/a"));
}
await liveGoto(`/tasks/${taskId}`);
await page.getByRole("button", { name: "产物" }).click().catch(() => {});
await page.getByRole("link", { name: "产物" }).click().catch(() => {});
await page.getByTestId("task-completion").waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
const criteria = page.locator('[data-testid^="criterion-"]');
const count = await criteria.count();
console.log("criteria:", count);
for (let i = 0; i < count; i++) {
  const box = criteria.nth(i);
  if (!(await box.isChecked())) await box.click();
}
await page.locator('input[name="completion-statement"]').fill("已逐项核对验收条件，确认本轮成果满足验收依据。");
await page.screenshot({ path: `${out}UI27-before-complete.png` });
const completeButton = page.getByTestId("task-complete");
await completeButton.waitFor({ timeout: 10000 });
if ((await completeButton.getAttribute("disabled")) !== null) throw new Error("task-complete still disabled");
await completeButton.click();
await page.getByTestId("task-complete-receipt").waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}UI27-task-completed.png` });
console.log("completed; receipt visible");
const recordLink = page.getByRole("link", { name: /完成凭据|查看完成/ }).first();
if (await recordLink.count()) {
  await recordLink.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
}
if (!page.url().includes("completion-records")) {
  const anyRecordLink = page.locator('a[href^="/completion-records"]').first();
  if (await anyRecordLink.count()) await anyRecordLink.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
}
console.log("url:", page.url());
await page.screenshot({ path: `${out}UI27-completion-record.png`, fullPage: true });
await page.close();
await browser.close();
