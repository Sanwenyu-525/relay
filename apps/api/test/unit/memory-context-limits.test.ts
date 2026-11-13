import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryContextLimits } from '../../src/application/assist-memory.js';

/**
 * 0162：这里只剩「一次压缩请求最多能读多少历史」的输入上限。
 *
 * 触发阈值已经改为 token 策略（`assist-context-policy.ts`），不再有
 * `autoBytes` / `autoMessages` 这两个按字节与条数的自动触发门槛；保留它们会让
 * 读者以为「到 48KB 就压」仍然生效。
 */
test('256K, 512K and 1024K scale the compaction input bound', () => {
  for (const tokens of [262_144, 524_288, 1_048_576]) {
    const limits = memoryContextLimits(tokens);
    assert.equal(limits.inputBytes, tokens * 0.75 * 3);
  }
});

test('smaller effective model budgets reduce the limit; legacy mock/default keeps its guard', () => {
  assert.ok(memoryContextLimits(32_768).inputBytes < memoryContextLimits(262_144).inputBytes);
  assert.deepEqual(memoryContextLimits(null), { inputBytes: 128000 });
});
