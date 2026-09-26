import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextFixture } from '../../src/workflow/context-fixture.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { CANDIDATE_OUTPUT_SCHEMA, validateCandidate } from '../../src/workflow/markdown-deliverable.js';

/**
 * FakeModelPort 的四个场景与确定性（P05）。
 * 模型输出只变成受约束结果：这里只断言输出类型与稳定性，不涉及任何 Task/Run 状态。
 */

const CONTRACT_SNAPSHOT = {
  source: 'DELEGATE',
  objective: '写一份候选交付',
};

function manifestFor(fakeScenario: 'LEGAL' | 'SCHEMA_INVALID' | 'MISSING_MATERIAL') {
  return buildContextFixture({
    taskId: '11111111-1111-1111-1111-111111111111',
    taskTitle: '候选任务',
    contractSnapshot: CONTRACT_SNAPSHOT,
    fakeScenario,
  }).payload;
}

test('LEGAL produces a structurally valid candidate with deterministic identity and usage', async () => {
  const port = new FakeModelPort();
  const request = {
    manifest: manifestFor('LEGAL'),
    outputSchema: CANDIDATE_OUTPUT_SCHEMA,
  };
  const first = await port.generate(request);
  const second = await port.generate(request);

  assert.equal(first.kind, 'CONTENT');
  assert.deepEqual(first, second);

  if (first.kind !== 'CONTENT') {
    throw new Error('expected CONTENT');
  }

  assert.equal(validateCandidate(first.content).ok, true);
  assert.match(first.providerRequestId, /^fake-[0-9a-f]{32}$/u);
  assert.ok(first.usage.inputTokens !== null && first.usage.inputTokens >= 1);
  assert.ok(first.usage.outputTokens !== null && first.usage.outputTokens >= 1);
});

test('SCHEMA_INVALID produces text missing a required section', async () => {
  const result = await new FakeModelPort().generate({
    manifest: manifestFor('SCHEMA_INVALID'),
    outputSchema: CANDIDATE_OUTPUT_SCHEMA,
  });

  assert.equal(result.kind, 'SCHEMA_INVALID');

  if (result.kind !== 'SCHEMA_INVALID') {
    throw new Error('expected SCHEMA_INVALID');
  }

  assert.equal(validateCandidate(result.raw).ok, false);
  assert.match(result.reason, /结论/u);
});

test('MISSING_MATERIAL declares the missing input', async () => {
  const result = await new FakeModelPort().generate({
    manifest: manifestFor('MISSING_MATERIAL'),
    outputSchema: CANDIDATE_OUTPUT_SCHEMA,
  });

  assert.equal(result.kind, 'MISSING_MATERIAL');

  if (result.kind !== 'MISSING_MATERIAL') {
    throw new Error('expected MISSING_MATERIAL');
  }

  assert.deepEqual(result.missing, ['material']);
});

test('an aborted signal yields CANCELLED without producing content', async () => {
  const controller = new AbortController();

  controller.abort();

  const result = await new FakeModelPort().generate({
    manifest: manifestFor('LEGAL'),
    outputSchema: CANDIDATE_OUTPUT_SCHEMA,
    signal: controller.signal,
  });

  assert.equal(result.kind, 'CANCELLED');
});
