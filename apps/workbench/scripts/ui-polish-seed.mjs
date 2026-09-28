// UI 精修验证种子：通过真实 API 在指定工作空间创建混合状态测试任务（仅测试数据）。
// 用法：node apps/workbench/scripts/ui-polish-seed.mjs [baseUrl] [workspaceId]
// 需要先启动 apps/api（apps/api/.env）并完成 relay_dev 迁移与工作空间初始化。
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const repoRoot = new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const envText = readFileSync(`${repoRoot}apps/api/.env`, "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")
  && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
const base = process.argv[2] ?? `http://127.0.0.1:${env.RELAY_API_PORT ?? 8787}`;
const workspaceId = process.argv[3] ?? "11111111-1111-4111-8111-111111111111";
const root = `${base}/api/v1/workspaces/${workspaceId}`;
const headers = { "content-type": "application/json", authorization: `Bearer ${env.RELAY_API_BEARER_TOKEN}` };

async function call(path, body, method = "POST") {
  const response = await fetch(`${root}${path}`, { method, headers,
    body: method === "GET" ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (response.status >= 300) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text);
}
const command = (extra = {}) => ({ command_id: randomUUID(), ...extra });
const localDate = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
  .format(new Date(Date.now() + offsetDays * 86400000));
const today = localDate(0);

async function createProject(title) {
  return (await call("/projects", command({ title, project_type: "GENERAL" }))).result.project_id;
}
async function createTask(projectId, title, objective) {
  const envelope = await call("/tasks", command({ project_id: projectId, title, objective, mode: "ME",
    criteria: [{ statement: `${objective}，且结果已人工核对。`, required: true }] }));
  return { taskId: envelope.result.task_id, revision: envelope.result.revision };
}
const markReady = async (taskId, revision) =>
  (await call(`/tasks/${taskId}/ready`, command({ expected_revision: revision }))).result.revision;
const planning = async (taskId, revision, priority, due) =>
  call(`/tasks/${taskId}/planning-metadata`, command({ expected_revision: revision, priority,
    due_local_date: due, timezone: due ? "Asia/Shanghai" : null }));
const start = async (taskId, revision) =>
  (await call(`/tasks/${taskId}/start`, command({ expected_revision: revision }))).result.revision;
async function select(taskId, pin, laterLocalDate) {
  const snapshot = await call(`/today?date=${today}&timezone=Asia/Shanghai`, null, "GET");
  await call(`/task-selections/${taskId}`, command({ expected_revision: snapshot.selection_revision,
    pin, later_local_date: laterLocalDate, timezone: laterLocalDate ? "Asia/Shanghai" : null }));
}

const p1 = await createProject("人机协作工作流研究");
const p2 = await createProject("论文写作与验收整理");
const t1 = await createTask(p1, "整理实验资料并归档", "把实验原始记录整理为可复查的归档");
const t2 = await createTask(p1, "确定实验评价指标", "补齐基线、评价方法与可复核的验收依据");
const t3 = await createTask(p1, "梳理任务恢复流程", "整理中断后接手的步骤与注意事项");
const t4 = await createTask(p1, "补充基线数据核对", "核对三组基线数据并记录差异");
const t5 = await createTask(p2, "修改第二章论证结构", "按评审意见调整第二章论证顺序");
const readyRevision = {};
for (const task of [t1, t2, t3, t4, t5]) readyRevision[task.taskId] = await markReady(task.taskId, task.revision);
await planning(t1.taskId, readyRevision[t1.taskId], "NORMAL", null);
await planning(t4.taskId, readyRevision[t4.taskId], "HIGH", today);
await select(t2.taskId, true, null);
await select(t3.taskId, true, localDate(1));
const t5Revision = await start(t5.taskId, readyRevision[t5.taskId]);

const snapshot = await call(`/today?date=${today}&timezone=Asia/Shanghai`, null, "GET");
console.log(JSON.stringify({ p1, p2, t5Revision, groups: {
  eligible: snapshot.eligible_items.map((item) => item.title),
  blockedPinned: snapshot.blocked_pinned_items.map((item) => item.title),
  waitingOther: snapshot.waiting_items.filter((item) =>
    !snapshot.blocked_pinned_items.some((blocked) => blocked.task_id === item.task_id)).map((item) => item.title)
} }, null, 2));
