import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { AssistRepository } from '../../src/assist/assist-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { ModelErrorCategory } from '../../src/workflow/model-error-classification.js';
import type { ModelPortConfig } from '../../src/workflow/model-port-config.js';
import { ModelToolOutputError, OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { createWorkspace, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

// Real ChatOpenAI/Adapter, Assist owners, PG ledger and a separate HTTP API.
// Only the constructor's existing fetch/lookup seam is injected. The bridge
// sends synthetic input to an owned loopback HTTP socket and returns a Response
// without its physical URL, keeping the public HTTPS logical URL checks intact.
// This is not real Provider, TLS/DNS binding, endpoint-policy or Windows acceptance.
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-model-provider-faults');
const dummyKey = 'controlled-provider-dummy-key';
const prompt = 'Reply to this fixed synthetic message only.';
const privatePayload = 'controlled-provider-private-error';
const sockets = new Set<Socket>();
let api: TestApi | undefined;
let storage: ManagedContentStore;
let localOrigin: string;
let totalRequests = 0;
let active: { category: ModelErrorCategory | 'NATIVE_TOOL_CALL' | 'NATIVE_TOOL_AFTER_TEXT'; requests: number; body: string;
  loopback: boolean; closedBeforeHeaders: boolean } | null = null;

const server = createServer((request, response) => {
  totalRequests += 1;
  const evidence = active;
  if (evidence === null) { response.writeHead(503).end(); return; }
  evidence.requests += 1;
  evidence.loopback = request.socket.localAddress === '127.0.0.1' &&
    request.socket.remoteAddress === '127.0.0.1' && request.method === 'POST' &&
    request.url === '/v1/chat/completions' && request.headers.authorization === undefined;
  request.on('data', (chunk: Buffer) => { evidence.body += chunk.toString('utf8'); });
  request.once('end', () => {
    switch (evidence.category) {
      case 'NATIVE_TOOL_CALL':
      case 'NATIVE_TOOL_AFTER_TEXT': {
        const chunk = (delta: object, finishReason: string | null = null): string =>
          `data: ${JSON.stringify({ id: 'chatcmpl-controlled-tool',
            object: 'chat.completion.chunk', created: 1, model: 'controlled-model',
            choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(chunk({ role: 'assistant', content: evidence.category === 'NATIVE_TOOL_AFTER_TEXT'
          ? '# Partial synthetic reply before refusal' : '' }) +
          chunk({ tool_calls: [{ index: 0, id: 'controlled-tool-call', type: 'function',
            function: { name: 'write_file', arguments: '{"path":' } }] }) +
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"synthetic.txt"}' } }] }) +
          chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
        return;
      }
      case 'TIMEOUT': return; // The real Adapter deadline must abort this HTTP request.
      case 'NETWORK':
        evidence.closedBeforeHeaders = !response.headersSent;
        request.socket.destroy();
        return;
      case 'STREAM_BROKEN':
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'chatcmpl-controlled-partial',
          object: 'chat.completion.chunk', created: 1, model: 'controlled-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '# Unfinished synthetic reply' },
            finish_reason: null }] })}\n\n`); // Legal fragment, clean EOF, no [DONE].
        return;
      default: {
        const status = evidence.category === 'AUTH' ? 401
          : evidence.category === 'RATE_LIMIT' ? 429 : 422;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: privatePayload, type: 'controlled_error' } }));
      }
    }
  });
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => { sockets.delete(socket); });
});

async function closeSockets(): Promise<void> {
  await Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => {
    socket.once('close', resolve);
    socket.destroy();
  })));
  assert.equal(sockets.size, 0, 'owned HTTP sockets remain');
}

