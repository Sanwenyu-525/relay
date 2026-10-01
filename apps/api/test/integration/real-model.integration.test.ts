// Opt-in real-model end-to-end slice (M04). Runs ONLY when RELAY_MODEL_* is
// fully configured in the environment; otherwise the whole file is skipped so
// the standard regression never spends tokens or hits the network.
// The API key stays in the environment; nothing here prints or stores it.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { buildRunContext, type ContextSource } from '../../src/application/context-builder.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createKnowledge, createRule } from '../../src/application/information-commands.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { applySafeControl, requestRunControl }
  from '../../src/application/control-requests.js';
import { withTransaction, createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { readModelPortConfig } from '../../src/workflow/model-port-config.js';
import { createDataRoot, startTestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';

const modelConfig = readModelPortConfig(process.env);
const modelReady = modelConfig !== undefined && modelConfig.provider === 'openai-compatible';
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p12-real-model');
let dataRoot: string;
let storage: ManagedContentStore;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

test('P12 the real model drafts from explicitly selected sources and passes the completion gate',
  { skip: !modelReady && 'RELAY_MODEL_* not configured' }, async () => {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    await withTransaction(app.db, async (r) => {
      await r.workspaces.insertWorkspace({ id: workspaceId, name: `p12-${workspaceId}` });
      await r.workspaces.insertAuthorityRow(workspaceId);
      await r.projects.insertProject({ id: projectId, workspaceId, title: 'P12 Real Model',
        projectType: 'GENERAL' });
      await r.projects.insertProjectState(projectId, 'PLANNING');
      await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: '真实模型候选',
        status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
        ownershipEpoch: 0n, currentCompletionId: null });
      await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
        objective: '依据显式选中的资料形成一篇简短 Markdown 候选，并在结论中原样回显探针资料的完整唯一标记，不得改写或省略',
        requiredOutputSpec: {}, source: 'CREATE' });
      await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
        statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
    });
    // 显式选源是真实外发边界：资料正文带独特词，供端到端断言模型确实消费了该来源。
    const distinctive = `RELAY-M04-SOURCE-${randomUUID()}`;
    const knowledge = await createKnowledge(app.db, { workspaceId, projectId,
      commandId: randomUUID(), title: '真实模型探针资料',
      source: { sourceKind: 'NOTE', text: distinctive } });
    const knowledgeVersion = knowledge.result.version ?? '1';
    const sourceHash = createHash('sha256').update(distinctive, 'utf8').digest('hex');
    const delegated = await delegateTask(app.db, { workspaceId, taskId,
      commandId: randomUUID(), expectedTaskRevision: '0',
      contextSources: [{ kind: 'KNOWLEDGE', root_id: knowledge.result.knowledge_id!,
        version: knowledgeVersion }] });
    const runId = delegated.result.run_id;

    const workerId = `real-model-${randomUUID()}`;
    for (let step = 0; step < 8; step += 1) {
      const result = await advanceRunStep(app.db, { runId, workerId, storage });
      if (result.status === 'WAITING_REVIEW' ||
          (result.status === 'STEP_SUCCEEDED' && result.run_status === 'WAITING_APPROVAL')) break;
      assert.equal(result.status, 'STEP_SUCCEEDED', `step ${step}: ${JSON.stringify(result)}`);
    }

    const run = await createRepositories(app.db).runs.readRun(runId);
    assert.ok(run);
    assert.equal(run.status, 'WAITING_APPROVAL');

    const manifest = await buildRunContext(app.db, { run, task: await getTask(taskId), storage });
    assert.equal(manifest.kind, 'READY');
    if (manifest.kind !== 'READY') return;
    const sources = manifest.payload.sources as readonly ContextSource[];
    const explicitSources = sources.filter((source) => source.selection_reason === 'EXPLICIT_SELECTION');
    assert.equal(explicitSources.length, 1,
      'the frozen explicit selection is the only relevant source outbound');
    const selected = explicitSources[0]!;
    assert.equal(selected.source_ref, `knowledge:${knowledge.result.knowledge_id!}:v${knowledgeVersion}`);
    assert.equal(selected.version, knowledgeVersion);
    assert.equal(selected.content, distinctive);
    assert.equal(selected.sha256, sourceHash);
    assert.equal(selected.source_sha256, sourceHash);

    const draft = await sql<{ content: string; usage: { input_tokens: number; output_tokens: number };
      request_id: string | null; sources: readonly ContextSource[] }>`
      select a.result_ref->>'content' as content,
             a.result_ref->'usage' as usage,
             a.result_ref->>'provider_request_id' as request_id,
             m.payload->'sources' as sources
      from step_attempts a join run_steps s on s.id = a.step_id
      join model_calls c on c.step_attempt_id = a.id and c.kind = 'DRAFT'
      join context_manifests m on m.id = c.manifest_id and m.run_id = s.run_id
      where s.run_id = ${runId} and s.step_kind = 'DRAFT' and a.status = 'SUCCEEDED'
      order by a.attempt_number desc limit 1`.execute(app.db);
    assert.ok(draft.rows[0]);
    assert.deepEqual(draft.rows[0]!.sources.filter(
      (source) => source.selection_reason === 'EXPLICIT_SELECTION'), explicitSources,
      'the original DRAFT model call retains the same selected source version and content hashes');
    assert.ok((draft.rows[0]!.usage?.input_tokens ?? 0) > 0,
      'the real model reports a nonzero input token usage');
    const candidate = await sql<{ count: string }>`
      select count(*) as count from artifact_versions where source_ref like ${`run:${runId}/%`}`.execute(app.db);
    assert.equal(String(candidate.rows[0]?.count), '1', 'exactly one managed candidate is published');
    const draftContent = draft.rows[0]!.content;
    assert.ok(!draftContent.includes('本候选依据目标'), 'the output is not the deterministic Fake template');
    assert.ok(draftContent.includes(distinctive), 'the real candidate echoes the unique selected-source marker verbatim');
    assert.equal(String((await sql<{ count: bigint }>`
      select count(*) as count from completion_records where task_id = ${taskId}`.execute(app.db)).rows[0]?.count), '0',
      'the HUMAN criterion keeps completion gated');
  });

