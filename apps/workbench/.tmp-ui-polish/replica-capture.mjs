// 一比一复刻对照取证：全页面 fixture 截图，与 docs/frontend/mockups 同尺寸（1487×1058）。
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/.tmp-ui-replica/captures/";
mkdirSync(out, { recursive: true });
const UI = "http://127.0.0.1:5173";
const pages = [
  ["UI01-today", "/today"],
  ["UI05-projects", "/projects"],
  ["UI06-create-project", "/projects?view=create"],
  ["UI07-tasks", "/tasks"],
  ["UI08-inbox", "/tasks?tab=inbox"],
  ["UI09-project-tasks", "/projects/project-hci/tasks"],
  ["UI10-task-detail", "/tasks/task-evaluation-metrics"],
  ["UI12-workbench-general", "/projects/project-hci/workbench/general"],
  ["UI13-workbench-thesis", "/projects/project-thesis-topic/workbench/thesis"],
  ["UI14-knowledge", "/knowledge"],
  ["UI17-activity", "/activity"],
  ["UI21-reviews", "/reviews"],
  ["UI23-connections", "/connections"],
  ["UI24-settings", "/settings"],
  ["UI29-create-task", "/tasks?view=create"],
  ["UI30-blueprint", "/projects/project-hci?skill=blueprint"],
  ["UI33-resume", "/projects/project-hci?skill=resume"]
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1487, height: 1058 }, deviceScaleFactor: 1 });
for (const [name, path] of pages) {
  await page.goto(`${UI}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}${name}.png` });
  console.log(`captured ${name}`);
}
// UI-15 知识阅读：列表内点击第一条可读条目打开阅读器
await page.goto(`${UI}/knowledge`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
const readerTrigger = page.locator(".knowledge-list button, .knowledge-item, [data-testid^='knowledge-open']").first();
try {
  await readerTrigger.click({ timeout: 5000 });
} catch {
  const anyButton = page.locator("main button").filter({ hasText: /综述|笔记|指南|说明/ }).first();
  await anyButton.click({ timeout: 5000 }).catch(() => console.log("knowledge item click failed"));
}
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}UI15-knowledge-reading.png` });
console.log("captured UI15-knowledge-reading");
await page.close();
await browser.close();
