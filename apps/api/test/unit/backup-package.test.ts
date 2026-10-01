import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { BackupPackageError, inspectBackupRegistryArchive,
  verifyBackupPackage, verifyRestoreRuntimePackage } from '../../src/runtime/backup-package.js';
import { createFirstPartyRegistry, exportFirstPartyRegistryArchive,
  FIRST_PARTY_REGISTRY, type FirstPartyRegistryArchive } from '../../src/skills/first-party-registry.js';

const archive = exportFirstPartyRegistryArchive();
const windows = { skip: process.platform !== 'win32' };
const invalidPackage = (cause: unknown) => cause instanceof BackupPackageError &&
  cause.code === 'BACKUP_PACKAGE_INVALID';
const invalidRegistry = (cause: unknown) => cause instanceof BackupPackageError &&
  cause.code === 'BACKUP_REGISTRY_INVALID';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

test('backup archive contains retired Pack bodies and members without mutating the live registry', () => {
  const checked = inspectBackupRegistryArchive(archive);
  assert.equal(checked.skills.length, FIRST_PARTY_REGISTRY.skills.length);
  assert.equal(checked.packs.length, FIRST_PARTY_REGISTRY.packs.length);
  const retired = checked.packs.find(pack => pack.definition.id === 'thesis-minimal' &&
    pack.definition.version === '1.0.0')!;
  assert.deepEqual(retired.definition.members.map(member => member.id),
    retired.members.map(member => member.id));
  assert.equal(retired.sha256, FIRST_PARTY_REGISTRY.pack('thesis-minimal', '1.0.0')!.sha256);
  const changed = structuredClone(checked);
  Object.assign(changed.skills[0]!.definition, { instructions: 'local mutation' });
  assert.notEqual(FIRST_PARTY_REGISTRY.skills[0]!.definition.instructions, 'local mutation');
  assert.deepEqual(exportFirstPartyRegistryArchive(), archive);
});

test('archive reconstruction rejects tampered bodies, incomplete Pack members, and duplicate identities', () => {
  const changed = structuredClone(archive);
  Object.assign(changed.skills[0]!.dependencies[0]!.definition, { history_limit: 999 });
  const missing = structuredClone(archive);
  Object.assign(missing.packs[0]!, { members: missing.packs[0]!.members.slice(1) });
  const duplicate = { ...archive, skills: [...archive.skills, archive.skills[0]] };
  const summaryOnly = { ...archive, packs: FIRST_PARTY_REGISTRY.packs };
  const badHash = structuredClone(archive);
  Object.assign(badHash.packs[0]!, { sha256: '0'.repeat(64) });
  for (const value of [changed, missing, duplicate, summaryOnly, badHash, {}]) {
    assert.throws(() => inspectBackupRegistryArchive(value), invalidRegistry);
  }
});

function differentArchive(): FirstPartyRegistryArchive {
  const oldSkill = structuredClone(archive.skills[0]!);
  Object.assign(oldSkill.definition, { instructions: 'Exact definition from the source package.' });
  const pack = archive.packs[0]!.definition;
  const selected = archive.skills.filter(skill => pack.members.some(member =>
    member.id === skill.id && member.version === skill.version));
  const registry = createFirstPartyRegistry(
    selected.flatMap(skill => skill.dependencies), selected.map(skill =>
      skill.id === oldSkill.id && skill.version === oldSkill.version ? oldSkill.definition : skill.definition), [pack]);
  return { skills: registry.skills, packs: [{ definition: pack,
    sha256: registry.packs[0]!.sha256, members: pack.members.map(member => registry.skill(member.id, member.version)!) }] };
}

test('valid archived definitions may differ from the coordinating application at the same id/version', () => {
  const different = differentArchive();
  assert.notEqual(different.skills[0]!.sha256, FIRST_PARTY_REGISTRY.skill(
    different.skills[0]!.id, different.skills[0]!.version)!.sha256);
  assert.deepEqual(inspectBackupRegistryArchive(different), different);
});