async function getTask(taskId: string) {
  const task = await createRepositories(app.db).tasks.readTask(taskId);
  assert.ok(task);
  return task;
}

test('P12 a HARD SEMANTIC rule is verified by the real semantic checker end to end',
  { skip: !modelReady && 'RELAY_MODEL_* not configured' }, async () => {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    await withTransaction(app.db, async (r) => {
      await r.workspaces.insertWorkspace({ id: workspaceId, name: `p12s-${workspaceId}` });
      await r.workspaces.insertAuthorityRow(workspaceId);
      await r.projects.insertProject({ id: projectId, workspaceId, title: 'P12 Semantic',
        projectType: 'GENERAL' });
      await r.projects.insertProjectState(projectId, 'PLANNING');
      await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: '语义检查候选',
        status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
        ownershipEpoch: 0n, currentCompletionId: null });
      await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
        objective: '形成一篇带结论的简短 Markdown 候选', requiredOutputSpec: {}, source: 'CREATE' });
      await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
        statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
    });
    await createRule(app.db, { workspaceId, commandId: randomUUID(), scope: 'PROJECT',
      scopeId: projectId, ruleKey: 'conclusion-required', statement: '候选正文中包含以「结论」命名的二级小节，且该小节给出一句明确总结。',
      strength: 'HARD', applicability: 'AI_RUN', enforcement: 'SEMANTIC' });
    const delegated = await delegateTask(app.db, { workspaceId, taskId,
      commandId: randomUUID(), expectedTaskRevision: '0' });
    const runId = delegated.result.run_id;
    const workerId = `real-semantic-${randomUUID()}`;
    for (let step = 0; step < 8; step += 1) {
      const result = await advanceRunStep(app.db, { runId, workerId, storage });
      if (result.status === 'WAITING_REVIEW' ||
          (result.status === 'STEP_SUCCEEDED' && result.run_status === 'WAITING_APPROVAL')) break;
      assert.equal(result.status, 'STEP_SUCCEEDED', `step ${step}: ${JSON.stringify(result)}`);
    }
    const run = await createRepositories(app.db).runs.readRun(runId);
    assert.ok(run);
    assert.equal(run.status, 'WAITING_APPROVAL');
    const semantic = await sql<{ result: string; evidence: { fake?: boolean;
      usage?: { input_tokens: number }; reason?: string } }>`
      select result, evidence_refs as evidence from check_results
      where checker_id = 'semantic-model-v1' order by created_at desc limit 1`.execute(app.db);
    assert.ok(semantic.rows[0], 'the real semantic checker ran');
    assert.equal(semantic.rows[0]!.result, 'PASS');
    assert.equal(semantic.rows[0]!.evidence.fake, false);
    assert.ok((semantic.rows[0]!.evidence.usage?.input_tokens ?? 0) > 0,
      'the semantic verdict carries real token usage');
  });

