import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { before, after, beforeEach, afterEach, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { sql } from 'kysely';

import { createArtifactWithVersion } from '../../src/application/artifact-commands.js';
import { createProject } from '../../src/application/create-project.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep, SimulatedWorkerCrash } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { changeAdmission, readAdmissionStatus } from '../../src/application/runtime-maintenance.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { createBackup, BackupError } from '../../src/runtime/backup.js';
import { postgresBackupEnvironment } from '../../src/runtime/backup-postgres.js';
import { openDesktopMaintenanceSession } from '../../src/runtime/desktop-maintenance-session.js';
import { recoverDatabaseConnectFence } from '../../src/runtime/database-connect-fence.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createWorkspace } from './api-harness.js';
import { ADMIN_DATABASE_URL, createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase, type TemporaryDatabase } from './integration-support.js';

const workspace = resolve(MIGRATIONS_DIRECTORY, '../../..');
const postgresBin = join(workspace, '.research/runtime-cache/postgresql-18.6-2/pgsql/bin');
const desktopExe = join(workspace, 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/relay-desktop.exe');
const rustProbe = join(workspace, 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/deps/relay_desktop-32fc57221e376524.exe');
const runFile = promisify(execFile);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let root: string, packageRoot: string, dataRoot: string, backupRoot: string;
let database: TemporaryDatabase;
const owned = new Set<ChildProcess>();

before(async () => {
  assert.equal(process.platform, 'win32', 'this suite requires actual Windows native owners');
  root = await mkdtemp(join(tmpdir(), 'relay-backup-composition-'));
  packageRoot = join(root, 'package');
  const files: Record<string, Buffer | string> = {
    'relay-desktop.exe': await readFile(desktopExe), 'node.exe': await readFile(process.execPath),
    'relay-file-io-helper.exe': await readFile(process.env.RELAY_FILE_IO_HELPER!),
    'licenses/OFL.txt': 'composition fixture only', 'api/package.json': '{"type":"module"}',
    'api/dist/src/main.js': '', 'api/dist/src/worker/main.js': '', 'api/dist/src/worker/supervisor-main.js': '',
    'api/dist/src/runtime/database-connect-fence.js': '',
    'api/dist/src/receipt/payload-hash.js': await readFile(new URL('../../src/receipt/payload-hash.js', import.meta.url)),
    'api/dist/src/skills/first-party-registry.js': await readFile(new URL('../../src/skills/first-party-registry.js', import.meta.url)),
  };
  assert.ok((files['relay-desktop.exe'] as Buffer).includes(Buffer.from('maintenance_session_start')));
  const probeBytes = await readFile(rustProbe);
  assert.ok(probeBytes.includes(Buffer.from('job_sidecar::tests::host_crash_probe')));
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) files[`api/migrations/${name}`] = await readFile(join(MIGRATIONS_DIRECTORY, name));
  for (const [ref, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(packageRoot, ref)), { recursive: true }); await writeFile(join(packageRoot, ref), bytes);
  }
  await writeFile(join(packageRoot, 'desktop-build-manifest.json'), JSON.stringify({ schema_version: 1,
    maintenance_session_protocol: 'relay-desktop-maintenance-v1', node_version: process.version,
    artifact_sha256: hash(files['relay-desktop.exe']!), forbidden_config_files: 0,
    resource_inventory: ['dist', 'migrations', 'package.json'], resource_file_sha256: Object.fromEntries(
      Object.entries(files).filter(([ref]) => ref !== 'relay-desktop.exe').map(([ref, bytes]) => [ref, hash(bytes)])) }));
});
after(async () => {
  assert.equal(owned.size, 0, 'all owned native processes must exit before fixture deletion');
  if (root !== undefined) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); }
});
beforeEach(async () => {
  database = await createTemporaryDatabase('m07_backup_composition');
  await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(database.migrationUrl);
  dataRoot = join(root, `data-${randomUUID()}`); backupRoot = join(root, `backup-${randomUUID()}`);
  await mkdir(dataRoot);
});
afterEach(async () => { await database?.drop(); });
const input = () => ({ appUrl: database.appUrl, migrationUrl: database.migrationUrl,
  packageRoot, dataRoot, backupRoot, postgresBin, signal: new AbortController().signal });
const refused = (code: string) => (cause: unknown) => cause instanceof BackupError && cause.code === code;

