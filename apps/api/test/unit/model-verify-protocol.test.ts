import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelPortConfig } from '../../src/workflow/model-port-config.js';
import { createModelVerifyCall, ModelVerifyCallError, VERIFY_PROMPT }
  from '../../src/workflow/model-port-verify.js';

/**
 * 连接验证的两种真实协议（MODEL-SETTINGS-03）。
 *
 * 「验证」是最容易被写成「只支持一种协议」的入口：它不走 ModelPort，而是直接发一次
 * 非流式短探针。这里钉住两种协议的端点、认证头与响应解析，避免 Anthropic 连接被拿去
 * 调 `/chat/completions`（或反之）。
 */

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

function base(protocol: 'openai-compatible' | 'anthropic-messages'): ModelPortConfig {
  return { provider: protocol, protocol, model: 'fixture-model', apiKey: 'fixture-key',
    baseUrl: 'https://models.vendor.com/v1', timeoutMs: 1_000,
    maxOutputTokens: 16, maxCallTokens: 1_024, maxScopeCalls: 1, maxScopeTokens: 4_096 };
}

interface Captured {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function call(protocol: 'openai-compatible' | 'anthropic-messages',
  handler: () => Response): Promise<{ readonly captured: Captured;
    readonly result: Awaited<ReturnType<ReturnType<typeof createModelVerifyCall>['call']>> }> {
  let captured: Captured | undefined;
  const verify = createModelVerifyCall({
    lookup: publicLookup,
    fetch: async (input, init) => {
      captured = { url: String(input), headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return handler();
    },
  });
  return verify.call({ config: base(protocol), prompt: VERIFY_PROMPT, timeoutMs: 1_000 })
    .then((result) => { assert.ok(captured); return { captured, result }; });
}

test('OpenAI 兼容探针：/chat/completions + Bearer，解析 choices/message/content', async () => {
  const { captured, result } = await call('openai-compatible', () => new Response(
    JSON.stringify({ id: 'chatcmpl-verify', choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: {
        cached_tokens: 2 } } }),
    { headers: { 'content-type': 'application/json' } }));
  assert.equal(captured.url, 'https://models.vendor.com/v1/chat/completions');
  assert.equal(captured.headers.get('authorization'), 'Bearer fixture-key');
  assert.equal(captured.headers.get('x-api-key'), null);
  assert.equal(captured.body.stream, false);
  assert.equal(result.providerRequestId, 'chatcmpl-verify');
  assert.equal(result.usage.inputTokens, 5);
  assert.equal(result.usage.outputTokens, 1);
  assert.equal(result.usage.cacheReadTokens, 2);
});

test('Anthropic 探针：/messages + x-api-key + anthropic-version，解析 content 块', async () => {
  const { captured, result } = await call('anthropic-messages', () => new Response(
    JSON.stringify({ id: 'msg_verify', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 6, output_tokens: 2,
        cache_read_input_tokens: 1, cache_creation_input_tokens: 3 } }),
    { headers: { 'content-type': 'application/json' } }));
  assert.equal(captured.url, 'https://models.vendor.com/v1/messages');
  assert.equal(captured.headers.get('x-api-key'), 'fixture-key');
  assert.equal(captured.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(captured.headers.get('authorization'), null);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.max_tokens, 16);
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: VERIFY_PROMPT }]);
  assert.equal(result.providerRequestId, 'msg_verify');
  assert.equal(result.usage.inputTokens, 6);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.cacheReadTokens, 1);
  assert.equal(result.usage.cacheCreationTokens, 3);
});

test('Anthropic 404 记 MODEL_NOT_FOUND；缺少 text 块按协议错误', async () => {
  await assert.rejects(call('anthropic-messages', () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }),
    { status: 404, headers: { 'content-type': 'application/json' } })),
  (error: unknown) => error instanceof ModelVerifyCallError &&
    error.category === 'PROTOCOL' && error.errorKind === 'MODEL_NOT_FOUND');

  await assert.rejects(call('anthropic-messages', () => new Response(
    JSON.stringify({ id: 'msg_empty', content: [{ type: 'thinking' }] }),
    { headers: { 'content-type': 'application/json' } })),
  (error: unknown) => error instanceof ModelVerifyCallError && error.category === 'PROTOCOL');
});