/** 推进到 PERSIST_CANDIDATE 成功（Run=VERIFYING），下一步即为 VERIFY。 */
async function driveToVerifying(runId: string, workerId: string): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    const result = await advanceRunStep(app.db, { runId, workerId, storage });
    if (result.status === 'STEP_SUCCEEDED' && result.run_status === 'VERIFYING') return;
    assert.equal(result.status, 'STEP_SUCCEEDED', `step ${step}: ${JSON.stringify(result)}`);
  }
  assert.fail('the run never reached VERIFYING');
}

/** 等待 SEMANTIC_CHECK 账本行出现：begin() 在 Provider 外呼前先提交 STARTED。 */
async function waitForSemanticLedgerRow(runId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = (await sql<{ id: string; status: string }>`
      select c.id, c.status from model_calls c
      join step_attempts a on a.id = c.step_attempt_id
      join run_steps s on s.id = a.step_id
      where s.run_id = ${runId} and c.kind = 'SEMANTIC_CHECK'
      order by c.started_at desc limit 1`.execute(app.db)).rows[0];
    if (row !== undefined) return;
    assert.ok(Date.now() < deadline, 'the semantic model call never started a ledger row');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function latestSemanticLedgerStatus(runId: string): Promise<string> {
  return (await sql<{ status: string }>`
    select c.status from model_calls c
    join step_attempts a on a.id = c.step_attempt_id
    join run_steps s on s.id = a.step_id
    where s.run_id = ${runId} and c.kind = 'SEMANTIC_CHECK'
    order by c.started_at desc limit 1`.execute(app.db)).rows[0]!.status;
}

async function semanticCheckResultCount(runId: string): Promise<string> {
  return (await sql<{ count: string }>`
    select count(*)::text as count from check_results cr
    join verification_sessions vs on vs.id = cr.session_id
    where vs.run_id = ${runId}`.execute(app.db)).rows[0]!.count;
}

/** HARD SEMANTIC 规则 + 委派，返回 run_id（与 test 2 的最小建链一致）。 */
async function delegateSemanticTask(workspaceId: string, projectId: string): Promise<string> {
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p12c-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P12 Semantic Cancel',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: '取消语义候选',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '形成一篇带结论的简短 Markdown 候选', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
  });
  await createRule(app.db, { workspaceId, commandId: randomUUID(), scope: 'PROJECT',
    scopeId: projectId, ruleKey: 'conclusion-required', statement: '候选正文中包含以「结论」命名的二级小节，且该小节给出一句明确总结。',
    strength: 'HARD', applicability: 'AI_RUN', enforcement: 'SEMANTIC' });
  const delegated = await delegateTask(app.db, { workspaceId, taskId,
    commandId: randomUUID(), expectedTaskRevision: '0' });
  return delegated.result.run_id;
}

