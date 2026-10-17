import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { readAssistModelRuntime } from '../../src/application/assist-model-runtime.js';
import { DomainError } from '../../src/application/domain-error.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-model-runtime-test');
before(async () => { await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY }); });
after(async () => { await app.close(); });

async function messageFixture() {
  const workspaceId = await createWorkspace(app.db);
  const sessionId = randomUUID(); const messageId = randomUUID();
  const repository = createRepositories(app.db).assist;
  await repository.insertSession({ id: sessionId, workspaceId, projectId: null, taskId: null, title: 'runtime projection' });
  await repository.insertMessage({ id: messageId, sessionId, seq: 1n, role: 'ASSISTANT', status: 'RUNNING',
    intent: 'DISCUSS', content: null, sources: [] });
  return { workspaceId, sessionId, messageId };
}

test('legacy runtime does not fabricate an initial model or zero use; foreign workspace cannot read it', async () => {
  const fixture = await messageFixture();
  const projection = await readAssistModelRuntime(app.db, fixture);
  assert.equal(projection.snapshot_available, false);
  assert.equal(projection.preferred_model, null);
  assert.equal(projection.actual_model, null);
  assert.deepEqual(projection.candidate_models, []);
  assert.equal(projection.free_daily_remaining, null);
  await assert.rejects(() => readAssistModelRuntime(app.db, { ...fixture, workspaceId: randomUUID() }),
    (error: unknown) => error instanceof DomainError && error.code === 'RESOURCE_NOT_FOUND');
});

test('actual model and unknown use come from the original ledger, including an unresolved call', async () => {
  const fixture = await messageFixture();
  const calls = new ModelCallRepository(app.db); const callId = randomUUID();
  await calls.begin(callId, { workspaceId: fixture.workspaceId, kind: 'ASSIST', assistMessageId: fixture.messageId },
    { provider: 'openrouter', model: 'projection/model:free', configFingerprint: 'a'.repeat(64) });
  const started = await readAssistModelRuntime(app.db, fixture);
  assert.equal(started.actual_model, 'projection/model:free');
  assert.equal(started.preferred_model, null);
  assert.equal(started.calls[0]?.status, 'STARTED');
  assert.equal(started.calls[0]?.input_tokens, null);
  assert.equal(started.calls[0]?.output_tokens, null);
  await calls.settle(callId, { status: 'FAILED', errorKind: 'RATE_LIMIT' });
  const failed = await readAssistModelRuntime(app.db, fixture);
  assert.equal(failed.calls[0]?.id, callId);
  assert.equal(failed.calls[0]?.status, 'FAILED');
  assert.equal(failed.calls[0]?.input_tokens, null);
  assert.equal(failed.failure_scope, null);
  assert.equal(failed.free_daily_remaining, null);
  assert.equal(JSON.stringify(failed).includes('config_fingerprint'), false);
});
