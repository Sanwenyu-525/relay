import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after, before, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

import { createArtifactWithVersion } from '../../src/application/artifact-commands.js';
import { createProject } from '../../src/application/create-project.js';
import { registerManagedResource } from '../../src/application/gateway-configuration.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { installGraphCheckpoints } from '../../src/infrastructure/graph-checkpoints.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createBackup } from '../../src/runtime/backup.js';
import { backupStateSha256 } from '../../src/runtime/backup-state.js';
import { decodeRestoreDatabaseIsolationJournal } from '../../src/runtime/restore-database-isolation.js';
import { checkIsolatedRestore } from '../../src/runtime/restore-check.js';
import { assertRestoreNotIsolated } from '../../src/runtime/restore-isolation.js';
import { RestoreCheckError, RESTORE_MATERIAL_REFS } from '../../src/runtime/restore-materials.js';
import { restoreIsolated, RestoreError } from '../../src/runtime/restore.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createWorkspace } from './api-harness.js';
import { ADMIN_DATABASE_URL, createTemporaryDatabase, MIGRATIONS_DIRECTORY, openDatabase,
  type TemporaryDatabase } from './integration-support.js';

const workspace = resolve(MIGRATIONS_DIRECTORY, '../../..');
const postgresBin = join(workspace, '.research/runtime-cache/postgresql-18.6-2/pgsql/bin');
const desktopExe = join(workspace, 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/relay-desktop.exe');
const rustProbe = join(workspace, 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/deps/relay_desktop-32fc57221e376524.exe');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const owned = new Set<ChildProcess>();
let root: string, packageRoot: string, dataRoot: string, backupRoot: string, contentRef: string;
let source: TemporaryDatabase, sourceRows: unknown[];
let manifest: { backup_id: string; files: { source_ref: string; backup_ref: string; kind: string; size: string; sha256: string }[] };
const runId = randomUUID(), stepId = randomUUID(), attemptId = randomUUID(), operationId = randomUUID();
const resourceContent = Buffer.from('外部根原内容\n');
const resourceFixtures: { id: string; path: string; storedId: string | null;
  result: 'MATCH' | 'NO_STORED_ID' | 'ID_MISMATCH' }[] = [];

async function query(url: string, statement: string, values: unknown[] = []) {
  const client = new Client({ connectionString: url, application_name: 'relay-restore-composition-check', connectionTimeoutMillis: 5000 });
  client.on('error', () => {});
  try { await client.connect(); return (await client.query(statement, values)).rows; } finally { await client.end(); }
}
async function tableRows(url: string): Promise<unknown[]> {
  const tables = await query(url, `select n.nspname as schema,c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','relay_graph_v1') and c.relkind='r'
    order by n.nspname,c.relname`);
  const result = [];
  for (const table of tables) result.push({ ...table, rows: await query(url,
    `select to_jsonb(t) as row from ${quote(table.schema)}.${quote(table.name)} t order by to_jsonb(t)::text`) });
  return result;
}
async function appConnect(target: TemporaryDatabase): Promise<boolean> {
  return (await query(ADMIN_DATABASE_URL,
    "select has_database_privilege('relay_app',oid,'CONNECT') as allowed from pg_database where datname=$1", [target.name]))[0]?.allowed;
}
async function noReceipt(targetRoot: string) { await assert.rejects(stat(join(targetRoot, 'restore/verified.json')), { code: 'ENOENT' }); }
const input = (target: TemporaryDatabase, targetRoot: string) => ({ migrationUrl: target.migrationUrl,
  backupRoot, sourcePackageRoot: packageRoot, runtimePackageRoot: packageRoot, dataRoot: targetRoot,
  postgresBin, signal: new AbortController().signal });
const refused = (code: string) => (cause: unknown) => cause instanceof RestoreError && cause.code === code;

/** Keep the historical source fixture; only the maintenance target gets real packaged libraries. */
async function runtimePackageWithDependencies(): Promise<string> {
  const runtimeRoot = join(root, 'runtime-with-dependencies');
  await cp(packageRoot, runtimeRoot, { recursive: true });
  // This old directory supplies the unchanged pinned libraries, not current M07 package acceptance.
  await cp(join(workspace, 'test-release/api/node_modules'), join(runtimeRoot, 'api/node_modules'), { recursive: true });
  await writeFile(join(runtimeRoot, 'api/package.json'), await readFile(resolve(MIGRATIONS_DIRECTORY, '../package.json')));
  const manifest = JSON.parse(await readFile(join(runtimeRoot, 'desktop-build-manifest.json'), 'utf8'));
  const hashes: Record<string, string> = {};
  const pending = [''];
  while (pending.length !== 0) {
    const ref = pending.pop()!;
    for (const entry of await readdir(join(runtimeRoot, ref), { withFileTypes: true })) {
      const child = ref === '' ? entry.name : `${ref}/${entry.name}`;
      assert.equal(entry.isSymbolicLink(), false, 'fixture dependencies must be ordinary package files');
      if (entry.isDirectory()) pending.push(child);
      else {
        assert.equal(entry.isFile(), true);
        if (child !== 'desktop-build-manifest.json' && child !== 'relay-desktop.exe') {
          hashes[child] = hash(await readFile(join(runtimeRoot, child)));
        }
      }
    }
  }
  manifest.resource_inventory = ['dist', 'migrations', 'node_modules', 'package.json'];
  manifest.resource_file_sha256 = hashes;
  await writeFile(join(runtimeRoot, 'desktop-build-manifest.json'), JSON.stringify(manifest));
  return runtimeRoot;
}

before(async () => {
  assert.equal(process.platform, 'win32', 'this suite requires Windows native maintenance owners');
  root = await mkdtemp(join(tmpdir(), 'relay-restore-composition-'));
  packageRoot = join(root, 'package'); dataRoot = join(root, 'source-data'); backupRoot = join(root, 'backup');
  const files: Record<string, Buffer | string> = {
    'relay-desktop.exe': await readFile(desktopExe), 'node.exe': await readFile(process.execPath),
    'relay-file-io-helper.exe': await readFile(process.env.RELAY_FILE_IO_HELPER!),
    'licenses/OFL.txt': 'API resource fixture only; not an installable product package',
    'api/package.json': '{"type":"module"}',
  };
  for (const ref of ['main.js', 'worker/main.js', 'worker/supervisor-main.js', 'runtime/database-connect-fence.js',
    'runtime/restore-isolation.js', 'receipt/payload-hash.js', 'skills/first-party-registry.js']) {
    files[`api/dist/src/${ref}`] = await readFile(new URL(`../../src/${ref}`, import.meta.url));
  }
  assert.ok((files['relay-desktop.exe'] as Buffer).includes(Buffer.from('RESTORE_ISOLATED')));
  for (const name of await readdir(MIGRATIONS_DIRECTORY)) files[`api/migrations/${name}`] = await readFile(join(MIGRATIONS_DIRECTORY, name));
  for (const [ref, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(packageRoot, ref)), { recursive: true }); await writeFile(join(packageRoot, ref), bytes);
  }
  await writeFile(join(packageRoot, 'desktop-build-manifest.json'), JSON.stringify({ schema_version: 1,
    maintenance_session_protocol: 'relay-desktop-maintenance-v1', restore_isolation_protocol: 'relay-restore-isolation-v1',
    node_version: process.version, artifact_sha256: hash(files['relay-desktop.exe']!), forbidden_config_files: 0,
    resource_inventory: ['dist', 'migrations', 'package.json'], resource_file_sha256: Object.fromEntries(
      Object.entries(files).filter(([ref]) => ref !== 'relay-desktop.exe').map(([ref, bytes]) => [ref, hash(bytes)])) }));
  source = await createTemporaryDatabase('restore_composition_source');
  await runMigrations({ connectionString: source.migrationUrl, directory: MIGRATIONS_DIRECTORY });
  await installGraphCheckpoints(source.migrationUrl); await mkdir(dataRoot);
  const app = openDatabase(source.appUrl, 'relay-restore-composition-fixture');
  let taskId: string;
  try {
    const workspaceId = await createWorkspace(app.db);
    const project = await createProject(app.db, { workspaceId, commandId: randomUUID(), title: '还原原记录', projectType: 'GENERAL' });
    taskId = randomUUID();
    await withTransaction(app.db, async r => {
      await r.tasks.insertTask({ id: taskId, workspaceId, projectId: project.result.project_id, title: '保留确切版本',
        status: 'IN_PROGRESS', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
      await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n, objective: '核对原内容', requiredOutputSpec: {}, source: 'CREATE' });
      await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human', statement: '原内容不变', required: true, method: 'HUMAN', targetSpec: {} });
    });
    const saved = (await createArtifactWithVersion(app.db, new ManagedContentStore(dataRoot), { workspaceId, taskId,
      commandId: randomUUID(), expectedTaskRevision: '0', title: '原内容', mediaType: 'text/markdown', content: '# 还原\n原中文正文\n' })).result;
    contentRef = `artifacts/${saved.artifact_id}/${saved.version_id}/content.md`;
    for (const result of ['MATCH', 'NO_STORED_ID', 'ID_MISMATCH'] as const) {
      const path = join(root, `external-${result.toLowerCase()}`);
      await mkdir(path); await writeFile(join(path, 'original.md'), resourceContent);
      const resource = await registerManagedResource(app.db, { workspaceId, projectId: project.result.project_id, rootPath: path });
      // Initial fixture only, before the backup snapshot: older/non-write registrations permit this nullable fact.
      if (result === 'NO_STORED_ID') await query(source.migrationUrl,
        'update managed_resources set file_write_root_id=null where id=$1', [resource.resourceId]);
      const row = (await query(source.migrationUrl, 'select file_write_root_id from managed_resources where id=$1', [resource.resourceId]))[0]!;
      if (result === 'NO_STORED_ID') assert.equal(row.file_write_root_id, null);
      else assert.match(row.file_write_root_id, /^[0-9a-f]{16}:[0-9a-f]{32}$/u);
      resourceFixtures.push({ id: resource.resourceId, path: resource.canonicalRoot, storedId: row.file_write_root_id, result });
    }
    // Ledger fixture only: preserve an original unresolved identity without executing any Adapter or Provider.
    const ledger = new Client({ connectionString: source.migrationUrl, application_name: 'relay-restore-ledger-fixture' });
    ledger.on('error', () => {});
    try {
      await ledger.connect(); await ledger.query('begin');
      await ledger.query("insert into runs(id,workspace_id,task_id,status,ownership_epoch) values($1,$2,$3,'PAUSED',0)", [runId, workspaceId, taskId]);
      await ledger.query("insert into execution_contracts(run_id,task_id,acceptance_revision,workflow_key,workflow_version,execution_config_version,contract_hash,frozen_snapshot) values($1,$2,1,'markdown-deliverable-v1','1','fixture',$3,'{}')", [runId, taskId, Buffer.alloc(32, 1)]);
      await ledger.query("insert into run_steps(id,run_id,step_index,step_kind,status) values($1,$2,2,'PERSIST_CANDIDATE','RUNNING')", [stepId, runId]);
      await ledger.query("insert into step_attempts(id,step_id,attempt_number,attempt_key,status) values($1,$2,1,'original-attempt','RUNNING')", [attemptId, stepId]);
      await ledger.query("insert into run_effect_actions(operation_id,run_id,step_id,attempt_id,action_type,target_ref,params_hash,status,dispatch_count,dispatched_at) values($1,$2,$3,$4,'PUBLISH_CANDIDATE','original-target',$5,'UNKNOWN',1,now())", [operationId, runId, stepId, attemptId, Buffer.alloc(32, 2)]);
      await ledger.query("insert into relay_graph_v1.checkpoints(thread_id,checkpoint_id,checkpoint,metadata) values('original-thread','original-checkpoint',$1,$2)", [{ v: 4, channel_versions: { draft: '1' }, pending: '原 checkpoint' }, { source: 'composition fixture' }]);
      await ledger.query("insert into relay_graph_v1.checkpoint_blobs(thread_id,channel,version,type,blob) values('original-thread','draft','1','json',$1)", [Buffer.from('原 blob')]);
      await ledger.query("insert into relay_graph_v1.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob) values('original-thread','original-checkpoint','original-task',0,'draft','json',$1)", [Buffer.from('原 write')]);
      await ledger.query('commit');
    } catch (cause) { await ledger.query('rollback'); throw cause; }
    finally { await ledger.end(); }
  } finally { await app.close(); }
  await new ManagedContentStore(dataRoot).publish({ artifactId: randomUUID(), versionId: randomUUID(), content: Buffer.from('原孤儿') });
  await mkdir(join(dataRoot, 'staging'), { recursive: true }); await writeFile(join(dataRoot, 'staging', `${randomUUID()}.part`), '原暂存');
  const probe = spawn(rustProbe, ['--exact', 'job_sidecar::tests::host_crash_probe', '--nocapture'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAY_JOB_PROBE_MODE: 'hold',
      RELAY_JOB_PROBE_ROOT: dataRoot, RELAY_TEST_NODE: process.execPath } });
  owned.add(probe); probe.stdout!.resume(); probe.stderr!.resume(); probe.once('error', () => {});
  const closed = new Promise(resolve => probe.once('close', code => { owned.delete(probe); resolve(code); }));
  try {
    const deadline = Date.now() + 10_000;
    while (!await readFile(join(dataRoot, 'probe-ready')).catch(() => null)) {
      assert.ok(Date.now() < deadline, 'actual original Job must be ready'); await delay(30);
    }
    await unlink(join(dataRoot, 'probe-ready'));
    await createBackup({ appUrl: source.appUrl, migrationUrl: source.migrationUrl, packageRoot, dataRoot,
      backupRoot, postgresBin, signal: new AbortController().signal });
  } finally { probe.kill(); await Promise.race([closed, delay(10_000).then(() => { throw new Error('own probe did not exit'); })]); }
  sourceRows = await tableRows(source.migrationUrl);
  manifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.filter(file => file.kind === 'ARMED').length, 1);
});
after(async () => {
  assert.equal(owned.size, 0, 'all owned CLI/native processes must exit');
  if (source !== undefined) await source.drop();
  if (root !== undefined) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); }
});

