import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './pi.mjs';

test('real Pi loop invokes exactly one registered tool and two model calls', async () => {
  const result = await run();
  assert.equal(result.effects, 1);
  assert.equal(result.calls, 2);
});
test('policy denies and terminates before effect', async () => {
  const result = await run({ denied: true });
  assert.equal(result.effects, 0);
  assert.equal(result.calls, 1);
});
test('UNKNOWN terminates the loop without a second model retry', async () => {
  const result = await run({ unknown: true });
  assert.equal(result.effects, 1);
  assert.equal(result.calls, 1);
});
test('unregistered shell tool is never executed', async () => {
  const result = await run({ toolName: 'shell' });
  assert.equal(result.effects, 0);
  assert.ok(result.messages.some(m => m.role === 'toolResult' && m.isError));
});
test('invalid arguments are rejected before effect', async () => {
  assert.equal((await run({ toolArgs: {} })).effects, 0);
});
test('cancellation reaches delayed fake provider and prevents tool effect', async () => {
  const controller = new AbortController();
  const pending = run({ delay: 10, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).effects, 0);
});
