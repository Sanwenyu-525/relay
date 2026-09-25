import assert from 'node:assert/strict';
import test from 'node:test';

import { toDecimalString } from '../../src/shared/decimal.js';
import {
  CANONICALIZATION_VERSION,
  PAYLOAD_HASH_ALGORITHM,
  PayloadCanonicalizationError,
  canonicalizeJson,
  computePayloadHash,
  payloadHashHex,
} from '../../src/receipt/payload-hash.js';

test('canonical JSON sorts keys and keeps array order', () => {
  assert.equal(
    canonicalizeJson({ b: [1, true, null], a: 'x' }),
    '{"a":"x","b":[1,true,null]}',
  );
  assert.equal(canonicalizeJson({ a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1}}');
  assert.equal(canonicalizeJson([2, 1]), '[2,1]');
});

test('payload hash ignores key order but not array order or command type', () => {
  const first = computePayloadHash({
    commandType: 'CreateTask',
    target: { task_id: 't1' },
    body: { title: 'a', criteria: ['c1', 'c2'] },
  });
  const reordered = computePayloadHash({
    commandType: 'CreateTask',
    target: { task_id: 't1' },
    body: { criteria: ['c1', 'c2'], title: 'a' },
  });
  const differentArrayOrder = computePayloadHash({
    commandType: 'CreateTask',
    target: { task_id: 't1' },
    body: { criteria: ['c2', 'c1'], title: 'a' },
  });
  const differentCommandType = computePayloadHash({
    commandType: 'EditTaskPresentation',
    target: { task_id: 't1' },
    body: { criteria: ['c1', 'c2'], title: 'a' },
  });

  assert.deepEqual(first, reordered);
  assert.notDeepEqual(first, differentArrayOrder);
  assert.notDeepEqual(first, differentCommandType);
  assert.equal(payloadHashHex(first).length, 64);
  assert.equal(PAYLOAD_HASH_ALGORITHM, 'sha256');
  assert.equal(CANONICALIZATION_VERSION, 'relay-canonical-json-v1');
});

test('canonical JSON rejects values that cannot be encoded deterministically', () => {
  assert.throws(() => canonicalizeJson(Number.NaN), PayloadCanonicalizationError);
  assert.throws(() => canonicalizeJson(Number.POSITIVE_INFINITY), PayloadCanonicalizationError);
  assert.throws(
    () => canonicalizeJson(9007199254740993),
    PayloadCanonicalizationError,
  );
  assert.throws(
    () => canonicalizeJson({ a: undefined as never }),
    PayloadCanonicalizationError,
  );
  assert.throws(
    () => canonicalizeJson(new Date(0) as never),
    PayloadCanonicalizationError,
  );
  assert.throws(() => canonicalizeJson(1n as never), PayloadCanonicalizationError);
});

test('decimal strings keep bigint values exact', () => {
  assert.equal(toDecimalString(0n), '0');
  assert.equal(toDecimalString(9007199254740993n), '9007199254740993');
  // 经过 number 会丢精度：BigInt(Number(x)) 已经不再是 x，证明应用层不能先转 number。
  assert.equal(Number(9007199254740993n), 9007199254740992);
  assert.notEqual(BigInt(Number(9007199254740993n)), 9007199254740993n);
});