import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { assertBackupWindowsPaths, BackupWindowsPathsError } from './backup-paths.js';

const MAX_FILES = 100_000;
const MAX_ENTRIES = 200_000;
const MAX_REF_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_ARMED_BYTES = 64 * 1024;
const ERROR_CODES = ['BACKUP_INVALID_PATH', 'BACKUP_ROOT_OVERLAP', 'BACKUP_UNSAFE_ENTRY',
  'BACKUP_HARD_LINK', 'BACKUP_ALTERNATE_STREAM', 'BACKUP_UNMANAGED_DATA', 'BACKUP_TARGET_EXISTS',
  'BACKUP_FILE_LIMIT', 'BACKUP_ENTRY_LIMIT', 'BACKUP_SIZE_LIMIT', 'BACKUP_SOURCE_CHANGED',
  'BACKUP_TARGET_CHANGED', 'BACKUP_LOCK_LOST', 'BACKUP_METADATA_UNAVAILABLE', 'BACKUP_IO_FAILED'] as const;
type BackupFilesErrorCode = typeof ERROR_CODES[number];

export class BackupFilesError extends Error {
  override readonly name = 'BackupFilesError';
  readonly code: BackupFilesErrorCode;
  constructor(code: BackupFilesErrorCode = 'BACKUP_IO_FAILED') {
    const safe = ERROR_CODES.includes(code) ? code : 'BACKUP_IO_FAILED';
    super(safe);
    this.code = safe;
  }
}

export interface BackupDataFile {
  readonly source_ref: string;
  readonly backup_ref: string;
  readonly kind: 'CONTENT' | 'STAGING' | 'ARMED';
  readonly size: string;
  readonly sha256: string;
}

interface Entry { readonly path: string; readonly ref: string; readonly stat: BigIntStats }
interface SourceFile extends Entry { readonly kind: BackupDataFile['kind'] }
interface Inventory { readonly entries: Map<string, Entry>; readonly files: SourceFile[] }

function fail(code: BackupFilesErrorCode): never { throw new BackupFilesError(code); }
function key(path: string): string { return path.replaceAll('\\', '/').toLowerCase(); }
function safeSegment(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && value.length <= 255 &&
    !/[<>:"/\\|?*\x00-\x1f]/u.test(value) && !/[. ]$/u.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/iu.test(value);
}
function absoluteRoot(value: string): string {
  if (!isAbsolute(value) || value.includes('\0') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/iu.test(value))) fail('BACKUP_INVALID_PATH');
  const root = parse(value).root;
  const tail = value.slice(root.length).replace(/[\\/]$/u, '');
  if (tail !== '' && tail.split(/[\\/]/u).some((segment) => !safeSegment(segment))) fail('BACKUP_INVALID_PATH');
  return resolve(value);
}
function identity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && a.nlink === b.nlink && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function inspect(path: string, ref: string): Promise<Entry> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('BACKUP_UNSAFE_ENTRY');
  if (stat.isFile() && stat.nlink !== 1n) fail('BACKUP_HARD_LINK');
  if (key(await realpath(path)) !== key(path)) fail('BACKUP_INVALID_PATH');
  return { path, ref, stat };
}
async function ancestors(path: string): Promise<Entry[]> {
  const chain: string[] = [];
  for (let current = path;; current = dirname(current)) {
    chain.unshift(current);
    if (dirname(current) === current) break;
  }
  // The Windows probe walks these supplied paths in order and stops at a reparse ancestor.
  await assertBackupWindowsPaths(chain);
  const result: Entry[] = [];
  for (const current of chain) {
    const entry = await inspect(current, '');
    if (!entry.stat.isDirectory()) fail('BACKUP_UNSAFE_ENTRY');
    result.push(entry);
  }
  return result;
}
async function checkAncestors(entries: readonly Entry[], code: BackupFilesErrorCode = 'BACKUP_SOURCE_CHANGED'): Promise<void> {
  for (const entry of entries) {
    const current = await inspect(entry.path, entry.ref);
    if (!identity(entry.stat, current.stat)) fail(code);
  }
}

