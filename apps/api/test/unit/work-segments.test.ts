import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelCallRow } from '../../src/infrastructure/database-schema.js';
import { recordedModelUsage } from '../../src/application/work-segments.js';
import { validateStateMaintenanceCandidate } from '../../src/application/conversation-state.js';

test('工作段只汇总实际已知用量，缺项与金额不补零', () => {
  const base = { id: 'call1', kind: 'ASSIST', provider: 'fake', model: 'fixture', status: 'COMPLETED',
    usage_input_tokens: 42, usage_output_tokens: 12, usage_cache_read_tokens: null, usage_cache_creation_tokens: null,
    started_at: new Date('2026-10-14T00:00:00Z'), settled_at: new Date('2026-10-14T00:00:01Z') };
  const partial = recordedModelUsage([base, { ...base, id: 'call2', usage_input_tokens: null, usage_output_tokens: null }] as unknown as ModelCallRow[]);
  assert.deepEqual(partial.input, { known_tokens: '42', total_tokens: null, missing_calls: 1 });
  assert.equal(partial.monetary_cost, null);
  assert.equal(recordedModelUsage([]).input.total_tokens, null);
  assert.equal(recordedModelUsage([]).recorded_call_count, 0);
});
test('工作段会话候选必须给出既有任务范围和预期', () => {
  const candidate = (fields: Record<string, unknown>) => validateStateMaintenanceCandidate({ decision: 'MAINTAIN', decision_required: null,
    changes: [{ kind: 'START_WORK_SEGMENT', ...fields }] });
  assert.equal(candidate({ title: '本段', expectation: '完成已登记条件', task_titles: ['核对报告'] }).ok, true);
  assert.equal(candidate({ title: '本段', task_titles: ['核对报告'] }).ok, false);
  assert.equal(candidate({ title: '本段', expectation: '完成', task_titles: [] }).ok, false);
});
