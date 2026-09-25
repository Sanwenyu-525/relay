import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { addKnowledgeVersion, addMemoryRevision, addRuleVersion, createDecision,
  createKnowledge, createMemory, createRule, retireInformation, supersedeDecision }
  from '../../src/application/information-commands.js';
import { listInformationVersions, readInformation, searchInformation }
  from '../../src/application/information-queries.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, expectCommandAccepted, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';
import { rm } from 'node:fs/promises';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p10-information');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function fixture() {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p10-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P10 Project', projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Rule task',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '形成 Markdown', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
  });
  return { workspaceId, projectId, taskId };
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function barrier() {
  let enter!: () => void;
  let leave!: () => void;
  return { entered: new Promise<void>((resolve) => { enter = resolve; }),
    release: () => leave(), wait: async () => {
      enter(); await new Promise<void>((resolve) => { leave = resolve; });
    } };
}

test('P10 Knowledge/Memory immutable versions, explicit confirmation and Artifact promotion reuse', async () => {
  const f = await fixture();
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '知识',
    source: { sourceKind: 'NOTE', text: '中文资料一' } });
  const id = knowledge.result.knowledge_id;
  assert.ok(id);
  const next = await addKnowledgeVersion(app.db, { workspaceId: f.workspaceId,
    knowledgeId: id, commandId: randomUUID(), expectedRevision: '0',
    source: { sourceKind: 'MANAGED_TEXT', text: '# 中文资料二', mediaType: 'text/markdown' } });
  assert.equal(next.result.version, '2');
  const versions = await listInformationVersions(app.db, 'knowledge', f.workspaceId, id);
  assert.deepEqual(versions.map((v) => v.version), ['2', '1']);
  assert.equal(versions[1]?.excerpt, '中文资料一');
  await assert.rejects(createMemory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '记忆', text: '未经确认',
    confirmed: false }), (error: unknown) => code(error) === 'VALIDATION_FAILED');
  const memory = await createMemory(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '记忆', text: '已确认', confirmed: true });
  const memoryId = memory.result.memory_id;
  assert.ok(memoryId);
  await addMemoryRevision(app.db, { workspaceId: f.workspaceId, memoryId,
    commandId: randomUUID(), expectedRevision: '0', title: '记忆二',
    text: '再次确认', confirmed: true });
  const memoryVersions = await listInformationVersions(app.db, 'memory', f.workspaceId, memoryId);
  assert.equal(memoryVersions.length, 2);
  assert.equal(memoryVersions[1]?.text, '已确认');
  const artifactId = randomUUID();
  const artifactVersionId = randomUUID();
  const content = '# 产物';
  await withTransaction(app.db, async (r) => {
    await r.artifacts.insertArtifact({ id: artifactId, workspaceId: f.workspaceId,
      projectId: f.projectId, taskId: f.taskId, artifactKind: 'MARKDOWN_DOCUMENT', title: '产物' });
    await r.artifacts.insertArtifactVersion({ id: artifactVersionId, artifactId,
      versionNumber: 1n, storageRef: `artifacts/${artifactId}/1.md`,
      contentHash: createHash('sha256').update(content).digest(), size: BigInt(Buffer.byteLength(content)),
      mediaType: 'text/markdown', sourceKind: 'HUMAN', sourceRef: null });
  });
  const promotion = { workspaceId: f.workspaceId, projectId: f.projectId,
    title: '产物提升', source: { sourceKind: 'ARTIFACT_VERSION' as const, artifactVersionId } };
  const [first, repeated] = await Promise.all([
    createKnowledge(app.db, { ...promotion, commandId: randomUUID() }),
    createKnowledge(app.db, { ...promotion, commandId: randomUUID() }),
  ]);
  assert.equal(repeated.result.knowledge_id, first.result.knowledge_id);
  const count = await sql<{ total: bigint }>`select count(*) as total from knowledge_versions
    where artifact_version_id = ${artifactVersionId}`.execute(app.db);
  assert.equal(count.rows[0]?.total, 1n);
  const otherProjectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: otherProjectId, workspaceId: f.workspaceId,
      title: 'Other', projectType: 'GENERAL' });
    await r.projects.insertProjectState(otherProjectId, 'PLANNING');
  });
  await assert.rejects(sql`insert into knowledge_versions (id, workspace_id, knowledge_id,
    project_id, version, source_kind, media_type, content_text, content_sha256)
    values (${randomUUID()}, ${f.workspaceId}, ${id}, ${otherProjectId}, 99,
      'NOTE', 'text/plain', 'cross scope', ${createHash('sha256').update('cross scope').digest()})`
    .execute(app.db), (error: unknown) => code(error) === '23503');
  const otherKnowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: otherProjectId, commandId: randomUUID(), title: 'Other',
    source: { sourceKind: 'NOTE', text: 'Other text' } });
  const secondArtifactVersionId = randomUUID();
  await withTransaction(app.db, (r) => r.artifacts.insertArtifactVersion({
    id: secondArtifactVersionId, artifactId, versionNumber: 2n,
    storageRef: `artifacts/${artifactId}/2.md`,
    contentHash: createHash('sha256').update(content).digest(),
    size: BigInt(Buffer.byteLength(content)), mediaType: 'text/markdown',
    sourceKind: 'HUMAN', sourceRef: null,
  }));
  await assert.rejects(sql`insert into knowledge_versions (id, workspace_id, knowledge_id,
    project_id, version, source_kind, media_type, content_sha256,
    source_artifact_id, artifact_version_id)
    values (${randomUUID()}, ${f.workspaceId}, ${otherKnowledge.result.knowledge_id},
      ${otherProjectId}, 2, 'ARTIFACT_VERSION', 'text/markdown',
      ${createHash('sha256').update(content).digest()}, ${artifactId}, ${secondArtifactVersionId})`
    .execute(app.db), (error: unknown) => code(error) === '23503');
});

