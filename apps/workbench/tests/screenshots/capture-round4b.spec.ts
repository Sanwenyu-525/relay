import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = "D:/Develop/Relay-Agent/ui-screenshots-2026-10-11";
const ENV_PATH = "D:/Develop/Relay-Agent/apps/api/.env";
const SESSION_PATH = "D:/Develop/Relay-Agent/.relay-test/session.json";
const IDS = JSON.parse(
  fs.readFileSync(path.join(OUT, "_deep-link-seed-ids.json"), "utf8").replace(/^\uFEFF/, ""),
) as { layoutTaskId: string; projectId: string };

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

function md5(buf: Buffer) { return crypto.createHash("md5").update(buf).digest("hex"); }
function existingHashes(): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of fs.readdirSync(OUT)) {
    if (!name.endsWith(".png")) continue;
    map.set(md5(fs.readFileSync(path.join(OUT, name))), name);
  }
  return map;
}
async function shot(page: Page, name: string, hashes: Map<string, string>) {
  await page.waitForTimeout(400);
  const buf = await page.screenshot({ fullPage: false, type: "png" });
  const hash = md5(buf);
  const dup = hashes.get(hash);
  if (dup && dup !== `${name}.png`) { console.log(`SKIP_DUP ${name}.png == ${dup}`); return false; }
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  hashes.set(hash, `${name}.png`);
  console.log(`SAVED ${name}.png`);
  return true;
}

async function forceConnect(page: Page) {
  const envText = fs.readFileSync(ENV_PATH, "utf8");
  const token = /RELAY_API_BEARER_TOKEN=(.+)/.exec(envText)?.[1]?.trim()!;
  const workspaceId = (JSON.parse(fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, "")) as { workspace_id: string }).workspace_id;
  await page.goto("/agent", { waitUntil: "domcontentloaded" });
  await page.getByTestId("relay-connection-open").click({ timeout: 10000 });
  await page.locator('input[name="relay-base-url"]').fill("http://127.0.0.1:8787");
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(token);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: /已连接/ }).first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

test("round4b layout activity folder", async ({ page }) => {
  const hashes = existingHashes();
  await forceConnect(page);

  // Layout
  await page.goto(`/agent?work=${IDS.layoutTaskId}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("collab-goal").or(page.getByTestId("collab-page-head")).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const ids = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")));
  fs.writeFileSync(path.join(OUT, "_round4b-agent-work-testids.json"), JSON.stringify(ids, null, 2));
  console.log("has_layout_btn=" + ids.some((id) => id?.startsWith("collab-layout-")));
  console.log("has_fixture_gap=" + ids.includes("collab-fixture-gap"));
  // Open more menu via accessible name
  const more = page.locator("details.page-head-more");
  if (await more.count()) {
    await more.locator("summary").click({ force: true });
    await page.waitForTimeout(300);
  } else {
    await page.getByRole("button", { name: /更多操作/ }).click().catch(() => {});
  }
  for (const mode of ["split", "chat", "result"] as const) {
    const btn = page.getByTestId(`collab-layout-${mode}`);
    console.log(`layout_${mode}_count=${await btn.count()}`);
    if (await btn.count()) {
      await btn.click({ force: true });
      await shot(page, `agent-layout-${mode}`, hashes);
    }
  }
  // Fallback: if buttons missing, still capture the work-associated agent page
  if (!(await page.getByTestId("collab-layout-split").count())) {
    await shot(page, "agent-work-task-associated", hashes);
  }

  // Activity filter with applied project
  await page.goto("/activity", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const details = page.locator('[data-testid="activity-advanced-filter"]');
  await details.locator("summary").click().catch(() => {});
  await page.waitForTimeout(300);
  const select = page.getByTestId("activity-project-filter");
  if (await select.count()) {
    const options = await select.locator("option").allTextContents();
    console.log("activity_options=" + JSON.stringify(options.slice(0, 5)));
    // pick first real project option if any
    const values = await select.locator("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    const projectValue = values.find((v) => v && v !== "" && v !== "__manual__");
    if (projectValue) {
      await select.selectOption(projectValue);
      await page.getByRole("button", { name: "应用筛选" }).click();
      await page.waitForTimeout(800);
    }
  }
  await shot(page, "activity-filter-applied-live", hashes);

  // Folder dialog under live
  await forceConnect(page);
  await page.goto("/agent", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.getByTestId("folder-scope-change").click({ timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "agent-folder-change-dialog-live", hashes);
  const manual = page.getByTestId("folder-manual-root");
  console.log("manual_count=" + (await manual.count()));
  if (await manual.count()) {
    await manual.fill("D:\\Develop\\Relay-Agent");
    await shot(page, "agent-folder-manual-path", hashes);
  }
  // Native picker button state
  const openFolder = page.getByTestId("collab-open-folder");
  if (await openFolder.count()) {
    console.log("open_folder_disabled=" + (await openFolder.isDisabled()));
    await shot(page, "agent-folder-open-button-state", hashes);
  }

  expect(true).toBeTruthy();
});