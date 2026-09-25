import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { desktopDispatchReadyLine, desktopLaunchRecoveryAckLine } from
  '../../src/worker/desktop-supervisor-protocol.js';

const RUST_SUPERVISOR_LINE_LIMIT = 64 * 1024;

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function frame(requeuedRunIds: readonly string[], blockedRunIds: readonly string[]): {
  line: string; event: Record<string, unknown>;
} {
  const line = desktopDispatchReadyLine({ nonce: randomUUID(), launchId: randomUUID(),
    requeuedRunIds, blockedRunIds });
  assert.ok(line.endsWith('\n'));
  return { line, event: JSON.parse(line) as Record<string, unknown> };
}

test('small desktop dispatch readiness preserves Rust Vec fields and complete counts', () => {
  const { line, event } = frame([runId(1)], [runId(2)]);
  assert.ok(Buffer.byteLength(line, 'utf8') < RUST_SUPERVISOR_LINE_LIMIT);
  assert.equal(event.type, 'dispatch_ready');
  assert.deepEqual(event.requeuedRunIds, [runId(1)]);
  assert.deepEqual(event.blockedRunIds, [runId(2)]);
  assert.equal(event.requeuedRunCount, 1);
  assert.equal(event.blockedRunCount, 1);
  assert.equal(event.runIdsTruncated, false);
});

test('1677 blocked Run IDs cannot exceed the Rust stdout line limit', () => {
  const blocked = Array.from({ length: 1677 }, (_, index) => runId(index));
  const { line, event } = frame([], blocked);
  assert.ok(Buffer.byteLength(line, 'utf8') < RUST_SUPERVISOR_LINE_LIMIT);
  assert.deepEqual(event.requeuedRunIds, []);
  assert.equal(event.blockedRunCount, blocked.length);
  assert.equal(event.runIdsTruncated, true);
  assert.ok(Array.isArray(event.blockedRunIds));
  assert.ok((event.blockedRunIds as unknown[]).length < blocked.length);
  assert.equal((event.blockedRunIds as string[])[0], blocked[0]);
});

test('4096 recovered launches can report both outcomes without losing total counts', () => {
  const requeued = Array.from({ length: 4096 }, (_, index) => runId(index));
  const blocked = Array.from({ length: 4096 }, (_, index) => runId(index + 4096));
  const { line, event } = frame(requeued, blocked);
  assert.ok(Buffer.byteLength(line, 'utf8') < RUST_SUPERVISOR_LINE_LIMIT);
  assert.equal(event.requeuedRunCount, requeued.length);
  assert.equal(event.blockedRunCount, blocked.length);
  assert.equal(event.runIdsTruncated, true);
  assert.ok(Array.isArray(event.requeuedRunIds));
  assert.ok(Array.isArray(event.blockedRunIds));
  assert.equal((event.requeuedRunIds as string[])[0], requeued[0]);
  assert.equal((event.blockedRunIds as string[])[0], blocked[0]);
  assert.ok((event.requeuedRunIds as unknown[]).length < requeued.length);
  assert.ok((event.blockedRunIds as unknown[]).length < blocked.length);
});

test('line bound is checked in UTF-8 bytes after JSON encoding', () => {
  const syntheticIds = Array.from({ length: 80 }, (_, index) =>
    `${runId(index)}-${'文'.repeat(300)}`);
  const { line, event } = frame(syntheticIds, []);
  assert.ok(Buffer.byteLength(line, 'utf8') < RUST_SUPERVISOR_LINE_LIMIT);
  assert.equal(event.requeuedRunCount, syntheticIds.length);
  assert.equal(event.runIdsTruncated, true);
  assert.ok((event.requeuedRunIds as unknown[]).length < syntheticIds.length);
});

test('launch recovery acknowledgement keeps a bounded exact JSON count', () => {
  for (const retainedClaims of [0n, 1n, BigInt(Number.MAX_SAFE_INTEGER)]) {
    const nonce = randomUUID();
    const launchId = randomUUID();
    const line = desktopLaunchRecoveryAckLine({ nonce, launchId, retainedClaims });
    assert.ok(Buffer.byteLength(line, 'utf8') < RUST_SUPERVISOR_LINE_LIMIT);
    assert.deepEqual(JSON.parse(line), { type: 'launch_recovery_ack', nonce, launchId,
      retainedClaims: Number(retainedClaims) });
  }
  const base = { nonce: randomUUID(), launchId: randomUUID() };
  assert.throws(() => desktopLaunchRecoveryAckLine({ ...base, retainedClaims: -1n }), /safe JSON integer/u);
  assert.throws(() => desktopLaunchRecoveryAckLine({ ...base,
    retainedClaims: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), /safe JSON integer/u);
  assert.throws(() => desktopLaunchRecoveryAckLine({ ...base,
    retainedClaims: 1 as unknown as bigint }), /safe JSON integer/u);
});