async function fixture(t: { after(fn: () => Promise<void>): void }, source?: string) {
  const temp = await mkdtemp(join(tmpdir(), 'relay-backup-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'package');
  const files: Record<string, Buffer | string> = {
    'relay-desktop.exe': 'maintenance fixture only', 'node.exe': 'node fixture only',
    'relay-file-io-helper.exe': 'helper fixture only', 'licenses/OFL.txt': 'fixture',
    'api/package.json': '{"type":"module"}', 'api/dist/src/main.js': '',
    'api/dist/src/worker/main.js': '', 'api/dist/src/worker/supervisor-main.js': '',
    'api/dist/src/runtime/database-connect-fence.js': '',
    'api/migrations/0001_v001_human_core.sql': '-- fixture',
    'api/migrations/0048_m07_admission_gate.sql': '-- fixture',
    'api/dist/src/receipt/payload-hash.js': await readFile(new URL('../../src/receipt/payload-hash.js', import.meta.url)),
    'api/dist/src/skills/first-party-registry.js': source ??
      await readFile(new URL('../../src/skills/first-party-registry.js', import.meta.url)),
  };
  for (const [ref, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, ref)), { recursive: true });
    await writeFile(join(root, ref), bytes);
  }
  const manifest = { schema_version: 1, maintenance_session_protocol: 'relay-desktop-maintenance-v1',
    node_version: process.version, artifact_sha256: hash(files['relay-desktop.exe']!), forbidden_config_files: 0,
    resource_file_sha256: Object.fromEntries(Object.entries(files).filter(([ref]) => ref !== 'relay-desktop.exe')
      .map(([ref, bytes]) => [ref, hash(bytes)])), resource_inventory: ['dist', 'migrations', 'package.json'] };
  const publish = () => writeFile(join(root, 'desktop-build-manifest.json'), JSON.stringify(manifest));
  await publish();
  return { root, temp, manifest, publish };
}

test('verified package exports its own complete registry and binds all declared resources', windows, async t => {
  const f = await fixture(t);
  const result = await verifyBackupPackage(f.root);
  assert.deepEqual(result.registry, archive);
  assert.equal(result.artifactHash, f.manifest.artifact_sha256);
  assert.equal(result.manifestHash, hash(await readFile(join(f.root, 'desktop-build-manifest.json'))));
  const different = differentArchive();
  const historical = await fixture(t, `export const exportFirstPartyRegistryArchive=()=>(${JSON.stringify(different)});`);
  assert.deepEqual((await verifyBackupPackage(historical.root)).registry, different);
});

test('package verification rejects changed, undeclared, missing and credential-like resources', windows, async t => {
  for (const kind of ['changed', 'undeclared', 'missing', 'credential'] as const) {
    const f = await fixture(t);
    if (kind === 'changed') await writeFile(join(f.root, 'node.exe'), 'changed');
    if (kind === 'undeclared') await writeFile(join(f.root, 'api/extra.js'), 'extra');
    if (kind === 'missing') await rm(join(f.root, 'api/migrations/0048_m07_admission_gate.sql'));
    if (kind === 'credential') {
      await writeFile(join(f.root, 'api/.env'), 'fixture');
      f.manifest.resource_file_sha256['api/.env'] = hash('fixture');
      f.manifest.resource_inventory.push('.env');
      await f.publish();
    }
    await assert.rejects(verifyBackupPackage(f.root), invalidPackage);
  }
});

test('package verification rejects path aliases, unsupported protocol and unlisted inventory', windows, async t => {
  for (const kind of ['alias', 'traversal', 'protocol', 'inventory'] as const) {
    const f = await fixture(t);
    if (kind === 'alias') f.manifest.resource_file_sha256['NODE.EXE'] = f.manifest.resource_file_sha256['node.exe']!;
    if (kind === 'traversal') f.manifest.resource_file_sha256['api/../node.exe'] = hash('node fixture only');
    if (kind === 'protocol') f.manifest.maintenance_session_protocol = 'legacy';
    if (kind === 'inventory') f.manifest.resource_inventory.push('extra');
    await f.publish();
    await assert.rejects(verifyBackupPackage(f.root), invalidPackage);
  }
});

