import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { createFirstPartyRegistry, inspectFrozenSkillSnapshot,
  type FirstPartyRegistryArchive, type FrozenSkill, type PackDefinition,
  type RegistryDependency } from '../skills/first-party-registry.js';
import { assertBackupWindowsPaths } from './backup-paths.js';
import { DESKTOP_MAINTENANCE_PROTOCOL } from './desktop-maintenance-session.js';

const HASH = /^[0-9a-f]{64}$/u;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 256n * 1024n * 1024n;
const MANIFEST = 'desktop-build-manifest.json';
const REGISTRY_MODULE = 'api/dist/src/skills/first-party-registry.js';
const TOP_LEVEL = ['api', 'desktop-build-manifest.json', 'licenses', 'node.exe',
  'relay-desktop.exe', 'relay-file-io-helper.exe'];
const REQUIRED = ['node.exe', 'relay-file-io-helper.exe', 'api/package.json', REGISTRY_MODULE,
  'api/dist/src/receipt/payload-hash.js', 'api/dist/src/main.js',
  'api/dist/src/worker/main.js', 'api/dist/src/worker/supervisor-main.js',
  'api/dist/src/runtime/database-connect-fence.js', 'api/migrations/0001_v001_human_core.sql',
  'api/migrations/0048_m07_admission_gate.sql'];

export class BackupPackageError extends Error {
  override readonly name = 'BackupPackageError';
  constructor(readonly code = 'BACKUP_PACKAGE_INVALID') { super(code); }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}
function canonical(value: unknown): string {
  return canonicalizeJson(value as JsonObject);
}

/** Rebuild hashes from archived bodies, never from the coordinating application's newer registry. */
export function inspectBackupRegistryArchive(value: unknown): FirstPartyRegistryArchive {
  try {
    if (!exact(value, ['skills', 'packs']) || !Array.isArray(value.skills) ||
        value.skills.length === 0 || value.skills.length > 16 || !Array.isArray(value.packs) ||
        value.packs.length === 0 || value.packs.length > 8) throw new Error();
    const skills: FrozenSkill[] = [];
    const dependencies = new Map<string, RegistryDependency>();
    const skillKeys = new Set<string>();
    for (const entry of value.skills) {
      if (!object(entry) || inspectFrozenSkillSnapshot(entry as JsonObject) === null) throw new Error();
      const skill = entry as unknown as FrozenSkill;
      if (!exact(skill.definition, ['id', 'version', 'title', 'target', 'output_kind',
        'availability', 'required_capabilities', 'instructions', 'dependency_refs']) ||
          typeof skill.definition.title !== 'string' || typeof skill.definition.instructions !== 'string' ||
          !Array.isArray(skill.definition.dependency_refs) || skill.definition.dependency_refs.length > 32 ||
          !['task-to-execution-contract', 'project-resume', 'verification-plan',
            'goal-to-project-blueprint'].includes(skill.id)) throw new Error();
      const key = `${skill.id}@${skill.version}`;
      if (skillKeys.has(key)) throw new Error();
      skillKeys.add(key);
      skills.push(skill);
      for (const dependency of skill.dependencies) {
        const depKey = `${dependency.kind}:${dependency.id}@${dependency.version}`;
        const definition = { kind: dependency.kind, id: dependency.id,
          version: dependency.version, definition: dependency.definition };
        if (dependencies.has(depKey) && canonical(dependencies.get(depKey)) !== canonical(definition)) {
          throw new Error();
        }
        dependencies.set(depKey, definition);
      }
    }
    const packs: FirstPartyRegistryArchive['packs'][number][] = [];
    const packKeys = new Set<string>();
    for (const entry of value.packs) {
      if (!exact(entry, ['definition', 'sha256', 'members']) || typeof entry.sha256 !== 'string' ||
          !HASH.test(entry.sha256) || !exact(entry.definition, ['id', 'version', 'title',
            'host_contract', 'members']) || !Array.isArray(entry.definition.members) ||
          !Array.isArray(entry.members) || entry.members.length === 0 || entry.members.length > 8 ||
          entry.definition.members.length !== entry.members.length ||
          !['thesis-minimal', 'development-minimal'].includes(String(entry.definition.id)) ||
          typeof entry.definition.version !== 'string' ||
          !/^\d+\.\d+\.\d+$/u.test(entry.definition.version) ||
          typeof entry.definition.title !== 'string') throw new Error();
      const definition = entry.definition as unknown as PackDefinition;
      const key = `${definition.id}@${definition.version}`;
      if (packKeys.has(key)) throw new Error();
      packKeys.add(key);
      for (let i = 0; i < entry.members.length; i++) {
        const member = entry.members[i];
        const ref = definition.members[i];
        if (!exact(ref, ['kind', 'id', 'version']) || ref.kind !== 'SKILL' ||
            !object(member) || member.id !== ref.id || member.version !== ref.version ||
            canonical(member) !== canonical(skills.find(skill =>
              skill.id === ref.id && skill.version === ref.version))) throw new Error();
      }
      packs.push(entry as unknown as FirstPartyRegistryArchive['packs'][number]);
    }
    const rebuilt = createFirstPartyRegistry([...dependencies.values()],
      skills.map(skill => skill.definition), packs.map(pack => pack.definition));
    for (const skill of skills) {
      if (canonical(rebuilt.skill(skill.id, skill.version)) !== canonical(skill)) throw new Error();
    }
    for (const pack of packs) {
      if (rebuilt.pack(pack.definition.id, pack.definition.version)?.sha256 !== pack.sha256) throw new Error();
    }
    return structuredClone({ skills, packs });
  } catch { throw new BackupPackageError('BACKUP_REGISTRY_INVALID'); }
}

function safeSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\x00-\x1f<>:"/\\|?*]/u.test(name) &&
    !/[. ]$/u.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/iu.test(name);
}
function safeRef(ref: string): boolean {
  return ref.split('/').every(safeSegment) && !isAbsolute(ref);
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;
}

async function ancestors(root: string): Promise<string[]> {
  if (!isAbsolute(root) || resolve(root) !== root || root.startsWith('\\\\')) throw new Error();
  const result: string[] = [];
  for (let current = root;; current = dirname(current)) {
    result.unshift(current);
    if (current === parse(current).root) break;
    if (!safeSegment(basename(current))) throw new Error();
  }
  await assertBackupWindowsPaths(result);
  for (const current of result) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  }
  return result;
}

async function inventory(root: string, deadline: number): Promise<Map<string, BigIntStats>> {
  const entries = new Map<string, BigIntStats>();
  const folded = new Set<string>();
  let refBytes = 0;
  let pending = [''];
  while (pending.length !== 0) {
    if (Date.now() > deadline || entries.size + pending.length > MAX_FILES) throw new Error();
    await assertBackupWindowsPaths(pending.map(ref => ref === '' ? root : join(root, ...ref.split('/'))));
    const next: string[] = [];
    for (const ref of pending) {
      if (Date.now() > deadline) throw new Error();
      const file = ref === '' ? root : join(root, ...ref.split('/'));
      const stat = await lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
          (stat.isFile() && (stat.nlink !== 1n || stat.size > MAX_FILE_BYTES))) throw new Error();
      if (await realpath(file) !== file || relative(root, file).startsWith(`..${sep}`)) throw new Error();
      entries.set(ref, stat);
      if (stat.isDirectory()) {
        for (const name of (await readdir(file)).sort()) {
          const child = ref === '' ? name : `${ref}/${name}`;
          if (!safeSegment(name) || folded.has(child.toLowerCase()) ||
              /^\.env(?:\.|$)/iu.test(name) || /\.(?:pem|key)$/iu.test(name)) throw new Error();
          folded.add(child.toLowerCase());
          refBytes += Buffer.byteLength(child);
          if (refBytes > 16 * 1024 * 1024) throw new Error();
          next.push(child);
          if (entries.size + next.length > MAX_FILES) throw new Error();
        }
      }
    }
    pending = next;
  }
  return entries;
}

