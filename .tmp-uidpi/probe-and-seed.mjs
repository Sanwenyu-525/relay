// UI-DPI 取证：附着桌面 CDP，提取桌面 bootstrap 连接（token 仅留内存，不落盘），经真实 API 领域入口准备测试数据。
// 用法：node .tmp-uidpi/probe-and-seed.mjs [--probe-only]（须先设 DESKTOP_CDP，默认 http://127.0.0.1:9333）
import { chromium } from "@playwright/test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const cdpBase = process.env.DESKTOP_CDP ?? "http://127.0.0.1:9333";
const probeOnly = process.argv.includes("--probe-only");
const TAG = "UI取证-20260929";

const browser = await chromium.connectOverCDP(cdpBase);
const ctx = browser.contexts()[0];
if (!ctx) { console.error("no CDP context"); process.exit(1); }
let page = ctx.pages().find((p) => p.url().startsWith("http://tauri.localhost"));
if (!page) { console.error("pages:", ctx.pages().map((p) => p.url())); process.exit(1); }

// 桌面窗口内重新走一次 bootstrap（导航后 App 自动做；这里直接 invoke 拿连接，凭据仅留内存）
const conn = await page.evaluate(async () => {
  const input = await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap");
  if (!input || typeof input.baseUrl !== "string") throw new Error("bootstrap failed: " + JSON.stringify(Object.keys(window.__TAURI_INTERNALS__)));
  return input;
});
const { baseUrl, workspaceId, bearerToken } = conn;
console.log("baseUrl=" + baseUrl);
console.log("workspaceId=" + workspaceId);
console.log("token=***in-memory-only***");

