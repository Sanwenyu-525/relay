import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyVerifyError,
  createFakeVerifyCall,
  createOpenAiCompatibleVerifyCall,
  ModelVerifyCallError,
  ModelVerifyConfigError,
  resolveVerifyConfig,
  VERIFY_PROMPT,
  type FakeVerifyScenario,
} from '../../src/workflow/model-port-verify.js';
import type { ModelPortConfig } from '../../src/workflow/model-port-config.js';

const config: ModelPortConfig = {
  provider: 'openai-compatible', model: 'fixture-model', apiKey: 'sk-fixture-secret',
  baseUrl: 'https://models.vendor.com/v1', timeoutMs: 1_000,
  maxOutputTokens: 256, maxCallTokens: 4_096,
  maxScopeCalls: 32, maxScopeTokens: 262_144,
};

test('fake 场景映射到稳定的 error_category', async () => {
  const expected: Record<FakeVerifyScenario, 'AUTH' | 'TIMEOUT' | 'PROTOCOL' | 'NETWORK' | null> = {
    SUCCESS: null, AUTH: 'AUTH', TIMEOUT: 'TIMEOUT', INVALID_MODEL: 'PROTOCOL', NETWORK: 'NETWORK',
  };
  for (const scenario of Object.keys(expected) as FakeVerifyScenario[]) {
    const call = createFakeVerifyCall(scenario);
    try {
      const success = await call.call({ config, prompt: VERIFY_PROMPT, timeoutMs: 100 });
      assert.equal(expected[scenario], null);
      assert.equal(success.providerRequestId.includes(scenario.toLowerCase()), true);
    } catch (error) {
      assert.ok(error instanceof ModelVerifyCallError);
      assert.equal(error.category, expected[scenario]);
    }
  }
});

test('classifyVerifyError 覆盖六类错误', () => {
  assert.equal(classifyVerifyError(new ModelVerifyCallError('AUTH', 'x')), 'AUTH');
  assert.equal(classifyVerifyError(new ModelVerifyCallError('RATE_LIMIT', 'x')), 'RATE_LIMIT');
  assert.equal(classifyVerifyError(new ModelVerifyCallError('TIMEOUT', 'x')), 'TIMEOUT');
  assert.equal(classifyVerifyError(new ModelVerifyCallError('STREAM_BROKEN', 'x')), 'STREAM_BROKEN');
  assert.equal(classifyVerifyError(new ModelVerifyCallError('PROTOCOL', 'x')), 'PROTOCOL');
  assert.equal(classifyVerifyError(new ModelVerifyCallError('NETWORK', 'x')), 'NETWORK');
  const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
  assert.equal(classifyVerifyError(timeout), 'TIMEOUT');
  assert.equal(classifyVerifyError(new Error('MODEL_STREAM_INCOMPLETE')), 'STREAM_BROKEN');
  assert.equal(classifyVerifyError(new Error('MODEL_ENDPOINT_NOT_PUBLIC')), 'NETWORK');
  assert.equal(classifyVerifyError(Object.assign(new Error('http'), { status: 401 })), 'AUTH');
  assert.equal(classifyVerifyError(Object.assign(new Error('http'), { status: 403 })), 'AUTH');
  assert.equal(classifyVerifyError(Object.assign(new Error('http'), { status: 429 })), 'RATE_LIMIT');
  assert.equal(classifyVerifyError(Object.assign(new Error('http'), { status: 404 })), 'PROTOCOL');
  assert.equal(classifyVerifyError(Object.assign(new Error('http'), { status: 500 })), 'NETWORK');
  assert.equal(classifyVerifyError(new TypeError('fetch failed')), 'NETWORK');
});

test('resolveVerifyConfig：fake/空 → 未配置；残缺 → 配置无效', () => {
  assert.throws(() => resolveVerifyConfig({}),
    (error: unknown) => error instanceof ModelVerifyConfigError &&
      error.code === 'MODEL_PORT_NOT_CONFIGURED');
  assert.throws(() => resolveVerifyConfig({ RELAY_MODEL_PROVIDER: 'fake' }),
    (error: unknown) => error instanceof ModelVerifyConfigError &&
      error.code === 'MODEL_PORT_NOT_CONFIGURED');
  assert.throws(() => resolveVerifyConfig({ RELAY_MODEL_PROVIDER: 'openai-compatible' }),
    (error: unknown) => error instanceof ModelVerifyConfigError &&
      error.code === 'MODEL_CONFIG_INVALID');
  const resolved = resolveVerifyConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: 'sk-secret-key-abcdef',
    RELAY_MODEL_NAME: 'gpt-test',
  });
  assert.equal(resolved.model, 'gpt-test');
  assert.equal(JSON.stringify(resolved).includes('sk-secret-key'), true, 'config holds key in memory');
});

test('真实验证外呼是非流式固定短文本，且响应不含密钥', async () => {
  const seen: { url?: string | undefined; body?: unknown; auth?: string | null | undefined } = {};
  const call = createOpenAiCompatibleVerifyCall({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (input, init) => {
      seen.url = String(input);
      seen.auth = new Headers(init?.headers).get('authorization');
      seen.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'chatcmpl-verify', choices: [
        { message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const success = await call.call({ config, prompt: VERIFY_PROMPT, timeoutMs: 1_000 });
  assert.equal(success.providerRequestId, 'chatcmpl-verify');
  assert.deepEqual(success.usage, { inputTokens: 3, outputTokens: 1,
    cacheReadTokens: null, cacheCreationTokens: null });
  assert.equal(String(seen.url).endsWith('/chat/completions'), true);
  assert.equal(seen.auth, `Bearer ${config.apiKey}`);
  assert.deepEqual(seen.body, {
    model: 'fixture-model',
    messages: [{ role: 'user', content: VERIFY_PROMPT }],
    stream: false,
    max_tokens: 16,
  });
});

test('真实验证外呼按 HTTP 状态映射分类，不把密钥写入错误', async () => {
  const call = createOpenAiCompatibleVerifyCall({
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async () => new Response('{"error":"unauthorized"}', {
      status: 401, headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(() => call.call({ config, prompt: VERIFY_PROMPT, timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof ModelVerifyCallError);
      assert.equal(error.category, 'AUTH');
      assert.equal(error.message.includes('sk-fixture-secret'), false);
      return true;
    });
});
