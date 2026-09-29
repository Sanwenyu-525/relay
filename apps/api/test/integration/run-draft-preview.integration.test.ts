import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { requestRunControl } from '../../src/application/control-requests.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createKnowledge, retireInformation }
  from '../../src/application/information-commands.js';
import { lockTaskAndRun } from '../../src/application/lock-task-run.js';
import { publishRunDraftPreview } from '../../src/application/run-draft-preview.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, expectProblem, startTestApi, withTimeout, workspacePath,
  type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-run-draft-preview');
let api: TestApi;
let storage: ManagedContentStore;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  storage = new ManagedContentStore(await createDataRoot());
});
after(async () => { await api?.stop(); await app.close(); });

async function fixture(withSource = false) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'draft-preview-ws' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId,
      title: 'draft-preview-project', projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId,
      title: 'Draft preview', status: 'READY', mode: 'ME',
      acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
      currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '生成可核对的 Markdown', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n,
      criterionId: 'c1', statement: '人工核对摘要', required: true,
      method: 'HUMAN', targetSpec: {} });
  });
  const source = withSource ? await createKnowledge(app.db, { workspaceId,
    projectId, commandId: randomUUID(), title: 'Draft preview source',
    source: { sourceKind: 'NOTE', text: '受限资料正文' } }) : null;
  const delegated = await delegateTask(app.db, { workspaceId, taskId,
    commandId: randomUUID(), expectedTaskRevision: '0',
    ...(source === null ? {} : { contextSources: [{ kind: 'KNOWLEDGE' as const,
      root_id: source.result.knowledge_id!, version: '1' }] }) });
  const runId = delegated.result.run_id;
  const workerId = `draft-preview-${randomUUID()}`;
  const built = await advanceRunStep(app.db, { runId, workerId, storage });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  assert.equal(built.step_kind, 'BUILD_CONTEXT');
  return { workspaceId, projectId, taskId, runId, workerId, source };
}

function previewPath(f: { workspaceId: string; runId: string }) {
  return workspacePath(f.workspaceId, `/runs/${f.runId}/draft-preview`);
}

function blockedDraft(f: Awaited<ReturnType<typeof fixture>>, workerId = f.workerId) {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const completion = advanceRunStep(app.db, { runId: f.runId, workerId, storage,
    hooks: { beforeCommit: async () => { entered(); await wait; } } });
  return { reached: withTimeout(reached, 15_000, 'DRAFT beforeCommit'),
    release: () => release(), completion };
}

interface Preview {
  run_id: string; run_status: string; step_attempt_id: string | null;
  attempt_claim_epoch: string | null; model_call_id: string | null;
  preview_revision: string; preview_text: string | null;
  preview_truncated: boolean; preview_available: boolean;
}