async function readChecked(file: string, expected: BigIntStats, collect: boolean): Promise<{
  sha256: string; bytes: Buffer;
}> {
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let count = 0n;
  try {
    if (!same(expected, await handle.stat({ bigint: true }))) throw new Error();
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      const bytes = chunk as Buffer;
      count += BigInt(bytes.length);
      if (count > expected.size) throw new Error();
      hash.update(bytes);
      if (collect) chunks.push(bytes);
    }
    if (count !== expected.size || !same(expected, await handle.stat({ bigint: true })) ||
        !same(expected, await lstat(file, { bigint: true }))) throw new Error();
    return { sha256: hash.digest('hex'), bytes: collect ? Buffer.concat(chunks) : Buffer.alloc(0) };
  } finally { await handle.close(); }
}

async function exportPackageRegistry(moduleFile: string): Promise<FirstPartyRegistryArchive> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const script = "import {pathToFileURL} from 'node:url';" +
    "try { const m=await import(pathToFileURL(process.argv[1]).href);" +
    "if(typeof m.exportFirstPartyRegistryArchive!=='function') process.exit(1);" +
    "process.stdout.write(JSON.stringify(m.exportFirstPartyRegistryArchive())); } catch { process.exit(1); }";
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, moduleFile],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const fail = () => { failed = true; child.kill(); };
    const timer = setTimeout(fail, 10_000);
    child.once('error', fail);
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) fail();
      else output.push(chunk);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try {
        if (failed || code !== 0 || signal !== null) throw new Error();
        resolveResult(inspectBackupRegistryArchive(JSON.parse(Buffer.concat(output).toString('utf8'))));
      } catch { reject(new BackupPackageError('BACKUP_REGISTRY_INVALID')); }
    });
  });
}

/** Local trusted package verification. Hashes bind content; they are not a publisher signature. */
export async function verifyBackupPackage(packageRoot: string): Promise<{
  manifestHash: string; artifactHash: string; nodeVersion: string;
  resourceHashes: Readonly<Record<string, string>>; registry: FirstPartyRegistryArchive;
}> {
  try {
    if (process.platform !== 'win32') throw new Error();
    const deadline = Date.now() + 5 * 60_000;
    const parentPaths = await ancestors(packageRoot);
    const before = await inventory(packageRoot, deadline);
    const manifestStat = before.get(MANIFEST);
    if (manifestStat === undefined || !manifestStat.isFile() || manifestStat.size > 8n * 1024n * 1024n ||
        [...before.keys()].filter(ref => ref !== '' && !ref.includes('/')).sort().join('|') !==
          TOP_LEVEL.join('|')) throw new Error();
    const raw = await readChecked(join(packageRoot, MANIFEST), manifestStat, true);
    const manifest: unknown = JSON.parse(raw.bytes.toString('utf8').replace(/^\uFEFF/u, ''));
    if (!object(manifest) || manifest.schema_version !== 1 ||
        manifest.maintenance_session_protocol !== DESKTOP_MAINTENANCE_PROTOCOL ||
        typeof manifest.artifact_sha256 !== 'string' || !HASH.test(manifest.artifact_sha256) ||
        typeof manifest.node_version !== 'string' || !/^v24\.\d+\.\d+$/u.test(manifest.node_version) ||
        manifest.forbidden_config_files !== 0 || !object(manifest.resource_file_sha256) ||
        !Array.isArray(manifest.resource_inventory)) throw new Error();
    const resources: Record<string, string> = Object.create(null) as Record<string, string>;
    const folded = new Set<string>();
    for (const [ref, hash] of Object.entries(manifest.resource_file_sha256)) {
      if (!safeRef(ref) || !['api', 'licenses', 'node.exe', 'relay-file-io-helper.exe'].includes(ref.split('/')[0]!) ||
          typeof hash !== 'string' || !HASH.test(hash) || folded.has(ref.toLowerCase())) throw new Error();
      resources[ref] = hash;
      folded.add(ref.toLowerCase());
    }
    if (REQUIRED.some(ref => !Object.hasOwn(resources, ref))) throw new Error();
    const expected: Record<string, string> = { ...resources, 'relay-desktop.exe': manifest.artifact_sha256 };
    const fileRefs = [...before].filter(([ref, stat]) => ref !== MANIFEST && stat.isFile()).map(([ref]) => ref).sort();
    if (fileRefs.join('|') !== Object.keys(expected).sort().join('|') ||
        [...before.keys()].filter(ref => ref.startsWith('api/') && ref.split('/').length === 2)
          .map(ref => ref.slice(4)).sort().join('|') !== [...manifest.resource_inventory].sort().join('|')) {
      throw new Error();
    }
    for (const ref of fileRefs) {
      if (Date.now() > deadline || (await readChecked(join(packageRoot, ...ref.split('/')),
        before.get(ref)!, false)).sha256 !== expected[ref]) throw new Error();
    }
    const registry = await exportPackageRegistry(join(packageRoot, ...REGISTRY_MODULE.split('/')));
    const after = await inventory(packageRoot, deadline);
    if ([...before.keys()].sort().join('|') !== [...after.keys()].sort().join('|') ||
        [...before].some(([ref, stat]) => !same(stat, after.get(ref)!))) throw new Error();
    // Recheck every byte after executing the package's export; a module must not alter its package.
    for (const ref of [MANIFEST, ...fileRefs]) {
      if (Date.now() > deadline || (await readChecked(join(packageRoot, ...ref.split('/')),
        before.get(ref)!, false)).sha256 !== (ref === MANIFEST ? raw.sha256 : expected[ref])) throw new Error();
    }
    await assertBackupWindowsPaths(parentPaths);
    if (Date.now() > deadline) throw new Error();
    return { manifestHash: raw.sha256, artifactHash: manifest.artifact_sha256,
      nodeVersion: manifest.node_version, resourceHashes: resources, registry };
  } catch (error) {
    if (error instanceof BackupPackageError) throw error;
    throw new BackupPackageError();
  }
}

