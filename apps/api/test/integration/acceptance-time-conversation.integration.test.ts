import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { interpretStateMaintenance } from '../../src/application/conversation-state.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { AssistModelPort, ConversationInterpretationRequest } from '../../src/workflow/fake-model-port.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-acceptance-time-conversation-test');
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
  return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status, commandId);
}
async function prepare() {
  const project = await post('/projects', { title: '会话耗时登记', project_type: 'GENERAL' }, 201);
  const task = await post('/tasks', { project_id: project.project_id, title: '核对报告', objective: '保存试用',
    criteria: [{ criterion_id: 'c1', statement: '核对' }] }, 201);
  const root = `/tasks/${task.task_id}/acceptance-trials`;
  const started = await post(root, { expected_acceptance_revision: task.acceptance_revision,
    mode: 'ORIGINAL', sample_label: '原流程一次试用' });
  const trial = await post(`${root}/${started.trial_id}/transitions`, { expected_revision: started.revision, action: 'FINISH' });
  const session = await post('/assist-sessions', { project_id: project.project_id, title: '补录会话' }, 201);
  return { project, task, trial, root, sessionId: session.session_id as string };
}
function port(body: unknown, requests: ConversationInterpretationRequest[] = []): AssistModelPort {
  return { identity: { provider: 'fake', model: 'fake-model-v1', configFingerprint: 'acceptance-time-test' },
    assist: async () => { throw new Error('only interpretation is used'); }, interpret: async (request) => {
      requests.push(request);
      return { kind: 'CONTENT', content: JSON.stringify(body), providerRequestId: 'controlled-interpretation',
        usage: { inputTokens: 1, outputTokens: 1 } };
    } };
}
const candidate = (extra: Record<string, unknown>) => ({ decision: 'MAINTAIN', questions: [], decision_required: null,
  changes: [{ kind: 'REPORT_ACCEPTANCE_TIME', ...extra }] });
async function message(sessionId: string, content: string) {
  return (await post(`/assist-sessions/${sessionId}/messages`, { content }, 202)).user_message_id as string;
}
async function interpret(sessionId: string, sourceMessageId: string, body: unknown, requests?: ConversationInterpretationRequest[]) {
  return interpretStateMaintenance(app.db, { workspaceId, sessionId, sourceMessageId,
    commandId: randomUUID(), modelPort: port(body, requests) });
}
async function apply(requestId: string) {
  const response = await api.post(path(`/conversation-state-requests/${requestId}/applications`), {});
  assert.equal(response.status, 200, response.text);
  return (response.body as { result: { status: string; changes: { status: string; error: unknown }[] } }).result;
}

