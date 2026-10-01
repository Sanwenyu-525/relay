import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticCheckSettlement } from '../../src/application/verify-run.js';
import type { CheckOutcome } from '../../src/workflow/checkers.js';

/**
 * VERIFY 模型记账行的结算映射（死锁修复引入的独立纯函数）：
 * 信号中止 → CANCELLED；检查器故障（ERROR）→ FAILED；其余 → COMPLETED。
 * 用量与 provider_request_id 只来自检查器证据，不携带正文。
 */
test('semantic check settlement maps checker outcomes and abort to ledger states', () => {
  const pass: CheckOutcome = { result: 'PASS', evidence: {
    provider_request_id: 'req-1', usage: { input_tokens: 12, output_tokens: 8,
      cache_read_tokens: 5, cache_creation_tokens: 1 } } };
  assert.deepEqual(semanticCheckSettlement(pass), { status: 'COMPLETED',
    providerRequestId: 'req-1', usage: { inputTokens: 12, outputTokens: 8,
      cacheReadTokens: 5, cacheCreationTokens: 1 } });

  const error: CheckOutcome = { result: 'ERROR', evidence: {
    error_kind: 'SemanticResponseError', provider_request_id: 'req-2' } };
  assert.deepEqual(semanticCheckSettlement(error), { status: 'FAILED',
    errorKind: 'SemanticResponseError', providerRequestId: 'req-2',
    usage: { inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheCreationTokens: null } });

  // 证据里没有 error_kind 时按 CHECKER_ERROR 结算，不冒充模型判定。
  assert.equal(semanticCheckSettlement({ result: 'ERROR', evidence: {} }).errorKind,
    'CHECKER_ERROR');

  const controller = new AbortController();
  controller.abort();
  assert.equal(semanticCheckSettlement(pass, controller.signal).status, 'CANCELLED');
  assert.equal(semanticCheckSettlement(error, controller.signal).status, 'CANCELLED');
  assert.equal(semanticCheckSettlement({ result: 'FAIL', evidence: {} },
    controller.signal).status, 'CANCELLED');
});
