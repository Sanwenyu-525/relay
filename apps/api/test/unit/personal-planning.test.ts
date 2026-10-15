import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlanningItems, type PlanningTask } from '../../src/application/personal-planning.js';

const task = (id: string, extra: Partial<PlanningTask> = {}): PlanningTask => ({ task_id: id, title: id, revision: '0', acceptance_revision: '1',
  status: 'INBOX', priority: null, due_local_date: null, estimate_revision: '1', elapsed_ms: 20, human_ms: null,
  critical: false, dependencies: [], blockers: [], ...extra });
test('主线必要前置先排，剩余容量才排独立任务；人工投入不重复占用整段预算', () => {
  const items = buildPlanningItems([task('small', { elapsed_ms: 10, priority: 'HIGH' }), task('main', { critical: true, dependencies: ['prerequisite'], human_ms: 100 }), task('prerequisite')], 50, 10);
  assert.deepEqual(items.map((i) => i.task_id), ['prerequisite', 'main', 'small']);
  assert.deepEqual(items.map((i) => i.kind), ['TASK', 'TASK', 'TASK']);
});
test('未知主线只排有边界诊断，下游和无估时独立任务不承诺完成', () => {
  const items = buildPlanningItems([task('main', { critical: true, dependencies: ['unknown'] }), task('unknown', { elapsed_ms: null }), task('other', { elapsed_ms: null })], 100, 10);
  assert.equal(items[0]?.kind, 'DIAGNOSTIC'); assert.equal(items[0]?.budget_ms, 10); assert.equal(items[0]?.human_ms, null);
  assert.match(items[0]?.output ?? '', /未知问题/);
  assert.equal(items[1]?.reason, 'DEPENDENCY_NOT_PLANNED'); assert.equal(items[2]?.reason, 'ESTIMATE_UNKNOWN');
});
test('容量不足与已登记阻塞明确延后，不把计划建议当执行准入', () => {
  const items = buildPlanningItems([task('main', { critical: true, elapsed_ms: 60 }), task('blocked', { blockers: ['需要人工决定'] })], 50, 10);
  assert.equal(items[0]?.reason, 'CAPACITY_EXCEEDED'); assert.equal(items[1]?.reason, 'OPEN_BLOCKER');
});
