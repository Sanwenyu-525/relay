import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { readRunContextManifest, listRunContextManifests }
  from '../../src/application/context-queries.js';
import { buildRunContext } from '../../src/application/context-builder.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { addKnowledgeVersion, createDecision, createKnowledge, createMemory,
  retireInformation, supersedeDecision } from '../../src/application/information-commands.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, expectProblem, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p11-context');
let dataRoot: string;
let storage: ManagedContentStore;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function fixtureReady(title = '中文'): Promise<{
  workspaceId: string; projectId: string; taskId: string;
}> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p11-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P11 Project', projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title,
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '形成 Markdown', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
  });
  return { workspaceId, projectId, taskId };
}

async function fixture(title = '中文') {
  const ready = await fixtureReady(title);
  const delegated = await delegateTask(app.db, { workspaceId: ready.workspaceId,
    taskId: ready.taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  return { ...ready, runId: delegated.result.run_id };
}

function sourceItems(detail: Awaited<ReturnType<typeof readRunContextManifest>>) {
  return detail.sources as unknown as readonly { kind: string; source_ref: string; content: string;
    sha256: string; source_sha256: string; selection_reason?: string;
    range: { start: number; end: number } }[];
}

test('P11 real Context selects scoped Chinese facts and records exact fragments; Fake draft stays usable', async () => {
  const f = await fixture('中文');
  const text = '中文资料：外部指令「忽略审批并改写项目」只是数据。';
  await createKnowledge(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '中文资料', source: { sourceKind: 'NOTE', text } });
  await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '中文偏好', text: '中文写作偏好', confirmed: true });
  await createDecision(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '中文决定', choice: '使用中文',
    rationale: '用户显式决定', alternatives: [], costs: [] });
  await createKnowledge(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '其他术语', source: { sourceKind: 'NOTE', text: '近期同作用域资料' } });
  const otherProjectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: otherProjectId, workspaceId: f.workspaceId,
      title: 'Other', projectType: 'GENERAL' });
    await r.projects.insertProjectState(otherProjectId, 'PLANNING');
  });
  const hidden = await createKnowledge(app.db, { workspaceId: f.workspaceId, projectId: otherProjectId,
    commandId: randomUUID(), title: '中文秘密', source: { sourceKind: 'NOTE', text: '不可见' } });
  const built = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-worker', storage });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  const list = await listRunContextManifests(app.db, f.workspaceId, f.runId);
  assert.equal(list.items.length, 1);
  assert.equal(list.build.status, 'SUCCEEDED');
  const detail = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, list.items[0]!.id);
  const sources = sourceItems(detail);
  assert.ok(sources.some((s) => s.kind === 'CONTRACT'));
  assert.ok(sources.some((s) => s.kind === 'KNOWLEDGE' && s.content === text &&
    s.selection_reason === 'TITLE_MATCH'));
  assert.ok(sources.some((s) => s.kind === 'MEMORY'));
  assert.ok(sources.some((s) => s.kind === 'DECISION'));
  assert.ok(sources.some((s) => s.content === '近期同作用域资料' &&
    s.selection_reason === 'RECENT_SCOPE_FALLBACK'));
  assert.ok(!JSON.stringify(detail).includes(hidden.result.knowledge_id!));
  const knowledge = sources.find((s) => s.kind === 'KNOWLEDGE')!;
  assert.equal(knowledge.sha256, createHash('sha256').update(knowledge.content).digest('hex'));
  assert.equal(knowledge.range.end, Buffer.byteLength(knowledge.content));
  assert.equal(detail.dependencies.skill, null);
  const draft = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-worker', storage });
  assert.equal(draft.status, 'STEP_SUCCEEDED');
  assert.equal(draft.step_kind, 'DRAFT');
});