test('separate HTTP process reads the disposable Markdown prefix before candidate commit', async () => {
  const f = await fixture();
  const draft = blockedDraft(f);
  try {
    await draft.reached;
    const response = await api.get(previewPath(f));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    const live = response.body as Preview;
    assert.equal(live.run_id, f.runId);
    assert.equal(live.run_status, 'RUNNING');
    assert.equal(live.preview_available, true);
    assert.match(live.preview_text ?? '', /^# Draft preview/u);
    assert.equal(live.preview_revision, '1');
    assert.ok(live.step_attempt_id && live.model_call_id && live.attempt_claim_epoch);
    assert.deepEqual((await api.get(previewPath(f))).body, live);
    const artifactCount = await sql<{ count: string }>`select count(*)::text as count
      from artifact_versions v join artifacts a on a.id = v.artifact_id
      where a.task_id = ${f.taskId}`.execute(app.db);
    assert.equal(artifactCount.rows[0]?.count, '0');
    const other = await fixture();
    expectProblem(await api.get(workspacePath(other.workspaceId,
      `/runs/${f.runId}/draft-preview`)), 404, 'RESOURCE_NOT_FOUND');
    assert.equal((await api.get(previewPath(f), { headers: {
      authorization: 'Bearer wrong' } })).status, 401);
  } finally { draft.release(); }
  assert.equal((await draft.completion).status, 'STEP_SUCCEEDED');
  const done = (await api.get(previewPath(f))).body as Preview;
  assert.equal(done.preview_available, false);
  assert.equal(done.preview_text, null);
  assert.equal(done.model_call_id, null);
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from run_draft_previews where run_id = ${f.runId}`.execute(app.db);
  assert.equal(rows.rows[0]?.count, '0');
});

test('a read-first Run already in RUNNING advances its current position to DRAFT', async () => {
  const f = await fixture();
  const built = (await sql<{ id: string }>`select id from run_steps
    where run_id = ${f.runId} and step_kind = 'BUILD_CONTEXT'`.execute(app.db)).rows[0]!;
  const moved = await sql`update runs set status = 'RUNNING',
    current_step_id = ${built.id}, revision = revision + 1
    where id = ${f.runId} and status = 'PLANNING'`.execute(app.db);
  assert.equal(moved.numAffectedRows, 1n);
  const draft = blockedDraft(f);
  try {
    await draft.reached;
    const live = (await api.get(previewPath(f))).body as Preview;
    assert.equal(live.preview_available, true);
    const position = (await sql<{ current_step_id: string; draft_step_id: string }>`
      select r.current_step_id, s.id as draft_step_id from runs r
      join run_steps s on s.run_id = r.id and s.step_kind = 'DRAFT'
      where r.id = ${f.runId}`.execute(app.db)).rows[0]!;
    assert.equal(position.current_step_id, position.draft_step_id);
  } finally { draft.release(); }
  assert.equal((await draft.completion).status, 'STEP_SUCCEEDED');
});

test('fenced Worker cannot restore an old preview; a new claim uses a new identity', async () => {
  const f = await fixture();
  const first = blockedDraft(f);
  let old!: { run_id: string; step_attempt_id: string; attempt_claim_epoch: bigint;
    run_worker_epoch: bigint; worker_id: string; invocation_epoch: bigint | null;
    model_call_id: string };
  try {
    await first.reached;
    const rows = await sql<typeof old>`select run_id, step_attempt_id,
      attempt_claim_epoch, run_worker_epoch, worker_id, invocation_epoch, model_call_id
      from run_draft_previews where run_id = ${f.runId}`.execute(app.db);
    old = rows.rows[0]!;
    await withTransaction(app.db, async (r) => {
      await lockTaskAndRun(r, f.runId);
      assert.ok(await r.runs.fenceWorker(f.runId));
    });
    const hidden = (await api.get(previewPath(f))).body as Preview;
    assert.equal(hidden.preview_available, false);
    assert.equal(hidden.preview_text, null);
    const call = await sql<{ manifest_id: string; input_sha256: Buffer }>`
      select manifest_id, input_sha256 from model_calls where id = ${old.model_call_id}`
      .execute(app.db);
    const wrote = await publishRunDraftPreview(app.db, {
      workspaceId: f.workspaceId, runId: f.runId,
      stepId: (await sql<{ step_id: string }>`select step_id from step_attempts
        where id = ${old.step_attempt_id}`.execute(app.db)).rows[0]!.step_id,
      attemptId: old.step_attempt_id, attemptClaimEpoch: old.attempt_claim_epoch,
      runWorkerEpoch: old.run_worker_epoch, workerId: old.worker_id,
      modelCallId: old.model_call_id, manifestId: call.rows[0]!.manifest_id,
      inputHash: call.rows[0]!.input_sha256.toString('hex'),
      text: '迟到内容', truncated: false,
    });
    assert.equal(wrote, false);
  } finally { first.release(); }
  assert.equal((await first.completion).status, 'STALE_RESULT');
  const second = blockedDraft(f, 'new-draft-worker');
  try {
    await second.reached;
    const current = (await api.get(previewPath(f))).body as Preview;
    assert.equal(current.preview_available, true);
    assert.notEqual(current.model_call_id, old.model_call_id);
    assert.notEqual(current.attempt_claim_epoch, old.attempt_claim_epoch.toString());
  } finally { second.release(); }
  assert.equal((await second.completion).status, 'STEP_SUCCEEDED');
});

test('pending control and stale context suppress the prefix before full settlement', async () => {
  const f = await fixture();
  const draft = blockedDraft(f);
  try {
    await draft.reached;
    assert.equal(((await api.get(previewPath(f))).body as Preview).preview_available, true);
    await withTransaction(app.db, async (r) => {
      const task = await r.tasks.readTask(f.taskId);
      assert.ok(task);
      await r.tasks.updateTaskTitle(task.id, task.revision, 'Changed context title');
    });
    const stale = (await api.get(previewPath(f))).body as Preview;
    assert.equal(stale.preview_available, false);
    assert.equal(stale.preview_text, null);
    const task = (await sql<{ revision: bigint }>`select revision from tasks
      where id = ${f.taskId}`.execute(app.db)).rows[0]!;
    const run = (await sql<{ revision: bigint }>`select revision from runs
      where id = ${f.runId}`.execute(app.db)).rows[0]!;
    await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
      commandId: randomUUID(), expectedTaskRevision: task.revision.toString(),
      expectedRunRevision: run.revision.toString(), type: 'CANCEL' });
    const pending = (await api.get(previewPath(f))).body as Preview;
    assert.equal(pending.preview_available, false);
    assert.equal(pending.preview_text, null);
  } finally { draft.release(); }
  assert.equal((await draft.completion).status, 'CONTROL_PENDING');
});

test('retiring a selected Knowledge source hides the in-flight draft without source refs', async () => {
  const f = await fixture(true);
  assert.ok(f.source);
  const draft = blockedDraft(f);
  try {
    await draft.reached;
    assert.equal(((await api.get(previewPath(f))).body as Preview).preview_available, true);
    await retireInformation(app.db, { workspaceId: f.workspaceId,
      kind: 'knowledge', id: f.source.result.knowledge_id!,
      commandId: randomUUID(), expectedRevision: f.source.result.revision });
    const response = await api.get(previewPath(f));
    assert.equal(response.status, 200, response.text);
    const hidden = response.body as Preview;
    assert.equal(hidden.preview_available, false);
    assert.equal(hidden.preview_text, null);
    assert.equal(JSON.stringify(hidden).includes(f.source.result.knowledge_id!), false);
  } finally { draft.release(); }
  // Source revocation is a preview read fence; the underlying DRAFT follows its
  // existing business commit protocol and is not rewritten by this projection.
  assert.equal((await draft.completion).status, 'STEP_SUCCEEDED');
});
