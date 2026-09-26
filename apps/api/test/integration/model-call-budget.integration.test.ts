import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { recordModelInvocation } from '../../src/application/model-call-recorder.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository, ModelScopeBudgetError }
  from '../../src/model/model-call-repository.js';
import { ModelCallBudgetError } from '../../src/workflow/openai-compatible-model-port.js';
import type { ModelIdentity } from '../../src/workflow/fake-model-port.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m04-budget');
let dataRoot: string;
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

const identity: ModelIdentity = {
  provider: 'openai-compatible', model: 'fixture-model',
  configFingerprint: createHash('sha256').update('fixture-model').digest('hex'),
  budget: { callReservationTokens: 100, scopeCallLimit: 4,
    scopeTokenLimit: 150 },
};

async function runFixture(): Promise<{ workspaceId: string; runId: string;
  draftAttemptId: string; verifyAttemptId: string; manifestId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'budget-run' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId,
      title: 'Budget Project', projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId,
      title: 'Budget Task', status: 'READY', mode: 'ME', acceptanceRevision: 1n,
      executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: 'Produce a draft', requiredOutputSpec: {}, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n,
      criterionId: 'human', statement: 'Check draft', required: true,
      method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId,
    commandId: randomUUID(), expectedTaskRevision: '0' });
  const runId = delegated.result.run_id;
  const r = createRepositories(app.db);
  const steps = await r.runs.listSteps(runId);
  const draft = steps.find((step) => step.step_kind === 'DRAFT')!;
  const verify = steps.find((step) => step.step_kind === 'VERIFY')!;
  const draftAttemptId = randomUUID();
  const verifyAttemptId = randomUUID();
  const manifestId = randomUUID();
  await r.runs.insertStepAttempt({ id: draftAttemptId, stepId: draft.id,
    attemptNumber: 1n, attemptKey: 'budget-draft' });
  await r.runs.insertStepAttempt({ id: verifyAttemptId, stepId: verify.id,
    attemptNumber: 1n, attemptKey: 'budget-verify' });
  await r.runs.insertContextManifest({ id: manifestId, runId,
    stepId: draft.id, builderVersion: 'budget-fixture',
    manifestHash: createHash('sha256').update(manifestId).digest(), payload: {} });
  return { workspaceId, runId, draftAttemptId, verifyAttemptId, manifestId };
}

async function assistFixture(): Promise<{ workspaceId: string; sessionId: string;
  firstId: string; secondId: string }> {
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  const firstId = randomUUID();
  const secondId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'budget-assist' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.assist.insertSession({ id: sessionId, workspaceId,
      projectId: null, taskId: null, title: 'Budget Session' });
    await r.assist.insertMessage({ id: firstId, sessionId, seq: 1n,
      role: 'ASSISTANT', status: 'RUNNING', intent: 'DISCUSS',
      content: null, sources: [] });
    await r.assist.insertMessage({ id: secondId, sessionId, seq: 2n,
      role: 'ASSISTANT', status: 'RUNNING', intent: 'DISCUSS',
      content: null, sources: [] });
  });
  return { workspaceId, sessionId, firstId, secondId };
}

