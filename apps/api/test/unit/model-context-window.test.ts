import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_DECLARED_CONTEXT_WINDOW_TOKENS, MIN_DECLARED_CONTEXT_WINDOW_TOKENS,
  MODEL_CONTEXT_TARGET_TOKENS, UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  assembleModelContextCapacity, resolveEffectiveModelWindow,
} from '../../src/application/model-context-window.js';

/**
 * 0165：模型容量只做纯算术与来源归一。
 *
 * 这些断言锁住产品口径：
 *   · 1M 是十进制目标，不是 1,048,576；
 *   · 真实窗口大于 1M 时仍只申请 1M；
 *   · 未知窗口用 256K 安全回退，绝不假定 1M；
 *   · 服务商单次上限可以继续压低有效窗口；
 *   · 来源与 fallback 标记必须自洽，不把未知说成目录能力。
 */

test('产品目标是十进制 1M，安全回退是 256K', () => {
  assert.equal(MODEL_CONTEXT_TARGET_TOKENS, 1_000_000);
  assert.equal(UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS, 262_144);
  assert.equal(MIN_DECLARED_CONTEXT_WINDOW_TOKENS, 16_384);
  assert.equal(MAX_DECLARED_CONTEXT_WINDOW_TOKENS, 4_000_000);
});

test('已知 1M 窗口原样可用', () => {
  const resolved = resolveEffectiveModelWindow({ modelWindowTokens: 1_000_000 });
  assert.deepEqual(resolved, { windowTokens: 1_000_000, fallbackApplied: false });
});

test('真实窗口大于 1M 时按产品目标截断', () => {
  const resolved = resolveEffectiveModelWindow({ modelWindowTokens: 2_000_000 });
  assert.equal(resolved.windowTokens, 1_000_000);
  assert.equal(resolved.fallbackApplied, false);
});

test('未知窗口按安全回退，不冒充 1M', () => {
  const resolved = resolveEffectiveModelWindow({ modelWindowTokens: null });
  assert.deepEqual(resolved, { windowTokens: 262_144, fallbackApplied: true });
});

test('服务商单次硬上限继续压低有效窗口', () => {
  const resolved = resolveEffectiveModelWindow({ modelWindowTokens: 1_000_000,
    providerCallCapTokens: 65_536 });
  assert.equal(resolved.windowTokens, 65_536);
  assert.equal(resolved.fallbackApplied, false);
});

test('极小/非法输入不产生 0 窗口', () => {
  assert.equal(resolveEffectiveModelWindow({ modelWindowTokens: 1_024 }).windowTokens, 1_024);
  assert.equal(resolveEffectiveModelWindow({ modelWindowTokens: 0 }).windowTokens, 262_144);
  assert.equal(resolveEffectiveModelWindow({ modelWindowTokens: -1 }).windowTokens, 262_144);
});

test('容量组装：已知窗口带来源，未知窗口强制 UNKNOWN_FALLBACK', () => {
  const known = assembleModelContextCapacity({ model: 'gpt-test',
    modelWindowTokens: 1_000_000, windowSource: 'CAPABILITY_DECLARATION',
    providerCallCapTokens: 1_000_000, outputReserveTokens: 8_192 });
  assert.deepEqual(known, { model: 'gpt-test', modelWindowTokens: 1_000_000,
    windowSource: 'CAPABILITY_DECLARATION', providerCallCapTokens: 1_000_000,
    outputReserveTokens: 8_192, effectiveWindowTokens: 1_000_000, fallbackApplied: false });

  const unknown = assembleModelContextCapacity({ model: 'unknown',
    modelWindowTokens: null, windowSource: 'MODEL_CATALOG' });
  assert.equal(unknown.modelWindowTokens, null);
  assert.equal(unknown.windowSource, 'UNKNOWN_FALLBACK');
  assert.equal(unknown.effectiveWindowTokens, 262_144);
  assert.equal(unknown.fallbackApplied, true);
});

test('已知窗口却标 UNKNOWN_FALLBACK 时归一为 MODEL_CATALOG，避免自相矛盾', () => {
  const capacity = assembleModelContextCapacity({ model: 'm',
    modelWindowTokens: 524_288, windowSource: 'UNKNOWN_FALLBACK' });
  assert.equal(capacity.windowSource, 'MODEL_CATALOG');
  assert.equal(capacity.fallbackApplied, false);
});
