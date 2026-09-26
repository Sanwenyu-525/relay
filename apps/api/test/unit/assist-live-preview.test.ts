import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistLivePreviewPublisher } from '../../src/assist/live-preview.js';

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
