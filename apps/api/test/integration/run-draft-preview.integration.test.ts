import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { requestRunControl } from '../../src/application/control-requests.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createKnowledge, retireInformation }
  from '../../src/application/information-commands.js';
import { lockTaskAndRun } from '../../src/application/lock-task-run.js';
import { recordModelInvocation } from '../../src/application/model-call-recorder.js';
import { publishRunDraftPreview, recordRunDraftFirstTextDelta }
  from '../../src/application/run-draft-preview.js';
import { draftInputHash } from '../../src/application/run-read-evidence.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { AssistLivePreviewPublisher } from '../../src/assist/live-preview.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { CANDIDATE_OUTPUT_SCHEMA, validateCandidate }
  from '../../src/workflow/markdown-deliverable.js';
import { OpenAiCompatibleModelPort }
  from '../../src/workflow/openai-compatible-model-port.js';
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

// Controlled composition, not the Worker path: advanceRunStep has no transport
// injection. Build one real claim through its repositories, without a Fake DRAFT
// or a second model call on the same Attempt.
async function controlledDraftClaim() {
  const f = await fixture();
  return withTransaction(app.db, async (r) => {
    const { run } = await lockTaskAndRun(r, f.runId, f.workspaceId);
    const built = await r.runs.readStepByKind(run.id, 'BUILD_CONTEXT');
    assert.equal(built?.status, 'SUCCEEDED');
    const manifestHash = built?.result_ref?.manifest_hash;
    assert.equal(typeof manifestHash, 'string');
    const manifest = await r.runs.readContextManifestByHash(run.id,
      Buffer.from(manifestHash as string, 'hex'));
    assert.ok(manifest);
    const step = await r.runs.readStepByKind(run.id, 'DRAFT');
    assert.equal(step?.status, 'PENDING');
    assert.ok(step);
    const leaseUntil = new Date(Date.now() + 60_000);
    const worker = await r.runs.claimWorker(run.id, f.workerId, leaseUntil);
    assert.ok(worker);
    const inserted = await r.runs.insertStepAttempt({ id: randomUUID(),
      stepId: step.id, attemptNumber: 1n, attemptKey: 'DRAFT#1' });
    assert.equal(inserted.inserted, true);
    const attempt = await r.runs.claimAttempt({ attemptId: inserted.row.id,
      workerId: f.workerId, leaseUntil });
    assert.ok(attempt);
    const runningStep = await r.runs.advanceStep({ stepId: step.id,
      expectedRevision: step.revision, status: 'RUNNING' });
    assert.ok(runningStep);
    assert.ok(await r.runs.advanceRun({ runId: run.id,
      expectedRevision: worker.revision, status: 'RUNNING', currentStepId: step.id }));
    return { ...f, step: runningStep, attempt, worker, manifest,
      inputHash: draftInputHash(manifest.payload, CANDIDATE_OUTPUT_SCHEMA) };
  });
}

async function settleControlledClaim(f: Awaited<ReturnType<typeof controlledDraftClaim>>,
  content: string | null) {
  await withTransaction(app.db, async (r) => {
    await lockTaskAndRun(r, f.runId, f.workspaceId);
    if ((await r.runs.readAttempt(f.attempt.id))?.status !== 'RUNNING') return;
    const resultRef = content === null ? null : { content };
    assert.ok(await r.runs.recordAttemptOutcome({ attemptId: f.attempt.id,
      expectedClaimEpoch: f.attempt.claim_epoch,
      status: content === null ? 'REJECTED_STALE' : 'SUCCEEDED',
      resultRef, evidence: null }));
    assert.ok(await r.runs.advanceStep({ stepId: f.step.id,
      expectedRevision: f.step.revision, status: content === null ? 'FAILED' : 'SUCCEEDED',
      resultRef }));
    assert.ok(await r.runs.releaseWorker(f.runId, f.workerId, f.worker.worker_epoch));
  });
}