test('DRAFT and SEMANTIC share one Run budget; STARTED reservation and actual usage differ',
  async () => {
    const f = await runFixture();
    const calls = new ModelCallRepository(app.db);
    const draftId = randomUUID();
    await calls.begin(draftId, { workspaceId: f.workspaceId, kind: 'DRAFT',
      stepAttemptId: f.draftAttemptId, manifestId: f.manifestId }, identity);
    await assert.rejects(() => calls.begin(randomUUID(), {
      workspaceId: f.workspaceId, kind: 'SEMANTIC_CHECK',
      stepAttemptId: f.verifyAttemptId, criterionId: 'human', checkAttempt: 1,
    }, identity), ModelScopeBudgetError);
    await calls.settle(draftId, { status: 'COMPLETED',
      usage: { inputTokens: 12, outputTokens: 8 } });
    const semanticId = randomUUID();
    await calls.begin(semanticId, { workspaceId: f.workspaceId,
      kind: 'SEMANTIC_CHECK', stepAttemptId: f.verifyAttemptId,
      criterionId: 'human', checkAttempt: 1 }, identity);
    const row = (await sql<{ budget_reserved_tokens: number; status: string }>`
      select budget_reserved_tokens, status from model_calls where id = ${semanticId}`
      .execute(app.db)).rows[0]!;
    assert.equal(row.budget_reserved_tokens, 100);
    assert.equal(row.status, 'STARTED');
    await assert.rejects(() => calls.begin(randomUUID(), {
      workspaceId: f.workspaceId, kind: 'DRAFT', stepAttemptId: f.draftAttemptId,
      manifestId: f.manifestId }, identity), ModelScopeBudgetError);
    await calls.settle(semanticId, { status: 'FAILED',
      usage: { inputTokens: 120, outputTokens: 80 },
      errorKind: 'ModelCallBudgetError' });
    const actual = (await sql<{ usage_input_tokens: number;
      usage_output_tokens: number }>`select usage_input_tokens, usage_output_tokens
      from model_calls where id = ${semanticId}`.execute(app.db)).rows[0]!;
    assert.deepEqual(actual, { usage_input_tokens: 120, usage_output_tokens: 80 });
    await assert.rejects(() => calls.begin(randomUUID(), {
      workspaceId: f.workspaceId, kind: 'DRAFT', stepAttemptId: f.draftAttemptId,
      manifestId: f.manifestId }, identity), ModelScopeBudgetError);
  });

test('two Assist workers serialize on Session; old unknown row blocks rather than counting zero',
  async () => {
    const f = await assistFixture();
    const calls = new ModelCallRepository(app.db);
    const tight: ModelIdentity = { ...identity, budget: {
      callReservationTokens: 100, scopeCallLimit: 1, scopeTokenLimit: 100 } };
    const starts = await Promise.allSettled([
      calls.begin(randomUUID(), { workspaceId: f.workspaceId, kind: 'ASSIST',
        assistMessageId: f.firstId }, tight),
      calls.begin(randomUUID(), { workspaceId: f.workspaceId, kind: 'ASSIST',
        assistMessageId: f.secondId }, tight),
    ]);
    assert.deepEqual(starts.map((result) => result.status).sort(),
      ['fulfilled', 'rejected']);
    assert.ok(starts.some((result) => result.status === 'rejected' &&
      result.reason instanceof ModelScopeBudgetError));
    const count = (await sql<{ count: string }>`select count(*)::text as count
      from model_calls where assist_message_id in (${f.firstId}, ${f.secondId})`
      .execute(app.db)).rows[0]!;
    assert.equal(count.count, '1');

    const old = await assistFixture();
    await calls.begin(randomUUID(), { workspaceId: old.workspaceId,
      kind: 'ASSIST', assistMessageId: old.firstId }, {
      provider: 'fake', model: 'old', configFingerprint: identity.configFingerprint });
    await assert.rejects(() => calls.begin(randomUUID(), {
      workspaceId: old.workspaceId, kind: 'ASSIST', assistMessageId: old.secondId,
    }, identity), ModelScopeBudgetError);
  });

test('the model call row commits before Provider work and does not hold the Run lock',
  async () => {
    const f = await runFixture();
    const call = await recordModelInvocation(app.db, {
      origin: { workspaceId: f.workspaceId, kind: 'DRAFT',
        stepAttemptId: f.draftAttemptId, manifestId: f.manifestId },
      identity,
      invoke: async () => {
        await app.db.transaction().execute(async (trx) => {
          const row = await sql<{ id: string }>`select id from runs
            where id = ${f.runId} for update nowait`.execute(trx);
          assert.equal(row.rows[0]!.id, f.runId);
        });
        return { providerRequestId: 'fixture', usage: {
          inputTokens: 10, outputTokens: 11 } };
      },
      settle: (result) => ({ status: 'COMPLETED',
        providerRequestId: result.providerRequestId, usage: result.usage }),
    });
    const row = (await sql<{ status: string; usage_input_tokens: number }>`
      select status, usage_input_tokens from model_calls where id = ${call.callId}`
      .execute(app.db)).rows[0]!;
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.usage_input_tokens, 10);
  });

