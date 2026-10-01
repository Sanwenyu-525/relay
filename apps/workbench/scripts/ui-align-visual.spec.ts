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