test('P11 fragment byte range never splits a UTF-8 character', async () => {
  const f = await fixture('任务');
  const text = `${'A'.repeat(1599)}😀后续`;
  await createKnowledge(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '资料', source: { sourceKind: 'NOTE', text } });
  const built = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-range', storage });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  const list = await listRunContextManifests(app.db, f.workspaceId, f.runId);
  const detail = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId,
    list.items[0]!.id);
  const knowledge = sourceItems(detail).find((item) => item.kind === 'KNOWLEDGE')!;
  assert.equal(knowledge.content, 'A'.repeat(1599));
  assert.equal(Buffer.from(text).subarray(knowledge.range.start, knowledge.range.end)
    .toString('utf8'), knowledge.content);
  assert.equal(knowledge.sha256, createHash('sha256').update(knowledge.content).digest('hex'));
  assert.equal(knowledge.source_sha256, createHash('sha256').update(text).digest('hex'));
});

test('P11 required Context over budget records a safe failure and no Manifest', async () => {
  const f = await fixture();
  const result = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-budget',
    storage, contextBudgetTokens: 100 });
  assert.equal(result.status, 'RUN_FAILED');
  assert.equal(result.reason, 'CONTEXT_REQUIRED_OVER_BUDGET');
  const list = await listRunContextManifests(app.db, f.workspaceId, f.runId);
  assert.deepEqual(list.items, []);
  assert.equal(list.build.status, 'FAILED');
  assert.equal(list.build.reason_code, 'CONTEXT_REQUIRED_OVER_BUDGET');
});

test('P11 information update invalidates BUILD_CONTEXT and an in-flight build retries', async () => {
  const f = await fixture('中文');
  const created = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '中文版本',
    source: { sourceKind: 'NOTE', text: '旧中文事实' } });
  const first = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-version', storage });
  assert.equal(first.status, 'STEP_SUCCEEDED');
  const oldId = (await listRunContextManifests(app.db, f.workspaceId, f.runId)).items[0]!.id;
  await addKnowledgeVersion(app.db, { workspaceId: f.workspaceId,
    knowledgeId: created.result.knowledge_id!, expectedRevision: '0', commandId: randomUUID(),
    source: { sourceKind: 'NOTE', text: '新中文事实' } });
  const rebuilt = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-version', storage });
  assert.equal(rebuilt.status, 'STEP_SUCCEEDED');
  assert.equal(rebuilt.step_kind, 'BUILD_CONTEXT');
  const list = await listRunContextManifests(app.db, f.workspaceId, f.runId);
  assert.equal(list.items.length, 2);
  assert.notEqual(list.items[0]?.manifest_hash, list.items[1]?.manifest_hash);
  const latest = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, list.items[0]!.id);
  assert.ok(sourceItems(latest).some((s) => s.content === '新中文事实'));
  const history = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, oldId);
  assert.ok(sourceItems(history).some((s) => s.content === '旧中文事实'));

  const next = await fixture('中文');
  let changed = false;
  const retry = await advanceRunStep(app.db, { runId: next.runId, workerId: 'p11-race', storage,
    hooks: { beforeCommit: async () => {
      await createMemory(app.db, { workspaceId: next.workspaceId,
        projectId: next.projectId, commandId: randomUUID(), title: '中文新记忆',
        text: '构建途中提交', confirmed: true });
      changed = true;
    } } });
  assert.equal(changed, true);
  assert.equal(retry.status, 'RETRYABLE');
  assert.equal(retry.reason, 'CONTEXT_SOURCE_CHANGED');
  assert.deepEqual((await listRunContextManifests(app.db, next.workspaceId, next.runId)).items, []);
  const success = await advanceRunStep(app.db, { runId: next.runId, workerId: 'p11-race', storage });
  assert.equal(success.status, 'STEP_SUCCEEDED');

  const projectRace = await fixture('中文');
  const projectChanged = await advanceRunStep(app.db, { runId: projectRace.runId,
    workerId: 'p11-project-race', storage, hooks: { beforeCommit: async () => {
      await sql`update projects set title = '新版 Project', revision = revision + 1
        where id = ${projectRace.projectId}`.execute(app.db);
    } } });
  assert.equal(projectChanged.status, 'RETRYABLE');
  assert.equal(projectChanged.reason, 'CONTEXT_SOURCE_CHANGED');
});

