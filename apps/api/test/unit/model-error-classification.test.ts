import assert from 'node:assert/strict';
import test from 'node:test';

import {
  categoryOfProviderStatus,
  classifyProviderError,
  classifyProviderErrorOrProtocol,
  classifyRoutingStop,
  readProviderHttpStatus,
  type ModelErrorCategory,
} from '../../src/workflow/model-error-classification.js';

test('HTTP 状态映射到六类词表', () => {
  assert.equal(categoryOfProviderStatus(401), 'AUTH');
  assert.equal(categoryOfProviderStatus(403), 'AUTH');
  assert.equal(categoryOfProviderStatus(429), 'RATE_LIMIT');
  assert.equal(categoryOfProviderStatus(400), 'PROTOCOL');
  assert.equal(categoryOfProviderStatus(404), 'PROTOCOL');
  assert.equal(categoryOfProviderStatus(422), 'PROTOCOL');
  assert.equal(categoryOfProviderStatus(503), 'NETWORK');
});

test('Provider 失败按状态与传输特征归因', () => {
  const auth = Object.assign(new Error('Incorrect API key provided'), { status: 401 });
  assert.equal(classifyProviderError(auth), 'AUTH');
  assert.equal(classifyProviderError(Object.assign(new Error('slow down'), { status: 429 })),
    'RATE_LIMIT');
  assert.equal(classifyProviderError(Object.assign(new Error('upstream'), { status: 502 })),
    'NETWORK');
  assert.equal(classifyProviderError(new ModelTimeoutError()), 'TIMEOUT');
  assert.equal(classifyProviderError(new Error('MODEL_STREAM_INCOMPLETE')), 'STREAM_BROKEN');
  assert.equal(classifyProviderError(new Error('MODEL_ENDPOINT_NOT_PUBLIC')), 'NETWORK');
  assert.equal(classifyProviderError(new TypeError('fetch failed')), 'NETWORK');
});

test('cause 链里的传输失败不被外层包装吞掉', () => {
  const wrapped = new TypeError('fetch failed',
    { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED' }) });
  assert.equal(classifyProviderError(wrapped), 'NETWORK');
  const statusInCause = new Error('request failed',
    { cause: Object.assign(new Error('rate limited'), { status: 429 }) });
  assert.equal(classifyProviderError(statusInCause), 'RATE_LIMIT');
  const cyclic = new Error('loop', { cause: undefined });
  cyclic.cause = cyclic;
  assert.equal(classifyProviderError(cyclic), undefined);
});

test('Relay 自身失败不冒充 Provider 故障', () => {
  assert.equal(classifyProviderError(new TypeError('local request construction failed')), undefined);
  for (const name of ['ModelCallBudgetError', 'ModelOutputBudgetError', 'ModelToolOutputError',
    'SemanticResponseError', 'AssistPreviewOwnershipLostError']) {
    const error = new Error('relay owned failure');
    error.name = name;
    assert.equal(classifyProviderError(error), undefined, name);
  }
  // 未归因的失败在需要封闭词表时收口为 PROTOCOL，不丢信息也不臆造类别。
  assert.equal(classifyProviderErrorOrProtocol(new Error('unattributable')), 'PROTOCOL');
});

test('category 字段优先于状态，保证连接验证的显式分类不被改写', () => {
  const verifyError = Object.assign(new Error('verify failed with HTTP 401'),
    { category: 'RATE_LIMIT' satisfies ModelErrorCategory, status: 401 });
  assert.equal(classifyProviderError(verifyError), 'RATE_LIMIT');
});

test('readProviderHttpStatus 只接受合法状态码并沿 cause 链查找', () => {
  assert.equal(readProviderHttpStatus({ status: 429 }), 429);
  assert.equal(readProviderHttpStatus({ statusCode: 503 }), 503);
  assert.equal(readProviderHttpStatus({ status: 999 }), undefined);
  assert.equal(readProviderHttpStatus({ status: '429' }), undefined);
  assert.equal(readProviderHttpStatus(new Error('x', { cause: { status: 500 } })), 500);
  assert.equal(readProviderHttpStatus('not an error'), undefined);
});

class ModelTimeoutError extends Error {
  override readonly name = 'ModelTimeoutError';
}

test('路由停因按精确码归因，只有限流与额度类才写 Provider 归类', () => {
  assert.deepEqual(classifyRoutingStop(new Error('ASSIST_MODEL_ACCOUNT_QUOTA_EXHAUSTED')),
    { reason: 'ACCOUNT_QUOTA_EXHAUSTED', providerErrorKind: 'RATE_LIMIT' });
  // 候选耗尽是本地可选集用完，不是上游限流：只保留 reason，不写 Provider 归类。
  assert.deepEqual(classifyRoutingStop(new Error('ASSIST_FREE_MODEL_CANDIDATES_EXHAUSTED')),
    { reason: 'CANDIDATES_EXHAUSTED', providerErrorKind: undefined });
  assert.deepEqual(classifyRoutingStop(new Error('ASSIST_MODEL_CANDIDATE_CAS_LOST')),
    { reason: 'CANDIDATE_STATE_LOST', providerErrorKind: undefined });
  // 未知码不做前缀匹配：内部错误不能被写成 Provider 故障。
  assert.equal(classifyRoutingStop(new Error('ASSIST_FREE_MODEL_ROUTING_BLOCKED')), undefined);
  assert.equal(classifyRoutingStop(new Error('boom')), undefined);
  assert.equal(classifyRoutingStop('ASSIST_MODEL_ACCOUNT_COOLDOWN'), undefined);
});
