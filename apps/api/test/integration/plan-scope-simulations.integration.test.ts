import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-scope-simulation-test');
let api: TestApi; let workspaceId: string;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); workspaceId = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
const path = (suffix: string) => workspacePath(workspaceId, suffix);
const minutes = (n: number) => n * 60000;
async function post(suffix: string, body: Record<string, unknown>, status: 200 | 201 = 200) {
  const commandId = typeof body.command_id === 'string' ? body.command_id : randomUUID();
  return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status, commandId);
}
async function read(suffix: string) { const r = await api.get(path(suffix)); assert.equal(r.status, 200, r.text); return r.body as Record<string, unknown>; }
async function estimate(id: string, elapsed: number, revision = '0') {
  const task = (await createRepositories(app.db).tasks.readTask(id))!;
  await post(`/tasks/${id}/time-estimates`, { confirmed: true, expected_task_revision: task.revision.toString(), expected_estimate_revision: revision,
    elapsed_ms: minutes(elapsed), execution_ms: null, waiting_ms: null, review_ms: null, human_ms: null, source_note: '用户声明的整段估时' });
}
async function fixture() {
  const p = await post('/projects', { title: '固定容量范围推演', project_type: 'GENERAL' }, 201);
  const ids = [];
  for (const title of ['推进主线', '必要前置', '独立任务']) ids.push((await post('/tasks', { project_id: p.project_id, title, objective: `完成${title}`,
    criteria: [{ criterion_id: 'c1', statement: '原任务人工验收', method: 'HUMAN' }] }, 201)).task_id as string);
  const [main, pre, other] = ids as [string, string, string];
  await post(`/tasks/${main}/dependency-links`, { expected_revision: '0', depends_on_task_id: pre, dependency_kind: 'BLOCKS' });
  await estimate(main, 20); await estimate(pre, 10); await estimate(other, 40);
  const plan = await post(`/projects/${p.project_id}/period-plans`, { title: '下一段五十分钟', available_ms: minutes(50), diagnostic_ms: minutes(5),
    task_ids: [main, other], mainline_task_ids: [main], goal_ids: [] });
  return { projectId: p.project_id as string, planId: plan.plan_id as string, main, pre, other, ids };
}
type Item = { id: string; task_id: string; kind: string; status: string; reason: string; created_task_id: string | null };
type Option = { kind: string; task_ids: string[]; retained_prerequisite_ids: string[]; excluded_task_ids: string[]; requested_elapsed_ms: number | null;
  capacity_gap_ms: number | null; feasibility: string; items: Item[]; consequences: Record<string, unknown>[] };
const request = (f: Awaited<ReturnType<typeof fixture>>) => ({ command_id: randomUUID(), expected_revision: '1', keep_task_ids: [f.main], defer_task_ids: [f.pre], unreliable_task_ids: [] });

