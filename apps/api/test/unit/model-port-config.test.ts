import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError } from '../../src/config/config.js';
import { OPENROUTER_CHAT_BASE_URL, readModelPortConfig,
  readOpenRouterModelPortConfig, validateModelPortConfig }
  from '../../src/workflow/model-port-config.js';

test('no provider env keeps the Fake ModelPort path', () => {
  assert.equal(readModelPortConfig({}), undefined);
  assert.equal(readModelPortConfig({ RELAY_MODEL_PROVIDER: '' }), undefined);
  assert.equal(readModelPortConfig({ RELAY_MODEL_PROVIDER: 'fake' }), undefined);
});

test('a partial openai-compatible configuration fails validation explicitly', () => {
  for (const env of [
    { RELAY_MODEL_PROVIDER: 'openai-compatible' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_NAME: 'm' },
    { RELAY_MODEL_PROVIDER: 'unknown-provider', RELAY_MODEL_API_KEY: 'k', RELAY_MODEL_NAME: 'm' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k',
      RELAY_MODEL_NAME: 'm', RELAY_MODEL_TIMEOUT_MS: '10' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k',
      RELAY_MODEL_NAME: 'm', RELAY_MODEL_BASE_URL: 'http://insecure.example/v1' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k',
      RELAY_MODEL_NAME: 'm', RELAY_MODEL_BASE_URL: 'https://user:pass@model.vendor.com/v1' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k',
      RELAY_MODEL_NAME: 'm', RELAY_MODEL_BASE_URL: 'https://127.0.0.1/v1' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k',
      RELAY_MODEL_NAME: 'm', RELAY_MODEL_BASE_URL: 'https://model.vendor.com/v1#fragment' },
    { RELAY_MODEL_PROVIDER: 'openai-compatible', RELAY_MODEL_API_KEY: 'k',
      RELAY_MODEL_NAME: 'm', RELAY_MODEL_MAX_CALL_TOKENS: '1024',
      RELAY_MODEL_MAX_OUTPUT_TOKENS: '2048' },
  ]) {
    assert.throws(() => readModelPortConfig(env), ConfigError);
    assert.throws(() => validateModelPortConfig(env), ConfigError);
  }
});

test('a complete openai-compatible configuration parses every field', () => {
  const config = readModelPortConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: '  secret  ',
    RELAY_MODEL_NAME: ' agnes-3.0-flash ',
    RELAY_MODEL_BASE_URL: 'https://model.vendor.com/v1',
    RELAY_MODEL_TIMEOUT_MS: '45000',
    RELAY_MODEL_MAX_OUTPUT_TOKENS: '2048',
    RELAY_MODEL_MAX_CALL_TOKENS: '8192',
    RELAY_MODEL_MAX_SCOPE_CALLS: '12',
    RELAY_MODEL_MAX_SCOPE_TOKENS: '131072',
  });
  assert.deepEqual(config, { provider: 'openai-compatible', model: 'agnes-3.0-flash',
    apiKey: 'secret', baseUrl: 'https://model.vendor.com/v1', timeoutMs: 45000,
    maxOutputTokens: 2048, maxCallTokens: 8192,
    maxScopeCalls: 12, maxScopeTokens: 131072 });
});

test('defaults apply when optional fields are absent', () => {
  const config = readModelPortConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: 'secret',
    RELAY_MODEL_NAME: 'model',
  });
  assert.ok(config);
  assert.equal(config.baseUrl, undefined);
  assert.equal(config.timeoutMs, 120_000);
  assert.equal(config.maxOutputTokens, 4_096);
  assert.equal(config.maxCallTokens, 65_536);
  assert.equal(config.maxScopeCalls, 32);
  assert.equal(config.maxScopeTokens, 262_144);
});

