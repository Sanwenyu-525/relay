import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { interpretStateMaintenance } from '../../src/application/conversation-state.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { AssistModelPort } from '../../src/workflow/fake-model-port.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-work-segment-test');
let api: TestApi;
let workspaceId: string;
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); api = await startTestApi(); workspaceId = await createWorkspace(app.db); });
after(async () => { await api?.stop(); await app.close(); });
const path = (suffix: string) => workspacePath(workspaceId, suffix);
async function post(suffix: string, body: Record<string, unknown>, status: 200 | 201 | 202 = 200) {
  const commandId = typeof body.command_id === 'string' ? body.command_id : randomUUID();
  return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status, commandId);
}
async function read(suffix: string) {
  const response = await api.get(path(suffix)); assert.equal(response.status, 200, response.text);
  return response.body as Record<string, unknown>;
}
async function fixture() {
  const project = await post('/projects', { title: '工作段基础', project_type: 'GENERAL' }, 201);
  const tasks = [];
  for (const title of ['核对报告', '补齐说明']) tasks.push(await post('/tasks', { project_id: project.project_id, title,
    objective: `完成${title}`, criteria: [{ criterion_id: 'c1', statement: '人工核对', method: 'HUMAN' }] }, 201));
  return { project, tasks };
}
const selection = (tasks: Record<string, unknown>[]) => tasks.map((t) => ({ task_id: t.task_id, expected_revision: t.revision, expected_acceptance_revision: t.acceptance_revision }));
async function complete(taskId: string) {
  const r = createRepositories(app.db);
  const task = (await r.tasks.readTask(taskId))!;
  const ready = await post(`/tasks/${taskId}/ready`, { expected_revision: task.revision.toString() });
  const started = await post(`/tasks/${taskId}/start`, { expected_revision: ready.revision });
  const artifact = await post(`/tasks/${taskId}/artifacts`, { expected_task_revision: started.revision, title: '交付内容', media_type: 'text/markdown', content: '# 已核对交付' }, 201);
  const current = (await r.tasks.readTask(taskId))!;
  return post(`/tasks/${taskId}/complete`, { expected_revision: current.revision.toString(), acceptance_revision: current.acceptance_revision.toString(),
    artifact_version_ids: [artifact.version_id], acceptance: { statement: '明确接受交付', accepted_criterion_ids: ['c1'] } });
}

