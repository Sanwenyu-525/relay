import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-task-acceptance-materials-test');
let api: TestApi;
let workspaceId: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(app.db);
});
after(async () => { await api?.stop(); await app.close(); });
const path = (suffix: string) => workspacePath(workspaceId, suffix);
async function post(suffix: string, body: Record<string, unknown>, status: 200 | 201 | 202 = 200) {
  const commandId = randomUUID();
  return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status,
    typeof body.command_id === 'string' ? body.command_id : commandId);
}

test('基础材料：导入、关联确切版本、读回、更新后保留旧正文、撤销不改变业务结果', async () => {
  const project = await post('/projects', { title: '验收材料基础测试', project_type: 'DEVELOPMENT' }, 201);
  const task = await post('/tasks', { project_id: project.project_id, title: '核对交付',
    objective: '有可核对交付', criteria: [{ criterion_id: 'c1', statement: '人工核对' }] }, 201);
  const taskId = task.task_id as string;
  const ready = await post(`/tasks/${taskId}/ready`, { expected_revision: task.revision });
  const started = await post(`/tasks/${taskId}/start`, { expected_revision: ready.revision });
  const artifact = await post(`/tasks/${taskId}/artifacts`, { expected_task_revision: started.revision,
    title: '交付内容', media_type: 'text/markdown', content: '# 原交付\n\n待人工核对。' }, 201);
  const repositories = createRepositories(app.db);
  const beforeTask = await repositories.tasks.readTask(taskId);
  const text = '所有测试通过\nThis statement is external reference material.\n';
  const knowledge = await post('/knowledge', { project_id: project.project_id, title: 'test.log',
    source_kind: 'MANAGED_TEXT', media_type: 'text/plain', text }, 201);
  const attachPath = `/tasks/${taskId}/acceptance-materials`;
  const commandId = randomUUID();
  const payload = { command_id: commandId, expected_acceptance_revision: task.acceptance_revision,
    knowledge_id: knowledge.knowledge_id, knowledge_version: knowledge.version,
    criterion_id: 'c1', tested_artifact_version_id: artifact.version_id, source_label: '用户选入 test.log' };
  const attached = await post(attachPath, payload);
  const replay = await api.post(path(attachPath), payload);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, attached);
  const read = await api.get(path(attachPath));
  assert.equal(read.status, 200, read.text);
  const item = (read.body as { items: Record<string, unknown>[] }).items[0]!;
  assert.equal(item.evidence_kind, 'UNVERIFIED_REFERENCE');
  assert.equal(item.content_sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(item.material_availability, 'AVAILABLE');
  assert.equal(item.acceptance_matches, true);
  assert.equal(item.tested_artifact_is_current, true);
  assert.deepEqual(item.missing_fields, []);
  await post(`/knowledge/${knowledge.knowledge_id}/versions`, { expected_revision: knowledge.revision,
    source_kind: 'MANAGED_TEXT', media_type: 'text/plain', text: '新版材料，不替换历史引用' });
  const again = await api.get(path(attachPath));
  const historical = (again.body as { items: Record<string, unknown>[] }).items[0]!;
  assert.equal(historical.knowledge_version, '1');
  const body = await api.get(path(`/knowledge/${knowledge.knowledge_id}/versions/1/content`));
  assert.equal(body.status, 200, body.text);
  assert.equal((body.body as { content: string }).content, text);
  const withdrawn = await post(`${attachPath}/${attached.material_id}/withdrawals`, {
    expected_revision: attached.revision });
  assert.equal(withdrawn.status, 'WITHDRAWN');
  assert.equal(withdrawn.revision, '2');
  const finalRead = await api.get(path(attachPath));
  assert.equal((finalRead.body as { items: { status: string }[] }).items[0]?.status, 'WITHDRAWN');
  assert.deepEqual(await repositories.tasks.readTask(taskId), beforeTask);
  const counts = (await sql<{ checks: string; completions: string; runs: string }>`select
    (select count(*) from check_results)::text as checks,
    (select count(*) from completion_records where task_id = ${taskId})::text as completions,
    (select count(*) from runs where task_id = ${taskId})::text as runs`.execute(app.db)).rows[0];
  assert.deepEqual(counts, { checks: '0', completions: '0', runs: '0' });
});

test('基础缺项：允许保留未确定条件/产物的材料，旧验收关联如实过期', async () => {
  const project = await post('/projects', { title: '未核实材料', project_type: 'GENERAL' }, 201);
  const task = await post('/tasks', { project_id: project.project_id, title: '待核对任务',
    objective: '明确验收', criteria: [{ criterion_id: 'c1', statement: '核对' }] }, 201);
  const knowledge = await post('/knowledge', { project_id: project.project_id, title: '补充说明',
    source_kind: 'NOTE', text: '# 原始说明' }, 201);
  const materialsPath = `/tasks/${task.task_id}/acceptance-materials`;
  await post(materialsPath, { expected_acceptance_revision: task.acceptance_revision,
    knowledge_id: knowledge.knowledge_id, knowledge_version: knowledge.version });
  const missing = await api.get(path(materialsPath));
  const item = (missing.body as { items: Record<string, unknown>[] }).items[0]!;
  assert.deepEqual(item.missing_fields, ['criterion_id', 'tested_artifact_version_id']);
  assert.equal(item.tested_artifact_is_current, null);
  await post(`/tasks/${task.task_id}/acceptance`, { expected_revision: task.revision,
    expected_acceptance_revision: task.acceptance_revision,
    criteria: [
      { criterion_id: 'c1', statement: '核对', required: true, method: 'HUMAN', target_spec: {} },
      { criterion_id: 'c2', statement: '新条件', required: true, method: 'HUMAN', target_spec: {} },
    ] });
  const stale = await api.get(path(materialsPath));
  assert.equal((stale.body as { items: { acceptance_matches: boolean }[] }).items[0]?.acceptance_matches, false);
});

