import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { interpretStateMaintenance } from '../../src/application/conversation-state.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { AssistModelPort } from '../../src/workflow/fake-model-port.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-hypotheses-test');
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
  const commandId = typeof body.command_id === 'string' ? body.command_id : randomUUID();
  return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status, commandId);
}
async function read(suffix: string) {
  const response = await api.get(path(suffix));
  assert.equal(response.status, 200, response.text);
  return response.body as Record<string, unknown>;
}
const definition = { claim: '验收视图降低总核对成本', method: '记录相近任务样本并保留准备成本', criterion: '总成本相对下降 20%' };

test('基础假设：建档/观察/建议/用户确认/新定义保留历史，结论不改变任务或正式验收', async () => {
  const project = await post('/projects', { title: '假设记录', project_type: 'GENERAL' }, 201);
  const task = await post('/tasks', { project_id: project.project_id, title: '尚未完成任务', objective: '真实交付',
    criteria: [{ criterion_id: 'c1', statement: '人工核对' }] }, 201);
  const beforeTask = await createRepositories(app.db).tasks.readTask(task.task_id as string);
  const createPath = `/projects/${project.project_id}/hypotheses`;
  const payload = { command_id: randomUUID(), title: '减少验收投入', confirmed: true, ...definition };
  const hypothesis = await post(createPath, payload, 201);
  const replay = await api.post(path(createPath), payload);
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.deepEqual((replay.body as { result: unknown }).result, hypothesis);
  const root = `/hypotheses/${hypothesis.hypothesis_id}`;
  const empty = await post(`${root}/suggestions`, { expected_revision: hypothesis.revision,
    outcome: 'SUPPORTED', rationale: '尚无记录', evidence_sufficient: true, method_reliable: true });
  assert.equal(empty.outcome, 'INCONCLUSIVE');
  assert.equal(empty.recommendation, 'COLLECT_MORE_EVIDENCE');
  assert.equal((await read(root)).current_user_conclusion, null);
  const observed = await post(`${root}/observations`, { expected_revision: empty.revision, summary: '用户记录：计入准备后总成本没有下降' });
  const suggestion = await post(`${root}/suggestions`, { expected_revision: observed.revision, outcome: 'NOT_SUPPORTED',
    rationale: '当前样本不支持目标收益', evidence_sufficient: true, method_reliable: true });
  assert.equal(suggestion.recommendation, 'STOP_NEXT_STAGE');
  assert.equal((await read(root)).current_user_conclusion, null);
  const confirmed = await post(`${root}/confirmations`, { expected_revision: suggestion.revision,
    suggestion_id: suggestion.suggestion_id, confirmed: true });
  const accepted = await read(root);
  const conclusion = accepted.current_user_conclusion as Record<string, unknown>;
  assert.equal(conclusion.kind, 'USER_CONFIRMED');
  assert.equal(conclusion.outcome, 'NOT_SUPPORTED');
  assert.equal(conclusion.applicable, true);
  const next = await post(`${root}/observations`, { expected_revision: confirmed.revision, summary: '新增不同任务的观察，等待重新判断' });
  assert.equal(((await read(root)).current_user_conclusion as Record<string, unknown>).applicable, false);
  const stale = await api.post(path(`${root}/confirmations`), { command_id: randomUUID(),
    expected_revision: next.revision, suggestion_id: suggestion.suggestion_id, confirmed: true });
  assert.equal(stale.status, 409, stale.text);
  const version = await post(`${root}/versions`, { expected_revision: next.revision, ...definition, criterion: '新版目标：总成本下降 10%' });
  assert.equal(version.version, '2');
  const historical = await read(root);
  const versions = historical.versions as Record<string, unknown>[];
  assert.equal(versions.length, 2);
  assert.equal(versions[1]?.criterion, definition.criterion);
  assert.equal((historical.observations as unknown[]).length, 2);
  assert.equal((historical.conclusions as unknown[]).length, 3);
  assert.equal(((await read(createPath)).items as unknown[]).length, 1);
  assert.deepEqual(await createRepositories(app.db).tasks.readTask(task.task_id as string), beforeTask);
  const counts = (await sql<{ checks: string; completions: string; runs: string }>`select
    (select count(*) from check_results)::text as checks,
    (select count(*) from completion_records)::text as completions,
    (select count(*) from runs)::text as runs`.execute(app.db)).rows[0];
  assert.deepEqual(counts, { checks: '0', completions: '0', runs: '0' });
});

