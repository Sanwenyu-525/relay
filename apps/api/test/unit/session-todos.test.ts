import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTodoContextBlock,
  buildTodoToolResult,
  normalizeTodoItems,
  TODO_ITEMS_MAX,
  TodoRequestRejected,
  todoParallelLimit,
  todoWriteToolSpec,
  type TodoItem,
} from '../../src/assist/session-todos.js';

/**
 * 待办协议层（ADR-038，2026-10-30）：只测纯函数，不起数据库。
 *
 * 重点验证“拒绝”与“稳定身份”两件事：前者决定脏写入能不能落地，后者决定列表在
 * 版本之间会不会整排换 key。
 */

const previous: readonly TodoItem[] = [
  { id: 'id-a', content: '读取执行契约', status: 'completed' },
  { id: 'id-b', content: '实现 todo_write', status: 'in_progress' },
];

function reason(run: () => unknown): string {
  try { run(); } catch (error) {
    return error instanceof TodoRequestRejected ? error.reason : 'NOT_TYPED';
  }
  return 'NO_THROW';
}

test('规范化保持顺序，并沿用上一版的内容匹配身份', () => {
  const items = normalizeTodoItems({ parallelLimit: 1, previous, raw: [
    { content: '实现 todo_write', status: 'completed' },
    { content: '跑集成测试', status: 'pending' },
  ] });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, 'id-b');
  assert.equal(items[1]?.status, 'pending');
  assert.notEqual(items[1]?.id, 'id-b');
});

test('身份只跟上一版对齐：陌生 id 不直接采用，两项也不会撞 id', () => {
  const items = normalizeTodoItems({ parallelLimit: 1, previous, raw: [
    { id: 'id-b', content: '实现 todo_write', status: 'completed' },
    { id: 'id-b', content: '另一项', status: 'pending' },
  ] });
  // 第一项与上一版同 id 且未占用，沿用；第二项声明了已被占用的 id，服务端另发新 id。
  assert.equal(items[0]?.id, 'id-b');
  assert.notEqual(items[1]?.id, 'id-b');
  assert.equal(items.filter((item) => item.id === 'id-b').length, 1);
  // 陌生 id（上一版没有）不直接采用，避免模型跨会话伪造身份。
  const fresh = normalizeTodoItems({ parallelLimit: 1, previous: [], raw: [
    { id: 'forged', content: 'A', status: 'pending' }] });
  assert.notEqual(fresh[0]?.id, 'forged');
});

test('拒绝路径：空数组、超长、重复、非法状态、并行超限', () => {
  const one = { parallelLimit: 1 } as const;
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous, raw: [] })),
    'TODO_ITEMS_EMPTY');
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous,
    raw: [{ content: 'x'.repeat(201), status: 'pending' }] })), 'TODO_CONTENT_TOO_LONG');
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous, raw: [
    { content: '同一个', status: 'pending' }, { content: ' 同一个 ', status: 'completed' }] })),
  'TODO_DUPLICATE_CONTENT');
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous,
    raw: [{ content: 'A', status: 'DONE' }] })), 'TODO_STATUS_INVALID');
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous, raw: [
    { content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }] })),
  'TODO_IN_PROGRESS_LIMIT');
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous,
    raw: Array.from({ length: TODO_ITEMS_MAX + 1 }, (_v, i) => ({ content: 'item ' + i,
      status: 'pending' })) })), 'TODO_ITEMS_TOO_MANY');
  assert.equal(reason(() => normalizeTodoItems({ ...one, previous, raw: 'nope' })),
    'TODO_ITEMS_INVALID');
});

test('并行上限：默认 1，非法值回落，上限 8', () => {
  assert.equal(todoParallelLimit(undefined), 1);
  assert.equal(todoParallelLimit('3'), 3);
  assert.equal(todoParallelLimit('abc'), 1);
  assert.equal(todoParallelLimit(0), 1);
  assert.equal(todoParallelLimit(99), 8);
});

test('上下文块：空清单一字不加，有清单时带版本与上限', () => {
  assert.equal(buildTodoContextBlock({ sessionId: 's', version: 1, items: [],
    inProgressLimit: 1, updatedAt: '2026-10-30T00:00:00.000Z' }), '');
  const block = buildTodoContextBlock({ sessionId: 's', version: 3, items: previous,
    inProgressLimit: 2, updatedAt: '2026-10-30T00:00:00.000Z' });
  assert.ok(block.includes('v3'));
  assert.ok(block.includes('已完成 1/2'));
  assert.ok(block.includes('同时进行中最多 2 项'));
});

test('工具结果与 spec：状态、版本与必填参数就位', () => {
  const result = JSON.parse(buildTodoToolResult({ sessionId: 's', version: 2, items: previous,
    inProgressLimit: 1, updatedAt: '2026-10-30T00:00:00.000Z' })) as {
      version: number; counts: { completed: number }; items: unknown[] };
  assert.equal(result.version, 2);
  assert.equal(result.counts.completed, 1);
  assert.equal(result.items.length, 2);
  const spec = todoWriteToolSpec();
  assert.equal(spec.name, 'todo_write');
  assert.deepEqual(spec.parameters.required, ['items']);
});