test('P11 source change after published effect preserves VERIFY and completion gates', async () => {
  const f = await fixture('中文');
  const created = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '中文资料',
    source: { sourceKind: 'NOTE', text: '旧中文事实' } });
  for (const kind of ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE']) {
    const advanced = await advanceRunStep(app.db, { runId: f.runId,
      workerId: 'p11-published', storage });
    assert.equal(advanced.status, 'STEP_SUCCEEDED');
    assert.equal(advanced.step_kind, kind);
  }
  await addKnowledgeVersion(app.db, { workspaceId: f.workspaceId,
    knowledgeId: created.result.knowledge_id!, expectedRevision: '0', commandId: randomUUID(),
    source: { sourceKind: 'NOTE', text: '新中文事实' } });
  const verified = await advanceRunStep(app.db, { runId: f.runId,
    workerId: 'p11-published', storage });
  assert.equal(verified.status, 'STEP_SUCCEEDED');
  assert.equal(verified.step_kind, 'VERIFY');
  const completion = await advanceRunStep(app.db, { runId: f.runId,
    workerId: 'p11-published', storage });
  assert.equal(completion.status, 'COMPLETION_BLOCKED');
});

test('P11 optional input trims with an attributable reason and stays within estimated budget', async () => {
  const f = await fixture('中文');
  await createKnowledge(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '中文长资料',
    source: { sourceKind: 'NOTE', text: `中文${'长资料'.repeat(1100)}` } });
  const r = createRepositories(app.db);
  const run = await r.runs.readRun(f.runId);
  const task = await r.tasks.readTask(f.taskId);
  assert.ok(run && task);
  const probe = await buildRunContext(app.db, { run, task, storage });
  assert.equal(probe.kind, 'READY');
  if (probe.kind !== 'READY') return;
  const required = (probe.payload.budget as { required_tokens: number }).required_tokens;
  const limit = required + 1536 + 80;
  const built = await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-trim',
    storage, contextBudgetTokens: limit });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  const id = (await listRunContextManifests(app.db, f.workspaceId, f.runId)).items[0]!.id;
  const detail = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, id);
  assert.ok(detail.exclusions.some((x) => x.reason === 'BUDGET_TRIMMED'));
  const budget = detail.budget as unknown as { selected_tokens: number;
    reserved_tokens: number; limit_tokens: number };
  assert.ok(budget.selected_tokens + budget.reserved_tokens <= budget.limit_tokens);
});

test('real model Context excludes recent fallback while Mock keeps its existing selection', async () => {
  const f = await fixture('无匹配任务');
  await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '独立资料',
    source: { sourceKind: 'NOTE', text: '不应凭近期排序外发' } });
  const r = createRepositories(app.db);
  const run = await r.runs.readRun(f.runId);
  const task = await r.tasks.readTask(f.taskId);
  assert.ok(run && task);
  const mock = await buildRunContext(app.db, { run, task, storage });
  const real = await buildRunContext(app.db, { run, task, storage,
    externalModel: true });
  assert.equal(mock.kind, 'READY');
  assert.equal(real.kind, 'READY');
  if (mock.kind !== 'READY' || real.kind !== 'READY') return;
  const mockSources = mock.payload.sources as { selection_reason?: string }[];
  const realSources = real.payload.sources as { selection_reason?: string }[];
  assert.ok(mockSources.some((source) => source.selection_reason === 'RECENT_SCOPE_FALLBACK'));
  assert.ok(realSources.every((source) => source.selection_reason !== 'RECENT_SCOPE_FALLBACK'));
  assert.notEqual(mock.manifestHash.toString('hex'), real.manifestHash.toString('hex'));
});

test('P11 expired Memory is excluded on historical Manifest read', async () => {
  const f = await fixture('中文');
  const memory = await createMemory(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    commandId: randomUUID(), title: '中文短期记忆', text: '很快过期', confirmed: true,
    expiresAt: new Date(Date.now() + 1_200).toISOString() });
  await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-expiry', storage });
  const id = (await listRunContextManifests(app.db, f.workspaceId, f.runId)).items[0]!.id;
  const beforeExpiry = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, id);
  assert.ok(JSON.stringify(beforeExpiry).includes(memory.result.memory_id!));
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  const afterExpiry = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, id);
  assert.ok(!JSON.stringify(afterExpiry).includes(memory.result.memory_id!));
});

