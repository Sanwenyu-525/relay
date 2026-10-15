import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-decision-review-test');
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
async function fixture() {
  const project = await post('/projects', { title: '决定复审基础', project_type: 'GENERAL' }, 201);
  const decision = await post('/decisions', { project_id: project.project_id, title: '暂用现有方案', choice: '继续方案 A',
    rationale: '明确等待来源核对', alternatives: [], costs: [] }, 201);
  const knowledge = await post('/knowledge', { project_id: project.project_id, title: '样本说明', source_kind: 'NOTE', text: '初始来源' }, 201);
  const content = await read(`/knowledge/${knowledge.knowledge_id}/versions/1/content`);
  const reviewsPath = `/projects/${project.project_id}/decision-reviews`;
  return { project, decision, knowledge, content, reviewsPath };
}
type Review = { id: string; status: string; revision: string; applicable: boolean; decision_id: string;
  premise_id: string; before_ref: Record<string, unknown>; after_ref: Record<string, unknown> };
async function reviews(root: string) { return await read(root) as { pending_count: number; items: Review[] }; }

test('资料更新自动准备候选：重复来源命令不重复，保留决定后再次变化沿新基线', async () => {
  const f = await fixture();
  const untouched = await post('/decisions', { project_id: f.project.project_id, title: '没有前提的决定', choice: '原样', rationale: '没有登记前提', alternatives: [], costs: [] }, 201);
  const task = await post('/tasks', { project_id: f.project.project_id, title: '不被复审改变', objective: '交付', criteria: [{ criterion_id: 'c1', statement: '核对' }] }, 201);
  const r = createRepositories(app.db);
  const beforeDecision = await r.information.readRoot('decision', f.decision.decision_id as string);
  const beforeTask = await r.tasks.readTask(task.task_id as string);
  const premisePath = `/decisions/${f.decision.decision_id}/premises`;
  const premise = await post(premisePath, { expected_decision_revision: f.decision.revision, confirmed: true,
    statement: '当前样本支持继续方案 A', knowledge_version_id: f.content.id });
  assert.equal((await read(premisePath)).decision_id, f.decision.decision_id);
  assert.equal((await reviews(f.reviewsPath)).pending_count, 0);
  const updatePath = `/knowledge/${f.knowledge.knowledge_id}/versions`;
  const payload = { command_id: randomUUID(), expected_revision: f.knowledge.revision, source_kind: 'NOTE', text: '新增不利样本' };
  const changed = await post(updatePath, payload);
  assert.equal(changed.decision_review_count, '1');
  assert.equal(changed.decision_review_candidates_ref, `projects/${f.project.project_id}/decision-reviews`);
  const replay = await api.post(path(updatePath), payload);
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.headers['command-replayed'], 'true');
  const current = await reviews(f.reviewsPath);
  assert.equal(current.items.length, 1);
  assert.equal(current.pending_count, 1);
  const candidate = current.items[0]!;
  assert.equal(candidate.decision_id, f.decision.decision_id);
  assert.equal(candidate.before_ref.version, '1');
  assert.equal(candidate.after_ref.version, '2');
  const resolution = { command_id: randomUUID(), expected_revision: candidate.revision, action: 'KEEP_DECISION', reason: '已核对新样本，暂保持原决定' };
  const kept = await post(`/decision-reviews/${candidate.id}/resolutions`, resolution);
  assert.equal(kept.status, 'KEPT');
  assert.equal(kept.revision, '2');
  const again = await api.post(path(`/decision-reviews/${candidate.id}/resolutions`), resolution);
  assert.equal(again.status, 200, again.text);
  const premises = (await read(premisePath)).items as { id: string; revision: string; baseline_ref: { version: string } }[];
  assert.equal(premises[0]?.id, premise.premise_id);
  assert.equal(premises[0]?.revision, '2');
  assert.equal(premises[0]?.baseline_ref.version, '2');
  const third = await post(updatePath, { expected_revision: changed.revision, source_kind: 'NOTE', text: '第三版来源' });
  const older = (await reviews(f.reviewsPath)).items.find((c) => c.status === 'PENDING')!;
  assert.equal(older.before_ref.version, '2');
  const fourth = await post(updatePath, { expected_revision: third.revision, source_kind: 'NOTE', text: '第四版来源' });
  const all = await reviews(f.reviewsPath);
  assert.equal(all.items.length, 3);
  assert.equal(all.pending_count, 1);
  assert.equal(all.items.find((c) => c.id === older.id)?.applicable, false);
  const stale = await api.post(path(`/decision-reviews/${older.id}/resolutions`), {
    command_id: randomUUID(), expected_revision: older.revision, action: 'KEEP_DECISION', reason: '旧依据' });
  assert.equal(stale.status, 409, stale.text);
  const latest = all.items.find((c) => c.applicable)!;
  await post(`/decision-reviews/${latest.id}/resolutions`, { expected_revision: latest.revision, action: 'DISMISS', reason: '本次不处理' });
  assert.equal((await reviews(f.reviewsPath)).pending_count, 0);
  const archived = await post(`/knowledge/${f.knowledge.knowledge_id}/archive`, { expected_revision: fourth.revision });
  assert.equal(archived.decision_review_count, '1');
  assert.equal((await reviews(f.reviewsPath)).pending_count, 1);
  assert.deepEqual(await r.information.readRoot('decision', f.decision.decision_id as string), beforeDecision);
  assert.equal((await r.information.readRoot('decision', untouched.decision_id as string))?.revision, 0n);
  assert.deepEqual(await r.tasks.readTask(task.task_id as string), beforeTask);
  const counts = (await sql<{ checks: string; completions: string; runs: string }>`select
    (select count(*) from check_results)::text as checks, (select count(*) from completion_records)::text as completions,
    (select count(*) from runs)::text as runs`.execute(app.db)).rows[0];
  assert.deepEqual(counts, { checks: '0', completions: '0', runs: '0' });
});

