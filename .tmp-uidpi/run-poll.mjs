// 轮询 Run 8d19e398 至终态或暂停/待审批，输出步骤与控制请求。
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}` };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const runId = "8d19e398-b5f7-4a04-8735-4d2832ea17c6";
let last = "";
for (let i = 0; i < 60; i++) {
  const run = await (await fetch(`${W}/runs/${runId}`, { headers: H })).json();
  const line = JSON.stringify({ status: run.status, phase: run.current_phase ?? run.phase, pending: run.pending_operation_id ?? null, control: run.control_state ?? null });
  if (line !== last) { console.log(`[${i}s]`, line.slice(0, 250)); last = line; }
  if (["COMPLETED", "FAILED", "CANCELLED", "PAUSED", "UNKNOWN"].includes(run.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const run = await (await fetch(`${W}/runs/${runId}`, { headers: H })).json();
console.log("run full:", JSON.stringify(run).slice(0, 1200));
const trace = await (await fetch(`${W}/runs/${runId}/trace`, { headers: H })).json();
console.log("trace:", JSON.stringify(trace).slice(0, 800));
const reviews = await (await fetch(`${W}/reviews?status=OPEN`, { headers: H })).json();
console.log("reviews OPEN:", JSON.stringify(reviews).slice(0, 600));
await browser.close();
