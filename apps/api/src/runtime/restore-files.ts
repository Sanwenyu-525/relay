import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import { assertBackupWindowsPaths } from './backup-paths.js';
import { RESTORE_ISOLATION_MARKER } from './restore-isolation.js';
import { CONTENT_IDENTITY } from '../storage/windows-content-publisher.js';

export class RestoreFilesError extends Error {
  override readonly name = 'RestoreFilesError';
  constructor(readonly code = 'RESTORE_FILES_UNAVAILABLE') { super(code); }
}
export interface RestoreFile { readonly ref: string; readonly size: string; readonly sha256: string }
const fail = (code: string): never => { throw new RestoreFilesError(code); };
const key = (value: string) => value.toLowerCase();
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.birthtimeNs === b.birthtimeNs;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export function safeRestoreRef(ref: string): boolean {
  return ref.length > 0 && ref.split('/').length <= 64 && ref.split('/').every(part => part.length > 0 &&
    part.length <= 255 && part !== '.' && part !== '..' && !/[\x00-\x1f<>:"/\\|?*]/u.test(part) &&
    !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\.|$)/iu.test(part));
}
export function restoreRoot(value: string): string {
  if (!isAbsolute(value) || !/^[a-z]:[\\/]/iu.test(value)) fail('RESTORE_INVALID_PATH');
  const tail = value.slice(parse(value).root.length).replace(/[\\/]$/u, '').replaceAll('\\', '/');
  if (!safeRestoreRef(tail)) fail('RESTORE_INVALID_PATH');
  return resolve(value);
}
async function entry(path: string): Promise<BigIntStats> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1n) || key(await realpath(path)) !== key(path)) fail('RESTORE_UNSAFE_ENTRY');
  return stat;
}
export async function plainRestoreDirectory(root: string): Promise<void> {
  const paths: string[] = [];
  for (let current = root;; current = dirname(current)) {
    paths.unshift(current); if (current === dirname(current)) break;
  }
  await assertBackupWindowsPaths(paths);
  for (const path of paths) if (!(await entry(path)).isDirectory()) fail('RESTORE_INVALID_PATH');
}
async function parents(root: string, ref: string): Promise<string> {
  if (!safeRestoreRef(ref)) fail('RESTORE_INVALID_PATH');
  const path = join(root, ...ref.split('/'));
  await plainRestoreDirectory(dirname(path));
  await assertBackupWindowsPaths([path]);
  return path;
}
async function readChecked(root: string, ref: string, maximum: bigint,
  signal: AbortSignal, target?: FileHandle): Promise<{ size: string; sha256: string; bytes?: Buffer }> {
  const path = await parents(root, ref), before = await entry(path);
  if (!before.isFile() || before.size > maximum) fail('RESTORE_FILE_LIMIT');
  const file = await open(path, 'r');
  try {
    if (!unchanged(before, await file.stat({ bigint: true }))) fail('RESTORE_FILES_CHANGED');
    const hash = createHash('sha256'), chunks: Buffer[] = [], buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, count);
      if (bytesRead === 0) break;
      count += bytesRead; if (BigInt(count) > before.size || BigInt(count) > maximum) fail('RESTORE_FILE_LIMIT');
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
      if (target !== undefined) {
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(chunk, written, bytesRead - written);
          if (result.bytesWritten === 0) fail('RESTORE_FILES_CHANGED'); written += result.bytesWritten;
        }
      } else if (maximum <= 24n * 1024n * 1024n) chunks.push(Buffer.from(chunk));
    }
    if (String(count) !== String(before.size) || !unchanged(before, await file.stat({ bigint: true })) ||
        !unchanged(before, await entry(path))) fail('RESTORE_FILES_CHANGED');
    return { size: String(count), sha256: hash.digest('hex'), ...(target === undefined && chunks.length > 0 ?
      { bytes: Buffer.concat(chunks) } : {}) };
  } finally { await file.close(); }
}
export async function readRestoreMetadata(root: string, ref: string, signal: AbortSignal): Promise<Buffer> {
  return (await readChecked(root, ref, 24n * 1024n * 1024n, signal)).bytes ?? Buffer.alloc(0);
}
export async function verifyRestoreFiles(root: string, files: readonly RestoreFile[], signal: AbortSignal,
  assertHeld: () => Promise<void>): Promise<void> {
  for (const file of files) {
    await assertHeld();
    const actual = await readChecked(root, file.ref, BigInt(file.size), signal);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size) fail('RESTORE_FILES_CHANGED');
    await assertHeld();
  }
}
/** Reject extra files and directories before consuming the restore archive. */
export async function assertRestoreInventory(root: string, expectedFiles: readonly string[]): Promise<void> {
  await plainRestoreDirectory(root);
  const files = new Set(expectedFiles), dirs = new Set(['', 'data', 'evidence', 'maintenance']);
  for (const ref of files) {
    if (!safeRestoreRef(ref)) fail('RESTORE_INVALID_PATH');
    const parts = ref.split('/'); for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'));
  }
  const found = new Set<string>(); let count = 0, bytes = 0; const pending = [''];
  while (pending.length > 0) {
    const ref = pending.pop()!, path = ref === '' ? root : await parents(root, ref);
    if (++count > 200_000 || (bytes += Buffer.byteLength(ref)) > 16 * 1024 * 1024) fail('RESTORE_FILE_LIMIT');
    const item = await entry(path);
    if (item.isDirectory()) {
      if (!dirs.has(ref)) fail('RESTORE_UNLISTED_ENTRY');
      const children = await opendir(path);
      for await (const child of children) pending.push(ref === '' ? child.name : `${ref}/${child.name}`);
    } else {
      if (!files.has(ref)) fail('RESTORE_UNLISTED_ENTRY'); found.add(ref);
    }
  }
  if (found.size !== files.size) fail('RESTORE_FILES_MISSING');
}
export async function writeRestoreMetadata(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 24 * 1024 * 1024) fail('RESTORE_FILE_LIMIT');
  restoreRoot(path);
  const parent = dirname(path); await plainRestoreDirectory(parent);
  const parentId = await entry(parent);
  const file = await open(path, 'wx', 0o600);
  try {
    const created = await file.stat({ bigint: true });
    const check = async () => {
      await plainRestoreDirectory(parent); await assertBackupWindowsPaths([path]);
      if (!same(parentId, await entry(parent)) || !same(created, await file.stat({ bigint: true })) ||
          !same(created, await entry(path))) fail('RESTORE_FILES_CHANGED');
    };
    await check(); await file.writeFile(bytes); await file.sync(); await check();
    if (!(await readRestoreMetadata(parent, basename(path), new AbortController().signal)).equals(bytes)) fail('RESTORE_FILES_CHANGED');
    await check();
  } finally { await file.close(); }
}
/** Publish a new root only after its first marker has been written and synced. */
export async function prepareRestoreRoot(root: string, operationId: string, marker: unknown): Promise<() => Promise<void>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) fail('RESTORE_INVALID_PATH');
  const parent = dirname(root); await plainRestoreDirectory(parent); const before = await entry(parent);
  try { await lstat(root); fail('RESTORE_TARGET_EXISTS'); }
  catch (error) { if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  const staging = join(parent, `.relay-restore-${operationId}`); await mkdir(staging);
  await writeRestoreMetadata(join(staging, RESTORE_ISOLATION_MARKER), marker);
  if (!same(before, await entry(parent))) fail('RESTORE_FILES_CHANGED');
  await rename(staging, root); // Windows never replaces an existing directory with this rename.
  const rootId = await entry(root), markerBytes = await readRestoreMetadata(root, RESTORE_ISOLATION_MARKER, new AbortController().signal);
  return async () => {
    await plainRestoreDirectory(root);
    if (!same(before, await entry(parent)) || !same(rootId, await entry(root)) ||
        !(await readRestoreMetadata(root, RESTORE_ISOLATION_MARKER, new AbortController().signal)).equals(markerBytes)) {
      fail('RESTORE_FILES_CHANGED');
    }
  };
}
export async function copyRestoreFile(sourceRoot: string, source: RestoreFile, targetRoot: string, ref: string,
  signal: AbortSignal, assertHeld: () => Promise<void>): Promise<void> {
  if (!safeRestoreRef(ref)) fail('RESTORE_INVALID_PATH');
  const parts = ref.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const parent = join(targetRoot, ...parts.slice(0, depth));
    try { await mkdir(parent); }
    catch (error) { if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
    await plainRestoreDirectory(parent);
  }
  await assertHeld();
  const path = join(targetRoot, ...parts), target = await open(path, 'wx', 0o600);
  try {
    const actual = await readChecked(sourceRoot, source.ref, BigInt(source.size), signal, target);
    await target.sync();
    if (actual.size !== source.size || actual.sha256 !== source.sha256 ||
        !(await target.stat()).isFile()) fail('RESTORE_FILES_CHANGED');
  } finally { await target.close(); }
  await verifyRestoreFiles(targetRoot, [{ ...source, ref }], signal, assertHeld);
}

