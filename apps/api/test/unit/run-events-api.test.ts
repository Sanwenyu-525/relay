import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test from 'node:test';

import { runEventCursor, writeRunEventFrame } from '../../src/api/run-events-api.js';

class ControlledResponse extends EventEmitter {
  destroyed = false;
  acceptsWrite = false;
  readonly frames: string[] = [];

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.acceptsWrite;
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

test('Run cursor accepts canonical signed-int64 values and query takes precedence', () => {
  assert.equal(runEventCursor({}, undefined), 0n);
  assert.equal(runEventCursor({ after: '9223372036854775807' }, 'broken'), 9223372036854775807n);
  assert.equal(runEventCursor({}, '12'), 12n);
  for (const value of ['-1', '01', '1.0', '9223372036854775808', '']) {
    assert.throws(() => runEventCursor({ after: value }, undefined), /VALIDATION_FAILED/u);
  }
});

test('Run event writer waits for drain after an explicit false write', async () => {
  const response = new ControlledResponse();
  const controller = new AbortController();
  const pending = writeRunEventFrame(response.asServerResponse(), 'id: 1\n\n', controller.signal);
  assert.deepEqual(response.frames, ['id: 1\n\n']);
  response.emit('drain');
  assert.equal(await pending, true);
});

test('Run event writer stops waiting when a slow client aborts', async () => {
  const response = new ControlledResponse();
  const controller = new AbortController();
  const pending = writeRunEventFrame(response.asServerResponse(), 'id: 1\n\n', controller.signal);
  controller.abort();
  assert.equal(await pending, false);
});

test('Run event writer closes a permanently backpressured frame after its bound', async () => {
  const response = new ControlledResponse();
  const started = Date.now();
  const written = await writeRunEventFrame(response.asServerResponse(), 'id: 1\n\n',
    new AbortController().signal);
  assert.equal(written, false);
  assert.ok(Date.now() - started >= 4900);
});