test('工作段保存预期、记录本段验收产出与部分用量，事件确认/撤回不改结束快照', async () => {
  const f = await fixture();
  const r = createRepositories(app.db);
  const before = await r.tasks.readTask(f.tasks[0]!.task_id as string);
  const payload = { command_id: randomUUID(), confirmed: true, title: '本次工作段', expectation: '按原验收完成两项任务', tasks: selection(f.tasks) };
  const root = `/projects/${f.project.project_id}/work-segments`;
  const started = await post(root, payload);
  const replay = await api.post(path(root), payload); assert.equal(replay.status, 200, replay.text); assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual(await r.tasks.readTask(f.tasks[0]!.task_id as string), before);
  const segment = `/work-segments/${started.segment_id}`;
  const original = await read(segment);
  assert.equal(original.expectation, payload.expectation);
  assert.equal(((original.baseline as { tasks: Record<string, unknown>[] }).tasks[0]?.acceptance as Record<string, unknown>).objective, '完成核对报告');
  const session = await post('/assist-sessions', { task_id: f.tasks[0]!.task_id, title: '范围内调用记录' }, 201);
  const sent = await post(`/assist-sessions/${session.session_id}/messages`, { content: '记录夹具用量' }, 202);
  const calls = new ModelCallRepository(app.db);
  const identity = { provider: 'fake', model: 'fake-model-v1', configFingerprint: 'a'.repeat(64) };
  const call1 = randomUUID(); await calls.begin(call1, { workspaceId, kind: 'ASSIST', assistMessageId: sent.assistant_message_id as string }, identity);
  await calls.settle(call1, { status: 'COMPLETED', usage: { inputTokens: 42, outputTokens: 12 } });
  const call2 = randomUUID(); await calls.begin(call2, { workspaceId, kind: 'ASSIST', assistMessageId: sent.assistant_message_id as string }, identity);
  await calls.settle(call2, { status: 'FAILED', errorKind: 'FIXTURE' });
  const completion = await complete(f.tasks[0]!.task_id as string);
  const event = await post(`${segment}/events`, { expected_revision: started.revision, kind: 'REWORK', task_id: f.tasks[0]!.task_id, description: '疑似返工，待用户确认' });
  assert.equal(((await read(segment)).event_statistics as { rework_count: number }).rework_count, 0);
  const ended = await post(`${segment}/finishes`, { expected_revision: event.revision });
  assert.equal(ended.status, 'FINISHED');
  const finished = await read(segment);
  const actual = finished.actual as { accepted_output_count: number; tasks: Record<string, unknown>[]; model_usage: Record<string, unknown> };
  assert.equal(actual.accepted_output_count, 1);
  assert.equal(actual.tasks[0]?.completion_id, completion.completion_id);
  assert.equal(actual.tasks[0]?.outcome, 'ACCEPTED_OUTPUT');
  assert.equal(actual.tasks[1]?.outcome, 'NOT_ACCEPTED');
  assert.equal(actual.model_usage.recorded_call_count, 2);
  assert.deepEqual(actual.model_usage.input, { known_tokens: '42', total_tokens: null, missing_calls: 1 });
  assert.equal(actual.model_usage.monetary_cost, null);
  const confirmPayload = { command_id: randomUUID(), expected_revision: event.event_revision, action: 'CONFIRM', reason: '用户确认本次是返工' };
  const confirmed = await post(`/work-segment-events/${event.event_id}/resolutions`, confirmPayload);
  await post(`/work-segment-events/${event.event_id}/resolutions`, confirmPayload);
  assert.equal(((await read(segment)).event_statistics as { rework_count: number }).rework_count, 1);
  const withdrawn = await post(`/work-segment-events/${event.event_id}/resolutions`, { expected_revision: confirmed.event_revision, action: 'WITHDRAW', reason: '核对后撤回返工判断' });
  const after = await read(segment);
  assert.equal((after.event_statistics as { rework_count: number }).rework_count, 0);
  assert.deepEqual(after.actual, actual);
  assert.equal((after.events as { history: unknown[] }[])[0]?.history.length, 2);
  const intervention = await post(`${segment}/events`, { expected_revision: withdrawn.revision, kind: 'HUMAN_INTERVENTION', description: '用户补录介入', duration_ms: 300000 });
  await post(`/work-segment-events/${intervention.event_id}/resolutions`, { expected_revision: intervention.event_revision, action: 'CONFIRM', reason: '用户确认 5 分钟介入' });
  assert.equal(((await read(segment)).event_statistics as { known_intervention_ms: string }).known_intervention_ms, '300000');
  const unrecorded = await post('/tasks', { project_id: f.project.project_id, title: '无历史预期任务', objective: '尚无本段记录', criteria: [{ criterion_id: 'c1', statement: '核对' }] }, 201);
  const temporary = await api.post(path(`/projects/${f.project.project_id}/retrospectives`), { task_ids: [f.tasks[1]!.task_id, unrecorded.task_id] });
  assert.equal(temporary.status, 200, temporary.text);
  assert.equal((temporary.body as { baseline_status: string }).baseline_status, 'PARTIAL');
  assert.equal((temporary.body as { expectation: unknown }).expectation, null);
  const retrospectiveTasks = (temporary.body as { tasks: { baseline_status: string; expectation: string | null; segment_id: string | null }[] }).tasks;
  assert.equal(retrospectiveTasks[0]?.expectation, payload.expectation);
  assert.equal(retrospectiveTasks[0]?.segment_id, started.segment_id);
  assert.equal(retrospectiveTasks[1]?.baseline_status, 'UNKNOWN');
  assert.equal(retrospectiveTasks[1]?.expectation, null);
  assert.equal(((await read(root)).items as unknown[]).length, 1);
  const counts = (await sql<{ runs: string; done: string }>`select (select count(*) from runs)::text as runs,
    (select count(*) from completion_records)::text as done`.execute(app.db)).rows[0];
  assert.deepEqual(counts, { runs: '0', done: '1' });
});

