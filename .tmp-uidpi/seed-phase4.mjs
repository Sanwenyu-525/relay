// 补齐：正确枚举创建规则；核对 /reviews?status=OPEN 与搜索接口。
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const uuid = () => crypto.randomUUID();

const ruleRes = await fetch(`${W}/rules`, { method: "POST", headers: H, body: JSON.stringify({
  command_id: uuid(), scope: "PROJECT", scope_id: "4254461d-c6e2-4b08-8ce9-679d3b8393f3",
  rule_key: "ui.forensic.readability", statement: "UI取证-20260929 取证规则：保持正文可读。",
  strength: "HARD", applicability: "AI_RUN", enforcement: "PRE_ACTION" }) });
console.log("rule:", ruleRes.status, (await ruleRes.text()).slice(0, 200));

const reviews = await (await fetch(`${W}/reviews?status=OPEN`, { headers: H })).json();
console.log("reviews OPEN:", JSON.stringify(reviews).slice(0, 500));

const search = await (await fetch(`${W}/search?q=UI%E5%8F%96%E8%AF%81&limit=10`, { headers: H })).json();
console.log("search:", JSON.stringify(search).slice(0, 300));
await browser.close();
