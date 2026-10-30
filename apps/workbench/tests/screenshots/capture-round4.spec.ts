import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-screenshots-2026-10-11";
const ENV_PATH = "D:/Develop/Relay-Agent/apps/api/.env";
const SESSION_PATH = "D:/Develop/Relay-Agent/.relay-test/session.json";
const IDS = JSON.parse(fs.readFileSync(path.join(OUT, "_deep-link-seed-ids.json"), "utf8").replace(/^\uFEFF/, "")) as {
  layoutTaskId: string; runId: string; completionId: string; artifactVersionId: string; projectId: string;
};
const LIVE_PROJECT = IDS.projectId;

test.use({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

function readLiveCreds() {
  const envText = fs.readFileSync(ENV_PATH, "utf8");
  const token = /RELAY_API_BEARER_TOKEN=(.+)/.exec(envText)?.[1]?.trim();
  const sessionRaw = fs.readFileSync(SESSION_PATH, "utf8").replace(/^\uFEFF/, "");
  const workspaceId = (JSON.parse(sessionRaw) as { workspace_id: string }).workspace_id;
  return { baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: token! };
}

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
  await page.waitForTimeout(350);
  const file = path.join(OUT, `${name}.png`);
  const buf = await page.screenshot({ fullPage: false, type: "png" });
  const hash = md5(buf);
  const dup = hashes.get(hash);
  if (dup && dup !== `${name}.png`) {
    console.log(`SKIP_DUP ${name}.png == ${dup}`);
    return false;
  }
  fs.writeFileSync(file, buf);
  hashes.set(hash, `${name}.png`);
  console.log(`SAVED ${name}.png`);
  return true;
}

async function connectLive(page: Page) {
  const creds = readLiveCreds();
  await page.goto("/agent", { waitUntil: "domcontentloaded" });
  // Already connected? skip dialog.
  const connected = page.getByTestId("relay-connection-state").filter({ hasText: /已连接/ });
  if (await connected.count()) return;
  await page.getByTestId("relay-connection-open").click({ timeout: 10000 });
  await page.locator('input[name="relay-base-url"]').fill(creds.baseUrl);
  await page.locator('input[name="relay-workspace-id"]').fill(creds.workspaceId);
  await page.locator('input[name="relay-bearer-token"]').fill(creds.bearerToken);
  await page.getByTestId("relay-connect").click();
  await connected.first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
}

test("round4 unblocked gaps", async ({ page }) => {
  const hashes = existingHashes();
  const saved: string[] = [];
  const skip: string[] = [];
  const record = async (name: string) => {
    if (await shot(page, name, hashes)) saved.push(name); else skip.push(name);
  };

  await connectLive(page);

  // 1) Layout modes
  await page.goto(`/agent?work=${IDS.layoutTaskId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await page.locator("details.page-head-more > summary").click().catch(() => {});
  await page.waitForTimeout(250);
  for (const mode of ["split", "chat", "result"] as const) {
    const btn = page.getByTestId(`collab-layout-${mode}`);
    if (await btn.count()) {
      await btn.click({ force: true });
      await record(`agent-layout-${mode}`);
    } else {
      console.log(`MISSING collab-layout-${mode}`);
    }
  }

  // 2) Deep links
  await page.goto(`/runs/${IDS.runId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await record("run-detail-live");

  await page.goto(`/completion-records/${IDS.completionId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await record("completion-record-live");

  await page.goto(`/artifact-versions/${IDS.artifactVersionId}/lineage`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await record("artifact-lineage-live");

  // 3) Activity filter (live)
  await page.goto("/activity", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.locator('[data-testid="activity-advanced-filter"] > summary').click().catch(() => {});
  await page.waitForTimeout(200);
  await page.getByTestId("activity-project-filter").click().catch(() => {});
  await record("activity-filter-open-live");

  // 4) Knowledge tabs (live project)
  await page.goto(`/projects/${LIVE_PROJECT}/knowledge`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await record("projects-live-knowledge-base");
  for (const kind of ["MEMORY", "DECISION", "RULE"] as const) {
    await page.getByTestId(`knowledge-tab-${kind}`).click().catch(() => {});
    await page.waitForTimeout(400);
    await record(`projects-live-knowledge-${kind.toLowerCase()}`);
  }

  // 5) Create project type radios
  await page.goto("/projects?view=create", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.locator('input[name="project-type"][value="THESIS"]').click({ force: true }).catch(async () => {
    await page.getByText("论文", { exact: true }).click().catch(() => {});
  });
  await record("projects-create-type-thesis");

  // 6) Folder AppDialog + manual path (browser; not OS dialog)
  await page.goto("/agent", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.getByTestId("folder-scope-change").click().catch(() => {});
  await page.waitForTimeout(400);
  const manual = page.getByTestId("folder-manual-root");
  if (await manual.count()) {
    await manual.fill("D:\\Develop\\Relay-Agent");
    await record("agent-folder-manual-path");
  } else {
    await record("agent-folder-change-dialog");
  }

  console.log(JSON.stringify({ saved, skip, savedCount: saved.length, skipCount: skip.length }, null, 2));
  expect(saved.length + skip.length).toBeGreaterThan(0);
});