/** Only metadata is read. Unknown root names are rejected before lstat or traversal. */
async function inventory(root: string): Promise<Inventory> {
  const entries = new Map<string, Entry>();
  const files: SourceFile[] = [];
  let refBytes = 0;
  const add = (entry: Entry) => {
    if (entries.size >= MAX_ENTRIES) fail('BACKUP_ENTRY_LIMIT');
    refBytes += Buffer.byteLength(entry.ref);
    if (refBytes > MAX_REF_BYTES) fail('BACKUP_ENTRY_LIMIT');
    if (entries.has(key(entry.ref))) fail('BACKUP_INVALID_PATH');
    entries.set(key(entry.ref), entry);
  };
  add(await inspect(root, ''));
  type Pending = { entry: Entry; kind: BackupDataFile['kind'] | 'EMPTY'; depth: number };
  let pending: Pending[] = [];
  const directory = await opendir(root);
  for await (const child of directory) {
    const kinds: Record<string, BackupDataFile['kind']> = {
      artifacts: 'CONTENT', staging: 'STAGING', 'runtime-launches': 'ARMED',
    };
    const kind = Object.hasOwn(kinds, child.name) ? kinds[child.name] : undefined;
    if (kind === undefined && !['logs', '.relay-content-admission.lock', 'knowledge', 'runtime-workspaces'].includes(child.name)) {
      fail('BACKUP_UNMANAGED_DATA');
    }
    const entry = await inspect(join(root, child.name), child.name);
    add(entry);
    if (child.name === '.relay-content-admission.lock') {
      if (!entry.stat.isFile()) fail('BACKUP_UNSAFE_ENTRY');
    } else {
      if (!entry.stat.isDirectory()) fail('BACKUP_UNSAFE_ENTRY');
      if (kind !== undefined) pending.push({ entry, kind, depth: 1 });
      else if (child.name !== 'logs') pending.push({ entry, kind: 'EMPTY', depth: 1 });
    }
  }
  await assertBackupWindowsPaths([...entries.values()].map((entry) => entry.path));
  while (pending.length !== 0) {
    const next: Pending[] = [];
    const discovered: Entry[] = [];
    for (const { entry: parent, kind, depth } of pending) {
      if (depth > 64) fail('BACKUP_ENTRY_LIMIT');
      await checkEntry(parent, 'BACKUP_SOURCE_CHANGED');
      const children = await opendir(parent.path);
      for await (const child of children) {
        if (kind === 'EMPTY') fail('BACKUP_UNMANAGED_DATA');
        if (!safeSegment(child.name)) fail('BACKUP_INVALID_PATH');
        const entry = await inspect(join(parent.path, child.name), `${parent.ref}/${child.name}`);
        add(entry);
        discovered.push(entry);
        if (entry.stat.isDirectory()) {
          if (kind === 'ARMED') fail('BACKUP_UNMANAGED_DATA');
          next.push({ entry, kind, depth: depth + 1 });
        } else {
          if (kind === 'ARMED' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(child.name)) {
            fail('BACKUP_UNMANAGED_DATA');
          }
          if (files.length >= MAX_FILES) fail('BACKUP_FILE_LIMIT');
          if (entry.stat.size > BigInt(kind === 'ARMED' ? MAX_ARMED_BYTES : MAX_CONTENT_BYTES)) fail('BACKUP_SIZE_LIMIT');
          files.push({ ...entry, kind });
        }
      }
    }
    // Reject every tag and stream before opening a discovered directory or reading a file.
    if (discovered.length !== 0) await assertBackupWindowsPaths(discovered.map((entry) => entry.path));
    pending = next;
  }
  return { entries, files: files.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) };
}

