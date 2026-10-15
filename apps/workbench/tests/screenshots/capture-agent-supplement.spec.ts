import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = "D:/Develop/Relay-Agent/ui-screenshots-2026-10-11";
const ENV_PATH = "D:/Develop/Relay-Agent/apps/api/.env";
const SESSION_PATH = "D:/Develop/Relay-Agent/.relay-test/session.json";
const LIVE_PROJECT = "b7b7a62e-ef45-4247-8ce2-5372d9f703dd";
/** From ui-screenshots-2026-10-11/_deep-link-seed-ids.json (screenshot-deep-link-seed). */
const LAYOUT_TASK = "a3e57735-932b-4b96-85a9-1ea90bb884f9";
const SEED_RUN = "0898fbbe-288a-493e-98ce-393ac4880ba9";
const SEED_COMPLETION = "820ca548-60f9-469b-8fe3-6bff8d9081bb";
const SEED_ARTIFACT_VERSION = "ecbe6fcf-5cbe-40fe-b31b-7be578f841fa";

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

function readLiveCreds() {
  const envText = fs.readFileSync(ENV_PATH, "utf8");
  const token = /RELAY_API_BEARER_TOKEN=(.+)/.exec(envText)?.[1]?.trim();
  const sessionRaw = fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, "");
  const workspaceId = (JSON.parse(sessionRaw) as { workspace_id: string }).workspace_id;
  return { baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: token! };
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

test("supplement live agent + project tabs", async ({ page }) => {
  const creds = readLiveCreds();
  await page.goto("/agent");
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(creds.baseUrl);
  await page.locator('input[name="relay-workspace-id"]').fill(creds.workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(creds.bearerToken);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: /已连接/ }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await page.goto("/agent");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);

  // Dump visible testids for debugging if needed
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).filter(Boolean)
  );
  fs.writeFileSync(path.join(OUT, "_agent-live-testids.json"), JSON.stringify(ids, null, 2));

  // Rail search
  const search = page.getByTestId("recent-work-search");
  if (await search.count()) {
    await search.fill("你好");
    await shot(page, "agent-rail-search");
    await search.fill("");
  }

  // Select session by text or testid prefix
  const byText = page.getByText("你好", { exact: false }).first();
  if (await byText.count()) {
    await byText.click().catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, "agent-session-selected");
  }

  // Discussion / source details in composer
  for (const label of ["资料", "普通讨论"]) {
    const summary = page.locator("summary").filter({ hasText: label }).first();
    if (await summary.count()) {
      await summary.click();
      await shot(page, label === "资料" ? "agent-source-dropdown-open" : "agent-discussion-dropdown-open");
      await summary.click().catch(() => {});
    }
  }

  // Composer fill + send hover
  const draft = page.locator('[data-testid="assist-draft"], [data-testid="assist-first-draft"], textarea').first();
  if (await draft.count()) {
    await draft.click();
    await draft.fill("截图用测试输入，请勿发送。");
    await shot(page, "agent-composer-filled");
  }
  const send = page.locator('[data-testid="assist-send"], [data-testid="assist-first-send"]').first();
  if (await send.count()) {
    await send.hover();
    await shot(page, "agent-send-hover");
  }
  const meter = page.getByTestId("assist-context-meter");
  if (await meter.count()) {
    await meter.hover();
    await shot(page, "agent-context-meter-hover");
  }

  // Layout modes require ?work=<taskId> and the page-head "更多操作" disclosure.
  await page.goto(`/agent?work=${LAYOUT_TASK}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
  await page.locator("details.page-head-more > summary").click().catch(() => {});
  await page.waitForTimeout(200);
  for (const mode of ["split", "chat", "result"] as const) {
    const btn = page.getByTestId(`collab-layout-${mode}`);
    if (await btn.count()) {
      await btn.click({ force: true });
      await shot(page, `agent-layout-${mode}`);
    }
  }

  // Deep-link pages from screenshot-deep-link-seed
  for (const [route, name] of [
    [`/runs/${SEED_RUN}`, "run-detail-live"],
    [`/completion-records/${SEED_COMPLETION}`, "completion-record-live"],
    [`/artifact-versions/${SEED_ARTIFACT_VERSION}/lineage`, "artifact-lineage-live"],
  ] as const) {
    await page.goto(route);
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, name);
  }

  // Directory picker (browser): AppDialog + manual path — not OS dialog
  await page.goto("/agent");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByTestId("folder-scope-change").click().catch(() => {});
  await page.waitForTimeout(300);
  const manual = page.getByTestId("folder-manual-root");
  if (await manual.count()) {
    await manual.fill("D:\\Develop\\Relay-Agent");
    await shot(page, "agent-folder-manual-path");
  } else {
    await shot(page, "agent-folder-change-dialog");
  }
  await page.keyboard.press("Escape");

  // Live project tabs by known id
  for (const [route, name] of [
    [`/projects/${LIVE_PROJECT}`, "projects-live-overview"],
    [`/projects/${LIVE_PROJECT}/tasks`, "projects-live-tasks"],
    [`/projects/${LIVE_PROJECT}/knowledge`, "projects-live-knowledge"],
    [`/projects/${LIVE_PROJECT}/knowledge?kind=MEMORY`, "projects-live-knowledge-memory"],
    [`/projects/${LIVE_PROJECT}/connections`, "projects-live-connections"],
    [`/projects/${LIVE_PROJECT}/workbench/general`, "projects-live-workbench-general"],
    [`/projects/${LIVE_PROJECT}/workbench/thesis`, "projects-live-workbench-thesis"],
    [`/projects/${LIVE_PROJECT}/workbench/development`, "projects-live-workbench-development"],
  ] as const) {
    await page.goto(route);
    await page.waitForLoadState("networkidle").catch(() => {});
    await shot(page, name);
  }

  expect(true).toBeTruthy();
});
