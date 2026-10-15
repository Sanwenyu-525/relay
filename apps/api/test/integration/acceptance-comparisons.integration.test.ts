import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-acceptance-comparisons-test');
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

test('基础比较：先冻结原流程基线，再绑定新试用，保留成本、失败和纠正来源', async () => {
  const project = await post('/projects', { title: '验收比较', project_type: 'GENERAL' }, 201);
  const originalTask = await post('/tasks', { project_id: project.project_id, title: '原流程样本', objective: '原始核对',
    criteria: [{ criterion_id: 'c1', statement: '人工核对' }] }, 201);
  const oldRoot = `/tasks/${originalTask.task_id}/acceptance-trials`;
  const started = await post(oldRoot, { expected_acceptance_revision: originalTask.acceptance_revision,
    mode: 'ORIGINAL', sample_label: '原流程，未选入新材料' });
  await setTimeout(30);
  const finished = await post(`${oldRoot}/${started.trial_id}/transitions`, { expected_revision: started.revision, action: 'FINISH' });
  const observed = await post(`${oldRoot}/${started.trial_id}/observations`, { expected_revision: finished.revision,
    preparation_ms: 30000, total_acceptance_ms: 100000, source_note: '原流程用户记录，含准备成本', correctness_outcome: 'NO_ISSUE_REPORTED' });
  const comparePath = `/projects/${project.project_id}/acceptance-comparisons`;
  const freezePayload = { command_id: randomUUID(), baseline_trial_id: started.trial_id,
    expected_baseline_revision: observed.revision, target_reduction_percent: 100,
    sample_scope: '同项目两个简单任务；材料规模相近，保留顺序和熟悉效应说明' };
  const comparison = await post(comparePath, freezePayload);
  const replay = await api.post(path(comparePath), freezePayload);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, comparison);
  type Comparison = { comparison_id: string; baseline_current: boolean; baseline_revision: string;
    baseline_observation: { total_acceptance_ms: string }; samples: Record<string, unknown>[] };
  const read = async () => {
    const response = await api.get(path(comparePath));
    assert.equal(response.status, 200, response.text);
    return (response.body as { items: Comparison[] }).items[0]!;
  };
  assert.deepEqual((await read()).samples, []);
  const task = await post('/tasks', { project_id: project.project_id, title: '新流程样本', objective: '读取证据',
    criteria: [{ criterion_id: 'c1', statement: '人工核对' }] }, 201);
  const ready = await post(`/tasks/${task.task_id}/ready`, { expected_revision: task.revision });
  const human = await post(`/tasks/${task.task_id}/start`, { expected_revision: ready.revision });
  const artifact = await post(`/tasks/${task.task_id}/artifacts`, { expected_task_revision: human.revision,
    title: '受验产物', media_type: 'text/markdown', content: '# 交付' }, 201);
  const knowledge = await post('/knowledge', { project_id: project.project_id, title: '观察日志', source_kind: 'NOTE', text: '原始记录' }, 201);
  const material = await post(`/tasks/${task.task_id}/acceptance-materials`, { expected_acceptance_revision: task.acceptance_revision,
    knowledge_id: knowledge.knowledge_id, knowledge_version: knowledge.version, criterion_id: 'c1', tested_artifact_version_id: artifact.version_id });
  const beforeTask = await createRepositories(app.db).tasks.readTask(task.task_id as string);
  const newRoot = `/tasks/${task.task_id}/acceptance-trials`;
  const newTrial = await post(newRoot, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'EVIDENCE_VIEW', sample_label: '新流程记录', material_ids: [material.material_id], comparison_id: comparison.comparison_id });
  assert.equal((await read()).samples[0]?.assessment, 'IN_PROGRESS');
  const newEnd = await post(`${newRoot}/${newTrial.trial_id}/transitions`, { expected_revision: newTrial.revision, action: 'FINISH' });
  assert.equal((await read()).samples[0]?.assessment, 'INSUFFICIENT_DATA');
  const newObservation = await post(`${newRoot}/${newTrial.trial_id}/observations`, { expected_revision: newEnd.revision,
    preparation_ms: 60000, total_acceptance_ms: 120000, source_note: '新流程整体变慢，含准备', correctness_outcome: 'NO_ISSUE_REPORTED' });
  const cost = (await read()).samples[0]!;
  assert.equal(cost.assessment, 'TARGET_NOT_MET');
  assert.equal(cost.total_reduction_percent, -20);
  assert.equal(cost.preparation_difference_ms, '30000');
  assert.equal(cost.overall_time_saved, false);
  const correction = await post(`${newRoot}/${newTrial.trial_id}/observations`, { expected_revision: newObservation.revision,
    preparation_ms: 60000, total_acceptance_ms: 90000, source_note: '补充核对发现漏验，不能作为成功样本', correctness_outcome: 'ISSUE_REPORTED' });
  assert.equal((await read()).samples[0]?.assessment, 'CORRECTNESS_ISSUE');
  const other = await post(newRoot, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'EVIDENCE_VIEW', sample_label: '第二次试用未完成', comparison_id: comparison.comparison_id });
  assert.equal((await read()).samples.length, 2);
  assert.ok((await read()).samples.some((s) => s.trial_id === other.trial_id && s.assessment === 'IN_PROGRESS'));
  await post(`${newRoot}/${other.trial_id}/transitions`, { expected_revision: other.revision, action: 'FINISH' });
  await post(`/knowledge/${knowledge.knowledge_id}/versions`, { expected_revision: knowledge.revision, source_kind: 'NOTE', text: '更新材料' });
  assert.equal((await read()).samples[0]?.assessment, 'STALE');
  await post(`${oldRoot}/${started.trial_id}/observations`, { expected_revision: observed.revision,
    preparation_ms: 30000, total_acceptance_ms: 80000, source_note: '更正原流程记录' });
  const stale = await read();
  assert.equal(stale.baseline_current, false);
  assert.equal(stale.baseline_revision, observed.revision);
  assert.equal(stale.baseline_observation.total_acceptance_ms, '100000');
  assert.ok(stale.samples.every((s) => s.assessment === 'STALE'));
  const originals = await api.get(path(`${newRoot}`));
  const newHistory = (originals.body as { items: { trial_id: string; revision: string; observations: unknown[] }[] }).items
    .find((t) => t.trial_id === newTrial.trial_id)!;
  assert.equal(newHistory.revision, correction.revision);
  assert.equal(newHistory.observations.length, 2);
  assert.deepEqual(await createRepositories(app.db).tasks.readTask(task.task_id as string), beforeTask);
});

