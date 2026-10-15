import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceComparisonMetrics } from '../../src/application/task-acceptance-comparisons.js';

const baseline = { baselineFindingMs: 60000n, baselinePreparationMs: 0n, baselineTotalMs: 120000n, targetPercent: 20 };
test('找证据达到目标，但总耗时增加时不标整体省时', () => {
  assert.deepEqual(acceptanceComparisonMetrics({ ...baseline, findingMs: 30000n,
    preparationMs: 60000n, totalMs: 150000n }), { finding_reduction_percent: 50,
    total_reduction_percent: -25, preparation_difference_ms: '60000', finding_target_met: true, overall_time_saved: false });
});
test('准备成本增加但整体下降，直接比较已含准备的总耗时', () => {
  assert.deepEqual(acceptanceComparisonMetrics({ ...baseline, findingMs: 30000n,
    preparationMs: 30000n, totalMs: 90000n }), { finding_reduction_percent: 50,
    total_reduction_percent: 25, preparation_difference_ms: '30000', finding_target_met: true, overall_time_saved: true });
});
test('未补录的总耗时与准备成本保持未知', () => {
  const result = acceptanceComparisonMetrics({ ...baseline, findingMs: 30000n, preparationMs: null, totalMs: null });
  assert.equal(result.finding_reduction_percent, 50);
  assert.equal(result.preparation_difference_ms, null);
  assert.equal(result.total_reduction_percent, null);
  assert.equal(result.overall_time_saved, null);
});
test('零基线不形成降幅或成功，阈值按原时长而不是舍入百分比比较', () => {
  const zero = acceptanceComparisonMetrics({ ...baseline, baselineFindingMs: 0n, baselineTotalMs: 0n,
    findingMs: 0n, preparationMs: 0n, totalMs: 0n });
  assert.equal(zero.finding_reduction_percent, null);
  assert.equal(zero.finding_target_met, null);
  assert.equal(zero.total_reduction_percent, null);
  assert.equal(zero.overall_time_saved, null);
  const rounded = acceptanceComparisonMetrics({ ...baseline, baselineFindingMs: 100001n, targetPercent: 50,
    findingMs: 50001n, preparationMs: 0n, totalMs: 10000n });
  assert.equal(rounded.finding_target_met, false);
});
