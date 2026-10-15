import assert from 'node:assert/strict';
import test from 'node:test';
import { readAcceptanceTimeStatement } from '../../src/task/acceptance-time-statement.js';
import { validateStateMaintenanceCandidate } from '../../src/application/conversation-state.js';

test('一句话耗时按原文单位换算，未提项不补零', () => {
  assert.deepEqual(readAcceptanceTimeStatement('记录这次验收：准备用了 3 分钟，整体验收用了 12 分钟'),
    { preparation_ms: 180000, total_acceptance_ms: 720000 });
  assert.deepEqual(readAcceptanceTimeStatement('补录准备改为 1.5 分钟'), { preparation_ms: 90000 });
  assert.deepEqual(readAcceptanceTimeStatement('补录整体验收用了 0.5 小时'), { total_acceptance_ms: 1800000 });
});
test('缺单位、重复口径或总耗时不含准备时不猜数字', () => {
  assert.equal(readAcceptanceTimeStatement('准备 3，整体验收用了 12 分钟'), null);
  assert.equal(readAcceptanceTimeStatement('准备三分钟，整体验收用了 12 分钟'), null);
  assert.equal(readAcceptanceTimeStatement('准备用了 3 分钟，准备改为 4 分钟'), null);
  assert.equal(readAcceptanceTimeStatement('验收用了 12 分钟，不含准备'), null);
});
test('补录候选允许只改准备，拒绝未知数值或倒置总成本', () => {
  const candidate = (change: Record<string, unknown>) => validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', changes: [{ kind: 'REPORT_ACCEPTANCE_TIME', ...change }], decision_required: null });
  assert.equal(candidate({ preparation_ms: 180000 }).ok, true);
  assert.equal(candidate({ preparation_ms: null }).ok, false);
  assert.equal(candidate({ preparation_ms: 180000, total_acceptance_ms: 120000 }).ok, false);
});
