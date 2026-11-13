import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideExpiredGenerationRecovery,
  parseAssistantTurn,
  parseToolResults,
  recoveryReadOnlyTools,
  toResumedRound,
} from '../../src/application/assist-generation-resume.js';
import type { AssistGenerationRoundRow } from '../../src/infrastructure/database-schema.js';

/**
 * 0163 的纯函数面：接续判定与检查点解析。
 *
 * 这两处不需要数据库，但决定了恢复时「会不会信一条编造的历史」与「会不会重复一次
 * 有副作用的动作」。畸形检查点必须整轮丢弃或逐项丢弃，不能补造工具结果。
 */

test('接续判定：停止优先于一切，其次委派与未核对动作，最后才是次数上界', () => {
  const base = { cancelRequested: false, runningDelegation: false, unsafeTool: false,
    generationAttempt: 1, maxAttempts: 3 };
  assert.equal(decideExpiredGenerationRecovery(base), 'REQUEUE');
  assert.equal(decideExpiredGenerationRecovery({ ...base, generationAttempt: 2 }), 'REQUEUE');
  assert.equal(decideExpiredGenerationRecovery({ ...base, generationAttempt: 3 }), 'EXHAUSTED');
  assert.equal(decideExpiredGenerationRecovery({ ...base, unsafeTool: true }), 'BLOCKED');
  assert.equal(decideExpiredGenerationRecovery({ ...base, runningDelegation: true }), 'DEFERRED');
  assert.equal(decideExpiredGenerationRecovery({ ...base, cancelRequested: true }), 'CANCELLED');
  // 用户停止即使同时存在未核对动作与上界，也不再自动处理。
  assert.equal(decideExpiredGenerationRecovery({ ...base, cancelRequested: true,
    unsafeTool: true, runningDelegation: true, generationAttempt: 9 }), 'CANCELLED');
});

test('模型回合解析：缺调用、缺配对标识或参数不是对象的行整轮丢弃', () => {
  const ok = parseAssistantTurn({
    calls: [{ provider_tool_call_id: 'call-1', name: 'read_file',
      arguments: { relative_path: 'README.md' } }],
    steers_before: ['换个方向'],
    preamble: '先读一下',
    reasoning_content: '内部推理',
  });
  assert.ok(ok !== undefined);
  assert.equal(ok.calls.length, 1);
  assert.deepEqual(ok.calls[0]!.arguments, { relative_path: 'README.md' });
  assert.deepEqual(ok.steersBefore, ['换个方向']);
  assert.equal(ok.preamble, '先读一下');
  assert.equal(ok.reasoningContent, '内部推理');

  assert.equal(parseAssistantTurn({ calls: [] }), undefined);
  assert.equal(parseAssistantTurn({ calls: [{ name: 'read_file', arguments: {} }] }), undefined);
  assert.equal(parseAssistantTurn({ calls: [{ provider_tool_call_id: 'call-1',
    name: 'read_file', arguments: 'not-an-object' }] }), undefined);
});

test('工具结果解析：逐项校验，畸形项丢弃但不影响其它项', () => {
  const results = parseToolResults([
    { provider_tool_call_id: 'call-1', name: 'read_file', content: '正文', is_error: false,
      slot: 'READ' },
    { provider_tool_call_id: 'call-2', name: 'todo_write', content: '已写入', is_error: false,
      slot: 'SETTLEMENT' },
    { name: 'read_file', content: '缺配对标识' },
    { provider_tool_call_id: 'call-3', name: 'read_file', content: 42 },
    'not-an-object',
  ]);
  assert.deepEqual(results.map((item) => [item.providerToolCallId, item.slot]), [
    ['call-1', 'READ'],
    ['call-2', 'SETTLEMENT'],
  ]);
  assert.equal(parseToolResults({ items: [] }).length, 0);
  assert.equal(parseToolResults(null).length, 0);
});

test('持久行还原：畸形回合返回 undefined，合法行保留完整回合事实', () => {
  const row = (overrides: Partial<AssistGenerationRoundRow>): AssistGenerationRoundRow => ({
    id: 'round-1', message_id: 'message-1', attempt: 2, round: 0,
    assistant_turn: { calls: [{ provider_tool_call_id: 'call-1', name: 'list_directory',
      arguments: { path: '.' } }], steers_before: [] },
    tool_results: [], usage: null, provider_request_id: null,
    created_at: new Date(0), updated_at: new Date(0),
    ...overrides,
  });
  const round = toResumedRound(row({
    tool_results: [{ provider_tool_call_id: 'call-1', name: 'list_directory',
      content: '{"entries":[]}', is_error: false, slot: 'READ' }],
    usage: { input_tokens: 9, output_tokens: 4, cache_read_tokens: null,
      cache_creation_tokens: null },
    provider_request_id: 'req-1',
  }));
  assert.ok(round !== undefined);
  assert.equal(round.round, 0);
  assert.equal(round.attempt, 2);
  assert.equal(round.results[0]!.content, '{"entries":[]}');
  assert.deepEqual(round.usage, { inputTokens: 9, outputTokens: 4,
    cacheReadTokens: null, cacheCreationTokens: null });
  assert.equal(round.providerRequestId, 'req-1');
  assert.equal(toResumedRound(row({ assistant_turn: { calls: [] } })), undefined);
});

test('恢复只读词表不包含任何有副作用的工具', () => {
  const tools = recoveryReadOnlyTools();
  assert.ok(tools.includes('read_file'));
  assert.ok(tools.includes('list_directory'));
  for (const effectful of ['apply_changeset', 'todo_write', 'delegate_subagent',
    'computer_click', 'browser_click']) {
    assert.equal(tools.includes(effectful), false, effectful);
  }
});
