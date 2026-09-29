// D1 回归：经真实领域入口 delegate（mock FAKE_WRITE）产生 Run，观察 worker/Supervisor 行为；
// 运行中请求 PAUSE（供 UI-19 补取证）。全部走桌面 bootstrap 后的真实 API。
import pw from 'file://D:/Develop/Relay-Agent/.tmp-uidpi/node_modules/@playwright/test/index.js';
const { chromium } = pw;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("http://tauri.localhost"));
if (!page) { console.log("PAGE_NOT_FOUND"); process.exit(2); }
const conn = await page.evaluate(async () => await window.__TAURI_INTERNALS__.invoke("desktop_bootstrap"));
log("bootstrap OK", conn.baseUrl);
const H = { Authorization: `Bearer ${conn.bearerToken}`, "Content-Type": "application/json" };
const W = `${conn.baseUrl}/api/v1/workspaces/${conn.workspaceId}`;
const uuid = () => crypto.randomUUID();
const get = async (path) => (await fetch(`${W}${path}`, { headers: H })).json();
const post = async (path, payload, expect = 201) => {
  const res = await fetch(`${W}${path}`, { method: "POST", headers: H, body: JSON.stringify(payload) });
  const text = await res.text();
  if (res.status !== expect) throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
};

// 1. 项目 A：优先复用既有项目
const projects = await get("/projects");
const rows = Array.isArray(projects) ? projects : (projects.items ?? []);
if (rows.length === 0) throw new Error("no project in workspace; seed first");
const projA = rows[0];
log("project:", projA.id, projA.name ?? projA.title ?? "");

// 2. mock 资源（幂等）
let resId;
const resList = await get(`/projects/${projA.id}/managed-resources`);
const resRows = Array.isArray(resList) ? resList : (resList.items ?? []);
const existing = resRows[0];
resId = existing?.id ?? existing?.resource_id;
if (!resId) {
  const r = await post(`/projects/${projA.id}/managed-resources`,
    { command_id: uuid(), root_path: "D:\\Develop\\Relay-Agent\\.tmp-uidpi\\fake-root" });
  resId = r.result?.resource_id ?? r.result?.id;
  log("resource created:", resId);
} else log("resource reused:", resId);

// 3. mock 连接
const c = await post(`/projects/${projA.id}/connections`,
  { command_id: uuid(), capabilities: ["FAKE_WRITE", "FAKE_PUBLIC_READ"] });
const connId = c.result?.connection_id ?? c.result?.id;
log("connection:", connId);

// 4. 回归任务（新建，标题固定标注）
const t6body = await post("/tasks", {
  command_id: uuid(), project_id: projA.id,
  title: `桌面修复D1回归-20260929 委托任务-${Date.now()}`,
  objective: "验证 worker 崩溃后宿主有界重启与可观测性（mock 网关）。",
  mode: "AI_ASSIST",
  criteria: [{ statement: "回归标准：宿主不因 worker 退出而永久失败" }],
});
let t6 = t6body.result?.task_id, rev = t6body.result?.revision;
await post(`/tasks/${t6}/ready`, { command_id: uuid(), expected_revision: rev }, 200)
  .catch((e) => { if (!String(e).includes("409")) throw e; });
let t6now = await get(`/tasks/${t6}`);
log("task READY:", t6, "rev", t6now.revision);

// 5. 退役阻断准入的 PRE_ACTION 规则（幂等）
const rules = await get(`/rules?project_id=${projA.id}`);
const ruleRows = Array.isArray(rules) ? rules : (rules.items ?? []);
for (const rr of ruleRows) {
  if (rr.status === "ACTIVE" && rr.enforcement === "PRE_ACTION") {
    const ret = await fetch(`${W}/rules/${rr.id}/retire`, { method: "POST", headers: H,
      body: JSON.stringify({ command_id: uuid(), expected_revision: rr.revision }) });
    log("retire rule", rr.id, ret.status);
  }
}

// 6. delegate（mock FAKE_WRITE）
const d = await fetch(`${W}/tasks/${t6}/delegations`, { method: "POST", headers: H,
  body: JSON.stringify({ command_id: uuid(), expected_task_revision: t6now.revision,
    mock_gateway_action: { connection_id: connId, resource_id: resId,
      target: "d1-regression-note.md", content: "桌面修复 D1 回归 mock 动作内容" } }) });
const dtext = await d.text();
log("delegate:", d.status, dtext.slice(0, 300));
let runId = (() => { try { const j = JSON.parse(dtext); return j.result?.run_id ?? j.result?.runId; } catch { return undefined; } })();
if (!runId) {
  const runs = await get(`/tasks/${t6}/runs`);
  const runRows = Array.isArray(runs) ? runs : (runs.items ?? []);
  runId = runRows[0]?.id ?? runRows[0]?.run_id;
}
log("run:", runId);

// 7. 轮询 Run 状态；RUNNING 稳定后请求 PAUSE（UI-19 取证）；观察暂停/终态
let last = "", paused = false, runRev = null, taskRev = null;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const run = await get(`/runs/${runId}`);
  const task = await get(`/tasks/${t6}`);
  runRev = run.revision; taskRev = task.revision;
  const line = JSON.stringify({ status: run.status, control: run.control_state ?? null,
    pending: run.pending_operation_id ?? null });
  if (line !== last) { log("run:", line.slice(0, 220), "task:", task.status); last = line; }
  if (run.status === "RUNNING" && !paused) {
    // 首次见到 RUNNING 即请求 PAUSE（PENDING），由安全点应用
    const pr = await fetch(`${W}/runs/${runId}/control-requests`, { method: "POST", headers: H,
      body: JSON.stringify({ command_id: uuid(), type: "PAUSE",
        expected_task_revision: taskRev, expected_run_revision: runRev }) });
    log("PAUSE request:", pr.status, (await pr.text()).slice(0, 200));
    paused = true;
  }
  if (["PAUSED", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"].includes(run.status)) {
    log("final-ish status:", run.status);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const run = await get(`/runs/${runId}`);
log("run full:", JSON.stringify({ status: run.status, control_state: run.control_state ?? null,
  wait_reason: run.wait_reason ?? null, revision: run.revision }).slice(0, 400));
const trace = await get(`/runs/${runId}/trace`);
log("trace tail:", JSON.stringify(trace).slice(0, 500));
await browser.close();
log("DONE runId=" + runId + " taskId=" + t6);
