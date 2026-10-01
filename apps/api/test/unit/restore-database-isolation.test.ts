import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { decodeDatabaseFenceJournal, DatabaseConnectFenceError } from '../../src/runtime/database-connect-fence.js';
import { decodeRestoreDatabaseIsolationJournal, holdRestoreDatabaseIsolation,
  RestoreDatabaseIsolationError } from '../../src/runtime/restore-database-isolation.js';

const source = { database: 'relay_source', database_oid: '101', owner_oid: '10',
  server_address: '127.0.0.1', server_port: '5432' };
const record = { version: 'relay-restore-database-isolation-v1', purpose: 'RESTORE_TARGET_KEEP_ISOLATED',
  operation_id: 'ad295fc7-8ea0-4d82-9c42-3ed877fa07bd', source_target: source,
  target: { ...source, database: 'relay_target', database_oid: '102', app_oid: '11' },
  original_acl: [
    { grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false },
    { grantee: '0', grantor: '10', privilege: 'CONNECT', grantable: false },
    { grantee: '11', grantor: '10', privilege: 'CONNECT', grantable: true },
  ],
  fenced_acl: [{ grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false }],
};
const encode = (value: unknown) => Buffer.from(JSON.stringify({ record: value,
  sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }));
const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreDatabaseIsolationError &&
  cause.code === code && cause.message === code;

test('restore evidence binds caller operation, source, target and complete effective ACL without activating recovery', () => {
  assert.deepEqual(decodeRestoreDatabaseIsolationJournal(encode(record)), record);
  assert.throws(() => decodeDatabaseFenceJournal(encode(record)), (cause: unknown) =>
    cause instanceof DatabaseConnectFenceError && cause.code === 'DATABASE_FENCE_JOURNAL_INVALID');
});

test('restore evidence rejects wrong purpose, foreign ACLs, corruption, credentials and oversized records', () => {
  for (const value of [
    { ...record, version: 'relay-database-connect-fence-v1' },
    { ...record, purpose: 'RESTORE_AND_RESUME' },
    { ...record, operation_id: 'not-an-operation-id' },
    { ...record, connection_url: 'never retain credentials' },
    { ...record, source_target: { ...source, password: 'never retain credentials' } },
    { ...record, original_acl: [...record.original_acl, { grantee: '12', grantor: '10', privilege: 'CONNECT', grantable: false }] },
    { ...record, fenced_acl: record.original_acl },
  ]) assert.throws(() => decodeRestoreDatabaseIsolationJournal(encode(value)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
  const corrupted = JSON.parse(encode(record).toString()) as { sha256: string };
  corrupted.sha256 = '0'.repeat(64);
  assert.throws(() => decodeRestoreDatabaseIsolationJournal(Buffer.from(JSON.stringify(corrupted))), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
  assert.throws(() => decodeRestoreDatabaseIsolationJournal(Buffer.alloc(65537)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
});

test('source physical identity is refused even through a different loopback address or renamed metadata', () => {
  for (const address of ['127.0.0.1', '::1']) {
    assert.throws(() => decodeRestoreDatabaseIsolationJournal(encode({ ...record,
      target: { ...record.target, database_oid: source.database_oid, server_address: address } })),
    refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
  }
});

test('the existing PostgreSQL inet-to-text CIDR representation is preserved in source and target evidence', () => {
  for (const address of ['127.0.0.1/32', '::1/128']) {
    const value = { ...record, source_target: { ...source, server_address: address },
      target: { ...record.target, server_address: address } };
    assert.deepEqual(decodeRestoreDatabaseIsolationJournal(encode(value)), value);
  }
});

test('pre-aborted isolation refuses before connection or journal IO', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => holdRestoreDatabaseIsolation({ operationId: record.operation_id,
    migrationUrl: 'must never be parsed or connected', journalFile: 'must never be opened',
    sourceTarget: source, signal: controller.signal }), refusal('RESTORE_DATABASE_ABORTED'));
});

test('malformed operation/source and non-local or wrong-role URLs fail with fixed input errors', async () => {
  const input = { operationId: record.operation_id, migrationUrl: 'postgresql://relay_migrator:secret@127.0.0.1/target',
    journalFile: 'not-accessed.json', sourceTarget: { ...source, server_version_num: '180006' } };
  for (const value of [
    { ...input, operationId: 'old-operation' },
    { ...input, sourceTarget: { ...source, database_oid: '0' } },
    { ...input, sourceTarget: { ...source, server_port: '65536' } },
    { ...input, migrationUrl: 'postgresql://relay_app:secret@127.0.0.1/target' },
    { ...input, migrationUrl: 'postgresql://relay_migrator:secret@remote.invalid/target' },
    { ...input, migrationUrl: input.migrationUrl + '?options=arbitrary' },
  ]) await assert.rejects(() => holdRestoreDatabaseIsolation(value), refusal('RESTORE_DATABASE_INVALID_INPUT'));
});
