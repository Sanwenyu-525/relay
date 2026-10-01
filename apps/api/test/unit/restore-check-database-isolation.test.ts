import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { holdRestoredDatabaseIsolation, RestoreDatabaseIsolationError } from '../../src/runtime/restore-database-isolation.js';

const target = { database: 'relay_target', database_oid: '102', owner_oid: '10', app_oid: '11',
  server_address: '127.0.0.1', server_port: '5432' };
const operationId = 'ad295fc7-8ea0-4d82-9c42-3ed877fa07bd';
const record = { version: 'relay-restore-database-isolation-v1', purpose: 'RESTORE_TARGET_KEEP_ISOLATED',
  operation_id: operationId, source_target: { database: 'relay_source', database_oid: '101', owner_oid: '10',
    server_address: '127.0.0.1', server_port: '5432' }, target,
  original_acl: [{ grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false },
    { grantee: '0', grantor: '10', privilege: 'CONNECT', grantable: false }],
  fenced_acl: [{ grantee: '10', grantor: '10', privilege: 'CONNECT', grantable: false }],
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify({ record: value,
  sha256: sha256(Buffer.from(JSON.stringify(value))) }));
const refusal = (code: string) => (cause: unknown) => cause instanceof RestoreDatabaseIsolationError &&
  cause.code === code && cause.message === code;
const input = (journalFile: string, bytes: Buffer) => ({ migrationUrl: 'postgresql://relay_migrator:private@127.0.0.1:1/target',
  journalFile, operationId, expectedTarget: target, expectedJournalSha256: sha256(bytes), expectedAdmissionRevision: '1' });
async function fixture(work: (path: string, bytes: Buffer) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'relay-restore-check-isolation-unit-'));
  const path = join(root, 'target-acl.json'), bytes = encode(record);
  try { await writeFile(path, bytes); await work(path, bytes); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('pre-aborted rehold refuses before URL parsing or local file IO', async () => {
  const controller = new AbortController(); controller.abort(new Error('private reason'));
  await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input('never opened', Buffer.alloc(0)),
    migrationUrl: 'never parsed', signal: controller.signal }), refusal('RESTORE_DATABASE_ABORTED'));
});

test('rehold rejects malformed expected bindings and unsupported connection URL options', async () => {
  for (const value of [
    { ...input('never opened', Buffer.alloc(0)), operationId: 'invalid' },
    { ...input('never opened', Buffer.alloc(0)), expectedJournalSha256: 'A'.repeat(64) },
    { ...input('never opened', Buffer.alloc(0)), expectedAdmissionRevision: '01' },
    { ...input('never opened', Buffer.alloc(0)), expectedTarget: { ...target, app_oid: '0' } },
    { ...input('never opened', Buffer.alloc(0)), expectedTarget: { ...target, server_port: '65536' } },
    { ...input('never opened', Buffer.alloc(0)), migrationUrl: 'postgresql://relay_app:private@127.0.0.1/target' },
    { ...input('never opened', Buffer.alloc(0)), migrationUrl: 'postgresql://relay_migrator:private@127.0.0.1/target?options=private' },
  ]) await assert.rejects(() => holdRestoredDatabaseIsolation(value), refusal('RESTORE_DATABASE_INVALID_INPUT'));
});

test('raw journal hash, operation and all six target fields are bound before connection', async () => {
  await fixture(async (path, bytes) => {
    await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(path, bytes), expectedJournalSha256: '0'.repeat(64) }),
      refusal('RESTORE_DATABASE_JOURNAL_CHANGED'));
    await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(path, bytes), operationId: 'e276fc7e-8ea0-4d82-9c42-3ed877fa07bd' }),
      refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
    for (const expectedTarget of [{ ...target, database: 'different' }, { ...target, database_oid: '103' },
      { ...target, owner_oid: '12' }, { ...target, app_oid: '12' }, { ...target, server_address: '::1' },
      { ...target, server_port: '5433' }]) {
      await assert.rejects(() => holdRestoredDatabaseIsolation({ ...input(path, bytes), expectedTarget }),
        refusal('RESTORE_DATABASE_TARGET_MISMATCH'));
    }
    assert.deepEqual(await readFile(path), bytes);
  });
});

test('invalid UTF8 cannot be silently repaired into a correctly hashed journal string', async () => {
  await fixture(async (path) => {
    const value = { ...record, target: { ...target, database: 'replacement\ufffdname' } };
    const bytes = encode(value), marker = Buffer.from('\ufffd');
    const offset = bytes.indexOf(marker); assert.ok(offset > 0);
    const invalid = Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xff]), bytes.subarray(offset + marker.length)]);
    await writeFile(path, invalid);
    await assert.rejects(() => holdRestoredDatabaseIsolation(input(path, invalid)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
    assert.deepEqual(await readFile(path), invalid);
  });
});

test('missing, relative and multiply linked local journals refuse without creating or changing files', async () => {
  await fixture(async (path, bytes) => {
    await assert.rejects(() => holdRestoredDatabaseIsolation(input('relative.json', bytes)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
    await assert.rejects(() => holdRestoredDatabaseIsolation(input(path + '.missing', bytes)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
    await link(path, path + '.hardlink');
    await assert.rejects(() => holdRestoredDatabaseIsolation(input(path, bytes)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
    assert.deepEqual(await readFile(path), bytes);
  });
});

test('oversized and corrupt journals refuse before the target connection is attempted', async () => {
  await fixture(async (path) => {
    for (const bytes of [Buffer.alloc(65537), Buffer.from('{"private":"invalid journal"}')]) {
      await writeFile(path, bytes);
      await assert.rejects(() => holdRestoredDatabaseIsolation(input(path, bytes)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
      assert.deepEqual(await readFile(path), bytes);
    }
  });
});

test('a real directory alias and Windows alternate stream cannot substitute local journal evidence', async () => {
  await fixture(async (path, bytes) => {
    const alias = join(dirname(path), 'linked-parent');
    await symlink(dirname(path), alias, process.platform === 'win32' ? 'junction' : 'dir');
    try { await assert.rejects(() => holdRestoredDatabaseIsolation(input(join(alias, 'target-acl.json'), bytes)),
      refusal('RESTORE_DATABASE_JOURNAL_INVALID')); }
    finally { await rm(alias); }
    if (process.platform === 'win32') {
      await writeFile(path + ':private-stream', 'retained metadata evidence');
      await assert.rejects(() => holdRestoredDatabaseIsolation(input(path, bytes)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
      await assert.rejects(() => holdRestoredDatabaseIsolation(input(path + ':private-stream', bytes)), refusal('RESTORE_DATABASE_JOURNAL_INVALID'));
    }
    assert.deepEqual(await readFile(path), bytes);
  });
});
