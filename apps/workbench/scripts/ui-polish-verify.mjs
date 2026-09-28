// 今日页 UI 精修验证：同条件截图矩阵、量化样式指标与真实交互证据。
// 前置：标准开发环境已启动（apps/api/.env 的 API + Vite 5173），目标工作空间已初始化。
// 用法：node apps/workbench/scripts/ui-polish-verify.mjs before|after [interactions] [--workspace <id>] [--ui <base>]
// 输出：docs/testing/evidence/ui-live-integration-2026-09-28/today-polish/<phase>/
// 凭据只在页面内存使用，不写入截图、日志或本脚本输出。
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const phase = process.argv[2] ?? "after";
const doInteractions = process.argv.includes("interactions");
const emptyWorkspace = process.argv.includes("--workspace");
const wsIdx = process.argv.indexOf("--workspace");
const uiIdx = process.argv.indexOf("--ui");
const ui = uiIdx > -1 ? process.argv[uiIdx + 1] : "http://127.0.0.1:5173";
const workspaceId = wsIdx > -1 ? process.argv[wsIdx + 1] : "11111111-1111-4111-8111-111111111111";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const envText = readFileSync(`${repoRoot}apps/api/.env`, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const apiBase = `http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`;
const outDir = `${repoRoot}docs/testing/evidence/ui-live-integration-2026-09-28/today-polish/${phase}/`;
mkdirSync(outDir, { recursive: true });

const metrics = [];
const interactionLog = [];
const todayUrl = `${ui}/today`;

async function connect(page) {
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(apiBase);
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(env.RELAY_API_BEARER_TOKEN);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await page.locator("h1").first().waitFor();
}

async function collectMetrics(page, label) {
  const data = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const nav = document.querySelector(".navigation-label");
    const dateInput = document.querySelector('.today-query input[type="date"]');
    const eyebrow = document.querySelector(".eyebrow");
    const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
        width: Math.round(r.width), height: Math.round(r.height) }; };
    const styleOf = (el, props) => { if (!el) return null; const s = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])); };
    return {
      url: location.href, scrollY: window.scrollY,
      viewport: { w: innerWidth, h: innerHeight }, dpr: devicePixelRatio,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      docHeight: document.documentElement.scrollHeight,
      h1: { text: h1?.textContent ?? null, rect: rectOf(h1),
        style: styleOf(h1, ["font-size", "font-family", "line-height"]) },
      eyebrow: { rect: rectOf(eyebrow) },
      topbar: { rect: rectOf(document.querySelector(".app-topbar")) },
      navFont: styleOf(nav, ["font-family", "font-size"]),
      dateInput: { rect: rectOf(dateInput),
        style: styleOf(dateInput, ["font-family", "font-size", "height", "border"]) },
      groups: [...document.querySelectorAll(".today-group")].map((g) => ({
        heading: g.querySelector("h2")?.textContent ?? null,
        headingStyle: styleOf(g.querySelector("h2"), ["font-size", "font-family"]) })),
      focusPanel: { text: document.querySelector(".today-focus")?.textContent?.slice(0, 120) ?? null },
      demoNotice: { text: document.querySelector(".demo-notice")?.textContent ?? null },
      container: rectOf(document.querySelector(".today-page"))
    };
  });
  metrics.push({ label, ...data });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
await page.goto(todayUrl, { waitUntil: "networkidle" });
await connect(page);
await page.waitForTimeout(800);

// 1. 首次进入：标题完整可见（T01）
await page.screenshot({ path: `${outDir}/today-first-entry-1280.png` });
await collectMetrics(page, "first-entry-1280");

// 2. 滚动中部与底部（T09 底部提示、页长）
await page.mouse.wheel(0, 600); await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/today-scrolled-1280.png` });
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/today-bottom-1280.png` });
await collectMetrics(page, "bottom-1280");

// 3. 滚回顶部（T01）
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
await page.screenshot({ path: `${outDir}/today-back-to-top-1280.png` });

// 4. 工具条特写 + Tab 焦点（T04/T03）
const toolbar = page.locator(".today-query");
await toolbar.screenshot({ path: `${outDir}/today-toolbar.png` });
await page.keyboard.press("Tab");
await toolbar.screenshot({ path: `${outDir}/today-toolbar-focus.png` });
await collectMetrics(page, "toolbar-focus");

