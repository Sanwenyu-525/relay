import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test, { mock } from 'node:test';
import { Client } from 'pg';

import { parseDatabaseConnectFenceArguments } from '../../src/cli/database-connect-fence.js';
import { CliConfigError } from '../../src/cli/cli-support.js';
import { decodeDatabaseFenceJournal, DatabaseConnectFenceError, holdDatabaseConnectFence,
  recoverDatabaseConnectFence } from '../../src/runtime/database-connect-fence.js';

const record = {
  version: 'relay-database-connect-fence-v1', operation_id: 'ad295fc7-8ea0-4d82-9c42-3ed877fa07bd',
  target: { database: 'relay_test', database_oid: '100', owner_oid: '10', app_oid: '11',
    server_address: '127.0.0.1', server_port: '5432' },
  original_acl: [
    { grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false },
    { grantee: '0', grantor: '10', privilege: 'CONNECT', grantable: false },
    { grantee: '11', grantor: '10', privilege: 'CONNECT', grantable: true },
  ],
  fenced_acl: [{ grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false }],
};
function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify({ record: value,
    sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }));
}
const invalid = (cause: unknown) => cause instanceof DatabaseConnectFenceError && cause.code === 'DATABASE_FENCE_JOURNAL_INVALID';

test('database fence CLI accepts only its two fixed actions and one absolute journal file', () => {
  const file = resolve('journal.json');
  for (const action of ['hold-database-connect-fence', 'recover-database-connect-fence'] as const) {
    assert.deepEqual(parseDatabaseConnectFenceArguments([action, '--journal-file', file]), { action, journalFile: file });
  }
  for (const argv of [[], ['freeze'], ['hold-database-connect-fence', '--journal-file', 'relative.json'],
    ['hold-database-connect-fence', '--journal-file', file, '--force'],
    ['recover-database-connect-fence', '--journal-file', file, '--journal-file', file]]) {
    assert.throws(() => parseDatabaseConnectFenceArguments(argv), CliConfigError);
  }
});

test('recovery evidence preserves CONNECT grant option and rejects altered bytes', () => {
  assert.deepEqual(decodeDatabaseFenceJournal(encode(record)), record);
  const corrupt = encode(record).toString().replace('relay_test', 'other_test');
  assert.throws(() => decodeDatabaseFenceJournal(Buffer.from(corrupt)), invalid);
  assert.throws(() => decodeDatabaseFenceJournal(Buffer.alloc(64 * 1024 + 1)), invalid);
  assert.throws(() => decodeDatabaseFenceJournal(Buffer.from('{}')), invalid);
});

test('recovery rejects a rehashed unsupported ACL or a fabricated fenced result', () => {
  for (const value of [
    { ...record, original_acl: [...record.original_acl, { grantee: '15', grantor: '10', privilege: 'CONNECT', grantable: false }] },
    { ...record, original_acl: [...record.original_acl, record.original_acl[0]] },
    { ...record, fenced_acl: record.original_acl },
    { ...record, original_acl: record.original_acl.map(g => g.grantee === '0' ? { ...g, grantable: true } : g) },
  ]) assert.throws(() => decodeDatabaseFenceJournal(encode(value)), invalid);
});

test('recovery evidence has no credential fields and requires exact target identity', () => {
  for (const value of [
    { ...record, connection_url: 'should never be accepted' },
    { ...record, target: { ...record.target, password: 'should never be accepted' } },
    { ...record, target: { ...record.target, database_oid: '0' } },
    { ...record, target: { ...record.target, server_port: '-1' } },
    { ...record, operation_id: 'not-a-uuid' },
  ]) assert.throws(() => decodeDatabaseFenceJournal(encode(value)), invalid);
});

test('hold and recovery reject malformed explicit URLs with safe errors before any connection', async () => {
  const connect = mock.method(Client.prototype, 'connect', async () => { throw new Error('must not connect'); });
  try {
    for (const url of ['not-a-url', 'postgresql://127.0.0.1/target',
      'postgresql://relay_migrator@127.0.0.1', 'postgresql://relay_migrator:private@127.0.0.1:65536/target']) {
      for (const action of [holdDatabaseConnectFence, recoverDatabaseConnectFence]) {
        await assert.rejects(() => action(url, resolve('must-not-be-read.json')), (cause: unknown) =>
          cause instanceof DatabaseConnectFenceError && cause.code === 'DATABASE_FENCE_UNAVAILABLE' &&
          cause.message === cause.code);
      }
    }
    assert.equal(connect.mock.callCount(), 0);
  } finally { connect.mock.restore(); }
});