test('complete product restore preserves every public/Graph row and exact file while retaining target isolation and original UNKNOWN identity', async () => {
  const target = await createTemporaryDatabase('restore_composition_success'), targetRoot = join(root, `target-${randomUUID()}`);
  try {
    const result = await restoreIsolated(input(target, targetRoot));
    assert.equal(result.backupId, manifest.backup_id); assert.equal(result.admission, 'DRAINING'); assert.equal(result.execution, 'ISOLATED');
    const receipt = JSON.parse(await readFile(join(targetRoot, 'restore/verified.json'), 'utf8'));
    assert.equal(backupStateSha256(receipt), result.verifiedSha256);
    assert.deepEqual(await tableRows(target.migrationUrl), sourceRows);
    assert.deepEqual(await query(target.migrationUrl, 'select operation_id,run_id,step_id,attempt_id,status,dispatch_count from run_effect_actions'),
      [{ operation_id: operationId, run_id: runId, step_id: stepId, attempt_id: attemptId, status: 'UNKNOWN', dispatch_count: 1 }]);
    for (const file of manifest.files) {
      const targetRef = file.kind === 'CONTENT' ? file.source_ref : `evidence/${file.source_ref}`;
      assert.deepEqual(await readFile(join(targetRoot, targetRef)), await readFile(join(backupRoot, file.backup_ref)));
    }
    assert.equal(await appConnect(target), false); assert.equal(await appConnect(source), true);
    await assert.rejects(query(target.appUrl, 'select 1'), { code: '42501' });
    await assert.rejects(assertRestoreNotIsolated(targetRoot), { code: 'RESTORE_ISOLATED' });
    await assert.rejects(stat(join(targetRoot, 'runtime-launches')), { code: 'ENOENT' });
    const journal = decodeRestoreDatabaseIsolationJournal(await readFile(join(targetRoot, 'restore/target-acl.json')));
    assert.equal(journal.target.database, target.name); assert.equal(journal.source_target.database, source.name);
    const originalMarker = await readFile(join(targetRoot, 'restore-isolation.json'));
    await assert.rejects(restoreIsolated(input(target, targetRoot)), refused('RESTORE_TARGET_EXISTS'));
    assert.deepEqual(await readFile(join(targetRoot, 'restore-isolation.json')), originalMarker);
    assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
  } finally { await target.drop(); }
});

