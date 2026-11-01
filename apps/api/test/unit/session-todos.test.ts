import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTodoContextBlock,
  buildTodoToolResult,
  normalizeTodoItems,
  TODO_ITEMS_MAX,
  TODO_PROMPT_ITEM_LIMIT,
  TodoRequestRejected,
  todoParallelLimit,
  parseNewTaskPrefix,
  todoPromptSelection,
  todoScopeKey,
  todoWriteToolSpec,
  type TodoItem,
} from '../../src/assist/session-todos.js';

/**
 * 待办协议层（ADR-038，2026-10-30）：只测纯函数，不起数据库。
 *
 * 重点验证「拒绝」与「稳定身份」两件事：前者决定脏写入能不能落地，后者决定列表在
 * 版本之间会不会整排换 key；另外验证工作轮次键与长清单注入优先级。
 */

const previous: readonly TodoItem[] = [
  { id: 'id-a', content: '读取执行契约', status: 'completed' },
  { id: 'id-b', content: '实现 todo_write', status: 'in_progress' },
];

const snapshotBase = { sessionId: 's', scopeKey: 'turn:u1', version: 1,
  inProgressLimit: 1, updatedAt: '2026-10-30T00:00:00.000Z' } as const;

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

test('改名保留稳定身份，重排不按位置认身份', () => {
  // 微调措辞（追加“工具”三字）：唯一最佳匹配且相似度达标，身份沿用。
  const renamed = normalizeTodoItems({ parallelLimit: 1, previous, raw: [
    { content: '实现 todo_write 工具', status: 'in_progress' }] });
  assert.equal(renamed[0]?.id, 'id-b');

  // 两段文字差不多的另一件事不得熨合成同一项。
  const unrelated = normalizeTodoItems({ parallelLimit: 1, previous, raw: [
    { content: '整理发布说明草稿', status: 'pending' }] });
  assert.notEqual(unrelated[0]?.id, 'id-a');
  assert.notEqual(unrelated[0]?.id, 'id-b');

  // 重排：身份跟内容走，不跟位置走。
  const reordered = normalizeTodoItems({ parallelLimit: 1, previous, raw: [
    { content: '实现 todo_write', status: 'completed' },
    { content: '读取执行契约', status: 'completed' }] });
  assert.deepEqual(reordered.map((item) => item.id), ['id-b', 'id-a']);
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

test('工作轮次键：有用户消息时按轮次，没有时回落会话级', () => {
  assert.equal(todoScopeKey('u-1'), 'turn:u-1');
  assert.equal(todoScopeKey(undefined), 'session');
  assert.equal(todoScopeKey(null), 'session');
  assert.equal(todoScopeKey(''), 'session');
});

test('上下文块：空清单一字不加，有清单时带版本与上限', () => {
  assert.equal(buildTodoContextBlock({ ...snapshotBase, items: [] }), '');
  const block = buildTodoContextBlock({ ...snapshotBase, version: 3, items: previous,
    inProgressLimit: 2 });
  assert.ok(block.includes('v3'));
  assert.ok(block.includes('已完成 1/2'));
  assert.ok(block.includes('同时进行中最多 2 项'));
  assert.ok(block.includes('expected_version: 3'));
});

test('长清单注入：进行中项必列，完成项折叠成摘要，不按位置丢当前项', () => {
  const items: TodoItem[] = [];
  for (let index = 0; index < 5; index += 1) {
    items.push({ id: `done-${index}`, content: `已完成步骤 ${index}`, status: 'completed' });
  }
  for (let index = 0; index < 30; index += 1) {
    items.push({ id: `todo-${index}`, content: `待办步骤 ${index}`,
      status: index === 29 ? 'in_progress' : 'pending' });
  }
  const selection = todoPromptSelection(items);
  assert.equal(selection.shown.length, TODO_PROMPT_ITEM_LIMIT);
  const shownIds = selection.shown.map((item) => item.id);
  assert.ok(shownIds.includes('todo-29'), '进行中的项必须在注入正文里');
  assert.ok(shownIds.includes('done-4'), '最近一条完成项留作锚点');
  assert.equal(selection.omitted.completed, 4);
  assert.ok(selection.omitted.pending > 0);

  const block = buildTodoContextBlock({ ...snapshotBase, items });
  assert.ok(block.includes('待办步骤 29'));
  assert.ok(block.includes('已完成 4 项（略）'));
  assert.ok(!block.includes('已完成步骤 0'), '早已完成的项不该逐条占预算');
});

test('工具结果与 spec：状态、版本与必填参数就位', () => {
  const result = JSON.parse(buildTodoToolResult({ ...snapshotBase, version: 2, items: previous })) as {
    version: number; counts: { completed: number }; items: unknown[] };
  assert.equal(result.version, 2);
  assert.equal(result.counts.completed, 1);
  assert.equal(result.items.length, 2);
  const spec = todoWriteToolSpec();
  assert.equal(spec.name, 'todo_write');
  assert.deepEqual(spec.parameters.required, ['items']);
  const properties = spec.parameters.properties as { expected_version: { minimum: number } };
  assert.equal(properties.expected_version.minimum, 0, '首次写入必须能用 0 表达基线');
});
test('换任务的显式声明：/newtask 剥掉命令只留正文，其它写法一律不认', () => {
  // 与「新任务：」同义：命令决定这一轮怎么受理，命令后面的内容才是正文。
  assert.deepEqual(parseNewTaskPrefix('/newtask 整理发布说明'), { rest: '整理发布说明' });
  assert.deepEqual(parseNewTaskPrefix('  /NEWTASK   换一件事  '), { rest: '换一件事' });
  // 只有命令没有内容：返回空正文，由调用方拒绝（不能发一条空消息）。
  assert.deepEqual(parseNewTaskPrefix('/newtask'), { rest: '' });
  // 不做关键词猜测：句子中间出现、或只是提到这个词，都不算声明。
  assert.equal(parseNewTaskPrefix('请继续 /newtask 这件事'), null);
  assert.equal(parseNewTaskPrefix('newtask 整理发布说明'), null);
  assert.equal(parseNewTaskPrefix('新任务：整理发布说明'), null);
  assert.equal(parseNewTaskPrefix(''), null);
});