/** Source packages retain their old historical contract; restore runtimes need every new startup guard. */
export async function verifyRestoreRuntimePackage(packageRoot: string): Promise<Awaited<ReturnType<typeof verifyBackupPackage>>> {
  try {
    const verified = await verifyBackupPackage(packageRoot);
    const refs = ['api/dist/src/main.js', 'api/dist/src/worker/main.js',
      'api/dist/src/worker/supervisor-main.js'];
    const moduleRef = 'api/dist/src/runtime/restore-isolation.js';
    if (![...refs, moduleRef].every(ref => Object.hasOwn(verified.resourceHashes, ref))) throw new Error();
    const read = async (ref: string, expected: string): Promise<Buffer> => {
      const path = join(packageRoot, ...ref.split('/'));
      await assertBackupWindowsPaths([path]);
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > MAX_FILE_BYTES) throw new Error();
      const result = await readChecked(path, stat, true);
      if (result.sha256 !== expected) throw new Error(); return result.bytes;
    };
    const manifest = JSON.parse((await read(MANIFEST, verified.manifestHash)).toString('utf8').replace(/^\uFEFF/u, ''));
    if (manifest.restore_isolation_protocol !== 'relay-restore-isolation-v1') throw new Error();
    const native = await read('relay-desktop.exe', verified.artifactHash);
    const module = await read(moduleRef, verified.resourceHashes[moduleRef]!);
    for (const literal of ['restore-isolation.json', 'RESTORE_ISOLATED', 'RESTORE_ISOLATION_UNAVAILABLE']) {
      if (!native.includes(Buffer.from(literal)) || !module.includes(Buffer.from(literal))) throw new Error();
    }
    for (const ref of refs) {
      const text = (await read(ref, verified.resourceHashes[ref]!)).toString('utf8');
      if (!text.includes('runtime/restore-isolation.js') || !text.includes('await assertRestoreNotIsolated(')) throw new Error();
    }
    return verified;
  } catch { throw new BackupPackageError('RESTORE_RUNTIME_PACKAGE_INVALID'); }
}