test('P11 retired, superseded and cross-scope facts disappear from historical read and HTTP keeps 404', async () => {
  const f = await fixture('中文');
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '中文知识',
    source: { sourceKind: 'NOTE', text: '要隐藏的中文知识' } });
  const memory = await createMemory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '中文记忆',
    text: '要隐藏的记忆', confirmed: true });
  const decision = await createDecision(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '中文决定',
    choice: '旧决定', rationale: '原依据', alternatives: [], costs: [] });
  const replacement = await createDecision(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '替代决定',
    choice: '新决定', rationale: '新依据', alternatives: [], costs: [] });
  await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-read', storage });
  const id = (await listRunContextManifests(app.db, f.workspaceId, f.runId)).items[0]!.id;
  await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'knowledge',
    id: knowledge.result.knowledge_id!, commandId: randomUUID(), expectedRevision: '0' });
  await retireInformation(app.db, { workspaceId: f.workspaceId, kind: 'memory',
    id: memory.result.memory_id!, commandId: randomUUID(), expectedRevision: '0' });
  await supersedeDecision(app.db, { workspaceId: f.workspaceId,
    decisionId: decision.result.decision_id!, replacementDecisionId: replacement.result.decision_id!,
    commandId: randomUUID(), expectedRevision: '0' });
  const detail = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, id);
  const serialized = JSON.stringify(detail);
  for (const old of [knowledge.result.knowledge_id!, memory.result.memory_id!, decision.result.decision_id!,
    '要隐藏的中文知识', '要隐藏的记忆', '旧决定']) assert.ok(!serialized.includes(old));
  assert.ok(sourceItems(detail).every((s) =>
    ![knowledge.result.knowledge_id!, memory.result.memory_id!, decision.result.decision_id!]
      .some((idValue) => s.source_ref.includes(idValue))));
  assert.equal((detail.budget as { selected_tokens: null }).selected_tokens, null);
  const api = await startTestApi();
  try {
    const path = workspacePath(f.workspaceId, `/runs/${f.runId}/context-manifests`);
    const list = await api.get(path);
    assert.equal(list.status, 200, list.text);
    assert.equal((list.body as { items: unknown[] }).items.length, 1);
    const detailHttp = await api.get(`${path}/${id}`);
    assert.equal(detailHttp.status, 200, detailHttp.text);
    assert.ok(!detailHttp.text.includes(knowledge.result.knowledge_id!));
    expectProblem(await api.get(workspacePath(randomUUID(), `/runs/${f.runId}/context-manifests`)),
      404, 'RESOURCE_NOT_FOUND');
    expectProblem(await api.get(`${path}/${randomUUID()}`), 404, 'RESOURCE_NOT_FOUND');
  } finally { await api.stop(); }
});

test('P11 ArtifactVersion Knowledge uses checked managed content and hides damaged source', async () => {
  const f = await fixture('中文');
  const artifactId = randomUUID();
  const versionId = randomUUID();
  const content = '# 中文受管资料\n可信正文';
  const published = await storage.publish({ artifactId, versionId, content: Buffer.from(content) });
  await withTransaction(app.db, async (r) => {
    await r.artifacts.insertArtifact({ id: artifactId, workspaceId: f.workspaceId,
      projectId: f.projectId, taskId: f.taskId, artifactKind: 'MARKDOWN_DOCUMENT', title: '中文受管资料' });
    await r.artifacts.insertArtifactVersion({ id: versionId, artifactId, versionNumber: 1n,
      storageRef: published.storageRef, contentHash: published.contentHash, size: published.size,
      mediaType: 'text/markdown', sourceKind: 'HUMAN', sourceRef: null });
  });
  const promoted = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '中文受管资料',
    source: { sourceKind: 'ARTIFACT_VERSION', artifactVersionId: versionId } });
  await advanceRunStep(app.db, { runId: f.runId, workerId: 'p11-artifact', storage });
  const id = (await listRunContextManifests(app.db, f.workspaceId, f.runId)).items[0]!.id;
  const detail = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, id);
  assert.ok(sourceItems(detail).some((s) => s.content === content));
  await rm(`${dataRoot}/artifacts/${artifactId}/${versionId}/content.md`);
  const unavailable = await readRunContextManifest(app.db, storage, f.workspaceId, f.runId, id);
  assert.ok(!JSON.stringify(unavailable).includes(promoted.result.knowledge_id!));
});

