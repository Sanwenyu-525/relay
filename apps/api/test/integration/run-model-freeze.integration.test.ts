import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { selectSessionModel } from '../../src/application/select-session-model.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { parseAssistModelSnapshot } from '../../src/application/assist-model-snapshot.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-run-model-freeze-test');
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); });
after(async () => { await app.close(); });
const fakeEnv = { RELAY_MODEL_PROVIDER: 'fake' };
const freeEnv = { ...fakeEnv, RELAY_OPENROUTER_API_KEY: 'synthetic-run-freeze',
  RELAY_MODEL_MAX_OUTPUT_TOKENS: '512', RELAY_MODEL_MAX_CALL_TOKENS: '16384' };

async function readyTask() {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Run model freeze', projectType: 'DEVELOPMENT' });
  const projectId = project.result.project_id;
  const created = await createTask(app.db, { workspaceId, projectId, commandId: randomUUID(),
    title: 'Synthetic task', objective: 'Produce a synthetic Markdown document', mode: 'ME',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'human', statement: 'Review the synthetic document', required: true, method: 'HUMAN' }] });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: created.result.task_id,
    commandId: randomUUID(), expectedRevision: created.result.revision });
  return { workspaceId, projectId, taskId: created.result.task_id, expectedTaskRevision: ready.result.revision };
}

test('new real-default Runs freeze one non-secret model; replay does not refreeze changed configuration', async () => {
  const fixture = await readyTask();
  const env = { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_NAME: 'synthetic/default-a',
    RELAY_MODEL_API_KEY: 'synthetic-default-credential' };
  const input = { ...fixture, commandId: randomUUID() };
  const accepted = await delegateTask(app.db, input, env);
  // 模型快照随执行契约冻结，读取入口是 readContract().frozen_snapshot，不挂在 runs 行上。
  const contract = await createRepositories(app.db).runs.readContract(accepted.result.run_id);
  assert.ok(contract);
  const plan = parseAssistModelSnapshot(contract.frozen_snapshot.model_selection_snapshot as JsonObject);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0]?.connection.model, 'synthetic/default-a');
  assert.equal(plan.candidates[0]?.freeOnly, false);
  assert.equal(JSON.stringify(contract.frozen_snapshot).includes(env.RELAY_MODEL_API_KEY), false);
  const replay = await delegateTask(app.db, input, { ...env, RELAY_MODEL_NAME: 'synthetic/default-b' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.run_id, accepted.result.run_id);
  const replayedContract = await createRepositories(app.db).runs.readContract(accepted.result.run_id);
  assert.deepEqual(replayedContract?.frozen_snapshot, contract.frozen_snapshot);
});

test('a conversation Run freezes the selected free queue; later selection cannot rewrite its contract', async () => {
  const fixture = await readyTask();
  const modelA = `freeze-a-${randomUUID()}:free`;
  const modelB = `freeze-b-${randomUUID()}:free`;
  for (const model of [modelA, modelB]) {
    await sql`insert into model_catalog_entries
      (source_model_id, display_name, context_window, pricing, capabilities, is_free, not_free_reason, fetched_at)
      values (${model}, ${model}, 131072, '{"prompt":"0","completion":"0"}'::jsonb,
      '{"text_input":true,"text_output":true,"tools":true,"response_format":true}'::jsonb, true, null, now())`.execute(app.db);
  }
  await sql`update model_catalog_sync_state set snapshot_seq = snapshot_seq + 1,
    last_success_at = now() where singleton = true`.execute(app.db);
  const sessionId = randomUUID();
  await createRepositories(app.db).assist.insertSession({ id: sessionId, workspaceId: fixture.workspaceId,
    projectId: fixture.projectId, taskId: null, title: 'Model source' });
  await selectSessionModel(app.db, { workspaceId: fixture.workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: modelA, env: freeEnv });
  const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID(), modelSessionId: sessionId }, freeEnv);
  const contract = await createRepositories(app.db).runs.readContract(accepted.result.run_id);
  assert.ok(contract);
  const frozen = parseAssistModelSnapshot(contract.frozen_snapshot.model_selection_snapshot as JsonObject);
  assert.equal(frozen.candidates[0]?.connection.model, modelA);
  assert.ok(frozen.candidates.some((candidate) => candidate.connection.model === modelB));
  assert.ok(frozen.candidates.every((candidate) => candidate.freeOnly));
  await selectSessionModel(app.db, { workspaceId: fixture.workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: modelB, env: freeEnv });
  const later = await createRepositories(app.db).runs.readContract(accepted.result.run_id);
  assert.deepEqual(later?.frozen_snapshot, contract.frozen_snapshot);
  assert.deepEqual(later?.contract_hash, contract.contract_hash);
  assert.equal(JSON.stringify(contract.frozen_snapshot).includes(freeEnv.RELAY_OPENROUTER_API_KEY), false);
});

test('Fake Runs keep explicit compatibility without inventing a real model snapshot', async () => {
  const fixture = await readyTask();
  const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() }, fakeEnv);
  const contract = await createRepositories(app.db).runs.readContract(accepted.result.run_id);
  assert.ok(contract);
  assert.equal('model_selection_snapshot' in contract.frozen_snapshot, false);
});
