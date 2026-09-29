// 探查 mock 网关：项目A 的 mock 连接/资源，并尝试经领域入口 delegate（DELEGATE_AI 任务 T6）。
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const uuid = () => crypto.randomUUID();
const projAId = "4254461d-c6e2-4b08-8ce9-679d3b8393f3";

const conns = await (await fetch(`${W}/projects/${projAId}/gateway-connections`, { headers: H })).json();
console.log("gateway-connections:", JSON.stringify(conns).slice(0, 500));
const resources = await (await fetch(`${W}/projects/${projAId}/managed-resources`, { headers: H })).json();
console.log("managed-resources:", JSON.stringify(resources).slice(0, 500));

// 建 DELEGATE_AI 任务 T6 并尝试 delegate（不带 mock 动作，先看错误面）
const t6res = await fetch(`${W}/tasks`, { method: "POST", headers: H, body: JSON.stringify({
  command_id: uuid(), project_id: projAId, title: "UI取证-20260929 委托任务T6", objective: "用于 Run 状态取证的委托任务。",
  mode: "DELEGATE_AI", criteria: [{ statement: "取证标准：Run 状态可追溯" }] }) });
const t6body = await t6res.json();
const t6 = t6body.result?.task_id;
console.log("T6:", t6res.status, t6);
await fetch(`${W}/tasks/${t6}/ready`, { method: "POST", headers: H, body: JSON.stringify({ command_id: uuid(), expected_revision: t6body.result?.revision }) });
const d = await fetch(`${W}/tasks/${t6}/delegations`, { method: "POST", headers: H, body: JSON.stringify({ command_id: uuid(), expected_task_revision: "1" }) });
console.log("delegate(no mock):", d.status, (await d.text()).slice(0, 400));
await browser.close();
