import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = "D:/Develop/Relay-Agent/ui-screenshots-2026-10-11";
const ENV_PATH = "D:/Develop/Relay-Agent/apps/api/.env";
const SESSION_PATH = "D:/Develop/Relay-Agent/.relay-test/session.json";
const IDS = JSON.parse(
  fs.readFileSync(path.join(OUT, "_deep-link-seed-ids.json"), "utf8").replace(/^\uFEFF/, ""),
) as { layoutTaskId: string; projectId: string; runId: string; completionId: string; artifactVersionId: string };

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

function md5(buf: Buffer) { return crypto.createHash("md5").update(buf).digest("hex"); }
function hashes(): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of fs.readdirSync(OUT)) {
    if (!name.endsWith(".png")) continue;
    map.set(md5(fs.readFileSync(path.join(OUT, name))), name);
  }
  return map;
}
async function shot(page: Page, name: string, map: Map<string, string>) {
  await page.waitForTimeout(400);
  const buf = await page.screenshot({ fullPage: false, type: "png" });
  const h = md5(buf);
  const dup = map.get(h);
  if (dup && dup !== `${name}.png`) { console.log(`SKIP_DUP ${name}.png == ${dup}`); return false; }
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
  map.set(h, `${name}.png`);
  console.log(`SAVED ${name}.png`);
  return true;
}

/** Connect without navigating away — live credentials are memory-only. */
async function connectHere(page: Page) {
  const envText = fs.readFileSync(ENV_PATH, "utf8");
  const token = /RELAY_API_BEARER_TOKEN=(.+)/.exec(envText)?.[1]?.trim()!;
  const workspaceId = (JSON.parse(fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, "")) as { workspace_id: string }).workspace_id;
  const already = page.getByTestId("relay-connection-state").filter({ hasText: /已连接/ });
  if (await already.count()) return;
  await page.getByTestId("relay-connection-open").click({ timeout: 10000 });
  await page.locator('input[name="relay-base-url"]').fill("http://127.0.0.1:8787");
  await page.locator('input[name="relay-workspace-id"]').fill(workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(token);
  await page.getByTestId("relay-connect").click();
  await already.first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

test("round4c stay-on-page live shots", async ({ page }) => {
  const map = hashes();

  // Layout: land on work URL first, then connect in place
  await page.goto(`/agent?work=${IDS.layoutTaskId}`, { waitUntil: "domcontentloaded" });
  await connectHere(page);
  await page.getByTestId("collab-goal").or(page.getByTestId("collab-page-head")).first().waitFor({ timeout: 25000 });
  await page.waitForTimeout(600);
  const ids = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")));
  fs.writeFileSync(path.join(OUT, "_round4c-layout-testids.json"), JSON.stringify(ids, null, 2));
  console.log("fixture_gap=" + ids.includes("collab-fixture-gap") + " layout_btns=" + ids.filter((x) => x?.startsWith("collab-layout-")).join(","));

  const more = page.locator("details.page-head-more > summary");
  if (await more.count()) await more.click({ force: true });
  await page.waitForTimeout(250);
  for (const mode of ["split", "chat", "result"] as const) {
    const btn = page.getByTestId(`collab-layout-${mode}`);
    console.log(`count_${mode}=${await btn.count()}`);
    if (await btn.count()) {
      await btn.click({ force: true });
      await shot(page, `agent-layout-${mode}`, map);
    }
  }

  // Folder dialog: connect on /agent then open — no further goto
  await page.goto("/agent", { waitUntil: "domcontentloaded" });
  await connectHere(page);
  await page.getByTestId("folder-scope-change").click({ timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "agent-folder-change-dialog-live", map);
  const manual = page.getByTestId("folder-manual-root");
  console.log("manual=" + (await manual.count()) + " openDisabled=" + (await page.getByTestId("collab-open-folder").isDisabled().catch(() => null)));
  if (await manual.count()) {
    await manual.fill("D:\\Develop\\Relay-Agent");
    await shot(page, "agent-folder-manual-path", map);
  }

  // Activity with applied filter — connect first on page
  await page.goto("/activity", { waitUntil: "domcontentloaded" });
  await connectHere(page);
  await page.waitForTimeout(700);
  await page.locator('[data-testid="activity-advanced-filter"] > summary').click().catch(() => {});
  const select = page.getByTestId("activity-project-filter");
  if (await select.count()) {
    const values = await select.locator("option").evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    const projectValue = values.find((v) => v && v !== "" && v !== "__manual__");
    console.log("activity_project=" + projectValue);
    if (projectValue) {
      await select.selectOption(projectValue);
      await page.getByRole("button", { name: "应用筛选" }).click();
      await page.waitForTimeout(900);
    }
  }
  await shot(page, "activity-filter-applied-live", map);

  // Knowledge MEMORY tab after in-place connect
  await page.goto(`/projects/${IDS.projectId}/knowledge?kind=MEMORY`, { waitUntil: "domcontentloaded" });
  await connectHere(page);
  await page.waitForTimeout(800);
  await page.getByTestId("knowledge-tab-MEMORY").click().catch(() => {});
  await shot(page, "projects-live-knowledge-memory", map);

  expect(true).toBeTruthy();
});