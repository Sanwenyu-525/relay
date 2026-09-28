import assert from 'node:assert/strict';
import test from 'node:test';
import { describeModelPortStatus } from '../../src/workflow/model-port-config.js';

test('未设置或 fake 时报告 Mock 端口，不暴露任何配置内容', () => {
  assert.deepEqual(describeModelPortStatus({}), { provider: 'fake', configured: false, model: null, baseUrl: null });
  assert.deepEqual(describeModelPortStatus({ RELAY_MODEL_PROVIDER: 'fake' }),
    { provider: 'fake', configured: false, model: null, baseUrl: null });
});

test('完整真实配置报告 provider/model/base_url，密钥不出现在任何字段', () => {
  const status = describeModelPortStatus({
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: 'sk-secret-key-abcdef',
    RELAY_MODEL_NAME: 'gpt-test',
    RELAY_MODEL_BASE_URL: 'https://api.example.com/v1',
  });
  assert.equal(status.provider, 'openai-compatible');
  assert.equal(status.configured, true);
  assert.equal(status.model, 'gpt-test');
  assert.equal(status.baseUrl, 'https://api.example.com/v1');
  assert.equal(JSON.stringify(status).includes('sk-secret'), false);
});

test('未自定义 base_url 时为 null（使用内置默认端点）', () => {
  const status = describeModelPortStatus({
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: 'sk-secret-key-abcdef',
    RELAY_MODEL_NAME: 'gpt-test',
  });
  assert.equal(status.baseUrl, null);
});

test('残缺的真实 Provider 配置报告 invalid，而不是伪装成 Mock', () => {
  const status = describeModelPortStatus({ RELAY_MODEL_PROVIDER: 'openai-compatible' });
  assert.equal(status.provider, 'invalid');
  assert.equal(status.configured, false);
  assert.equal(status.model, null);
});