// 5. 窄窗 960×640（T10）
await page.setViewportSize({ width: 960, height: 640 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/today-960x640.png` });
await collectMetrics(page, "narrow-960");

// 6. 用户截图同量级宽窗 1536×832（1920 物理 @125%）（T10）
await page.setViewportSize({ width: 1536, height: 832 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/today-1536x832.png` });
await collectMetrics(page, "wide-1536");
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(300);

if (doInteractions) {
  const track = async (name, fn) => {
    try { await fn(); interactionLog.push({ name, ok: true }); }
    catch (error) { interactionLog.push({ name, ok: false, error: String(error).slice(0, 300) }); }
  };

  // I1 路由离开再返回：标题完整、scrollY=0（T01）
  await track("route-leave-return", async () => {
    await page.locator('.navigation-list a[href="/projects"]').click();
    await page.locator("h1").first().waitFor();
    await page.locator('.navigation-list a[href="/today"]').click();
    await page.locator("h1", { hasText: "把今天留给重要的事" }).waitFor();
    const scroll = await page.evaluate(() => window.scrollY);
    if (scroll !== 0) throw new Error(`scrollY after return = ${scroll}`);
    await page.screenshot({ path: `${outDir}/today-route-return-1280.png` });
  });

  // I2 非法时区就地报错且不覆盖已生效时区；合法时区应用后编辑区收起（T04）
  await track("timezone-invalid-then-valid", async () => {
    await page.getByRole("button", { name: "调整时区" }).click();
    await page.locator('.today-query input:not([type="date"])').fill("Not/AZone");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.locator(".today-query .action-error").waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${outDir}/today-timezone-invalid.png` });
    await page.locator('.today-query input:not([type="date"])').fill("Asia/Shanghai");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.locator(".today-query .action-error").waitFor({ state: "detached", timeout: 5000 });
    await page.locator(".today-query__editor").waitFor({ state: "detached", timeout: 5000 });
    await page.screenshot({ path: `${outDir}/today-timezone-applied.png` });
  });

  // I3 切换日期：眉线日期变化、分组随查询更新（T04）
  await track("date-switch", async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await page.locator('.today-query input[type="date"]').fill(tomorrow);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${outDir}/today-date-tomorrow.png` });
    await page.locator('.today-query input[type="date"]').fill(new Date().toISOString().slice(0, 10));
    await page.waitForTimeout(900);
  });

  // I4 刷新有反馈（T04）
  await track("refresh", async () => {
    await page.getByRole("button", { name: "刷新" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/today-refresh.png` });
  });

  if (!emptyWorkspace) {
    // I5 设为今日焦点 → 焦点卡显示任务名；清除回到空态（T06）
    await track("focus-set-clear", async () => {
      await page.getByRole("button", { name: "设为今日焦点" }).first().click();
      await page.locator('[data-testid="today-focus"] .today-focus__title a').waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${outDir}/today-focus-set.png` });
      await page.getByRole("button", { name: "清除今日焦点" }).first().click();
      await page.locator(".today-focus__empty").waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${outDir}/today-focus-cleared.png` });
    });

    // I6 置顶/取消置顶经真实 API 往返（文案与回执一致）
    await track("pin-toggle", async () => {
      await page.getByRole("button", { name: "置顶", exact: true }).first().click();
      await page.getByRole("button", { name: "取消置顶" }).first().waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${outDir}/today-pin-toggled.png` });
      await page.getByRole("button", { name: "取消置顶" }).first().click();
      await page.getByRole("button", { name: "置顶", exact: true }).first().waitFor({ timeout: 10000 });
    });
  } else {
    // I7 全空态主行动进入真实创建表单（T08）
    await track("empty-create-navigation", async () => {
      await page.locator('[data-testid="today-empty"] a', { hasText: "新建任务" }).click();
      await page.waitForURL("**/tasks?view=create**");
      await page.locator("h1", { hasText: "把想做的事" }).waitFor();
      await page.screenshot({ path: `${outDir}/today-empty-to-create.png` });
      await page.locator('.navigation-list a[href="/today"]').click();
      await page.locator("h1", { hasText: "把今天留给重要的事" }).waitFor();
    });
  }
}

await page.close();
await browser.close();
writeFileSync(`${outDir}metrics.json`, JSON.stringify(metrics, null, 2));
writeFileSync(`${outDir}interactions.json`, JSON.stringify(interactionLog, null, 2));
console.log(`phase=${phase} metrics=${metrics.length} interactions=${JSON.stringify(interactionLog)}`);
