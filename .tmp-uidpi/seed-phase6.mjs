// 构造 Run 链路：mock 连接+资源 → T6(DELEGATE_AI) → delegate(mock FAKE_WRITE) → 轮询 Run 状态。
import { chromium } from "@playwright/test";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const uuid = () => crypto.randomUUID();
const post = async (path, payload, expect = 201) => {
  const res = await fetch(`${W}${path}`, { method: "POST", headers: H, body: JSON.stringify(payload) });
  const text = await res.text();
  if (res.status !== expect) throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const projAId = "4254461d-c6e2-4b08-8ce9-679d3b8393f3";

// 1. mock 连接
const c = await post(`/projects/${projAId}/connections`, { command_id: uuid(), capabilities: ["FAKE_WRITE", "FAKE_PUBLIC_READ"] });
console.log("connection:", JSON.stringify(c).slice(0, 250));
const connId = c.result?.connection_id ?? c.result?.id;
// 2. mock 资源（root_path 用临时取证目录；幂等：已登记则复用）
let resId;
const resList = await (await fetch(`${W}/projects/${projAId}/managed-resources`, { headers: H })).json();
console.log("resource list:", JSON.stringify(resList).slice(0, 400));
const existing = (Array.isArray(resList) ? resList[0] : resList.items?.[0]);
resId = existing?.id ?? existing?.resource_id;
if (!resId) {
  const r = await post(`/projects/${projAId}/managed-resources`, { command_id: uuid(), root_path: "D:\\Develop\\Relay-Agent\\.tmp-uidpi\\fake-root" });
  console.log("resource:", JSON.stringify(r).slice(0, 250));
  resId = r.result?.resource_id ?? r.result?.id;
} else {
  console.log("resource exists, reuse:", resId);
}
// 3. T6（幂等：已有 READY 任务则复用，否则新建带序号）
let t6, t6rev;
const wsTasks = await (await fetch(`${W}/tasks?page_size=50`, { headers: H })).json();
const rows = Array.isArray(wsTasks) ? wsTasks : (wsTasks.items ?? []);
const found = rows.find((x) => x.title?.startsWith("UI取证-20260929 委托任务T6") && x.status === "READY");
if (found) { t6 = found.id ?? found.task_id; t6rev = found.revision; console.log("T6 reuse READY:", t6); }
else {
  const suffix = rows.filter((x) => x.title?.startsWith("UI取证-20260929 委托任务T6")).length + 1;
  const t6body = await post("/tasks", { command_id: uuid(), project_id: projAId, title: `UI取证-20260929 委托任务T6-${suffix}`, objective: "用于 Run 状态取证的委托任务（mock 网关）。", mode: "AI_ASSIST", criteria: [{ statement: "取证标准：Run 状态可追溯" }] });
  t6 = t6body.result?.task_id; t6rev = t6body.result?.revision;
  console.log("T6:", t6, "rev:", t6rev);
}
await post(`/tasks/${t6}/ready`, { command_id: uuid(), expected_revision: t6rev }, 200).catch((e) => { if (!String(e).includes("409")) throw e; });
let t6now = await (await fetch(`${W}/tasks/${t6}`, { headers: H })).json();
console.log("T6 after ready:", t6now.status, "rev", t6now.revision, "allowed:", JSON.stringify(t6now.allowed_actions));
// 4. delegate 前：退役会阻断准入的 HARD/PRE_ACTION 规则（规则治理入口，幂等）
const rules = await (await fetch(`${W}/rules?project_id=${projAId}`, { headers: H })).json();
const ruleRows = Array.isArray(rules) ? rules : (rules.items ?? []);
for (const rr of ruleRows) {
  if (rr.status === "ACTIVE" && rr.enforcement === "PRE_ACTION") {
    const ret = await fetch(`${W}/rules/${rr.id}/retire`, { method: "POST", headers: H, body: JSON.stringify({ command_id: uuid(), expected_revision: rr.revision }) });
    console.log("retire rule", rr.id, ret.status);
  }
}
// 4. delegate（mock FAKE_WRITE）
const d = await fetch(`${W}/tasks/${t6}/delegations`, { method: "POST", headers: H, body: JSON.stringify({ command_id: uuid(), expected_task_revision: t6now.revision, mock_gateway_action: { connection_id: connId, resource_id: resId, target: "forensic-note.md", content: "UI取证-20260929 mock 动作内容" } }) });
const dtext = await d.text();
console.log("delegate:", d.status, dtext.slice(0, 400));
if (d.status === 202) {
  const djson = JSON.parse(dtext);
  const runId = djson.result?.run_id;
  console.log("runId:", runId);
  // 轮询 Run 状态 15s
  for (let i = 0; i < 15; i++) {
    await new Promise((r2) => setTimeout(r2, 1000));
    const run = await (await fetch(`${W}/runs/${runId}`, { headers: H })).json();
    console.log(`run[${i}s]:`, run.status ?? JSON.stringify(run).slice(0, 120));
    if (["COMPLETED", "FAILED", "CANCELLED", "PAUSED", "UNKNOWN"].includes(run.status)) break;
  }
  const reviews = await (await fetch(`${W}/reviews?status=OPEN`, { headers: H })).json();
  console.log("reviews OPEN:", JSON.stringify(reviews).slice(0, 400));
}
await browser.close();
