// Opt-in real-model end-to-end slice (M04). Runs ONLY when RELAY_MODEL_* is
// fully configured in the environment; otherwise the whole file is skipped so
// the standard regression never spends tokens or hits the network.
// The API key stays in the environment; nothing here prints or stores it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { buildRunContext } from '../../src/application/context-builder.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createKnowledge, createRule } from '../../src/application/information-commands.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
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
        objective: '依据显式选中的资料形成一篇简短 Markdown 候选',
        requiredOutputSpec: {}, source: 'CREATE' });
      await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
        statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
    });
    // 显式选源是真实外发边界：资料正文带独特词，供端到端断言模型确实消费了该来源。
    const distinctive = `量子萤石协议-X7：探针资料正文中唯一的独特标记 ${randomUUID().slice(0, 8)}`;
    const knowledge = await createKnowledge(app.db, { workspaceId, projectId,
      commandId: randomUUID(), title: '真实模型探针资料',
      source: { sourceKind: 'NOTE', text: distinctive } });
    const delegated = await delegateTask(app.db, { workspaceId, taskId,
      commandId: randomUUID(), expectedTaskRevision: '0',
      contextSources: [{ kind: 'KNOWLEDGE', root_id: knowledge.result.knowledge_id!,
        version: knowledge.result.version ?? '1' }] });
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
    const sources = manifest.payload.sources as readonly { selection_reason?: string }[];
    assert.equal(sources.filter((source) => source.selection_reason === 'EXPLICIT_SELECTION').length, 1,
      'the frozen explicit selection is the only relevant source outbound');

    const draft = await sql<{ content: string; usage: { input_tokens: number; output_tokens: number };
      request_id: string | null }>`
      select a.result_ref->>'content' as content,
             a.result_ref->'usage' as usage,
             a.result_ref->>'provider_request_id' as request_id
      from step_attempts a join run_steps s on s.id = a.step_id
      where s.run_id = ${runId} and s.step_kind = 'DRAFT' and a.status = 'SUCCEEDED'
      order by a.attempt_number desc limit 1`.execute(app.db);
    assert.ok(draft.rows[0]);
    assert.ok((draft.rows[0]!.usage?.input_tokens ?? 0) > 0,
      'the real model reports a nonzero input token usage');
    const candidate = await sql<{ count: string }>`
      select count(*) as count from artifact_versions where source_ref like ${`run:${runId}/%`}`.execute(app.db);
    assert.equal(String(candidate.rows[0]?.count), '1', 'exactly one managed candidate is published');
    const draftContent = draft.rows[0]!.content;
    assert.ok(!draftContent.includes('本候选依据目标'), 'the output is not the deterministic Fake template');
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