test('正常一句话：原用户消息到确切试用观察，纠正准备保留总耗时，重放不重复', async () => {
  const f = await prepare();
  const before = await createRepositories(app.db).tasks.readTask(f.task.task_id as string);
  const source = await message(f.sessionId, '请补录这次验收：准备用了 3 分钟，整体验收用了 12 分钟。');
  const requests: ConversationInterpretationRequest[] = [];
  const interpreted = await interpret(f.sessionId, source, candidate({ preparation_ms: 180000, total_acceptance_ms: 720000 }), requests);
  assert.equal(interpreted.result.request.status, 'READY');
  assert.ok(requests[0]?.system.includes('REPORT_ACCEPTANCE_TIME'));
  assert.ok(requests[0]?.userContent.includes('原流程一次试用'));
  assert.equal(interpreted.result.changes[0]?.baseline_ref?.trial_id, f.trial.trial_id);
  assert.equal(interpreted.result.changes[0]?.baseline_ref?.trial_revision, f.trial.revision);
  assert.equal((await apply(interpreted.result.request.id)).status, 'APPLIED');
  assert.equal((await apply(interpreted.result.request.id)).status, 'APPLIED');
  const r = createRepositories(app.db);
  const observations = await r.acceptanceTrials.observations(f.trial.trial_id as string);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.preparation_ms, 180000n);
  assert.equal(observations[0]?.total_acceptance_ms, 720000n);
  assert.equal(observations[0]?.source_message_id, source);
  const correctionMessage = await message(f.sessionId, '请补录准备改为 4 分钟。');
  const correction = await interpret(f.sessionId, correctionMessage, candidate({ preparation_ms: 240000 }));
  assert.equal((await apply(correction.result.request.id)).status, 'APPLIED');
  const history = await r.acceptanceTrials.observations(f.trial.trial_id as string);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.preparation_ms, 240000n);
  assert.equal(history[0]?.total_acceptance_ms, 720000n);
  assert.equal(history[0]?.source_message_id, correctionMessage);
  assert.equal(history[1]?.preparation_ms, 180000n);
  const read = await api.get(path(f.root));
  assert.equal(read.status, 200, read.text);
  assert.equal((read.body as { items: { latest_observation: { source_message_id: string } }[] }).items[0]?.latest_observation.source_message_id,
    correctionMessage);
  const discussion = await interpret(f.sessionId, await message(f.sessionId, '准备 3 分钟够吗？'), { decision: 'DISCUSS' });
  assert.equal(discussion.result.request.status, 'DISCUSSED');
  assert.equal((await r.acceptanceTrials.observations(f.trial.trial_id as string)).length, 2);
  assert.deepEqual(await r.tasks.readTask(f.task.task_id as string), before);
});

test('多条试用与缺单位先澄清，指定确切任务/标签后再补录', async () => {
  const f = await prepare();
  const other = await post(f.root, { expected_acceptance_revision: f.task.acceptance_revision,
    mode: 'EVIDENCE_VIEW', sample_label: '证据流程另一次' });
  const ambiguous = await interpret(f.sessionId, await message(f.sessionId, '请补录准备 3 分钟。'), candidate({ preparation_ms: 180000 }));
  assert.equal(ambiguous.result.request.status, 'CLARIFY');
  assert.equal(ambiguous.result.changes.length, 0);
  const precise = await interpret(f.sessionId, await message(f.sessionId, '请给核对报告的原流程一次试用补录：准备 3 分钟。'),
    candidate({ task_title: '核对报告', sample_label: '原流程一次试用', preparation_ms: 180000 }));
  assert.equal((await apply(precise.result.request.id)).status, 'APPLIED');
  const missing = await interpret(f.sessionId, await message(f.sessionId, '请给原流程一次试用补录准备 3。'),
    candidate({ sample_label: '原流程一次试用', preparation_ms: 180000 }));
  assert.equal(missing.result.request.status, 'CLARIFY');
  assert.equal(missing.result.changes.length, 0);
  assert.equal((await createRepositories(app.db).acceptanceTrials.observations(f.trial.trial_id as string)).length, 1);
  assert.equal((await createRepositories(app.db).acceptanceTrials.observations(other.trial_id as string)).length, 0);
  await post(`${f.root}/${other.trial_id}/transitions`, { expected_revision: other.revision, action: 'FINISH' });
});

test('已解释补录不覆盖后来手动登记的试用版本', async () => {
  const f = await prepare();
  const source = await message(f.sessionId, '请补录准备 3 分钟。');
  const interpreted = await interpret(f.sessionId, source, candidate({ preparation_ms: 180000 }));
  await post(`${f.root}/${f.trial.trial_id}/observations`, { expected_revision: f.trial.revision,
    preparation_ms: 60000, total_acceptance_ms: 300000, source_note: '后来手动核实' });
  const applied = await apply(interpreted.result.request.id);
  assert.equal(applied.status, 'FAILED');
  const observations = await createRepositories(app.db).acceptanceTrials.observations(f.trial.trial_id as string);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.preparation_ms, 60000n);
  assert.equal(observations[0]?.source_message_id, null);
});
