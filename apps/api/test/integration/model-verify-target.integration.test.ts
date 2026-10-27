import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { runModelPortVerification } from '../../src/application/model-port-verification.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { readCredentialFingerprint } from '../../src/workflow/credential-identity.js';
import { createOpenAiCompatibleVerifyCall, ModelVerifyTargetError,
  readModelVerificationState } from '../../src/workflow/model-port-verify.js';
import { createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * P1-4：验证**所选型号**，而不是只验证进程默认模型（真实 PG + 受控 Provider HTTP 接缝）。
 *
 * 证明：目标由调用方显式给出；OpenRouter 目录型号用独立聊天凭据 + 确切型号 + 零价硬限制；
 * 目录里不再是免费文本型号、或目录过期时**不探测、不记账**；状态按目标独立推导。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-model-verify-target-test');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

const OPENROUTER_KEY = 'synthetic-openrouter-verify-key';
const OTHER_KEY = 'synthetic-openrouter-verify-key-rotated';
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function controlledVerifyTransport() {
  const requests: { readonly body: Record<string, unknown>;
    readonly authorization: string | null }[] = [];
  const transport = {
    lookup: PUBLIC_LOOKUP,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const headers = new Headers(init?.headers ?? {});
      requests.push({ body: raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>,
        authorization: headers.get('authorization') });
      return new Response(JSON.stringify({ id: 'chatcmpl-verify-target',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return { requests, transport };
}

async function seedFreeModel(model: string): Promise<void> {
  await sql`insert into model_catalog_entries
    (source_model_id, display_name, context_window, pricing, capabilities, is_free,
     not_free_reason, fetched_at)
    values (${model}, ${model}, 131072, '{"prompt":"0","completion":"0"}'::jsonb,
    '{"text_input":true,"text_output":true,"tools":true,"response_format":true}'::jsonb,
    true, null, now())`.execute(app.db);
  await sql`update model_catalog_sync_state set snapshot_seq = snapshot_seq + 1,
    last_success_at = now() where singleton = true`.execute(app.db);
}

const openRouterEnv = (apiKey: string) => ({ RELAY_MODEL_PROVIDER: 'fake',
  RELAY_OPENROUTER_API_KEY: apiKey, RELAY_MODEL_MAX_OUTPUT_TOKENS: '512',
  RELAY_MODEL_MAX_CALL_TOKENS: '16384' });

test('an OpenRouter target probe uses the independent credential and the zero-price guard',
  async () => {
    const model = `verify-target-${randomUUID()}:free`;
    await seedFreeModel(model);
    const workspaceId = await createWorkspace(app.db);
    const provider = controlledVerifyTransport();
    const result = await runModelPortVerification({ db: app.db, workspaceId,
      env: openRouterEnv(OPENROUTER_KEY),
      call: createOpenAiCompatibleVerifyCall(provider.transport),
      target: { connection: 'openrouter', model } });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, model);

    // 探针本身是免费外呼：最终 HTTP 体必须带零价上限。
    assert.equal(provider.requests.length, 1);
    const body = provider.requests[0]!.body;
    assert.equal(body.model, model);
    const guard = body.provider as Record<string, unknown>;
    assert.deepEqual(guard.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
    assert.equal(guard.allow_fallbacks, false);
    // 用的是独立聊天凭据，不是进程默认模型的 Key。
    assert.equal(provider.requests[0]!.authorization, `Bearer ${OPENROUTER_KEY}`);

    const row = await new ModelCallRepository(app.db)
      .latestVerifyForModel('openrouter', model);
    assert.ok(row);
    assert.equal(row.kind, 'VERIFY');
    assert.equal(row.credential_fingerprint,
      readCredentialFingerprint({ provider: 'openrouter', apiKey: OPENROUTER_KEY }));

    const verified = await readModelVerificationState(app.db, openRouterEnv(OPENROUTER_KEY),
      { connection: 'openrouter', model });
    assert.equal(verified.target, `openrouter:${model}`);
    assert.equal(verified.connection, 'openrouter');
    assert.equal(verified.model, model);
    assert.equal(verified.state, 'VERIFIED');
    assert.equal(verified.credential_identity, 'MATCH');

    // 换 Key：同一型号的旧验证不再代表当前连接可执行。
    const rotated = await readModelVerificationState(app.db, openRouterEnv(OTHER_KEY),
      { connection: 'openrouter', model });
    assert.equal(rotated.state, 'CREDENTIAL_CHANGED');
    assert.equal(rotated.credential_identity, 'CHANGED');
    assert.equal(rotated.matches_current_config, false);
  });

test('a model that is not a free catalog entry is refused before any call or ledger row',
  async () => {
    const model = `verify-target-paid-${randomUUID()}:free`;
    await sql`insert into model_catalog_entries
      (source_model_id, display_name, context_window, pricing, capabilities, is_free,
       not_free_reason, fetched_at)
      values (${model}, ${model}, 131072, '{"prompt":"0.001","completion":"0.002"}'::jsonb,
      '{"text_input":true,"text_output":true}'::jsonb, false, 'NONZERO_PRICE', now())`
      .execute(app.db);
    await sql`update model_catalog_sync_state set snapshot_seq = snapshot_seq + 1,
      last_success_at = now() where singleton = true`.execute(app.db);
    const workspaceId = await createWorkspace(app.db);
    const before = await new ModelCallRepository(app.db).latestVerify();
    const provider = controlledVerifyTransport();
    await assert.rejects(runModelPortVerification({ db: app.db, workspaceId,
      env: openRouterEnv(OPENROUTER_KEY),
      call: createOpenAiCompatibleVerifyCall(provider.transport),
      target: { connection: 'openrouter', model } }), (error: unknown) =>
    error instanceof ModelVerifyTargetError &&
      error.code === 'MODEL_VERIFY_TARGET_NOT_ELIGIBLE');
    assert.equal(provider.requests.length, 0);
    const afterRow = await new ModelCallRepository(app.db).latestVerify();
    assert.equal(afterRow?.id, before?.id);

    const state = await readModelVerificationState(app.db, openRouterEnv(OPENROUTER_KEY),
      { connection: 'openrouter', model });
    assert.equal(state.state, 'FREE_INELIGIBLE');
  });

test('a stale catalog blocks the probe instead of guessing eligibility', async () => {
  const model = `verify-target-stale-${randomUUID()}:free`;
  await seedFreeModel(model);
  await sql`update model_catalog_sync_state set last_success_at = now() - interval '30 days'
    where singleton = true`.execute(app.db);
  const workspaceId = await createWorkspace(app.db);
  const provider = controlledVerifyTransport();
  await assert.rejects(runModelPortVerification({ db: app.db, workspaceId,
    env: openRouterEnv(OPENROUTER_KEY),
    call: createOpenAiCompatibleVerifyCall(provider.transport),
    target: { connection: 'openrouter', model } }), (error: unknown) =>
  error instanceof ModelVerifyTargetError && error.code === 'MODEL_VERIFY_CATALOG_STALE');
  assert.equal(provider.requests.length, 0);

  const state = await readModelVerificationState(app.db, openRouterEnv(OPENROUTER_KEY),
    { connection: 'openrouter', model });
  assert.equal(state.state, 'CATALOG_STALE');
});

test('the default target still reports the process default connection', async () => {
  const state = await readModelVerificationState(app.db, { RELAY_MODEL_PROVIDER: 'fake' });
  assert.equal(state.target, 'default');
  assert.equal(state.connection, 'default');
  assert.equal(state.state, 'NOT_CONFIGURED');
  assert.equal(state.current_config_fingerprint, null);
});
