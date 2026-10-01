import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { readMaintenanceReleaseInput } from '../../src/runtime/maintenance-release-input.js';

test('release input cannot accept a first line and silently ignore oversized or extra trailing input', async () => {
  for (const chunk of ['release\n' + 'x'.repeat(300), 'release\ninvalid\n', 'release\nrelease\n']) {
    const stream = new PassThrough();
    const reader = readMaintenanceReleaseInput(stream);
    stream.write(chunk);
    await assert.rejects(async () => { await reader.requested; reader.assertValid(); });
    reader.dispose();
  }
});

test('later invalid input remains visible after the release promise has resolved', async () => {
  const stream = new PassThrough();
  const reader = readMaintenanceReleaseInput(stream);
  stream.write('release\n');
  await reader.requested;
  stream.write('invalid\n');
  assert.throws(() => reader.assertValid());
  reader.dispose();
});

test('split LF or CRLF release and clean EOF are accepted without retaining listeners', async () => {
  for (const ending of ['\n', '\r\n']) {
    const stream = new PassThrough();
    const reader = readMaintenanceReleaseInput(stream);
    stream.write('rel'); stream.write('ease' + ending);
    await reader.requested;
    reader.assertValid(); reader.dispose();
    assert.equal(stream.listenerCount('data'), 0);
  }
  const stream = new PassThrough();
  const reader = readMaintenanceReleaseInput(stream);
  stream.end();
  await reader.requested;
  reader.assertValid(); reader.dispose();
});