test('关联假设：观察和用户结论准备复审，未确认建议不触发，资料更新传播到已登记前提', async () => {
  const f = await fixture();
  const hypothesis = await post(`/projects/${f.project.project_id}/hypotheses`, { title: '收益假设', confirmed: true,
    claim: '总成本更低', method: '比较样本', criterion: '总成本下降', source_knowledge_version_id: f.content.id }, 201);
  const h = `/hypotheses/${hypothesis.hypothesis_id}`;
  await post(`/decisions/${f.decision.decision_id}/premises`, { expected_decision_revision: f.decision.revision, confirmed: true,
    statement: '收益假设成立时继续原方案', hypothesis_id: hypothesis.hypothesis_id, expected_hypothesis_revision: hypothesis.revision });
  const suggestion = await post(`${h}/suggestions`, { expected_revision: hypothesis.revision, outcome: 'SUPPORTED', rationale: '尚无观察', evidence_sufficient: true, method_reliable: true });
  assert.equal(suggestion.decision_review_count, undefined);
  assert.equal((await reviews(f.reviewsPath)).items.length, 0);
  const observed = await post(`${h}/observations`, { expected_revision: suggestion.revision, summary: '明确选入样本', knowledge_version_id: f.content.id });
  assert.equal(observed.decision_review_count, '1');
  const basisCandidate = (await reviews(f.reviewsPath)).items[0]!;
  const supported = await post(`${h}/suggestions`, { expected_revision: observed.revision, outcome: 'SUPPORTED', rationale: '调用方提交的候选判断', evidence_sufficient: true, method_reliable: true });
  assert.equal((await reviews(f.reviewsPath)).items[0]?.applicable, true);
  const confirmed = await post(`${h}/confirmations`, { expected_revision: supported.revision, suggestion_id: supported.suggestion_id, confirmed: true });
  assert.equal(confirmed.decision_review_count, '1');
  const withConclusion = await reviews(f.reviewsPath);
  assert.equal(withConclusion.items.length, 2);
  assert.equal(withConclusion.items.find((c) => c.id === basisCandidate.id)?.applicable, false);
  assert.equal(withConclusion.items.find((c) => c.applicable)?.after_ref.user_conclusion_applicable, true);
  const material = await post(`/knowledge/${f.knowledge.knowledge_id}/versions`, { expected_revision: f.knowledge.revision, source_kind: 'NOTE', text: '来源已改变' });
  assert.equal(material.decision_review_count, '1');
  const withSource = await reviews(f.reviewsPath);
  assert.equal(withSource.items.length, 3);
  assert.equal(withSource.pending_count, 1);
  assert.equal(withSource.items.find((c) => c.applicable)?.after_ref.user_conclusion_applicable, false);
  const source2 = await read(`/knowledge/${f.knowledge.knowledge_id}/versions/2/content`);
  const nextVersion = await post(`${h}/versions`, { expected_revision: confirmed.revision, claim: '修改主张', method: '比较新样本', criterion: '新的标准', source_knowledge_version_id: source2.id });
  assert.equal(nextVersion.decision_review_count, '1');
  assert.equal((await reviews(f.reviewsPath)).items.length, 4);
  assert.equal((await createRepositories(app.db).information.readRoot('decision', f.decision.decision_id as string))?.status, 'ACTIVE');
});

test('原决定显式替代后旧复审不可行动，替代仍由既有入口完成', async () => {
  const f = await fixture();
  await post(`/decisions/${f.decision.decision_id}/premises`, { expected_decision_revision: f.decision.revision, confirmed: true,
    statement: '原来源仍成立', knowledge_version_id: f.content.id });
  await post(`/knowledge/${f.knowledge.knowledge_id}/versions`, { expected_revision: f.knowledge.revision, source_kind: 'NOTE', text: '来源改变' });
  const candidate = (await reviews(f.reviewsPath)).items[0]!;
  const replacement = await post('/decisions', { project_id: f.project.project_id, title: '新方案', choice: '方案 B', rationale: '用户重新判断', alternatives: [], costs: [] }, 201);
  await post(`/decisions/${f.decision.decision_id}/supersessions`, { expected_revision: f.decision.revision, replacement_decision_id: replacement.decision_id });
  assert.equal((await reviews(f.reviewsPath)).pending_count, 0);
  const response = await api.post(path(`/decision-reviews/${candidate.id}/resolutions`), {
    command_id: randomUUID(), expected_revision: candidate.revision, action: 'KEEP_DECISION', reason: '旧决定已替代' });
  assert.equal(response.status, 409, response.text);
  assert.equal((await createRepositories(app.db).information.readRoot('decision', f.decision.decision_id as string))?.status, 'SUPERSEDED');
});
