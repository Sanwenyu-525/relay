import assert from 'node:assert/strict';
import test from 'node:test';

import { computeDailyDelta, validateViewedFactRefs } from
  '../../src/application/project-daily-continuation.js';
import type { DailyViewCurrentFacts } from '../../src/application/project-daily-continuation.js';

/**
 * 日常查看基线的确定性纯函数（无数据库）：
 * delta 计算（含「基线缺字段按未知保守处理」）与 viewed_fact_refs 入口校验。
 */

const baseCurrent: DailyViewCurrentFacts = {
  phase_key: 'DISCOVERY',
  next_action_task_id: null,
  open_task_ids: ['task-a', 'task-b'],
  unresolved_blocker_count: 0,
  open_task_ids_truncated: false,
};

const baseRefs = {
  phase_key: 'DISCOVERY',
  next_action_task_id: null,
  open_task_ids: ['task-a', 'task-b'],
  unresolved_blocker_count: 0,
};

test('无基线时 delta 为 null：只展示当前事实', () => {
  assert.equal(computeDailyDelta(baseCurrent, null), null);
});

test('当前事实与基线完全一致时零变化', () => {
  const delta = computeDailyDelta(baseCurrent, baseRefs);
  assert.ok(delta !== null);
  assert.deepEqual(delta, {
    phase_changed: false, phase_before: 'DISCOVERY', phase_after: 'DISCOVERY',
    next_action_changed: false, next_action_before: null, next_action_after: null,
    new_open_task_ids: [], closed_task_ids: [],
    unresolved_blocker_count_changed: false, open_tasks_unknown: false,
  });
});

test('任务集合任一侧超出租捕范围时新增/关闭为未知，不声称「没有变化」', () => {
  const truncatedCurrent: DailyViewCurrentFacts = { ...baseCurrent,
    open_task_ids_truncated: true };
  const delta = computeDailyDelta(truncatedCurrent, baseRefs);
  assert.ok(delta !== null);
  assert.equal(delta.open_tasks_unknown, true);
  assert.deepEqual(delta.new_open_task_ids, []);
  assert.deepEqual(delta.closed_task_ids, []);

  // 基线恰好填满捕获上限：无法区分「正好 200 个」与「被截断」，保守按未知处理。
  const fullBaseline = { ...baseRefs,
    open_task_ids: Array.from({ length: 200 }, (_, index) => `task-${index}`) };
  const conservative = computeDailyDelta(baseCurrent, fullBaseline);
  assert.ok(conservative !== null);
  assert.equal(conservative.open_tasks_unknown, true);
  assert.deepEqual(conservative.closed_task_ids, []);

  // 基线自己标注被截断时同样按未知处理。
  const flagged = computeDailyDelta(baseCurrent, { ...baseRefs,
    open_task_ids_truncated: true });
  assert.ok(flagged !== null);
  assert.equal(flagged.open_tasks_unknown, true);
});

test('phase 与 next_action 逐字段比较，before/after 如实报告', () => {
  const delta = computeDailyDelta({ ...baseCurrent,
    phase_key: 'IMPLEMENTATION', next_action_task_id: 'task-b' },
  { ...baseRefs, phase_key: 'DISCOVERY', next_action_task_id: null });
  assert.ok(delta !== null);
  assert.equal(delta.phase_changed, true);
  assert.equal(delta.phase_before, 'DISCOVERY');
  assert.equal(delta.phase_after, 'IMPLEMENTATION');
  assert.equal(delta.next_action_changed, true);
  assert.equal(delta.next_action_before, null);
  assert.equal(delta.next_action_after, 'task-b');
});

test('open 集合差集：新开与关闭按各自顺序报告', () => {
  const delta = computeDailyDelta({ ...baseCurrent,
    open_task_ids: ['task-b', 'task-c', 'task-d'] },
  { ...baseRefs, open_task_ids: ['task-a', 'task-b', 'task-x'] });
  assert.ok(delta !== null);
  assert.deepEqual(delta.new_open_task_ids, ['task-c', 'task-d']);
  assert.deepEqual(delta.closed_task_ids, ['task-a', 'task-x']);
});

test('阻塞计数变化如实比较', () => {
  const changed = computeDailyDelta({ ...baseCurrent, unresolved_blocker_count: 2 },
    { ...baseRefs, unresolved_blocker_count: 0 });
  assert.ok(changed !== null);
  assert.equal(changed.unresolved_blocker_count_changed, true);
  const same = computeDailyDelta({ ...baseCurrent, unresolved_blocker_count: 3 },
    { ...baseRefs, unresolved_blocker_count: 3 });
  assert.ok(same !== null);
  assert.equal(same.unresolved_blocker_count_changed, false);
});

