import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFreePriceGuard, mergeProviderGuard, withProviderGuard }
  from '../../src/workflow/free-call-guard.js';
import type { FrozenModelConstraint } from '../../src/workflow/frozen-model-constraint.js';

const FP = 'b'.repeat(64);

function constraint(overrides: Partial<FrozenModelConstraint> = {}): FrozenModelConstraint {
  return {
    connection: { provider: 'openai-compatible', model: 'free/model-x', configFingerprint: FP },
    freeOnly: true,
    catalogBasis: { source: 'openrouter', snapshotSeq: '1', sourceModelId: 'free/model-x' },
    ...overrides,
  };
}

test('未携带冻结约束时不生成硬限制（原默认行为不变）', () => {
  assert.equal(buildFreePriceGuard(undefined), undefined);
});

test('非“仅免费”约束不生成硬限制', () => {
  assert.equal(buildFreePriceGuard(constraint({ freeOnly: false })), undefined);
});

test('仅免费约束生成覆盖 prompt/completion/request/image 的绝对零价硬限制', () => {
  const guard = buildFreePriceGuard(constraint());
  assert.ok(guard);
  assert.deepEqual(guard.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.equal(guard.provider.allow_fallbacks, false);
  assert.equal(guard.provider.require_parameters, true);
});

test('硬限制不引入 openrouter/free，也不改写具体模型', () => {
  const guard = buildFreePriceGuard(constraint());
  assert.ok(guard);
  const serialized = JSON.stringify(guard);
  assert.ok(!serialized.includes('openrouter/free'));
  // 守卫对象里根本不携带 model 字段，模型 ID 只能来自连接配置。
  assert.equal(Object.hasOwn(guard, 'model'), false);
});

test('mergeProviderGuard 保留 SDK 其它 provider 字段但强制价格/fallback/参数', () => {
  const guard = buildFreePriceGuard(constraint())!;
  const merged = mergeProviderGuard({ model: 'free/model-x',
    provider: { order: ['openai'], sort: 'price' } }, guard);
  const provider = merged.provider as Record<string, unknown>;
  assert.deepEqual(provider.order, ['openai']);
  assert.deepEqual(provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.equal(provider.allow_fallbacks, false);
  assert.equal(provider.require_parameters, true);
  assert.equal(merged.model, 'free/model-x');
});

test('mergeProviderGuard 在没有 provider 字段的请求体上新建 provider 对象', () => {
  const guard = buildFreePriceGuard(constraint())!;
  const merged = mergeProviderGuard({ model: 'free/model-x', messages: [] }, guard);
  assert.ok(merged.provider);
});

test('withProviderGuard 改写最终发出的 HTTP body，非 JSON body 原样放行', async () => {
  const guard = buildFreePriceGuard(constraint())!;
  let capturedInit: RequestInit | undefined;
  const sink = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;
  const fetchGuarded = withProviderGuard(sink, guard);

  await fetchGuarded('https://api.openai.com/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'free/model-x', messages: [] }),
  });
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.deepEqual((body.provider as Record<string, unknown>).max_price,
    { prompt: 0, completion: 0, request: 0, image: 0 });

  // GET 无字符串 body：不能伪造，原样透传。
  let passthrough: RequestInit | undefined;
  const sink2 = (async (_i: Parameters<typeof fetch>[0], init?: RequestInit) => {
    passthrough = init; return new Response('ok');
  }) as typeof fetch;
  await withProviderGuard(sink2, guard)('https://api.openai.com/v1/models', { method: 'GET' });
  assert.equal(passthrough?.body, undefined);
});
