import assert from 'node:assert/strict';
import test from 'node:test';

import type { AssistCallUsageRow, AssistLiveUsageEstimate }
  from '../../src/application/assist-usage-projection.js';
import { assistUsageDto, liveUsageEstimateJson, projectAssistUsage, readLiveUsageEstimate }
  from '../../src/application/assist-usage-projection.js';

/** 一行已结算调用；缺省 COMPLETED + 完整用量，便于只写关心的字段。 */
function settled({ id, ...patch }: Partial<AssistCallUsageRow> & { readonly id: string }):
AssistCallUsageRow {
  return { id, assist_message_id: 'message-1', status: 'COMPLETED',
    input_tokens: 100, output_tokens: 20,
    cache_read_tokens: null, cache_creation_tokens: null, ...patch };
}

function estimate(patch: Partial<AssistLiveUsageEstimate> = {}): AssistLiveUsageEstimate {
  return { callId: 'call-active', inputTokensEstimate: 900, outputTokensEstimate: 120,
    providerInputTokens: null, providerOutputTokens: null,
    providerCacheReadTokens: null, providerCacheCreationTokens: null, ...patch };
}

test('一次完整调用结算后是 CONFIRMED，总和是原始整数', () => {
  const summary = projectAssistUsage([settled({ id: 'call-1', input_tokens: 4_757,
    output_tokens: 316 })]);
  assert.equal(summary.state, 'CONFIRMED');
  assert.equal(summary.inputTokens, 4_757);
  assert.equal(summary.outputTokens, 316);
  assert.equal(summary.settledCalls, 1);
  assert.equal(summary.pendingCalls, 0);
  assert.equal(summary.missingUsageCalls, 0);
});

test('工具续轮的多次调用逐次累计输入，不把最近一次上下文当成整轮', () => {
  const summary = projectAssistUsage([
    settled({ id: 'call-1', input_tokens: 5_000, output_tokens: 120 }),
    settled({ id: 'call-2', input_tokens: 6_200, output_tokens: 80 }),
    settled({ id: 'call-3', input_tokens: 7_100, output_tokens: 90 }),
  ]);
  assert.equal(summary.state, 'CONFIRMED');
  assert.equal(summary.inputTokens, 18_300);
  assert.equal(summary.outputTokens, 290);
  assert.equal(summary.settledCalls, 3);
});

test('只有在途估算时是 ESTIMATED，数值来自估算而不是账本', () => {
  const summary = projectAssistUsage([settled({ id: 'call-active', status: 'STARTED',
    input_tokens: null, output_tokens: null })], estimate());
  assert.equal(summary.state, 'ESTIMATED');
  assert.equal(summary.inputTokens, 900);
  assert.equal(summary.outputTokens, 120);
  assert.equal(summary.settledCalls, 0);
  assert.equal(summary.pendingCalls, 1);
});

test('结算后的同一 call_id 让账本优先，估算不重复累计', () => {
  const rows = [settled({ id: 'call-1', input_tokens: 1_000, output_tokens: 100 }),
    settled({ id: 'call-2', input_tokens: 2_000, output_tokens: 200 })];
  const summary = projectAssistUsage(rows, estimate({ callId: 'call-2',
    inputTokensEstimate: 7_000, outputTokensEstimate: 700 }));
  assert.equal(summary.state, 'CONFIRMED');
  assert.equal(summary.inputTokens, 3_000);
  assert.equal(summary.outputTokens, 300);
  assert.equal(summary.pendingCalls, 0, '已结算调用不再算在途');
});

test('有已确认调用、后续调用仍在途时是 PARTIAL，且不清零已确认部分', () => {
  const rows = [settled({ id: 'call-1', input_tokens: 5_000, output_tokens: 200 }),
    settled({ id: 'call-2', status: 'STARTED', input_tokens: null, output_tokens: null })];
  const summary = projectAssistUsage(rows, estimate({ callId: 'call-2',
    inputTokensEstimate: 1_000, outputTokensEstimate: 50 }));
  assert.equal(summary.state, 'PARTIAL');
  assert.equal(summary.inputTokens, 6_000);
  assert.equal(summary.outputTokens, 250);
  assert.equal(summary.pendingCalls, 1);
});

test('Provider 部分上报时只替换有值的字段，另一项仍按估算并保持 PARTIAL', () => {
  const rows = [settled({ id: 'call-1', input_tokens: 2_000, output_tokens: 100 }),
    settled({ id: 'call-2', status: 'STARTED', input_tokens: null, output_tokens: null })];
  const summary = projectAssistUsage(rows, estimate({ callId: 'call-2',
    inputTokensEstimate: 800, outputTokensEstimate: 60,
    providerInputTokens: 1_234, providerOutputTokens: null }));
  assert.equal(summary.state, 'PARTIAL');
  assert.equal(summary.inputTokens, 3_234);
  assert.equal(summary.outputTokens, 160);
});

test('未上报用量保持 null，不伪造为 0：单次失败且无读数时是 UNKNOWN', () => {
  const summary = projectAssistUsage([settled({ id: 'call-1', status: 'FAILED',
    input_tokens: null, output_tokens: null })]);
  assert.equal(summary.state, 'UNKNOWN');
  assert.equal(summary.inputTokens, null);
  assert.equal(summary.outputTokens, null);
  assert.equal(summary.settledCalls, 1);
  assert.equal(summary.missingUsageCalls, 1);
  assert.deepEqual(assistUsageDto(summary).input_tokens, null);
});

test('一次调用只上报输入时是 PARTIAL，输出保持未上报', () => {
  const summary = projectAssistUsage([settled({ id: 'call-1', input_tokens: 1_200,
    output_tokens: null })]);
  assert.equal(summary.state, 'PARTIAL');
  assert.equal(summary.inputTokens, 1_200);
  assert.equal(summary.outputTokens, null);
  assert.equal(summary.missingUsageCalls, 1);
});

test('缓存字段只累计真正上报的值，缺失保持 null', () => {
  const summary = projectAssistUsage([
    settled({ id: 'call-1', input_tokens: 1_000, output_tokens: 10,
      cache_read_tokens: 300, cache_creation_tokens: null }),
    settled({ id: 'call-2', input_tokens: 1_100, output_tokens: 10,
      cache_read_tokens: null, cache_creation_tokens: 50 }),
  ]);
  assert.equal(summary.cacheReadTokens, 300);
  assert.equal(summary.cacheCreationTokens, 50);
  const absent = projectAssistUsage([settled({ id: 'call-3' })]);
  assert.equal(absent.cacheReadTokens, null);
  assert.equal(absent.cacheCreationTokens, null);
});

test('预览估算 JSON 往返：畸形或缺失按没有估算处理', () => {
  const json = liveUsageEstimateJson('call-1', { inputTokensEstimate: 900,
    outputTokensEstimate: 40, providerUsage: { inputTokens: null,
      outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null } });
  assert.deepEqual(readLiveUsageEstimate(json), { callId: 'call-1',
    inputTokensEstimate: 900, outputTokensEstimate: 40,
    providerInputTokens: null, providerOutputTokens: null,
    providerCacheReadTokens: null, providerCacheCreationTokens: null });
  assert.equal(readLiveUsageEstimate({}), undefined);
  assert.equal(readLiveUsageEstimate({ call_id: 'call-1',
    input_tokens_estimate: -1, output_tokens_estimate: 4 }), undefined);
  assert.equal(readLiveUsageEstimate(null), undefined);
});