test('P12 explicit context sources freeze with the Run, pin immutable versions and drop the recent fallback', async () => {
  const ready = await fixtureReady('显式来源任务标题');
  const created = await createKnowledge(app.db, { workspaceId: ready.workspaceId,
    projectId: ready.projectId, commandId: randomUUID(), title: '旧版资料',
    source: { sourceKind: 'NOTE', text: '显式钉住的第一版正文' } });
  const knowledgeId = created.result.knowledge_id!;
  const updated = await addKnowledgeVersion(app.db, { workspaceId: ready.workspaceId,
    knowledgeId, commandId: randomUUID(), expectedRevision: created.result.revision,
    source: { sourceKind: 'NOTE', text: '更新后的第二版正文' } });
  assert.equal(updated.result.version, '2');
  // 标题与任务无关：没有显式选择时它会是 RECENT_SCOPE_FALLBACK 的补位候选。
  await createMemory(app.db, { workspaceId: ready.workspaceId, projectId: ready.projectId,
    commandId: randomUUID(), title: '完全无关的近期记忆', text: '最近补位资料', confirmed: true });
  // 标题命中：显式选择存在时同作用域检索仍按设计保留。
  await createKnowledge(app.db, { workspaceId: ready.workspaceId, projectId: ready.projectId,
    commandId: randomUUID(), title: '显式来源任务标题相关资料',
    source: { sourceKind: 'NOTE', text: '标题命中的同作用域资料' } });

  const delegated = await delegateTask(app.db, { workspaceId: ready.workspaceId,
    taskId: ready.taskId, commandId: randomUUID(), expectedTaskRevision: '0',
    contextSources: [{ kind: 'KNOWLEDGE', root_id: knowledgeId, version: '1' }] });
  const frozen = await sql<{ sources: readonly unknown[] }>`
    select frozen_snapshot->'context_sources' as sources from execution_contracts
    where run_id = ${delegated.result.run_id}`.execute(app.db);
  assert.deepEqual(frozen.rows[0]?.sources, [
    { kind: 'KNOWLEDGE', root_id: knowledgeId, version: '1' }]);

  const built = await buildRunContext(app.db, { run: await getRun(delegated.result.run_id),
    task: await getTask(ready.taskId), storage });
  assert.equal(built.kind, 'READY');
  if (built.kind !== 'READY') return;
  const sources = built.payload.sources as readonly { kind: string; source_ref: string;
    content: string; selection_reason?: string }[];
  const pinned = sources.find((source) => source.selection_reason === 'EXPLICIT_SELECTION');
  assert.ok(pinned);
  assert.equal(pinned.source_ref, `knowledge:${knowledgeId}:v1`);
  assert.equal(pinned.content, '显式钉住的第一版正文');
  assert.ok(sources.some((source) => source.selection_reason === 'TITLE_MATCH'),
    'scoped retrieval stays available alongside explicit selections');
  assert.equal(sources.some((source) => source.selection_reason === 'RECENT_SCOPE_FALLBACK'), false,
    'explicit selections replace the recent fallback per minimal necessary input');
  assert.ok(!JSON.stringify(built.payload).includes('最近补位资料'));
});