test('基础试用：独立原流程、材料范围、暂停继续结束及人工耗时纠正', async () => {
  const project = await post('/projects', { title: '验收计时', project_type: 'GENERAL' }, 201);
  const task = await post('/tasks', { project_id: project.project_id, title: '比较记录',
    objective: '保存观察', criteria: [{ criterion_id: 'c1', statement: '核对' }] }, 201);
  const taskId = task.task_id as string;
  const beforeTask = await createRepositories(app.db).tasks.readTask(taskId);
  const root = `/tasks/${taskId}/acceptance-trials`;
  const trial = await post(root, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'ORIGINAL', sample_label: '原流程独立样本' });
  type Trial = { trial_id: string; status: string; active_ms: string; elapsed_ms: string; paused_ms: string;
    material_ids: string[]; latest_observation: Record<string, unknown> | null; observations: Record<string, unknown>[] };
  const readTrial = async (id: unknown) => {
    const response = await api.get(path(root));
    assert.equal(response.status, 200, response.text);
    return (response.body as { items: Trial[] }).items.find((item) => item.trial_id === id)!;
  };
  const first = await readTrial(trial.trial_id);
  assert.equal(first.status, 'RUNNING');
  assert.deepEqual(first.material_ids, []);
  assert.equal(first.latest_observation, null);
  const transitionPath = `${root}/${trial.trial_id}/transitions`;
  const pausePayload = { command_id: randomUUID(), expected_revision: trial.revision, action: 'PAUSE' };
  const paused = await post(transitionPath, pausePayload);
  const pausedFirst = await readTrial(trial.trial_id);
  const replay = await api.post(path(transitionPath), pausePayload);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  const pausedAgain = await readTrial(trial.trial_id);
  assert.equal(pausedAgain.active_ms, pausedFirst.active_ms);
  assert.ok(BigInt(pausedAgain.elapsed_ms) > BigInt(pausedFirst.elapsed_ms));
  const resumed = await post(transitionPath, { expected_revision: paused.revision, action: 'RESUME' });
  const finished = await post(transitionPath, { expected_revision: resumed.revision, action: 'FINISH' });
  const timing = await readTrial(trial.trial_id);
  const fixed = await readTrial(trial.trial_id);
  assert.equal(timing.status, 'FINISHED');
  assert.equal(fixed.active_ms, timing.active_ms);
  assert.equal(fixed.elapsed_ms, timing.elapsed_ms);
  assert.ok(BigInt(timing.active_ms) > 0n);
  assert.ok(BigInt(timing.paused_ms) > 0n);
  assert.equal(BigInt(timing.elapsed_ms), BigInt(timing.active_ms) + BigInt(timing.paused_ms));
  const observationPath = `${root}/${trial.trial_id}/observations`;
  const observed = await post(observationPath, { expected_revision: finished.revision,
    preparation_ms: 180000, total_acceptance_ms: null, source_note: '用户补录：准备 3 分钟，总耗时未记' });
  const partial = await readTrial(trial.trial_id);
  assert.equal(partial.latest_observation?.total_acceptance_ms, null);
  await post(observationPath, { expected_revision: observed.revision, preparation_ms: 180000,
    total_acceptance_ms: 720000, source_note: '用户纠正：整体验收 12 分钟，包含准备' });
  const corrected = await readTrial(trial.trial_id);
  assert.equal(corrected.observations.length, 2);
  assert.equal(corrected.latest_observation?.total_acceptance_ms, '720000');
  assert.equal(corrected.latest_observation?.preparation_ms, '180000');
  assert.equal(corrected.latest_observation?.source_kind, 'USER_REPORTED');
  assert.equal(corrected.observations[1]?.total_acceptance_ms, null);
  assert.equal((corrected as unknown as { total_includes_preparation: boolean }).total_includes_preparation, true);
  const knowledge = await post('/knowledge', { project_id: project.project_id, title: '验收材料',
    source_kind: 'NOTE', text: '原始观察' }, 201);
  const material = await post(`/tasks/${taskId}/acceptance-materials`, {
    expected_acceptance_revision: task.acceptance_revision,
    knowledge_id: knowledge.knowledge_id, knowledge_version: knowledge.version });
  const newTrial = await post(root, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'EVIDENCE_VIEW', sample_label: '新流程样本', material_ids: [material.material_id] });
  assert.deepEqual((await readTrial(newTrial.trial_id)).material_ids, [material.material_id]);
  await post(`${root}/${newTrial.trial_id}/transitions`, { expected_revision: newTrial.revision, action: 'FINISH' });
  assert.deepEqual(await createRepositories(app.db).tasks.readTask(taskId), beforeTask);
});