/** One read-only legacy request. Callers pin and verify the explicit helper before and after use. */
export async function inspectRestoreRootIdentity(input: {
  rootPath: string; helperExecutable: string; signal: AbortSignal; deadline: number;
}): Promise<string | null> {
  const { rootPath, helperExecutable, signal, deadline } = input;
  if (signal.aborted) fail('RESTORE_ROOT_INSPECT_ABORTED');
  if (!Number.isFinite(deadline) || Date.now() >= deadline) fail('RESTORE_ROOT_INSPECT_TIMEOUT');
  if (Buffer.byteLength(rootPath) > 4096 || rootPath.includes('\0')) fail('RESTORE_ROOT_INSPECT_INVALID');
  const bytes = await new Promise<Buffer>((done, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const child = spawn(helperExecutable, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, failure: string | undefined;
    const stop = (code: string) => {
      failure ??= code;
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    };
    const abort = () => stop('RESTORE_ROOT_INSPECT_ABORTED');
    const timer = setTimeout(() => stop('RESTORE_ROOT_INSPECT_TIMEOUT'), Math.min(10_000, Math.max(1, deadline - Date.now())));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 4096) stop('RESTORE_ROOT_INSPECT_OUTPUT_LIMIT');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4096) stop('RESTORE_ROOT_INSPECT_OUTPUT_LIMIT');
    });
    child.once('error', () => stop('RESTORE_ROOT_INSPECT_CHILD_FAILED'));
    child.stdin.once('error', () => stop('RESTORE_ROOT_INSPECT_CHILD_FAILED'));
    child.once('close', (code, endedSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failure !== undefined || code !== 0 || endedSignal !== null) {
        reject(new RestoreFilesError(failure ?? 'RESTORE_ROOT_INSPECT_CHILD_FAILED'));
      } else done(Buffer.concat(chunks));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.end(JSON.stringify({ version: 'relay-file-io-v1', op: 'inspect-root', root_path: rootPath }) + '\n');
  });
  if (signal.aborted) fail('RESTORE_ROOT_INSPECT_ABORTED');
  if (Date.now() >= deadline) fail('RESTORE_ROOT_INSPECT_TIMEOUT');
  try {
    const reply: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply) ||
        !('version' in reply) || reply.version !== 'relay-file-io-v1' || !('ok' in reply)) {
      throw new RestoreFilesError('RESTORE_ROOT_INSPECT_PROTOCOL');
    }
    if (reply.ok === true && 'root_id' in reply && typeof reply.root_id === 'string' && CONTENT_IDENTITY.test(reply.root_id) &&
        Object.keys(reply).every(name => ['version', 'ok', 'root_id', 'limits'].includes(name))) return reply.root_id;
    if (reply.ok === false && Object.keys(reply).sort().join(',') === 'error,ok,version' && 'error' in reply &&
        reply.error !== null && typeof reply.error === 'object' && !Array.isArray(reply.error) &&
        Object.keys(reply.error).sort().join(',') === 'code,message' && 'code' in reply.error &&
        typeof reply.error.code === 'string' && ['INVALID_ROOT', 'UNSAFE_ENTRY', 'ROOT_UNAVAILABLE',
          'IDENTITY_UNAVAILABLE', 'NT_OPEN_FAILED', 'ROOT_PATH_UNAVAILABLE', 'ROOT_PATH_CHANGED'].includes(reply.error.code) &&
        'message' in reply.error && typeof reply.error.message === 'string' && reply.error.message.length <= 2048) return null;
    throw new RestoreFilesError('RESTORE_ROOT_INSPECT_PROTOCOL');
  } catch { throw new RestoreFilesError('RESTORE_ROOT_INSPECT_PROTOCOL'); }
}