for (const scenario of [
  { name: 'known request and usage', requestId: 'chatcmpl-controlled-known',
    usage: { inputTokens: 43, outputTokens: 8 } },
  { name: 'unknown request and usage', requestId: undefined,
    usage: { inputTokens: null, outputTokens: null } },
]) {
  test(`controlled tool refusal envelope persists ${scenario.name}`, async () => {
    assert.ok(api);
    const workspaceId = await createWorkspace(app.db);
    const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
      title: 'Controlled refusal metadata' });
    const requested = await requestAssistMessage(app.db, { workspaceId,
      sessionId: session.result.session_id, commandId: randomUUID(), content: prompt });
    const messageId = requested.result.assistant_message_id;
    const calls = new ModelCallRepository(app.db);
    let originalCallId: string | undefined;
    const identity = new OpenAiCompatibleModelPort({ provider: 'openai-compatible',
      model: 'controlled-metadata', apiKey: dummyKey, baseUrl: 'https://models.vendor.com/v1',
      timeoutMs: 500, maxOutputTokens: 256, maxCallTokens: 4096,
      maxScopeCalls: 32, maxScopeTokens: 262144 }).identity;
    // Explicit error-envelope seam, not a real Provider or unread SSE usage.
    const outcome = await runAssistGenerationTick(app.db, { workerId: `metadata-${randomUUID()}`,
      storage, leaseMs: 30_000, modelPort: { identity,
        assist: async () => {
          const started = await calls.listForAssistMessage(messageId);
          assert.equal(started.length, 1);
          assert.equal(started[0]!.status, 'STARTED');
          originalCallId = started[0]!.id;
          throw new ModelToolOutputError(scenario.requestId, scenario.usage);
        },
      } });
    assert.equal(outcome?.messageId, messageId);
    assert.equal(outcome?.status, 'FAILED');
    assert.equal(outcome?.errorCode, 'MODEL_FAILED');
    assert.deepEqual(outcome?.proposalIds, []);
    const settled = await calls.listForAssistMessage(messageId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.id, originalCallId);
    assert.equal(settled[0]!.status, 'FAILED');
    assert.equal(settled[0]!.error_kind, 'ModelToolOutputError');
    assert.equal(settled[0]!.provider_request_id, scenario.requestId ?? null);
    assert.equal(settled[0]!.usage_input_tokens, scenario.usage.inputTokens);
    assert.equal(settled[0]!.usage_output_tokens, scenario.usage.outputTokens);
    const message = await new AssistRepository(app.db).readMessage(messageId);
    assert.ok(message);
    assert.equal(message.provider_error_kind, null);
    assert.equal(message.content, null);
    assert.equal(message.provider_request_id, settled[0]!.provider_request_id);
    assert.equal(message.usage_input_tokens, settled[0]!.usage_input_tokens);
    assert.equal(message.usage_output_tokens, settled[0]!.usage_output_tokens);
    const facts = await sql<{ proposals: number; previews: number; actions: number }>`select
      (select count(*)::integer from assist_proposals where message_id=${messageId}) as proposals,
      (select count(*)::integer from assist_message_previews where message_id=${messageId}) as previews,
      (select count(*)::integer from logical_operations where workspace_id=${workspaceId}) as actions`
      .execute(app.db);
    assert.deepEqual(facts.rows[0], { proposals: 0, previews: 0, actions: 0 });
    const response = await api.get(workspacePath(workspaceId,
      `/assist-sessions/${session.result.session_id}/messages`));
    assert.equal(response.status, 200);
    const projected = (response.body as { items: { id: string; provider_request_id: string | null;
      provider_error_kind: string | null; content: string | null;
      usage: { input_tokens: number | null; output_tokens: number | null } }[] }).items
      .find((item) => item.id === messageId);
    assert.ok(projected);
    assert.equal(projected.provider_request_id, scenario.requestId ?? null);
    assert.deepEqual(projected.usage, { input_tokens: scenario.usage.inputTokens,
      output_tokens: scenario.usage.outputTokens });
    assert.equal(projected.provider_error_kind, null);
    assert.equal(projected.content, null);
  });
}

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  storage = new ManagedContentStore(api.dataRoot);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  localOrigin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const results = await Promise.allSettled([
    (async () => {
      await closeSockets();
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      assert.equal(server.listening, false);
      assert.equal(server.address(), null);
    })(),
    api?.stop(),
    app.close(),
  ]);
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'controlled Provider cleanup failed');
  if (api) {
    const stopped = results[1]!;
    assert.ok(stopped.status === 'fulfilled');
    assert.equal(stopped.value, 0, 'separate API did not stop cleanly');
  }
  assert.equal(totalRequests, 8, 'unexpected HTTP requests outside the six faults and two tool refusals');
  console.log('controlled_provider_cleanup listener_closed=true sockets=0 api_exit=0');
});

