// 工作主线对齐取样：只读夹具 + 页面内拦截，不连数据库、不调用 Provider、不提交业务命令。
// 用法：npx playwright test --config scripts/playwright.ui-align.config.ts
// 输出：output/acceptance-raw/ui-align-20261001/<视口>/ 与同目录 ui-align-layout.json
import { mkdirSync, writeFileSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { workspaceId, taskId, prefix, bodies, docBody, artifacts } from "./collab-visual-fixtures.mjs";

const outRoot = "D:/Develop/Relay-Agent/output/acceptance-raw/ui-align-20261001";
const viewports = [
  { name: "1487x1058", width: 1487, height: 1058 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "960x640", width: 960, height: 640 },
  { name: "390x844", width: 390, height: 844 }
];

const measurements: Record<string, unknown>[] = [];

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
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
    if (path === `${prefix}/artifact-versions/v-artifact-current`) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(artifacts.items[0]) });
    }
    if (path.includes("/trace")) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", detail: "Trace 暂不可读" }) });
    if (path.includes("/check-plan")) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", detail: "预览不可读" }) });
    if (path.startsWith(`${prefix}/search`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null }) });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", detail: path }) });
  });
  await page.goto(`/agent?work=${taskId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill("http://127.0.0.1:8787");
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill("ui-align-readonly-token");
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("collab-goal").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
}

function probe() {
  const height = (selector: string) => {
    const element = document.querySelector(selector);
    return element ? Math.round(element.getBoundingClientRect().height) : null;
  };
  const children = (selector: string) => {
    const element = document.querySelector(selector);
    return element ? [...element.children].map((node) => ({
      node: node.nodeName.toLowerCase() + (typeof node.className === "string" && node.className.trim()
        ? "." + node.className.trim().split(/\s+/).join(".") : ""),
      height: Math.round(node.getBoundingClientRect().height)
    })) : [];
  };
  const textarea = document.querySelector<HTMLTextAreaElement>(".agent-chat-composer textarea");
  const textareaStyle = textarea ? getComputedStyle(textarea) : null;
  const posts = performance.getEntriesByType("resource")
    .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === "xmlhttprequest");
  return {
    collabGoal: height("[data-testid='collab-goal']"),
    chatTranscript: height(".agent-chat-transcript"),
    composer: height(".agent-chat-composer"),
    readerScroll: height(".collab-reader-scroll"),
    judgment: height("[data-testid='collab-judgment']"),
    documentHeading: height(".collab-reader .artifact-doc-heading"),
    paper: height(".collab-document-paper"),
    sideBody: height(".collab-side-body[data-testid='collab-panel-DOCUMENT']"),
    textareaBorder: textareaStyle ? textareaStyle.borderTopWidth + " " + textareaStyle.borderTopStyle : null,
    goalChildren: children(".collab-goal .page-head-main"),
    composerTools: children(".agent-chat-composer-tools"),
    judgmentMainChildren: children("[data-testid='collab-judgment'] .judgment-bar-main"),
    rootScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    posts: posts.length
  };
}

test("协作工作区与效果图对齐取样", async ({ page }) => {
  for (const viewport of viewports) {
    const dir = `${outRoot}/${viewport.name}`;
    mkdirSync(dir, { recursive: true });
    await open(page, viewport.width, viewport.height);
    await page.screenshot({ path: `${dir}/collaboration.png` });
    measurements.push({ viewport: viewport.name, ...(await page.evaluate(probe)) });
  }

  // 「更多操作」浮层单独取一张：确认次级动作不改变页头高度。
  await open(page, 1487, 1058);
  await page.getByLabel("更多操作").dispatchEvent("click");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outRoot}/1487x1058/collaboration-more-open.png` });
  measurements.push({ viewport: "1487x1058-more-open", ...(await page.evaluate(() => ({
    moreOpen: document.querySelector(".page-head-more")?.hasAttribute("open") ?? false,
    moreLabels: [...document.querySelectorAll(".page-head-more-panel button")]
      .map((node) => node.textContent?.trim() ?? ""),
    goalHeight: Math.round(document.querySelector("[data-testid='collab-goal']")!.getBoundingClientRect().height),
    posts: performance.getEntriesByType("resource")
      .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === "xmlhttprequest").length
  }))) });

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(`${outRoot}/ui-align-layout.json`, JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify(measurements, null, 2));
});

