import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-personal-planning-test');
let api: TestApi; let workspaceId: string;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); workspaceId = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
const path = (suffix: string) => workspacePath(workspaceId, suffix);
async function post(suffix: string, body: Record<string, unknown>, status: 200 | 201 = 200) {
  const commandId = typeof body.command_id === 'string' ? body.command_id : randomUUID();
  return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status, commandId);
}
async function read(suffix: string) { const r = await api.get(path(suffix)); assert.equal(r.status, 200, r.text); return r.body as Record<string, unknown>; }
async function fixture(titles: string[]) {
  const project = await post('/projects', { title: '基础本段计划', project_type: 'GENERAL' }, 201);
  const tasks = [];
  for (const title of titles) tasks.push(await post('/tasks', { project_id: project.project_id, title, objective: `完成${title}`, criteria: [{ criterion_id: 'c1', statement: '人工核对', method: 'HUMAN' }] }, 201));
  return { projectId: project.project_id as string, taskIds: tasks.map((t) => t.task_id as string) };
}
async function estimate(id: string, elapsedMs: number | null, revision = '0') {
  const task = (await createRepositories(app.db).tasks.readTask(id))!;
  return post(`/tasks/${id}/time-estimates`, { confirmed: true, expected_task_revision: task.revision.toString(), expected_estimate_revision: revision,
    elapsed_ms: elapsedMs, execution_ms: elapsedMs === null ? null : 1200000, waiting_ms: elapsedMs === null ? null : 1200000,
    review_ms: elapsedMs === null ? null : 600000, human_ms: elapsedMs === null ? null : 600000, source_note: '用户依据本段任务填写，执行与等待有重叠' });
}
const minutes = (n: number) => n * 60000;
type Item = { id: string; task_id: string; kind: string; reason: string; status: string; budget_ms: number; created_task_id: string | null };

test('基础计划按主线/前置/容量排序，读回不重置窗口，逐项接受与拒绝不启动执行', async () => {
  const f = await fixture(['主线', '必要前置', '独立任务']); const [main, prerequisite, other] = f.taskIds as [string, string, string];
  await post(`/tasks/${main}/dependency-links`, { expected_revision: '0', depends_on_task_id: prerequisite, dependency_kind: 'BLOCKS' });
  await estimate(main, minutes(20)); await estimate(prerequisite, minutes(10)); await estimate(other, minutes(40));
  const tasksBefore = await createRepositories(app.db).tasks.listTasksByIds(f.taskIds);
  const body = { command_id: randomUUID(), title: '接下来一小时', available_ms: minutes(60), diagnostic_ms: minutes(10), task_ids: [main, other], mainline_task_ids: [main], goal_ids: [] };
  const plan = await post(`/projects/${f.projectId}/period-plans`, body);
  await post(`/projects/${f.projectId}/period-plans`, body);
  const url = `/period-plans/${plan.plan_id}`;
  const view = await read(url); const items = view.items as Item[];
  assert.deepEqual(view.stale_reasons, []);
  assert.deepEqual(items.map((i) => i.task_id), [prerequisite, main, other]);
  assert.deepEqual(items.map((i) => i.kind), ['TASK', 'TASK', 'DEFERRED']);
  assert.equal(items[1]?.budget_ms, minutes(20)); // 不是执行+等待+审阅的 50 分钟。
  const reread = await read(url); assert.equal(reread.started_at, view.started_at); assert.equal(reread.ends_at, view.ends_at);
  assert.ok(BigInt(reread.remaining_ms as string) <= BigInt(view.remaining_ms as string));
  const early = await api.post(path(`${url}/items/${items[1]!.id}/resolutions`), { command_id: randomUUID(), expected_revision: '1', action: 'ACCEPT', reason: '尚未接受前置' });
  assert.equal(early.status, 409, early.text);
  const accepted = await post(`${url}/items/${items[0]!.id}/resolutions`, { expected_revision: '1', action: 'ACCEPT', reason: '先做前置' });
  const mainAccepted = await post(`${url}/items/${items[1]!.id}/resolutions`, { expected_revision: accepted.revision, action: 'ACCEPT', reason: '推进主线' });
  await post(`${url}/items/${items[2]!.id}/resolutions`, { expected_revision: mainAccepted.revision, action: 'REJECT', reason: '下段再做' });
  assert.deepEqual((await read(url)).items && ((await read(url)).items as Item[]).map((i) => i.status), ['ACCEPTED', 'ACCEPTED', 'REJECTED']);
  assert.deepEqual(await createRepositories(app.db).tasks.listTasksByIds(f.taskIds), tasksBefore);
  assert.equal((await read(url)).execution_admission, 'NOT_GRANTED');
  assert.equal(((await read(`/projects/${f.projectId}/period-plans`)).items as unknown[]).length, 1);
});
test('未知关键任务创建独立诊断 Task，原任务不完成，原命令重放不重复创建', async () => {
  const f = await fixture(['修复主线', '独立未知']); const [main, other] = f.taskIds as [string, string];
  await estimate(main, null);
  const plan = await post(`/projects/${f.projectId}/period-plans`, { title: '先定位问题', available_ms: minutes(30), diagnostic_ms: minutes(10), task_ids: f.taskIds, mainline_task_ids: [main], goal_ids: [] });
  const url = `/period-plans/${plan.plan_id}`;
  const items = (await read(url)).items as Item[];
  assert.equal(items[0]?.kind, 'DIAGNOSTIC'); assert.equal(items[1]?.reason, 'ESTIMATE_UNKNOWN');
  const body = { command_id: randomUUID(), expected_revision: '1', action: 'ACCEPT', reason: '先查清再估时' };
  const accepted = await post(`${url}/items/${items[0]!.id}/resolutions`, body);
  const replay = await api.post(path(`${url}/items/${items[0]!.id}/resolutions`), body);
  assert.equal(replay.status, 200, replay.text); assert.equal(replay.headers['command-replayed'], 'true');
  const r = createRepositories(app.db); const diagnostic = (await r.tasks.readTask(accepted.created_task_id as string))!;
  assert.equal(diagnostic.status, 'INBOX'); assert.equal(diagnostic.executor_kind, 'HUMAN'); assert.equal(diagnostic.executor_run_id, null);
  const acceptance = (await r.tasks.readAcceptanceVersion(diagnostic.id, diagnostic.acceptance_revision))!;
  assert.equal(acceptance.required_output_spec.source_task_id, main);
  assert.equal(acceptance.required_output_spec.time_budget_ms, minutes(10)); assert.match(acceptance.objective, /未知问题/);
  assert.equal((await r.tasks.readTask(main))?.status, 'INBOX');
  assert.equal((await r.tasks.readTask(other))?.status, 'INBOX');
  assert.equal((await r.tasks.listProjectTasksByStatus(f.projectId, ['INBOX'])).length, 3);
  const estimateView = await read(`/tasks/${main}/time-estimates`);
  assert.equal((estimateView.current as { elapsed_ms: unknown }).elapsed_ms, null);
});
test('用户改估时后保留旧候选并拒绝按旧依据应用，重新发起可用新估时', async () => {
  const f = await fixture(['待排任务']); const id = f.taskIds[0]!;
  await estimate(id, minutes(20));
  const input = { title: '本段', available_ms: minutes(60), diagnostic_ms: minutes(10), task_ids: [id], mainline_task_ids: [id], goal_ids: [] };
  const plan = await post(`/projects/${f.projectId}/period-plans`, input);
  const url = `/period-plans/${plan.plan_id}`; const item = ((await read(url)).items as Item[])[0]!;
  await estimate(id, minutes(40), '1');
  assert.ok(((await read(url)).stale_reasons as string[]).some((v) => v.includes(id)));
  const rejected = await api.post(path(`${url}/items/${item.id}/resolutions`), { command_id: randomUUID(), expected_revision: '1', action: 'ACCEPT', reason: '按旧估时' });
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(((await read(url)).items as Item[])[0]?.budget_ms, minutes(20));
  const next = await post(`/projects/${f.projectId}/period-plans`, input);
  assert.equal(((await read(`/period-plans/${next.plan_id}`)).items as Item[])[0]?.budget_ms, minutes(40));
  assert.equal(((await read(`/tasks/${id}/time-estimates`)).items as unknown[]).length, 2);
  const runs = await sql<{ count: string }>`select count(*)::text as count from runs where workspace_id = ${workspaceId}`.execute(app.db);
  assert.equal(runs.rows[0]?.count, '0');
});

