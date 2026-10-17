import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { readAssistModelRuntime } from '../../src/application/assist-model-runtime.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { syncModelCatalog } from '../../src/application/model-catalog-sync.js';
import { selectSessionModel } from '../../src/application/select-session-model.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

// Explicit opt-in only. The credential is inherited in memory by the isolated
// integration runner, never included in arguments, fixtures, snapshots or output.
test('live OpenRouter: real catalog → selection → frozen message → guarded generation → original ledger',
  { skip: process.env.RELAY_ACCEPTANCE_REAL_OPENROUTER !== '1', timeout: 180_000 }, async () => {
    assert.ok(process.env.RELAY_OPENROUTER_API_KEY, 'a separately configured credential is required');
    const app = openDatabase(APP_DATABASE_URL, 'relay-free-model-live-test');
    let dataRoot: string | undefined;
    const env: NodeJS.ProcessEnv = { RELAY_MODEL_PROVIDER: 'fake', RELAY_MODEL_CATALOG_ENABLED: 'true',
      RELAY_OPENROUTER_API_KEY: process.env.RELAY_OPENROUTER_API_KEY,
      RELAY_MODEL_MAX_OUTPUT_TOKENS: '512', RELAY_MODEL_MAX_CALL_TOKENS: '16384',
      RELAY_MODEL_MAX_SCOPE_CALLS: '3', RELAY_MODEL_MAX_SCOPE_TOKENS: '49152',
      RELAY_MODEL_TIMEOUT_MS: '60000' };
    try {
      await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
      dataRoot = await createDataRoot();
      const synced = await syncModelCatalog({ db: app.db, env, trigger: 'startup' });
      assert.equal(synced.status, 'PUBLISHED', 'real catalog must be read before generation');
      const repositories = createRepositories(app.db);
      const models = (await repositories.modelCatalog.readEntries(true))
        .filter((entry) => entry.source_model_id !== 'openrouter/free' &&
          entry.capabilities.text_input === true && entry.capabilities.text_output === true &&
          entry.capabilities.tools === true && entry.capabilities.response_format === true &&
          entry.context_window !== null && entry.context_window >= 16384)
        .sort((left, right) => left.source_model_id.localeCompare(right.source_model_id));
      const selected = models[0];
      assert.ok(selected, 'a concrete free model with declared text/tool/JSON support must exist');
      const workspaceId = await createWorkspace(app.db);
      const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(), title: 'Synthetic live acceptance' });
      const sessionId = created.result.session_id;
      const selection = await selectSessionModel(app.db, { workspaceId, sessionId, env,
        commandId: randomUUID(), requestedModel: selected.source_model_id });
      const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
        commandId: randomUUID(), expectedModelSelectionRevision: selection.result.revision,
        content: 'This is a synthetic connection test. Do not invoke tools, propose work, or change state. Reply with RELAY_LIVE_OK.' }, env);
      const wire: { model: string; guarded: boolean }[] = [];
      const result = await runAssistGenerationTick(app.db, { workerId: `live-${randomUUID()}`,
        storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(), modelEnv: env,
        modelFetchDependencies: { fetch: async (input, init) => {
          if (String(input).endsWith('/chat/completions')) {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const provider = body.provider as Record<string, unknown> | undefined;
            const prices = provider?.max_price as Record<string, unknown> | undefined;
            wire.push({ model: String(body.model), guarded: provider?.allow_fallbacks === false &&
              provider.require_parameters === true && ['prompt', 'completion', 'request', 'image']
                .every((key) => prices?.[key] === 0) && !('models' in body) && !('plugins' in body) });
          }
          return fetch(input, init);
        } }, leaseMs: 90_000, maxMessages: 1 });
      const runtime = await readAssistModelRuntime(app.db, { workspaceId, messageId: accepted.result.assistant_message_id });
      // Only safe metadata is printed. Provider response bodies, prompts, endpoint
      // configuration and account labels are intentionally omitted.
      console.log(JSON.stringify({ liveModelAcceptance: true, status: result?.status,
        preferredModel: runtime.preferred_model, actualModel: runtime.actual_model,
        calls: runtime.calls.map((call) => ({ model: call.model, status: call.status,
          errorKind: call.error_kind, inputTokens: call.input_tokens, outputTokens: call.output_tokens })),
        wireCalls: wire.length, allRequestsGuarded: wire.length > 0 && wire.every((call) => call.guarded) }));
      assert.equal(result?.status, 'COMPLETED', 'real generation must complete in the original message');
      assert.ok(wire.length > 0 && wire.length <= 3);
      assert.ok(wire.every((call) => call.guarded));
      assert.equal(runtime.calls.length, wire.length, 'each actual HTTP attempt must have its own original ledger row');
      assert.equal(runtime.preferred_model, selected.source_model_id);
      assert.equal(runtime.calls.at(-1)?.status, 'COMPLETED');
      const message = await repositories.assist.readMessage(accepted.result.assistant_message_id);
      assert.ok(message?.content?.trim(), 'the original assistant message must contain the real reply');
    } catch (error) {
      // Test runner inspection must never serialize an SDK error carrying request headers.
      if (error instanceof assert.AssertionError) throw error;
      throw new Error('Live acceptance stopped before completion; inspect safe ledger metadata and environment connectivity.');
    } finally {
      delete env.RELAY_OPENROUTER_API_KEY;
      await app.close();
      if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
    }
  });