async function task(status: 'READY' | 'IN_PROGRESS') {
  const app = openDatabase(database.appUrl, 'relay-backup-fixture');
  try {
    const workspaceId = await createWorkspace(app.db);
    const project = await createProject(app.db, { workspaceId, commandId: randomUUID(), title: '备份组合', projectType: 'GENERAL' });
    const taskId = randomUUID();
    await withTransaction(app.db, async r => {
      await r.tasks.insertTask({ id: taskId, workspaceId, projectId: project.result.project_id, title: '保留确切产物',
        status, mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
      await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n, objective: '保存原内容', requiredOutputSpec: {}, source: 'CREATE' });
      await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human', statement: '核对原内容', required: true, method: 'HUMAN', targetSpec: {} });
    });
    return { workspaceId, taskId };
  } finally { await app.close(); }
}
async function artifact() {
  const f = await task('IN_PROGRESS'), app = openDatabase(database.appUrl, 'relay-backup-fixture');
  try {
    return (await createArtifactWithVersion(app.db, new ManagedContentStore(dataRoot), { ...f,
      commandId: randomUUID(), expectedTaskRevision: '0', title: '原内容', mediaType: 'text/markdown', content: '# 备份\n原正文\n' })).result;
  } finally { await app.close(); }
}
async function query(url: string, statement: string) {
  const client = new Client({ connectionString: url, application_name: 'relay-backup-check', connectionTimeoutMillis: 5000 });
  client.on('error', () => {});
  try { await client.connect(); return (await client.query(statement)).rows; } finally { await client.end(); }
}
async function gate() { return (await query(database.appUrl, 'select mode from runtime_admission_gate'))[0]?.mode; }
async function noMarker() { await assert.rejects(stat(join(backupRoot, 'complete.json')), { code: 'ENOENT' }); }
async function released() {
  const session = await openDesktopMaintenanceSession({ packageRoot, dataRoot });
  await session.release(); assert.equal((await session.closed).failure, null);
}

test('complete composition stops an actual original Job, copies exact content/evidence, dumps both schemas and releases without resume', async () => {
  const saved = await artifact();
  const contentRef = `artifacts/${saved.artifact_id}/${saved.version_id}/content.md`;
  const originalContent = await readFile(join(dataRoot, contentRef));
  await mkdir(join(dataRoot, 'staging'), { recursive: true }); await writeFile(join(dataRoot, 'staging', `${randomUUID()}.part`), '原暂存');
  await new ManagedContentStore(dataRoot).publish({ artifactId: randomUUID(), versionId: randomUUID(), content: Buffer.from('保留孤儿') });
  const child = spawn(rustProbe, ['--exact', 'job_sidecar::tests::host_crash_probe', '--nocapture'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAY_JOB_PROBE_MODE: 'hold',
      RELAY_JOB_PROBE_ROOT: dataRoot, RELAY_TEST_NODE: process.execPath } });
  owned.add(child); child.stdout!.resume(); child.stderr!.resume();
  const closed = new Promise(resolve => child.once('close', result => { owned.delete(child); resolve(result); }));
  child.once('error', () => {});
  try {
    const deadline = Date.now() + 10000;
    while (!await readFile(join(dataRoot, 'probe-ready')).catch(() => null)) {
      assert.ok(Date.now() < deadline, 'actual Job probe readiness required'); await delay(30);
    }
    await unlink(join(dataRoot, 'probe-ready'));
    const armedName = (await readdir(join(dataRoot, 'runtime-launches')))[0]!;
    const armed = await readFile(join(dataRoot, 'runtime-launches', armedName));
    const dirty = { PGHOST: 'unselected.invalid', PGPORT: '15432', PGUSER: 'unselected', PGDATABASE: 'unselected',
      PGPASSWORD: 'synthetic-only', PGSSLMODE: 'require', PGOPTIONS: '-c role=unselected', PGCLIENT_ENCODING: 'LATIN1' };
    const original = Object.fromEntries(Object.keys(dirty).map(key => [key, process.env[key]]));
    let result;
    try { Object.assign(process.env, dirty); result = await createBackup(input()); }
    finally {
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    assert.equal(result.admission, 'DRAINING'); assert.equal(await gate(), 'DRAINING');
    assert.deepEqual(await readFile(join(backupRoot, 'data', contentRef)), originalContent);
    assert.deepEqual(await readFile(join(backupRoot, 'evidence/runtime-launches', armedName)), armed);
    await assert.rejects(stat(join(backupRoot, 'data/runtime-launches')), { code: 'ENOENT' });
    const manifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8'));
    const completion = JSON.parse(await readFile(join(backupRoot, 'complete.json'), 'utf8'));
    assert.equal(completion.manifest_canonical_sha256, result.manifestSha256);
    assert.equal(manifest.maintenance.stopped_launches[0].launchId, armedName.slice(0, -5));
    assert.equal(manifest.files.filter((f: {kind: string}) => f.kind === 'CONTENT').length, 2);
    assert.equal(manifest.files.filter((f: {kind: string}) => f.kind === 'STAGING').length, 1);
    const target = await createTemporaryDatabase('m07_composition_restore_probe');
    try {
      await runFile(join(postgresBin, 'pg_restore.exe'), ['--no-password', '--exit-on-error', '--dbname', target.name, join(backupRoot, 'database.dump')],
        { env: postgresBackupEnvironment(target.migrationUrl), windowsHide: true, timeout: 30000, maxBuffer: 65536 });
      assert.equal((await query(target.appUrl, 'select mode from runtime_admission_gate'))[0]?.mode, 'DRAINING');
      assert.deepEqual(await query(target.appUrl, 'select id,storage_ref,encode(content_hash,\'hex\') as hash,size::text from artifact_versions order by id'),
        await query(database.appUrl, 'select id,storage_ref,encode(content_hash,\'hex\') as hash,size::text from artifact_versions order by id'));
      assert.equal((await query(target.migrationUrl, 'select count(*)::int as count from relay_graph_v1.checkpoint_migrations'))[0]?.count, 5);
    } finally { await target.drop(); }
    await released();
  } finally {
    child.kill(); await Promise.race([closed, delay(10000).then(() => { throw new Error('own probe failed to exit'); })]);
  }
});

