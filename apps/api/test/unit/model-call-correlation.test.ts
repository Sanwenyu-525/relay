import assert from 'node:assert/strict';
import test from 'node:test';
import { correlationFields } from '../../src/application/model-call-recorder.js';

test('关联字段只复制已确知事实，缺失值不补空键', () => {
  const fields = correlationFields({ workspaceId: 'w-1', kind: 'ASSIST' }, {
    sessionId: 's-1', messageId: 'm-1', workerId: 'worker:1',
  });
  assert.deepEqual(fields, { session_id: 's-1', message_id: 'm-1', worker_id: 'worker:1' });
  assert.equal('run_id' in fields, false);
  assert.equal('task_id' in fields, false);
  assert.equal('project_id' in fields, false);
});

test('未提供关联对象时从 origin 的既有身份补齐，不覆盖业务语义', () => {
  const fields = correlationFields({
    workspaceId: 'w-1', kind: 'VERIFY', assistMessageId: 'm-2',
    readOperationId: 'op-1', readInvocationId: 'inv-1',
  }, undefined);
  assert.deepEqual(fields, {
    message_id: 'm-2', operation_id: 'op-1', invocation_id: 'inv-1',
  });
});

test('显式关联优先于 origin 推断；空字符串按缺失处理', () => {
  const fields = correlationFields({
    workspaceId: 'w-1', kind: 'ASSIST', assistMessageId: 'm-origin',
  }, { messageId: '', workerId: 'worker:2' });
  assert.equal(fields.message_id, 'm-origin');
  assert.equal(fields.worker_id, 'worker:2');

  const overridden = correlationFields({
    workspaceId: 'w-1', kind: 'ASSIST', assistMessageId: 'm-origin',
  }, { messageId: 'm-explicit' });
  assert.equal(overridden.message_id, 'm-explicit');
});

test('成员唤醒保留触发消息身份供跨模块检索', () => {
  const fields = correlationFields({
    workspaceId: 'w-1', kind: 'MEMBER', memberMessageId: 'member-message-1',
  }, { messageId: 'member-message-1', projectId: 'p-1' });
  assert.equal(fields.member_message_id, 'member-message-1');
  assert.equal(fields.project_id, 'p-1');
});