test('failed complete Provider response retains known usage and request identity', async () => {
  const f = await assistFixture();
  let thrown: ModelCallBudgetError | undefined;
  await assert.rejects(() => recordModelInvocation(app.db, {
    origin: { workspaceId: f.workspaceId, kind: 'ASSIST',
      assistMessageId: f.firstId }, identity,
    invoke: async () => {
      thrown = new ModelCallBudgetError('provider-fixture',
        { inputTokens: 120, outputTokens: 80 });
      throw thrown;
    },
    settle: () => ({ status: 'COMPLETED' }),
  }), ModelCallBudgetError);
  assert.ok(thrown);
  const row = (await sql<{ status: string; provider_request_id: string;
    usage_input_tokens: number; usage_output_tokens: number;
    budget_reserved_tokens: number }>`select status, provider_request_id,
      usage_input_tokens, usage_output_tokens, budget_reserved_tokens
      from model_calls where assist_message_id = ${f.firstId}`.execute(app.db)).rows[0]!;
  assert.deepEqual(row, { status: 'FAILED', provider_request_id: 'provider-fixture',
    usage_input_tokens: 120, usage_output_tokens: 80,
    budget_reserved_tokens: 100 });
});

test('exhausted real Provider budget fails DRAFT before any network invocation', async () => {
  const f = await runFixture();
  const storage = new ManagedContentStore(dataRoot);
  const built = await advanceRunStep(app.db, { runId: f.runId,
    workerId: 'budget-fixture-worker', storage });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  await new ModelCallRepository(app.db).begin(randomUUID(), {
    workspaceId: f.workspaceId, kind: 'DRAFT',
    stepAttemptId: f.draftAttemptId, manifestId: f.manifestId,
  }, identity);
  const previous = {
    provider: process.env.RELAY_MODEL_PROVIDER,
    key: process.env.RELAY_MODEL_API_KEY,
    name: process.env.RELAY_MODEL_NAME,
    calls: process.env.RELAY_MODEL_MAX_SCOPE_CALLS,
  };
  process.env.RELAY_MODEL_PROVIDER = 'openai-compatible';
  process.env.RELAY_MODEL_API_KEY = 'fixture-key-never-sent';
  process.env.RELAY_MODEL_NAME = 'fixture-model';
  process.env.RELAY_MODEL_MAX_SCOPE_CALLS = '1';
  try {
    const result = await advanceRunStep(app.db, { runId: f.runId,
      workerId: 'budget-fixture-worker', storage });
    assert.equal(result.status, 'RUN_FAILED');
    assert.equal(result.reason, 'MODEL_BUDGET_EXHAUSTED');
    const run = (await sql<{ status: string; worker_id: string | null }>`
      select status, worker_id from runs where id = ${f.runId}`.execute(app.db)).rows[0]!;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.worker_id, null);
    const rows = (await sql<{ count: string }>`select count(*)::text as count
      from model_calls c join step_attempts a on a.id = c.step_attempt_id
      join run_steps s on s.id = a.step_id where s.run_id = ${f.runId}`
      .execute(app.db)).rows[0]!;
    assert.equal(rows.count, '1');
  } finally {
    for (const [key, value] of [
      ['RELAY_MODEL_PROVIDER', previous.provider],
      ['RELAY_MODEL_API_KEY', previous.key],
      ['RELAY_MODEL_NAME', previous.name],
      ['RELAY_MODEL_MAX_SCOPE_CALLS', previous.calls],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