test('a referenced content hash mismatch refuses completion and releases owned holds while retaining DRAINING', async () => {
  const saved = await artifact();
  await writeFile(join(dataRoot, `artifacts/${saved.artifact_id}/${saved.version_id}/content.md`), '已被篡改');
  await assert.rejects(createBackup(input()), refused('BACKUP_CONTENT_MISMATCH'));
  await noMarker(); assert.equal(await gate(), 'DRAINING');
  assert.ok((await stat(join(backupRoot, 'maintenance/original-acl.json'))).isFile());
  await released();
});

test('an unrelated expired worker is refused without changing its original Run/effect or killing a process', async () => {
  const f = await task('READY'), app = openDatabase(database.appUrl, 'relay-backup-unproved-writer');
  let before;
  try {
    const run = await delegateTask(app.db, { ...f, commandId: randomUUID(), expectedTaskRevision: '0' });
    await assert.rejects(advanceRunStep(app.db, { runId: run.result.run_id, workerId: 'unproved-old-worker',
      storage: new ManagedContentStore(dataRoot), hooks: { afterClaim: async () => { throw new SimulatedWorkerCrash(); } } }), SimulatedWorkerCrash);
    await sql`update runs set worker_lease_until=clock_timestamp()-interval '1 day' where id=${run.result.run_id}`.execute(app.db);
    before = (await sql`select id,worker_id,worker_epoch,status from runs where id=${run.result.run_id}`.execute(app.db)).rows;
  } finally { await app.close(); }
  await assert.rejects(createBackup(input()), refused('BACKUP_WRITER_NOT_STOPPED'));
  await noMarker(); assert.equal(await gate(), 'DRAINING');
  const after = await query(database.appUrl, 'select id,worker_id,worker_epoch,status from runs');
  assert.deepEqual(after, before); await released();
});

test('an existing independent database connection remains alive and prevents a complete snapshot', async () => {
  const old = new Client({ connectionString: database.appUrl, application_name: 'relay-backup-independent-old-reader' });
  old.on('error', () => {}); await old.connect();
  try {
    await assert.rejects(createBackup(input()), refused('DATABASE_FENCE_OTHER_CONNECTION'));
    assert.equal((await old.query('select 1 as alive')).rows[0]?.alive, 1);
    await noMarker(); assert.equal(await gate(), 'DRAINING'); await released();
  } finally { await old.end(); }
});

