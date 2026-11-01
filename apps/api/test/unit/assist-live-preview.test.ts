import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentReplyPreviewProjector, AssistLivePreviewPublisher, AssistLiveUsagePublisher,
  AssistPreviewOwnershipLostError } from '../../src/assist/live-preview.js';
import type { ModelUsageProgress } from '../../src/workflow/fake-model-port.js';

const emptyUsage = { inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheCreationTokens: null };

function progress(outputTokensEstimate: number): ModelUsageProgress {
  return { inputTokensEstimate: 900, outputTokensEstimate, providerUsage: emptyUsage };
}

test('Agent reply projection survives every split and never exposes later fields', () => {
  const reply = '中文🙂 "quoted" \\ path\nnext';
  const wire = JSON.stringify({ reply, execution: { secret: 'HIDDEN' }, maintenance: 'HIDDEN' });
  for (let split = 0; split <= wire.length; split += 1) {
    const projector = new AgentReplyPreviewProjector();
    assert.equal(projector.push(wire.slice(0, split)) + projector.push(wire.slice(split)), reply);
    assert.equal(projector.push('HIDDEN'), '');
  }
  const projector = new AgentReplyPreviewProjector();
  assert.equal([...wire].map((piece) => projector.push(piece)).join(''), reply);
});

test('Agent reply projection handles incomplete escapes, unknown envelopes and bounded input', () => {
  const projector = new AgentReplyPreviewProjector();
  assert.equal(projector.push('{"reply":"A\\u4'), 'A');
  assert.equal(projector.push('e2d\\'), '中');
  assert.equal(projector.push('nB","execution":"HIDDEN"}'), '\nB');
  for (const input of ['{"execution":"HIDDEN","reply":"later"}', '```js\n{"reply":"later"}',
    '[{"reply":"later"}]', '{"reply":"\\qHIDDEN"}']) {
    assert.equal(new AgentReplyPreviewProjector().push(input), '');
  }
  assert.equal(new AgentReplyPreviewProjector().push('x'.repeat(131_073)), '');
  const plain = new AgentReplyPreviewProjector();
  assert.equal(plain.push('hello'), 'hello');
  assert.equal(plain.push(' world'), ' world');
});

test('fenced replies stream safely and prose preambles cannot expose envelopes at any split', () => {
  const envelope = JSON.stringify({ reply: '可见正文', execution: { secret: 'HIDDEN' } });
  for (const fence of ['```json\n', '```JSON\r\n', '```\n']) {
    const wire = fence + envelope + '\n```';
    for (let split = 0; split <= wire.length; split += 1) {
      const projector = new AgentReplyPreviewProjector();
      assert.equal(projector.push(wire.slice(0, split)) + projector.push(wire.slice(split)), '可见正文');
    }
  }
  const wire = '说明文字\n' + envelope;
  for (let split = 0; split <= wire.length; split += 1) {
    const projector = new AgentReplyPreviewProjector();
    assert.equal(projector.push(wire.slice(0, split)) + projector.push(wire.slice(split)), '说明文字\n');
  }
});

test('live preview preserves UTF-8 boundaries and caps the cumulative prefix', async () => {
  const writes: { text: string; truncated: boolean }[] = [];
  const preview = new AssistLivePreviewPublisher(async (text, truncated) => {
    writes.push({ text, truncated });
    return true;
  }, () => assert.fail('owner should remain current'));
  await preview.push('a'.repeat(16_380) + '🙂x');
  assert.equal(writes.length, 1);
  assert.equal(Buffer.byteLength(writes[0]!.text, 'utf8'), 16_384);
  assert.equal(writes[0]!.text.endsWith('🙂'), true);
  assert.equal(writes[0]!.text.includes('\uFFFD'), false);
  assert.equal(writes[0]!.truncated, true);
  await preview.push('ignored');
  assert.equal(writes.length, 1);
});

test('live usage publisher throttles to the newest frame and flushes the last one', async () => {
  // AGENT_LIVE_TOKEN_USAGE：约 500ms 一档，避免为每个 chunk 写一次预览行；同一档内只留最新值。
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const writes: number[] = [];
    const publisher = new AssistLiveUsagePublisher(async (value) => {
      writes.push(value.outputTokensEstimate);
      return true;
    }, () => assert.fail('owner should remain current'));
    await publisher.push(progress(0));
    assert.deepEqual(writes, [0]);
    await publisher.push(progress(10));
    await publisher.push(progress(20));
    assert.deepEqual(writes, [0], 'same window keeps only the pending newest frame');
    now += 600;
    await publisher.push(progress(30));
    assert.deepEqual(writes, [0, 30]);
    await publisher.push(progress(40));
    await publisher.flush();
    assert.deepEqual(writes, [0, 30, 40], 'call end flushes the last pending reading');
    await publisher.push(progress(50));
    assert.deepEqual(writes, [0, 30, 40], 'stopped publisher ignores late frames');
  } finally { Date.now = originalNow; }
});

test('live usage publisher signals ownership loss without inventing a write', async () => {
  const lost: string[] = [];
  const publisher = new AssistLiveUsagePublisher(async () => false,
    () => lost.push('lost'));
  await assert.rejects(() => publisher.push(progress(10)), AssistPreviewOwnershipLostError);
  assert.deepEqual(lost, ['lost']);
  await publisher.push(progress(20));
});

test('split surrogate is published as one character and later chunks are coalesced', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const writes: string[] = [];
    const preview = new AssistLivePreviewPublisher(async (text) => {
      writes.push(text);
      return true;
    }, () => assert.fail('owner should remain current'));
    await preview.push('\uD83D');
    assert.equal(writes.length, 0);
    await preview.push('\uDE42');
    assert.deepEqual(writes, ['🙂']);
    await preview.push('后续');
    assert.deepEqual(writes, ['🙂']);
    now += 100;
    await preview.push('片段');
    assert.deepEqual(writes, ['🙂', '🙂后续片段']);
  } finally { Date.now = originalNow; }
});