test('tampered backup content is rejected before publishing a new target root or changing target CONNECT', async () => {
  const target = await createTemporaryDatabase('restore_composition_tamper'), targetRoot = join(root, `target-${randomUUID()}`);
  const path = join(backupRoot, 'data', contentRef), original = await readFile(path);
  try {
    await writeFile(path, Buffer.alloc(original.length, 0x78));
    await assert.rejects(restoreIsolated(input(target, targetRoot)), refused('RESTORE_FILES_CHANGED'));
    await assert.rejects(stat(targetRoot), { code: 'ENOENT' }); assert.equal(await appConnect(target), true);
    assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
  } finally { await writeFile(path, original); await target.drop(); }
});

test('a nonempty target retains its original rows and ACL and never receives a verified restore receipt', async () => {
  const target = await createTemporaryDatabase('restore_composition_nonempty'), targetRoot = join(root, `target-${randomUUID()}`);
  try {
    await query(target.migrationUrl, 'create table operator_original(value text)');
    await query(target.migrationUrl, "insert into operator_original values('keep')");
    await assert.rejects(restoreIsolated(input(target, targetRoot)), refused('RESTORE_DATABASE_NOT_EMPTY'));
    assert.deepEqual(await query(target.migrationUrl, 'select * from operator_original'), [{ value: 'keep' }]);
    assert.equal(await appConnect(target), true); await noReceipt(targetRoot);
    await assert.rejects(assertRestoreNotIsolated(targetRoot), { code: 'RESTORE_ISOLATED' });
    assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
  } finally { await target.drop(); }
});