test('P10 Decision supersession keeps history and rejects a cycle', async () => {
  const f = await fixture();
  const make = async (title: string) => createDecision(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title, choice: title,
    rationale: '明确理由', alternatives: [], costs: [] });
  const a = (await make('甲')).result.decision_id;
  const b = (await make('乙')).result.decision_id;
  assert.ok(a && b);
  await supersedeDecision(app.db, { workspaceId: f.workspaceId, decisionId: a,
    replacementDecisionId: b, commandId: randomUUID(), expectedRevision: '0' });
  const old = await readInformation(app.db, 'decision', f.workspaceId, a);
  assert.equal(old.status, 'SUPERSEDED');
  assert.equal(old.superseded_by_id, b);
  await assert.rejects(supersedeDecision(app.db, { workspaceId: f.workspaceId,
    decisionId: b, replacementDecisionId: a, commandId: randomUUID(), expectedRevision: '0' }),
  (error: unknown) => code(error) === 'INVALID_TRANSITION');
  const otherProjectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: otherProjectId, workspaceId: f.workspaceId,
      title: 'Decision other', projectType: 'GENERAL' });
    await r.projects.insertProjectState(otherProjectId, 'PLANNING');
  });
  const other = await createDecision(app.db, { workspaceId: f.workspaceId,
    projectId: otherProjectId, commandId: randomUUID(), title: '异项目',
    choice: '异项目决定', rationale: '隔离', alternatives: [], costs: [] });
  await assert.rejects(supersedeDecision(app.db, { workspaceId: f.workspaceId,
    decisionId: b, replacementDecisionId: other.result.decision_id!,
    commandId: randomUUID(), expectedRevision: '0' }),
  (error: unknown) => code(error) === 'RESOURCE_NOT_FOUND');
});

