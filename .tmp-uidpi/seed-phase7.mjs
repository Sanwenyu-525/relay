// UI-18 数据：对真实 Run 8d19e398 提交 PENDING 暂停请求（领域入口，不触 worker 执行路径）。
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const runId = "8d19e398-b5f7-4a04-8735-4d2832ea17c6";
const run = await (await fetch(`${W}/runs/${runId}`, { headers: H })).json();
console.log("run status:", run.status, "run rev:", run.revision, "task:", run.task_id);
const task = await (await fetch(`${W}/tasks/${run.task_id}`, { headers: H })).json();
const res = await fetch(`${W}/runs/${runId}/control-requests`, { method: "POST", headers: H, body: JSON.stringify({
  command_id: crypto.randomUUID(),
  expected_task_revision: task.revision,
  expected_run_revision: run.revision,
  type: "PAUSE" }) });
console.log("control-requests:", res.status, (await res.text()).slice(0, 300));
await browser.close();
