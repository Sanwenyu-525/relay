// 补齐：规则创建（排查 422）、artifact 版本结构检查、review-inbox/today 汇总。
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const uuid = () => crypto.randomUUID();

for (const [label, body] of [
  ["v1", { rule_key: "ui.forensic.1", statement: "UI取证-20260929 取证规则：保持正文可读。", strength: "HARD", enforcement: "BLOCK" }],
]) {
  const res = await fetch(`${W}/rules`, { method: "POST", headers: H, body: JSON.stringify({ command_id: uuid(), scope: "PROJECT", scope_id: "4254461d-c6e2-4b08-8ce9-679d3b8393f3", ...body }) });
  console.log("rules", label, res.status, (await res.text()).slice(0, 700));
}

const arts = await (await fetch(`${W}/tasks/21071df6-b10b-487a-b62b-1645e4e0df5f/artifacts`, { headers: H })).json();
console.log("taskArtifacts:", JSON.stringify(arts).slice(0, 600));

const reviews = await (await fetch(`${W}/review-inbox`, { headers: H })).json();
console.log("review-inbox:", JSON.stringify(reviews).slice(0, 400));

const today = await (await fetch(`${W}/today?date=${new Date().toISOString().slice(0, 10)}&timezone=Asia%2FShanghai`, { headers: H })).json();
console.log("today:", JSON.stringify(today).slice(0, 400));
await browser.close();