function checkInventory(before: Inventory, after: Inventory): void {
  if (before.entries.size !== after.entries.size || before.files.length !== after.files.length) fail('BACKUP_SOURCE_CHANGED');
  for (const [ref, entry] of before.entries) {
    const current = after.entries.get(ref);
    // Logs and the admission sentinel are excluded operational data, checked for identity only.
    const same = ['logs', '.relay-content-admission.lock'].includes(entry.ref) ? identity : unchanged;
    if (current === undefined || current.ref !== entry.ref || !same(entry.stat, current.stat)) fail('BACKUP_SOURCE_CHANGED');
  }
}

async function held(assertHeld: () => Promise<void>): Promise<void> {
  try { await assertHeld(); } catch { fail('BACKUP_LOCK_LOST'); }
}
async function checkEntry(entry: Entry, code: BackupFilesErrorCode): Promise<void> {
  const current = await inspect(entry.path, entry.ref);
  if (!unchanged(entry.stat, current.stat)) fail(code);
}
async function hashHandle(handle: FileHandle, limit: number, target?: FileHandle): Promise<{ size: string; sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let size = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (bytesRead === 0) break;
    size += bytesRead;
    if (size > limit) fail('BACKUP_SIZE_LIMIT');
    hash.update(buffer.subarray(0, bytesRead));
    if (target !== undefined) {
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written);
        if (result.bytesWritten === 0) fail('BACKUP_IO_FAILED');
        written += result.bytesWritten;
      }
    }
  }
  return { size: String(size), sha256: hash.digest('hex') };
}
async function hashFile(entry: Entry, limit: number, code: BackupFilesErrorCode = 'BACKUP_SOURCE_CHANGED'): Promise<{ size: string; sha256: string }> {
  await checkEntry(entry, code);
  const handle = await open(entry.path, 'r');
  try {
    if (!unchanged(entry.stat, await handle.stat({ bigint: true }))) fail(code);
    const result = await hashHandle(handle, limit);
    if (!unchanged(entry.stat, await handle.stat({ bigint: true })) || result.size !== String(entry.stat.size)) {
      fail(code);
    }
    await checkEntry(entry, code);
    return result;
  } finally { await handle.close(); }
}

