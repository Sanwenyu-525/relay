import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { invokeAssistWithFreeModelRouting } from '../../src/application/assist-free-model-routing.js';
import { requestAssistMessage } from '../../src/application/assist-commands.js';
import { selectSessionModel } from '../../src/application/select-session-model.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { FakeModelPort, type AssistRequest } from '../../src/workflow/fake-model-port.js';
import type { AssistFreeModelRoutingContext } from '../../src/application/assist-free-model-routing.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-free-model-routing-test');
const env = { RELAY_OPENROUTER_API_KEY: 'controlled-test-key' } as NodeJS.ProcessEnv;
const requests: { readonly path: string; readonly model?: string | undefined;
  readonly providerGuard?: unknown }[] = [];
let responseMode: 'fallback' | 'ordinary-429' = 'fallback';
let localOrigin = '';
let preferredModel = '';
let fallbackModel = '';
let server: Server;

server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.once('end', () => {
    const path = request.url ?? '';
    if (path === '/api/v1/key') {
      requests.push({ path });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { free_model_daily_requests: { remaining: 49 } } }));
      return;
    }
    if (path !== '/api/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model?: string; provider?: unknown };
    requests.push({ path, model: body.model, providerGuard: body.provider });
    if (body.model === preferredModel) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
      const error = responseMode === 'fallback'
        ? { message: 'upstream provider is rate limited', metadata: {
          provider_code: 429, error_type: 'rate_limit_exceeded' } }
        : { message: 'rate limit', type: 'rate_limit_exceeded' };
      response.end(JSON.stringify({ error }));
      return;
    }
    assert.equal(body.model, fallbackModel);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      `data: ${JSON.stringify({ id: 'chatcmpl-controlled-b', object: 'chat.completion.chunk',
        created: 1, model: fallbackModel, choices: [{ index: 0, delta: { role: 'assistant' },
          finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-controlled-b', object: 'chat.completion.chunk',
        created: 1, model: fallbackModel, choices: [{ index: 0,
          delta: { content: 'controlled answer' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-controlled-b', object: 'chat.completion.chunk',
        created: 1, model: fallbackModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 17, completion_tokens: 3 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''));
  });
});

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  localOrigin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await app.close();
});

test('真实PG与OpenAI兼容HTTP：结构化上游429且账户额度仍有余量时，同一消息从A切B', async () => {
  responseMode = 'fallback';
  requests.length = 0;
  preferredModel = `free-a-${randomUUID()}`;
  fallbackModel = `free-b-${randomUUID()}`;
  for (const model of [preferredModel, fallbackModel]) {
    await sql`insert into model_catalog_entries
      (source_model_id, display_name, context_window, pricing, capabilities, is_free,
       not_free_reason, fetched_at)
      values (${model}, ${model}, 131072, '{"prompt":"0","completion":"0"}'::jsonb,
        '{"tools":true,"response_format":true,"text_input":true,"text_output":true}'::jsonb,
        true, null, now())`.execute(app.db);
  }
  await sql`update model_catalog_sync_state set snapshot_seq = snapshot_seq + 1,
    last_success_at = now(), consecutive_failures = 0, last_failure_at = null,
    last_failure_reason = null where singleton = true`.execute(app.db);

  const workspaceId = await createWorkspace(app.db);
  const sessionId = randomUUID();
  await createRepositories(app.db).assist.insertSession({ id: sessionId, workspaceId,
    projectId: null, taskId: null, title: '受控免费模型接续' });
  const selection = await selectSessionModel(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: preferredModel, env });
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '合成验收文本',
    expectedModelSelectionRevision: selection.result.revision }, env);
  const workerId = `controlled-${randomUUID()}`;
  const message = await createRepositories(app.db).assist.claimNextPendingMessage(workerId);
  assert.equal(message?.id, sent.result.assistant_message_id);
  const session = await createRepositories(app.db).assist.readSession(sessionId);
  assert.ok(message && session);
  const dependencies: ModelFetchDependencies = {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(target.origin, 'https://openrouter.ai');
      const local = await fetch(`${localOrigin}${target.pathname}`, init);
      return new Response(local.body, { status: local.status, statusText: local.statusText,
        headers: local.headers });
    },
  };
  const context: AssistFreeModelRoutingContext = { db: app.db, message, session, workerId, env,
    defaultModelPort: new FakeModelPort(), modelFetchDependencies: dependencies };
  const request: AssistRequest = { intent: 'DISCUSS', system: '受控系统提示',
    turns: [{ role: 'user', content: '合成验收文本' }] };

  const result = await invokeAssistWithFreeModelRouting(context, request);
  assert.equal(result.kind, 'CONTENT');
  if (result.kind !== 'CONTENT') return;
  assert.equal(result.content, 'controlled answer');
  assert.deepEqual(requests.map((entry) => entry.path.endsWith('/key') ? 'key' : entry.model),
    [preferredModel, 'key', fallbackModel]);
  for (const entry of requests.filter((item) => item.model !== undefined)) {
    assert.deepEqual(entry.providerGuard, { max_price: {
      prompt: 0, completion: 0, request: 0, image: 0,
    }, allow_fallbacks: false, require_parameters: true });
  }
  const calls = await new ModelCallRepository(app.db).listForAssistMessage(message.id);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.model, call.status]), [
    [preferredModel, 'FAILED'], [fallbackModel, 'COMPLETED'],
  ]);
  assert.notEqual(calls[0]!.id, calls[1]!.id);
  assert.equal(calls[0]!.usage_input_tokens, null);
  assert.equal(calls[1]!.usage_input_tokens, 17);
  assert.equal(calls[1]!.usage_output_tokens, 3);
  const latest = await createRepositories(app.db).assist.readMessage(message.id);
  const state = latest?.model_attempt_state;
  assert.ok(state);
  assert.equal(state.current_candidate_index, 1);
  assert.equal(state.switch_count, 1);
  assert.equal(state.active_call_id, null);
  assert.equal(state.completed_call_id, calls[1]!.id);
  const lastFailure = state.last_failure as Record<string, unknown>;
  assert.equal(lastFailure.reason, 'UPSTREAM_PROVIDER_RATE_LIMIT');
  assert.equal(lastFailure.scope, 'UPSTREAM_PROVIDER');
  assert.equal(lastFailure.free_daily_remaining, 49);
  const cooldowns = await sql<{ scope: string; model_id: string }>`select scope, model_id
    from model_provider_cooldowns where model_call_id = ${calls[0]!.id}`.execute(app.db);
  assert.deepEqual(cooldowns.rows, [{ scope: 'MODEL', model_id: preferredModel }]);
});
