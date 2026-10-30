import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryContextLimits } from '../../src/application/assist-memory.js';

test('256K, 512K and 1024K scale input and pressure limits without a message-count trigger', () => {
  for (const tokens of [262_144, 524_288, 1_048_576]) {
    const limits = memoryContextLimits(tokens);
    assert.equal(limits.inputBytes, tokens * 0.75 * 3);
    assert.equal(limits.autoBytes, Math.floor(limits.inputBytes * 0.8));
    assert.equal(limits.autoMessages, null);
    assert.ok(limits.autoBytes < limits.inputBytes);
  }
});

test('smaller effective model budgets reduce the limit; legacy mock/default keeps its guard', () => {
  assert.ok(memoryContextLimits(32_768).inputBytes < memoryContextLimits(262_144).inputBytes);
  assert.deepEqual(memoryContextLimits(null), { inputBytes: 128000, autoBytes: 48000, autoMessages: 32 });
});