for (const category of ['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'STREAM_BROKEN', 'PROTOCOL', 'NETWORK', 'NATIVE_TOOL_CALL', 'NATIVE_TOOL_AFTER_TEXT'] as const) {
  test(`real Adapter loopback ${category} preserves one Assist call and projects a safe failure`,
    { timeout: 30_000 }, async () => {
      assert.ok(api);
      const workspaceId = await createWorkspace(app.db);
      const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
        title: 'Controlled Provider fault' });
      const requested = await requestAssistMessage(app.db, { workspaceId,
        sessionId: session.result.session_id, commandId: randomUUID(), content: prompt });
      const messageId = requested.result.assistant_message_id;
      const calls = new ModelCallRepository(app.db);
      active = { category, requests: 0, body: '', loopback: false, closedBeforeHeaders: false };
      const evidence = active;
      const toolRefusal = category === 'NATIVE_TOOL_CALL' || category === 'NATIVE_TOOL_AFTER_TEXT';
      let bridgeRequests = 0;
      let originalCallId: string | undefined;
      const dispatch: { signal: AbortSignal | null } = { signal: null };
      const config: ModelPortConfig = { provider: 'openai-compatible', model: 'controlled-model',
        apiKey: dummyKey, baseUrl: 'https://models.vendor.com/v1', timeoutMs: 500,
        maxOutputTokens: 256, maxCallTokens: 4096, maxScopeCalls: 32, maxScopeTokens: 262144 };
      const modelPort = new OpenAiCompatibleModelPort(config, {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        fetch: async (input, init) => {
          bridgeRequests += 1;
          const logicalUrl = new URL(input instanceof Request ? input.url : String(input));
          assert.equal(logicalUrl.href, 'https://models.vendor.com/v1/chat/completions');
          assert.equal(init?.redirect, 'error');
          assert.equal(typeof init?.body, 'string', 'SDK did not send its synthetic JSON body');
          const headers = new Headers(init?.headers);
          assert.ok(headers.get('authorization') === `Bearer ${dummyKey}`, 'SDK dummy auth missing');
          headers.delete('authorization'); // No credential reaches or is captured by the local server.
          const started = await calls.listForAssistMessage(messageId);
          assert.equal(started.length, 1);
          assert.equal(started[0]!.status, 'STARTED', 'ledger must commit before socket dispatch');
          originalCallId = started[0]!.id;
          dispatch.signal = init?.signal ?? null;
          const physical = await fetch(`${localOrigin}${logicalUrl.pathname}`, { ...init, headers });
          assert.equal(new URL(physical.url).origin, localOrigin, 'request escaped the owned socket');
          // Response.url is otherwise loopback and would correctly fail the
          // production guard's logical-origin check. Only this test bridge clears it.
          return new Response(physical.body, { status: physical.status,
            statusText: physical.statusText, headers: physical.headers });
        },
      });
      try {
        const outcome = await runAssistGenerationTick(app.db, { workerId: `controlled-${category}`,
          storage, modelPort, leaseMs: 30_000 });
        assert.ok(outcome);
        assert.equal(outcome.messageId, messageId);
        assert.equal(outcome.status, 'FAILED');
        assert.equal(outcome.errorCode, 'MODEL_FAILED');
        assert.deepEqual(outcome.proposalIds, []);
        assert.equal(bridgeRequests, 1, 'Adapter automatically retried');
        assert.equal(evidence.requests, 1, 'HTTP request was duplicated or never dispatched');
        assert.equal(evidence.loopback, true);
        assert.ok(evidence.body.includes(prompt));
        assert.ok(!evidence.body.includes(dummyKey));
        if (category === 'TIMEOUT') {
          assert.ok(dispatch.signal !== null && dispatch.signal.aborted, 'real deadline did not abort');
        }
        if (category === 'NETWORK') assert.equal(evidence.closedBeforeHeaders, true);
        const settled = await calls.listForAssistMessage(messageId);
        assert.equal(settled.length, 1);
        assert.equal(settled[0]!.id, originalCallId);
        assert.equal(settled[0]!.status, 'FAILED');
        assert.equal(settled[0]!.error_kind, toolRefusal
          ? 'ModelToolOutputError' : category);
        assert.equal(settled[0]!.provider, 'openai-compatible');
        const message = await new AssistRepository(app.db).readMessage(messageId);
        assert.ok(message);
        assert.equal(message.status, 'FAILED');
        assert.equal(message.provider_error_kind, toolRefusal ? null : category);
        assert.equal(message.error_code, 'MODEL_FAILED');
        assert.equal(message.content, null);
        assert.equal(message.cancel_requested, false);
        const facts = await sql<{ proposals: number; previews: number }>`select
          (select count(*)::integer from assist_proposals where message_id=${messageId}) as proposals,
          (select count(*)::integer from assist_message_previews where message_id=${messageId}) as previews`
          .execute(app.db);
        assert.deepEqual(facts.rows[0], { proposals: 0, previews: 0 });
        if (toolRefusal) {
          const actions = await sql<{ count: number }>`select count(*)::integer as count
            from logical_operations where workspace_id=${workspaceId}`.execute(app.db);
          assert.equal(actions.rows[0]!.count, 0, 'native model tool arguments created a Gateway action');
          if (category === 'NATIVE_TOOL_AFTER_TEXT') {
            assert.ok(settled[0]!.first_text_delta_at instanceof Date);
            assert.ok(settled[0]!.first_preview_persisted_at instanceof Date);
            assert.ok(settled[0]!.first_preview_persisted_at >= settled[0]!.first_text_delta_at);
          } else {
            assert.equal(settled[0]!.first_text_delta_at, null);
            assert.equal(settled[0]!.first_preview_persisted_at, null);
          }
          assert.equal(settled[0]!.provider_request_id, 'chatcmpl-controlled-tool');
          assert.equal(message.provider_request_id, settled[0]!.provider_request_id);
          assert.equal(settled[0]!.usage_input_tokens, null);
          assert.equal(settled[0]!.usage_output_tokens, null);
        }
        const response = await api.get(workspacePath(workspaceId,
          `/assist-sessions/${session.result.session_id}/messages`));
        assert.equal(response.status, 200);
        const items = (response.body as { items: { id: string; status: string; content: string | null;
          provider_error_kind: string | null; error_code: string | null;
          provider_request_id: string | null; usage: { input_tokens: number | null; output_tokens: number | null } }[] }).items;
        const projected = items.find((item) => item.id === messageId);
        assert.ok(projected);
        assert.equal(projected.status, 'FAILED');
        assert.equal(projected.provider_error_kind, toolRefusal ? null : category);
        assert.equal(projected.error_code, 'MODEL_FAILED');
        assert.equal(projected.content, null);
        if (toolRefusal) {
          assert.equal(projected.provider_request_id, settled[0]!.provider_request_id);
          assert.deepEqual(projected.usage, { input_tokens: null, output_tokens: null });
        }
        const serialized = JSON.stringify({ message, settled, body: response.body },
          (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
        assert.ok(!serialized.includes(dummyKey) && !serialized.includes(privatePayload),
          'raw credentials or Provider error body entered persistent/API evidence');
        if (toolRefusal) assert.ok(!serialized.includes('write_file') && !serialized.includes('synthetic.txt'),
          'native tool arguments entered persistent/API evidence');
      } finally {
        await closeSockets();
        active = null;
      }
      console.log(`controlled_provider_fault category=${category} http_requests=1 bridge_requests=1 original_call_preserved=true pg=FAILED api=FAILED sockets=0 synthetic_input=true`);
    });
}
