import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import { Client } from 'pg';
import { assertBackupContentReferences, assertBackupWritersStopped, backupStateSha256,
  BackupStateError, readBackupDatabaseState, type BackupDatabaseState } from '../../src/runtime/backup-state.js';
import { managedContentRef } from '../../src/storage/managed-content-store.js';
import { parseBackupArguments } from '../../src/cli/backup.js';
import { exportFirstPartyRegistryArchive } from '../../src/skills/first-party-registry.js';

const state = (changes: Partial<BackupDatabaseState> = {}): BackupDatabaseState => ({ target: {},
  admission: { mode: 'DRAINING', revision: '1' }, migrations: [], graph_versions: [], artifacts: [], workers: [],
  unresolved_effects: [], unresolved_operations: [], unresolved_invocations: [], unresolved_model_calls: [],
  external_resources: [], stored_skills: [], stored_packs: [], ...changes });

test('retained writers require an exact original desktop launch stop proof, regardless of lease', () => {
  const launchId = randomUUID(), workerId = randomUUID();
  const stopped = [{ launchId, stopEvidence: 'armed_job_terminated_and_active_count_zero' as const }];
  const row = { worker_id: `worker:desktop:${launchId}:${workerId}`, kind: 'RESOURCE', status: 'QUARANTINED', epoch: '3' };
  assertBackupWritersStopped(state({ workers: [row] }), stopped);
  for (const worker_id of [null, `worker:${workerId}`, `worker:desktop:${randomUUID()}:${workerId}`,
    `worker:desktop:${launchId}:${'-'.repeat(36)}`]) {
    assert.throws(() => assertBackupWritersStopped(state({ workers: [{ ...row, worker_id }] }), stopped),
      (e: unknown) => e instanceof BackupStateError && e.code === 'BACKUP_WRITER_NOT_STOPPED');
  }
});

test('artifact references bind exact copied bytes and location while keeping unreferenced content', () => {
  const id = randomUUID(), artifact_id = randomUUID(), storage_ref = managedContentRef(artifact_id, id);
  const ref = { id, artifact_id, storage_ref, sha256: 'a'.repeat(64), size: '7' };
  const file = { kind: 'CONTENT' as const, source_ref: storage_ref, backup_ref: `data/${storage_ref}`,
    sha256: ref.sha256, size: ref.size };
  assertBackupContentReferences(state({ artifacts: [ref] }), [file, { ...file, source_ref: 'orphan' }]);
  for (const files of [[], [{ ...file, sha256: 'b'.repeat(64) }], [{ ...file, size: '8' }],
    [{ ...file, backup_ref: `evidence/${storage_ref}` }]]) {
    assert.throws(() => assertBackupContentReferences(state({ artifacts: [ref] }), files),
      (e: unknown) => e instanceof BackupStateError && e.code === 'BACKUP_CONTENT_MISMATCH');
  }
});

test('state identity is key-order independent and changes when an unresolved original identity changes', () => {
  assert.equal(backupStateSha256({ b: 2, a: 1 }), backupStateSha256({ a: 1, b: 2 }));
  assert.notEqual(backupStateSha256(state({ unresolved_effects: [{ operation_id: 'original', status: 'UNKNOWN' }] })),
    backupStateSha256(state({ unresolved_effects: [{ operation_id: 'replacement', status: 'UNKNOWN' }] })));
});

test('backup CLI rejects duplicate, missing, unknown and relative inputs and never takes credentials as flags', () => {
  const argv = ['create-backup', '--package-root', 'D:/package', '--data-root', 'D:/data',
    '--backup-root', 'D:/backup', '--postgres-bin', 'D:/pg/bin'];
  assert.equal(parseBackupArguments(argv).backupRoot, 'D:/backup');
  for (const bad of [argv.slice(0, -2), [...argv, '--url', 'private'],
    argv.map(v => v === '--data-root' ? '--package-root' : v),
    argv.map(v => v === 'D:/backup' ? './backup' : v), argv.map(v => v === '--postgres-bin' ? '--url' : v)]) {
    assert.throws(() => parseBackupArguments(bad));
  }
});

test('controlled state reader ignores unrelated PG environment before any actual connection', async () => {
  const environment = { PGHOST: 'private.invalid', PGPORT: '15432', PGUSER: 'relay_app', PGDATABASE: 'other',
    PGPASSWORD: 'synthetic-unrelated-password', PGSSLMODE: 'require', PGOPTIONS: '-c search_path=other' };
  const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let observed = false, checked = false;
  const hook = mock.method(Client.prototype, 'connect', async function (this: Client) {
    observed = true;
    const params = (this as Client & { connectionParameters: {
      host: string; port: number; user: string; database: string; password: () => Promise<string>; ssl: boolean; options: string;
    } }).connectionParameters;
    assert.equal(params.host, '127.0.0.1'); assert.equal(params.port, 5432);
    assert.equal(params.user, 'relay_migrator'); assert.equal(params.database, 'selected');
    assert.equal(params.ssl, false); assert.equal(params.options, '-c default_transaction_read_only=on');
    assert.equal(typeof params.password, 'function'); assert.equal(await params.password(), '');
    checked = true;
    throw new Error('deliberate stop before network');
  });
  try {
    Object.assign(process.env, environment);
    await assert.rejects(readBackupDatabaseState({ migrationUrl: 'postgresql://relay_migrator@127.0.0.1/selected',
      registry: exportFirstPartyRegistryArchive(), resourceHashes: {}, signal: new AbortController().signal, assertHeld: async () => {} }),
      cause => cause instanceof BackupStateError && cause.code === 'BACKUP_STATE_UNAVAILABLE');
    assert.equal(observed, true);
    // The reader normalizes safe failures; a swallowed assertion must not make this check pass.
    assert.equal(checked, true);
  } finally {
    hook.mock.restore();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