test('同一基线比较三种范围，选择复用原计划 Owner，逐项应用保留部分结果且不执行', async () => {
  const f = await fixture(); const r = createRepositories(app.db);
  const beforeTasks = await r.tasks.listTasksByIds(f.ids); const beforePlan = await read(`/period-plans/${f.planId}`);
  const body = request(f); const created = await post(`/period-plans/${f.planId}/scope-simulations`, body);
  await post(`/period-plans/${f.planId}/scope-simulations`, body);
  const url = `/scope-simulations/${created.simulation_id}`;
  const view = await read(url); const options = view.options as Option[];
  assert.deepEqual(view.stale_reasons, []); assert.equal(view.execution_admission, 'NOT_GRANTED'); assert.equal(view.completion_date, null);
  assert.equal(view.material_gaps, 'CHECK_AT_EXECUTION'); assert.equal(view.permission_gaps, 'CHECK_AT_EXECUTION');
  assert.deepEqual(options.map((o) => o.kind), ['ALL', 'SHRINK', 'DEFER']);
  assert.equal(options[0]?.requested_elapsed_ms, minutes(70)); assert.equal(options[0]?.capacity_gap_ms, minutes(20));
  assert.deepEqual(options[1]?.retained_prerequisite_ids, [f.pre]); assert.equal(options[1]?.requested_elapsed_ms, minutes(30));
  assert.deepEqual(options[2]?.task_ids, [f.other]); assert.equal(options[2]?.items.find((i) => i.task_id === f.main)?.reason, 'DEFERRED_WITH_DEPENDENT');
  assert.equal(options[2]?.consequences.find((c) => c.task_id === f.main)?.mainline, true);
  const selectBody = { command_id: randomUUID(), expected_revision: '1', confirmed: true, option: 'SHRINK', reason: '本段保留主线和前置' };
  const selected = await post(`${url}/selections`, selectBody);
  const replay = await api.post(path(`${url}/selections`), selectBody); assert.equal(replay.status, 200, replay.text); assert.equal(replay.headers['command-replayed'], 'true');
  const newPlanUrl = `/period-plans/${selected.selected_plan_id}`;
  const newPlan = await read(newPlanUrl);
  assert.equal(newPlan.available_ms, beforePlan.available_ms); assert.equal(newPlan.started_at, beforePlan.started_at); assert.equal(newPlan.ends_at, beforePlan.ends_at);
  assert.deepEqual(await r.tasks.listTasksByIds(f.ids), beforeTasks);
  const items = newPlan.items as Item[]; const prerequisite = items.find((i) => i.task_id === f.pre)!;
  const accepted = await post(`${newPlanUrl}/items/${prerequisite.id}/resolutions`, { expected_revision: '1', action: 'ACCEPT', reason: '先做前置' });
  const partial = (await read(url)).selected_plan as { items: Item[] };
  assert.equal(partial.items.find((i) => i.task_id === f.pre)?.status, 'ACCEPTED');
  assert.equal(partial.items.find((i) => i.task_id === f.main)?.status, 'CANDIDATE');
  const main = items.find((i) => i.task_id === f.main)!;
  const next = await post(`${newPlanUrl}/items/${main.id}/resolutions`, { expected_revision: accepted.revision, action: 'ACCEPT', reason: '本段推进' });
  const excluded = items.find((i) => i.task_id === f.other)!;
  await post(`${newPlanUrl}/items/${excluded.id}/resolutions`, { expected_revision: next.revision, action: 'REJECT', reason: '本段排除' });
  assert.deepEqual(await r.tasks.listTasksByIds(f.ids), beforeTasks);
  assert.equal(((await read(`/projects/${f.projectId}/period-plans`)).items as unknown[]).length, 2);
  assert.equal(((await read(`/period-plans/${f.planId}/scope-simulations`)).items as unknown[]).length, 1);
  const runs = await sql<{ count: string }>`select count(*)::text as count from runs where workspace_id = ${workspaceId}`.execute(app.db);
  assert.equal(runs.rows[0]?.count, '0');
});
test('用户标记不可靠估时只生成诊断，选方案本身不建 Task，原逐项入口接受才建一次', async () => {
  const f = await fixture();
  const created = await post(`/period-plans/${f.planId}/scope-simulations`, { ...request(f), unreliable_task_ids: [f.main] });
  const url = `/scope-simulations/${created.simulation_id}`; const view = await read(url); const options = view.options as Option[];
  assert.equal(options[0]?.requested_elapsed_ms, null); assert.equal(options[0]?.capacity_gap_ms, null); assert.equal(options[1]?.feasibility, 'UNKNOWN');
  assert.equal(options[1]?.items.find((i) => i.task_id === f.main)?.kind, 'DIAGNOSTIC');
  const baseline = view.baseline as { estimate_sources: { task_id: string; estimate: { source_note: string }; reliability: string }[] };
  assert.equal(baseline.estimate_sources.find((s) => s.task_id === f.main)?.reliability, 'USER_MARKED_UNRELIABLE');
  assert.equal(baseline.estimate_sources.find((s) => s.task_id === f.main)?.estimate.source_note, '用户声明的整段估时');
  const selected = await post(`${url}/selections`, { expected_revision: '1', confirmed: true, option: 'SHRINK', reason: '先查证据再补估时' });
  const r = createRepositories(app.db); assert.equal((await r.tasks.listProjectTasksByStatus(f.projectId, ['INBOX'])).length, 3);
  const newPlanUrl = `/period-plans/${selected.selected_plan_id}`; const items = (await read(newPlanUrl)).items as Item[];
  const prerequisite = await post(`${newPlanUrl}/items/${items.find((i) => i.task_id === f.pre)!.id}/resolutions`, { expected_revision: '1', action: 'ACCEPT', reason: '保留前置' });
  const diagnostic = items.find((i) => i.task_id === f.main)!;
  const body = { command_id: randomUUID(), expected_revision: prerequisite.revision, action: 'ACCEPT', reason: '阶段诊断' };
  const result = await post(`${newPlanUrl}/items/${diagnostic.id}/resolutions`, body); await post(`${newPlanUrl}/items/${diagnostic.id}/resolutions`, body);
  assert.equal((await r.tasks.listProjectTasksByStatus(f.projectId, ['INBOX'])).length, 4);
  assert.equal((await r.tasks.readTask(f.main))?.status, 'INBOX');
  assert.equal((await r.tasks.readTask(result.created_task_id as string))?.executor_run_id, null);
  const partial = (await read(url)).selected_plan as { items: Item[] };
  assert.equal(partial.items.find((i) => i.task_id === f.main)?.created_task_id, result.created_task_id);
});
test('估时来源变化保留旧比较并要求复核，不能用旧方案创建新计划', async () => {
  const f = await fixture(); const created = await post(`/period-plans/${f.planId}/scope-simulations`, request(f));
  const url = `/scope-simulations/${created.simulation_id}`; const before = await read(url);
  await estimate(f.main, 45, '1');
  const changed = await read(url); assert.deepEqual(changed.options, before.options); assert.ok((changed.stale_reasons as string[]).some((s) => s.includes(f.main)));
  const rejected = await api.post(path(`${url}/selections`), { command_id: randomUUID(), expected_revision: '1', confirmed: true, option: 'SHRINK', reason: '按旧值' });
  assert.equal(rejected.status, 409, rejected.text); assert.equal((await read(url)).selected_plan_id, null);
  assert.equal(((await read(`/projects/${f.projectId}/period-plans`)).items as unknown[]).length, 1);
});
test('原计划部分应用后旧推演不可选，新推演要求重新圈定计划', async () => {
  const f = await fixture(); const created = await post(`/period-plans/${f.planId}/scope-simulations`, request(f));
  const source = await read(`/period-plans/${f.planId}`); const pre = (source.items as Item[]).find((i) => i.task_id === f.pre)!;
  await post(`/period-plans/${f.planId}/items/${pre.id}/resolutions`, { expected_revision: '1', action: 'ACCEPT', reason: '已经开始安排' });
  const rejected = await api.post(path(`/scope-simulations/${created.simulation_id}/selections`), { command_id: randomUUID(), expected_revision: '1', confirmed: true, option: 'DEFER', reason: '旧推演' });
  assert.equal(rejected.status, 409, rejected.text);
  const create = await api.post(path(`/period-plans/${f.planId}/scope-simulations`), { ...request(f), expected_revision: '2' });
  assert.equal(create.status, 409, create.text);
});
