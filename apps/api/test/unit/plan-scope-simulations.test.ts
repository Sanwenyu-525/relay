import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScopeOptions } from '../../src/application/plan-scope-simulations.js';
import type { PlanningTask } from '../../src/application/personal-planning.js';
const task = (id: string, extra: Partial<PlanningTask> = {}): PlanningTask => ({ task_id: id, title: id, revision: '0', acceptance_revision: '1',
  status: 'INBOX', priority: null, due_local_date: null, estimate_revision: '1', elapsed_ms: 20, human_ms: null, critical: false, dependencies: [], blockers: [], ...extra });
test('固定容量比较全部、保留前置后的缩小范围与推迟下游，不扩时间或改验收', () => {
  const options = buildScopeOptions([task('main', { critical: true, dependencies: ['pre'] }), task('pre', { elapsed_ms: 10 }), task('other', { elapsed_ms: 40 })], 50, 10, ['main'], ['pre'], []);
  assert.deepEqual(options.map((o) => o.kind), ['ALL', 'SHRINK', 'DEFER']);
  assert.equal(options[0]?.requested_elapsed_ms, 70); assert.equal(options[0]?.capacity_gap_ms, 20);
  assert.deepEqual(options[1]?.retained_prerequisite_ids, ['pre']); assert.equal(options[1]?.requested_elapsed_ms, 30);
  assert.deepEqual(options[2]?.task_ids, ['other']);
  assert.equal(options[2]?.items.find((i) => i.task_id === 'main')?.reason, 'DEFERRED_WITH_DEPENDENT');
});
test('不可靠总估时不承诺完成，主线改成必要诊断；已知分项或人工不能补总时间', () => {
  const options = buildScopeOptions([task('main', { critical: true, human_ms: 5 }), task('other', { elapsed_ms: null })], 50, 10, ['main'], ['other'], ['main']);
  assert.equal(options[0]?.requested_elapsed_ms, null); assert.equal(options[0]?.capacity_gap_ms, null);
  assert.equal(options[1]?.feasibility, 'UNKNOWN'); assert.equal(options[1]?.requested_human_ms, null);
  assert.equal(options[1]?.items[0]?.kind, 'DIAGNOSTIC'); assert.equal(options[1]?.planned_ms, 10);
});