test('P12 a CANCEL intent committed during the real semantic call converges CANCELLED with a settled ledger row',
  { skip: !modelReady && 'RELAY_MODEL_* not configured' }, async () => {
    const workspaceId = randomUUID();
    const runId = await delegateSemanticTask(workspaceId, randomUUID());
    const workerId = `real-semantic-cancel-${randomUUID()}`;
    await driveToVerifying(runId, workerId);

    const controller = new AbortController();
    const verify = advanceRunStep(app.db, { runId, workerId, storage,
      signal: controller.signal });
    // 模型型语义检查现在发生在结果事务之外（修复自死锁的同一结构）：这里等 STARTED
    // 账本行提交后再注入 CANCEL 意图，控制必然落在结果事务的安全点核对之前。
    await waitForSemanticLedgerRow(runId);
    const revisions = (await sql<{ task_revision: string; run_revision: string }>`
      select t.revision::text as task_revision, r.revision::text as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${runId}`.execute(app.db)).rows[0]!;
    const workspaceOfRun = (await sql<{ workspace_id: string }>`
      select workspace_id from runs where id = ${runId}`.execute(app.db)).rows[0]!.workspace_id;
    await requestRunControl(app.db, { workspaceId: workspaceOfRun, runId,
      commandId: randomUUID(), expectedTaskRevision: revisions.task_revision,
      expectedRunRevision: revisions.run_revision, type: 'CANCEL' });

    const result = await verify;
    assert.equal(result.status, 'CONTROL_PENDING', JSON.stringify(result));
    assert.equal(await latestSemanticLedgerStatus(runId), 'COMPLETED',
      'the provider call that really happened settles COMPLETED, never an orphan STARTED');
    assert.equal(await semanticCheckResultCount(runId), '0',
      'a preempted step writes no check results');
    const run = await createRepositories(app.db).runs.readRun(runId);
    assert.equal(run?.status, 'CANCELLED', 'the committed control is applied at the safe point');
  });

test('P12 aborting the real semantic call mid-flight settles the ledger row CANCELLED and never writes check results',
  { skip: !modelReady && 'RELAY_MODEL_* not configured' }, async () => {
    const workspaceId = randomUUID();
    const runId = await delegateSemanticTask(workspaceId, randomUUID());
    const workerId = `real-semantic-abort-${randomUUID()}`;
    await driveToVerifying(runId, workerId);

    const controller = new AbortController();
    const verify = advanceRunStep(app.db, { runId, workerId, storage,
      signal: controller.signal });
    await waitForSemanticLedgerRow(runId);
    // 取消必须先持久化为控制意图（约束 6）：纯信号中止只是 Worker 丢失，
    // 不能把 Run 记成 CANCELLED。先提交 CANCEL，再中止在途调用。
    const revisions = (await sql<{ task_revision: string; run_revision: string }>`
      select t.revision::text as task_revision, r.revision::text as run_revision
      from runs r join tasks t on t.id = r.task_id where r.id = ${runId}`.execute(app.db)).rows[0]!;
    const workspaceOfRun = (await sql<{ workspace_id: string }>`
      select workspace_id from runs where id = ${runId}`.execute(app.db)).rows[0]!.workspace_id;
    await requestRunControl(app.db, { workspaceId: workspaceOfRun, runId,
      commandId: randomUUID(), expectedTaskRevision: revisions.task_revision,
      expectedRunRevision: revisions.run_revision, type: 'CANCEL' });
    controller.abort();

    // 中止发生在 Provider 调用在途时：prepare 返回后提交前被栅栏，等价于 DRAFT 的取消语义。
    const result = await verify;
    assert.equal(result.status, 'INVOCATION_LOST', JSON.stringify(result));
    assert.equal(await latestSemanticLedgerStatus(runId), 'CANCELLED',
      'the aborted provider call settles CANCELLED, never an orphan STARTED');
    assert.equal(await semanticCheckResultCount(runId), '0',
      'an aborted verification writes no check results');

    // 生产中由 dispatcher 的恢复/栅栏路径释放旧 claim；此处以同一仓库操作等价驱动。
    await withTransaction(app.db, async (r) => { await r.runs.fenceWorker(runId); });
    assert.equal((await applySafeControl(app.db, runId))?.status, 'APPLIED');
    const run = await createRepositories(app.db).runs.readRun(runId);
    assert.equal(run?.status, 'CANCELLED', 'the run converges to the CANCELLED terminal state');
  });