test('OpenRouter chat credential is independent from default and catalog credentials', () => {
  const env = { RELAY_MODEL_API_KEY: 'other-provider-key',
    RELAY_MODEL_CATALOG_API_KEY: 'catalog-key', RELAY_MODEL_NAME: 'default-model',
    RELAY_OPENROUTER_API_KEY: ' openrouter-chat-key ' };
  const config = readOpenRouterModelPortConfig(env, 'vendor/model:free');
  assert.equal(config.provider, 'openrouter');
  assert.equal(config.model, 'vendor/model:free');
  assert.equal(config.apiKey, 'openrouter-chat-key');
  assert.equal(config.baseUrl, OPENROUTER_CHAT_BASE_URL);
  assert.equal(config.maxScopeCalls, 32);
  assert.throws(() => readOpenRouterModelPortConfig({
    RELAY_MODEL_API_KEY: 'must-not-be-reused',
    RELAY_MODEL_CATALOG_API_KEY: 'also-not-chat',
  }, 'vendor/model:free'), ConfigError);
});

test('OpenRouter chat credential falls back to the standard OPENROUTER_API_KEY', () => {
  const fallback = readOpenRouterModelPortConfig(
    { OPENROUTER_API_KEY: ' std-key ' }, 'vendor/model:free');
  assert.equal(fallback.apiKey, 'std-key');
  const blankRelayFallsBack = readOpenRouterModelPortConfig(
    { RELAY_OPENROUTER_API_KEY: '   ', OPENROUTER_API_KEY: 'std-key' }, 'vendor/model:free');
  assert.equal(blankRelayFallsBack.apiKey, 'std-key');
  const explicitOverrideWins = readOpenRouterModelPortConfig(
    { RELAY_OPENROUTER_API_KEY: 'relay-key', OPENROUTER_API_KEY: 'std-key' }, 'vendor/model:free');
  assert.equal(explicitOverrideWins.apiKey, 'relay-key');
  assert.throws(() => readOpenRouterModelPortConfig({}, 'vendor/model:free'), ConfigError);
  assert.throws(() => readOpenRouterModelPortConfig(
    { OPENROUTER_API_KEY: '   ' }, 'vendor/model:free'), ConfigError);
});

// 2026-11-03：SPARK_API_KEY 回退只在 RELAY_MODEL_API_KEY 缺省/空白时生效，
// 且该路径自带星火 MaaS 的默认端点与默认模型名；显式 RELAY_MODEL_* 仍然优先。
test('SPARK_API_KEY fills the model credential only when RELAY_MODEL_API_KEY is absent', () => {
  const fallback = readModelPortConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible', SPARK_API_KEY: ' spark-key ',
  });
  assert.ok(fallback);
  assert.equal(fallback.apiKey, 'spark-key');
  assert.equal(fallback.model, 'spark-x2.6');
  assert.equal(fallback.baseUrl, 'https://maas-api.cn-huabei-1.xf-yun.com/v2');

  const explicitWins = readModelPortConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible', SPARK_API_KEY: 'spark-key',
    RELAY_MODEL_API_KEY: ' relay-key ', RELAY_MODEL_NAME: 'vendor-model',
    RELAY_MODEL_BASE_URL: 'https://model.vendor.com/v1',
  });
  assert.ok(explicitWins);
  assert.equal(explicitWins.apiKey, 'relay-key');
  assert.equal(explicitWins.model, 'vendor-model');
  assert.equal(explicitWins.baseUrl, 'https://model.vendor.com/v1');

  const explicitModelKeepsSparkEndpoint = readModelPortConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible', SPARK_API_KEY: 'spark-key',
    RELAY_MODEL_NAME: 'spark-x2.6-lite',
  });
  assert.ok(explicitModelKeepsSparkEndpoint);
  assert.equal(explicitModelKeepsSparkEndpoint.model, 'spark-x2.6-lite');
  assert.equal(explicitModelKeepsSparkEndpoint.baseUrl,
    'https://maas-api.cn-huabei-1.xf-yun.com/v2');

  // 空白 SPARK_API_KEY 不构成回退，缺少 RELAY_MODEL_API_KEY 仍然按残缺配置失败。
  assert.throws(() => readModelPortConfig({
    RELAY_MODEL_PROVIDER: 'openai-compatible', SPARK_API_KEY: '   ',
  }), ConfigError);
  // provider 缺省 / fake 时回退也不改变 Fake 路径。
  assert.equal(readModelPortConfig({ SPARK_API_KEY: 'spark-key' }), undefined);
});