test('已关联活动目标提供主线依据，缺总估时只生成诊断而不从分项推算', async () => {
  const f = await fixture(['目标任务']); const taskId = f.taskIds[0]!;
  const goal = await post('/goals', { title: '明确项目目标', description: '作为本段依据' }, 201);
  await post(`/projects/${f.projectId}/goal-links`, { expected_revision: '0', goal_id: goal.goal_id });
  const task = (await createRepositories(app.db).tasks.readTask(taskId))!;
  await post(`/tasks/${taskId}/time-estimates`, { confirmed: true, expected_task_revision: task.revision.toString(), expected_estimate_revision: '0',
    elapsed_ms: null, execution_ms: minutes(10), waiting_ms: minutes(10), review_ms: minutes(5), human_ms: minutes(5), source_note: '总时间未确认，只确认分项' });
  const plan = await post(`/projects/${f.projectId}/period-plans`, { title: '按目标推进', available_ms: minutes(30), diagnostic_ms: minutes(10), task_ids: [taskId], mainline_task_ids: [], goal_ids: [goal.goal_id] });
  const view = await read(`/period-plans/${plan.plan_id}`);
  assert.deepEqual(view.stale_reasons, []);
  assert.equal((view.items as Item[])[0]?.kind, 'DIAGNOSTIC');
  const baseline = view.baseline as { tasks: { critical: boolean; elapsed_ms: null }[]; project_goals: { goal_id: string }[] };
  assert.equal(baseline.tasks[0]?.critical, true); assert.equal(baseline.tasks[0]?.elapsed_ms, null);
  assert.equal(baseline.project_goals[0]?.goal_id, goal.goal_id);
});

test('恰好排满固定容量的候选在窗口内仍可接受，已耗审阅时间只提示缺口', async () => {
  const f = await fixture(['排满本段']); const taskId = f.taskIds[0]!;
  await estimate(taskId, minutes(20));
  const plan = await post(`/projects/${f.projectId}/period-plans`, { title: '二十分钟', available_ms: minutes(20), diagnostic_ms: minutes(5), task_ids: [taskId], mainline_task_ids: [taskId], goal_ids: [] });
  const url = `/period-plans/${plan.plan_id}`;
  const view = await read(url); const item = (view.items as Item[])[0]!;
  assert.equal(item.kind, 'TASK'); assert.equal(view.time_warning, 'ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW');
  const accepted = await post(`${url}/items/${item.id}/resolutions`, { expected_revision: plan.revision, action: 'ACCEPT', reason: '用户确认按此预算尝试' });
  assert.equal(accepted.item_status, 'ACCEPTED');
  assert.equal((await createRepositories(app.db).tasks.readTask(taskId))?.status, 'INBOX');
});