test('killing the owned backup CLI during a committed fence leaves no success marker and requires explicit original ACL recovery', async () => {
  // The cluster observer connects to the separate administrative database, never through the target fence.
  const observer = new Client({ connectionString: ADMIN_DATABASE_URL, application_name: 'relay-backup-crash-observer' });
  observer.on('error', () => {}); await observer.connect();
  for (let i = 0; i < 8; i++) {
    const path = join(dataRoot, `artifacts/${randomUUID()}/${randomUUID()}`);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'content.md'), '受控孤儿'.repeat(10000));
  }
  const env: NodeJS.ProcessEnv = { RELAY_DB_URL: database.appUrl, RELAY_MIGRATION_DB_URL: database.migrationUrl,
    RELAY_MODEL_API_KEY: 'synthetic-must-not-be-forwarded', RELAY_FILE_IO_HELPER: 'untrusted-environment-helper' };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const cli = resolve(MIGRATIONS_DIRECTORY, '../dist/src/cli/backup.js');
  const child = spawn(process.execPath, [cli, 'create-backup', '--package-root', packageRoot, '--data-root', dataRoot,
    '--backup-root', backupRoot, '--postgres-bin', postgresBin], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child); let output = '';
  child.stdout!.on('data', bytes => { output += String(bytes); }); child.stderr!.on('data', bytes => { output += String(bytes); });
  child.once('error', () => {});
  const closed = new Promise<number | null>(resolve => child.once('close', code => { owned.delete(child); resolve(code); }));
  let stopped = false;
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      const row = (await observer.query<{ allowed: boolean }>("select has_database_privilege('relay_app',oid,'CONNECT') as allowed from pg_database where datname=$1", [database.name])).rows[0];
      if (row?.allowed === false) break;
      assert.ok(Date.now() < deadline && owned.has(child), `committed original fence must be observed; ${output}`);
      await delay(30);
    }
    assert.ok(child.kill(), 'kill only this owned CLI process');
    assert.notEqual(await closed, 0); stopped = true;
    await noMarker(); assert.ok(!output.includes('backup_created')); assert.ok(!output.includes('synthetic-must-not-be-forwarded'));
    assert.equal((await observer.query<{ allowed: boolean }>("select has_database_privilege('relay_app',oid,'CONNECT') as allowed from pg_database where datname=$1", [database.name])).rows[0]?.allowed, false);
    const journal = join(backupRoot, 'maintenance/original-acl.json');
    assert.ok((await stat(journal)).isFile());
    const first = await recoverDatabaseConnectFence(database.migrationUrl, journal);
    assert.equal(first.changed, true); assert.equal((await recoverDatabaseConnectFence(database.migrationUrl, journal)).changed, false);
    assert.equal(await gate(), 'DRAINING');
    // Native owners release on parent-pipe EOF; never find/kill processes by name.
    const releasedDeadline = Date.now() + 15000;
    while (true) {
      try { await released(); break; }
      catch (cause) { assert.ok(Date.now() < releasedDeadline, String(cause)); await delay(100); }
    }
  } finally {
    if (!stopped) { child.kill(); await closed; }
    await observer.end();
  }
});

for (const drift of ['admission-revision', 'replaced-database'] as const) {
  test(`a real ${drift} change before the database fence refuses stale snapshot identity`, async () => {
    const originalQuery = Client.prototype.query as (text: string, values?: unknown[]) => Promise<import('pg').QueryResult>;
    let initialRead = false, injected = false;
    // Only timing is intercepted. The gate transitions and replacement DDL execute on this private real PG cluster.
    const hook = mock.method(Client.prototype, 'query', async function (this: Client, text: string, values?: unknown[]) {
      const result = await originalQuery.call(this, text, values);
      if (typeof text === 'string' && text.includes("and session_user='relay_migrator'")) initialRead = true;
      if (!injected && initialRead && text === 'commit') {
        injected = true;
        if (drift === 'replaced-database') {
          await this.end();
          assert.match(database.name, /^[a-z][a-z0-9_]+$/u);
          const admin = new Client({ connectionString: ADMIN_DATABASE_URL }); admin.on('error', () => {});
          try {
            await admin.connect(); await originalQuery.call(admin, `drop database "${database.name}"`);
            await originalQuery.call(admin, `create database "${database.name}" owner relay_migrator`);
          } finally { await admin.end(); }
          await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
          await installGraphCheckpoints(database.migrationUrl);
        }
        const app = openDatabase(database.appUrl, 'relay-backup-controlled-gate-drift');
        try {
          let current = await readAdmissionStatus(app.db);
          if (current.mode === 'DRAINING') {
            current = (await changeAdmission(app.db, { action: 'resume-admission', commandId: randomUUID(), expectedRevision: current.revision })).result;
          }
          await changeAdmission(app.db, { action: 'begin-drain', commandId: randomUUID(), expectedRevision: current.revision });
        } finally { await app.close(); }
      }
      return result;
    });
    try { await assert.rejects(createBackup(input()), refused('BACKUP_STATE_CHANGED')); }
    finally { hook.mock.restore(); }
    assert.equal(injected, true); await noMarker(); assert.equal(await gate(), 'DRAINING'); await released();
  });
}
