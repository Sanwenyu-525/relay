import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import test, { beforeEach, afterEach } from 'node:test';
import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { openContentFreezeSession } from '../../src/runtime/content-freeze-session.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, createWorkspace, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi } from './api-harness.js';
import { createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase } from './integration-support.js';

let database: TemporaryDatabase;
let app: ReturnType<typeof openDatabase>;
let root: string;
let api: TestApi | undefined;

beforeEach(async () => {
  database = await createTemporaryDatabase('m07_content_freeze');
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  app = openDatabase(database.appUrl, 'relay-content-freeze-integration');
  root = await createDataRoot();
});
afterEach(async () => {
  try { await api?.stop(); }
  finally {
    api = undefined;
    await app?.close(); await database?.drop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function task(status: 'READY' | 'IN_PROGRESS') {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Content admission', projectType: 'GENERAL' });
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId: project.result.project_id,
      title: 'Native managed content', status, mode: 'ME', acceptanceRevision: 1n,
      executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Store exact immutable Markdown', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: 'Review exact content', required: true, method: 'HUMAN', targetSpec: {} });
  });
  return { workspaceId, taskId };
}
async function versions(taskId: string) {
  return (await sql<{ count: string }>`select count(*)::text as count from artifact_versions v
    join artifacts a on a.id = v.artifact_id where a.task_id = ${taskId}`.execute(app.db)).rows[0]?.count;
}

test('native freeze rejects HTTP manual publication with zero PG effects; same command retries then replays', async () => {
  const f = await task('IN_PROGRESS');
  api = await startTestApi({ databaseUrl: database.appUrl });
  const endpoint = workspacePath(f.workspaceId, `/tasks/${f.taskId}/artifacts`);
  const body = { command_id: randomUUID(), expected_task_revision: '0', title: 'exact Markdown',
    media_type: 'text/markdown', content: '# 内容门锁\n人工产物\n' };
  const held = await openContentFreezeSession(api.dataRoot);
  try {
    expectProblem(await api.post(endpoint, body), 503, 'STORAGE_UNAVAILABLE');
    assert.equal(await versions(f.taskId), '0');
    assert.equal((await sql<{ count: string }>`select count(*)::text as count from artifacts
      where task_id = ${f.taskId}`.execute(app.db)).rows[0]?.count, '0');
    assert.equal((await sql<{ count: string }>`select count(*)::text as count from command_receipts
      where command_id = ${body.command_id}`.execute(app.db)).rows[0]?.count, '0');
    assert.equal((await sql<{ revision: string }>`select revision::text from tasks where id = ${f.taskId}`
      .execute(app.db)).rows[0]?.revision, '0');
    assert.deepEqual(await readdir(api.dataRoot), ['.relay-content-admission.lock']);
  } finally { if (held.isHeld()) await held.release(); }
  const savedResponse = await api.post(endpoint, body);
  const saved = expectCommandAccepted(savedResponse, 201, body.command_id);
  assert.equal(await versions(f.taskId), '1');
  const reheld = await openContentFreezeSession(api.dataRoot);
  try {
    const replay = await api.post(endpoint, body);
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual((replay.body as { result: unknown }).result, saved);
    assert.equal(await versions(f.taskId), '1');
  } finally { if (reheld.isHeld()) await reheld.release(); }
});

test('an originally claimed Run publication remains UNKNOWN with its original effect after content freeze', async () => {
  const f = await task('READY');
  const run = await delegateTask(app.db, { ...f, commandId: randomUUID(), expectedTaskRevision: '0' });
  const input = { runId: run.result.run_id, workerId: 'content-freeze-original-worker',
    storage: new ManagedContentStore(root) };
  assert.equal((await advanceRunStep(app.db, input)).status, 'STEP_SUCCEEDED');
  assert.equal((await advanceRunStep(app.db, input)).status, 'STEP_SUCCEEDED');
  let held: Awaited<ReturnType<typeof openContentFreezeSession>> | undefined;
  try {
    const persist = await advanceRunStep(app.db, { ...input,
      hooks: { afterEffectDispatch: async () => { held = await openContentFreezeSession(root); } } });
    assert.equal(persist.status, 'ACTION_UNKNOWN');
    if (persist.status !== 'ACTION_UNKNOWN') throw new Error('expected original effect to need reconciliation');
    const operationId = persist.operation_id;
    const effect = await sql<{ status: string; target_ref: string }>`select status, target_ref
      from run_effect_actions where operation_id = ${operationId}`.execute(app.db);
    assert.equal(effect.rows[0]?.status, 'UNKNOWN');
    assert.equal(await versions(f.taskId), '0');
    assert.deepEqual(await readdir(root), ['.relay-content-admission.lock']);
    assert.equal((await sql<{ status: string }>`select status from runs where id = ${input.runId}`
      .execute(app.db)).rows[0]?.status, 'RUNNING');
    assert.equal((await sql<{ mode: string }>`select mode from runtime_admission_gate`.execute(app.db)).rows[0]?.mode, 'NORMAL');
    await held?.release();
    const stillUnknown = await advanceRunStep(app.db, input);
    assert.equal(stillUnknown.status, 'ACTION_UNKNOWN');
    if (stillUnknown.status !== 'ACTION_UNKNOWN') throw new Error('UNKNOWN must not blindly retry publication');
    assert.equal(stillUnknown.operation_id, operationId);
    assert.equal(await versions(f.taskId), '0');
    assert.deepEqual((await sql<{ status: string; target_ref: string }>`select status, target_ref
      from run_effect_actions where operation_id = ${operationId}`.execute(app.db)).rows, effect.rows);
    assert.deepEqual(await readdir(root), ['.relay-content-admission.lock']);
    const restored = await input.storage.publish({ artifactId: randomUUID(), versionId: randomUUID(),
      content: Buffer.from('fresh publication after explicit content release') });
    assert.ok(restored.size > 0n);
  } finally { if (held?.isHeld()) await held.release(); }
});
