// UI-DPI 取证数据准备第二阶段：T2 启动后存产物两版；T1 就绪/开始；T5 依赖；知识/记忆/决定/规则；review-inbox 现状。
// 前置：probe-and-seed.mjs 已建项目与任务（IDs 硬编码自其输出）。
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const cdpBase = process.env.DESKTOP_CDP ?? "http://127.0.0.1:9333";
const browser = await chromium.connectOverCDP(cdpBase);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().startsWith("http://tauri.localhost"));
if (!page) { console.error("no tauri page"); process.exit(1); }
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
const { baseUrl, workspaceId, bearerToken } = conn;
console.log("baseUrl=" + baseUrl);
const H = { "Authorization": `Bearer ${bearerToken}`, "Content-Type": "application/json" };
const W = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const uuid = () => crypto.randomUUID();
async function api(path) {
  const res = await fetch(`${W}${path}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: (await res.text()).slice(0,200)`);
  return res.json();
}
async function post(path, payload, expect = 201) {
  const res = await fetch(`${W}${path}`, { method: "POST", headers: H, body: JSON.stringify(payload) });
  const text = await res.text();
  if (res.status !== expect) throw new Error(`POST ${path} -> ${res.status} (expect ${expect}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const rev = async (id) => (await api(`/tasks/${id}`)).revision;

const projAId = "4254461d-c6e2-4b08-8ce9-679d3b8393f3";
const t1 = "d8db4e26-4540-48e5-88fe-b5efeb0186b9";
const t2 = "21071df6-b10b-487a-b62b-1645e4e0df5f";
const t5 = "a73c81d2-4e5e-4215-8f3a-0c299c18be10";

// T2 就绪→启动（进入 IN_PROGRESS）再存产物
await post(`/tasks/${t2}/ready`, { command_id: uuid(), expected_revision: await rev(t2) }, 200);
await post(`/tasks/${t2}/start`, { command_id: uuid(), expected_revision: await rev(t2) }, 200);
console.log("T2 ready+started");
const art1 = await post(`/tasks/${t2}/artifacts`, { command_id: uuid(), expected_task_revision: await rev(t2), title: "UI取证-20260929 产物", media_type: "text/markdown", content: "# UI取证-20260929 产物V1\n\n第一版正文。" });
const a1 = art1.result ?? art1;
const artifactId = a1.artifact_id ?? a1.artifactId;
console.log("artifact=" + artifactId + " v1=" + (a1.artifact_version_id ?? a1.artifactVersionId));
const art2 = await post(`/artifacts/${artifactId}/versions`, { command_id: uuid(), expected_artifact_revision: a1.artifact_revision ?? a1.revision, expected_task_revision: await rev(t2), media_type: "text/markdown", content: "# UI取证-20260929 产物V2\n\n第二版正文。" });
const a2 = art2.result ?? art2;
console.log("v2=" + (a2.artifact_version_id ?? a2.artifactVersionId));

// T1 就绪 + 开始（今日可继续任务）
await post(`/tasks/${t1}/ready`, { command_id: uuid(), expected_revision: await rev(t1) }, 200);
await post(`/tasks/${t1}/start`, { command_id: uuid(), expected_revision: await rev(t1) }, 200);
console.log("T1 ready+started");

// T5 依赖 T1（BLOCKS）
await post(`/tasks/${t5}/dependency-links`, { command_id: uuid(), expected_revision: await rev(t5), depends_on_task_id: t1, dependency_kind: "BLOCKS" }, 200);
console.log("T5 depends on T1");

// 知识/记忆/决定/规则
await post("/knowledge", { command_id: uuid(), project_id: projAId, title: "UI取证-20260929 知识资料", source_kind: "NOTE", text: "# UI取证-20260929\n\n受管正文：用于知识库阅读页。" });
await post("/knowledge", { command_id: uuid(), project_id: null, title: "UI取证-20260929 全局资料", source_kind: "NOTE", text: "UI取证-20260929 全局正文。" });
await post("/memories", { command_id: uuid(), project_id: projAId, title: "UI取证-20260929 记忆", text: "UI取证-20260929 已确认记忆内容。", confirmed: true });
await post("/decisions", { command_id: uuid(), project_id: projAId, title: "UI取证-20260929 决定", choice: "选择方案一", rationale: "UI取证-20260929 取证理由。", alternatives: ["方案二"], costs: ["成本说明"] });
await post("/rules", { command_id: uuid(), scope: "PROJECT", scope_id: projAId, rule_key: `ui.forensic.${Date.now()}`, statement: "UI取证-20260929 取证规则：保持正文可读。", strength: "HARD", enforcement: "BLOCK" });
console.log("knowledge/memory/decision/rule created");

// review-inbox 自然现状
const reviews = await api("/review-inbox").catch((e) => ({ error: String(e).slice(0, 150) }));
console.log("review-inbox=" + JSON.stringify(reviews).slice(0, 400));

// 今日（只读）
const today = await api(`/today?date=${new Date().toISOString().slice(0, 10)}&timezone=Asia%2FShanghai`).catch((e) => ({ error: String(e).slice(0, 150) }));
console.log("today=" + JSON.stringify(today).slice(0, 300));

// 保存非敏感 ID 汇总
writeFileSync(new URL("./seed-summary.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify({
  tag: "UI取证-20260929", baseUrl, workspaceId,
  projAId, projBId: "7d576bef-855e-4cd8-84af-101bd9995277",
  tasks: { t1, t2, t3: "00554b1c-f55f-41c1-abe7-4611fccfbe64", t4: "9fc58580-28e9-4c6c-8292-d3680875893c", t5 },
  artifactId, note: "T3 收件箱/T4 辅助任务见首轮输出；token 不落盘"
}, null, 2));
await browser.close();
console.log("phase2 done");