test('rehashed metadata with missing migrations or mismatched admission revision is rejected before target mutation', async () => {
  const target = await createTemporaryDatabase('restore_composition_metadata'), targetRoot = join(root, `target-${randomUUID()}`);
  const refs = ['state.json', 'manifest.json', 'complete.json'];
  const original = await Promise.all(refs.map(ref => readFile(join(backupRoot, ref))));
  try {
    for (const kind of ['missing-migration', 'different-revision']) {
      const state = JSON.parse(original[0]!.toString('utf8'));
      const changedManifest = JSON.parse(original[1]!.toString('utf8'));
      const complete = JSON.parse(original[2]!.toString('utf8'));
      if (kind === 'missing-migration') state.migrations.pop();
      else state.admission.revision = String(BigInt(state.admission.revision) + 1n);
      changedManifest.state.canonical_sha256 = backupStateSha256(state);
      complete.manifest_canonical_sha256 = backupStateSha256(changedManifest);
      await Promise.all([state, changedManifest, complete].map((value, index) => writeFile(join(backupRoot, refs[index]!), JSON.stringify(value))));
      await assert.rejects(restoreIsolated(input(target, targetRoot)), refused('RESTORE_BACKUP_INVALID'));
      await assert.rejects(stat(targetRoot), { code: 'ENOENT' }); assert.equal(await appConnect(target), true);
    }
  } finally {
    await Promise.all(original.map((bytes, index) => writeFile(join(backupRoot, refs[index]!), bytes)));
    await target.drop();
  }
});