test('P10 HARD Rule freezes into Delegate; update fences the old Run at next step', async () => {
  const f = await fixture();
  const rule = await createRule(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    scope: 'PROJECT', scopeId: f.projectId, ruleKey: 'heading', statement: '须有标题',
    strength: 'HARD', applicability: 'AI_RUN', enforcement: 'POST_CHECK',
    method: 'MARKDOWN_STRUCTURE', targetSpec: { required_headings: ['标题'] } });
  const ruleId = rule.result.rule_id;
  assert.ok(ruleId);
  const delegated = await delegateTask(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const frozen = await withTransaction(app.db, (r) => r.runs.readContract(runId));
  assert.equal(frozen?.frozen_snapshot.rule_revision, '1');
  assert.equal((frozen?.frozen_snapshot.rule_refs as unknown[]).length, 1);
  assert.match(JSON.stringify(frozen?.frozen_snapshot.criteria), /rule:/u);
  const changed = await addRuleVersion(app.db, { workspaceId: f.workspaceId,
    ruleId, commandId: randomUUID(), expectedRevision: '0', ruleKey: 'heading',
    statement: '须有新标题', strength: 'HARD', applicability: 'AI_RUN',
    enforcement: 'POST_CHECK', method: 'MARKDOWN_STRUCTURE',
    targetSpec: { required_headings: ['新标题'] } });
  assert.equal(changed.result.version, '2');
  await assert.rejects(advanceRunStep(app.db, { runId,
    workerId: `p10-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) }),
  (error: unknown) => code(error) === 'RULE_SNAPSHOT_STALE');
});

test('P10 Rule change after managed effect preserves its outcome, then fences the next step', async () => {
  const f = await fixture();
  const delegated = await delegateTask(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const storage = new ManagedContentStore(dataRoot);
  for (const step of ['BUILD_CONTEXT', 'DRAFT']) {
    const result = await advanceRunStep(app.db, { runId, workerId: `p10-${randomUUID()}`, storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', step);
  }
  const persisted = await advanceRunStep(app.db, { runId,
    workerId: `p10-${randomUUID()}`, storage,
    hooks: { beforeCommit: async () => {
      await createRule(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
        scope: 'PROJECT', scopeId: f.projectId, ruleKey: 'late', statement: '后来新增的检查',
        strength: 'HARD', applicability: 'AI_RUN', enforcement: 'POST_CHECK',
        method: 'MARKDOWN_STRUCTURE', targetSpec: { required_headings: ['后来'] } });
    } } });
  assert.equal(persisted.status, 'STEP_SUCCEEDED');
  const effect = await sql<{ status: string; operation_id: string }>`
    select status, operation_id from run_effect_actions where run_id = ${runId}`.execute(app.db);
  assert.equal(effect.rows[0]?.status, 'SUCCEEDED');
  const artifact = await sql<{ id: string }>`select id from artifact_versions
    where source_ref = ${`run:${runId}/step:PERSIST_CANDIDATE`}`.execute(app.db);
  assert.equal(artifact.rows.length, 1);
  await assert.rejects(advanceRunStep(app.db, { runId,
    workerId: `p10-${randomUUID()}`, storage }),
  (error: unknown) => code(error) === 'RULE_SNAPSHOT_STALE');
});

test('P10 Rule mutation and Delegate authority lock serialize both commit orders', async () => {
  const ruleFirst = await fixture();
  const firstGate = barrier();
  const firstRule = createRule(app.db, { workspaceId: ruleFirst.workspaceId,
    commandId: randomUUID(), scope: 'PROJECT', scopeId: ruleFirst.projectId,
    ruleKey: 'rule-first', statement: '先写规则', strength: 'HARD',
    applicability: 'AI_RUN', enforcement: 'HUMAN',
    hooks: { afterAuthorityLock: firstGate.wait } });
  await firstGate.entered;
  const afterRule = delegateTask(app.db, { workspaceId: ruleFirst.workspaceId,
    taskId: ruleFirst.taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  firstGate.release();
  await firstRule;
  const firstRun = await afterRule;
  const firstContract = await withTransaction(app.db, (r) => r.runs.readContract(firstRun.result.run_id));
  assert.equal(firstContract?.frozen_snapshot.rule_revision, '1');
  assert.equal((firstContract?.frozen_snapshot.rule_refs as unknown[]).length, 1);

  const delegateFirst = await fixture();
  const secondGate = barrier();
  const secondDelegate = delegateTask(app.db, { workspaceId: delegateFirst.workspaceId,
    taskId: delegateFirst.taskId, commandId: randomUUID(), expectedTaskRevision: '0',
    hooks: { afterAuthorityLock: secondGate.wait } });
  await secondGate.entered;
  const laterRule = createRule(app.db, { workspaceId: delegateFirst.workspaceId,
    commandId: randomUUID(), scope: 'PROJECT', scopeId: delegateFirst.projectId,
    ruleKey: 'delegate-first', statement: '后写规则', strength: 'HARD',
    applicability: 'AI_RUN', enforcement: 'HUMAN' });
  secondGate.release();
  const secondRun = await secondDelegate;
  await laterRule;
  const secondContract = await withTransaction(app.db, (r) => r.runs.readContract(secondRun.result.run_id));
  assert.equal(secondContract?.frozen_snapshot.rule_revision, '0');
  await assert.rejects(advanceRunStep(app.db, { runId: secondRun.result.run_id,
    workerId: `p10-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) }),
  (error: unknown) => code(error) === 'RULE_SNAPSHOT_STALE');
});

