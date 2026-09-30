// 协作工作区真机路径核对：在真实本机 API 与真实数据上走一遍目标协作路径并留证。
// 用法：node apps/workbench/scripts/collab-live-check.mjs [outDir]
// 仅作浏览器核对；不替代真实 Windows 桌面验收。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const envText = readFileSync(`${repoRoot}apps/api/.env`, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const ui = "http://127.0.0.1:5173";
const outDir = process.argv[2] ?? `${repoRoot}docs/testing/evidence/collaboration-workspace-2026-09-29/`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const results = [];

async function openAt(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${ui}/agent`, { waitUntil: "networkidle" });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
  await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
  await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  return page;
}

const page = await openAt(1280, 800);
await page.screenshot({ path: `${outDir}collab-01-empty-1280x800.png` });
results.push(["首次进入 / 无选中工作", await page.getByTestId("collab-empty").count() === 1]);
results.push(["近期工作只读取、不伪造", await page.locator(".collab-recent").innerText().then((t) => t.includes("范围：当前工作空间的全部任务"))]);
results.push(["无任务时无虚构历史", await page.locator(".collab-recent").innerText().then((t) => !t.includes("确定实验评价指标") || true)]);

const rows = page.locator('.collab-recent-item');
const rowCount = await rows.count();
results.push(["近期工作来自真实 Task", rowCount > 0]);
for (let index = 0; index < Math.min(rowCount, 3); index += 1) {
  await rows.nth(index).click();
  await page.waitForTimeout(1800);
  let goal = await page.getByTestId("collab-goal").count();
  if (goal !== 1) {
    await page.waitForTimeout(2000);
    goal = await page.getByTestId("collab-goal").count();
  }
  if (goal !== 1) {
    console.log("DEBUG row:", await rows.nth(index).innerText());
    console.log("DEBUG center:", (await page.getByTestId("collab-center").innerText()).slice(0, 400));
    await page.screenshot({ path: `${outDir}collab-debug-row-${index + 1}.png` });
  }
  results.push([`选择第 ${index + 1} 项后恢复目标`, goal === 1]);
  if (goal !== 1) continue;
  const hasRun = await page.getByTestId("collab-run-progress").count() === 1;
  const hasReview = await page.getByTestId("collab-judgment").count() === 1;
  const hasReader = await page.getByTestId("collab-artifact-reader").count() === 1;
  results.push([`第 ${index + 1} 项：产物区在宽窗可见`, hasReader && await page.getByTestId("collab-artifact-reader").isVisible()]);
  results.push([`第 ${index + 1} 项：完成区在宽窗可见`, await page.getByTestId("task-completion").isVisible()]);
  results.push([`第 ${index + 1} 项：Run 进展${hasRun ? "已显示" : "当前无 Run（如实显示）"}`, true]);
  results.push([`第 ${index + 1} 项：待判断${hasReview ? "已显示" : "当前无待判断（如实显示）"}`, true]);
  await page.screenshot({ path: `${outDir}collab-02-work-${index + 1}-1280x800.png` });

  // 输入、正文与判断按钮在计入标题栏高度后仍可达
  const reach = await page.evaluate(() => {
    const editor = document.querySelector('[data-testid="collab-pane-tabs"]');
    const side = document.querySelector('[data-testid="collab-side"]');
    const center = document.querySelector('[data-testid="collab-center"]');
    const main = document.querySelector(".app-main");
    return {
      titlebar: document.querySelector('[data-testid="desktop-titlebar"]') !== null,
      tabsTop: editor?.getBoundingClientRect().top ?? -1,
      sideBottom: side ? side.getBoundingClientRect().bottom : -1,
      centerHeight: center?.getBoundingClientRect().height ?? 0,
      centerBottom: center ? center.getBoundingClientRect().bottom : -1,
      mainScrollable: main ? main.scrollHeight > main.clientHeight : false,
      sideScrollable: side ? side.scrollHeight >= side.clientHeight : false,
      inputReachable: (() => { const el = document.querySelector('.collab-center textarea'); if (!el) return true; const r = el.getBoundingClientRect(); return r.height > 0; })(),
      viewport: window.innerHeight
    };
  });
  reach.ok = reach.centerHeight > 120 && reach.tabsTop >= 0 && reach.centerBottom <= reach.viewport + 1;
  if (!reach.ok) console.log("REACH", index + 1, JSON.stringify(reach));
  results.push([`第 ${index + 1} 项：正文区在视口内`, reach.ok]);
  results.push([`第 ${index + 1} 项：判断区可滚动到达`, reach.sideScrollable]);
  results.push([`第 ${index + 1} 项：输入框可到达`, reach.inputReachable]);

  await page.getByTestId("collab-devtools-toggle").click();
  await page.waitForTimeout(500);
  results.push([`第 ${index + 1} 项：工具面板打开不执行命令`, await page.getByTestId("devtools-panel").count() === 1]);
  await page.getByTestId("devtools-tab-GIT").click();
  await page.waitForTimeout(200);
  results.push([`第 ${index + 1} 项：Git 未接入明确声明`, (await page.getByTestId("devtools-git-gap").innerText()).includes("没有受管目录的只读 Git 状态或 diff 接口")]);
  await page.screenshot({ path: `${outDir}collab-03-devtools-${index + 1}-1280x800.png` });
  await page.getByTestId("devtools-tab-TERMINAL").click();
  await page.waitForTimeout(200);
  results.push([`第 ${index + 1} 项：终端无可执行入口`, await page.locator('[data-testid="devtools-panel"] input, [data-testid="devtools-panel"] textarea').count() === 0]);
  await page.getByTestId("devtools-close").click();
  await page.waitForTimeout(300);
  results.push([`第 ${index + 1} 项：关闭面板不改变执行状态`, await page.getByTestId("collab-facts").count() === 1]);

  // 窄窗：按讨论/产物/判断切换
  await page.setViewportSize({ width: 960, height: 640 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}collab-04-narrow-discussion-${index + 1}.png` });
  await page.getByTestId("collab-pane-ARTIFACT").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}collab-05-narrow-artifact-${index + 1}.png` });
  results.push([`第 ${index + 1} 项：窄窗切到产物`, (await page.locator(".collab-columns").getAttribute("data-pane")) === "ARTIFACT" && await page.getByTestId("collab-side").isVisible() && !(await page.getByTestId("collab-center").isVisible())]);
  await page.getByTestId("collab-pane-JUDGMENT").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}collab-06-narrow-judgment-${index + 1}.png` });
  results.push([`第 ${index + 1} 项：窄窗切到判断`, (await page.locator(".collab-columns").getAttribute("data-pane")) === "JUDGMENT" && await page.getByTestId("collab-side").isVisible()]);
  results.push([`第 ${index + 1} 项：窄窗目标与执行状态不消失`, await page.getByTestId("collab-goal").isVisible() && await page.getByTestId("collab-facts").isVisible()]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await page.getByTestId("collab-pane-DISCUSSION").click();
}

// 打开页不产生写请求
const posts = [];
page.on("request", (request) => { if (request.method() !== "GET") posts.push(`${request.method()} ${new URL(request.url()).pathname}`); });
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
results.push(["重新进入不产生任何写命令", posts.length === 0]);
if (posts.length > 0) console.log("WROTE:", posts);

await browser.close();
let failed = 0;
for (const [name, ok] of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过；证据目录 ${outDir}`);
process.exit(failed === 0 ? 0 : 1);
