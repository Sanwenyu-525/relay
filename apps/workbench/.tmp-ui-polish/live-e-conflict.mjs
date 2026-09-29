// Live 状态页对照 E：版本冲突（UI-26）。UI 建 v1 → 并发写手推进两个版本 → UI 保存吃 409。
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const out = "D:/Develop/Relay-Agent/.tmp-ui-replica/live/";
mkdirSync(out, { recursive: true });
const envText = readFileSync("D:/Develop/Relay-Agent/apps/api/.env", "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const taskId = process.argv[2] ?? "0535f05e-577f-4910-ad9a-096746de4115";
const bearer = env.RELAY_API_BEARER_TOKEN;
const root = `http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}/api/v1/workspaces/11111111-1111-4111-8111-111111111111`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1487, height: 1058 }, deviceScaleFactor: 1 });

async function liveGoto(path) {
  await page.goto(`http://127.0.0.1:5173${path}`, { waitUntil: "networkidle" });
  await page.getByTestId("relay-connection-open").click();
  await page.locator('input[name="relay-base-url"]').fill(`http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`);
  await page.locator('input[name="relay-workspace-id"]').fill("11111111-1111-4111-8111-111111111111");
  await page.locator('input[name="relay-bearer-token"]').fill(bearer);
  await page.getByTestId("relay-connect").click();
  await page.getByTestId("relay-connection-state").filter({ hasText: "已连接" }).waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
}

await liveGoto(`/tasks/${taskId}`);
await page.getByRole("button", { name: "产物" }).click().catch(() => {});
await page.getByTestId("artifact-editor").waitFor({ timeout: 15000 });
if ((await page.locator('input[name="artifact-title"]').getAttribute("disabled")) === null) await page.locator('input[name="artifact-title"]').fill("论证修订笔记");
await page.locator('textarea[name="artifact-content"]').fill("# 论证修订笔记\n\n第一轮人工草稿：补充第二章的论证结构与引用依据。");
await page.getByTestId("artifact-save").click();
await page.getByTestId("artifact-save-receipt").waitFor({ timeout: 20000 });
console.log("v1 saved via UI");
await page.waitForTimeout(800);

// 另一写手：直接推进两个版本（真实命令，模拟并发修改）
const bumped = await page.evaluate(async ({ root, bearer, taskId }) => {
  const headers = { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json", "Origin": "http://127.0.0.1:5173" };
  const art = await (await fetch(`${root}/tasks/${taskId}/artifacts`, { headers })).json();
  const artifactId = art.items[0].id;
  const task = await (await fetch(`${root}/tasks/${taskId}`, { headers })).json();
  let artifactRevision = String(art.items[0].revision);
  let taskRevision = String(task.revision);
  const results = [];
  for (const text of ["# 论证修订笔记\n\n并发写手 v2：补充引用一致性检查。", "# 论证修订笔记\n\n并发写手 v3：按最新验收版本调整措辞。"]) {
    taskRevision = String((await (await fetch(`${root}/tasks/${taskId}`, { headers })).json()).revision);
    const res = await fetch(`${root}/artifacts/${artifactId}/versions`, { method: "POST", headers,
      body: JSON.stringify({ command_id: crypto.randomUUID(), expected_artifact_revision: artifactRevision,
        expected_task_revision: taskRevision, media_type: "text/markdown", content: text }) });
    const body = await res.json();
    if (!res.ok) return { error: body };
    results.push(body.result);
    artifactRevision = String(body.result.artifact_revision ?? body.result.revision ?? artifactRevision);
  }
  return { artifactId, results };
}, { root, bearer, taskId });
console.log("bumped:", JSON.stringify(bumped).slice(0, 200));

// UI 保存：草稿基线仍是 v1 → 预期 409 冲突
await page.locator('textarea[name="artifact-content"]').fill("# 论证修订笔记\n\n第一轮人工草稿：补充第二章的论证结构与引用依据。\n\n（人工继续编辑这一行。）");
await page.getByTestId("artifact-save").click();
await page.locator("[data-testid='artifact-save-conflict'], .action-error, [data-testid='artifact-draft-base-changed']").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}UI26-version-conflict.png`, fullPage: true });
const conflictText = await page.getByText("草稿保留在编辑器里").count();
const baseChanged = await page.getByTestId("artifact-draft-base-changed").count();
console.log("conflict UI: error-text=", conflictText > 0, "base-changed=", baseChanged > 0);
await page.close();
await browser.close();