test('package verification rejects real hardlinks, junction ancestors and alternate data streams', windows, async t => {
  const hard = await fixture(t);
  await link(join(hard.root, 'node.exe'), join(hard.temp, 'node-alias.exe'));
  await assert.rejects(verifyBackupPackage(hard.root), invalidPackage);
  const junction = await fixture(t);
  const alias = join(junction.temp, 'alias');
  await symlink(junction.root, alias, 'junction');
  await assert.rejects(verifyBackupPackage(alias), invalidPackage);
  const ads = await fixture(t);
  await writeFile(`${join(ads.root, 'node.exe')}:hidden`, 'fixture');
  await assert.rejects(verifyBackupPackage(ads.root), invalidPackage);
});

test('old package export cannot fall back to current definitions or inherit credential environment', windows, async t => {
  const old = await fixture(t, 'export const FIRST_PARTY_REGISTRY = {};');
  await assert.rejects(verifyBackupPackage(old.root), invalidRegistry);
  const secretName = 'RELAY_BACKUP_TEST_SECRET';
  const previous = process.env[secretName];
  process.env[secretName] = 'test sentinel only';
  try {
    const isolated = await fixture(t, `if(process.env.${secretName}!==undefined) throw new Error();` +
      `export const exportFirstPartyRegistryArchive=()=>(${JSON.stringify(archive)});`);
    assert.deepEqual((await verifyBackupPackage(isolated.root)).registry, archive);
  } finally {
    if (previous === undefined) delete process.env[secretName]; else process.env[secretName] = previous;
  }
});

test('source package export cannot mutate resources after hash verification', windows, async t => {
  const f = await fixture(t, "import {writeFileSync} from 'node:fs';" +
    "import {fileURLToPath} from 'node:url';" +
    "writeFileSync(fileURLToPath(new URL('../../../../node.exe', import.meta.url)), 'changed');" +
    `export const exportFirstPartyRegistryArchive=()=>(${JSON.stringify(archive)});`);
  await assert.rejects(verifyBackupPackage(f.root), invalidPackage);
});

test('registry export is bounded when the source module hangs or floods stdout', windows, async t => {
  const hung = await fixture(t, 'await new Promise(()=>setInterval(()=>{},1000));');
  const started = Date.now();
  await assert.rejects(verifyBackupPackage(hung.root), invalidRegistry);
  assert.ok(Date.now() - started < 30_000, 'owned exporter must stop within its time budget');
  const flooded = await fixture(t, "process.stdout.write('x'.repeat(1024*1024+1));" +
    `export const exportFirstPartyRegistryArchive=()=>(${JSON.stringify(archive)});`);
  await assert.rejects(verifyBackupPackage(flooded.root), invalidRegistry);
});

test('restore runtime requires capability and hash-bound native and three Node guards while source verification stays compatible', windows, async t => {
  const f = await fixture(t);
  const refused = (cause: unknown) => cause instanceof BackupPackageError && cause.code === 'RESTORE_RUNTIME_PACKAGE_INVALID';
  await verifyBackupPackage(f.root); await assert.rejects(verifyRestoreRuntimePackage(f.root), refused);
  const literals = 'restore-isolation.json RESTORE_ISOLATED RESTORE_ISOLATION_UNAVAILABLE';
  const moduleRef = 'api/dist/src/runtime/restore-isolation.js';
  await mkdir(dirname(join(f.root, moduleRef)), { recursive: true }); await writeFile(join(f.root, moduleRef), literals);
  f.manifest.resource_file_sha256[moduleRef] = hash(literals);
  await writeFile(join(f.root, 'relay-desktop.exe'), literals); f.manifest.artifact_sha256 = hash(literals);
  const capable = { ...f.manifest, restore_isolation_protocol: 'relay-restore-isolation-v1' };
  const publish = () => writeFile(join(f.root, 'desktop-build-manifest.json'), JSON.stringify(capable));
  const refs = ['api/dist/src/main.js', 'api/dist/src/worker/main.js', 'api/dist/src/worker/supervisor-main.js'];
  const body = "import '../runtime/restore-isolation.js'; await assertRestoreNotIsolated(dataRoot);";
  for (const ref of refs) { await writeFile(join(f.root, ref), body); f.manifest.resource_file_sha256[ref] = hash(body); }
  await publish(); await verifyRestoreRuntimePackage(f.root);
  await writeFile(join(f.root, refs[2]!), 'no guard'); f.manifest.resource_file_sha256[refs[2]!] = hash('no guard');
  await publish(); await assert.rejects(verifyRestoreRuntimePackage(f.root), refused);
});