test('确切资料来源更新后保留原引用，用户结论显示不再适用', async () => {
  const project = await post('/projects', { title: '来源假设', project_type: 'GENERAL' }, 201);
  const knowledge = await post('/knowledge', { project_id: project.project_id, title: '原始资料', source_kind: 'NOTE', text: '原始样本说明' }, 201);
  const content = await read(`/knowledge/${knowledge.knowledge_id}/versions/1/content`);
  const hypothesis = await post(`/projects/${project.project_id}/hypotheses`, { title: '有来源的主张', confirmed: true,
    ...definition, source_knowledge_version_id: content.id }, 201);
  const root = `/hypotheses/${hypothesis.hypothesis_id}`;
  const observed = await post(`${root}/observations`, { expected_revision: hypothesis.revision,
    summary: '用户选入材料供核对', knowledge_version_id: content.id });
  const suggestion = await post(`${root}/suggestions`, { expected_revision: observed.revision, outcome: 'SUPPORTED',
    rationale: '调用方提交的候选判断', evidence_sufficient: true, method_reliable: true });
  await post(`${root}/confirmations`, { expected_revision: suggestion.revision, suggestion_id: suggestion.suggestion_id, confirmed: true });
  await post(`/knowledge/${knowledge.knowledge_id}/versions`, { expected_revision: knowledge.revision, source_kind: 'NOTE', text: '更新后的来源' });
  const projected = await read(root);
  const version = (projected.versions as Record<string, unknown>[])[0]!;
  assert.equal(version.source_knowledge_version_id, content.id);
  assert.equal(version.source_status, 'STALE');
  assert.equal((projected.current_user_conclusion as Record<string, unknown>).applicable, false);
  assert.equal((projected.observations as Record<string, unknown>[])[0]?.evidence_kind, 'UNVERIFIED_REFERENCE');
  const staleSuggestion = await post(`${root}/suggestions`, { expected_revision: projected.revision, outcome: 'SUPPORTED',
    rationale: '资料已变化，尚需重新核对', evidence_sufficient: true, method_reliable: true });
  assert.equal(staleSuggestion.outcome, 'INCONCLUSIVE');
  assert.equal(staleSuggestion.recommendation, 'COLLECT_MORE_EVIDENCE');
});

test('一句话建档复用原会话：明确请求才建档，缺定义先澄清，原消息来源可读', async () => {
  const project = await post('/projects', { title: '会话假设', project_type: 'GENERAL' }, 201);
  const session = await post('/assist-sessions', { project_id: project.project_id, title: '想法会话' }, 201);
  const interpret = async (text: string, body: unknown) => {
    const message = await post(`/assist-sessions/${session.session_id}/messages`, { content: text }, 202);
    const modelPort: AssistModelPort = { identity: { provider: 'fake', model: 'fake-model-v1', configFingerprint: 'hypothesis-test' },
      assist: async () => { throw new Error('only interpretation is used'); },
      interpret: async () => ({ kind: 'CONTENT', content: JSON.stringify(body), providerRequestId: 'controlled', usage: { inputTokens: 1, outputTokens: 1 } }) };
    const result = await interpretStateMaintenance(app.db, { workspaceId, sessionId: session.session_id as string,
      sourceMessageId: message.user_message_id as string, commandId: randomUUID(), modelPort });
    return { result, sourceId: message.user_message_id };
  };
  const discussed = await interpret('是否值得把想法记成假设？', { decision: 'DISCUSS' });
  assert.equal(discussed.result.result.request.status, 'DISCUSSED');
  const missing = await interpret('把想法记成假设', { decision: 'MAINTAIN', decision_required: null,
    changes: [{ kind: 'CREATE_HYPOTHESIS', title: '缺定义', claim: '成本更低' }] });
  assert.equal(missing.result.result.request.status, 'CLARIFY');
  const requested = await interpret('把这个想法记成假设：验收视图降低总成本，记录相近样本，下降20%为目标。', {
    decision: 'MAINTAIN', decision_required: null, changes: [{ kind: 'CREATE_HYPOTHESIS', title: '会话明确建档', ...definition }] });
  const response = await api.post(path(`/conversation-state-requests/${requested.result.result.request.id}/applications`), {});
  assert.equal(response.status, 200, response.text);
  assert.equal((response.body as { result: { status: string } }).result.status, 'APPLIED');
  const items = (await read(`/projects/${project.project_id}/hypotheses`)).items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal((items[0]?.versions as Record<string, unknown>[])[0]?.source_message_id, requested.sourceId);
});
