import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Socket } from 'node:net';

import { WebSocketConnection } from '../../src/browser/websocket.js';

function clientFrame(opcode: number, payload: Buffer, final = true): Buffer {
  assert.ok(payload.length < 126);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([(final ? 0x80 : 0) | opcode, 0x80 | payload.length]),
    mask, Buffer.from(payload.map((value, index) => value ^ mask[index % 4]!))]);
}

class TestSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  write(data: Buffer): boolean { this.writes.push(data); return true; }
  end(): void { this.emit('end'); }
}

test('fragmented UTF-8 text is reassembled once across TCP chunks and interleaved ping', () => {
  const socket = new TestSocket();
  const connection = new WebSocketConnection(socket as unknown as Socket);
  const messages: string[] = [];
  connection.on('message', (value) => messages.push(String(value)));
  const body = Buffer.from('截图分片结果');
  const first = clientFrame(1, body.subarray(0, 2), false);
  socket.emit('data', first.subarray(0, 3));
  assert.deepEqual(messages, []);
  socket.emit('data', Buffer.concat([first.subarray(3), clientFrame(9, Buffer.alloc(0)),
    clientFrame(0, body.subarray(2, 5), false)]));
  assert.deepEqual(messages, []);
  socket.emit('data', clientFrame(0, body.subarray(5)));
  assert.deepEqual(messages, ['截图分片结果']);
  assert.equal(socket.writes.some((frame) => frame[0] === 0x88), false);
});

test('unexpected continuation and a second data message during fragmentation close with 1002', () => {
  for (const invalid of [clientFrame(0, Buffer.from('orphan')),
    Buffer.concat([clientFrame(1, Buffer.from('first'), false), clientFrame(1, Buffer.from('second'))])]) {
    const socket = new TestSocket();
    const connection = new WebSocketConnection(socket as unknown as Socket);
    const messages: string[] = [];
    connection.on('message', (value) => messages.push(String(value)));
    socket.emit('data', invalid);
    const closed = socket.writes.find((frame) => frame[0] === 0x88);
    assert.ok(closed);
    assert.equal(closed.readUInt16BE(2), 1002);
    assert.deepEqual(messages, []);
  }
});
