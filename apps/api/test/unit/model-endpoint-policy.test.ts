import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError } from '../../src/config/config.js';
import { guardedModelFetch, isPublicAddress, parseModelBaseUrl,
} from '../../src/workflow/model-endpoint-policy.js';

test('model endpoint parser rejects local and ambiguous configured targets', () => {
  for (const value of ['http://models.vendor.com/v1', 'https://localhost/v1',
    'https://[::1]/v1', 'https://10.0.0.1/v1',
    'https://user@models.vendor.com/v1', 'https://models.vendor.com/v1?q=x',
    'https://models.vendor.com/v1#x', 'https://models.vendor.com./v1',
    'https://metadata.internal/v1']) {
    assert.throws(() => parseModelBaseUrl(value), ConfigError, value);
  }
  assert.equal(parseModelBaseUrl('https://models.vendor.com/v1/'),
    'https://models.vendor.com/v1');
});

test('public address screening rejects private and special ranges', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.20.0.1',
    '192.168.0.1', '169.254.169.254', '100.64.1.1', '198.18.1.1',
    '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('SDK fetch stays under exact origin/path, rechecks DNS and rejects redirect', async () => {
  const requests: string[] = [];
  const guarded = guardedModelFetch('https://models.vendor.com/v1', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (input, init) => {
      requests.push(String(input));
      assert.equal(init?.redirect, 'error');
      return new Response('{}');
    },
  });
  await guarded('https://models.vendor.com/v1/chat/completions');
  assert.equal(requests.length, 1);
  await assert.rejects(() => guarded('https://metadata.internal/v1/chat/completions'),
    /MODEL_ENDPOINT_NOT_ALLOWED/u);
  await assert.rejects(() => guarded('https://models.vendor.com/other'),
    /MODEL_ENDPOINT_NOT_ALLOWED/u);
  assert.equal(requests.length, 1);
  const privateDns = guardedModelFetch('https://models.vendor.com/v1', {
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    fetch: async () => { throw new Error('must not send'); },
  });
  await assert.rejects(() => privateDns('https://models.vendor.com/v1/chat/completions'),
    /MODEL_ENDPOINT_NOT_PUBLIC/u);
  const redirected = guardedModelFetch('https://models.vendor.com/v1', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async () => Response.redirect('https://metadata.internal/', 302),
  });
  await assert.rejects(() => redirected('https://models.vendor.com/v1/chat/completions'),
    /MODEL_ENDPOINT_REDIRECTED/u);
});