test('基线缺字段或类型错时该维度保守 false，不猜', () => {
  // 历史 refs 缺 open_task_ids：新开/关闭都不声称。
  const noOpen = computeDailyDelta(baseCurrent,
    { phase_key: 'DISCOVERY', next_action_task_id: null });
  assert.ok(noOpen !== null);
  assert.deepEqual(noOpen.new_open_task_ids, []);
  assert.deepEqual(noOpen.closed_task_ids, []);
  assert.equal(noOpen.phase_changed, false);

  // phase_key 类型错（数字）：不比较，before 如实为 null。
  const badPhase = computeDailyDelta(baseCurrent, { ...baseRefs, phase_key: 7 });
  assert.ok(badPhase !== null);
  assert.equal(badPhase.phase_changed, false);
  assert.equal(badPhase.phase_before, null);
  assert.equal(badPhase.phase_after, 'DISCOVERY');

  // next_action_task_id 类型错：不比较。
  const badNext = computeDailyDelta(baseCurrent,
    { ...baseRefs, next_action_task_id: ['task-a'] });
  assert.ok(badNext !== null);
  assert.equal(badNext.next_action_changed, false);
  assert.equal(badNext.next_action_before, null);

  // open_task_ids 类型错：不声称差集。
  const badOpen = computeDailyDelta(baseCurrent, { ...baseRefs, open_task_ids: 'task-a' });
  assert.ok(badOpen !== null);
  assert.deepEqual(badOpen.new_open_task_ids, []);
  assert.deepEqual(badOpen.closed_task_ids, []);

  // 缺阻塞计数：保守 false。
  const noBlocker = computeDailyDelta({ ...baseCurrent, unresolved_blocker_count: 5 },
    { phase_key: 'DISCOVERY', next_action_task_id: null, open_task_ids: [] });
  assert.ok(noBlocker !== null);
  assert.equal(noBlocker.unresolved_blocker_count_changed, false);

  // 阻塞计数类型错：保守 false。
  const badBlocker = computeDailyDelta(baseCurrent,
    { ...baseRefs, unresolved_blocker_count: 'many' });
  assert.ok(badBlocker !== null);
  assert.equal(badBlocker.unresolved_blocker_count_changed, false);
});

test('viewed_fact_refs 校验：合法形状原样通过', () => {
  const validated = validateViewedFactRefs({ ...baseRefs,
    unresolved_blocker_count: 1 });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(validated.refs.phase_key, 'DISCOVERY');
  assert.deepEqual(validated.refs.open_task_ids, ['task-a', 'task-b']);
});

test('viewed_fact_refs 校验：数组、缺字段、类型错、超限都类型化拒绝', () => {
  // 数组不是 object。
  const array = validateViewedFactRefs(['task-a']);
  assert.equal(array.ok, false);
  assert.ok((array.ok ? [] : array.fieldErrors).some((error) => error.field === 'viewed_fact_refs'));

  // 缺 phase_key / next_action_task_id / open_task_ids。
  for (const missing of [
    { next_action_task_id: null, open_task_ids: [] },
    { phase_key: 'DISCOVERY', open_task_ids: [] },
    { phase_key: 'DISCOVERY', next_action_task_id: null },
  ]) {
    const result = validateViewedFactRefs(missing);
    assert.equal(result.ok, false, `缺字段应被拒绝：${JSON.stringify(missing)}`);
  }

  // open_task_ids 元素非字符串。
  const badElement = validateViewedFactRefs({ ...baseRefs, open_task_ids: ['task-a', 3] });
  assert.equal(badElement.ok, false);

  // open_task_ids 超 200 上限。
  const overflow = validateViewedFactRefs({ ...baseRefs,
    open_task_ids: Array.from({ length: 201 }, (_, index) => `task-${index}`) });
  assert.equal(overflow.ok, false);
  assert.ok((overflow.ok ? [] : overflow.fieldErrors)
    .some((error) => error.message.includes('200')));

  // unresolved_blocker_count 存在时必须是非负整数。
  const badBlocker = validateViewedFactRefs({ ...baseRefs, unresolved_blocker_count: -1 });
  assert.equal(badBlocker.ok, false);
  const floatBlocker = validateViewedFactRefs({ ...baseRefs, unresolved_blocker_count: 1.5 });
  assert.equal(floatBlocker.ok, false);

  // next_action_task_id 只接受 string 或 null。
  const badNextType = validateViewedFactRefs({ ...baseRefs, next_action_task_id: 42 });
  assert.equal(badNextType.ok, false);
});