test('Delegate rejects unknown, retired or missing explicit context source versions before any Run', async () => {
  const ready = await fixtureReady('校验显式来源');
  const created = await createKnowledge(app.db, { workspaceId: ready.workspaceId,
    projectId: ready.projectId, commandId: randomUUID(), title: '被归档的资料',
    source: { sourceKind: 'NOTE', text: '正文' } });
  const knowledgeId = created.result.knowledge_id!;
  const other = await fixtureReady('其他工作区');
  const foreign = await createKnowledge(app.db, { workspaceId: other.workspaceId,
    projectId: other.projectId, commandId: randomUUID(), title: '跨工作区资料',
    source: { sourceKind: 'NOTE', text: '不可见' } });

  for (const sources of [
    [{ kind: 'KNOWLEDGE' as const, root_id: knowledgeId, version: '99' }],
    [{ kind: 'KNOWLEDGE' as const, root_id: randomUUID(), version: '1' }],
    [{ kind: 'KNOWLEDGE' as const, root_id: foreign.result.knowledge_id!, version: '1' }],
  ]) {
    await assert.rejects(
      delegateTask(app.db, { workspaceId: ready.workspaceId, taskId: ready.taskId,
        commandId: randomUUID(), expectedTaskRevision: '0', contextSources: sources }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error &&
        ((error as { code: string }).code === 'RESOURCE_NOT_FOUND' ||
          (error as { code: string }).code === 'INVALID_TRANSITION'),
    );
  }

  await retireInformation(app.db, { workspaceId: ready.workspaceId, kind: 'knowledge',
    id: knowledgeId, commandId: randomUUID(), expectedRevision: created.result.revision });
  await assert.rejects(
    delegateTask(app.db, { workspaceId: ready.workspaceId, taskId: ready.taskId,
      commandId: randomUUID(), expectedTaskRevision: '0',
      contextSources: [{ kind: 'KNOWLEDGE', root_id: knowledgeId, version: '1' }] }),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code: string }).code === 'INVALID_TRANSITION',
  );
  const runs = await sql<{ count: string | bigint }>`
    select count(*) as count from runs where task_id = ${ready.taskId}`.execute(app.db);
  assert.equal(String(runs.rows[0]?.count), '0');
  const task = await sql<{ status: string; executor_kind: string }>`
    select status, executor_kind from tasks where id = ${ready.taskId}`.execute(app.db);
  assert.deepEqual(task.rows[0], { status: 'READY', executor_kind: 'HUMAN' });
});

test('a source retired after freeze is excluded as unavailable while the frozen pin stays', async () => {
  const ready = await fixtureReady('冻结后归档来源');
  const created = await createKnowledge(app.db, { workspaceId: ready.workspaceId,
    projectId: ready.projectId, commandId: randomUUID(), title: '稍后归档',
    source: { sourceKind: 'NOTE', text: '显式选中后归档的正文' } });
  const knowledgeId = created.result.knowledge_id!;
  const delegated = await delegateTask(app.db, { workspaceId: ready.workspaceId,
    taskId: ready.taskId, commandId: randomUUID(), expectedTaskRevision: '0',
    contextSources: [{ kind: 'KNOWLEDGE', root_id: knowledgeId, version: '1' }] });
  await retireInformation(app.db, { workspaceId: ready.workspaceId, kind: 'knowledge',
    id: knowledgeId, commandId: randomUUID(), expectedRevision: created.result.revision });

  const built = await buildRunContext(app.db, { run: await getRun(delegated.result.run_id),
    task: await getTask(ready.taskId), storage });
  assert.equal(built.kind, 'READY');
  if (built.kind !== 'READY') return;
  const sources = built.payload.sources as readonly { selection_reason?: string }[];
  assert.equal(sources.some((source) => source.selection_reason === 'EXPLICIT_SELECTION'), false);
  const exclusions = built.payload.exclusions as readonly { source_ref: string; reason: string }[];
  assert.deepEqual(exclusions.find((entry) => entry.source_ref === `knowledge:${knowledgeId}:v1`),
    { source_ref: `knowledge:${knowledgeId}:v1`, reason: 'SOURCE_UNAVAILABLE' });
});

async function getRun(runId: string) {
  const run = await createRepositories(app.db).runs.readRun(runId);
  assert.ok(run);
  return run;
}

async function getTask(taskId: string) {
  const task = await createRepositories(app.db).tasks.readTask(taskId);
  assert.ok(task);
  return task;
}
