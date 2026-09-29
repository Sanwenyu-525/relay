// UI-26 补做：重开 T2 → 制造真实 409（API 推进 revision → UI 保存冲突）→ 复截；同时截重开后的任务详情。
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
const OUT = "D:/Develop/Relay-Agent/docs/testing/evidence/ui-dpi-2026-09-29/matrix";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const T2 = "21071df6-b10b-487a-b62b-1645e4e0df5f";
const rev = async () => (await (await fetch(`${W}/tasks/${T2}`, { headers: H })).json()).revision;

// 1. 重开（领域入口；仅当 DONE 时需要）
let r = await fetch(`${W}/tasks/${T2}/reopen`, { method: "POST", headers: H, body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: await rev(), reason: "UI取证-20260929 重开以复现版本冲突" }) });
console.log("reopen:", r.status, (await r.text()).slice(0, 150));
console.log("status now:", (await (await fetch(`${W}/tasks/${T2}`, { headers: H })).json()).status);
// 重开后 READY，需 start 进入 IN_PROGRESS 才能存产物
await fetch(`${W}/tasks/${T2}/start`, { method: "POST", headers: H, body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: await rev() }) });
console.log("status after start:", (await (await fetch(`${W}/tasks/${T2}`, { headers: H })).json()).status);

const results = [];
async function shot(id, note) {
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    return { hOverflow: de.scrollWidth > de.clientWidth + 1, errs: [...document.querySelectorAll(".action-error")].map((e) => e.textContent?.trim().slice(0, 160)), h1: document.querySelector("h1")?.textContent?.trim() };
  });
  const path = `${OUT}/${id}-1280x800.png`;
  await page.screenshot({ path });
  results.push({ id, note, ...m, screenshot: path });
  console.log(`OK ${id} errs=${m.errs.length} | ${note}`);
}

// 2. 进入产物页，载入草稿
await page.goto(`http://tauri.localhost/tasks/${T2}?tab=artifacts`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-service-connecting"]'), { timeout: 20000 });
await page.getByTestId("artifact-editor").waitFor({ timeout: 15000 });
await page.getByTestId("artifact-load-latest-draft").click();
await page.getByTestId("artifact-draft-base").waitFor({ timeout: 10000 });
await page.locator('textarea[name="artifact-content"]').fill("# UI取证-20260929 冲突草稿\n\n该草稿在基线推进后保存，产生真实 409 REVISION_CONFLICT。");
// 3. 经真实领域入口推进 revision（priority 设置）
r = await fetch(`${W}/tasks/${T2}/planning-metadata`, { method: "POST", headers: H, body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: await rev(), priority: "HIGH", due_local_date: null, timezone: null }) });
console.log("planning-metadata(priority):", r.status, (await r.text()).slice(0, 120));
// 4. UI 保存 → 409
await page.getByTestId("artifact-save").click();
await page.locator('[data-testid="artifact-editor"] .action-error, [data-testid="artifact-draft-base-changed"]').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(900);
await shot("UI-26", "真实409冲突：草稿保留+基线变化提示");
await shot("UI-26b", "冲突后重取事实区（版本列表）");
writeFileSync(`${OUT}/ui26-retry-log.json`, JSON.stringify(results, null, 2));
await browser.close();
