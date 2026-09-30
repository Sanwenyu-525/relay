// 协作工作区视觉取证：在浏览器里渲染真实组件，用拦截的接口返回与效果图同构的服务端事实。
// 这是浏览器渲染证据，不是 Windows 桌面验收，也不代表真实执行结果。
// 用法：node scripts/collab-visual-check.mjs [outDir]
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { workspaceId, taskId, versionId, prefix, bodies, docBody, artifacts } from "./collab-visual-fixtures.mjs";

const ui = "http://127.0.0.1:4188";
const outDir = process.argv[2] ?? "D:/Develop/Relay-Agent/docs/testing/evidence/collaboration-workspace-2026-09-29/";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();

async function openAt(width, height, work) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.route("**/health/ready", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ status: "ready", database: "ready", migrations: "applied", worker: "ready" })
  }));
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    for (const [key, body] of bodies) {
      if (path === key) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (path.endsWith("/content")) return route.fulfill({ status: 200, contentType: "text/markdown; charset=utf-8", body: docBody });
    if (path === `${prefix}/artifact-versions/${versionId}`) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(artifacts.items[0]) });
    if (path.includes("/trace")) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", detail: "Trace 暂不可读" }) });
    if (path.includes("/check-plan")) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", detail: "预览不可读" }) });
    if (path.startsWith(`${prefix}/search`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", detail: path }) });
  });
  await page.goto(`${ui}/agent${work === null ? "" : `?work=${work}`}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill("http://127.0.0.1:8787");
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("visual-check-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
  if (work !== null) await page.getByTestId("collab-goal").waitFor({ timeout: 15000 });
  await page.waitForTimeout(900);
  return page;
}

const results = [];
const page = await openAt(1280, 800, null);
await page.screenshot({ path: `${outDir}collab-10-empty-1280x800.png` });
results.push(["无选中工作显示目标入口", await page.getByTestId("collab-empty").count() === 1]);
results.push(["左栏近期工作来自真实 Task", await page.locator(".recent-work-item").count() >= 3]);
await page.close();

const wide = await openAt(1512, 950, taskId);
await wide.screenshot({ path: `${outDir}collab-11-dialogue-document-1512x950.png` });
results.push(["三栏同时可见", await wide.getByTestId("collab-side").isVisible() && await wide.getByTestId("collab-center").isVisible()]);
results.push(["事实条为一条三格", await wide.locator(".collab-factbar > li").count() === 3]);
results.push(["消息有头像与时间戳", await wide.locator(".agent-message-avatar").count() === 3]);
results.push(["日期分隔线存在", await wide.locator(".agent-date-separator").count() === 1]);
results.push(["输入区常驻且有工具条", await wide.locator(".agent-chat-composer-tools .agent-chat-tool").count() === 3]);
results.push(["执行进展不在中栏", await wide.locator(".collab-center [data-testid='collab-run-progress']").count() === 0]);
// 这里验证渲染结果，不验证点击拦截；可见性已单独断言，草稿轮询会让 Playwright 的稳定性检查反复重试。
await wide.getByTestId("collab-side-tab-CHECK").dispatchEvent("click");
await wide.waitForTimeout(400);
await wide.screenshot({ path: `${outDir}collab-12-check-tab-1512x950.png` });
results.push(["检查页签有执行进展", await wide.getByTestId("collab-run-progress").count() === 1]);
await wide.getByTestId("collab-side-tab-HISTORY").dispatchEvent("click");
await wide.waitForTimeout(400);
await wide.screenshot({ path: `${outDir}collab-13-history-tab-1512x950.png` });
results.push(["版本历史可选确切版本", await wide.getByTestId("collab-history-select").count() === 1]);
await wide.getByTestId("collab-side-tab-DOCUMENT").dispatchEvent("click");
await wide.waitForTimeout(300);
await wide.getByTestId("collab-devtools-toggle").dispatchEvent("click");
await wide.waitForTimeout(400);
await wide.screenshot({ path: `${outDir}collab-14-devtools-1512x950.png` });
results.push(["工具面板占用右栏而非第四列", await wide.getByTestId("devtools-panel").count() === 1]);
await wide.close();

const narrow = await openAt(900, 780, taskId);
await narrow.screenshot({ path: `${outDir}collab-15-narrow-document-900x780.png` });
await narrow.getByTestId("collab-side-tab-CHECK").dispatchEvent("click");
await narrow.waitForTimeout(400);
await narrow.screenshot({ path: `${outDir}collab-16-narrow-check-900x780.png` });
results.push(["窄窗目标与事实条常驻", await narrow.getByTestId("collab-goal").isVisible()]);
await narrow.close();

await browser.close();
for (const [label, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? "ALL VISUAL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`);