test('正常改善：查找达到冻结目标且已含准备的整体成本下降', async () => {
  const project = await post('/projects', { title: '正常比较样本', project_type: 'GENERAL' }, 201);
  const task = await post('/tasks', { project_id: project.project_id, title: '同题顺序试用', objective: '记录样本',
    criteria: [{ criterion_id: 'c1', statement: '人工核对' }] }, 201);
  const root = `/tasks/${task.task_id}/acceptance-trials`;
  const baseline = await post(root, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'ORIGINAL', sample_label: '原流程' });
  await setTimeout(300);
  const ended = await post(`${root}/${baseline.trial_id}/transitions`, { expected_revision: baseline.revision, action: 'FINISH' });
  const baselineCost = await post(`${root}/${baseline.trial_id}/observations`, { expected_revision: ended.revision,
    preparation_ms: 0, total_acceptance_ms: 120000, source_note: '原流程人工成本', correctness_outcome: 'NO_ISSUE_REPORTED' });
  const comparePath = `/projects/${project.project_id}/acceptance-comparisons`;
  const comparison = await post(comparePath, { baseline_trial_id: baseline.trial_id,
    expected_baseline_revision: baselineCost.revision, target_reduction_percent: 1,
    sample_scope: '同一任务顺序试用，仅测试数据功能；熟悉效应存在，不证明实际收益' });
  const started = await post(root, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'EVIDENCE_VIEW', sample_label: '使用既有内部证据视图，无外部材料', comparison_id: comparison.comparison_id });
  const newEnd = await post(`${root}/${started.trial_id}/transitions`, { expected_revision: started.revision, action: 'FINISH' });
  await post(`${root}/${started.trial_id}/observations`, { expected_revision: newEnd.revision,
    preparation_ms: 30000, total_acceptance_ms: 90000, source_note: '用户记录总成本，已经包括准备', correctness_outcome: 'NO_ISSUE_REPORTED' });
  const response = await api.get(path(comparePath));
  assert.equal(response.status, 200, response.text);
  const item = (response.body as { items: { evidence_kind: string; samples: Record<string, unknown>[] }[] }).items[0]!;
  assert.equal(item.evidence_kind, 'USER_REPORTED_SAMPLE');
  assert.equal(item.samples[0]?.assessment, 'TARGET_MET');
  assert.equal(item.samples[0]?.overall_time_saved, true);
  assert.equal(item.samples[0]?.total_reduction_percent, 25);
  assert.equal(item.samples[0]?.preparation_difference_ms, '30000');
});