// 六类普通页面的标题字号：只读示例模式，无连接、无业务写入。
// 量的是「实际渲染出来的 px」而不是 CSS 里的 token 名，避免改 token 后各处降级不一致。
test("普通页面标题与区域标题字号取样", async ({ page }) => {
  const routes = ["/today", "/projects", "/tasks", "/knowledge", "/reviews", "/settings", "/connections", "/activity"];
  const rows: Record<string, unknown>[] = [];
  mkdirSync(`${outRoot}/ordinary-1280x720`, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 720 });
    for (const route of routes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);
      const row = await page.evaluate(() => {
        const px = (selector: string) => {
          const element = document.querySelector(selector);
          return element ? getComputedStyle(element).fontSize : null;
        };
        return {
          h1: px("h1"),
          section: px("h2"),
          rootScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth
        };
      });
      rows.push({ route, width, ...row });
      if (width === 1280) {
        await page.screenshot({ path: `${outRoot}/ordinary-1280x720/${route.replace(/\//g, "") || "root"}.png` });
      }
    }
  }
  writeFileSync(`${outRoot}/ui-align-ordinary-type.json`, JSON.stringify(rows, null, 2));
  for (const row of rows) {
    console.log(`${row.width}px  ${row.route}  h1=${row.h1}  h2=${row.section}  scrollW=${row.rootScrollWidth}/${row.viewportWidth}`);
  }
});

// 共享壳栏位分离与聊天任务头：只用真实 Tab/Enter 路径，不直接调用组件方法。
// 记录两列实际栏宽、近期工作选中态、完整名称入口的可达性，以及窄窗是否退回抽屉。
test("共享壳两列与完整名称键盘入口取样", async ({ page }) => {
  const rows: Record<string, unknown>[] = [];
  mkdirSync(`${outRoot}/shell-columns`, { recursive: true });
  for (const viewport of [{ name: "1487x1058", width: 1487, height: 1058 }, { name: "1280x720", width: 1280, height: 720 }]) {
    await open(page, viewport.width, viewport.height);
    await page.screenshot({ path: `${outRoot}/shell-columns/${viewport.name}.png` });
    rows.push({ viewport: viewport.name, ...(await page.evaluate(() => {
      const width = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? Math.round(element.getBoundingClientRect().width) : null;
      };
      const handle = document.querySelector('[data-testid="sidebar-resize-handle"]') as HTMLElement | null;
      return {
        navRail: width(".app-navrail"),
        contextRail: width(".app-context-rail"),
        content: width(".app-content"),
        railVisible: getComputedStyle(document.querySelector(".app-navrail")!).display !== "none",
        resizeHandleLeft: handle ? Math.round(handle.getBoundingClientRect().left) : null,
        activeRecentWork: document.querySelector(".recent-work-item--active")?.textContent ?? null,
        // 拖拽分隔条必须落在两列之间，而不是页面最左或内容中间。
        handleOnRailEdge: handle
          ? Math.abs(handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2
            - (document.querySelector(".app-navrail")!.getBoundingClientRect().width
              + document.querySelector(".app-context-rail")!.getBoundingClientRect().width)) < 14
          : null,
        rootScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      };
    })) });
  }

  // 完整名称：Tab 能走到标题链接并显示焦点，Enter 进入确切任务页。
  await open(page, 1280, 720);
  await page.getByTestId("collab-page-head-title-link").focus();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  const linkName = await page.getByTestId("collab-page-head-title-link").evaluate((node) => ({
    text: node.textContent, href: node.getAttribute("href")
  }));
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/tasks\//, { timeout: 15_000 });
  const landed = new URL(page.url()).pathname;
  rows.push({ keyboardNameEntry: { focused, ...linkName, landed } });

  // 窄窗：两列收起，导航与近期工作改由抽屉承担。
  await open(page, 960, 640);
  rows.push({ narrow: await page.evaluate(() => ({
    navRail: getComputedStyle(document.querySelector(".app-navrail")!).display,
    contextRail: getComputedStyle(document.querySelector(".app-context-rail")!).display,
    rootScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  })) });
  await page.getByLabel("打开导航").click();
  await page.waitForTimeout(300);
  rows.push({ narrowDrawer: await page.evaluate(() => ({
    completeNav: document.querySelectorAll('nav[aria-label="完整导航"] a').length,
    recentWork: document.querySelectorAll('[data-testid^="recent-work-"]').length
  })) });

  writeFileSync(`${outRoot}/ui-align-shell.json`, JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows, null, 2));
});