import assert from 'node:assert/strict';
import test from 'node:test';
import { hypothesisSuggestion } from '../../src/application/hypotheses.js';
import { validateStateMaintenanceCandidate } from '../../src/application/conversation-state.js';

test('无观察、证据不足或方法不可靠时保留无结论', () => {
  for (const [sufficient, reliable, count] of [[true, true, 0], [false, true, 1], [true, false, 1]] as const) {
    assert.deepEqual(hypothesisSuggestion('SUPPORTED', sufficient, reliable, count),
      { outcome: 'INCONCLUSIVE', recommendation: 'COLLECT_MORE_EVIDENCE' });
  }
});
test('可靠充分但未支持主张时只建议停止下一阶段投入', () => {
  assert.deepEqual(hypothesisSuggestion('NOT_SUPPORTED', true, true, 2),
    { outcome: 'NOT_SUPPORTED', recommendation: 'STOP_NEXT_STAGE' });
  assert.deepEqual(hypothesisSuggestion('SUPPORTED', true, true, 1),
    { outcome: 'SUPPORTED', recommendation: 'CONTINUE_DISCUSSION' });
});
test('会话假设建档缺主张、方法或判断标准先澄清', () => {
  const candidate = (fields: Record<string, unknown>) => validateStateMaintenanceCandidate({
    decision: 'MAINTAIN', decision_required: null, changes: [{ kind: 'CREATE_HYPOTHESIS', ...fields }] });
  assert.equal(candidate({ title: '减少核对时间', claim: '核对更快', method: '比较样本', criterion: '总成本下降' }).ok, true);
  assert.equal(candidate({ title: '减少核对时间', claim: '核对更快' }).ok, false);
});