test('已有完成不算本段产出，验收版本变化与原预期分别保留', async () => {
  const f = await fixture();
  await complete(f.tasks[0]!.task_id as string);
  const current = (await createRepositories(app.db).tasks.readTask(f.tasks[0]!.task_id as string))!;
  const started = await post(`/projects/${f.project.project_id}/work-segments`, { confirmed: true, title: '新工作段', expectation: '保留开始预期',
    tasks: [{ task_id: current.id, expected_revision: current.revision.toString(), expected_acceptance_revision: current.acceptance_revision.toString() }, ...selection([f.tasks[1]!])] });
  await post(`/tasks/${f.tasks[1]!.task_id}/acceptance`, { expected_revision: f.tasks[1]!.revision, expected_acceptance_revision: f.tasks[1]!.acceptance_revision,
    criteria: [{ criterion_id: 'c1', statement: '人工核对', required: true, method: 'HUMAN', target_spec: {} }, { criterion_id: 'c2', statement: '新要求', required: true, method: 'HUMAN', target_spec: {} }] });
  const root = `/work-segments/${started.segment_id}`;
  await post(`${root}/finishes`, { expected_revision: started.revision });
  const report = await read(root);
  const actual = report.actual as { accepted_output_count: number; tasks: { outcome: string }[] };
  assert.equal(actual.accepted_output_count, 0);
  assert.equal(actual.tasks[0]?.outcome, 'ALREADY_ACCEPTED_BEFORE_SEGMENT');
  assert.equal(actual.tasks[1]?.outcome, 'BASELINE_CHANGED');
  assert.equal((report.baseline as { tasks: { acceptance_revision: string }[] }).tasks[1]?.acceptance_revision, '1');
});

test('一句话保存既有任务预期，不创建或启动任务；未找到范围先澄清', async () => {
  const f = await fixture();
  const session = await post('/assist-sessions', { project_id: f.project.project_id, title: '复盘会话' }, 201);
  const run = async (content: string, title: string) => {
    const message = await post(`/assist-sessions/${session.session_id}/messages`, { content }, 202);
    const modelPort: AssistModelPort = { identity: { provider: 'fake', model: 'fake-model-v1', configFingerprint: 'work-segment-test' },
      assist: async () => { throw new Error('only interpretation is used'); }, interpret: async () => ({ kind: 'CONTENT',
        content: JSON.stringify({ decision: 'MAINTAIN', decision_required: null, changes: [{ kind: 'START_WORK_SEGMENT', title: '会话工作段', expectation: '按原验收完成', task_titles: [title] }] }),
        providerRequestId: 'controlled', usage: { inputTokens: 1, outputTokens: 1 } }) };
    const outcome = await interpretStateMaintenance(app.db, { workspaceId, sessionId: session.session_id as string, sourceMessageId: message.user_message_id as string, commandId: randomUUID(), modelPort });
    return { outcome, messageId: message.user_message_id };
  };
  const before = await createRepositories(app.db).tasks.readTask(f.tasks[0]!.task_id as string);
  const requested = await run('接下来做核对报告，预期按原验收完成，结束后复盘。', '核对报告');
  const applied = await api.post(path(`/conversation-state-requests/${requested.outcome.result.request.id}/applications`), {});
  assert.equal(applied.status, 200, applied.text);
  assert.equal((applied.body as { result: { status: string } }).result.status, 'APPLIED');
  const items = (await read(`/projects/${f.project.project_id}/work-segments`)).items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source_message_id, requested.messageId);
  assert.deepEqual(await createRepositories(app.db).tasks.readTask(f.tasks[0]!.task_id as string), before);
  const missing = await run('接下来做未登记任务，结束后复盘。', '未登记任务');
  assert.equal(missing.outcome.result.request.status, 'CLARIFY');
  assert.equal(((await read(`/projects/${f.project.project_id}/work-segments`)).items as unknown[]).length, 1);
});