function controlledSseEvent(content: string | null, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-controlled',
    object: 'chat.completion.chunk', created: 1, model: 'controlled-model',
    choices: content === null ? [] : [{ index: 0,
      delta: { role: 'assistant', content }, finish_reason: finishReason }],
    ...(content === null ? { usage: { prompt_tokens: 40,
      completion_tokens: 12, total_tokens: 52 } } : {}) })}\n\n`;
}

test('controlled SDK stream observes one call through first durable preview before DONE', async () => {
  const f = await controlledDraftClaim();
  const calls = new ModelCallRepository(app.db);
  const firstText = '# Draft preview\n\n## 摘要\n首个受控片段';
  const tail = '\n\n## 结论\n完整受控结果';
  const stages: { stage: string; elapsed_ms: number }[] = [];
  const started = performance.now();
  const observe = (stage: string) => stages.push({ stage,
    elapsed_ms: Number((performance.now() - started).toFixed(3)) });
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let fetchReached!: () => void;
  const fetched = new Promise<void>((resolve) => { fetchReached = resolve; });
  let previewReached!: () => void;
  const published = new Promise<void>((resolve) => { previewReached = resolve; });
  let fetchCount = 0;
  let lookupCount = 0;
  let doneSent = false;
  let callId = '';
  const deltas: string[] = [];
  const model = new OpenAiCompatibleModelPort({ provider: 'openai-compatible',
    model: 'controlled-model', apiKey: 'fixture-key',
    baseUrl: 'https://models.vendor.com/v1', timeoutMs: 30_000,
    maxOutputTokens: 256, maxCallTokens: 4_096,
    maxScopeCalls: 32, maxScopeTokens: 262_144 }, {
    lookup: async () => { lookupCount += 1; return [{ address: '8.8.8.8', family: 4 }]; },
    fetch: async (_input, init) => {
      fetchCount += 1;
      observe('fetch_called');
      assert.equal(init?.redirect, 'error');
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          // Role-only and usage-only chunks contain no text. Keep the stream
          // open until PG and the separate API have observed the first prefix.
          controller.enqueue(encoder.encode(controlledSseEvent('') + controlledSseEvent(null)));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
      fetchReached();
      return response;
    },
  });
  const finish = () => {
    if (doneSent || stream === undefined) return;
    doneSent = true;
    stream.enqueue(encoder.encode(controlledSseEvent(tail, 'stop') + 'data: [DONE]\n\n'));
    stream.close();
  };
  const invocation = recordModelInvocation(app.db, {
    origin: { workspaceId: f.workspaceId, kind: 'DRAFT',
      stepAttemptId: f.attempt.id, manifestId: f.manifest.id, inputHash: f.inputHash },
    identity: model.identity,
    invoke: async (id) => {
      callId = id;
      const begun = await calls.read(id);
      assert.ok(begun);
      assert.equal(begun?.status, 'STARTED');
      assert.equal(begun.settled_at, null);
      observe('ledger_committed');
      const preview = new AssistLivePreviewPublisher(async (text, truncated) => {
        const wrote = await publishRunDraftPreview(app.db, { workspaceId: f.workspaceId,
          runId: f.runId, stepId: f.step.id, attemptId: f.attempt.id,
          attemptClaimEpoch: f.attempt.claim_epoch, runWorkerEpoch: f.worker.worker_epoch,
          workerId: f.workerId, modelCallId: id, manifestId: f.manifest.id,
          inputHash: f.inputHash, text, truncated });
        assert.equal(wrote, true);
        if (!stages.some((item) => item.stage === 'first_preview_committed')) {
          observe('first_preview_committed');
          previewReached();
        }
        return wrote;
      }, () => assert.fail('controlled claim lost preview ownership'));
      const result = await model.generate({ manifest: f.manifest.payload,
        outputSchema: CANDIDATE_OUTPUT_SCHEMA, onTextDelta: async (piece) => {
          if (deltas.length === 0) {
            observe('first_text_delta');
            assert.equal(await recordRunDraftFirstTextDelta(app.db, {
              workspaceId: f.workspaceId, runId: f.runId, stepId: f.step.id,
              attemptId: f.attempt.id, attemptClaimEpoch: f.attempt.claim_epoch,
              runWorkerEpoch: f.worker.worker_epoch, workerId: f.workerId,
              modelCallId: id, manifestId: f.manifest.id, inputHash: f.inputHash,
              observedAt: new Date(),
            }), true);
          }
          deltas.push(piece);
          await preview.push(piece);
        } });
      await preview.flush();
      return result;
    },
    settle: (result) => {
      assert.equal(result.kind, 'CONTENT');
      if (result.kind !== 'CONTENT') throw new Error('controlled content missing');
      return { status: 'COMPLETED', providerRequestId: result.providerRequestId,
        usage: result.usage };
    },
  });
  try {
    await withTimeout(Promise.race([fetched, invocation.then(() =>
      assert.fail('controlled call settled before fetch'))]), 15_000, 'controlled SDK fetch');
    assert.equal((await calls.read(callId))?.settled_at, null);
    assert.equal((await calls.read(callId))?.first_text_delta_at, null);
    assert.equal((await calls.read(callId))?.first_preview_persisted_at, null);
    const previewOwner = { workspaceId: f.workspaceId, runId: f.runId,
      stepId: f.step.id, attemptId: f.attempt.id, attemptClaimEpoch: f.attempt.claim_epoch,
      runWorkerEpoch: f.worker.worker_epoch, workerId: f.workerId,
      modelCallId: callId, manifestId: f.manifest.id, inputHash: f.inputHash };
    assert.equal(await recordRunDraftFirstTextDelta(app.db, { ...previewOwner,
      modelCallId: randomUUID(), observedAt: new Date() }), false);
    const empty = (await api.get(previewPath(f))).body as Preview;
    assert.equal(empty.preview_text, null);
    assert.equal(empty.model_call_id, null);
    stream.enqueue(encoder.encode(controlledSseEvent(firstText)));
    await withTimeout(published, 15_000, 'first committed prefix');
    const durable = (await sql<{ model_call_id: string; preview_text: string }>`
      select model_call_id, preview_text from run_draft_previews where run_id = ${f.runId}`
      .execute(app.db)).rows[0]!;
    assert.equal(durable.model_call_id, callId);
    assert.equal(durable.preview_text, firstText);
    const response = await api.get(previewPath(f));
    assert.equal(response.status, 200, response.text);
    const live = response.body as Preview;
    assert.equal(live.model_call_id, callId);
    assert.equal(live.step_attempt_id, f.attempt.id);
    assert.equal(live.preview_text, firstText);
    assert.equal(live.preview_revision, '1');
    assert.deepEqual(deltas, [firstText]);
    assert.equal(doneSent, false);
    const beforeDone = await calls.read(callId);
    assert.ok(beforeDone);
    assert.equal(beforeDone?.status, 'STARTED');
    assert.equal(beforeDone.settled_at, null);
    assert.ok(beforeDone.first_text_delta_at);
    assert.ok(beforeDone.first_preview_persisted_at);
    assert.ok(beforeDone.first_preview_persisted_at >= beforeDone.first_text_delta_at);
    const firstTimes = [beforeDone.first_text_delta_at.toISOString(),
      beforeDone.first_preview_persisted_at.toISOString()];
    assert.equal(await recordRunDraftFirstTextDelta(app.db, { ...previewOwner,
      observedAt: new Date(Date.now() + 60_000) }), true);
    assert.equal((await calls.read(callId))?.first_text_delta_at?.toISOString(), firstTimes[0]);
    observe('pre_done_api_read');
    finish();
    const recorded = await withTimeout(invocation, 15_000, 'controlled model settlement');
    assert.equal(recorded.callId, callId);
    assert.equal(recorded.result.kind, 'CONTENT');
    if (recorded.result.kind !== 'CONTENT') assert.fail('controlled content missing');
    assert.equal(recorded.result.content, firstText + tail);
    assert.equal(validateCandidate(recorded.result.content).ok, true);
    assert.deepEqual(deltas, [firstText, tail]);
    const settled = await calls.read(callId);
    assert.ok(settled);
    assert.equal(settled?.status, 'COMPLETED');
    assert.ok(settled.settled_at && settled.settled_at >= settled.started_at);
    assert.deepEqual([settled.first_text_delta_at?.toISOString(),
      settled.first_preview_persisted_at?.toISOString()], firstTimes);
    observe('model_settled');
    assert.equal((await calls.listForStepAttempt(f.attempt.id)).length, 1);
    await settleControlledClaim(f, recorded.result.content);
    assert.equal(((await api.get(previewPath(f))).body as Preview).preview_text, null);
    assert.equal((await sql`select run_id from run_draft_previews
      where run_id = ${f.runId}`.execute(app.db)).rows.length, 0);
    const trace = await api.get(workspacePath(f.workspaceId, `/runs/${f.runId}/trace`));
    assert.equal(trace.status, 200, trace.text);
    const traceCall = (trace.body as { model_calls: { id: string;
      first_text_delta_at: string | null; first_preview_persisted_at: string | null }[] })
      .model_calls.find((call) => call.id === callId)!;
    assert.deepEqual([traceCall.first_text_delta_at, traceCall.first_preview_persisted_at],
      firstTimes);
    observe('attempt_settled_preview_removed');
    assert.equal(fetchCount, 1);
    assert.equal(lookupCount, 1);
    assert.deepEqual(stages.map((item) => item.stage), ['ledger_committed', 'fetch_called',
      'first_text_delta', 'first_preview_committed', 'pre_done_api_read',
      'model_settled', 'attempt_settled_preview_removed']);
    console.log(JSON.stringify({ type: 'controlled_first_output', call_id: callId,
      scope: 'SDK_SSE_PG_API_COMPOSITION', stages }));
  } finally {
    finish();
    await withTimeout(invocation, 15_000, 'controlled stream cleanup').catch(() => {});
    await settleControlledClaim(f, null);
  }
});

test('late DRAFT text after cancel or Worker fencing leaves both first times NULL', async () => {
  for (const scenario of ['cancel', 'fence'] as const) {
    const f = await fixture();
    const original = FakeModelPort.prototype.generate;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    FakeModelPort.prototype.generate = async function (input) {
      await input.onTextDelta?.('');
      entered();
      await proceed;
      return original.call(this, input);
    };
    const completion = advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage });
    try {
      await withTimeout(started, 15_000, 'DRAFT before first text');
      if (scenario === 'fence') {
        await withTransaction(app.db, async (r) => {
          await lockTaskAndRun(r, f.runId);
          assert.ok(await r.runs.fenceWorker(f.runId));
        });
      } else {
        const revisions = await withTransaction(app.db, async (r) => ({
          task: (await r.tasks.readTask(f.taskId))!, run: (await r.runs.readRun(f.runId))!,
        }));
        await requestRunControl(app.db, { workspaceId: f.workspaceId, runId: f.runId,
          commandId: randomUUID(), expectedTaskRevision: revisions.task.revision.toString(),
          expectedRunRevision: revisions.run.revision.toString(), type: 'CANCEL' });
      }
    } finally {
      release();
      FakeModelPort.prototype.generate = original;
    }
    assert.equal((await completion).status, scenario === 'cancel' ? 'CONTROL_PENDING' : 'STALE_RESULT');
    const calls = (await sql<{ first_text_delta_at: Date | null;
      first_preview_persisted_at: Date | null }>`select c.first_text_delta_at,
      c.first_preview_persisted_at from model_calls c join step_attempts a
      on a.id = c.step_attempt_id join run_steps s on s.id = a.step_id
      where s.run_id = ${f.runId}`.execute(app.db)).rows;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { first_text_delta_at: null, first_preview_persisted_at: null });
    assert.equal(((await api.get(previewPath(f))).body as Preview).preview_text, null);
  }
});

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
    const call = await new ModelCallRepository(app.db).read(live.model_call_id);
    assert.ok(call?.first_text_delta_at && call.first_preview_persisted_at);
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

test('local DRAFT preview TypeErrors are isolated from Provider network diagnostics', async () => {
  for (const method of ['push', 'flush', 'firstPreview'] as const) {
    const f = await fixture();
    const originalPush = AssistLivePreviewPublisher.prototype.push;
    const originalFlush = AssistLivePreviewPublisher.prototype.flush;
    const originalFirstPreview = ModelCallRepository.prototype.recordFirstPreviewPersisted;
    const fail = async () => { throw new TypeError('TOP_SECRET_LOCAL_PREVIEW_PAYLOAD'); };
    if (method === 'firstPreview') ModelCallRepository.prototype.recordFirstPreviewPersisted = fail;
    else AssistLivePreviewPublisher.prototype[method] = fail;
    // Force flush failures through the post-generation catch, independently of push.
    if (method === 'flush') AssistLivePreviewPublisher.prototype.push = async () => {};
    try {
      await assert.rejects(advanceRunStep(app.db, { runId: f.runId,
        workerId: f.workerId, storage }), { name: 'RunDraftPreviewWriteError' });
    } finally {
      AssistLivePreviewPublisher.prototype.push = originalPush;
      AssistLivePreviewPublisher.prototype.flush = originalFlush;
      ModelCallRepository.prototype.recordFirstPreviewPersisted = originalFirstPreview;
    }
    const rows = await sql<{ status: string; error_kind: string }>`select c.status,
      c.error_kind from model_calls c join step_attempts a on a.id = c.step_attempt_id
      join run_steps s on s.id = a.step_id where s.run_id = ${f.runId}`.execute(app.db);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.status, 'FAILED');
    assert.equal(rows.rows[0]?.error_kind, 'RunDraftPreviewWriteError');
    if (method === 'firstPreview') {
      const call = (await sql<{ first_text_delta_at: Date | null;
        first_preview_persisted_at: Date | null }>`select c.first_text_delta_at,
        c.first_preview_persisted_at from model_calls c join step_attempts a
        on a.id = c.step_attempt_id join run_steps s on s.id = a.step_id
        where s.run_id = ${f.runId}`.execute(app.db)).rows[0]!;
      assert.ok(call.first_text_delta_at);
      assert.equal(call.first_preview_persisted_at, null);
      assert.equal((await sql`select run_id from run_draft_previews
        where run_id = ${f.runId}`.execute(app.db)).rows.length, 0);
    }
    const trace = await api.get(workspacePath(f.workspaceId, `/runs/${f.runId}/trace`));
    assert.equal(trace.status, 200, trace.text);
    assert.equal((trace.body as { model_calls: { provider_error_kind: string | null }[] })
      .model_calls[0]?.provider_error_kind, null);
    assert.equal(trace.text.includes('TOP_SECRET_LOCAL_PREVIEW_PAYLOAD'), false);
    assert.equal(trace.text.includes('RunDraftPreviewWriteError'), false);
  }
});