test('P10 upper HARD conflict and missing PRE_ACTION checker block Delegate', async () => {
  const f = await fixture();
  await createRule(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    scope: 'WORKSPACE', scopeId: f.workspaceId, ruleKey: 'format', statement: '必须 Markdown',
    strength: 'HARD', applicability: 'AI_RUN', enforcement: 'POST_CHECK',
    method: 'MARKDOWN_STRUCTURE', targetSpec: { required_headings: ['A'] } });
  await createRule(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    scope: 'TASK', scopeId: f.taskId, ruleKey: 'format', statement: '可以纯文本',
    strength: 'PREFERENCE', applicability: 'AI_RUN', enforcement: 'HUMAN' });
  await assert.rejects(delegateTask(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId, commandId: randomUUID(), expectedTaskRevision: '0' }),
  (error: unknown) => code(error) === 'RULE_CONFLICT');
  const g = await fixture();
  await createRule(app.db, { workspaceId: g.workspaceId, commandId: randomUUID(),
    scope: 'PROJECT', scopeId: g.projectId, ruleKey: 'preflight', statement: '操作前人工检查',
    strength: 'HARD', applicability: 'AI_RUN', enforcement: 'PRE_ACTION' });
  await assert.rejects(delegateTask(app.db, { workspaceId: g.workspaceId,
    taskId: g.taskId, commandId: randomUUID(), expectedTaskRevision: '0' }),
  (error: unknown) => code(error) === 'RULE_ENFORCEMENT_UNAVAILABLE');
  const semantic = await fixture();
  await createRule(app.db, { workspaceId: semantic.workspaceId, commandId: randomUUID(),
    scope: 'PROJECT', scopeId: semantic.projectId, ruleKey: 'semantic',
    statement: '必须符合语义', strength: 'HARD', applicability: 'AI_RUN',
    enforcement: 'SEMANTIC' });
  await assert.rejects(delegateTask(app.db, { workspaceId: semantic.workspaceId,
    taskId: semantic.taskId, commandId: randomUUID(), expectedTaskRevision: '0' }),
  (error: unknown) => code(error) === 'RULE_ENFORCEMENT_UNAVAILABLE');
  const h = await fixture();
  for (const statement of ['偏好甲', '偏好乙']) {
    await createRule(app.db, { workspaceId: h.workspaceId, commandId: randomUUID(),
      scope: 'PROJECT', scopeId: h.projectId, ruleKey: 'same-scope', statement,
      strength: 'PREFERENCE', applicability: 'AI_RUN', enforcement: 'HUMAN' });
  }
  await assert.rejects(delegateTask(app.db, { workspaceId: h.workspaceId,
    taskId: h.taskId, commandId: randomUUID(), expectedTaskRevision: '0' }),
  (error: unknown) => code(error) === 'RULE_CONFLICT');
});

test('P10 bounded Chinese literal search is scoped, stable and exposed through HTTP', async () => {
  const f = await fixture();
  const other = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: other, workspaceId: f.workspaceId,
      title: 'Other project', projectType: 'GENERAL' });
    await r.projects.insertProjectState(other, 'PLANNING');
  });
  const add = async (projectId: string | null, title: string) => createKnowledge(app.db, {
    workspaceId: f.workspaceId, projectId, commandId: randomUUID(), title,
    source: { sourceKind: 'NOTE', text: `${title} 的中文正文` } });
  await add(null, '中全局');
  await add(f.projectId, '中本项目');
  await add(other, '中其他项目');
  const first = await searchInformation(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, query: '中', limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  const second = await searchInformation(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, query: '中', limit: 1, cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]?.id, second.items[0]?.id);
  assert.equal(second.next_cursor, null);
  await assert.rejects(searchInformation(app.db, { workspaceId: f.workspaceId,
    projectId: other, query: '中', limit: 1, cursor: first.next_cursor }),
  (error: unknown) => code(error) === 'INVALID_CURSOR');
  const exact = await add(f.projectId, '中文');
  const contains = await add(f.projectId, '中文档案');
  await add(f.projectId, '百分比 100%');
  const ranked = await searchInformation(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, query: '中文', limit: 10 });
  assert.equal(ranked.items[0]?.id, exact.result.knowledge_id);
  assert.equal(ranked.items[1]?.id, contains.result.knowledge_id);
  const literalPercent = await searchInformation(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, query: '%' });
  assert.equal(literalPercent.items.length, 1);
  const api = await startTestApi();
  try {
    const path = workspacePath(f.workspaceId, '/knowledge');
    const commandId = randomUUID();
    const createBody = { command_id: commandId, project_id: f.projectId,
      title: 'HTTP 知识', source_kind: 'NOTE', text: '中文搜索' };
    const created = expectCommandAccepted(await api.post(path, createBody),
    201, commandId);
    const replay = await api.post(path, createBody);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.equal((replay.body as { result: { knowledge_id: string } }).result.knowledge_id,
      created.knowledge_id);
    const id = created.knowledge_id;
    assert.equal(typeof id, 'string');
    const detail = await api.get(`${path}/${id}`);
    assert.equal(detail.status, 200, detail.text);
    const list = await api.get(`${path}?project_id=${f.projectId}`);
    assert.equal(list.status, 200, list.text);
    assert.ok(Array.isArray(list.body));
    const searched = await api.get(workspacePath(f.workspaceId,
      `/search?q=${encodeURIComponent('中文')}&project_id=${f.projectId}&limit=2`));
    assert.equal(searched.status, 200, searched.text);
    assert.ok(Array.isArray((searched.body as { items: unknown[] }).items));
    expectProblem(await api.get(workspacePath(randomUUID(), `/knowledge/${id}`)), 404, 'RESOURCE_NOT_FOUND');
  } finally { await api.stop(); }
});