test('a restore-directory junction after the actual maintenance connection closes refuses success and never writes into the original data root', async () => {
  const target = await createTemporaryDatabase('restore_composition_late_path'), targetRoot = join(root, `target-${randomUUID()}`);
  const end = Client.prototype.end, open = fsPromises.open;
  let matched = false, maintenanceEnded = false, journalPinned = false, changed = false, faultCode = '', restoreCode = '';
  const closeHooks: (() => void)[] = [];
  const hook = mock.method(Client.prototype, 'end', function (this: Client, ...args: Parameters<typeof end>) {
    const result = end.apply(this, args);
    const params = (this as Client & { connectionParameters: { database: string; application_name: string } }).connectionParameters;
    if (params.database !== target.name || params.application_name !== 'relay-restore-database-isolation') return result;
    matched = true;
    return Promise.resolve(result).then(() => { maintenanceEnded = true; });
  });
  const openHook = mock.method(fsPromises, 'open', async function (...args: Parameters<typeof open>) {
    const handle = await open.apply(fsPromises, args);
    if (args[0] === join(targetRoot, 'restore/target-acl.json') && args[1] === 'r') {
      assert.equal(journalPinned, false, 'only the actual pinned target journal may inject this fault'); journalPinned = true;
      const close = handle.close;
      const closeHook = mock.method(handle, 'close', async function () {
        await close.call(handle);
        assert.equal(maintenanceEnded, true, 'the real PG connection must end before the pinned journal closes');
        try {
          await rename(join(targetRoot, 'restore'), join(targetRoot, 'restore-original'));
          await symlink(dataRoot, join(targetRoot, 'restore'), 'junction'); changed = true;
        } catch (cause) { faultCode = (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN'; throw cause; }
      });
      closeHooks.push(() => closeHook.mock.restore());
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(restoreIsolated(input(target, targetRoot)), cause => {
      if (!(cause instanceof RestoreError)) return false;
      restoreCode = cause.code; return true;
    });
    assert.equal(matched, true, `target maintenance close must be matched; restore=${restoreCode}`);
    assert.equal(journalPinned, true, 'the target isolation must use the actual pinned journal');
    assert.equal(maintenanceEnded, true, 'the actual target maintenance connection must close');
    assert.equal(changed, true, `fault must occur after the real target maintenance connection closes; fault=${faultCode}; restore=${restoreCode}`);
    await noReceipt(targetRoot); await assert.rejects(stat(join(dataRoot, 'verified.json')), { code: 'ENOENT' });
    assert.equal(await appConnect(target), false); await assert.rejects(assertRestoreNotIsolated(targetRoot), { code: 'RESTORE_ISOLATED' });
    for (const file of manifest.files) assert.deepEqual(await readFile(join(dataRoot, file.source_ref)), await readFile(join(backupRoot, file.backup_ref)));
    assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
  } finally {
    hook.mock.restore(); openHook.mock.restore(); closeHooks.forEach(restore => restore()); syncBuiltinESMExports();
    if (changed) await rm(join(targetRoot, 'restore')); // This is only our junction, not its original target.
    await target.drop();
  }
});

test('killing the owned product restore CLI after target CONNECT revocation leaves its marker/journal and no success receipt', async () => {
  const target = await createTemporaryDatabase('restore_composition_crash'), targetRoot = join(root, `target-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = { RELAY_MIGRATION_DB_URL: target.migrationUrl,
    RELAY_MODEL_API_KEY: 'synthetic-must-not-be-forwarded', RELAY_FILE_IO_HELPER: 'untrusted-environment-helper' };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const cli = resolve(MIGRATIONS_DIRECTORY, '../dist/src/cli/restore.js');
  const child = spawn(process.execPath, [cli, 'restore-isolated', '--backup-root', backupRoot, '--source-package-root', packageRoot,
    '--runtime-package-root', packageRoot, '--data-root', targetRoot, '--postgres-bin', postgresBin], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child); let output = '', stopped = false;
  child.stdout!.on('data', bytes => { output += String(bytes); }); child.stderr!.on('data', bytes => { output += String(bytes); });
  child.once('error', () => {});
  const closed = new Promise<number | null>(resolve => child.once('close', code => { owned.delete(child); resolve(code); }));
  try {
    const deadline = Date.now() + 90_000;
    while (await appConnect(target)) {
      assert.ok(Date.now() < deadline && owned.has(child), `target revocation must be observed; ${output}`); await delay(30);
    }
    assert.ok(child.kill()); assert.notEqual(await closed, 0); stopped = true;
    await noReceipt(targetRoot); assert.equal(await appConnect(target), false);
    await assert.rejects(assertRestoreNotIsolated(targetRoot), { code: 'RESTORE_ISOLATED' });
    assert.ok((await stat(join(targetRoot, 'restore/target-acl.json'))).isFile());
    assert.ok(!output.includes('restore_verified_isolated') && !output.includes('synthetic-must-not-be-forwarded'));
    assert.equal(await appConnect(source), true); assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
    const deadlineExit = Date.now() + 10_000;
    while ((await query(ADMIN_DATABASE_URL, 'select pid from pg_stat_activity where datname=$1', [target.name])).length > 0) {
      assert.ok(Date.now() < deadlineExit, 'owned maintenance connection must exit'); await delay(30);
    }
  } finally {
    if (!stopped && owned.has(child)) { child.kill(); await closed; }
    await target.drop();
  }
});

test('a target inside the original or same-volume moved source data root is rejected before any directory or CONNECT mutation', async () => {
  const target = await createTemporaryDatabase('restore_composition_source_root');
  const originalRoot = dataRoot, movedRoot = join(root, 'source-data-moved');
  const entries = await readdir(dataRoot); let moved = false;
  try {
    for (const move of [false, true]) {
      if (move) { await rename(originalRoot, movedRoot); dataRoot = movedRoot; moved = true; }
      const targetRoot = join(dataRoot, 'must-not-create');
      await assert.rejects(restoreIsolated(input(target, targetRoot)), refused('RESTORE_SOURCE_ROOT_OVERLAP'));
      await assert.rejects(stat(targetRoot), { code: 'ENOENT' });
      assert.deepEqual(await readdir(dataRoot), entries); assert.equal(await appConnect(target), true);
      assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
    }
  } finally {
    if (moved) await rename(movedRoot, originalRoot);
    dataRoot = originalRoot; await target.drop();
  }
});

test('business-read-only restore check and its actual CLI preserve every row, original UNKNOWN, stored materials and target isolation', async () => {
  const target = await createTemporaryDatabase('restore_check_composition'), targetRoot = join(root, `target-${randomUUID()}`);
  const hiddenBackup = join(root, 'backup-not-read-by-check'); let backupHidden = false;
  try {
    const runtimeRoot = await runtimePackageWithDependencies();
    await restoreIsolated({ ...input(target, targetRoot), runtimePackageRoot: runtimeRoot });
    const replaced = resourceFixtures.find(resource => resource.result === 'ID_MISMATCH')!;
    // Retain the original directory so the new directory cannot reuse its still-live File ID.
    await rename(replaced.path, join(root, 'external-retained-original'));
    await mkdir(replaced.path); await writeFile(join(replaced.path, 'original.md'), resourceContent);
    const rows = await tableRows(target.migrationUrl);
    const refs = [...RESTORE_MATERIAL_REFS, ...manifest.files.map(file => file.kind === 'CONTENT' ? file.source_ref : `evidence/${file.source_ref}`)];
    const bytes = await Promise.all(refs.map(ref => readFile(join(targetRoot, ref))));
    const assertPreserved = async () => {
      assert.deepEqual(await tableRows(target.migrationUrl), rows);
      for (const [index, ref] of refs.entries()) assert.deepEqual(await readFile(join(targetRoot, ref)), bytes[index]);
      for (const resource of resourceFixtures) {
        assert.deepEqual(await readdir(resource.path), ['original.md']);
        assert.deepEqual(await readFile(join(resource.path, 'original.md')), resourceContent);
      }
      assert.equal(await appConnect(target), false); assert.equal(await appConnect(source), true);
      await assert.rejects(query(target.appUrl, 'select 1'), { code: '42501' });
      await assert.rejects(assertRestoreNotIsolated(targetRoot), { code: 'RESTORE_ISOLATED' });
      await assert.rejects(stat(join(targetRoot, 'runtime-launches')), { code: 'ENOENT' });
      assert.deepEqual(await tableRows(source.migrationUrl), sourceRows);
      assert.deepEqual(await query(target.migrationUrl, 'select operation_id,run_id,step_id,attempt_id,status,dispatch_count from run_effect_actions'),
        [{ operation_id: operationId, run_id: runId, step_id: stepId, attempt_id: attemptId, status: 'UNKNOWN', dispatch_count: 1 }]);
      assert.equal((await query(ADMIN_DATABASE_URL, 'select pid from pg_stat_activity where datname=$1', [target.name])).length, 0);
    };
    await assert.rejects(stat(join(targetRoot, '.relay-content-admission.lock')), { code: 'ENOENT' });
    await rename(backupRoot, hiddenBackup); backupHidden = true;
    const checkInput = { migrationUrl: target.migrationUrl, dataRoot: targetRoot, runtimePackageRoot: runtimeRoot,
      signal: new AbortController().signal };
    const report = await checkIsolatedRestore(checkInput);
    assert.equal(report.execution, 'ISOLATED'); assert.equal(report.activation, 'NOT_GRANTED');
    assert.equal(report.scope, 'SELECTED_DATABASE_PROJECTION_AND_LISTED_FILES');
    assert.equal(report.source_backup_attestation, 'STORED_MANIFEST_BINDING_ONLY');
    assert.equal(report.source_package_attestation, 'STORED_BINDING_ONLY');
    assert.equal(report.runtime_dependency_probe.scope, 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY');
    assert.equal(report.resource_root_identity_probe.version, 'relay-restore-resource-roots-v1');
    assert.equal(report.resource_root_identity_probe.scope, 'REGISTERED_MANAGED_ROOT_IDENTITIES_ONLY');
    assert.equal(report.resource_root_identity_probe.root_count, resourceFixtures.length);
    assert.equal(report.resource_root_identity_probe.selected_state_sha256, report.selected_state_canonical_sha256);
    const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, 'desktop-build-manifest.json'), 'utf8'));
    const runtimeMetadata = JSON.parse(await readFile(join(runtimeRoot, 'api/package.json'), 'utf8'));
    assert.equal(report.resource_root_identity_probe.helper_sha256, runtimeManifest.resource_file_sha256['relay-file-io-helper.exe']);
    for (const resource of resourceFixtures) {
      const observed = report.resource_root_identity_probe.results.find(entry => entry.id === resource.id)!;
      assert.equal(observed.result, resource.result); assert.equal(observed.stored_root_id, resource.storedId);
      if (resource.result === 'NO_STORED_ID') assert.equal(observed.observed_root_id, null);
      else {
        assert.match(observed.observed_root_id!, /^[0-9a-f]{16}:[0-9a-f]{32}$/u);
        if (resource.result === 'MATCH') assert.equal(observed.observed_root_id, resource.storedId);
        else assert.notEqual(observed.observed_root_id, resource.storedId);
      }
    }
    assert.equal(report.runtime_dependency_probe.format, 'relay-restore-runtime-probe-v1');
    assert.equal(report.runtime_dependency_probe.node_version, process.version);
    assert.equal(report.runtime_dependency_probe.node_sha256, runtimeManifest.resource_file_sha256['node.exe']);
    assert.equal(report.runtime_dependency_probe.package_metadata_sha256, runtimeManifest.resource_file_sha256['api/package.json']);
    assert.deepEqual(report.runtime_dependency_probe.direct_dependencies.map(entry => entry.name).sort(),
      Object.keys(runtimeMetadata.dependencies).sort());
    for (const entry of report.runtime_dependency_probe.direct_dependencies) {
      assert.equal(entry.version, runtimeMetadata.dependencies[entry.name]);
      assert.equal(entry.entry_sha256, runtimeManifest.resource_file_sha256[entry.entry_ref]);
      assert.equal(entry.package_sha256, runtimeManifest.resource_file_sha256[entry.package_ref]);
    }
    assert.ok(report.runtime_dependency_probe.loaded_file_count > 1000, 'actual packaged libraries must load');
    assert.match(report.runtime_dependency_probe.loaded_files_canonical_sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.values(report.runtime_dependency_probe.checks), Array(9).fill(true));
    assert.equal(report.content_exclusion.sentinel_initially_absent, true);
    assert.equal(report.content_exclusion.session_closed_before_report, true);
    assert.deepEqual(report.pending, ['FULL_HISTORICAL_EXECUTION_COMPATIBILITY', 'TARGET_DEPENDENCY_CALLABILITY',
      'EXTERNAL_RESOURCE_LIVE_IDENTITY', 'CONFIGURATION_AND_SINGLE_LOGICAL_OWNER', 'EXPLICIT_ACTIVATION']);
    const receipt = JSON.parse(bytes[refs.indexOf('restore/verified.json')]!.toString('utf8'));
    assert.equal(report.restore_id, receipt.restore_id); assert.deepEqual(report.target, receipt.target);
    assert.equal(report.selected_state_canonical_sha256, receipt.restored_state_canonical_sha256);
    assert.equal(report.verified_receipt_canonical_sha256, backupStateSha256(receipt));
    await assertPreserved();

    const env: NodeJS.ProcessEnv = { RELAY_MIGRATION_DB_URL: target.migrationUrl,
      RELAY_MODEL_API_KEY: 'synthetic-restore-check-secret', RELAY_FILE_IO_HELPER: 'untrusted-environment-helper',
      PGHOST: 'private.invalid', PGPORT: '1', PGUSER: 'relay_app', PGDATABASE: 'never-connect',
      PGPASSWORD: 'synthetic-unrelated-password', PGSSLMODE: 'require', PGOPTIONS: '-c unknown_private_setting=on' };
    for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const cli = resolve(MIGRATIONS_DIRECTORY, '../dist/src/cli/restore-check.js');
    const child = spawn(process.execPath, [cli, 'restore-check-isolated', '--data-root', targetRoot,
      '--runtime-package-root', runtimeRoot], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    owned.add(child); let output = '', errors = '', outputBytes = 0, failure = '';
    const stop = (reason: string) => { failure ||= reason; child.kill(); };
    child.stdout!.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 64 * 1024) stop('CLI output limit'); else output += chunk.toString('utf8'); });
    child.stderr!.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 64 * 1024) stop('CLI output limit'); else errors += chunk.toString('utf8'); });
    child.once('error', () => stop('CLI spawn failed'));
    // Observe the existing 15-minute product budget and its owned-process close; this is not an RTO claim.
    const timer = setTimeout(() => stop('CLI observation deadline'), 15 * 60_000 + 30_000);
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('close', (code, signal) => {
      clearTimeout(timer); owned.delete(child); done({ code, signal });
    }));
    assert.equal(failure, ''); assert.equal(ended.code, 0, errors); assert.equal(ended.signal, null); assert.equal(errors, '');
    assert.ok(!output.includes('synthetic-restore-check-secret'));
    assert.ok(!output.includes('synthetic-unrelated-password'));
    const cliReport = JSON.parse(output);
    assert.equal(cliReport.type, 'restore_checked_isolated'); assert.equal(cliReport.activation, 'NOT_GRANTED');
    assert.equal(cliReport.runtime_dependency_probe.scope, 'PACKAGED_DEPENDENCIES_OFFLINE_ONLY');
    assert.deepEqual(cliReport.resource_root_identity_probe, report.resource_root_identity_probe);
    assert.deepEqual(cliReport.runtime_dependency_probe.direct_dependencies, report.runtime_dependency_probe.direct_dependencies);
    assert.equal(cliReport.runtime_dependency_probe.node_sha256, report.runtime_dependency_probe.node_sha256);
    assert.equal(cliReport.runtime_dependency_probe.package_metadata_sha256, report.runtime_dependency_probe.package_metadata_sha256);
    assert.deepEqual(cliReport.runtime_dependency_probe.checks, report.runtime_dependency_probe.checks);
    assert.ok(cliReport.runtime_dependency_probe.loaded_file_count > 1000);
    assert.match(cliReport.runtime_dependency_probe.loaded_files_canonical_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(cliReport.content_exclusion.sentinel_initially_absent, false);
    assert.equal(cliReport.content_exclusion.session_closed_before_report, true);
    await assertPreserved();

    const markerPath = join(targetRoot, 'restore-isolation.json'), originalMarker = await readFile(markerPath);
    try {
      await writeFile(markerPath, '{}');
      await assert.rejects(checkIsolatedRestore(checkInput), cause => cause instanceof RestoreCheckError && cause.code === 'RESTORE_CHECK_MATERIALS_INVALID');
    } finally { await writeFile(markerPath, originalMarker); }
    await assertPreserved();
    const contentPath = join(targetRoot, contentRef), originalContent = await readFile(contentPath);
    try {
      await writeFile(contentPath, Buffer.alloc(originalContent.length, 0x78));
      await assert.rejects(checkIsolatedRestore(checkInput), cause => cause instanceof RestoreCheckError && cause.code === 'RESTORE_FILES_CHANGED');
    } finally { await writeFile(contentPath, originalContent); }
    await assertPreserved();
    for (const file of manifest.files) assert.deepEqual(await readFile(join(dataRoot, file.source_ref)), await readFile(join(hiddenBackup, file.backup_ref)));
  } finally {
    if (backupHidden) await rename(hiddenBackup, backupRoot);
    await target.drop();
  }
});
