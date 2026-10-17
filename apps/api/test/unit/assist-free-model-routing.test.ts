import assert from 'node:assert/strict';
import test from 'node:test';

import { hasStructuredUpstreamRateLimit } from '../../src/application/assist-free-model-routing.js';

test('上游429使用OpenRouter结构化字段，数值provider_code合法且provider_name可缺省', () => {
  assert.equal(hasStructuredUpstreamRateLimit({ status: 429, error: {
    metadata: { provider_code: 429, error_type: 'rate_limit_exceeded' },
  } }), true);
  assert.equal(hasStructuredUpstreamRateLimit({ status: 429, error: {
    metadata: { provider_code: '429', error_type: 'rate_limit_exceeded' },
  } }), true);
});

test('普通429或缺少结构化上游码不得触发自动接续', () => {
  assert.equal(hasStructuredUpstreamRateLimit({ status: 429 }), false);
  assert.equal(hasStructuredUpstreamRateLimit({ status: 429, error: {
    metadata: { provider_code: 500, error_type: 'rate_limit_exceeded' },
  } }), false);
  assert.equal(hasStructuredUpstreamRateLimit({ status: 429, error: {
    metadata: { provider_code: 429, error_type: 'provider_error' },
  } }), false);
});

test('cause链任一层出现平台X-RateLimit头都否决上游429归因', () => {
  const error = { status: 429, error: {
    metadata: { provider_code: 429, error_type: 'rate_limit_exceeded' },
  }, cause: { headers: new Headers({ 'x-ratelimit-remaining': '0' }) } };
  assert.equal(hasStructuredUpstreamRateLimit(error), false);
});
