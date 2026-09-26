import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { attachReadEvidenceWithinBudget, ReadInputBudgetError,
  type RunReadEvidence } from '../../src/application/run-read-evidence.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';

test('Gateway text is trimmed to the remaining Manifest budget at a UTF-8 boundary', () => {
  const content = '😀'.repeat(2_000);
  const manifest = { task: { title: '摘要' }, sources: [],
    budget: { limit_tokens: 1_000, reserved_tokens: 250,
      selected_tokens: 50 } };
  const read: RunReadEvidence = { operationId: 'operation', invocationId: 'invocation',
    input: { kind: 'FILE_READ', trust: 'UNTRUSTED_DATA', operation_id: 'operation',
      invocation_id: 'invocation', target: 'file.txt', source_sha256: 'a'.repeat(64),
      content_sha256: createHash('sha256').update(content).digest('hex'),
      included_sha256: createHash('sha256').update(content).digest('hex'),
      content_bytes: Buffer.byteLength(content), included_bytes: Buffer.byteLength(content),
      input_truncated: false, adapter_truncated: false, text_available: true, content } };
  const input = attachReadEvidenceWithinBudget(manifest, read);
  const excerpt = (input.tool_read as { content: string; included_sha256: string;
    included_bytes: number; input_truncated: boolean });
  assert.equal(excerpt.input_truncated, true);
  assert.ok(excerpt.content.length < content.length);
  assert.equal(excerpt.content.includes('\ufffd'), false);
  assert.equal(excerpt.included_bytes, Buffer.byteLength(excerpt.content));
  assert.equal(excerpt.included_sha256,
    createHash('sha256').update(excerpt.content).digest('hex'));
  assert.ok(Math.ceil(Buffer.byteLength(canonicalizeJson(input), 'utf8') / 3) + 250 <= 1_000);
});

test('Gateway metadata that cannot fit the Manifest budget prevents model input', () => {
  const manifest = { sources: [], budget: { limit_tokens: 40, reserved_tokens: 30 } };
  const read: RunReadEvidence = { operationId: 'operation', invocationId: 'invocation',
    input: { trust: 'UNTRUSTED_DATA', operation_id: 'operation',
      invocation_id: 'invocation', source_sha256: 'a'.repeat(64), content: 'data' } };
  assert.throws(() => attachReadEvidenceWithinBudget(manifest, read), ReadInputBudgetError);
});