const H = { "Authorization": `Bearer ${bearerToken}`, "Content-Type": "application/json" };
const W = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
async function api(path, init = {}) {
  const res = await fetch(`${W}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return body;
}
const uuid = () => crypto.randomUUID();
async function cmdEnvelope(path, payload, expect = 201) {
  const res = await fetch(`${W}${path}`, { method: "POST", headers: H, body: JSON.stringify(payload) });
  const text = await res.text();
  if (res.status !== expect) throw new Error(`POST ${path} -> ${res.status} (expect ${expect}): ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// 1. 健康与现状
{
  const res = await fetch(`${baseUrl}/health/ready`, { headers: H });
  const readyBody = await res.json();
  console.log("health=" + JSON.stringify(readyBody).slice(0, 200));
  if (readyBody?.status !== "ready") throw new Error("API not ready");
}
const projectsPage = await api("/projects?status=all");
const existing = (projectsPage.projects ?? projectsPage.items ?? []).map((p) => ({ id: p.id, title: p.title }));
console.log("existing projects=" + existing.length);
existing.forEach((p) => console.log("  - " + p.id + " " + p.title));

if (probeOnly) { await browser.close(); process.exit(0); }

// 已有 seed 则跳过（幂等）
const summaryPath = new URL("./seed-summary.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
if (existsSync(summaryPath)) {
  const prev = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (prev.workspaceId === workspaceId && prev.tag === TAG) {
    console.log("seed-summary 已存在且工作区一致，跳过重复创建。projects=" + (prev.projects?.length ?? 0));
    await browser.close(); process.exit(0);
  }
}

const summary = { tag: TAG, baseUrl, workspaceId, createdAt: new Date().toISOString(), projects: [], tasks: [], knowledge: [], info: {} };
const keep = (o) => JSON.parse(JSON.stringify(o));

// 2. 项目 A（有数据）
const projA = await cmdEnvelope("/projects", { command_id: uuid(), title: `${TAG} 项目A`, project_type: "THESIS" });
summary.projects.push({ name: "A", ...keep(projA) });
const projAId = projA?.result?.project_id ?? projA?.result?.projectId ?? projA?.project_id;
console.log("projA=" + projAId);
const projAResult = projA.result ?? projA;

// 项目 B（空）
const projB = await cmdEnvelope("/projects", { command_id: uuid(), title: `${TAG} 空项目B`, project_type: "GENERAL" });
summary.projects.push({ name: "B-empty", ...keep(projB) });
const projBId = projB?.result?.project_id ?? projB?.project_id;
console.log("projB=" + projBId);

// 3. 项目 A 任务
async function createTask(projectId, title, objective, mode, criteria) {
  const payload = { command_id: uuid(), title, objective, mode, criteria: criteria.map((statement) => ({ statement })) };
  if (projectId !== null) payload.project_id = projectId;
  const body = await cmdEnvelope("/tasks", payload);
  const t = body.result ?? body;
  console.log(`task[${title}]=` + t.task_id);
  return t;
}
// T1 人工任务（收件箱外：挂项目A）
const t1 = await createTask(projAId, `${TAG} 人工任务T1`, "由人工完成的取证任务，用于今日工作台与任务详情。", "ME", ["取证标准1：任务详情可见", "取证标准2：验收标准渲染正确"]);
summary.tasks.push({ name: "T1-human", id: t1.task_id, revision: t1.revision });
// T2 产物版本任务
const t2 = await createTask(projAId, `${TAG} 产物任务T2`, "带两版产物的取证任务，用于版本条与产物页签。", "ME", ["取证标准：产物两版可切换"]);
summary.tasks.push({ name: "T2-artifact", id: t2.task_id, revision: t2.revision });
// T3 无项目收件箱任务
const t3 = await createTask(null, `${TAG} 收件箱T3`, "无项目收件箱任务，用于任务收件箱页面。", "ME", ["取证标准：收件箱可见"]);
summary.tasks.push({ name: "T3-inbox", id: t3.task_id, revision: t3.revision });
// T4 AI_ASSIST 任务（辅助模式展示）
const t4 = await createTask(projAId, `${TAG} 辅助任务T4`, "AI 辅助模式任务，用于交互模式展示。", "AI_ASSIST", ["取证标准：辅助模式可见"]);
summary.tasks.push({ name: "T4-assist", id: t4.task_id, revision: t4.revision });
// T5 依赖阻塞：T5 被 T1 BLOCKS（依赖面板）
const t5 = await createTask(projAId, `${TAG} 被阻塞任务T5`, "依赖 T1 的取证任务，用于依赖说明面板。", "ME", ["取证标准：依赖阻塞提示"]);
summary.tasks.push({ name: "T5-blocked", id: t5.task_id, revision: t5.revision });

// T2 产物两版
const art1 = await cmdEnvelope(`/tasks/${t2.task_id}/artifacts`, { command_id: uuid(), expected_task_revision: t2.revision, title: `${TAG} 产物V1`, media_type: "text/markdown", content: `# ${TAG} 产物V1\n\n第一版正文。` });
const a1 = art1.result ?? art1;
const artifactId = a1.artifact_id ?? a1.artifactId;
const artifactVersion1 = a1.artifact_version_id ?? a1.artifactVersionId;
console.log("artifact=" + artifactId + " v1=" + artifactVersion1);
summary.info.artifactId = artifactId; summary.info.artifactV1 = artifactVersion1;
// 第二版前重取 task revision（保存产物可能推进 revision）
const t2detail = await api(`/tasks/${t2.task_id}`);
const t2rev = t2detail.revision ?? t2detail.task?.revision;
const art2 = await cmdEnvelope(`/artifacts/${artifactId}/versions`, { command_id: uuid(), expected_artifact_revision: a1.artifact_revision ?? a1.revision, expected_task_revision: t2rev, media_type: "text/markdown", content: `# ${TAG} 产物V2\n\n第二版正文。` });
const a2 = art2.result ?? art2;
summary.info.artifactV2 = a2.artifact_version_id ?? a2.artifactVersionId;
console.log("v2=" + summary.info.artifactV2);

// T1 标记就绪 + 选中（今日工作台数据）
const t1detail = await api(`/tasks/${t1.task_id}`);
const t1rev = t1detail.revision ?? t1detail.task?.revision;
await cmdEnvelope(`/tasks/${t1.task_id}/ready`, { command_id: uuid(), expected_revision: t1rev }, 200);
try {
  await cmdEnvelope(`/tasks/${t1.task_id}/start`, { command_id: uuid(), expected_revision: (await api(`/tasks/${t1.task_id}`)).revision }, 200);
  summary.info.t1Started = true;
} catch (e) { console.log("start T1 skipped: " + e.message.slice(0, 120)); summary.info.t1Started = false; }

// T5 依赖 T1
const t5detail = await api(`/tasks/${t5.task_id}`);
await cmdEnvelope(`/tasks/${t5.task_id}/dependency-links`, { command_id: uuid(), expected_revision: t5detail.revision, depends_on_task_id: t1.task_id, dependency_kind: "BLOCKS" }, 200);

// 4. 知识/记忆/决定/规则（项目A + 工作区）
const k1 = await cmdEnvelope("/knowledge", { command_id: uuid(), project_id: projAId, title: `${TAG} 知识资料`, source_kind: "NOTE", text: `# ${TAG}\n\n受管正文：用于知识库阅读页。` });
summary.knowledge.push(keep(k1));
const k2 = await cmdEnvelope("/knowledge", { command_id: uuid(), project_id: null, title: `${TAG} 全局资料`, source_kind: "NOTE", text: `${TAG} 全局正文。` });
summary.knowledge.push(keep(k2));
const m1 = await cmdEnvelope("/memories", { command_id: uuid(), project_id: projAId, title: `${TAG} 记忆`, text: `${TAG} 已确认记忆内容。`, confirmed: true });
summary.info.memory = keep(m1);
const d1 = await cmdEnvelope("/decisions", { command_id: uuid(), project_id: projAId, title: `${TAG} 决定`, choice: "选择方案一", rationale: `${TAG} 取证理由。`, alternatives: ["方案二"], costs: ["成本说明"] });
summary.info.decision = keep(d1);
const r1 = await cmdEnvelope("/rules", { command_id: uuid(), scope: "PROJECT", scope_id: projAId, rule_key: `ui.forensic.${Date.now()}`, statement: `${TAG} 取证规则：保持正文可读。`, strength: "HARD", enforcement: "BLOCK" });
summary.info.rule = keep(r1);

// 5. Review 现状（自然产生的待审）
const reviews = await api("/review-inbox").catch(() => null);
console.log("review-inbox=" + JSON.stringify(reviews)?.slice(0, 500));
summary.info.reviewInboxCount = Array.isArray(reviews?.reviews) ? reviews.reviews.length : (Array.isArray(reviews) ? reviews.length : null);

// 6. 今日（只读验证）
const today = await api(`/today?date=${new Date().toISOString().slice(0, 10)}&timezone=Asia%2FShanghai`).catch((e) => e.message.slice(0, 150));
console.log("today=" + JSON.stringify(today).slice(0, 300));

writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log("summary saved (无 token):" + summaryPath);
await browser.close();