/** Copies current managed files and evidence only; it does not declare a frozen or complete backup. */
export async function copyBackupData(input: { dataRoot: string; backupRoot: string;
  assertHeld: () => Promise<void> }): Promise<readonly BackupDataFile[]> {
  try {
    await held(input.assertHeld);
    const source = absoluteRoot(input.dataRoot);
    const destination = absoluteRoot(input.backupRoot);
    const overlaps = (a: string, b: string) => key(a) === key(b) || key(b).startsWith(`${key(a).replace(/\/$/u, '')}/`);
    if (overlaps(source, destination) || overlaps(destination, source)) fail('BACKUP_ROOT_OVERLAP');
    const sourceParents = await ancestors(source);
    const targetParents = await ancestors(destination);
    const before = await inventory(source);
    await assertBackupWindowsPaths([...sourceParents, ...targetParents, ...before.entries.values()].map((entry) => entry.path));
    const targetDirectories = new Map<string, Entry>();
    const createDirectory = async (path: string): Promise<void> => {
      if (targetDirectories.has(key(path))) return;
      await checkAncestors(targetParents, 'BACKUP_TARGET_CHANGED');
      try { await mkdir(path); }
      catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') fail('BACKUP_TARGET_EXISTS');
        throw error;
      }
      targetDirectories.set(key(path), await inspect(path, ''));
    };
    await createDirectory(join(destination, 'data'));
    await createDirectory(join(destination, 'evidence'));
    const manifest: BackupDataFile[] = [];
    const copied: Entry[] = [];
    for (const file of before.files) {
      await held(input.assertHeld);
      await checkAncestors(sourceParents);
      await checkAncestors(targetParents, 'BACKUP_TARGET_CHANGED');
      const sourceDirectories: Entry[] = [before.entries.get('')!];
      const sourceSegments = file.ref.split('/');
      for (let depth = 1; depth < sourceSegments.length; depth++) {
        const entry = before.entries.get(key(sourceSegments.slice(0, depth).join('/')));
        if (entry === undefined || !entry.stat.isDirectory()) fail('BACKUP_SOURCE_CHANGED');
        sourceDirectories.push(entry);
      }
      await checkAncestors(sourceDirectories);
      const segments = file.ref.split('/');
      let parent = join(destination, file.kind === 'CONTENT' ? 'data' : 'evidence');
      for (const segment of segments.slice(0, -1)) {
        const previous = targetDirectories.get(key(parent));
        if (previous === undefined || !identity(previous.stat, (await inspect(parent, '')).stat)) fail('BACKUP_TARGET_CHANGED');
        parent = join(parent, segment);
        await createDirectory(parent);
      }
      const target = join(parent, segments.at(-1)!);
      await checkEntry(file, 'BACKUP_SOURCE_CHANGED');
      const reader = await open(file.path, 'r');
      try {
        if (!unchanged(file.stat, await reader.stat({ bigint: true }))) fail('BACKUP_SOURCE_CHANGED');
        let writer: FileHandle;
        try { writer = await open(target, 'wx'); }
        catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') fail('BACKUP_TARGET_EXISTS');
          throw error;
        }
        try {
          const result = await hashHandle(reader, file.kind === 'ARMED' ? MAX_ARMED_BYTES : MAX_CONTENT_BYTES, writer);
          await writer.sync();
          const targetStat = await writer.stat({ bigint: true });
          if (!targetStat.isFile() || targetStat.nlink !== 1n || String(targetStat.size) !== result.size) fail('BACKUP_TARGET_CHANGED');
          const targetEntry = await inspect(target, '');
          if (!unchanged(targetStat, targetEntry.stat)) fail('BACKUP_TARGET_CHANGED');
          copied.push(targetEntry);
          if (!unchanged(file.stat, await reader.stat({ bigint: true })) || result.size !== String(file.stat.size)) fail('BACKUP_SOURCE_CHANGED');
          await checkEntry(file, 'BACKUP_SOURCE_CHANGED');
          await checkAncestors(sourceDirectories);
          manifest.push({ source_ref: file.ref, backup_ref: relative(destination, target).split(sep).join('/'),
            kind: file.kind, ...result });
        } finally { await writer.close(); }
      } finally { await reader.close(); }
      await held(input.assertHeld);
    }
    const after = await inventory(source);
    checkInventory(before, after);
    await assertBackupWindowsPaths([...sourceParents, ...targetParents, ...after.entries.values(),
      ...targetDirectories.values(), ...copied].map((entry) => entry.path));
    for (let i = 0; i < before.files.length; i++) {
      const file = before.files[i]!;
      const expected = manifest[i]!;
      const actual = await hashFile(file, file.kind === 'ARMED' ? MAX_ARMED_BYTES : MAX_CONTENT_BYTES);
      const target = await hashFile(copied[i]!, file.kind === 'ARMED' ? MAX_ARMED_BYTES : MAX_CONTENT_BYTES, 'BACKUP_TARGET_CHANGED');
      if (actual.size !== expected.size || actual.sha256 !== expected.sha256) fail('BACKUP_SOURCE_CHANGED');
      if (target.size !== expected.size || target.sha256 !== expected.sha256) fail('BACKUP_TARGET_CHANGED');
      await held(input.assertHeld);
    }
    checkInventory(before, await inventory(source));
    await checkAncestors(sourceParents);
    await checkAncestors(targetParents, 'BACKUP_TARGET_CHANGED');
    await checkAncestors([...targetDirectories.values()], 'BACKUP_TARGET_CHANGED');
    await held(input.assertHeld);
    return manifest;
  } catch (error) {
    if (error instanceof BackupFilesError) throw error;
    if (error instanceof BackupWindowsPathsError) throw new BackupFilesError(error.code);
    throw new BackupFilesError();
  }
}