/** The caller supplies its verified helper and an absent target with an existing parent.
 * Historical File IDs detect a surviving source ancestor; they are not live ownership or relocation proof. */
export async function assertRestoreSourceRootSeparate(targetRoot: string, sourceRootId: string,
  helperExecutable: string, signal: AbortSignal): Promise<void> {
  const unavailable = 'RESTORE_SOURCE_ROOT_UNAVAILABLE';
  try {
    if (signal.aborted) fail('RESTORE_SOURCE_ROOT_ABORTED');
    if (process.platform !== 'win32' || !CONTENT_IDENTITY.test(sourceRootId)) fail('RESTORE_SOURCE_ROOT_INVALID');
    const target = restoreRoot(targetRoot), helper = restoreRoot(helperExecutable);
    if (Buffer.byteLength(target) > 4096 || Buffer.byteLength(helper) > 4096) fail('RESTORE_SOURCE_ROOT_INVALID');
    await plainRestoreDirectory(dirname(helper)); await assertBackupWindowsPaths([helper]);
    const helperId = await entry(helper);
    if (!helperId.isFile()) fail(unavailable);
    const deadline = Date.now() + 30_000;
    for (let path = dirname(target);; path = dirname(path)) {
      if (signal.aborted) fail('RESTORE_SOURCE_ROOT_ABORTED');
      if (Date.now() >= deadline || !unchanged(helperId, await entry(helper))) fail(unavailable);
      const rootId = await inspectRestoreRootIdentity({ rootPath: path, helperExecutable: helper, signal, deadline });
      if (signal.aborted) fail('RESTORE_SOURCE_ROOT_ABORTED');
      if (Date.now() >= deadline || !unchanged(helperId, await entry(helper))) fail(unavailable);
      if (rootId === null) throw new RestoreFilesError(unavailable);
      if (rootId === sourceRootId) fail('RESTORE_SOURCE_ROOT_OVERLAP');
      if (path === dirname(path)) break;
    }
  } catch (cause) {
    if (cause instanceof RestoreFilesError && cause.code.startsWith('RESTORE_SOURCE_ROOT_')) throw cause;
    if (signal.aborted) fail('RESTORE_SOURCE_ROOT_ABORTED');
    fail(unavailable);
  }
}
